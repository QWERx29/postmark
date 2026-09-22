/**
 * Electron 主进程 — 新一代日戳管理系统
 * ======================================
 * 内置轻量 HTTP 静态文件服务器，避免 file:// 协议的跨域限制。
 * 应用关闭时自动停止服务器。
 */

const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFileSync } = require('child_process');
const iconv = require('iconv-lite');

const CrawlerEngine = require('./crawler-engine');

// ---- 控制台编码 ----
// 调试时终端里的中文全是乱码：Electron 主进程的 stdout 不是 TTY，写出去的是裸
// UTF-8 字节，而中文版 Windows 的控制台代码页是 GBK(936)，两者对不上。
// 在 Electron 内部既读不到也改不了控制台代码页（child_process 派生出的进程拿到
// 的是全新的隐藏控制台，chcp 只会报系统默认值），所以只能在写出前把文本转成控制台
// 使用的代码页。脚本在 node 下运行时走的是 Node 自己的 TTY 通道，不在此列。
// 设置 POSTMARK_CONSOLE_ENCODING=utf-8 可关闭本处理。
const CONSOLE_ENCODINGS = { 936: 'gbk', 54936: 'gb18030' };

function setupConsoleEncoding() {
  if (process.platform !== 'win32' || !process.versions.electron) return;
  if (process.stdout.isTTY) return;                    // TTY 由 Node 自己写，已是正确显示
  if (String(process.env.POSTMARK_CONSOLE_ENCODING).toLowerCase() === 'utf-8') return;

  // 派生进程拿到的是系统默认控制台，其代码页即交互式终端通常使用的那个
  let codePage = 0;
  try {
    const raw = execFileSync('cmd.exe', ['/c', 'chcp'], {
      windowsHide: true, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'],
    });
    // chcp 的输出本身也按该代码页编码，只有数字是 ASCII，从 latin1 里取即可
    const m = /:\s*(\d+)/.exec(raw.toString('latin1'));
    codePage = m ? Number(m[1]) : 0;
  } catch (e) {
    return;                                            // 取不到代码页：保持原样
  }

  const encoding = CONSOLE_ENCODINGS[codePage];
  if (!encoding) return;

  // 代码页装不下中文时（例如英文系统的 437）宁可保持 UTF-8，免得整成问号
  const probe = '中文日志';
  if (iconv.decode(iconv.encode(probe, encoding), encoding) !== probe) return;

  const patch = (level, stream) => {
    console[level] = (...args) => {
      stream.write(iconv.encode(util.format(...args) + '\n', encoding));
    };
  };
  patch('log', process.stdout);
  patch('info', process.stdout);
  patch('warn', process.stderr);
  patch('error', process.stderr);
}

setupConsoleEncoding();

// ---- 常量 ----
const HOST = '127.0.0.1';
const PREFERRED_PORT = 19876;
let PORT = PREFERRED_PORT;
let server = null;

/** 需要放行 POST 的接口前缀（其余一律只读） */
const POST_ROUTES = ['/api/crawl/start', '/api/crawl/cancel'];

/** 请求体大小上限，防止异常客户端撑爆内存 */
const MAX_BODY_BYTES = 1024 * 1024;

// ---- MIME 类型映射 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ---- base 网点数据目录 ----
// 查找顺序:
//   1. exe 同级的 base/        便携版: PORTABLE_EXECUTABLE_DIR；安装版: exe 所在目录
//   2. 打包内置的 base/        app.asar 内的兜底副本
// 外部目录优先，因此用户替换 exe 旁的 CSV 即可更新参考数据，无需重新打包。
function resolveBaseDir() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'base'));
  }
  try {
    candidates.push(path.join(path.dirname(app.getPath('exe')), 'base'));
  } catch (e) {
    // 个别环境下取不到 exe 路径，忽略这一候选
  }
  candidates.push(path.join(__dirname, 'base'));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch (e) {
      // 该候选不可访问，继续下一个
    }
  }
  return path.join(__dirname, 'base');
}

