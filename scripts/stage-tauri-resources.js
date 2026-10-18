#!/usr/bin/env node
/**
 * Tauri 资源暂存 — 把外壳运行所需的一切拷进 src-tauri/resources/
 * ==============================================================
 * Tauri 的 resource_dir() 会把构建产物的 resources 目录原样带进安装包
 * （Windows 上落在 <exe目录>/resources/），Rust 外壳按固定布局去取：
 *
 *   resources/node/node.exe      随包分发的 Node 运行时（用户无需自己装 Node）
 *   resources/app/server.js      本地 HTTP 服务器入口
 *   resources/app/crawler-*.js   爬虫引擎与匹配逻辑
 *   resources/app/index.html     前端
 *   resources/app/js|css|geo     前端资源
 *   resources/app/base/*.csv     网点参考数据
 *   resources/app/node_modules/  iconv-lite / safer-buffer（crawler-engine 的运行时依赖）
 *   resources/app/txt_compare.exe  对比工具
 *
 * 刻意不拷的东西：webui.py / crawler.py（Python 单文件工具，外壳用不到）、
 * output/（运行时产出）、release/、scripts/、测试与调试产物。
 *
 *   node scripts/stage-tauri-resources.js [--clean]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources');

// ---- 要拷进 resources/app 的条目 ----
// 注意：这里是显式清单，server.js 新 require 的模块必须同步加进来，
// 否则打包版会在启动时报 MODULE_NOT_FOUND（js/ 与 css/ 走 APP_DIRS 整目录拷贝，不用列）。
const APP_FILES = [
  'server.js',
  'crawler-engine.js',
  'crawler-cities.js',
  'crawler-match.js',
  'crawler-intelligent.js',
  'img-export.js',
  'index.html',
  'txt_compare.exe',
];
const APP_DIRS = ['js', 'css', 'geo', 'base'];

// ---- Node 侧运行时依赖：只有 crawler-engine 真实 require 的那两个 ----
// （echarts / xlsx / jsbarcode 是前端 <script> 直接引用的，需要单独处理）
const NODE_MODULES = ['iconv-lite', 'safer-buffer'];

// ---- 前端 <script> 直接引用的第三方库（index.html 里写的是 node_modules/... 路径）----
const FRONTEND_LIBS = [
  'echarts/dist/echarts.min.js',
  'xlsx/dist/xlsx.full.min.js',
  'jsbarcode/dist/JsBarcode.all.min.js',
];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** 递归拷贝，返回 {files, bytes} */
function copyTree(src, dst, stats) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name), stats);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  stats.files++;
  stats.bytes += st.size;
}

/** 定位 node.exe：优先 nvm 目录（随当前 node 版本），再退回 PATH */
function findNodeExe() {
  const fromPath = process.execPath;
  if (fromPath && fs.existsSync(fromPath)) return fromPath;
  const guess = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
  if (fs.existsSync(guess)) return guess;
  return '';
}

function main() {
  const clean = process.argv.includes('--clean');
  if (clean && fs.existsSync(DEST)) {
    rmrf(DEST);
    console.log(`[stage] 已清空 ${path.relative(ROOT, DEST)}`);
    return;
  }

  console.log('============================================================');
  console.log(' 暂存 Tauri 资源');
  console.log('============================================================');

  // ---- node 运行时 ----
  const nodeExe = findNodeExe();
  if (!nodeExe) {
    console.error('[stage] 找不到 node.exe，无法打包 Node 运行时。');
    process.exit(1);
  }
  const stats = { files: 0, bytes: 0 };

  const nodeDir = path.join(DEST, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  // 只拷可执行文件本体与许可证：node_modules 里是全局工具，不属于运行时
  copyTree(nodeExe, path.join(nodeDir, 'node.exe'), stats);
  const lic = path.join(path.dirname(nodeExe), 'LICENSE');
  if (fs.existsSync(lic)) copyTree(lic, path.join(nodeDir, 'LICENSE'), stats);
  console.log(`[stage] node 运行时: ${path.basename(nodeExe)} (${(fs.statSync(nodeExe).size / 1024 / 1024).toFixed(1)} MB)`);

  // ---- 应用本体 ----
  const appDir = path.join(DEST, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  let missing = [];
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { missing.push(f); continue; }
    copyTree(src, path.join(appDir, f), stats);
  }
  for (const d of APP_DIRS) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) { missing.push(d + '/'); continue; }
    copyTree(src, path.join(appDir, d), stats);
  }
  if (missing.length) {
    console.warn(`[stage] 警告：以下条目不存在，已跳过 -> ${missing.join(', ')}`);
  }

  // ---- 运行时依赖 ----
  for (const m of NODE_MODULES) {
    const src = path.join(ROOT, 'node_modules', m);
    if (!fs.existsSync(src)) {
      console.error(`[stage] 缺少运行时依赖 node_modules/${m}，请先 npm install。`);
      process.exit(1);
    }
    copyTree(src, path.join(appDir, 'node_modules', m), stats);
  }

  // ---- 前端第三方库 ----
  for (const lib of FRONTEND_LIBS) {
    const src = path.join(ROOT, 'node_modules', lib);
    if (!fs.existsSync(src)) {
      console.error(`[stage] 缺少前端库 node_modules/${lib}，请先 npm install。`);
      process.exit(1);
    }
    copyTree(src, path.join(appDir, 'node_modules', lib), stats);
  }

  console.log(`[stage] 应用本体: ${APP_FILES.length} 个文件 + ${APP_DIRS.length} 个目录`);
  console.log(`[stage] 依赖    : ${NODE_MODULES.concat(FRONTEND_LIBS).join(', ')}`);
  console.log('------------------------------------------------------------');
  console.log(`[stage] 合计 ${stats.files} 个文件, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[stage] 输出: ${path.relative(ROOT, DEST)}`);
}

main();
