/**
 * 本地明文 HTTP registry — 供 scripts/dev-local-registry.js 与测试复用
 * ====================================================================
 * 见 dev-local-registry.js 文件头：本模块存在的唯一原因是本机受限会话下
 * schannel 不可用，导致 cargo 无法完成任何 HTTPS 请求。
 *
 * 这里只负责"按 cargo 的实际请求路径提供服务"，不做监听与进程管理，
 * 因此可以被测试直接以随机端口拉起、逐条断言路由行为。
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const UPSTREAM_INDEX = 'https://index.crates.io';
const UPSTREAM_CRATES = 'https://static.crates.io';

/**
 * crates.io 稀疏索引路径规则（与官方一致，已用上游实测校验）：
 *   1 字符   -> 1/{name}
 *   2 字符   -> 2/{name}
 *   3 字符   -> 3/{首字符}/{name}
 *   >=4 字符 -> {前2}/{第3-4}/{name}
 *
 * 例：anyhow(6) -> an/yh/anyhow；syn(3) -> 3/s/syn；libc(4) -> li/bc/libc
 * 名字先规范化：小写，'-' 与 '_' 在索引分桶时等价。
 */
function indexPathFor(name) {
  const n = name.toLowerCase().replace(/-/g, '_');
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/**
 * 创建 registry 服务器（未监听）。
 * @param {{cacheDir:string, port?:number, log?:function}} opts
 *   port 只用于生成 config.json 里的 dl 地址；本地请求路径与它无关。
 */
function createRegistryServer(opts) {
  const cacheDir = opts.cacheDir;
  const crateCache = path.join(cacheDir, 'crates');
  const indexCache = path.join(cacheDir, 'index');
  const log = opts.log || ((msg) => console.log(msg));
  const errlog = opts.error || ((msg) => console.error(msg));
  // 注意用 == null 而不是 || ：port 为 0（让内核分配端口）是合法输入，
  // 用 || 会把 0 当成"未提供"而退回 19780，导致 config.json 里的 dl
  // 指向一个并没有在监听的端口。
  // 监听后还会用 server.address().port 校正一次 —— 传 0 时只有那时才知道真实端口。
  let port = opts.port == null ? 19780 : opts.port;

  const stats = { indexHits: 0, indexFetches: 0, crateHits: 0, crateFetches: 0, bytes: 0, errors: [] };

  fs.mkdirSync(crateCache, { recursive: true });
  fs.mkdirSync(indexCache, { recursive: true });

  /** HTTP GET，返回 Buffer */
  function httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'accept-encoding': 'identity' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  function send(res, code, body, type) {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * config.json 是 cargo 进入 registry 的第一站，它决定 .crate 从哪里下载。
   * 必须把 dl 改写成指向本代理，否则 cargo 会拿着官方 https 地址
   * 直接去 static.crates.io —— 于是又回到 schannel 失败。
   * 其余字段（api 等）原样透传，避免与官方语义漂移。
   */
  async function handleConfig(res) {
    const cacheFile = path.join(indexCache, 'config.json');
    let raw;
    try {
      raw = fs.readFileSync(cacheFile, 'utf8');
    } catch (e) {
      try {
        const buf = await httpGet(`${UPSTREAM_INDEX}/config.json`);
        raw = buf.toString('utf8');
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, raw);
      } catch (err) {
        stats.errors.push(`config.json: ${err.message}`);
        errlog(`[registry] config.json 获取失败: ${err.message}`);
        return send(res, 502, err.message, 'text/plain');
      }
    }

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      return send(res, 502, `config.json 不是合法 JSON: ${e.message}`, 'text/plain');
    }
    // dl 每次都用当前端口重新生成，**不能信任缓存里的值**：
    // 缓存来自上游（dl 指向 https://static.crates.io，那会让 cargo 又撞 schannel），
    // 而且端口可能变化。曾经因为"只在首次下载时改写"，缓存命中时把错误的
    // dl 原样吐给了 cargo —— 由测试用不同端口暴露出来。
    const upstreamDl = cfg.dl;
    cfg.dl = `http://127.0.0.1:${port}/crates`;
    cfg.api = null;                                  // 本地代理不提供 Web API
    log(`[registry] 提供 config.json (dl: ${upstreamDl} -> ${cfg.dl})`);
    return send(res, 200, JSON.stringify(cfg), 'application/json');
  }

  async function handleIndex(res, relPath) {
    const safe = relPath.replace(/\.\./g, '').replace(/^\/+/, '');
    const cacheFile = path.join(indexCache, safe);

    try {
      const buf = fs.readFileSync(cacheFile);
      stats.indexHits++;
      return send(res, 200, buf, 'text/plain; charset=utf-8');
    } catch (e) { /* 去上游取 */ }

    try {
      const buf = await httpGet(`${UPSTREAM_INDEX}/${safe}`);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, buf);
      stats.indexFetches++;
      return send(res, 200, buf, 'text/plain; charset=utf-8');
    } catch (e) {
      const code = /HTTP 404/.test(e.message) ? 404 : 502;
      stats.errors.push(`index ${safe}: ${e.message}`);
      // 必须打日志：索引失败原本是静默的，cargo 只看到一句 502，
      // 排查时完全不知道是哪个路径出的问题 —— 这个盲区已经被坑过一次。
      errlog(`[registry] 索引失败 ${safe}: ${e.message}`);
      return send(res, code, e.message, 'text/plain');
    }
  }

  async function handleCrate(res, relPath) {
    // relPath 形如 `anyhow/1.0.104/download`
    const safe = relPath.replace(/\.\./g, '').replace(/^\/+/, '');
    const cacheFile = path.join(crateCache, safe);

    try {
      const buf = fs.readFileSync(cacheFile);
      stats.crateHits++;
      stats.bytes += buf.length;
      return send(res, 200, buf, 'application/x-tar');
    } catch (e) { /* 需要下载 */ }

    // 上游真实地址要补 `/crates` 段：
    // static.crates.io/crates/<name>/<version>/download
    // （曾漏掉这一段，上游回 403，报错信息误导性很强，故此处显式拼全）
    try {
      const buf = await httpGet(`${UPSTREAM_CRATES}/crates/${safe}`);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, buf);
      stats.crateFetches++;
      stats.bytes += buf.length;
      log(`[registry] 下载 ${safe} (${(buf.length / 1024).toFixed(0)} KB)`);
      return send(res, 200, buf, 'application/x-tar');
    } catch (e) {
      // 上游对"不存在的 crate"回的是 **403**（不是 404）。两者都应转成 404，
      // 否则 cargo 会把"包不存在"误判成"网络故障"而反复重试。
      const missing = /HTTP (403|404)/.test(e.message);
      const code = missing ? 404 : 502;
      stats.errors.push(`crate ${safe}: ${e.message}`);
      if (!missing) errlog(`[registry] 失败 ${safe}: ${e.message}`);
      return send(res, code, e.message, 'text/plain');
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    log(`[registry] ${req.method} ${url}`);

    // cargo 会在这个位置取 config.json。依 registry URL 的写法不同，
    // 它可能落在 /config.json（registry 指向 /index/ 时），
    // 也可能落在 /index/config.json（registry 指向根时）。两个都认，
    // 免得因为一处路径差异又变成一句无从下手的 502。
    if (url === '/config.json' || url === '/index/config.json') {
      return handleConfig(res);
    }
    if (url.startsWith('/index/')) {
      return handleIndex(res, url.slice('/index/'.length));
    }
    if (url.startsWith('/crates/')) {
      return handleCrate(res, url.slice('/crates/'.length));
    }

    return send(res, 404, '本地开发 registry：可用路径 /config.json, /index/<路径>, /crates/<name>/<version>/download', 'text/plain');
  });

  server.__stats = stats;
  // 监听后校正端口：传 port=0 时真实端口只有此刻才知道。
  // config.json 的 dl 必须与它一致，否则 cargo 会拿到 :0 这种无效地址。
  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
  });
  return server;
}

module.exports = { createRegistryServer, indexPathFor, UPSTREAM_INDEX, UPSTREAM_CRATES };
