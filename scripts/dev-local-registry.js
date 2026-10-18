#!/usr/bin/env node
/**
 * 本地明文 HTTP registry — 让 cargo 在 schannel 不可用的机器上也能装依赖
 * ======================================================================
 * 背景（已逐项实测）
 * --------------
 * 本机受限会话下 schannel 无法获取凭证句柄：
 *   schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
 * curl / PowerShell / cargo 的 HTTPS 全部失败；Node（内置 OpenSSL 根证书）与
 * git（mingw ca-bundle）正常。cargo 只肯用 HTTPS，且对 HTTPS 会发 CONNECT，
 * 而 CONNECT 隧道里 TLS 仍由 cargo 自己完成 —— 所以普通代理救不了它。
 *
 * 解法：把 cargo 的数据源换成**明文 HTTP 的本地 registry**（见 scripts/lib/dev-registry.js）。
 *   - 索引：按需去 index.crates.io 取（Node 做 TLS），缓存到磁盘；
 *   - crate：本地没有就去 static.crates.io 下载并缓存。
 *
 * 完整性说明：cargo 仍会用 Cargo.lock 记录的官方 sha256 校验每个 .crate，
 * 因此走明文 HTTP 不降低完整性保证 —— 篡改会在校验环节被发现。
 *
 * 用法:
 *   node scripts/dev-local-registry.js [--port=19780]
 *
 * 这是**开发环境的绕行方案**：正常网络（schannel 可用）下不需要它。
 * 仅监听 127.0.0.1，不做通用开放代理。
 */

'use strict';

const path = require('path');

const { createRegistryServer } = require('./lib/dev-registry');

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice(7)) : 19780;

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.rust', 'registry-cache');

const server = createRegistryServer({ cacheDir: CACHE_DIR, port: PORT });

server.on('error', (e) => {
  console.error(`[registry] 监听失败: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================================');
  console.log(' 本地明文 HTTP registry（开发环境绕过 schannel）');
  console.log(` 监听  : http://127.0.0.1:${PORT}`);
  console.log(` 缓存  : ${path.relative(ROOT, CACHE_DIR)}`);
  console.log(' 索引  : https://index.crates.io   → 按需缓存');
  console.log(' crate  : https://static.crates.io  → 按需下载并缓存');
  console.log(' Ctrl+C 停止');
  console.log('============================================================');
});

process.on('SIGINT', () => {
  const s = server.__stats;
  console.log(`\n[registry] 索引 命中${s.indexHits}/下载${s.indexFetches}`
    + `, crate 命中${s.crateHits}/下载${s.crateFetches}`
    + `, 共 ${(s.bytes / 1024 / 1024).toFixed(1)} MB`);
  if (s.errors.length) {
    console.log(`[registry] 错误 ${s.errors.length} 条（前 5 条）:`);
    for (const e of s.errors.slice(0, 5)) console.log('  ' + e);
  }
  server.close(() => process.exit(0));
});
