#!/usr/bin/env node
/**
 * npm start 的启动包装
 * ====================
 * 两个目标：
 *
 *  A. 数据只有一份 —— 受限身份写不了 %APPDATA%，而普通身份默认写 %APPDATA%，
 *     两边各写一份就得反复导出/导入。所以这里**固定使用项目内的 .userdata**：
 *     两种身份、每次启动都是同一份数据，不需要任何手工同步。
 *     首次运行会把 %APPDATA%\postmark-system 里的记录复制过来（只读复制，原数据不动）；
 *     若之后系统 profile 比它更新（例如用过 npm run start:electron），会先备份再同步过来。
 *
 *  B. 窗口真的出来才算成功 —— 受限环境里可能"进程活着但窗口永远不显示"。
 *     启动时设置 POSTMARK_STARTUP_REPORT，main.js 在 boot/server/shown/error 节点回执，
 *     只有 ready-to-show 之后 win.isVisible() 为真才回 shown；收不到就换下一种参数。
 *
 * 尝试顺序（最小权限优先），成功的方式记在 profile 的 .start-memory.json，下次直接用：
 *   ① --user-data-dir=<项目>/.userdata
 *   ② --no-sandbox --user-data-dir=...
 *   ③ --disable-gpu-sandbox --user-data-dir=...
 *
 * 直连 Electron（用 %APPDATA%，仅排错用）：npm run start:electron
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PREFERRED_PORT = 19876;
const BOOT_WAIT_MS = 15000;       // 等应用写出第一份回执（证明它认识本机制）
const SHOWN_WAIT_MS = 30000;      // 已有回执后，等窗口真正显示的最长时间
const MEMORY_FILE = '.start-memory.json';
const MEMORY_SCHEMA = 3;          // 判定方式/参数集变更时递增，旧记忆自动失效
const SYNC_SKEW_MS = 5 * 60 * 1000;
const PROFILE_ITEMS = ['Local Storage', 'Preferences', 'Local State', 'Session Storage'];

// ---------- Electron ----------
function resolveElectron() {
  try {
    const p = require('electron');                 // 普通 Node 下返回可执行文件路径
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch { /* 用兜底路径 */ }
  const guess = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(guess)) return guess;
  console.error('[start] 找不到 Electron，请先执行 npm install');
  process.exit(1);
}

const ELECTRON = resolveElectron();

// ---------- profile ----------
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const APP_NAME = require(path.join(ROOT, 'package.json')).name || 'postmark-system';
const SYSTEM_PROFILE = path.join(APPDATA, APP_NAME);
const PROJECT_PROFILE = path.join(ROOT, '.userdata');

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function newestMtimeMs(dir) {
  let newest = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch { /* skip */ } }
    }
  };
  walk(dir);
  return newest;
}

function copyProfile(fromDir, toDir, items) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const item of items || PROFILE_ITEMS) {
    const src = path.join(fromDir, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(toDir, item);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

/**
 * 保证项目内 profile 是最新的一份（两种身份共用）。
 * @returns {'ok'|'empty'|'seeded'|{migrated:true,backup:string}}
 */
function ensureProjectProfile() {
  const fromLs = path.join(SYSTEM_PROFILE, 'Local Storage');
  const toLs = path.join(PROJECT_PROFILE, 'Local Storage');
  try {
    if (!fs.existsSync(toLs)) {
      if (!fs.existsSync(fromLs)) return 'empty';
      copyProfile(SYSTEM_PROFILE, PROJECT_PROFILE);
      return 'seeded';
    }
    if (!fs.existsSync(fromLs)) return 'ok';
    // 系统 profile 明显更新（例如刚用过 npm run start:electron）→ 先备份再同步过来
    if (newestMtimeMs(fromLs) - newestMtimeMs(toLs) > SYNC_SKEW_MS) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(ROOT, '_recovery', `profile-backup-${stamp}`);
      try { copyProfile(PROJECT_PROFILE, backup, ['Local Storage']); } catch { /* 备份失败就不搬 */ return 'ok'; }
      copyProfile(SYSTEM_PROFILE, PROJECT_PROFILE);
      return { migrated: true, backup };
    }
  } catch (e) {
    console.warn('[start] profile 检查/同步失败（继续启动）:', e.message);
  }
  return 'ok';
}

function readMemory(profileDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(profileDir, MEMORY_FILE), 'utf8'));
    return m && m.schema === MEMORY_SCHEMA ? m : {};
  } catch { return {}; }
}
function writeMemory(profileDir, id) {
  try {
    fs.writeFileSync(path.join(profileDir, MEMORY_FILE),
      JSON.stringify({ schema: MEMORY_SCHEMA, lastGood: id }, null, 2));
  } catch { /* 记不住就算了 */ }
}

function isPortBusy() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: PREFERRED_PORT });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

function fmtCode(code) {
  if (typeof code !== 'number') return String(code);
  return code < 0 || code > 0xffff ? `${code} (0x${(code >>> 0).toString(16).toUpperCase()})` : String(code);
}

