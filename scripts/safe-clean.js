#!/usr/bin/env node
/**
 * 安全清理临时文件（safe-clean）
 * ==============================
 * 只清理明确列在白名单里的生成物；默认 dry-run，必须加 --apply 才真正删除。
 *
 * 背景：Windows 上对含 junction 的临时目录做递归删除，会穿透链接删掉项目里的
 * 真实目录（js / css / geo / base / node_modules）。本脚本因此：
 *   1. 不清理项目目录本身，只清理 output/、data/、_recovery/ 下的指定临时物；
 *   2. 删除前逐项 lstat，遇到符号链接/目录联接直接拒绝，绝不递归跟随；
 *   3. 用自写的 removeTree（先删子项再 rmdir），不用 fs.rmSync(recursive)；
 *   4. 默认 dry-run；--apply 前先做 git tracked 检查与完整扫描；
 *   5. 每次 apply 写 _recovery/cleanup-<时间>.log 审计日志。
 *
 * 用法：
 *   node scripts/safe-clean.js                 # 预览
 *   node scripts/safe-clean.js --apply         # 真正删除
 *   node scripts/safe-clean.js --include-tmp-scripts   # 额外清理 scripts/_tmp_*
 *   node scripts/safe-clean.js --force         # git 不可用时仍允许 apply（谨慎）
 *
 * 注意：运行前最好关闭应用/抓取，避免删到正在写入的临时文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 允许整目录删除的浏览器缓存目录名（在 data/browser-chrome 下按名字查找） */
const CACHE_DIR_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
]);

const USAGE = `安全清理临时文件（默认 dry-run，只预览）

用法：
  node scripts/safe-clean.js
  node scripts/safe-clean.js --apply
  node scripts/safe-clean.js --include-tmp-scripts
  node scripts/safe-clean.js --force

允许清理：
  .smoke-*.html（项目根目录）
  output/tmp/
  output/**/*.part
  data/browser-chrome 下的 Cache / Code Cache / GPUCache / ShaderCache 等
  _recovery/tmp-*
  scripts/_tmp_*（需 --include-tmp-scripts）

保护：
  .git/、node_modules/、js/、css/、geo/、base/、postal/、src-tauri/、
  index.html、根目录 *.js、package*.json、data/ 其余内容、output/ 其余内容。

--force 只绕过“git 不可用”的拦截，不会绕过 tracked 文件或符号链接检查。`;

function lstatSafe(p) {
  try { return fs.lstatSync(p); } catch (e) { return null; }
}

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch (e) { return ''; }
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** abs 是否在 root 内（且不等于 root）；用 realpath 防止父目录是链接 */
function isInsideRoot(root, abs) {
  const realRoot = realpathSafe(root);
  const realAbs = realpathSafe(abs);
  if (!realRoot || !realAbs) return false;
  const r = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const a = process.platform === 'win32' ? realAbs.toLowerCase() : realAbs;
  return a !== r && a.startsWith(r + path.sep);
}

function isUnder(abs, dir) {
  const r = path.relative(dir, abs);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function readdirSafe(dir, warnings) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push(`无法读取 ${dir}: ${e.message}`);
    return [];
  }
}

/** 遍历目录收集匹配文件；不跟随符号链接，遇到链接只记 warning */
function walkFiles(dir, predicate, onFile, warnings) {
  for (const entry of readdirSafe(dir, warnings)) {
    const p = path.join(dir, entry.name);
    const st = lstatSafe(p);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      warnings.push(`跳过符号链接/联接: ${p}`);
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(p, predicate, onFile, warnings);
    } else if (st.isFile() && predicate(entry.name)) {
      onFile(p);
    }
  }
}

/** 在浏览器 profile 里按名字找缓存目录；命中后不再深入该目录 */
function findCacheDirs(dir, add, warnings) {
  for (const entry of readdirSafe(dir, warnings)) {
    const p = path.join(dir, entry.name);
    const st = lstatSafe(p);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      warnings.push(`跳过符号链接/联接: ${p}`);
      continue;
    }
    if (!st.isDirectory()) continue;
    if (CACHE_DIR_NAMES.has(entry.name)) {
      add(p, 'dir', '浏览器缓存');
      continue;
    }
    findCacheDirs(p, add, warnings);
  }
}

