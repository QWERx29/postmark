/**
 * 机戳查询 — UPRINS 扫码链接解析
 * ================================
 * 输入扫描得到的 s.uprins.com 链接：
 *   1. 把域名换成固定服务器 IP，先拿到 3xx 跳转；
 *   2. 把跳转地址里的 card.uprins.com 也换成 IP；
 *   3. 访问最终页面，自动识别「普通扫描结果页」或「宣传戳信息页」并提取文字；
 *   4. 把机戳文字拆成字段，兼容两种原始格式：
 *      - 斜杠分隔：TFJ003/闽 CA17/00326155/25095532/闽 2026-1-(1-1)
 *      - 标签：值：邮资机表头号：TFJ003 ...
 *      原始 5 段为：邮资机表头号 / 邮资戳号码 / 邮资机过资总件数 / 验证码 / 宣传戳编号，
 *      解析结果统一显示为：邮资机编号 / 邮资机表头 / 当前总过戳数 / 验证码 / 宣传戳编号；
 *      宣传戳编号可为空，当前总过戳数去除前导零；
 *   5. 若中间链接带有 03_XJS... 打印参数，再拆出打印日期 / 打印金额 / 当前图案过戳数。
 *   6. 若最终响应是图片，或页面里有一张机戳图片，转成 data URL 一并返回；
 *      不落盘、不缓存，每次查询重新获取。
 *
 * 与 Python 版的差异：
 *   - 使用 Node 内置 http/https，不依赖 requests；
 *   - 用范围很窄的正则 + 标签配对提取文字，不依赖 BeautifulSoup；
 *   - 图片展示只在 Node 版实现，Python 原版不输出图片；
 *   - 跳转只允许落到 s.uprins.com / card.uprins.com / 固定 IP，
 *     避免服务端被任意 Location 带去访问其它地址（SSRF）。
 *
 * 主要入口为 parse(url)，错误统一抛 UprinsError（带 statusCode）。
 */

'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const iconv = require('iconv-lite');

// ==================== 配置 ====================

const SERVER_IP = '119.37.199.25';
const SOURCE_DOMAIN = 's.uprins.com';
const TARGET_DOMAIN = 'card.uprins.com';

const TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// 「已扫描到以下内容」下一行的 5 段机戳信息
const MACHINE_STAMP_MARKER = '已扫描到以下内容';
const MACHINE_STAMP_FIELDS = [
  // 解析结果使用新名称，原始扫描页仍按 aliases 里的旧名称识别
  { key: 'headerNo', label: '邮资机编号', aliases: ['邮资机表头号'] },
  { key: 'stampNo', label: '邮资机表头', aliases: ['邮资戳号码'] },
  { key: 'totalCount', label: '当前总过戳数', aliases: ['邮资机过资总件数'] },
  { key: 'verifyCode', label: '验证码', aliases: ['验证码'] },
  { key: 'promoNo', label: '宣传戳编号', aliases: ['宣传戳编号'] },
];

const MACHINE_STAMP_LABEL_TO_KEY = new Map();
for (const field of MACHINE_STAMP_FIELDS) {
  for (const alias of field.aliases) {
    MACHINE_STAMP_LABEL_TO_KEY.set(alias, field.key);
  }
}

const MACHINE_STAMP_LABEL_PATTERN = MACHINE_STAMP_FIELDS
  .reduce((aliases, field) => aliases.concat(field.aliases), [])
  .sort((a, b) => b.length - a.length)
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// 中间链接里的打印参数，例如：
// 03_XJS010_00201678_003_2026101808_0000080_400_0000198_25595460
const MACHINE_STAMP_TOKEN_RE =
  /(?:^|[^0-9A-Za-z])(\d{2}_[0-9A-Za-z]+_\d+_\d+_\d{10}_\d+_\d+_\d+_\d+)(?![0-9A-Za-z_])/g;

