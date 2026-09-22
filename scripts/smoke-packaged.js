#!/usr/bin/env node
/**
 * 打包产物冒烟测试
 * =================
 * 针对已构建的便携版 exe，直接驱动其内置 HTTP 服务，验证打包后：
 *   1. 服务能起来、省份表完整；
 *   2. iconv-lite 已随包发布 —— 抓取的 CSV 能按 GBK 写出并被读回；
 *   3. txt_compare.exe 已 asarUnpack —— 对比作业能真正 spawn 起它；
 *   4. 产出目录落在 exe 同级的 output/（便携版 PORTABLE_EXECUTABLE_DIR）。
 *
 * 前置: npm run build，并让 exe 处于运行状态。
 * 用法: node scripts/smoke-packaged.js [exeDir]
 */

'use strict';

const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

const ROOT = path.join(__dirname, '..');
// 便携版会把 exe 所在目录通过 PORTABLE_EXECUTABLE_DIR 传给应用，
// 产出也就落在那里 —— 默认取 release/。
const EXE_DIR = path.resolve(process.argv[2] || path.join(ROOT, 'release'));
const BASE = 'http://127.0.0.1:19876';

let passed = 0;
let failed = 0;
const createdFiles = [];

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
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}

/** 轮流询直到作业结束 */
async function runToEnd(body, timeoutMs = 240000) {
  const start = await api('POST', '/api/crawl/start', body);
  if (start.status !== 200) return { startStatus: start.status, error: start.json };

  let cursor = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/crawl/status?job=${start.json.jobId}&cursor=${cursor}`);
    const s = await r.json();
    cursor = s.cursor;
    if (s.state !== 'running') return { startStatus: 200, status: s };
    await new Promise((r2) => setTimeout(r2, 500));
  }
  return { startStatus: 200, timeout: true };
}

function track(status) {
  if (status && status.result && status.result.reportPath) {
    createdFiles.push(status.result.reportPath);
  }
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/base-files`);
      if (res.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  check('exe 目录存在', fs.existsSync(EXE_DIR), EXE_DIR);

  console.log(`\n等待打包版服务就绪 (${BASE}) ...`);
  if (!(await waitForServer())) {
    console.log('  FAIL 服务未在 60s 内就绪 —— 请先手动启动 exe');
    process.exit(1);
  }
  console.log('  服务已就绪\n');

  // ---- [1] 基础接口 ----
  console.log('[1] 打包版基础接口');
  const provinces = await api('GET', '/api/crawl/provinces');
  eq('GET /api/crawl/provinces', provinces.status, 200);
  eq('省份数', Array.isArray(provinces.json) && provinces.json.length, 31);

  const baseFiles = await api('GET', '/api/base-files');
  eq('GET /api/base-files', baseFiles.status, 200);
  check('base 数据已打包（62 个 CSV）',
    Array.isArray(baseFiles.json) && baseFiles.json.length === 62,
    String(baseFiles.json && baseFiles.json.length));

  // ---- [2] 抓取 → 验证 GBK 落盘 ----
  console.log('\n[2] 抓取并验证 GBK 写入（iconv-lite）');
  const crawl = await runToEnd({
    kind: 'crawl', provinces: ['天津'], doPost: false, doSpb: true, delay: 0,
  });
  eq('抓取作业状态', crawl.status && crawl.status.state, 'done');
  if (!crawl.status || crawl.status.state !== 'done') {
    console.log('\n抓取未成功，后续用例无法进行');
    process.exit(1);
  }

  const res = crawl.status.result;
  check('SPB 抓到数据', res.totalSpb > 0, `${res.totalSpb} 条`);
  eq('产出目录为 exe 同级 output/',
    path.resolve(res.outputDir), path.resolve(EXE_DIR, 'output'));

  const files = await api('GET', '/api/output-files');
  const csv = files.json.find((f) => f.name.startsWith('spbtj'));
  check('产出文件已列出', !!csv, JSON.stringify(files.json.map((f) => f.name)));

  if (csv) {
    const resp = await fetch(`${BASE}/output/${encodeURIComponent(csv.name)}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    // 用 GBK 解码：能解出中文即证明是 iconv-lite 的 GBK 编码（UTF-8 会解成乱码）
    const text = iconv.decode(buf, 'gbk');
    const firstLine = text.split(/\r?\n/)[0];
    const firstRow = text.split(/\r?\n/)[1] || '';
    eq('CSV 表头与 Python 版一致', firstLine, '所属省,所属市,所属县,场所名称,开办业务,详情链接');
    check('CSV 首行为真实中文（GBK 编码正确）', /天津市/.test(firstRow), firstRow.slice(0, 40));
  }

  // ---- [3] 对比作业 → 验证 txt_compare.exe 可执行 ----
  console.log('\n[3] 对比作业（验证 asarUnpack 后的 txt_compare.exe）');
  const cmp = await runToEnd({ kind: 'compare' });
  track(cmp.status);
  eq('对比作业状态', cmp.status && cmp.status.state, 'done');
  if (cmp.status && cmp.status.state === 'done') {
    const r = cmp.status.result;
    check('txt_compare.exe 成功执行（对比了 1 对）', r.compared >= 1,
      `compared=${r.compared}，可能未找到可执行文件`);
    check('未因缺少 Python 而失败', !cmp.status.error, String(cmp.status.error));
    // 有配对时报告里应含对比器输出；无配对则退化为新增/缺失清单
    check('报告文本非空', typeof r.reportText === 'string' && r.reportText.length > 0);
  }

  // ---- 清理本机产生的产出 ----
  const outDir = path.join(EXE_DIR, 'output');
  let removed = 0;
  try {
    for (const f of fs.readdirSync(outDir)) {
      try { fs.unlinkSync(path.join(outDir, f)); removed++; } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 目录不存在 */ }
  for (const f of createdFiles) {
    try { fs.unlinkSync(f); removed++; } catch (e) { /* 忽略 */ }
  }
  console.log(`\n已清理 ${removed} 个测试产出文件`);

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
