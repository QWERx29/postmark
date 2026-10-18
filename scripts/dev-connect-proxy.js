#!/usr/bin/env node
/**
 * 本地 TLS 终结代理 — 给只能用 schannel 的工具（cargo / curl）用
 * ================================================================
 * 为什么需要它
 * ------------
 * 本机受限会话下 schannel 拿不到凭证句柄：
 *   schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
 * 于是 curl / PowerShell / cargo 的 HTTPS 全部失败；而 Node（内置 OpenSSL 根证书）
 * 与 git（mingw 的 ca-bundle.crt）都能正常联网 —— 已实测确认。
 *
 * 关键点：**CONNECT 隧道解决不了这个问题**。隧道只转发 TCP 字节，TLS 握手
 * 仍由客户端自己完成，schannel 照样失败。要绕开，代理必须终结客户端侧的 TLS：
 * 客户端对本地代理说**明文 HTTP**，由本进程用 Node 的 OpenSSL 去连真正的 HTTPS。
 *
 *   cargo ──明文 HTTP──> 本代理 ──TLS(OpenSSL)──> static.crates.io
 *
 * 用法:
 *   node scripts/dev-connect-proxy.js [--port=19780]
 *
 * 让 cargo 走它（见 src-tauri/.cargo/config.toml 的 [http] proxy）:
 *   CARGO_HTTP_PROXY=http://127.0.0.1:19780
 *
 * 安全说明：本代理只监听 127.0.0.1，且**只允许白名单域名**，不做通用开放代理。
 * 这是开发环境的绕行方案，不是应用的一部分，也不该进生产；
 * 正常网络（schannel 可用）下完全不需要它。
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice(7)) : 19780;

/** 只代理这些域名：crate 下载与索引，避免变成开放代理 */
const ALLOWED_HOSTS = new Set([
  'static.crates.io',
  'index.crates.io',
  'crates.io',
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
]);

let served = 0;
let bytes = 0;
const failures = [];

function handleRequest(req, res) {
  let target;
  try {
    // 正向代理用法：请求行里是绝对 URI
    target = new URL(req.url);
  } catch (e) {
    // 注意：这里会收到 CONNECT。
    // CONNECT 的语义是"把 TCP 隧道给我，TLS 我自己来"—— 但本机 TLS 恰恰是坏的
    // （schannel 拿不到凭证），所以 CONNECT 对本问题毫无帮助，直接明确拒绝，
    // 免得客户端卡在等隧道上（表现为 "Proxy CONNECT aborted" 之类的怪错误）。
    const isConnect = req.method === 'CONNECT';
    console.error(`[proxy] 拒绝 ${req.method} ${req.url}`
      + (isConnect ? '（CONNECT 无法解决本机 schannel 问题，见文件头注释）' : '（非绝对 URI）'));
    res.writeHead(isConnect ? 501 : 400, { 'content-type': 'text/plain' });
    return res.end(isConnect
      ? '本代理不提供 CONNECT：它无法绕过 schannel。请让客户端使用明文 HTTP 正向代理。'
      : '需要绝对 URI（正向代理用法）');
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    console.error(`[proxy] 拒绝非白名单域名 ${target.hostname}`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end(`域名不在白名单: ${target.hostname}`);
  }

  console.log(`[proxy] ${req.method} ${target.href}`);

  const opts = {
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: req.method,
    headers: Object.assign({}, req.headers, {
      host: target.host,
      // 让站点直接回原始内容，别做压缩协商，减少一层出错可能
      'accept-encoding': 'identity',
    }),
  };

  const upstream = https.request(opts, (up) => {
    served++;
    res.writeHead(up.statusCode || 502, up.headers);
    up.on('data', (chunk) => { bytes += chunk.length; });
    up.pipe(res);
  });

  upstream.on('error', (e) => {
    failures.push(`${target.hostname}${target.pathname}: ${e.message}`);
    console.error(`[proxy] ${req.method} ${target.href} 失败: ${e.message}`);
    try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Bad Gateway'); } catch (err) { /* ignore */ }
  });

  req.pipe(upstream);
}

const server = http.createServer(handleRequest);
server.on('error', (e) => {
  console.error(`[proxy] 监听失败: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================================');
  console.log(' 本地 TLS 终结代理（开发环境绕过 schannel）');
  console.log(` 监听  : http://127.0.0.1:${PORT}`);
  console.log(` 白名单: ${[...ALLOWED_HOSTS].join(', ')}`);
  console.log(` 用法  : CARGO_HTTP_PROXY=http://127.0.0.1:${PORT} cargo build`);
  console.log(' Ctrl+C 停止');
  console.log('============================================================');
});

process.on('SIGINT', () => {
  console.log(`\n[proxy] 已服务 ${served} 个请求, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (failures.length) console.log(`[proxy] 失败 ${failures.length} 次`);
  server.close(() => process.exit(0));
});
