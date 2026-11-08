#!/usr/bin/env node
/**
 * 项目完整性自检（doctor）
 * ========================
 * 目的：在启动前发现「文件被误删 / 依赖没装 / node_modules 只装了一半」，
 * 直接给出修复命令，而不是等到 require() 抛 MODULE_NOT_FOUND。
 *
 * 用法：
 *   node doctor.js                 # 完整检查（含 git 删除、Electron 安装状态）
 *   node doctor.js --preflight     # 启动前静默检查（只报错误，不查 npm 状态）
 *   node doctor.js --json          # 机器可读输出
 *   npm run doctor
 *
 * 退出码：0 = 通过（允许警告）；1 = 有错误。
 *
 * 注意：本文件只使用 Node 内置模块，不能 require 项目里的任何模块。
 * 否则依赖缺失时 doctor 自己也会挂掉。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;

/** 启动链上必须存在的文件（缺一个就可能 MODULE_NOT_FOUND / 页面空白） */
const REQUIRED_FILES = [
  'index.html',
  'launch.js',
  'server.js',
  'crawler-engine.js',
  'crawler-cities.js',
  'crawler-match.js',
  'crawler-intelligent.js',
  'img-export.js',
  'uprins.js',
  'js/img-naming.js',
  'js/app.js',
  'css/style.css',
  'postal/index.js',
  'postal/http-client.js',
  'postal/base-updater.js',
  'postal/csv-exporter.js',
  'postal/logger.js',
  'package.json',
  'package-lock.json',
  // iconv-lite 的 GBK 码表：包能 resolve 但码表缺失时，爬虫写 CSV 才会炸
  'node_modules/iconv-lite/encodings/tables/cp936.json',
];

/** 目录里至少要有一种指定后缀的文件，防止「目录还在但内容被清空」 */
const REQUIRED_DIRS = [
  { rel: 'js', ext: '.js' },
  { rel: 'css', ext: '.css' },
  { rel: 'geo', ext: '.json' },
  { rel: 'base', ext: '.csv' },
];

/** Node 侧运行时依赖：crawler-engine / postal/http-client 直接 require */
const REQUIRED_MODULES = ['iconv-lite', 'safer-buffer'];

/** 前端 <script> 直接引用的文件（index.html 写的是 node_modules/... 路径） */
const FRONTEND_LIBS = [
  'node_modules/echarts/dist/echarts.min.js',
  'node_modules/xlsx/dist/xlsx.full.min.js',
  'node_modules/jsbarcode/dist/JsBarcode.all.min.js',
];

function statSafe(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

function checkFile(rel) {
  const st = statSafe(path.join(ROOT, rel));
  if (!st) return { name: rel, ok: false, message: '缺失' };
  if (!st.isFile()) return { name: rel, ok: false, message: '不是普通文件' };
  if (st.size === 0) return { name: rel, ok: false, message: '文件为空' };
  return { name: rel, ok: true, message: `${st.size} B` };
}

function checkDir(rel, ext) {
  const p = path.join(ROOT, rel);
  const st = statSafe(p);
  if (!st) return { name: `${rel}/`, ok: false, message: '缺失' };
  if (!st.isDirectory()) return { name: `${rel}/`, ok: false, message: '不是目录' };
  let entries;
  try { entries = fs.readdirSync(p); } catch (e) {
    return { name: `${rel}/`, ok: false, message: `不可读: ${e.message}` };
  }
  const count = entries.filter((f) => f.toLowerCase().endsWith(ext)).length;
  if (count === 0) {
    return { name: `${rel}/`, ok: false, message: `没有 ${ext} 文件（目录可能是空的）` };
  }
  return { name: `${rel}/`, ok: true, message: `${count} 个 ${ext} 文件` };
}

function checkModule(name) {
  try {
    const resolved = require.resolve(name, { paths: [ROOT] });
    return { name: `node_modules/${name}`, ok: true, message: resolved };
  } catch (e) {
    return {
      name: `node_modules/${name}`,
      ok: false,
      message: '无法解析（未安装或安装不完整）',
    };
  }
}

function checkLib(rel) {
  const st = statSafe(path.join(ROOT, rel));
  if (!st || !st.isFile() || st.size === 0) {
    return { name: rel, ok: false, message: '缺失或为空' };
  }
  return { name: rel, ok: true, message: `${st.size} B` };
}

/** 检查工作区里是否有被删除的 tracked 文件（只读检查，不改动任何东西） */
function checkGitDeletions() {
  try {
    const out = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const deleted = out
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => line[0] === 'D' || line[1] === 'D');
    if (deleted.length) {
      return {
        name: 'git 工作区',
        ok: false,
        message: `${deleted.length} 个已跟踪文件被删除`,
        details: deleted.slice(0, 10).map((line) => line.slice(3)),
      };
    }
    return { name: 'git 工作区', ok: true, message: '没有已跟踪文件被删除' };
  } catch (e) {
    return {
      name: 'git 工作区',
      ok: true,
      warning: true,
      message: '无法检查（git 不可用或不是仓库），已跳过',
    };
  }
}