/** 收集候选目标；所有路径都必须在 root 内，且后续还会再过一遍 isAllowed */
function collectTargets(root, opts) {
  const options = opts || {};
  const targets = [];
  const warnings = [];
  const seen = new Set();

  const add = (abs, kind, reason) => {
    const key = path.resolve(abs);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ abs: key, kind, reason });
  };

  // 1) 项目根目录的 .smoke-*.html（P0 自检页）
  for (const entry of readdirSafe(root, warnings)) {
    if (!/^\.smoke-.*\.html$/.test(entry.name)) continue;
    const p = path.join(root, entry.name);
    const st = lstatSafe(p);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      warnings.push(`跳过符号链接/联接: ${rel(root, p)}`);
      continue;
    }
    if (!st.isFile()) {
      warnings.push(`跳过非文件: ${rel(root, p)}`);
      continue;
    }
    add(p, 'file', '自检临时页');
  }

  // 2) output/tmp/
  const outputDir = path.join(root, 'output');
  const tmpDir = path.join(outputDir, 'tmp');
  const tmpSt = lstatSafe(tmpDir);
  if (tmpSt) {
    if (tmpSt.isSymbolicLink()) {
      warnings.push('跳过符号链接/联接: output/tmp');
    } else {
      add(tmpDir, tmpSt.isDirectory() ? 'dir' : 'file', '爬虫临时目录');
    }
  }

  // 3) output/**/*.part（跳过已在 output/tmp 目标内的文件）
  const outputSt = lstatSafe(outputDir);
  if (outputSt && outputSt.isSymbolicLink()) {
    warnings.push('跳过符号链接/联接: output');
  } else if (outputSt && outputSt.isDirectory()) {
    walkFiles(outputDir, (name) => name.toLowerCase().endsWith('.part'), (p) => {
      if (targets.some((t) => t.kind === 'dir' && isUnder(p, t.abs))) return;
      add(p, 'file', '未完成的 .part 文件');
    }, warnings);
  }

  // 4) data/browser-chrome 下的浏览器缓存目录
  const profileDir = path.join(root, 'data', 'browser-chrome');
  const profileSt = lstatSafe(profileDir);
  if (profileSt && profileSt.isSymbolicLink()) {
    warnings.push('跳过符号链接/联接: data/browser-chrome');
  } else if (profileSt && profileSt.isDirectory()) {
    findCacheDirs(profileDir, add, warnings);
  }

  // 5) _recovery/tmp-*
  const recoveryDir = path.join(root, '_recovery');
  const recoverySt = lstatSafe(recoveryDir);
  if (recoverySt && recoverySt.isSymbolicLink()) {
    warnings.push('跳过符号链接/联接: _recovery');
  } else if (recoverySt && recoverySt.isDirectory()) {
    for (const entry of readdirSafe(recoveryDir, warnings)) {
      if (!entry.name.startsWith('tmp-')) continue;
      const p = path.join(recoveryDir, entry.name);
      const st = lstatSafe(p);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        warnings.push(`跳过符号链接/联接: ${rel(root, p)}`);
        continue;
      }
      add(p, st.isDirectory() ? 'dir' : 'file', '_recovery 临时项');
    }
  }

  // 6) scripts/_tmp_*（必须显式开启）
  if (options.includeTmpScripts) {
    const scriptsDir = path.join(root, 'scripts');
    const scriptsSt = lstatSafe(scriptsDir);
    if (scriptsSt && scriptsSt.isSymbolicLink()) {
      warnings.push('跳过符号链接/联接: scripts');
    } else if (scriptsSt && scriptsSt.isDirectory()) {
      for (const entry of readdirSafe(scriptsDir, warnings)) {
        if (!entry.name.startsWith('_tmp_')) continue;
        const p = path.join(scriptsDir, entry.name);
        const st = lstatSafe(p);
        if (!st) continue;
        if (st.isSymbolicLink()) {
          warnings.push(`跳过符号链接/联接: ${rel(root, p)}`);
          continue;
        }
        add(p, st.isDirectory() ? 'dir' : 'file', 'scripts 临时脚本');
      }
    }
  }

  return { targets, warnings };
}

