#!/usr/bin/env node
/**
 * 对比逻辑：base_old 中已有的「撤销」记录不计入新增网点
 * =====================================================
 * 需求：output 里带「撤销」字样、且已在历史库 base_old 中的记录，
 * 说明它早已归档、不会进当前库，不应在智能判别里反复算成「新增网点」。
 *
 * 覆盖：
 *   - hasRevokedMark / archivedLookupKey / makeArchivedRevokedFilter 的判定
 *   - intelligentCompare 的 ignoreNew：summary.new、报告文本、明细列表
 *   - startCompare 集成：output 的撤销记录在 base_old 里时不计新增
 *     （本环境 txt_compare.exe 可能 spawn EPERM，不影响智能判别部分）
 *
 * 用法:
 *   node scripts/test-compare-base-old.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'crawler-engine.js'));
const Intelligent = require(path.join(ROOT, 'crawler-intelligent.js'));

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`);
  }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function post(district, name, postcode) {
  return {
    province: '天津市', city: '天津市', district,
    name, postcode, address: '天津市' + district,
  };
}

/** base_old 里的一条归档（结构与 readBaseOld 的返回一致） */
function archived(district, name, reason) {
  return {
    source: 'post', province: '天津市', city: '天津市', district, name,
    postcode: '', address: '', services: '', detail_link: '',
    reason: reason || '撤销', archivedAt: '2026-10-01 00:00:00',
  };
}

/** 从报告里取某个 section 的数据行（跳过标题 + 表头两行） */
function sectionRows(lines, title) {
  const i = lines.findIndex(l => l.startsWith(`--- ${title} (`));
  if (i < 0) return [];
  const rows = [];
  for (let j = i + 3; j < lines.length; j++) {
    if (lines[j].startsWith('--- ') || lines[j] === '') break;
    rows.push(lines[j]);
  }
  return rows;
}