// ---- 爬虫产出目录 ----
// base/ 是只读参考数据，爬取结果必须写到 app.asar 之外的可写目录。
// 优先级与 base 一致（exe 同级优先，用户能直接取到 CSV），
// 但候选目录不存在时尝试创建；都不可写则回退到项目目录。
function resolveOutputDir() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'output'));
  }
  // 只有打包后 exe 同级目录才是用户可见、可写的目标。
  // 开发模式下 app.getPath('exe') 指向 node_modules/electron/dist，
  // 会把产出藏进依赖目录里，因此跳过该候选。
  if (app.isPackaged) {
    try {
      candidates.push(path.join(path.dirname(app.getPath('exe')), 'output'));
    } catch (e) {
      // 个别环境下取不到 exe 路径，忽略这一候选
    }
  }
  candidates.push(path.join(__dirname, 'output'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      // 不可创建或不可写，继续下一个
    }
  }
  return path.join(__dirname, 'output');
}

// ---- 对比工具 txt_compare.exe 的候选路径 ----
// 打包后 exe 位于 app.asar 内，无法直接 spawn，
// 需 asarUnpack 到 app.asar.unpacked（engine 内部会自动改写路径）。
function compareExeCandidates() {
  const list = [];
  const push = (dir) => { if (dir) list.push(path.join(dir, 'txt_compare.exe')); };

  if (process.env.PORTABLE_EXECUTABLE_DIR) push(process.env.PORTABLE_EXECUTABLE_DIR);
  if (app.isPackaged) {
    try {
      push(path.dirname(app.getPath('exe')));
    } catch (e) {
      // 忽略
    }
  }
  push(__dirname);
  return list;
}

