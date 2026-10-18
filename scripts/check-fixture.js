#!/usr/bin/env node
/**
 * 开发期自检：把测试页面里的模板字符串（FIXTURE_BODY / FIXTURE_HTML）解出来
 * 做语法检查。
 *
 * 为什么需要它
 * ------------
 * 模板字符串里的语法错误在 Node 侧完全看不出来 —— 它只是一段文本。
 * 只有等浏览器真跑起来才炸，而且报错信息埋在 DOM dump 里极难定位。
 * 改完立刻查一下，比跑一遍浏览器测试快得多。
 *
 *   node scripts/check-fixture.js scripts/test-image-core.js FIXTURE_BODY
 *   node scripts/check-fixture.js scripts/test-image-e2e.js FIXTURE_HTML
 *
 * 检查方式：用 new Function() 让 V8 解析（只解析不执行），
 * 因此不需要起子进程、也不受管道限制。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'scripts/test-image-core.js';
const varName = process.argv[3] || 'FIXTURE_BODY';

const abs = path.resolve(file);
const src = fs.readFileSync(abs, 'utf8');
const marker = `const ${varName} = \``;
const start = src.indexOf(marker);
if (start < 0) {
  console.error(`找不到 ${varName}`);
  process.exit(1);
}
const bodyStart = start + marker.length;
const bodyEnd = src.indexOf('\n`;', bodyStart);
if (bodyEnd < 0) {
  console.error(`找不到 ${varName} 的结束反引号`);
  process.exit(1);
}

// 模板字符串转义还原：\\x → x（\n 例外）
const raw = src.slice(bodyStart, bodyEnd);
const body = raw.replace(/\\(.)/g, (all, ch) => (ch === 'n' ? '\n' : ch));

/**
 * 拼出浏览器实际收到的页面。
 *
 * 只检查模板字符串是不够的：html 是 HEAD + 内联脚本 + BODY 拼起来的，
 * 真正的语法错误往往出在「拼完之后」，而浏览器只会把错误留在 console 里，
 * 命令行完全看不到（这个坑踩过一次：模板里重复声明 const，页面直接空白）。
 */
function assemblePage() {
  // 内联 js/*.js（与 test-image-core.js 的 inlineScripts() 同规则）
  const mHead = /const FIXTURE_HEAD = `([\s\S]*?)`;/.exec(src);
  const head = mHead ? mHead[1].replace(/\\(.)/g, (a, c) => (c === 'n' ? '\n' : c)) : '';
  const mFiles = /const files = \[([^\]]*)\];/.exec(src);
  let inlined = '';
  if (mFiles) {
    const names = [...mFiles[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    inlined = names.map((rel) => {
      const p = path.join(path.dirname(abs), '..', rel);
      return `<script>\n${fs.readFileSync(p, 'utf8')}\n</script>`;
    }).join('\n');
  }
  return head + inlined + body;
}

/** 检查一段 JS 能否解析（不执行） */
function parseJs(code, label) {
  // vm.Script 与浏览器一样按「脚本」解析：重复 const 声明、顶层 await
  // 这类错误（new Function 因为多包了一层函数作用域反而看不见）都能抓住。
  const vm = require('vm');
  try {
    new vm.Script(code, { filename: label });
    return null;
  } catch (e) {
    const line = e.lineNumber || (e.stack && /:(\d+)\n/.exec(e.stack) && /:(\d+)\n/.exec(e.stack)[1]);
    return `${label}: ${line ? `第 ${line} 行 ` : ''}${e.message}`;
  }
}

let failures = 0;
let checked = 0;

// 始终检查一次「拼装后」的完整页面 —— 这才是浏览器真正解析的东西
const page = assemblePage();
const pageBlocks = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
console.log(`${file}: 拼装后的页面含 ${pageBlocks.length} 个内联脚本块`);
pageBlocks.forEach((m, i) => {
  checked++;
  const err = parseJs(m[1], `页面脚本块 #${i + 1}`);
  if (err) { failures++; console.error(`  [FAIL] ${err}`); }
});

// 只检查指定的模板变量（不重复报拼装结果）
if (varName !== 'FIXTURE_HTML' && !/<script/.test(body)) {
  checked++;
  const err = parseJs(body, varName);
  if (err) { failures++; console.error(`  [FAIL] ${err}`); }
}

if (failures === 0) {
  console.log(`${file}: ${checked} 个脚本块全部通过语法检查`);
} else {
  console.error(`${file}: ${failures} 处语法错误`);
  process.exitCode = 1;
}