/** node_modules 是否是 npm 完整安装的；不是则提示干净重装 */
function checkNpmState() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    return {
      name: 'node_modules 安装状态',
      ok: true,
      warning: true,
      message: '目录不存在；运行 npm ci',
    };
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json'))) {
    return {
      name: 'node_modules 安装状态',
      ok: true,
      warning: true,
      message: '缺少 .package-lock.json，可能是手工拷贝/不完整安装；建议 npm ci',
    };
  }
  return { name: 'node_modules 安装状态', ok: true, message: 'npm 安装记录存在' };
}

/** Electron 只影响 npm start，不影响 node launch.js，所以只给警告 */
function checkElectron() {
  const p = path.join(ROOT, 'node_modules', 'electron');
  if (!fs.existsSync(p)) {
    return {
      name: 'node_modules/electron',
      ok: true,
      warning: true,
      message: '未安装；npm start（Electron）不可用，node launch.js 不受影响',
    };
  }
  return { name: 'node_modules/electron', ok: true, message: '已安装' };
}

function runChecks(opts) {
  const o = opts || {};
  const checks = [];
  for (const rel of REQUIRED_FILES) checks.push(checkFile(rel));
  for (const d of REQUIRED_DIRS) checks.push(checkDir(d.rel, d.ext));
  for (const name of REQUIRED_MODULES) checks.push(checkModule(name));
  for (const rel of FRONTEND_LIBS) checks.push(checkLib(rel));
  if (o.git !== false) checks.push(checkGitDeletions());
  if (o.npmState !== false) {
    checks.push(checkNpmState());
    checks.push(checkElectron());
  }
  const errors = checks.filter((c) => !c.ok);
  const warnings = checks.filter((c) => c.warning);
  return { ok: errors.length === 0, root: ROOT, checks, errors, warnings };
}

function formatReport(report, opts) {
  const o = opts || {};
  const show = o.onlyProblems
    ? report.checks.filter((c) => !c.ok || c.warning)
    : report.checks;
  const lines = [];
  for (const c of show) {
    const tag = !c.ok ? 'FAIL' : (c.warning ? 'WARN' : ' ok ');
    lines.push(`  [${tag}] ${c.name}${c.message ? ' — ' + c.message : ''}`);
    if (c.details) {
      for (const d of c.details) lines.push(`         ${d}`);
    }
  }
  if (report.errors.length || report.warnings.length) {
    lines.push('');
    lines.push(`结果: ${report.errors.length} 项失败, ${report.warnings.length} 项警告`);
  } else if (!o.onlyProblems) {
    lines.push('');
    lines.push('结果: 全部通过');
  }
  return lines.join('\n');
}

function printRepair() {
  console.error('');
  console.error('修复建议：');
  console.error('  git status --short');
  console.error('  git restore -- js css geo base postal index.html   # 仅在确认是误删时执行');
  console.error('         （失败列表里若有其它路径，按路径补：git restore -- <路径>）');
  console.error('  npm ci            # 若 package-lock.json 也丢了，改用 npm install');
  console.error('  npm run doctor');
  console.error('');
  console.error('提示：如果 git restore 会覆盖你未提交的修改，先备份或 git stash。');
}

/**
 * 启动前轻量检查：查关键文件/依赖 + git 已跟踪文件删除；
 * 不查 npm 安装状态，也不输出成功信息。
 * @returns {boolean} true = 可以启动
 */
function preflight() {
  const report = runChecks({ npmState: false });
  if (report.ok) return true;
  console.error('[doctor] 启动前检查未通过：');
  console.error(formatReport(report, { onlyProblems: true }));
  printRepair();
  return false;
}

function main(argv) {
  const args = new Set(argv || []);
  const json = args.has('--json');
  const preflightMode = args.has('--preflight');
  const report = runChecks({ npmState: !preflightMode });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (preflightMode) {
    if (!report.ok) {
      console.error(formatReport(report, { onlyProblems: true }));
      printRepair();
    }
  } else {
    console.log('============================================================');
    console.log(' 项目完整性自检 (doctor)');
    console.log(` 目录: ${ROOT}`);
    console.log('============================================================');
    console.log(formatReport(report));
    if (!report.ok) printRepair();
  }

  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { ROOT, runChecks, preflight, formatReport };
