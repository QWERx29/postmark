'use strict';
/**
 * 智能判别对比 —— 真实数据规模下的一致性回归（JS 侧）
 * ==================================================
 * 读 regression-intelligent-realdiff.py 产出的 _realdiff.json，
 * 对同一对扰动后的真实 CSV 跑 crawler-intelligent.js，逐条/逐行比对。
 *
 * 用法:
 *   python scripts/regression-intelligent-realdiff.py
 *   node scripts/regression-intelligent-realdiff.js
 */
const fs = require('fs');
const path = require('path');
const Engine = require('../crawler-engine.js');
const Intelligent = require('../crawler-intelligent.js');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '_realdiff.json'), 'utf8'));

/** 区块标题里的区县列表在 Python 侧是 set 迭代序（逐进程随机），两侧都排序后再比 */
function norm(line) {
  const m = /^(--- 连续变化区块 #\d+ \(行[\d-]+, )(.*)(\) ---)$/.exec(line);
  return m ? m[1] + m[2].split(', ').filter(Boolean).sort().join(', ') + m[3] : line;
}

let ok = 0, bad = 0;
function check(label, cond, detail) {
  if (cond) { ok++; console.log(`  OK   ${label}`); }
  else { bad++; console.log(`  FAIL ${label}\n       ${detail}`); }
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `第 ${i + 1} 行\n         实际: ${JSON.stringify(a[i])}\n         期望: ${JSON.stringify(b[i])}`;
  }
  return `行数 ${a.length} vs ${b.length}`;
}

for (const c of base) {
  console.log(`\n[${c.prefix}] ${c.newCount} / ${c.oldCount} 条`);
  const read = c.sourceType === 'spb' ? Engine.readSpbCsv : Engine.readPostCsv;
  const r1 = read(c.file1);
  const r2 = read(c.file2);
  check('CSV 解析条数一致', r1.length === c.newCount && r2.length === c.oldCount,
    `${r1.length}/${r2.length} vs ${c.newCount}/${c.oldCount}`);

  // 关掉明细裁剪，才能和 Python 的全量结果逐条比
  const res = Intelligent.intelligentCompare(r1, r2, c.sourceType, c.label,
    { cap: Number.MAX_SAFE_INTEGER });

  check('summary 一致', JSON.stringify(res.summary.new) === String(c.summary.new) &&
    res.summary.new === c.summary.new && res.summary.removed === c.summary.removed &&
    res.summary.blocks === c.summary.blocks &&
    res.summary.comprehensive === c.summary.comprehensive,
    JSON.stringify(res.summary) + ' vs ' + JSON.stringify(c.summary));

  const gotLevels = res.changes.map(x => `${x.idx1}:${x.idx2}:${x.matchLevel}`).sort();
  check(`匹配方式逐条一致（${gotLevels.length} 条）`,
    JSON.stringify(gotLevels) === JSON.stringify(c.matchedLevels), firstDiff(gotLevels, c.matchedLevels));

  const gotCats = res.changes.map(x => `${x.idx1}:${x.categories.join(',')}`).sort();
  check(`变化类别逐条一致（${gotCats.length} 条）`,
    JSON.stringify(gotCats) === JSON.stringify(c.categories), firstDiff(gotCats, c.categories));

  const gotU1 = res.unmatched1.map(([, r]) => r.name);
  check(`新增名单一致（${gotU1.length} 条）`,
    JSON.stringify(gotU1) === JSON.stringify(c.unmatched1), firstDiff(gotU1, c.unmatched1));
  const gotU2 = res.unmatched2.map(([, r]) => r.name);
  check(`撤下名单一致（${gotU2.length} 条）`,
    JSON.stringify(gotU2) === JSON.stringify(c.unmatched2), firstDiff(gotU2, c.unmatched2));

  check(`区块数一致（${res.blocks.length}）`, res.blocks.length === c.nBlocks,
    `${res.blocks.length} vs ${c.nBlocks}`);
  const gotJ = res.blocks.map(b => b.judgment).sort();
  check('区块判断逐条一致', JSON.stringify(gotJ) === JSON.stringify(c.blockJudgments),
    firstDiff(gotJ, c.blockJudgments));

  const gotLines = res.lines.filter(l => !l.startsWith('生成时间:')).map(norm);
  const wantLines = c.lines.map(norm);
  check(`报告全文逐行一致（${gotLines.length} 行）`,
    JSON.stringify(gotLines) === JSON.stringify(wantLines), firstDiff(gotLines, wantLines));
}

console.log(`\n通过 ${ok} 项，失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
