#!/usr/bin/env node
/**
 * 智能判别对比 —— 与真实 crawler.py 的一致性回归
 * =============================================
 * 读 scripts/_regress_intelligent.json（由 regression-intelligent-compare.py
 * 用真实生产脚本 crawler.py 生成），把同一批 fixture 灌进 crawler-intelligent.js，
 * 逐字段比对：changes / unmatched1 / unmatched2 / blocks / summary / 报告全文。
 *
 * 用法:
 *   python scripts/regression-intelligent-compare.py      # 先重生成基准
 *   node scripts/regression-intelligent-compare.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const Intelligent = require('../crawler-intelligent.js');

const JSON_PATH = path.join(__dirname, '_regress_intelligent.json');

if (!fs.existsSync(JSON_PATH)) {
  console.error(`找不到基准文件: ${JSON_PATH}`);
  console.error('请先运行: python scripts/regression-intelligent-compare.py');
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '\n         → ' + detail : ''}`); }
}

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(label, g === w, `实际 ${g}\n           期望 ${w}`);
}

/** 只保留第一个差异位置附近的文本，便于看清报告文本的行级差异 */
function firstDiffLine(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `第 ${i + 1} 行\n           实际: ${JSON.stringify(a[i])}\n           期望: ${JSON.stringify(b[i])}`;
    }
  }
  return `行数不同: 实际 ${a.length}，期望 ${b.length}`;
}

/**
 * 报告文本的行归一化，只为抹掉两处**参考侧本身就不稳定/不可比**的内容：
 *
 *  1. `生成时间:` —— 两侧取自各自的 clock，换成占位符，但格式仍逐字比对。
 *  2. `--- 连续变化区块 #N (行a-b, 区县列表) ---` 里的区县列表 —— 真实 crawler.py 用
 *     `", ".join(d for d in districts if d)` 遍历一个 `set`，而 str 的哈希按
 *     PYTHONHASHSEED 逐进程随机，同一份数据每次跑出来的顺序都不一样（已用
 *     PYTHONHASHSEED=1/2/3 实测确认）。所以这里把两侧都排序后再比 —— 集合内容
 *     仍是逐条严格比对的，只有排列顺序被抹平。
 */
function normalizeLines(lines) {
  return lines.map(l => {
    if (/^生成时间: /.test(l)) return '生成时间: <T>';
    const m = /^(--- 连续变化区块 #\d+ \(行[\d-]+, )(.*)(\) ---)$/.exec(l);
    if (m) return m[1] + m[2].split(', ').filter(Boolean).sort().join(', ') + m[3];
    return l;
  });
}

/** JS 侧构造与 Python 同样的 now 字符串，用于喂给 intelligentCompare */
function nowFromString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`基准里的 nowStr 格式不对: ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                  Number(m[4]), Number(m[5]), Number(m[6]));
}

/** 与 Python 侧 norm_blocks 同样的规范化 */
function normBlocks(blocks) {
  return blocks.map(b => ({
    startLine: b.startLine,
    endLine: b.endLine,
    district: b.district.split(', ').filter(Boolean).sort().join(', '),
    judgment: b.judgment,
    onlyIn1: b.onlyIn1.map(([, r]) => r.name),
    onlyIn2: b.onlyIn2.map(([, r]) => r.name),
    fuzzy: b.fuzzyMatchesInBlock.map(([r1, r2, c]) => [r1.name, r2.name, c]),
    changesInBlock: b.changesInBlock.map(c => ({
      rec2: c.rec2.name, rec1: c.rec1.name, categories: c.categories,
    })),
  }));
}

function normChanges(changes) {
  return changes.map(c => ({
    idx1: c.idx1, idx2: c.idx2,
    matchLevel: c.matchLevel,
    rec1: c.rec1, rec2: c.rec2,
    categories: c.categories,
    details: c.details,
  }));
}

console.log(`基准来源: ${baseline.source}  (生成于 ${baseline.generatedAt})`);

for (const fx of baseline.fixtures) {
  console.log(`\n[${fx.name}] ${fx.label} (${fx.sourceType})`);
  const exp = fx.expected;

  const got = Intelligent.intelligentCompare(
    fx.records1, fx.records2, fx.sourceType, fx.label,
    exp.empty ? {} : { now: nowFromString(exp.nowStr) }
  );

  eq('changes', normChanges(got.changes), exp.changes);
  eq('unmatched1', got.unmatched1.map(([, r]) => r.name), exp.unmatched1);
  eq('unmatched2', got.unmatched2.map(([, r]) => r.name), exp.unmatched2);
  eq('blocks', normBlocks(got.blocks), exp.blocks);
  eq('summary', got.summary, exp.summary);

  const gotLines = normalizeLines(got.lines);
  const wantLines = normalizeLines(exp.lines);
  check('报告全文逐行一致', JSON.stringify(gotLines) === JSON.stringify(wantLines),
    firstDiffLine(gotLines, wantLines));
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