/** 递归扫描目标，统计文件/字节，并记录任何符号链接/联接 */
function scanTree(root, abs) {
  const result = { files: 0, bytes: 0, symlinks: [], errors: [] };

  (function walk(p) {
    const st = lstatSafe(p);
    if (!st) {
      result.errors.push(`${rel(root, p)}: 无法读取`);
      return;
    }
    if (st.isSymbolicLink()) {
      result.symlinks.push(rel(root, p));
      return;
    }
    if (st.isDirectory()) {
      const entries = readdirSafe(p, result.errors);
      for (const entry of entries) walk(path.join(p, entry.name));
    } else if (st.isFile()) {
      result.files++;
      result.bytes += st.size;
    } else {
      result.errors.push(`${rel(root, p)}: 不是普通文件`);
    }
  })(abs);

  return result;
}

/** 检查单个目标：存在性、链接、是否在 root 内、类型、内部链接 */
function inspectTarget(root, target) {
  const st = lstatSafe(target.abs);
  if (!st) return { ...target, missing: true };
  if (st.isSymbolicLink()) return { ...target, unsafe: '符号链接/目录联接' };
  if (!isInsideRoot(root, target.abs)) return { ...target, unsafe: '解析后不在项目目录内' };
  if (target.kind === 'dir' && !st.isDirectory()) return { ...target, unsafe: '期望目录但实际不是' };
  if (target.kind === 'file' && !st.isFile()) return { ...target, unsafe: '期望文件但实际不是' };
  if (st.isFile()) return { ...target, files: 1, bytes: st.size };

  const scan = scanTree(root, target.abs);
  let unsafe = '';
  if (scan.symlinks.length) unsafe = `目标内发现 ${scan.symlinks.length} 个符号链接/联接`;
  else if (scan.errors.length) unsafe = `无法完整扫描: ${scan.errors[0]}`;
  return {
    ...target,
    files: scan.files,
    bytes: scan.bytes,
    symlinks: scan.symlinks,
    errors: scan.errors,
    unsafe,
  };
}

/** 防御性二次校验：只允许白名单里的路径 */
function isAllowed(root, target) {
  const r = rel(root, target.abs);
  if (target.reason === '自检临时页') {
    return r === path.basename(target.abs) && /^\.smoke-.*\.html$/.test(r);
  }
  if (target.reason === '爬虫临时目录') {
    return r === 'output/tmp';
  }
  if (target.reason === '未完成的 .part 文件') {
    return r.startsWith('output/') && r.toLowerCase().endsWith('.part');
  }
  if (target.reason === '浏览器缓存') {
    return r.startsWith('data/browser-chrome/') && CACHE_DIR_NAMES.has(path.basename(target.abs));
  }
  if (target.reason === '_recovery 临时项') {
    return r.startsWith('_recovery/') && path.basename(target.abs).startsWith('tmp-');
  }
  if (target.reason === 'scripts 临时脚本') {
    return r.startsWith('scripts/') && path.basename(target.abs).startsWith('_tmp_');
  }
  return false;
}

/** 用 git 检查目标里是否有已跟踪文件；git 不可用则 available=false */
function gitTracked(root, targets) {
  const paths = targets.map((t) => rel(root, t.abs));
  if (paths.length === 0) return { available: true, tracked: [] };
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, tracked: out.split('\0').filter(Boolean) };
  } catch (e) {
    return { available: false, tracked: [], error: e.message };
  }
}

function gitStatus(root) {
  try {
    const out = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || '(clean)';
  } catch (e) {
    return '(git 不可用)';
  }
}

