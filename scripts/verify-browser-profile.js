#!/usr/bin/env node
/**
 * 浏览器 profile 验证 — 确认迁移后的数据能被浏览器真正读出
 * ==========================================================
 * 只"复制字节 + 回读 leveldb"只能证明磁盘上的数据正确，
 * 不能证明 Chrome 认这份 profile。本脚本补上后一半：
 * 用无头 Chrome 打开专属 profile，通过 DevTools 协议在页面里
 * 直接读 localStorage（记录）与 IndexedDB（PO 参考库分表），
 * 报告条数与体积。
 *
 * 注意：真 Chrome 需要能启动 crashpad（本机沙箱环境下可能被拦，
 * 表现为 "crash server failed to launch, self-terminating"）。
 *
 * 属于一次性验证工具，不是应用的一部分。
 *
 *   node scripts/verify-browser-profile.js --port=19876
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'data', 'browser-chrome');
const DEBUG_PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(require('os').homedir(), 'AppData', 'Local');
  const cands = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* next */ } }
  return '';
}

/** 等 DevTools 端口就绪，返回 page target 的 webSocketDebuggerUrl */
async function waitForTarget(port, appUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(appUrl));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  return '';
}

/** 在页面里执行表达式，返回 JSON 值 */
function evaluate(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP 超时')); }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* ignore */ }
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        return reject(new Error(r.exceptionDetails.text || '页面内异常'));
      }
      resolve(r.result ? r.result.value : undefined);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败')); });
  });
}

async function main() {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.slice(7)) : 19876;
  const appUrl = `http://127.0.0.1:${port}`;

  const exe = findChrome();
  if (!exe) { console.error('找不到 Chrome'); process.exit(1); }
  if (!fs.existsSync(PROFILE_DIR)) { console.error(`找不到 profile: ${PROFILE_DIR}`); process.exit(1); }

  console.log(`[verify] Chrome   : ${exe}`);
  console.log(`[verify] profile  : ${PROFILE_DIR}`);
  console.log(`[verify] 应用地址 : ${appUrl}`);
  console.log(`[verify] 注意：Chrome 需要访问该地址，请确保本地服务器已启动。\n`);

  const child = spawn(exe, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    appUrl,
  ], { stdio: 'ignore', detached: false });

  let exitCode = 0;
  try {
    const wsUrl = await waitForTarget(DEBUG_PORT, appUrl, 25000);
    if (!wsUrl) throw new Error('等不到页面 target（Chrome 可能启动失败）');

    // 等应用把记录写进 localStorage、把参考库写进 IndexedDB
    // （首次会先做 base 导入，给足时间）
    let result = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      result = await evaluate(wsUrl, `(async () => {
        const recs = localStorage.getItem('postmark_records');
        let n = null, provs = -1, idbChars = 0;
        try { n = recs ? JSON.parse(recs).length : 0; } catch (e) { n = 'parse-error'; }
        // PO 参考库自 2026-09-28 起改存 IndexedDB（见 js/idb.js），
        // 不再出现在 localStorage 里
        try {
          const rows = await IdbKV.entries('poref_data_');
          provs = rows.length;
          for (const [, v] of rows) idbChars += JSON.stringify(v).length;
        } catch (e) { /* IndexedDB 不可用 */ }
        return { n, provs, idbChars, origin: location.origin, keys: localStorage.length };
      })()`, 30000);
      if (result && result.n) break;
      await sleep(1000);
    }

    console.log('---- 浏览器内实测结果 ----');
    console.log(` origin          : ${result.origin}`);
    console.log(` localStorage 键 : ${result.keys}`);
    console.log(` 记录数          : ${result.n}`);
    console.log(` PO 参考库分表   : ${result.provs} 个 / ${result.idbChars.toLocaleString()} 字符 (IndexedDB)`);
    console.log('--------------------------');

    if (result.n === 1107) {
      console.log('\n[verify] 通过：浏览器读出了迁移前的全部 1107 条记录。');
    } else {
      console.log(`\n[verify] 未通过：期望 1107 条，实际 ${result.n} 条。`);
      exitCode = 1;
    }
  } catch (e) {
    console.error('[verify] 失败:', e.message);
    exitCode = 1;
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }
  process.exit(exitCode);
}

main();