const MACHINE_STAMP_DETAIL_FIELDS = [
  { key: 'printDate', label: '打印日期' },
  { key: 'printAmount', label: '打印金额' },
  { key: 'patternCount', label: '当前图案过戳数' },
];

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/156.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,' +
    'application/xml;q=0.9,image/*;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

// ==================== 错误类型 ====================

class UprinsError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'UprinsError';
    this.statusCode = statusCode || 500;
  }
}

// ==================== HTTP ====================

/**
 * 发一次 GET 请求，不跟随跳转。
 * @param {string} url
 * @param {string} [cookie] 需要带上的 Cookie 头
 * @param {object} [extraHeaders] 额外请求头（图片请求会覆盖 Accept）
 * @returns {Promise<{statusCode:number, headers:object, body:Buffer}>}
 */
function requestOnce(url, cookie, extraHeaders) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new UprinsError('链接格式不正确', 400));
      return;
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new UprinsError('仅支持 HTTP 和 HTTPS 链接', 400));
      return;
    }

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = { ...REQUEST_HEADERS, ...(extraHeaders || {}) };
    if (cookie) headers.Cookie = cookie;

    const options = {
      method: 'GET',
      headers,
      timeout: TIMEOUT_MS,
    };

    // 用 IP 直连 https 时，SNI 仍按业务域名发，避免证书按 IP 校验失败。
    if (isHttps && target.hostname === SERVER_IP) {
      options.servername = SOURCE_DOMAIN;
    }

    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    let req;
    try {
      req = lib.request(target, options, (res) => {
        const chunks = [];
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            done(new UprinsError('页面内容过大，已停止解析', 502));
            res.destroy();
            try { req.destroy(); } catch (e) { /* ignore */ }
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          let body = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (encoding === 'gzip') body = zlib.gunzipSync(body);
            else if (encoding === 'deflate') body = zlib.inflateSync(body);
            else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
          } catch (e) {
            // 解压失败就按原始字节交给后续编码识别
          }

          done(null, {
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body,
          });
        });

        res.on('error', (e) => {
          done(new UprinsError(`网络请求失败：${e.message}`, 502));
        });

        res.on('aborted', () => {
          done(new UprinsError('网络请求失败：连接中断', 502));
        });
      });
    } catch (e) {
      done(new UprinsError(`网络请求失败：${e.message}`, 502));
      return;
    }

    req.on('timeout', () => {
      try { req.destroy(new Error('请求超时')); } catch (e) { /* ignore */ }
    });

    req.on('error', (e) => {
      done(new UprinsError(`网络请求失败：${e.message}`, 502));
    });

    req.end();
  });
}

/** 把跳转地址限制在已知域名 / 固定 IP 内，并把业务域名换回 IP */
function resolveAllowedUrl(base, location) {
  let next;
  try {
    next = new URL(location, base);
  } catch (e) {
    throw new UprinsError('服务器返回了无效的跳转地址', 502);
  }

  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new UprinsError('跳转地址只支持 HTTP 和 HTTPS', 502);
  }
  if (next.username || next.password) {
    throw new UprinsError('跳转地址包含不支持的认证信息', 502);
  }

  const host = (next.hostname || '').toLowerCase();
  if (host === TARGET_DOMAIN || host === SOURCE_DOMAIN) {
    next.hostname = SERVER_IP;
  } else if (host !== SERVER_IP) {
    throw new UprinsError(`跳转地址域名不受支持：${next.hostname}`, 502);
  }

  return next.toString();
}

/** 把 Set-Cookie 合并进简单的 Cookie 头（保留同名覆盖） */
function mergeCookies(cookieHeader, setCookie) {
  const jar = new Map();

  function add(pair) {
    const text = String(pair || '').trim();
    const index = text.indexOf('=');
    if (index <= 0) return;
    jar.set(text.slice(0, index).trim(), text.slice(index + 1).trim());
  }

  String(cookieHeader || '').split(';').forEach(add);

  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const raw of list) {
    // 只取 name=value，忽略 Path / HttpOnly 等属性
    add(String(raw).split(';')[0]);
  }

  return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
}