/** 不跟随链接的递归删除；遇到任何链接立即抛错 */
function removeTree(root, abs) {
  const st = lstatSafe(abs);
  if (!st) return { files: 0, bytes: 0 };
  if (st.isSymbolicLink()) throw new Error(`拒绝删除符号链接/联接: ${rel(root, abs)}`);
  if (!st.isDirectory()) throw new Error(`不是目录: ${rel(root, abs)}`);

  let files = 0;
  let bytes = 0;
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(abs, entry.name);
    const s = lstatSafe(p);
    if (!s) continue;
    if (s.isSymbolicLink()) {
      throw new Error(`目标内发现符号链接/联接，拒绝删除: ${rel(root, p)}`);
    }
    if (s.isDirectory()) {
      const r = removeTree(root, p);
      files += r.files;
      bytes += r.bytes;
    } else if (s.isFile()) {
      fs.unlinkSync(p);
      files++;
      bytes += s.size;
    } else {
      throw new Error(`不是普通文件: ${rel(root, p)}`);
    }
  }
  fs.rmdirSync(abs);
  return { files, bytes };
}

function removeTarget(root, target) {
  const st = lstatSafe(target.abs);
  if (!st) return { files: 0, bytes: 0 };
  if (st.isSymbolicLink()) throw new Error('拒绝删除符号链接/联接');
  if (!isInsideRoot(root, target.abs)) throw new Error('路径不在项目目录内');
  if (st.isDirectory()) return removeTree(root, target.abs);
  if (st.isFile()) {
    fs.unlinkSync(target.abs);
    return { files: 1, bytes: st.size };
  }
  throw new Error('不是普通文件或目录');
}

function printTargets(root, list) {
  for (const t of list) {
    const size = t.kind === 'file'
      ? formatBytes(t.bytes || 0)
      : `${t.files || 0} 个文件, ${formatBytes(t.bytes || 0)}`;
    console.log(`  [${t.kind}] ${rel(root, t.abs)}  (${size})  — ${t.reason}`);
  }
}

/**
 * 执行清理。root 可注入，方便在临时目录做安全回归。
 * @returns {{ok:boolean, applied:boolean, deletedFiles:number, deletedBytes:number, logPath?:string, errors?:Array, unsafe?:Array, tracked?:string[]}}
 */
