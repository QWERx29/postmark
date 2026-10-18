#!/usr/bin/env node
/**
 * 浏览器启动器 — 新一代日戳管理系统
 * ====================================
 * 用系统浏览器（默认 Chrome）当窗口，取代 Electron 外壳。
 *
 * 为什么可以这样做
 * ----------------
 * 渲染层（index.html / js/*）只用 fetch 和 localStorage，从不 require('electron')，
 * 后端爬虫逻辑本来就是纯 Node。所以"窗口"换成本地浏览器的标签页/应用窗口之后，
 * 业务代码一行都不用改。
 *
 * 三个关键约定
 * ------------
 * 1. **端口固定 19876，绝不随机**。Local Storage 按 origin 隔离，端口一变
 *    就等于换了一份数据。因此发现端口已被占用时，不是换端口，而是认为
 *    "应用已经在跑"，直接把窗口指过去。
 * 2. **专属 profile**（<项目>/data/browser-chrome）。既保证 origin 上的记录
 *    只有这一份、不会被日常浏览器的清理动作带走，也避免把应用数据混进
 *    你平时用的 Chrome 里。
 * 3. **单个实例**。第二次双击不会起第二个服务器，只会再开一个窗口。
 *
 * 用法:
 *   node launch.js                 # 起服务 + 开窗口
 *   node launch.js --no-window     # 只起服务（调试用，Ctrl+C 停止）
 *   node launch.js --browser=chrome|edge|default
 *   node launch.js --port=19876
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const Server = require('./server');

const ROOT = __dirname;
const HOST = Server.DEFAULT_HOST;
const DEFAULT_PORT = Server.DEFAULT_PORT;

/** 专属浏览器 profile 的落点（与 Electron 的 .userdata 区分开） */
const DATA_DIR = path.join(ROOT, 'data');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 命令行 ----------
function parseArgs(argv) {
  const read = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  return {
    port: Number(read('port', String(DEFAULT_PORT))),
    browser: read('browser', process.env.POSTMARK_BROWSER || 'chrome'),
    noWindow: argv.includes('--no-window'),
  };
}

// ---------- 端口探测 ----------
/** 端口上是否已有本应用在响应（拿到 /api/crawl/provinces 的 JSON 才算数） */
async function probeExistingApp(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://${HOST}:${port}/api/crawl/provinces`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 端口是否被任意进程占用 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port });
    const done = (v) => { try { sock.destroy(); } catch (e) { /* ignore */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(true), 800);          // 超时按"占用"处理，宁可提示也不要抢端口
  });
}

// ---------- 浏览器定位 ----------
function browserCandidates(kind) {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

  const chrome = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const edge = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  if (kind === 'chrome') return chrome;
  if (kind === 'edge') return edge;
  return [];                                   // default：交给系统默认浏览器
}

function findBrowser(kind) {
  for (const exe of browserCandidates(kind)) {
    try { if (fs.existsSync(exe)) return exe; } catch (e) { /* 继续 */ }
  }
  return '';
}

/**
 * 用应用模式打开窗口。
 * @returns {import('child_process').ChildProcess|null} 打开成功返回子进程，失败返回 null
 */
function openAppWindow(exe, url, profileDir) {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    // 首次运行气泡、默认浏览器询问、后台预取等都会破坏"像个应用"的观感
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-networking',
  ];
  try {
    return spawn(exe, args, { stdio: 'ignore', detached: false });
  } catch (e) {
    console.error('[launch] 打开应用窗口失败:', e.message);
    return null;
  }
}

/** 兜底：用系统默认浏览器打开一个普通标签页 */
function openDefaultBrowser(exe, url) {
  try {
    if (exe) return spawn(exe, [url], { stdio: 'ignore', detached: false });
    // 交给系统 shell 处理 .html 之类的关联
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    return spawn(cmd, args, { stdio: 'ignore', detached: false, windowsHide: true });
  } catch (e) {
    console.error('[launch] 打开默认浏览器失败:', e.message);
    return null;
  }
}

// ---------- 主流程 ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = `http://${HOST}:${opts.port}`;

  console.log('============================================================');
  console.log(' 新一代日戳管理系统 — 浏览器模式');
  console.log(` 项目目录: ${ROOT}`);
  console.log(` 数据目录: ${path.relative(ROOT, PROFILE_DIR)}`);
  console.log('============================================================');

  // ---- 步骤 1：是否已有实例 ----
  let reuse = false;
  if (await probeExistingApp(opts.port)) {
    reuse = true;
    console.log(`[launch] 检测到已有本应用在 ${url} 运行，直接打开窗口。`);
  } else if (await isPortBusy(opts.port)) {
    // 端口被别的程序占着：这是唯一必须让用户介入的情况
    console.error(`[launch] 端口 ${opts.port} 已被其它程序占用，无法启动。`);
    console.error('         本应用固定使用该端口（换端口会使浏览器里的既有记录不可见），');
    console.error('         请先关闭占用该端口的程序，或确认它是不是本应用的旧实例。');
    process.exitCode = 1;
    return;
  }

  // ---- 步骤 2：起服务器 ----
  let server = null;
  let port = opts.port;
  if (!reuse) {
    try {
      const started = await Server.start({ root: ROOT, host: HOST, port: opts.port });
      server = started.server;
      port = started.port;
      console.log(`[launch] 服务器已启动: http://${HOST}:${port}`);
    } catch (err) {
      const busy = err && err.code === 'EADDRINUSE';
      console.error(`[launch] 服务器启动失败: ${busy ? `端口 ${opts.port} 已被占用` : (err && err.message) || err}`);
      process.exitCode = 1;
      return;
    }
  }

  const actualUrl = `http://${HOST}:${port}`;

  const shutdown = async () => {
    if (server) {
      await Server.stop(server);
      console.log('[launch] 服务器已停止。');
    }
  };

  if (opts.noWindow) {
    console.log('[launch] --no-window：服务器保持运行，按 Ctrl+C 停止。');
    process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
    return;
  }

  // ---- 步骤 3：开窗口 ----
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const exe = findBrowser(opts.browser);
  let child = null;
  let usingDefaultBrowser = false;

  if (exe) {
    console.log(`[launch] 使用 ${opts.browser}: ${exe}`);
    child = openAppWindow(exe, actualUrl, PROFILE_DIR);
  } else {
    console.log(`[launch] 未找到 ${opts.browser}，回退到系统默认浏览器（普通标签页）。`);
    usingDefaultBrowser = true;
    child = openDefaultBrowser('', actualUrl);
  }

  if (!child) {
    console.error('[launch] 无法打开浏览器窗口。服务器仍在运行，可手动访问:');
    console.error(`         ${actualUrl}`);
    console.error('         按 Ctrl+C 停止服务器。');
    process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
    return;
  }

  // ---- 步骤 4：窗口关掉就收工 ----
  // 应用模式下子进程与窗口同生命周期，退出即代表用户关了窗口。
  // 默认浏览器那种兜底没有这个语义（父进程会立刻退出），所以只在应用模式下等。
  if (!usingDefaultBrowser) {
    console.log('[launch] 窗口已打开。关闭该窗口即退出本程序。');
    child.once('exit', async () => {
      await shutdown();
      process.exit(0);
    });
    return;
  }

  console.log(`[launch] 已在默认浏览器打开 ${actualUrl}`);
  console.log('[launch] 该方式无法感知窗口关闭，服务器将保持运行；按 Ctrl+C 停止。');
  process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
}

main().catch((e) => {
  console.error('[launch] 启动器自身出错:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