// ---- 静态文件响应 ----
function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        res.writeHead(404);
        return res.end('Not Found');
      }
      res.writeHead(500);
      return res.end('Internal Server Error');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- 工具：读取并解析 JSON 请求体 ----
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        // 客户端发来的数据有误，属于 400 而非服务端故障
        const err = new Error('请求体不是合法 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---- 静态文件服务器 ----
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      // 解析路径 (去掉 query string + URL 解码)
      const qIndex = req.url.indexOf('?');
      const query = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex + 1) : '');
      let urlPath = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url;
      try { urlPath = decodeURIComponent(urlPath); } catch (e) { /* 保留原始路径 */ }

      // 方法的限制：爬虫接口放行 POST，其余一律 GET
      const allowPost = POST_ROUTES.includes(urlPath);
      if (req.method !== 'GET' && !(allowPost && req.method === 'POST')) {
        res.writeHead(405);
        return res.end('Method Not Allowed');
      }

      // ---------- 爬虫接口 ----------
      if (urlPath.startsWith('/api/crawl/')) {
        try {
          // 省份表（供 UI 多选）
          if (urlPath === '/api/crawl/provinces') {
            return sendJson(res, 200, CrawlerEngine.PROVINCES);
          }

          // 启动作业: body { kind: 'crawl'|'compare'|'apply-base'|'cross', ... }
          if (urlPath === '/api/crawl/start') {
            const body = await readJsonBody(req);
            const kind = body.kind || 'crawl';

            // 同一类型不并发，避免两个爬取互相抢占（不同省之间的请求频率翻倍）
            if (CrawlerEngine.hasRunningJob(kind)) {
              return sendJson(res, 409, {
                error: `已有同类作业正在运行，请等待其结束或先取消`,
              });
            }

            let job;
            if (kind === 'crawl') {
              job = CrawlerEngine.startCrawl(body);
            } else if (kind === 'compare') {
              job = CrawlerEngine.startCompare();
            } else if (kind === 'apply-base') {
              job = CrawlerEngine.applyBase();
            } else if (kind === 'cross') {
              job = CrawlerEngine.startCrossCompare(body);
            } else {
              return sendJson(res, 400, { error: `未知的作业类型: ${kind}` });
            }

            return sendJson(res, 200, { jobId: job.id, kind });
          }

          // 轮询状态: ?job=<id>&cursor=<n>
          if (urlPath === '/api/crawl/status') {
            const jobId = query.get('job');
            const cursor = Number(query.get('cursor')) || 0;
            const status = CrawlerEngine.getStatus(jobId, cursor);
            if (!status) return sendJson(res, 404, { error: '作业不存在或已过期' });
            return sendJson(res, 200, status);
          }

          // 取消作业: body { job: <id> }
          if (urlPath === '/api/crawl/cancel') {
            const body = await readJsonBody(req);
            const ok = CrawlerEngine.cancel(body.job);
            return sendJson(res, 200, { cancelled: ok });
          }

          res.writeHead(404);
          return res.end('Not Found');
        } catch (e) {
          const status = e.statusCode || 500;
          if (status >= 500) console.error('[Postmark] 爬虫接口异常:', e);
          return sendJson(res, status, { error: e.message || String(e) });
        }
      }

      // 产出目录文件列表（镜像 /api/base-files）
      if (urlPath === '/api/output-files') {
        const outDir = resolveOutputDir();
        let files = [];
        try {
          if (fs.existsSync(outDir)) {
            files = fs.readdirSync(outDir)
              .filter((f) => f.toLowerCase().endsWith('.csv'))
              .map((f) => {
                const st = fs.statSync(path.join(outDir, f));
                return { name: f, size: st.size, mtime: st.mtimeMs };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
          }
        } catch (e) {
          console.error('[Postmark] 读取 output 目录失败:', e);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(files));
      }

      // 爬取产出 CSV: /output/* 映射到解析后的可写目录
      if (urlPath.startsWith('/output/')) {
        const outDir = path.resolve(resolveOutputDir());
        const target = path.resolve(outDir, urlPath.slice('/output/'.length));
        if (!target.startsWith(outDir + path.sep)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        return sendFile(res, target);
      }

      // API: 列出 base 目录下的网点 CSV 文件
      if (urlPath === '/api/base-files') {
        const baseDir = resolveBaseDir();
        let files = [];
        try {
          if (fs.existsSync(baseDir)) {
            files = fs.readdirSync(baseDir)
              .filter((f) => f.toLowerCase().endsWith('.csv'))
              .map((f) => {
                const st = fs.statSync(path.join(baseDir, f));
                return { name: f, size: st.size, mtime: st.mtimeMs };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
          }
        } catch (e) {
          console.error('[Postmark] 读取 base 目录失败:', e);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(files));
      }

      // 网点 CSV: /base/* 映射到解析后的 base 目录 (可能位于 exe 同级，而非项目目录内)
      if (urlPath.startsWith('/base/')) {
        const baseDir = path.resolve(resolveBaseDir());
        const target = path.resolve(baseDir, urlPath.slice('/base/'.length));
        if (!target.startsWith(baseDir + path.sep)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        return sendFile(res, target);
      }

      const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
      let filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);

      // 检查文件是否在项目目录内
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(__dirname))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      // 如果是目录，尝试 index.html
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        filePath = path.join(resolved, 'index.html');
      }

      sendFile(res, filePath);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Postmark] 端口 ${PORT} 被占用，尝试随机端口...`);
        PORT = 0;
        server.close();
        server.listen(PORT, HOST);
      }
    });

    server.listen(PORT, HOST, () => {
      PORT = server.address().port;
      console.log(`[Postmark] 本地服务器已启动: http://${HOST}:${PORT}`);
      resolve();
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
    console.log('[Postmark] 服务器已停止');
  }
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
  // 爬虫引擎的目录配置（必须在任何爬虫接口被调用前注入）
  CrawlerEngine.configure({
    outputDir: resolveOutputDir(),
    baseDir: resolveBaseDir(),
    compareExeCandidates: compareExeCandidates(),
  });

  await startServer();
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
