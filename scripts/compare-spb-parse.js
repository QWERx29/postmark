#!/usr/bin/env node
/**
 * SPB 页面解析对照 — JS 正则侧
 * =============================
 * 读取 scripts/compare-spb-parse.py 落盘的同一份 HTML，
 * 用 crawler-engine.js 的 parseSpbPage（纯正则、无 bs4）解析，
 * 与 Python BeautifulSoup 版逐行比对。
 *
 * 用法:
 *   node scripts/compare-spb-parse.js [python侧JSON]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'crawler-engine.js'));

function main() {
  const pyPath = path.join(ROOT, process.argv[2] || '_spb_py.json');
  if (!fs.existsSync(pyPath)) {
    console.error(`未找到 Python 基准: ${pyPath}`);
    console.error('请先运行: python scripts/compare-spb-parse.py _spb_py.json');
    process.exit(2);
  }
  const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));

  let pages = 0;
  let rowsTotal = 0;
  const diffs = [];
  const tempFiles = [];

  for (const key of Object.keys(py.pages).sort()) {
    const entry = py.pages[key];
    const htmlPath = path.join(ROOT, entry.html_file);
    if (!fs.existsSync(htmlPath)) {
      diffs.push(`${key}: 缺少 HTML 文件 ${entry.html_file}`);
      continue;
    }
    tempFiles.push(htmlPath);

    const html = fs.readFileSync(htmlPath, 'utf8');
    const jsRows = Engine.parseSpbPage(html, entry.url, { lines: [] });
    const pyRows = entry.rows;

    pages++;
    rowsTotal += jsRows.length;

    if (jsRows.length !== pyRows.length) {
      diffs.push(`${key}: 行数不同 py=${pyRows.length} js=${jsRows.length}`);
    }

    const n = Math.min(jsRows.length, pyRows.length);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 6; c++) {
        const a = pyRows[i][c];
        const b = jsRows[i][c];
        if (a !== b) {
          diffs.push(`${key} 第${i + 1}行 第${c + 1}列:\n      py: ${JSON.stringify(a)}\n      js: ${JSON.stringify(b)}`);
        }
      }
    }
    console.log(`  ${key}: py ${pyRows.length} 行 / js ${jsRows.length} 行`);
  }

  console.log('');
  console.log(`比对 ${pages} 个页面，共 ${rowsTotal} 行`);

  if (diffs.length === 0) {
    console.log('SPB 正则解析与 BeautifulSoup 版逐格一致。');
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } }
    try { fs.unlinkSync(pyPath); } catch (e) { /* 忽略 */ }
  } else {
    console.error(`发现 ${diffs.length} 处差异（保留 HTML 与 JSON 以便排查）:`);
    for (const d of diffs.slice(0, 30)) console.error('  - ' + d);
    process.exit(1);
  }
}

main();
