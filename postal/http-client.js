/**
 * 港澳台网点采集 · HTTP 客户端
 * =================================
 * 只依赖 Node 内置 http/https 与项目已有的 iconv-lite。
 *
 * 设计取舍：
 *   - 不用 axios / node-fetch：项目没有这两个依赖，且 Node 22 自带 fetch；
 *     但台湾 post.gov.tw 在本机用 undici fetch 会先试 IPv6 并 10s 超时，
 *     用 http/https 模块直连反而稳定，因此这里统一走内置模块。
 *   - 403 不重试（按需求：停止盲目重试），429 遵循 Retry-After，
 *     5xx / 超时 / 连接重置做有限退避重试。
 *   - 请求间隔由 createHttpClient 的 delayMs 控制，串行请求，避免并发压站。
 */

'use strict';

const http = require('http');
const https = require('https');
const iconv = require('iconv-lite');

class HttpError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = info.status || 0;
    this.url = info.url || '';
    this.noRetry = !!info.noRetry;
    this.attempts = info.attempts || 0;
  }
}

/** 需要重试的状态码（403 故意不在其中） */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRY_NETWORK = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNABORTED',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(5000, 800 * Math.pow(2, attempt - 1));
}

/** 解析 Retry-After：秒数或 HTTP 日期；上限 60s */
function parseRetryAfter(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(60000, Number(s) * 1000);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, Math.min(60000, t - Date.now()));
  return null;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

function deleteHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
}

/** 单次请求（不处理重试与重定向），返回 { status, headers, buffer, url } */
function requestOnce(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 30000,
  } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new HttpError(`URL 无效: ${url}`, { url, noRetry: true }));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new HttpError(`不支持的协议: ${u.protocol}`, { url, noRetry: true }));
    }

    const lib = u.protocol === 'http:' ? http : https;
    // 部分站点对 chunked 请求体不友好，显式给出 Content-Length
    if (body != null && headerValue(headers, 'content-length') == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        buffer: Buffer.concat(chunks),
        url,
      }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`请求超时 (${timeoutMs}ms)`, { url }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** 跟随最多 maxRedirects 次重定向；303/302+POST 转为 GET */
async function requestFollowingRedirects(url, opts, logger, maxRedirects = 5) {
  let currentUrl = url;
  let method = opts.method || 'GET';
  let body = opts.body == null ? null : opts.body;
  const headers = Object.assign({}, opts.headers || {});

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await requestOnce(currentUrl, {
      method,
      headers,
      body,
      timeoutMs: opts.timeoutMs,
    });

    const location = headerValue(res.headers, 'location');
    if (REDIRECT_STATUS.has(res.status) && location) {
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch (e) {
        throw new HttpError(`重定向地址无效: ${location}`, { url: currentUrl, noRetry: true });
      }
      if (logger) logger.info(`  重定向 ${res.status}: ${currentUrl} -> ${nextUrl}`);
      const switchToGet =
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD');
      if (switchToGet) {
        method = 'GET';
        body = null;
        deleteHeader(headers, 'content-length');
        deleteHeader(headers, 'content-type');
      }
      currentUrl = nextUrl;
      continue;
    }

    return Object.assign(res, { finalUrl: currentUrl });
  }

  throw new HttpError(`重定向次数超过 ${maxRedirects} 次`, { url, noRetry: true });
}

/**
 * 带有限重试的请求。
 * @param {string} url
 * @param {object} opts { method, headers, body, timeoutMs, maxAttempts, tag }
 * @param {object} [logger]
 */