function readReport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/** 跑一次尝试：只有收到 shown 回执才算成功 */
async function attempt(args, reportFile) {
  fs.rmSync(reportFile, { force: true });
  const child = spawn(ELECTRON, [...args, '.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { POSTMARK_STARTUP_REPORT: reportFile }),
  });

  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => { exited = true; exitCode = code; });
  child.once('error', (err) => { exited = true; exitCode = -1; console.error('[start]', err.message); });

  const bootDeadline = Date.now() + BOOT_WAIT_MS;
  let sawReport = false;
  let shownDeadline = 0;

  while (!exited) {
    await sleep(300);
    const rep = readReport(reportFile);
    if (rep) {
      if (!sawReport) { sawReport = true; shownDeadline = Date.now() + SHOWN_WAIT_MS; }
      if (rep.phase === 'shown') { child.removeAllListeners('exit'); return { ok: true, why: 'shown', child }; }
      if (rep.phase === 'error') {
        child.kill();
        return { ok: false, why: `应用报告失败: ${rep.reason || 'unknown'}` };
      }
    } else if (Date.now() > bootDeadline && !sawReport) {
      // 应用不认识回执机制（旧版 main.js）：退回"活着即成功"
      child.removeAllListeners('exit');
      return { ok: true, why: 'legacy-alive', child };
    }
    if (sawReport && Date.now() > shownDeadline) {
      const last = readReport(reportFile) || {};
      child.kill();
      return { ok: false, why: `等不到窗口显示（最后回执: ${last.phase || '?'}）` };
    }
  }
  return { ok: false, why: `进程退出 code=${fmtCode(exitCode)}` };
}

const waitExit = (child) => new Promise((resolve) => child.once('exit', (c) => resolve(c == null ? 0 : c)));

// ---------- 主流程 ----------
async function main() {
  const extraArgs = process.argv.slice(2);          // npm start -- --xxx 透传
  const reportFile = path.join(os.tmpdir(), `postmark-startup-${process.pid}.json`);

  console.log('============================================================');
  console.log(' 新一代日戳管理系统 — npm start');

  let activeProfile = PROJECT_PROFILE;
  const profileState = ensureProjectProfile();
  if (profileState === 'seeded') {
    console.log(' [迁移] 首次使用项目内 profile：已从 %APPDATA% 复制一份记录（原数据不动）');
  } else if (profileState && profileState.migrated) {
    console.log(` [迁移] 检测到系统 profile 更新，已同步到项目内 profile；`);
    console.log(`        原副本备份于 ${path.relative(ROOT, profileState.backup)}`);
  }
  if (!isWritable(activeProfile)) {
    console.log(` [警告] ${activeProfile} 不可写，改用 %APPDATA% profile（记录可能读不到）`);
    activeProfile = SYSTEM_PROFILE;
  }
  console.log(` 数据 profile : ${activeProfile}`);
  console.log('                （两种启动身份共用这一份，无需再导出/导入）');
  if (await isPortBusy()) {
    console.log(` [警告] 端口 ${PREFERRED_PORT} 已被占用：本次会改用随机端口，`);
    console.log('        而 Local Storage 按端口隔离，界面可能看不到已有记录。');
  }

  const ud = `--user-data-dir=${activeProfile}`;
  let plan = [
    { id: 'local',      label: '项目 profile（保留 Chromium 沙箱）',   args: [ud] },
    { id: 'local-none', label: '项目 profile + 关闭 Chromium 沙箱',    args: ['--no-sandbox', ud] },
    { id: 'local-gpu',  label: '项目 profile + 只关 GPU 沙箱',         args: ['--disable-gpu-sandbox', ud] },
  ];
  const remembered = readMemory(activeProfile).lastGood;
  if (remembered && plan.some((s) => s.id === remembered)) {
    plan = [plan.find((s) => s.id === remembered), ...plan.filter((s) => s.id !== remembered)];
    console.log(` [记忆] 上次可用方式: ${remembered}`);
  }
  console.log('============================================================');

  for (const step of plan) {
    const args = [...step.args, ...extraArgs];
    console.log(`\n[start] ${step.label}`);
    console.log(`        ${path.basename(ELECTRON)} ${args.join(' ')} .\n`);

    const r = await attempt(args, reportFile);
    if (r.ok) {
      if (r.why === 'legacy-alive') console.log('\n[start] 未收到窗口回执（应用较旧），按进程存活判定为已启动。');
      else console.log('\n[start] 窗口已显示，启动成功。');
      if (remembered !== step.id) {
        writeMemory(activeProfile, step.id);
        console.log(`[start] 已记住此方式: ${step.id}`);
      }
      process.exitCode = await waitExit(r.child);
      fs.rmSync(reportFile, { force: true });
      return;
    }
    console.log(`\n[start] 失败：${r.why}，继续尝试下一种。`);
  }

  fs.rmSync(reportFile, { force: true });
  console.log('\n[start] 全部方式都没能让窗口显示出来。请把上面的输出发给维护者，');
  console.log('        并附上是否在任务管理器里看到 electron.exe 进程（有无窗口标题）。');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('[start] 启动器自身出错:', e);
  process.exitCode = 1;
});