// ============================================================
// [1] 判定工具
// ============================================================
function testHelpers() {
  console.log('\n[1] 撤销判定与 base_old 查表键');

  check('带（撤销）→ 命中', Engine.hasRevokedMark(post('和平区', '乙邮政所（撤销）', '1')));
  check('带「已撤销」字样 → 命中', Engine.hasRevokedMark(post('和平区', '乙邮政所已撤销', '1')));
  check('普通名称 → 不命中', !Engine.hasRevokedMark(post('和平区', '乙邮政所', '1')));
  check('名称缺失 → 不命中', !Engine.hasRevokedMark({}));

  // 归档里存的是带括注的名称，output 可能是去掉括注的同一名称（或反过来）
  eq('查表键忽略撤销括注',
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所（撤销）', '1')),
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所', '1')));
  eq('查表键兼容「（已撤销）」写法',
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所（已撤销）', '1')),
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所', '1')));
  check('查表键区分区县',
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所', '1')) !==
    Engine.archivedLookupKey('post', post('南开区', '乙邮政所', '1')));
  check('查表键区分来源',
    Engine.archivedLookupKey('post', post('和平区', '乙邮政所', '1')) !==
    Engine.archivedLookupKey('spb', post('和平区', '乙邮政所', '1')));

  const archive = [
    archived('和平区', '乙邮政所（撤销）', '撤销'),
    archived('和平区', '丙邮政所', '疑似撤下'),      // 归档时是不带状态的普通名称
  ];
  const filter = Engine.makeArchivedRevokedFilter('post', archive);

  check('撤销 + 归档同名 → 不算新增',
    filter(post('和平区', '乙邮政所（撤销）', '1')));
  check('「（已撤销）」变体也与归档同名记录匹配',
    filter(post('和平区', '乙邮政所（已撤销）', '9')));
  check('撤销 + 归档去状态同名 → 不算新增',
    filter(post('和平区', '丙邮政所（撤销）', '2')));
  check('撤销但不在归档 → 仍算新增',
    !filter(post('和平区', '丁邮政所（撤销）', '3')));
  check('普通名称即使与归档同名也不受影响',
    !filter(post('和平区', '丙邮政所', '4')));
  check('区县不同不匹配',
    !filter(post('南开区', '乙邮政所（撤销）', '5')));
  check('来源不同不匹配',
    !Engine.makeArchivedRevokedFilter('spb', archive)(post('和平区', '乙邮政所（撤销）', '6')));
  check('空归档恒为 false',
    !Engine.makeArchivedRevokedFilter('post', [])(post('和平区', '乙邮政所（撤销）', '7')));
  check('归档为 null 时不抛异常',
    !Engine.makeArchivedRevokedFilter('post', null)(post('和平区', '乙邮政所（撤销）', '8')));
}

// ============================================================
// [2] intelligentCompare 的 ignoreNew
// ============================================================
function testIntelligentCompare() {
  console.log('\n[2] 智能判别：ignoreNew 排除已归档撤销记录');

  const oldR = [post('和平区', '甲邮政所', '100000')];
  const newR = [
    post('和平区', '甲邮政所', '100000'),             // 一致
    post('和平区', '乙邮政所（撤销）', '100001'),      // 已归档撤销 → 忽略
    post('和平区', '丙邮政所（撤销）', '100002'),      // 未归档撤销 → 仍算新增
    post('和平区', '丁邮政所', '100003'),              // 普通新增
  ];
  // 模拟引擎的过滤器：只把「乙」当作已在 base_old 中
  const ignoreNew = (r) => /撤销/.test(r.name) && r.name.indexOf('乙') >= 0;

  const res = Intelligent.intelligentCompare(
    newR, oldR, 'post', 'posttj-20261019.csv', { ignoreNew }
  );

  eq('新增计数排除已归档撤销', res.summary.new, 2);
  eq('ignoredNew 计数', res.ignoredNew, 1);
  eq('summary 不含额外字段（与 Python 基准同构）', 'ignoredNew' in res.summary, false);
  eq('新版数据总数不变', res.newCount, 4);
  eq('旧版数据总数不变', res.oldCount, 1);
  eq('被忽略的记录不在 unmatched1 里',
    res.unmatched1.some(([, r]) => r.name.indexOf('乙') >= 0), false);
  check('未归档的撤销仍算新增',
    res.unmatched1.some(([, r]) => r.name.indexOf('丙') >= 0),
    JSON.stringify(res.unmatched1.map(([, r]) => r.name)));

  check('报告含「已归档撤销」汇总行',
    res.lines.some(l => l.includes('已归档撤销') && l.includes('不计入新增网点') && l.includes('1')),
    res.lines.filter(l => l.includes('撤销')).join(' | '));

  const rows = sectionRows(res.lines, '疑似新增网点');
  check('疑似新增明细不含已归档撤销',
    !rows.some(l => l.includes('乙邮政所')), JSON.stringify(rows));
  check('疑似新增明细仍含未归档撤销',
    rows.some(l => l.includes('丙邮政所')), JSON.stringify(rows));

  // 全部差异都被忽略：报告不能再说「完全一致」，要说明排除了多少条
  const only = Intelligent.intelligentCompare(
    [post('和平区', '乙邮政所（撤销）', '100001')], [],
    'post', 'posttj-20261019.csv', { ignoreNew: () => true }
  );
  eq('全部忽略 → 新增 0', only.summary.new, 0);
  eq('全部忽略 → ignoredNew 1', only.ignoredNew, 1);
  check('全部忽略时说明排除了已归档撤销',
    only.lines.some(l => l.includes('除 1 条已归档的撤销记录外')),
    JSON.stringify(only.lines));
  check('全部忽略时不再声称完全一致',
    !only.lines.some(l => l.includes('两份数据完全一致')),
    JSON.stringify(only.lines));

  // 未传 ignoreNew 时行为不变
  const plain = Intelligent.intelligentCompare([], [], 'post', 'x.csv');
  eq('未传 ignoreNew 时 ignoredNew = 0', plain.ignoredNew, 0);
  eq('未传 ignoreNew 时新增照旧',
    Intelligent.intelligentCompare([post('和平区', '戊邮政所', '1')], [], 'post', 'x.csv').summary.new, 1);
}

// ============================================================
// [3] startCompare 集成
// ============================================================
async function testStartCompare(tmpDir) {
  console.log('\n[3] 对比作业集成：base_old 中的撤销记录不计新增');

  const outDir = path.join(tmpDir, 'out');
  const baseDir = path.join(tmpDir, 'base');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  const header = Engine.csvLine(Engine.POST_FIELDS);
  const row = (district, name, postcode) =>
    Engine.csvLine(['天津市', '天津市', district, name, postcode, '天津市' + district]);
  const writeCsv = (file, rows) =>
    fs.writeFileSync(file, iconv.encode([header, ...rows].join('\r\n') + '\r\n', 'gbk'));

  // base：只有甲；output：甲 + 已归档撤销的乙 + 未归档撤销的丙 + 普通新增的丁
  writeCsv(path.join(baseDir, 'posttj+base.csv'), [
    row('和平区', '甲邮政所', '100000'),
  ]);
  writeCsv(path.join(outDir, 'posttj-20261019.csv'), [
    row('和平区', '甲邮政所', '100000'),
    row('和平区', '乙邮政所（撤销）', '100001'),
    row('和平区', '丙邮政所（撤销）', '100002'),
    row('和平区', '丁邮政所', '100003'),
  ]);
  // 历史库：乙早已归档（名称带撤销括注）
  const oldPath = path.join(baseDir, Engine.BASE_OLD_FILE);
  Engine.writeBaseOld(oldPath, [archived('和平区', '乙邮政所（撤销）', '撤销')]);

  Engine.configure({
    outputDir: outDir,
    baseDir: baseDir,
    compareExeCandidates: [path.join(ROOT, 'txt_compare.exe')],
  });

  if (!Engine.resolveCompareExe()) {
    check('定位到 txt_compare.exe', false, '未找到');
    return;
  }

  const job = Engine.startCompare();
  await job.done;
  eq('对比作业状态', job.state, 'done');

  const intel = (job.result.intelligent || []).find((p) => p.prefix === 'posttj');
  check('产出 posttj 的智能判别', !!intel);
  if (!intel) return;

  eq('新增网点只算未归档的丙与丁', intel.summary.new, 2);
  eq('已归档撤销单独计数', intel.ignoredNew, 1);
  eq('新版数据总数仍是 4', intel.newCount, 4);
  check('unmatched1 不含已归档撤销',
    !(intel.unmatched1 || []).some(([, r]) => r.name.indexOf('乙') >= 0),
    JSON.stringify((intel.unmatched1 || []).map(([, r]) => r.name)));

  check('智能判别报告含已归档撤销汇总行',
    /已归档撤销/.test(job.result.intelligentReportText || '') &&
    /不计入新增网点/.test(job.result.intelligentReportText || ''),
    (job.result.intelligentReportText || '').slice(0, 400));
  check('日志说明忽略了多少条',
    job.lines.some(l => l.includes('智能分析: posttj') && l.includes('已归档撤销 1 条不计新增')),
    job.lines.filter(l => l.includes('智能分析')).join(' | '));

  // 对比阶段不应改动 base 与 base_old
  eq('base_old 未被对比作业改写', Engine.readBaseOld(oldPath).length, 1);
  eq('base 未被对比作业改写',
    Engine.readPostCsv(path.join(baseDir, 'posttj+base.csv')).length, 1);
}

// ============================================================
// main
// ============================================================
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-base-old-'));
  console.log(`临时目录: ${tmpDir}`);

  testHelpers();
  testIntelligentCompare();
  await testStartCompare(tmpDir);

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed === 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  } else {
    console.log(`（保留临时目录以便排查: ${tmpDir}）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[测试异常]', e);
  process.exit(1);
});