async function fetchWithRetry(url, opts = {}, logger = null) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 3);
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  const tag = opts.tag || '';
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await requestFollowingRedirects(url, Object.assign({}, opts, { timeoutMs }), logger);
    } catch (e) {
      lastError = e;
      if (e instanceof HttpError && e.noRetry) throw e;
      const code = e && e.code;
      if (code && !RETRY_NETWORK.has(code)) throw e;
      if (attempt >= maxAttempts) throw e;
      const wait = backoffMs(attempt);
      if (logger) logger.warn(`${tag}请求失败: ${e.message}，${wait}ms 后重试 (${attempt}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }

    if (logger) {
      logger.info(`${tag}${opts.method || 'GET'} ${url} -> ${res.status} (${res.buffer.length} bytes)`);
    }

    if (res.status >= 200 && res.status < 300) return res;

    if (res.status === 403) {
      const snippet = res.buffer.toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
      const err = new HttpError(`HTTP 403 拒绝访问（已停止重试，请检查访问方式或页面是否改版）`, {
        status: 403, url, noRetry: true, attempts: attempt,
      });
      err.context = snippet;
      throw err;
    }

    if (!RETRY_STATUS.has(res.status)) {
      throw new HttpError(`HTTP ${res.status}`, {
        status: res.status, url, noRetry: true, attempts: attempt,
      });
    }

    if (attempt >= maxAttempts) {
      throw new HttpError(`HTTP ${res.status}（已重试 ${maxAttempts} 次）`, {
        status: res.status, url, attempts: attempt,
      });
    }

    const retryAfter = parseRetryAfter(headerValue(res.headers, 'retry-after'));
    const wait = retryAfter == null ? backoffMs(attempt) : retryAfter;
    if (logger) {
      logger.warn(`${tag}HTTP ${res.status}，${wait}ms 后重试 (${attempt}/${maxAttempts})`);
    }
    await sleep(wait);
  }

  throw lastError || new HttpError(`请求失败: ${url}`, { url });
}

/**
 * 解码网页字节流。
 * 优先按响应头 charset；没有 charset 时先严格 UTF-8，失败回退 Big5/GBK。
 */
function decodePage(buf, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (/charset\s*=\s*big5/.test(ct)) return iconv.decode(buf, 'big5');
  if (/charset\s*=\s*(gbk|gb2312|gb18030)/.test(ct)) return iconv.decode(buf, 'gb18030');

  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return iconv.decode(buf, 'big5');
  }
}

/**
 * @param {object} opts { logger, timeoutMs, maxAttempts, delayMs }
 */
function createHttpClient(opts = {}) {
  const logger = opts.logger || null;
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 3);
  const delayMs = Math.max(0, Number(opts.delayMs) || 0);
  let lastRequestAt = 0;

  async function politeWait() {
    if (!delayMs) return;
    const wait = lastRequestAt + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function request(url, options = {}) {
    await politeWait();
    return fetchWithRetry(url, Object.assign({}, options, {
      timeoutMs,
      maxAttempts,
      headers: Object.assign({
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8',
        'Accept': '*/*',
        'Connection': 'close',
      }, options.headers || {}),
    }), logger);
  }

  async function getText(url, options = {}) {
    const res = await request(url, Object.assign({}, options, { method: 'GET' }));
    const contentType = headerValue(res.headers, 'content-type') || '';
    return {
      status: res.status,
      finalUrl: res.finalUrl,
      headers: res.headers,
      text: decodePage(res.buffer, contentType),
    };
  }

  async function getJson(url, options = {}) {
    const res = await getText(url, options);
    try {
      return JSON.parse(res.text);
    } catch (e) {
      const err = new Error(`接口返回的不是合法 JSON（HTTP ${res.status}）`);
      err.context = res.text.slice(0, 500);
      throw err;
    }
  }

  async function postJson(url, payload, options = {}) {
    const body = JSON.stringify(payload == null ? {} : payload);
    const res = await request(url, Object.assign({}, options, {
      method: 'POST',
      body,
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
      }, options.headers || {}),
    }));
    const contentType = headerValue(res.headers, 'content-type') || '';
    const text = decodePage(res.buffer, contentType);
    try {
      return JSON.parse(text);
    } catch (e) {
      const err = new Error(`接口返回的不是合法 JSON（HTTP ${res.status}）`);
      err.context = text.slice(0, 500);
      throw err;
    }
  }

  async function postForm(url, form, options = {}) {
    const body = typeof form === 'string' ? form : new URLSearchParams(form).toString();
    const res = await request(url, Object.assign({}, options, {
      method: 'POST',
      body,
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
      }, options.headers || {}),
    }));
    const contentType = headerValue(res.headers, 'content-type') || '';
    return {
      status: res.status,
      finalUrl: res.finalUrl,
      headers: res.headers,
      text: decodePage(res.buffer, contentType),
    };
  }

  return { request, getText, getJson, postJson, postForm };
}

module.exports = {
  HttpError,
  createHttpClient,
  fetchWithRetry,
  decodePage,
  parseRetryAfter,
};
