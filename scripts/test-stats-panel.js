#!/usr/bin/env node
/**
 * 首页统计面板验证（纯 Node，不需要浏览器）
 * ==========================================
 * 覆盖 TODO 里的两条要求：
 *   1. 省份排名表「总计」不再用 PROVINCE_DATA 里手写的估算值，而是跟随参考库
 *      （base/post*.csv，即中国邮政官网抓取结果）中该省的 POST 条数动态更新；
 *   2. 右下角「数据更新」显示参考库最后一次刷新的日期（poref_meta.lastImportTime），
 *      不再是页面里写死的字符串。
 *
 * 验证内容：
 *   - 没有参考库时排名总计退回内置估算值；
 *   - 有参考库时用官网 POST 条数覆盖，SPB 条数不参与；
 *   - 只有 SPB / 没有官网数据的省份仍退回估算值；
 *   - 全国总数与完成率也按同一套总数重算；
 *   - 「数据更新」按 lastImportTime 渲染，参考库为空时显示「—」。
 *
 * 用法: node scripts/test-stats-panel.js
 * 退出码: 0 全部通过 / 1 有失败
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['js/data.js', 'js/stats.js'];

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

/** 极简 DOM：统计面板只用到 getElementById 与 textContent / innerHTML / title */
function makeDocument() {
  const nodes = new Map();
  function node() {
    return {
      textContent: '',
      innerHTML: '',
      title: '',
      removeAttribute(name) { if (name === 'title') this.title = ''; },
    };
  }
  return {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    _node: (id) => nodes.get(id),
  };
}

/** 加载 data.js + stats.js；RecordStore / PODatabase 由用例按需注入 */
function makeContext() {
  const ctx = { console, document: makeDocument() };
  vm.createContext(ctx);
  for (const f of SCRIPTS) {
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, f), 'utf8'),
      ctx, { filename: f });
  }
  return ctx;
}

const rankingOf = (ctx) =>
  vm.runInContext('JSON.parse(JSON.stringify(PostmarkData.getRanking()))', ctx);

// ============================================================
// 1. 没有参考库：排名总计退回 PROVINCE_DATA 的估算值
// ============================================================
console.log('\n场景 1  没有参考库（全新安装 / 参考库为空）');
{
  const ctx = makeContext();
  const ranking = rankingOf(ctx);
  const bj = ranking.find((r) => r.name === '北京市');
  check('北京市总计 = 内置估算 724', bj.total === 724, String(bj.total));

  const sum = vm.runInContext('PostmarkData.getNationSummary().total', ctx);
  const staticSum = vm.runInContext('PROVINCE_DATA.reduce((s, p) => s + p.total, 0)', ctx);
  check('全国总数 = 各省估算值之和', sum === staticSum, `${sum} vs ${staticSum}`);
}

// ============================================================
// 2. 有参考库：用官网 POST 条数覆盖
// ============================================================
console.log('\n场景 2  参考库有官网数据（POST 条数覆盖估算值）');
{
  const ctx = makeContext();
  ctx.PODatabase = {
    getStats: () => ({
      provinces: [
        { name: '北京市', postCount: 725, spbCount: 900 },   // SPB 更多，不应参与
        { name: '河北省', postCount: 2471, spbCount: 0 },
        { name: '上海市', postCount: 0, spbCount: 12 },      // 只有 SPB → 退回估算
      ],
    }),
  };
  const ranking = rankingOf(ctx);
  const byName = Object.fromEntries(ranking.map((r) => [r.name, r]));

  check('北京市总计取官网 725（而非估算 724）', byName['北京市'].total === 725,
    String(byName['北京市'].total));
  check('河北省总计取官网 2471（而非估算 2475）', byName['河北省'].total === 2471,
    String(byName['河北省'].total));
  check('SPB 条数不参与总计', byName['北京市'].total !== 900);
  check('只有 SPB 的省份退回估算 537', byName['上海市'].total === 537,
    String(byName['上海市'].total));
  check('没有官网数据的省份仍用估算（四川省 6141）', byName['四川省'].total === 6141);

  const sum = vm.runInContext('PostmarkData.getNationSummary().total', ctx);
  const expected = vm.runInContext('PROVINCE_DATA.reduce((s, p) => s + p.total, 0)', ctx)
    - 724 + 725 - 2475 + 2471;
  check('全国总数按官网条数重算', sum === expected, `${sum} vs ${expected}`);
}

// ============================================================
// 3. 完成率也走同一套总数
// ============================================================
console.log('\n场景 3  完成率使用动态总数');
{
  const ctx = makeContext();
  ctx.PODatabase = {
    getStats: () => ({ provinces: [{ name: '北京市', postCount: 100 }] }),
  };
  ctx.RecordStore = {
    count: () => 1,
    getAll: () => [],
    getProvinceStats: () => ({ 北京市: { collected: 25 } }),
  };
  const rates = vm.runInContext(
    'JSON.parse(JSON.stringify(PostmarkData.getProvinceRates()))', ctx);
  const bj = rates.find((r) => r.name === '北京市');
  check('北京市完成率 = 25/100 = 25%', bj.rate === 25, String(bj.rate));
}

// ============================================================
// 4. 右下角「数据更新」= 参考库刷新日期
// ============================================================
console.log('\n场景 4  右下角「数据更新」跟随参考库');
{
  const pad = (n) => String(n).padStart(2, '0');
  const iso = '2026-10-09T12:00:00Z';
  const d = new Date(iso);
  const expected = `数据更新: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const ctx = makeContext();
  ctx.PODatabase = { getStats: () => ({ lastImportTime: iso, provinces: [] }) };
  ctx.RecordStore = { getAll: () => [], count: () => 0, getProvinceStats: () => ({}) };
  vm.runInContext('StatsView.update("nation", null)', ctx);

  const el = ctx.document._node('update-time');
  check('按 lastImportTime 渲染日期', el.textContent === expected,
    `${el.textContent} vs ${expected}`);
  check('悬停提示说明这是参考库刷新时间',
    String(el.title).startsWith('参考库刷新时间：'), el.title);

  // 参考库为空：显示占位符，不残留上一次的日期
  const ctx2 = makeContext();
  ctx2.PODatabase = { getStats: () => ({ lastImportTime: null, provinces: [] }) };
  ctx2.RecordStore = { getAll: () => [], count: () => 0, getProvinceStats: () => ({}) };
  vm.runInContext('StatsView.update("nation", null)', ctx2);
  const el2 = ctx2.document._node('update-time');
  check('参考库为空时显示「—」', el2.textContent === '数据更新: —', el2.textContent);
  check('参考库为空时不带悬停提示', !el2.title, el2.title);
}

// ============================================================
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