/** 跟随最终页面的跳转（最多 MAX_REDIRECTS 次），沿途合并 Cookie，并收集打印参数 */
async function getFollowing(startUrl, cookie) {
  let current = startUrl;
  let jar = cookie || '';
  let token = findMachineStampToken(startUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestOnce(current, jar);
    jar = mergeCookies(jar, res.headers['set-cookie']);
    token = token || findMachineStampToken(current);

    if (!REDIRECT_CODES.has(res.statusCode)) {
      // 图片响应是二进制，不做文本解码；打印参数仍可从 URL 里找
      if (!detectImageMime(res.body, res.headers['content-type'])) {
        token = token || findMachineStampToken(
          decodeHtml(res.body, res.headers['content-type'])
        );
      }
      return { response: res, url: current, token, cookie: jar };
    }

    const location = res.headers.location;
    if (!location) {
      throw new UprinsError('服务器返回跳转但缺少 Location', 502);
    }

    token = token || findMachineStampToken(location);
    current = resolveAllowedUrl(current, location);
    token = token || findMachineStampToken(current);
  }
  throw new UprinsError('跳转次数过多，已停止解析', 502);
}

// ==================== 编码 / HTML 解析 ====================

function normalizeCharset(charset) {
  const value = String(charset || '').trim().toLowerCase();
  if (!value) return 'utf8';
  if (value === 'utf-8' || value === 'utf8') return 'utf8';
  if (['gb2312', 'gbk', 'gb18030', 'x-gbk'].includes(value)) return 'gb18030';
  return iconv.encodingExists(value) ? value : 'utf8';
}

function detectCharset(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return normalizeCharset(fromHeader[1]);

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8';
  }

  // meta charset 一定在文档靠前的位置，取前 4 KB 足够
  const head = buffer.slice(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (fromMeta) return normalizeCharset(fromMeta[1]);

  return null;
}

function decodeHtml(buffer, contentType) {
  const charset = detectCharset(buffer, contentType);
  if (charset) {
    try {
      return iconv.decode(buffer, charset);
    } catch (e) {
      return buffer.toString('utf8');
    }
  }

  // 未声明编码时先验证 UTF-8；失败再按中文页面常见的 GB18030 兜底
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return buffer.toString('utf8');
  } catch (e) {
    return iconv.decode(buffer, 'gb18030');
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  sol: '/',
  bsol: '\\',
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (e) { return match; }
      }
      return match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
      ? NAMED_ENTITIES[key]
      : match;
  });
}

/** 去掉注释与 script/style，避免把脚本内容当成正文 */
function cleanHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

function attrValue(attrs, name) {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i'
  );
  const m = re.exec(attrs || '');
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] || ''));
}

function hasClass(attrs, className) {
  const value = attrValue(attrs, 'class');
  if (!value) return false;
  return value.split(/\s+/).includes(className);
}

/**
 * 找出指定标签里带某个 class 的元素内部 HTML。
 * 逐个目标开标签配对同名闭合标签，能处理同名标签嵌套。
 */
