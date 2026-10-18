#!/usr/bin/env node
/**
 * IndexedDB 参考库验证 — 在真实 Chrome 里跑完整导入，然后回读核对
 * ================================================================
 * 背景: 参考库原先存在 localStorage，受 Chromium「每 origin 5 MiB」配额限制，
 *       全量 base/（约 10.9 万条、2200 万字符）根本写不进去，启动必弹
 *       「网点数据导入失败：存储空间不足」。改用 IndexedDB 后需要验证两件事：
 *       装得下，以及旧版遗留的 localStorage 副本会被清掉。
 *
 * 场景 A（全新安装）: 空 profile 打开应用 →
 *   - 31 个省、10 万条以上全部落进 IndexedDB；
 *   - localStorage 里不再有 poref_data_* / poref_meta / geojson_cache_*；
 *   - 提示语是「已从 base 目录覆盖导入」，不是「导入失败」。
 *
 * 场景 B（旧版升级）: 新 profile，在文档加载前把旧方案的数据塞进 localStorage
 *   （分片 + 元数据 + 旧 GeoJSON 缓存 + **与当前 base 完全一致的签名**），
 *   然后打开应用 →
 *   - 旧分片被搬进 IndexedDB（控制台出现「搬入 IndexedDB」）；
 *   - 旧 GeoJSON 缓存被清掉（控制台出现「旧 GeoJSON 缓存」）；
 *   - 尽管签名一致，也必须强制重新导入 base，得到完整 31 省（这是
 *     PODatabase.legacyUpgrade() 存在的意义，否则会停在搬过来的那 2 条上）；
 *   - 旧 localStorage 键全部消失。
 *
 * 全程使用独立临时 profile，绝不碰 data/browser-chrome 里的真实数据。
 *
 * 用法:
 *   node scripts/verify-idb-storage.js [--port=19877] [--timeout=300] [--keep]
 *
 * 退出码: 0 = 全部通过；1 = 有断言失败
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const Server = require('../server');

const ROOT = path.join(__dirname, '..');
const DEBUG_PORT_A = 9341;
const DEBUG_PORT_B = 9342;

// 独立交叉核对：这两个省的 base 文件自 Electron 版最后一次导入（9/27）以来未变，
// 因此新导入的记录数必须与旧库（.userdata 里那套）完全一致。
// 110000（北京）的 base 在 9/28 9:57 更新过，只报告不硬断言。
const KNOWN_COUNTS = { 120000: 892, 130000: 4943 };
const MIN_TOTAL = 90000;
const EXPECTED_PROVINCES = 31;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// Chrome 与 CDP
// ============================================================

function findChrome() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  const cands = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 下一个 */ }
  }
  return '';
}

