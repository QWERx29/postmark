/**
 * Electron 外壳 — 新一代日戳管理系统
 * ====================================
 * 本文件只做「外壳」的事：开一个窗口，把本地服务器指向它。
 * 服务器与爬虫接口都在 server.js（纯 Node，不依赖 electron），
 * launch.js 用系统浏览器当窗口时跑的是同一份代码。
 *
 * 因此：改服务器逻辑请改 server.js，不要在这里加路由。
 *
 * 启动自检报告
 * ------------
 * npm start 由 scripts/start.js 包装：受限环境里 Chromium 可能"进程活着但窗口永远不显示"，
 * 只靠进程存活判断不出来。包装脚本会设置 POSTMARK_STARTUP_REPORT 指向一个文件，
 * 本进程在关键节点把状态写进去，包装脚本据此决定是否需要换启动参数重试。
 * 未设置该变量时（例如打包版、npm run start:electron）本功能完全不参与。
 */

'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const Server = require('./server');

Server.setupConsoleEncoding();

// ---- 启动自检报告 ----
const STARTUP_REPORT = process.env.POSTMARK_STARTUP_REPORT || '';

function reportStartup(phase, extra) {
  if (!STARTUP_REPORT) return;
  try {
    fs.writeFileSync(STARTUP_REPORT, JSON.stringify(Object.assign({
      phase, pid: process.pid, at: Date.now(),
    }, extra || {})));
  } catch (e) { /* 报告写不出去不影响应用本身 */ }
}

reportStartup('boot');

// ---- 运行期状态 ----
const HOST = Server.DEFAULT_HOST;
let PORT = 0;                 // startServer() 成功后填入实际端口
let server = null;            // http.Server 实例

// ---- 启动本地服务器 ----
// root 用 __dirname：打包进 asar 后它仍是应用根，静态文件与 base/ 都在其下。
// 打包版额外把 exe 所在目录传进去，便携版/安装版可优先使用 exe 同级的 base/ 与 output/。
async function startServer() {
  const packagedExeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : '';
  const started = await Server.start({
    root: __dirname,
    packagedExeDir,
    host: HOST,
    port: Server.DEFAULT_PORT,
  });

  server = started.server;
  PORT = started.port;
  console.log(`[Postmark] 本地服务器已启动: http://${HOST}:${PORT}`);
  reportStartup('server', { port: PORT });
}

function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  try { s.close(); } catch (e) { /* 已关闭 */ }
  console.log('[Postmark] 服务器已停止');
}

// ---- 创建窗口 ----
function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '新一代日戳管理系统',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 禁止菜单栏
  win.setMenuBarVisibility(false);

  // 就绪后再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show();
    // 回执只在窗口"真的可见"时才给：受限会话里 ready-to-show 也可能触发而窗口出不来，
    // 那样 npm start 的包装脚本会把"没窗口"误判成成功。
    const confirmShown = () => {
      if (win.isVisible()) reportStartup('shown', { port: PORT, title: win.getTitle() });
    };
    confirmShown();
    setTimeout(confirmShown, 500);
    setTimeout(() => {
      if (!win.isVisible()) reportStartup('error', { reason: 'ready-to-show 已触发但窗口不可见' });
    }, 1600);
  });

  // 页面/渲染进程出问题时上报，包装脚本可据此立刻换参数重试（而不是干等超时）
  win.webContents.on('did-fail-load', (e, code, desc) => {
    reportStartup('error', { reason: `did-fail-load ${code} ${desc}` });
  });
  win.webContents.on('render-process-gone', (e, details) => {
    reportStartup('error', { reason: `render-process-gone ${details && details.reason}` });
  });

  // 外部链接用系统默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.loadURL(`http://${HOST}:${PORT}`);

  return win;
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    // 端口被占用是最常见的失败：不要静默换端口（换端口等于换 origin，
    // 浏览器里的既有记录会"消失"），直接把情况告诉用户。
    const busy = err && err.code === 'EADDRINUSE';
    const msg = busy
      ? `端口 ${Server.DEFAULT_PORT} 已被占用。\n\n`
        + '如果本应用已经在运行，请直接使用那个窗口；\n'
        + `否则请关闭占用该端口的程序后重试。`
      : `本地服务器启动失败：\n${err && err.message ? err.message : err}`;
    console.error('[Postmark]', msg);
    reportStartup('error', { reason: busy ? 'EADDRINUSE' : String(err && err.message) });
    try { dialog.showErrorBox('新一代日戳管理系统 — 启动失败', msg); } catch (e) { /* 无 GUI 时忽略 */ }
    app.exit(1);
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', () => {
  stopServer();
});