function collectElements(html, tagName, className) {
  const results = [];
  const openRe = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let open;

  while ((open = openRe.exec(html))) {
    if (!hasClass(open[1] || '', className)) continue;

    const closeRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
    closeRe.lastIndex = openRe.lastIndex;

    let depth = 1;
    let close;
    while ((close = closeRe.exec(html))) {
      if (close[1] === '/') {
        depth--;
        if (depth === 0) {
          results.push(html.slice(openRe.lastIndex, close.index));
          openRe.lastIndex = closeRe.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }
  }

  return results;
}

/** 近似 BeautifulSoup 的 get_text(" ", strip=True)：文本节点之间补空格 */
function textOf(html) {
  return String(html)
    .split(/<[^>]*>/)
    .map((part) => decodeEntities(part).trim())
    .filter(Boolean)
    .join(' ');
}

function parseNormalPage(html) {
  const title = collectElements(html, 'p', 'title')[0];
  const links = collectElements(html, 'div', 'link');
  if (title === undefined || !links.length) return null;

  const linkText = links
    .map((link) => textOf(link))
    .filter(Boolean)
    .join('\n');

  return `${textOf(title)}\n${linkText}`;
}

function parseStampPage(html) {
  const results = [];
  for (const className of ['a_a', 'a_b', 'a_c']) {
    for (const inner of collectElements(html, 'p', className)) {
      const value = textOf(inner);
      if (value) results.push(value);
    }
  }
  return results.length ? results.join('\n') : null;
}

/** 自动识别页面类型并提取文字；识别失败抛错 */
function parseHtml(html) {
  const cleaned = cleanHtml(html);

  const normal = parseNormalPage(cleaned);
  if (normal !== null) return normal;

  const stamp = parseStampPage(cleaned);
  if (stamp !== null) return stamp;

  throw new UprinsError('未识别到支持的页面结构', 422);
}

// ==================== 图片 ====================

function isJpeg(buffer) {
  return buffer.length >= 3 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  return buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
}

function isGif(buffer) {
  return buffer.length >= 6 &&
    buffer.toString('ascii', 0, 3) === 'GIF' &&
    (buffer.toString('ascii', 3, 6) === '87a' || buffer.toString('ascii', 3, 6) === '89a');
}

function isWebp(buffer) {
  return buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';
}

function isBmp(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

/**
 * 识别响应里的图片类型。
 * 优先看 Content-Type，但最终以文件魔数为准，避免把 HTML 错误页当图片。
 * 只接受浏览器可直接显示的常见位图；SVG 不在此列。
 */
function detectImageMime(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  const declared = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const normalized = declared === 'image/jpg' || declared === 'image/pjpeg'
    ? 'image/jpeg'
    : declared;

  if (normalized === 'image/jpeg' && isJpeg(buffer)) return 'image/jpeg';
  if (normalized === 'image/png' && isPng(buffer)) return 'image/png';
  if (normalized === 'image/gif' && isGif(buffer)) return 'image/gif';
  if (normalized === 'image/webp' && isWebp(buffer)) return 'image/webp';
  if (normalized === 'image/bmp' && isBmp(buffer)) return 'image/bmp';

  // Content-Type 缺失或写成 application/octet-stream 时按魔数兜底
  if (isJpeg(buffer)) return 'image/jpeg';
  if (isPng(buffer)) return 'image/png';
  if (isGif(buffer)) return 'image/gif';
  if (isWebp(buffer)) return 'image/webp';
  if (isBmp(buffer)) return 'image/bmp';

  return null;
}

/** 图片统一转成 data URL：不落盘、不经过浏览器 HTTP 缓存 */
function toImageDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** 从 HTML 的 img 标签里挑出可能属于机戳内容的图片 */
function extractImageCandidates(html, requireHint) {
  const candidates = [];
  const seen = new Set();
  const source = cleanHtml(html);
  const imgRe = /<img\b([^>]*)>/gi;
  let match;

  while ((match = imgRe.exec(source))) {
    const attrs = match[1] || '';
    const rawSrc =
      attrValue(attrs, 'src') ||
      attrValue(attrs, 'data-src') ||
      attrValue(attrs, 'data-original');
    if (!rawSrc) continue;

    const src = decodeEntities(rawSrc).trim();
    if (!src || /^(?:#|javascript:|about:|blob:)/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);

    const width = Number(attrValue(attrs, 'width'));
    const height = Number(attrValue(attrs, 'height'));
    if (Number.isFinite(width) && width > 0 && width < 60) continue;
    if (Number.isFinite(height) && height > 0 && height < 60) continue;

    const lower = src.toLowerCase();
    const attrsLower = attrs.toLowerCase();
    const contentHint =
      /\/a\/|stamp|postmark|machine|photo|pic|upload/.test(lower) ||
      /stamp|postmark|machine|photo|pic/.test(attrsLower);
    const chromeHint =
      /logo|icon|favicon|spacer|blank|pixel|loading|avatar|banner|background|qrcode|qr_|erweima/.test(lower) ||
      /logo|icon|favicon|spacer|blank|pixel|loading|avatar|banner|background|qrcode|qr_|erweima/.test(attrsLower);
    if (chromeHint && !contentHint) continue;

    let score = 0;
    if (/\/a\//.test(lower)) score += 50;
    if (/stamp|postmark|machine|photo|image|pic|upload|file/.test(lower)) score += 20;
    if (/stamp|postmark|machine|photo|image|pic/.test(attrsLower)) score += 15;
    if (Number.isFinite(width) && width >= 200) score += 10;
    if (Number.isFinite(height) && height >= 200) score += 10;
    if (requireHint && score <= 0) continue;

    candidates.push({ src, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 3);
  if (top.length > 1) {
    const hinted = top.filter((item) => item.score > 0);
    if (hinted.length) return hinted.slice(0, 3);
  }
  return top;
}

/** 跟随图片地址的跳转，返回 data URL；失败返回 null */
async function fetchImage(startUrl, cookie) {
  let current = startUrl;
  let jar = cookie || '';

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestOnce(current, jar, {
      Accept: 'image/*,*/*;q=0.8',
    });
    jar = mergeCookies(jar, res.headers['set-cookie']);

    if (REDIRECT_CODES.has(res.statusCode)) {
      const location = res.headers.location;
      if (!location) return null;
      current = resolveAllowedUrl(current, location);
      continue;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) return null;

    const mime = detectImageMime(res.body, res.headers['content-type']);
    if (!mime) return null;

    return {
      dataUrl: toImageDataUrl(res.body, mime),
      bytes: res.body.length,
    };
  }

  return null;
}

/**
 * 从页面里找一张图片并转成 data URL。
 * 只允许落在 s.uprins.com / card.uprins.com / 固定 IP，避免借图片地址做 SSRF。
 */
async function findHtmlImage(html, baseUrl, cookie, options) {
  const candidates = extractImageCandidates(
    html,
    Boolean(options && options.requireHint)
  );
  if (!candidates.length) return null;

  const tasks = candidates.map(async (candidate) => {
    const src = candidate.src;

    if (/^data:/i.test(src)) {
      const match = /^data:(image\/(?:jpeg|jpg|png|gif|webp|bmp));base64,([\s\S]+)$/i.exec(src);
      if (!match) return null;
      try {
        const buffer = Buffer.from(match[2], 'base64');
        const mime = detectImageMime(buffer, match[1]);
        if (!mime) return null;
        return { dataUrl: toImageDataUrl(buffer, mime), bytes: buffer.length };
      } catch (e) {
        return null;
      }
    }

    try {
      return await withTimeout(
        fetchImage(resolveAllowedUrl(baseUrl, src), cookie),
        IMAGE_TIMEOUT_MS
      );
    } catch (e) {
      return null;
    }
  });

  const results = (await Promise.all(tasks)).filter(Boolean);
  if (!results.length) return null;

  // 同一页面可能同时有 logo / 图标；取字节数最大的那张，通常才是正文图片
  results.sort((a, b) => b.bytes - a.bytes);
  return results[0].dataUrl;
}

/** 图片提取失败不能影响文字解析 */
async function safeFindHtmlImage(html, baseUrl, cookie, options) {
  try {
    return await findHtmlImage(html, baseUrl, cookie, options);
  } catch (e) {
    return null;
  }
}

/** 给图片请求加个上限，避免正文已经解析完还一直等图片 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** 统计一行里的半角 / 全角斜杠数量 */
function countSlashes(line) {
  return (String(line).match(/[\/／]/g) || []).length;
}

/** 解析结果里的数值归一化：当前总过戳数去掉前导零，其余字段保持原样 */
function normalizeMachineStampValue(key, value) {
  const text = String(value == null ? '' : value).trim();
  if (key === 'totalCount') return text.replace(/^0+(?=\d)/, '');
  return text;
}

/**
 * 解析「标签：值」格式的机戳信息。
 *
 * 支持：
 *   邮资机表头号：TFJ004
 *   邮资戳号码：闽 AA39
 *   邮资机过资总件数：00000095
 *   验证码：24840156
 *   宣传戳编号：闽 2026-1-(1-1)
 *
 * 「宣传戳编号」可以为空；前 4 项标签缺失或为空时返回 null。
 * 输出字段名统一为 MACHINE_STAMP_FIELDS 里的 label，原始扫描文字不修改。
 */
function parseLabeledMachineStamp(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const values = new Map();
  const labelRe = new RegExp(`(${MACHINE_STAMP_LABEL_PATTERN})\\s*[：:]`, 'g');

  // 有「已扫描到以下内容」标记时只看标记之后，避免把页面上的字段说明当成结果
  const markerIndex = normalized.indexOf(MACHINE_STAMP_MARKER);
  const scoped = markerIndex >= 0 ? normalized.slice(markerIndex) : normalized;

  for (const line of scoped.split('\n')) {
    labelRe.lastIndex = 0;
    const matches = Array.from(line.matchAll(labelRe));

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const label = match[1];
      const fieldKey = MACHINE_STAMP_LABEL_TO_KEY.get(label);
      if (!fieldKey) continue;

      const start = match.index + match[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
      const value = normalizeMachineStampValue(
        fieldKey,
        line
          .slice(start, end)
          .trim()
          .replace(/[，,；;]+$/, '')
          .trim()
      );

      // 同一字段优先保留第一个非空值
      if (!values.has(fieldKey) || !values.get(fieldKey)) {
        values.set(fieldKey, value);
      }
    }
  }

  const requiredKeys = MACHINE_STAMP_FIELDS
    .slice(0, 4)
    .map((field) => field.key);

  if (!requiredKeys.every((key) => values.has(key) && values.get(key))) return null;

  return {
    raw: normalized.trim(),
    fields: MACHINE_STAMP_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      value: values.has(field.key) ? values.get(field.key) : '',
    })),
  };
}

/**
 * 解析斜杠分隔格式的机戳信息。
 *
 * 目标格式：
 *   已扫描到以下内容
 *   TFJ003/闽 CA17/00326155/25095532/闽 2026-1-(1-1)
 *
 * 第 5 段「宣传戳编号」可以为空，也可以整段省略：
 *   TFJ003/闽 CA17/00326155/25095532
 *
 * 输出字段名统一为 MACHINE_STAMP_FIELDS 里的 label，原始扫描文字不修改。
 */
const SLASH_MACHINE_STAMP_RE = /^([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/;

function parseSlashMachineStamp(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [];
  const markerIndex = normalized.indexOf(MACHINE_STAMP_MARKER);
  if (markerIndex >= 0) {
    // 标记后面可能直接跟数据，也可能换行后再出现
    const afterMarker = normalized.slice(markerIndex + MACHINE_STAMP_MARKER.length);
    candidates.push(...afterMarker.split('\n'));
  }
  candidates.push(...lines);

  // 至少要有 3 个斜杠（4 段）；第 5 段可省略
  for (const line of candidates) {
    const target = line.trim();
    if (!target || countSlashes(target) < 3) continue;

    // 兼容「已扫描到以下内容：TFJ...」这种标记与数据同行的写法
    const candidate = target
      .replace(MACHINE_STAMP_MARKER, '')
      .replace(/^[：:]\s*/, '')
      .replace(/／/g, '/')
      .trim();

    const match = candidate.match(SLASH_MACHINE_STAMP_RE);
    if (!match) continue;

    const values = match
      .slice(1, 6)
      .map((value) => (value == null ? '' : value.trim()));

    return {
      raw: target,
      fields: MACHINE_STAMP_FIELDS.map((field, index) => ({
        key: field.key,
        label: field.label,
        value: normalizeMachineStampValue(field.key, values[index] || ''),
      })),
    };
  }

  return null;
}

/** 自动识别「标签：值」或斜杠分隔两种机戳格式 */
function parseMachineStamp(text) {
  return parseLabeledMachineStamp(text) || parseSlashMachineStamp(text);
}

/**
 * 解析中间链接里的打印参数。
 *
 * 例：
 *   03_XJS010_00201678_003_2026101808_0000080_400_0000198_25595460
 *
 * 第 5 段 2026101808 → 打印日期 2026年10月18日08时
 * 第 6 段 0000080    → 打印金额 80分
 * 第 8 段 0000198    → 当前图案过戳数 198件
 */
function parseMachineStampToken(token) {
  const parts = String(token || '').split('_');
  if (parts.length !== 9) return null;

  const dateText = parts[4];
  const amountText = parts[5];
  const countText = parts[7];

  if (
    !/^\d{10}$/.test(dateText) ||
    !/^\d+$/.test(amountText) ||
    !/^\d+$/.test(countText)
  ) {
    return null;
  }

  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const hour = Number(dateText.slice(8, 10));

  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23
  ) {
    return null;
  }

  // 用 UTC 校验真实日期，避免 2026023008 这类非法日期被 Date 自动进位
  const date = new Date(Date.UTC(year, month - 1, day, hour));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour
  ) {
    return null;
  }

  const values = {
    printDate: `${year}年${month}月${day}日${String(hour).padStart(2, '0')}时`,
    printAmount: `${Number(amountText)}分`,
    patternCount: `${Number(countText)}件`,
  };

  return {
    token: String(token),
    fields: MACHINE_STAMP_DETAIL_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      value: values[field.key],
    })),
  };
}

/** 从 URL / Location / 页面文字里找出第一组合法的打印参数 */
function findMachineStampToken(value) {
  let text = String(value || '');

  try {
    text = decodeURIComponent(text);
  } catch (e) {
    // 解码失败时保留原文，继续按未编码的 %5F 兼容
  }

  text = text.replace(/%5f/gi, '_');

  MACHINE_STAMP_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = MACHINE_STAMP_TOKEN_RE.exec(text))) {
    const parsed = parseMachineStampToken(match[1]);
    if (parsed) return parsed;
  }

  return null;
}