function run(opts) {
  const options = opts || {};
  const root = path.resolve(options.root || ROOT);
  const apply = !!options.apply;
  const includeTmpScripts = !!options.includeTmpScripts;
  const force = !!options.force;

  console.log('============================================================');
  console.log(' 安全清理临时文件 (safe-clean)');
  console.log(` 目录: ${root}`);
  console.log(` 模式: ${apply ? 'APPLY（会真正删除）' : 'DRY-RUN（只预览，不删除）'}`);
  console.log('============================================================');

  const { targets, warnings } = collectTargets(root, { includeTmpScripts });
  if (warnings.length) {
    console.log('\n[warn] 扫描时跳过/忽略：');
    for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (warnings.length > 20) console.log(`  ... 还有 ${warnings.length - 20} 条`);
  }

  const inspected = targets.map((t) => inspectTarget(root, t));
  const missing = inspected.filter((t) => t.missing);
  const present = inspected.filter((t) => !t.missing);

  if (missing.length) {
    console.log('\n[warn] 扫描后已不存在，跳过：');
    for (const t of missing.slice(0, 10)) console.log(`  - ${rel(root, t.abs)}`);
  }

  if (present.length === 0) {
    console.log('\n没有可清理的临时文件。');
    return { ok: true, applied: false, deletedFiles: 0, deletedBytes: 0, targets: [] };
  }

  // 二次校验：不在白名单内的目标一律拒绝
  for (const t of present) {
    if (!t.unsafe && !isAllowed(root, t)) t.unsafe = '不在允许清理的路径清单内';
  }

  console.log('\n目标：');
  printTargets(root, present);

  const unsafe = present.filter((t) => t.unsafe);
  if (unsafe.length) {
    console.log('\n[abort] 以下目标不安全，未删除任何文件：');
    for (const t of unsafe) console.log(`  - ${rel(root, t.abs)}: ${t.unsafe}`);
    return { ok: false, applied: false, deletedFiles: 0, deletedBytes: 0, unsafe, targets: present };
  }

  const git = gitTracked(root, present);
  if (!git.available) {
    console.log(`\n[warn] git 检查不可用：${git.error || '未知原因'}`);
  }
  if (git.tracked.length) {
    console.log('\n[abort] 以下目标包含 git 已跟踪文件，未删除任何文件：');
    for (const p of git.tracked.slice(0, 20)) console.log(`  - ${p}`);
    if (git.tracked.length > 20) console.log(`  ... 还有 ${git.tracked.length - 20} 个`);
    return { ok: false, applied: false, deletedFiles: 0, deletedBytes: 0, tracked: git.tracked, targets: present };
  }

  if (apply && !git.available && !force) {
    console.log('\n[abort] 无法执行 git 检查。确认目标都是生成文件后，可加 --force 再试。');
    return { ok: false, applied: false, deletedFiles: 0, deletedBytes: 0, targets: present };
  }

  if (!apply) {
    console.log('\n[dry-run] 未删除任何文件。确认无误后执行：');
    console.log('  npm run clean:temp -- --apply');
    return { ok: true, applied: false, deletedFiles: 0, deletedBytes: 0, targets: present };
  }

  // ---- apply ----
  const recoveryDir = path.join(root, '_recovery');
  const recoverySt = lstatSafe(recoveryDir);
  if (recoverySt && recoverySt.isSymbolicLink()) {
    console.error('\n[abort] _recovery 是符号链接/目录联接，拒绝写入审计日志。');
    return { ok: false, applied: false, deletedFiles: 0, deletedBytes: 0, targets: present };
  }
  try {
    fs.mkdirSync(recoveryDir, { recursive: true });
  } catch (e) {
    console.error(`\n[abort] 无法创建审计日志目录 ${recoveryDir}: ${e.message}`);
    return { ok: false, applied: false, deletedFiles: 0, deletedBytes: 0, targets: present };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(recoveryDir, `cleanup-${stamp}.log`);
  const log = (line) => {
    try { fs.appendFileSync(logPath, line + '\n'); } catch (e) { /* 日志失败不阻断清理 */ }
  };

  log('Postmark safe-clean');
  log(`time: ${new Date().toISOString()}`);
  log(`root: ${root}`);
  log(`mode: apply${force ? ' (--force)' : ''}`);
  log(`git: ${git.available ? 'available' : 'unavailable'}${git.available ? '' : ' (' + (git.error || '') + ')'}`);
  log('targets:');
  for (const t of present) log(`  ${t.kind} ${rel(root, t.abs)} reason=${t.reason}`);
  log('git status before:');
  log(gitStatus(root));

  let deletedFiles = 0;
  let deletedBytes = 0;
  const errors = [];

  for (const t of present) {
    try {
      const r = removeTarget(root, t);
      deletedFiles += r.files;
      deletedBytes += r.bytes;
      log(`OK ${t.kind} ${rel(root, t.abs)} files=${r.files} bytes=${r.bytes}`);
      console.log(`  [deleted] ${rel(root, t.abs)}`);
    } catch (e) {
      errors.push({ path: rel(root, t.abs), message: e.message });
      log(`FAIL ${t.kind} ${rel(root, t.abs)}: ${e.message}`);
      console.error(`  [failed] ${rel(root, t.abs)}: ${e.message}`);
    }
  }

  log('git status after:');
  log(gitStatus(root));
  log(`summary: files=${deletedFiles} bytes=${deletedBytes} errors=${errors.length}`);

  console.log(`\n[safe-clean] 完成：删除 ${deletedFiles} 个文件，${formatBytes(deletedBytes)}。`);
  console.log(`[safe-clean] 审计日志: ${rel(root, logPath)}`);
  if (errors.length) console.error(`[safe-clean] ${errors.length} 个目标删除失败，详见日志。`);

  return {
    ok: errors.length === 0,
    applied: true,
    deletedFiles,
    deletedBytes,
    logPath,
    errors,
    targets: present,
  };
}

function main(argv) {
  const args = argv || [];
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const known = new Set(['--apply', '--include-tmp-scripts', '--force']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`未知参数: ${unknown.join(' ')}`);
    console.error(USAGE);
    return 1;
  }

  const result = run({
    root: ROOT,
    apply: args.includes('--apply'),
    includeTmpScripts: args.includes('--include-tmp-scripts'),
    force: args.includes('--force'),
  });
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { ROOT, run, collectTargets };