/** 极简 CDP 客户端：send(method, params) + on(event, handler) */
function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = new Map();
    let nextId = 1;

    ws.addEventListener('open', () => resolve({
      send(method, params, timeoutMs) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP ${method} 超时`));
          }, timeoutMs || 20000);
          pending.set(id, { res, rej, timer });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, handler) { handlers.set(method, handler); },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    }));

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id == null) {
        const h = handlers.get(msg.method);
        if (h) h(msg.params);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    });

    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  return '';
}

/** 页面内求值（支持 await） */
async function evaluate(cdp, expression, timeoutMs) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, timeoutMs || 30000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内异常');
  return r.result ? r.result.value : undefined;
}

// ============================================================
// 页面内表达式
// ============================================================

/** 轻量轮询：只读元数据，不做昂贵的序列化 */
const POLL_EXPR = `(() => {
  try {
    if (typeof PODatabase === 'undefined') return { ready: false };
    const stats = PODatabase.getStats();
    const ov = document.getElementById('dialog-overlay');
    const msg = document.getElementById('dialog-message');
    return {
      ready: true,
      count: PODatabase.count(),
      provinces: stats.provinces.length,
      recs: stats.provinces.reduce((s, p) => s + p.postCount + p.spbCount, 0),
      dialogVisible: !!(ov && ov.classList.contains('active')),
      dialogText: msg ? (msg.textContent || '').trim() : '',
    };
  } catch (e) { return { ready: false, error: String((e && e.message) || e) }; }
})()`;

/** 完整审计：一次性统计 IndexedDB 体积、localStorage 残留、各省条数 */
const AUDIT_EXPR = `(async () => {
  const stats = PODatabase.getStats();
  const lsBad = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('poref_data_') || k === 'poref_meta' || k.startsWith('geojson_cache_'))) lsBad.push(k);
  }
  let idbProvs = 0, idbChars = 0, idbErr = '';
  try {
    const rows = await IdbKV.entries('poref_data_');
    idbProvs = rows.length;
    for (const [, v] of rows) idbChars += JSON.stringify(v).length;
  } catch (e) { idbErr = String((e && e.message) || e); }
  const ov = document.getElementById('dialog-overlay');
  const msg = document.getElementById('dialog-message');
  const perProvince = {};
  for (const p of stats.provinces) perProvince[p.adcode] = p.postCount + p.spbCount;
  return {
    origin: location.origin,
    count: PODatabase.count(),
    provinces: stats.provinces.length,
    post: stats.provinces.reduce((s, p) => s + p.postCount, 0),
    spb: stats.provinces.reduce((s, p) => s + p.spbCount, 0),
    perProvince,
    idbProvs, idbChars, idbErr,
    idbSupported: IdbKV.isSupported(),
    idbWrites: (window.__idbWrites || []),
    lsKeys: localStorage.length,
    lsBad,
    signature: localStorage.getItem('poref_base_signature'),
    dialogVisible: !!(ov && ov.classList.contains('active')),
    dialogText: msg ? (msg.textContent || '').trim() : '',
  };
})()`;

/**
 * 旧版方案在 localStorage 里留下的东西（场景 B 在文档加载前注入）。
 * 同时挂一个 IDBObjectStore.put 探针：把每次写入的键与数组长度记进
 * window.__idbWrites —— 页面极早期（ready() 阶段）的 console 消息可能被 CDP
 * 漏收，用写入序列来断言"旧分片确实被搬进来了、而且发生在 base 覆盖之前"更可靠。
 */
function seedSource(sig) {
  const legacyRecords = [
    { province: '北京市', city: '北京市', district: '东城区', name: '旧版遗留网点A', postalCode: '100010', address: '', services: '', detailLink: '', source: 'post' },
    { province: '北京市', city: '北京市', district: '西城区', name: '旧版遗留网点B', postalCode: '100032', address: '', services: '', detailLink: '', source: 'post' },
  ];
  const legacyMeta = {
    totalCount: 2, sources: ['post'],
    provinces: [{ name: '北京市', adcode: 110000, postCount: 2, spbCount: 0 }],
    lastImportTime: '2026-01-01T00:00:00.000Z',
  };
  return `(() => {
    try {
      window.__idbWrites = [];
      if (typeof IDBObjectStore !== 'undefined') {
        const origPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          try {
            if (key != null) {
              window.__idbWrites.push({
                key: String(key),
                len: Array.isArray(value) ? value.length : (value && typeof value === 'object' ? -1 : null),
              });
            }
          } catch (e) { /* 忽略 */ }
          return origPut.apply(this, arguments);
        };
      }
      localStorage.setItem('poref_data_110000', ${JSON.stringify(JSON.stringify(legacyRecords))});
      localStorage.setItem('poref_meta', ${JSON.stringify(JSON.stringify(legacyMeta))});
      localStorage.setItem('geojson_cache_100000', '{"type":"FeatureCollection","features":[{"fake":true}]}');
      localStorage.setItem('poref_base_signature', ${JSON.stringify(sig || '')});
    } catch (e) { /* 忽略 */ }
  })();`;
}

// ============================================================
// 单场景执行
// ============================================================

/**
 * @param {{exe:string, port:number, debugPort:number, seedSig:string|null, timeoutMs:number}} cfg
 */
async function runScenario(label, cfg) {
  const appUrl = `http://127.0.0.1:${cfg.port}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postmark-idb-verify-'));
  const consoleLines = [];

  console.log(`\n=========== ${label} ===========`);
  console.log(`[${label}] profile : ${profileDir}`);
  console.log(`[${label}] 应用地址: ${appUrl}`);

  // about:blank 起步：这样能在应用文档加载前注册注入脚本
  const child = spawn(cfg.exe, [
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    `--remote-debugging-port=${cfg.debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  const result = { label, ok: false, failures: [], audit: null, consoleLines };
  try {
    const wsUrl = await waitForPageTarget(cfg.debugPort, 30000);
    if (!wsUrl) throw new Error('等不到页面 target（Chrome 可能启动失败）');

    const cdp = await openCdp(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || [])
        .map((a) => (a.value != null ? a.value : (a.description || '')))
        .join(' ');
      if (text) consoleLines.push(text);
    });

    if (cfg.seedSig !== null) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seedSource(cfg.seedSig) });
      console.log(`[${label}] 已注入旧版 localStorage 数据（含与当前 base 一致的签名）`);
    }

    await cdp.send('Page.navigate', { url: appUrl });

    // 轮询等导入完成
    const deadline = Date.now() + cfg.timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const s = await evaluate(cdp, POLL_EXPR, 30000);
        if (s && s.ready) {
          last = s;
          if (s.count > MIN_TOTAL && s.provinces >= EXPECTED_PROVINCES) break;
        }
      } catch (e) { /* 页面还在加载 */ }
      await sleep(2000);
    }
    if (!last) throw new Error('页面始终没有就绪');

    // 等 IndexedDB 的最后一批写入落定，再做完整审计
    await sleep(2000);
    const audit = await evaluate(cdp, AUDIT_EXPR, 120000);
    result.audit = audit;

    // ---- 断言 ----
    const fail = (m) => result.failures.push(m);
    if (audit.idbErr) fail(`IndexedDB 读取报错: ${audit.idbErr}`);
    if (!audit.idbSupported) fail('IndexedDB 不可用');
    if (audit.provinces !== EXPECTED_PROVINCES) fail(`省份数 ${audit.provinces} ≠ ${EXPECTED_PROVINCES}`);
    if (audit.count <= MIN_TOTAL) fail(`记录数 ${audit.count} ≤ ${MIN_TOTAL}`);
    if (audit.idbProvs !== audit.provinces) fail(`IndexedDB 分片 ${audit.idbProvs} ≠ 省份数 ${audit.provinces}`);
    if (audit.idbChars < 20000000) fail(`IndexedDB 参考库仅 ${audit.idbChars} 字符，远低于预期的 2200 万`);
    if (audit.count !== audit.post + audit.spb) fail(`总数 ${audit.count} ≠ post+spb ${audit.post + audit.spb}`);
    if (audit.lsBad.length > 0) fail(`localStorage 仍有旧键: ${audit.lsBad.join(', ')}`);
    if (/导入失败/.test(audit.dialogText)) fail(`弹出失败提示: ${audit.dialogText.split('\n')[0]}`);

    for (const [adc, expected] of Object.entries(KNOWN_COUNTS)) {
      const actual = audit.perProvince[adc];
      if (actual !== expected) fail(`省份 ${adc} 条数 ${actual} ≠ 旧库基准 ${expected}`);
    }

    if (cfg.seedSig !== null) {
      // 用写入序列（而不是 console，页面极早期的消息可能被 CDP 漏收）来断言搬运行为
      const writes = (audit.idbWrites || []).filter((w) => w.key === 'poref_data_110000');
      const absorbIdx = writes.findIndex((w) => w.len === 2);
      const baseIdx = writes.findIndex((w) => w.len > 1000);
      if (absorbIdx < 0) {
        fail(`旧版分片没有被搬进 IndexedDB（poref_data_110000 的写入序列: ${writes.map((w) => w.len).join(',') || '空'}）`);
      } else if (baseIdx < 0 || baseIdx < absorbIdx) {
        fail(`搬运与 base 覆盖导入的顺序不对（写入序列: ${writes.map((w) => w.len).join(',')}）`);
      }
      if (audit.perProvince[110000] === 2) fail('参考库停在搬过来的 2 条上：legacyUpgrade 强制导入没有生效');
    }
    result.ok = result.failures.length === 0;
  } catch (e) {
    result.failures.push(e.message);
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    await sleep(1000);
    if (!cfg.keep) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      console.log(`[${label}] --keep：保留 profile ${profileDir}`);
    }
  }

  // ---- 报告 ----
  const a = result.audit;
  if (a) {
    console.log(`[${label}] origin        : ${a.origin}`);
    console.log(`[${label}] 省份 / 记录数  : ${a.provinces} / ${a.count}  (post ${a.post} + spb ${a.spb})`);
    console.log(`[${label}] IndexedDB     : ${a.idbProvs} 个分片, ${a.idbChars.toLocaleString()} 字符`);
    console.log(`[${label}] localStorage  : ${a.lsKeys} 个键（旧方案残留 ${a.lsBad.length} 个）`);
    console.log(`[${label}] 提示语        : ${(a.dialogText || '(无)').split('\n')[0]}`);
    console.log(`[${label}] 交叉核对      : ${Object.entries(KNOWN_COUNTS).map(([k, v]) => `${k}=${a.perProvince[k]}(基准${v})`).join('  ')}`);
    if (cfg.seedSig !== null) {
      const w = (a.idbWrites || []).filter((x) => x.key === 'poref_data_110000');
      console.log(`[${label}] 110000 写入序列: ${w.map((x) => x.len).join(' → ') || '(空)'}  (2 = 搬运旧分片, >1000 = base 覆盖)`);
    }
    console.log(`[${label}] 控制台输出    : 共 ${consoleLines.length} 条`);
    for (const l of consoleLines.slice(0, 30)) console.log(`[${label}]   | ${l.slice(0, 200)}`);
  }
  console.log(`[${label}] 结论          : ${result.ok ? '通过' : '失败'}`);
  for (const f of result.failures) console.log(`[${label}]   ✗ ${f}`);
  return result;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const arg = (name, def) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  const port = Number(arg('port', '19877'));
  const timeoutMs = Number(arg('timeout', '300')) * 1000;
  const keep = process.argv.includes('--keep');

  const exe = findChrome();
  if (!exe) { console.error('找不到 Chrome'); process.exit(1); }
  console.log(`[verify] Chrome: ${exe}`);

  let started;
  try {
    started = await Server.start({ root: ROOT, host: Server.DEFAULT_HOST, port });
  } catch (e) {
    console.error(`[verify] 服务器启动失败（端口 ${port} 可能被占用）: ${e.message}`);
    process.exit(1);
  }
  console.log(`[verify] 服务器: http://${Server.DEFAULT_HOST}:${started.port}`);

  const results = [];
  try {
    const a = await runScenario('场景A 全新安装', {
      exe, port: started.port, debugPort: DEBUG_PORT_A, seedSig: null, timeoutMs, keep,
    });
    results.push(a);

    const sig = a.audit ? a.audit.signature : '';
    if (!sig) {
      console.error('[verify] 场景A 没拿到 base 签名，场景B 无法验证「签名一致仍强制导入」');
    }

    const b = await runScenario('场景B 旧版升级', {
      exe, port: started.port, debugPort: DEBUG_PORT_B, seedSig: sig || '', timeoutMs, keep,
    });
    results.push(b);
  } finally {
    try { started.server.close(); } catch (e) { /* ignore */ }
  }

  console.log('\n=========== 汇总 ===========');
  for (const r of results) console.log(`${r.ok ? '通过' : '失败'}  ${r.label}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n失败项:');
    for (const r of failed) for (const f of r.failures) console.log(`  ${r.label}: ${f}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[verify] 异常:', e && e.stack || e);
  process.exit(1);
});