// ==================== 完整流程 ====================

async function convertUrl(originalUrl) {
  let parts;
  try {
    parts = new URL(originalUrl);
  } catch (e) {
    throw new UprinsError('链接格式不正确', 400);
  }

  const host = (parts.hostname || '').toLowerCase();
  if (host !== SOURCE_DOMAIN) {
    throw new UprinsError(`不支持的链接域名：${parts.hostname || '(空)'}`, 400);
  }
  if (parts.protocol !== 'http:' && parts.protocol !== 'https:') {
    throw new UprinsError('仅支持 HTTP 和 HTTPS 链接', 400);
  }

  // 第一步：通过 IP 访问原始入口（与 Python 版一致，丢掉原 URL 的端口）
  const ipUrl = new URL(parts.toString());
  ipUrl.hostname = SERVER_IP;
  ipUrl.port = '';
  ipUrl.username = '';
  ipUrl.password = '';

  const first = await requestOnce(ipUrl.toString());
  const cookie = mergeCookies('', first.headers['set-cookie']);
  const baseToken = findMachineStampToken(ipUrl.toString());

  // 少数链接不跳转，入口直接返回 HTML 或图片
  if (!REDIRECT_CODES.has(first.statusCode)) {
    if (first.statusCode >= 200 && first.statusCode < 300) {
      return {
        url: ipUrl.toString(),
        cookie,
        token: baseToken,
        directResponse: first,
      };
    }
    throw new UprinsError(`原始入口未返回预期跳转，HTTP ${first.statusCode}`, 502);
  }

  const location = first.headers.location;
  if (!location) {
    throw new UprinsError('服务器未返回 Location 跳转地址', 502);
  }

  // 第二步：解析跳转地址，把业务域名换回 IP；同时把跳转响应里的 Cookie 带上
  const resolvedUrl = resolveAllowedUrl(ipUrl.toString(), location);

  return {
    url: resolvedUrl,
    cookie,
    token:
      baseToken ||
      findMachineStampToken(location) ||
      findMachineStampToken(resolvedUrl) ||
      findMachineStampToken(decodeHtml(first.body, first.headers['content-type'])),
  };
}

