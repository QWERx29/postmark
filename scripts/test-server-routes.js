#!/usr/bin/env node
/**
 * 主进程 HTTP 路由测试
 * =====================
 * 用桩件替换 electron 模块后加载真实的 main.js，从而在不创建窗口的前提下
 * 驱动生产代码里的路由分支（/api/crawl/*、/output/*、方法限制、路径穿越防护）。
 *
 * 用法:
 *   node scripts/test-server-routes.js            # 离线用例
 *   node scripts/test-server-routes.js --net      # 追加一次真实抓取
 */

'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const Intelligent = require(path.join(ROOT, 'crawler-intelligent.js'));

// ============================================================
// electron 桩件 —— 必须在 require('../main.js') 之前装好
// ============================================================

const readyCallbacks = [];
let quitCalled = false;

const fakeApp = {
  isPackaged: false,             // 开发模式：output 应落在项目目录
  getPath(name) {
    if (name === 'exe') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    return os.tmpdir();
  },
  getAppPath() { return ROOT; },
  whenReady() { return Promise.resolve(); },
  on(event, cb) { readyCallbacks.push([event, cb]); },
  quit() { quitCalled = true; },
};

class FakeBrowserWindow {
  constructor() {
    this.webContents = {
      setWindowOpenHandler() {},
      on() {},
    };
  }
  static getAllWindows() { return []; }
  once() {}
  on() {}
  setMenuBarVisibility() {}
  loadURL() { return Promise.resolve(); }
}

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  shell: { openExternal() {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

// ============================================================
// 载入 main.js（会启动真实的 HTTP 服务器）
// ============================================================

let BASE = '';

async function bootServer() {
  require(path.join(ROOT, 'main.js'));
  // 等待服务器监听完成（main.js 内 console.log 输出端口）
  for (let i = 0; i < 100; i++) {
    for (const port of [19876, 0]) {
      // 端口在启动后可能变化，这里直接探测常见端口
      const candidates = [19876];
      for (const p of candidates) {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/api/base-files`);
          if (res.ok) { BASE = `http://127.0.0.1:${p}`; return; }
        } catch (e) { /* 还没起来 */ }
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('服务器未能启动');
}

// ============================================================
// 断言工具
// ============================================================

let passed = 0;
let failed = 0;

/** 测试期间产生的文件，结束时统一清理 */
const createdFiles = [];

function trackReport(status) {
  if (!status || !status.result) return;
  // 对比作业会落两个报告：compare_report_*.txt 与 intelligent_report_*.txt
  for (const k of ['reportPath', 'intelligentReportPath']) {
    if (status.result[k]) createdFiles.push(status.result[k]);
  }
}

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`); }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

/** 启动作业并轮询到结束，返回最终 status */
async function runToEnd(body, timeoutMs = 180000) {
  const start = await api('POST', '/api/crawl/start', body);
  if (start.status !== 200) return { startStatus: start.status, error: start.json };

  let cursor = 0;
  const lines = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/crawl/status?job=${start.json.jobId}&cursor=${cursor}`);
    const s = await r.json();
    lines.push(...s.lines);
    cursor = s.cursor;
    if (s.state !== 'running') return { startStatus: 200, status: s, lines };
    await new Promise(r2 => setTimeout(r2, 500));
  }
  return { startStatus: 200, timeout: true, lines };
}

// ============================================================
// 用例
// ============================================================

async function testRoutes() {
  console.log('\n[1] 路由与方法限制');

  const provinces = await api('GET', '/api/crawl/provinces');
  eq('GET /api/crawl/provinces 状态', provinces.status, 200);
  eq('返回 31 个省份', Array.isArray(provinces.json) && provinces.json.length, 31);
  eq('首项为北京', provinces.json && provinces.json[0].name, '北京');

  const outFiles = await api('GET', '/api/output-files');
  eq('GET /api/output-files 状态', outFiles.status, 200);
  check('output-files 返回数组', Array.isArray(outFiles.json));

  const bad = await api('GET', '/api/crawl/nosuch');
  eq('未知爬虫接口 → 404', bad.status, 404);

  const badKind = await api('POST', '/api/crawl/start', { kind: 'nosuch' });
  eq('未知作业类型 → 400', badKind.status, 400);
  check('400 带错误信息', !!(badKind.json && badKind.json.error), JSON.stringify(badKind.json));

  const badJson = await fetch(BASE + '/api/crawl/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  });
  eq('非法 JSON 请求体 → 400', badJson.status, 400);

  const notFound = await api('GET', '/api/crawl/status?job=nope&cursor=0');
  eq('不存在的作业 → 404', notFound.status, 404);

  // 只允许列出的两个接口用 POST
  const wrongMethod = await fetch(BASE + '/api/crawl/status?job=x', { method: 'POST' });
  eq('对 /api/crawl/status 用 POST → 405', wrongMethod.status, 405);

  const postToStatic = await fetch(BASE + '/index.html', { method: 'POST' });
  eq('对静态文件用 POST → 405', postToStatic.status, 405);
}

async function testPathTraversal() {
  console.log('\n[2] 路径穿越与静态服务');

  const ok = await fetch(BASE + '/index.html');
  eq('GET /index.html', ok.status, 200);

  // /output/* 目录穿越：应被拒或被规范化到目录内
  const esc1 = await fetch(BASE + '/output/..%2f..%2fmain.js');
  check('/output/ 穿越被拒绝', esc1.status === 403 || esc1.status === 404,
    `HTTP ${esc1.status}`);

  const esc2 = await fetch(BASE + '/base/..%2f..%2fmain.js');
  check('/base/ 穿越被拒绝', esc2.status === 403 || esc2.status === 404,
    `HTTP ${esc2.status}`);

  // /output/ 下的正常文件（若存在）
  const list = await api('GET', '/api/output-files');
  if (Array.isArray(list.json) && list.json.length > 0) {
    const f = list.json[0].name;
    const r = await fetch(BASE + '/output/' + encodeURIComponent(f));
    eq(`GET /output/${f}`, r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    check('产出 CSV 可被 GBK 解码且有内容',
      buf.length > 0 && require(path.join(ROOT, 'node_modules', 'iconv-lite')).decode(buf, 'gbk').length > 0);
  } else {
    console.log('  --   output 目录为空，跳过产出文件读取用例');
  }
}

async function testCompareAndCross() {
  console.log('\n[3] 对比作业与横向对比作业（基于 base 目录）');

  // 对比作业的期望值从两个目录的实际内容推出来：开发机上 output/ 可能留着
  // 上一次真实抓取的结果（用户跑过全国抓取后就是这样），写死「应为空」会误报。
  const outNames = ((await api('GET', '/api/output-files')).json || []).map(f => f.name);
  const baseNames = ((await api('GET', '/api/base-files')).json || []).map(f => f.name);
  const outPrefixes = new Set(outNames.map(f => String(f).replace(/-\d{8}\.csv$/i, '')));
  const basePrefixes = new Set(baseNames.map(f => String(f).replace(/\+base\.csv$/i, '')));
  const expectCompared = [...outPrefixes].filter(p => basePrefixes.has(p)).length;
  const expectMissing = [...basePrefixes].filter(p => !outPrefixes.has(p)).length;

  const cmp = await runToEnd({ kind: 'compare' });
  trackReport(cmp.status);
  eq('对比作业状态', cmp.status && cmp.status.state, 'done');
  if (cmp.status && cmp.status.state === 'done') {
    const r = cmp.status.result;
    eq(`对比文件对数（output ${outPrefixes.size} / base ${basePrefixes.size}）`,
      r.compared, expectCompared);
    eq('canApply 跟随 output 是否非空', r.canApply, outPrefixes.size > 0);
    eq('base 中 output 缺失的前缀数', r.missing, expectMissing);
    eq('对比计数自洽', r.compared + r.added + r.missing, r.pairs.length);
    check('报告文件已生成', fs.existsSync(r.reportPath || ''), r.reportPath);
    check('报告体积与逐文件输出一致',
      (r.reportText || '').length > 0 && /对比报告 —/.test(r.reportText || ''));

    // ---- 智能判别报告（对应 crawler.py 的 intelligent_compare）----
    check('结果含 intelligent 数组', Array.isArray(r.intelligent), typeof r.intelligent);
    const intel = Array.isArray(r.intelligent) ? r.intelligent : [];
    eq('智能判别逐「已对比」前缀一条', intel.length, expectCompared);
    if (intel.length) {
      const one = intel[0];
      check('智能判别条目字段齐全',
        ['prefix', 'sourceType', 'newCount', 'oldCount', 'summary', 'changes',
         'unmatched1', 'unmatched2', 'blocks']
          .every(k => k in one),
        Object.keys(one).join(','));
      check('sourceType 只可能是 post / spb',
        intel.every(p => p.sourceType === 'post' || p.sourceType === 'spb'),
        intel.map(p => p.sourceType).join(','));
      check('summary 计数自洽（新增/撤下/区块为非负整数）',
        intel.every(p => {
          const s = p.summary || {};
          return [s.new, s.removed, s.blocks, s.comprehensive]
            .every(n => Number.isInteger(n) && n >= 0);
        }), JSON.stringify(intel.map(p => p.summary)));
      // 明细裁剪到 cap=200 再返回（完整内容在报告文本里），summary 保留真实总数。
      // 这里按 min(总数, cap) 断言，全国尺度数据下才不会误报。
      const CAP = Intelligent.DETAIL_CAP;
      check('changes 不超过 cap', intel.every(p => p.changes.length <= CAP), '');
      check('unmatched1 条数 = min(summary.new, cap)',
        intel.every(p => p.unmatched1.length === Math.min(p.summary.new, CAP)),
        intel.map(p => `${p.unmatched1.length}/${p.summary.new}`).join(' '));
      check('unmatched2 条数 = min(summary.removed, cap)',
        intel.every(p => p.unmatched2.length === Math.min(p.summary.removed, CAP)),
        intel.map(p => `${p.unmatched2.length}/${p.summary.removed}`).join(' '));
      check('blocks 条数 = min(summary.blocks, cap)',
        intel.every(p => p.blocks.length === Math.min(p.summary.blocks, CAP)), '');
    }

    check('智能判别报告已落盘',
      fs.existsSync(r.intelligentReportPath || ''), r.intelligentReportPath);
    check('智能判别报告文件名与对比报告同一时间戳',
      path.basename(r.intelligentReportPath || '') ===
        path.basename(r.reportPath || '').replace(/^compare_report_/, 'intelligent_report_'),
      `${path.basename(r.intelligentReportPath || '')} vs ${path.basename(r.reportPath || '')}`);
    check('智能判别报告正文非空且含抬头',
      (r.intelligentReportText || '').length > 0 &&
        /智能判别报告 —/.test(r.intelligentReportText || ''), '');
    check('智能判别报告含逐文件分段',
      (r.intelligentReportText || '').includes('=== 智能判别分析:'),
      (r.intelligentReportText || '').slice(0, 200));
    // 落盘内容必须与返回给弹窗的一致（弹窗会直接把这段文本塞进「报告全文」）
    check('落盘文本与返回文本一致',
      fs.readFileSync(r.intelligentReportPath, 'utf8') === r.intelligentReportText);
  }

  // 横向对比走 base 目录 → 应有 31 个省份可对比
  const cross = await runToEnd({ kind: 'cross', useBase: true, provinces: ['北京', '上海'] });
  trackReport(cross.status);
  eq('横向对比作业状态', cross.status && cross.status.state, 'done');
  if (cross.status && cross.status.state === 'done') {
    const r = cross.status.result;
    eq('可对比省份数', r.provinceCount, 2);
    check('数据目录指向 base', /base$/.test(r.dataDir || ''), r.dataDir);
    check('报告文件已生成', fs.existsSync(r.reportPath || ''), r.reportPath);

    const bj = r.summary.find(s => s.abbr === 'bj');
    check('北京有汇总行', !!bj);
    if (bj) {
      // base/postbj+base.csv 实测 724 条（与 Python 回归基准一致）
      eq('北京 POST 条数', bj.postCount, 724);
      eq('北京 SPB 条数', bj.spbCount, 725);
      check('北京匹配数 > 0', bj.matchCount > 0, String(bj.matchCount));
    }
    check('报告含多省汇总', /多省汇总/.test(r.reportText || ''));

    // 弹窗用的逐省逐桶明细
    check('结果含 details', Array.isArray(r.details), typeof r.details);
    if (Array.isArray(r.details)) {
      eq('details 逐省一条', r.details.length, 2);
      const dbj = r.details.find(d => d.abbr === 'bj');
      check('details 含北京', !!dbj, JSON.stringify(r.details.map(d => d.abbr)));
      if (dbj) {
        // 与 Python 回归基准一致：北京精确匹配 706 对
        eq('北京精确匹配完整计数', dbj.counts.exact, 706);
        eq('北京精确匹配桶被裁剪到 cap=100', dbj.buckets.exact.length, 100);
        eq('北京精确桶字段齐全',
          Object.keys(dbj.buckets.exact[0]).sort().join(','),
          'district,postName,postcode,spbName');
        eq('postOnly 桶长度等于计数', dbj.buckets.postOnly.length, dbj.counts.postOnly);
      }
      // 明细必须是可 JSON 序列化的精简对象（弹窗直接吃这个结构）
      check('details 可 JSON 往返',
        JSON.stringify(r.details).length > 0 && JSON.parse(JSON.stringify(r.details)).length === 2);
    }
  }
}

async function testCancel() {
  console.log('\n[4] 取消作业');

  const start = await api('POST', '/api/crawl/start', {
    kind: 'crawl', provinces: ['上海', '北京', '天津'], doPost: false, doSpb: true, delay: 0,
  });
  eq('启动作业', start.status, 200);
  if (start.status !== 200) return;

  // 立刻取消
  const cancel = await api('POST', '/api/crawl/cancel', { job: start.json.jobId });
  eq('取消请求被接受', cancel.json && cancel.json.cancelled, true);

  // 轮询到结束
  let cursor = 0;
  let state = 'running';
  for (let i = 0; i < 60 && state === 'running'; i++) {
    const r = await fetch(`${BASE}/api/crawl/status?job=${start.json.jobId}&cursor=${cursor}`);
    const s = await r.json();
    cursor = s.cursor;
    state = s.state;
    if (state === 'running') await new Promise(r2 => setTimeout(r2, 500));
  }
  eq('取消后作业状态为 cancelled', state, 'cancelled');

  const again = await api('POST', '/api/crawl/cancel', { job: start.json.jobId });
  eq('重复取消返回 false', again.json && again.json.cancelled, false);
}

async function testLiveCrawl() {
  console.log('\n[5] 真实抓取（联网）');

  // 先记下跑测试前 output/ 里已有哪些文件，收尾时只删新增的那些
  const before = new Set(((await api('GET', '/api/output-files')).json || []).map(f => f.name));

  // 产出的 CSV 按「省份缩写+日期」命名，同一天重跑会覆盖同名文件 ——
  // 开发机上 output/spbtj-<今天>.csv 很可能正是用户上一次真实抓取的结果。
  // 所以把本次可能写到的文件先备份，收尾时原样恢复。
  const backups = new Map();
  for (const name of before) {
    if (!/^spbtj-\d{8}\.csv$/i.test(name)) continue;
    try { backups.set(name, fs.readFileSync(path.join(ROOT, 'output', name))); } catch (e) { /* 读不到就算了 */ }
  }

  const r = await runToEnd({
    kind: 'crawl', provinces: ['天津'], doPost: false, doSpb: true, delay: 0,
  });
  eq('抓取作业状态', r.status && r.status.state, 'done');
  if (!r.status || r.status.state !== 'done') return;

  const res = r.status.result;
  check('SPB 抓到数据', res.totalSpb > 0, `${res.totalSpb} 条`);
  eq('输出目录为项目目录（开发模式）',
     path.resolve(res.outputDir), path.resolve(ROOT, 'output'));
  check('产出文件落在项目 output/',
    res.files.length > 0 && res.files.every(f => path.resolve(f).startsWith(path.resolve(ROOT, 'output'))),
    JSON.stringify(res.files));

  // 通过 HTTP 拉回，验证渲染进程拿到的是可解析的 GBK CSV
  const files = await api('GET', '/api/output-files');
  const spbFile = files.json.find(f => f.name.startsWith('spbtj'));
  check('output-files 列出了新抓取的文件', !!spbFile, JSON.stringify(files.json.map(f => f.name)));

  if (spbFile) {
    const resp = await fetch(BASE + '/output/' + encodeURIComponent(spbFile.name));
    const buf = Buffer.from(await resp.arrayBuffer());
    const Engine = require(path.join(ROOT, 'crawler-engine.js'));
    const tmp = path.join(os.tmpdir(), spbFile.name);
    fs.writeFileSync(tmp, buf);
    const recs = Engine.readSpbCsv(tmp);
    fs.unlinkSync(tmp);
    check('CSV 可被引擎解析', recs.length > 0, `${recs.length} 条`);
    eq('省字段为全名', recs.length ? recs[0].province : '', '天津市');
  }

  // 本次只抓了 SPB 的天津。output 里是否已有天津 POST 得看跑测试前的状态：
  // 开发机上用户跑过全国抓取，就会留着 posttj-<日期>.csv。
  const hasPostTj = [...before].some(n => /^posttj-\d{8}\.csv$/i.test(n));
  const crossEmpty = await runToEnd({ kind: 'cross', useBase: false, provinces: ['天津'] });
  trackReport(crossEmpty.status);
  if (crossEmpty.status && crossEmpty.status.state === 'done') {
    eq(hasPostTj ? 'output 中已有天津 POST 时可对比' : 'output 中缺 POST 时天津被跳过',
      crossEmpty.status.result.provinceCount, hasPostTj ? 1 : 0);
  }

  // 同一个天津，在 base 里两个源都有 → 应能对比
  const crossBase = await runToEnd({ kind: 'cross', useBase: true, provinces: ['天津'] });
  trackReport(crossBase.status);
  if (crossBase.status && crossBase.status.state === 'done') {
    eq('base 目录下天津可对比', crossBase.status.result.provinceCount, 1);
  }

  // 清理本次测试新产生的文件。
  // 注意只删「跑测试之前不存在、跑完才出现」的那些：output/ 里平时就放着
  // 用户真实抓取的结果，无差别清空会把它们一起删掉。
  const newOutputFiles = ((await api('GET', '/api/output-files')).json || [])
    .map(f => f.name).filter(name => !before.has(name));

  let removed = 0;
  for (const f of newOutputFiles) {
    try { fs.unlinkSync(path.join(ROOT, 'output', f)); removed++; } catch (e) { /* 忽略 */ }
  }

  // 把被覆盖的同名文件恢复回跑测试前的内容
  let restored = 0;
  for (const [name, buf] of backups) {
    const p = path.join(ROOT, 'output', name);
    try {
      if (!buf.equals(fs.readFileSync(p))) { fs.writeFileSync(p, buf); restored++; }
    } catch (e) { /* 不存在或读不到则忽略 */ }
  }
  console.log(`  --   已清理本次测试新产生的 ${removed} 个文件（原有文件未动）`);
  if (restored) console.log(`  --   已恢复被本次抓取覆盖的 ${restored} 个原有文件`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  await bootServer();
  console.log(`服务器就绪: ${BASE}`);

  await testRoutes();
  await testPathTraversal();
  await testCompareAndCross();
  await testCancel();

  if (process.argv.includes('--net')) {
    await testLiveCrawl();
  } else {
    console.log('\n[5] 真实抓取 — 已跳过（加 --net 启用）');
  }

  // 清理测试期间生成的报告文件（报告落在 output/ 之外，需单独删）
  let cleaned = 0;
  for (const f of createdFiles) {
    try { fs.unlinkSync(f); cleaned++; } catch (e) { /* 已不存在则忽略 */ }
  }
  if (cleaned) console.log(`\n已清理 ${cleaned} 个测试生成的报告文件`);

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
