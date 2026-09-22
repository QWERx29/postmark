#!/usr/bin/env node
/**
 * 横向对比回归验证 — JS 引擎侧
 * ============================
 * 用 crawler-engine.js / crawler-match.js 跑遍 base/ 下所有省份的
 * (post{abbr}+base.csv, spb{abbr}+base.csv) 组合，导出与
 * scripts/regression-cross-match.py 完全同构的 JSON，然后逐字段比对。
 *
 * 用法:
 *   node scripts/regression-cross-match.js            # 导出 JS 侧并比对
 *   node scripts/regression-cross-match.js --dump     # 仅导出，不比对
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'crawler-engine.js'));

/** 与 Python 侧 dump_match 同构 */
function dumpMatch(result) {
  return {
    matched_exact: result.matchedExact.map(([p, s]) => [p.name, s.name]),
    matched_normalized: result.matchedNormalized.map(([p, s]) => [p.name, s.name]),
    matched_suspected: result.matchedSuspected.map(
      ([p, s, common, note]) => [p.name, s.name, common, note || '']
    ),
    matched_fuzzy: result.matchedFuzzy.map(
      ([p, s, r]) => [p.name, s.name, Math.round(r * 1e6) / 1e6]
    ),
    matched_cross_district: result.matchedCrossDistrict.map(
      ([p, s, method, note]) => [p.name, s.name, method, note || '']
    ),
    post_only: result.postOnly.map(p => p.name),
    spb_only: result.spbOnly.map(s => s.name),
  };
}

function buildReport(baseDir, enableFuzzy) {
  const report = { engine: 'js', fuzzy: !!enableFuzzy, provinces: {} };
  let checked = 0;

  for (const p of Engine.PROVINCES) {
    const postFile = path.join(baseDir, `post${p.abbr}+base.csv`);
    const spbFile = path.join(baseDir, `spb${p.abbr}+base.csv`);
    if (!fs.existsSync(postFile) || !fs.existsSync(spbFile)) continue;

    const postRecords = Engine.readPostCsv(postFile);
    const spbRecords = Engine.readSpbCsv(spbFile);

    const result = Engine.crossMatch(postRecords, spbRecords, { enableFuzzy: !!enableFuzzy });
    const d = dumpMatch(result);

    const counts = {};
    for (const k of Object.keys(d).sort()) counts[k] = d[k].length;

    report.provinces[p.abbr] = {
      province: p.name,
      post_count: postRecords.length,
      spb_count: spbRecords.length,
      result: d,
      counts,
    };
    checked++;
  }
  return { report, checked };
}

/** 逐省逐桶比对，返回差异描述数组（最多列出 limit 条） */
function diffReports(py, js, limit = 40) {
  const diffs = [];
  const push = (msg) => { if (diffs.length < limit) diffs.push(msg); };

  const pyAbbrs = Object.keys(py.provinces).sort();
  const jsAbbrs = Object.keys(js.provinces).sort();

  if (pyAbbrs.join(',') !== jsAbbrs.join(',')) {
    push(`省份集合不一致:\n  py: ${pyAbbrs.join(',')}\n  js: ${jsAbbrs.join(',')}`);
  }

  const BUCKETS = [
    'matched_exact', 'matched_normalized', 'matched_suspected',
    'matched_fuzzy', 'matched_cross_district', 'post_only', 'spb_only',
  ];

  for (const abbr of pyAbbrs) {
    const a = py.provinces[abbr];
    const b = js.provinces[abbr];
    if (!b) { push(`${abbr}: JS 侧缺失`); continue; }

    if (a.post_count !== b.post_count) {
      push(`${abbr}: POST 记录数不同 py=${a.post_count} js=${b.post_count}`);
    }
    if (a.spb_count !== b.spb_count) {
      push(`${abbr}: SPB 记录数不同 py=${a.spb_count} js=${b.spb_count}`);
    }

    for (const bucket of BUCKETS) {
      const la = a.result[bucket] || [];
      const lb = b.result[bucket] || [];
      if (la.length !== lb.length) {
        push(`${abbr}.${bucket}: 条数不同 py=${la.length} js=${lb.length}`);
      }
      const n = Math.min(la.length, lb.length);
      for (let i = 0; i < n; i++) {
        const sa = JSON.stringify(la[i]);
        const sb = JSON.stringify(lb[i]);
        if (sa !== sb) {
          push(`${abbr}.${bucket}[${i}]:\n      py: ${sa}\n      js: ${sb}`);
        }
      }
    }
  }
  return { diffs, truncated: diffs.length >= limit };
}

function main() {
  const baseDir = path.join(ROOT, 'base');
  const fuzzy = process.argv.includes('--fuzzy');
  const jsPath = path.join(ROOT, fuzzy ? '_regress_js_fuzzy.json' : '_regress_js.json');
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const pyPath = positional[0] ||
    path.join(ROOT, fuzzy ? '_regress_py_fuzzy.json' : '_regress_py.json');

  const built = buildReport(baseDir, fuzzy);
  const js = built.report;
  fs.writeFileSync(jsPath, JSON.stringify(js, null, 1), 'utf8');
  console.log(`JS 引擎结果已导出: ${path.relative(ROOT, jsPath)} ` +
              `(${built.checked} 个省份${fuzzy ? ', 含模糊匹配' : ''})`);

  if (process.argv.includes('--dump')) return;

  if (!fs.existsSync(pyPath)) {
    console.error(`\n未找到 Python 基准文件: ${pyPath}`);
    console.error('请先运行: python scripts/regression-cross-match.py');
    process.exit(2);
  }

  const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
  console.log(`Python 基准已读取: ${path.relative(ROOT, pyPath)} ` +
              `(${Object.keys(py.provinces).length} 个省份)`);
  console.log('');

  const { diffs, truncated } = diffReports(py, js);

  // 汇总各桶数量
  const totals = { py: {}, js: {} };
  for (const side of ['py', 'js']) {
    const src = side === 'py' ? py : js;
    for (const abbr of Object.keys(src.provinces)) {
      const counts = src.provinces[abbr].counts || {};
      for (const [k, v] of Object.entries(counts)) {
        totals[side][k] = (totals[side][k] || 0) + v;
      }
    }
  }
  const keys = Array.from(new Set([
    ...Object.keys(totals.py), ...Object.keys(totals.js),
  ])).sort();

  console.log('  桶                       Python      JS');
  console.log('  ' + '-'.repeat(44));
  for (const k of keys) {
    const a = totals.py[k] || 0;
    const b = totals.js[k] || 0;
    console.log(`  ${k.padEnd(22)} ${String(a).padStart(8)} ${String(b).padStart(7)}` +
                (a === b ? '' : '   <<< 不一致'));
  }
  console.log('');

  if (diffs.length === 0) {
    console.log('回归验证通过: JS 引擎与 Python 原版在全部省份上逐条一致。');
  } else {
    console.error(`发现 ${diffs.length}${truncated ? '+' : ''} 处差异:`);
    for (const d of diffs) console.error('  - ' + d);
    process.exit(1);
  }
}

main();