/**
 * 解析一条 s.uprins.com 扫码链接。
 * @param {string} originalUrl
 * @returns {Promise<{
 *   text: string,
 *   fields: Array<{ key: string, label: string, value: string }> | null,
 *   image: string | null
 * }>}
 *   fields 为机戳字段，若中间链接带打印参数则追加打印日期 / 打印金额 / 当前图案过戳数。
 *   image 为 data:image/...;base64,...，每次查询重新生成，不做缓存。
 */
async function parse(originalUrl) {
  const raw = String(originalUrl == null ? '' : originalUrl).trim();
  if (!raw) throw new UprinsError('链接不能为空', 400);

  let converted;
  try {
    converted = await convertUrl(raw);
  } catch (e) {
    if (e instanceof UprinsError) throw e;
    throw new UprinsError(`网络请求失败：${e.message}`, 502);
  }

  let response;
  let responseUrl;
  let responseCookie;
  let responseToken;

  if (converted.directResponse) {
    // 入口直接返回 HTML / 图片，不再走跳转
    response = converted.directResponse;
    responseUrl = converted.url;
    responseCookie = converted.cookie;
    responseToken = converted.token;
  } else {
    let followed;
    try {
      followed = await getFollowing(converted.url, converted.cookie);
    } catch (e) {
      if (e instanceof UprinsError) throw e;
      throw new UprinsError(`网络请求失败：${e.message}`, 502);
    }
    response = followed.response;
    responseUrl = followed.url;
    responseCookie = followed.cookie;
    responseToken = followed.token;
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new UprinsError(`页面访问失败，HTTP ${response.statusCode}`, 502);
  }

  // 有些链接最终直接返回一张图片，不进入 HTML 解析
  const directImageMime = detectImageMime(
    response.body,
    response.headers['content-type']
  );
  if (directImageMime) {
    return {
      text: '',
      fields: responseToken ? responseToken.fields : null,
      image: toImageDataUrl(response.body, directImageMime),
    };
  }

  const html = decodeHtml(response.body, response.headers['content-type']);

  let text;
  try {
    text = parseHtml(html);
  } catch (e) {
    // 页面结构不认识时，如果正文里有一张图，仍然把图展示出来
    const image = await safeFindHtmlImage(html, responseUrl, responseCookie);
    if (image) {
      const tokenInfo = responseToken || findMachineStampToken(html);
      return {
        text: '',
        fields: tokenInfo ? tokenInfo.fields : null,
        image,
      };
    }

    if (e instanceof UprinsError) {
      throw new UprinsError(`解析失败：${e.message}`, e.statusCode);
    }
    throw new UprinsError(`解析失败：${e.message}`, 500);
  }

  const machineStamp = parseMachineStamp(text);
  const tokenInfo =
    responseToken ||
    findMachineStampToken(html) ||
    findMachineStampToken(text);

  const fields = [];
  if (machineStamp) fields.push(...machineStamp.fields);
  if (tokenInfo) fields.push(...tokenInfo.fields);

  // 解析成功的页面也可能带一张机戳图片；只认有明显图片路径特征的，避免把 logo 当机戳图
  const image = await safeFindHtmlImage(html, responseUrl, responseCookie, {
    requireHint: true,
  });

  return {
    text,
    fields: fields.length ? fields : null,
    image,
  };
}

module.exports = {
  parse,
  // 供测试 / 排错
  parseHtml,
  parseMachineStamp,
  parseLabeledMachineStamp,
  parseSlashMachineStamp,
  parseMachineStampToken,
  findMachineStampToken,
  detectImageMime,
  decodeHtml,
  MACHINE_STAMP_FIELDS,
  MACHINE_STAMP_DETAIL_FIELDS,
  SERVER_IP,
  SOURCE_DOMAIN,
  TARGET_DOMAIN,
  UprinsError,
};
