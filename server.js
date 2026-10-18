/**
 * 本地 HTTP 服务器 —— 新一代日戳管理系统
 * ==========================================
 * 本文件是从 main.js 平移出来的「与应用外壳无关」的服务端：
 *   - 静态文件（index.html / js / css / geo / 前端库）
 *   - /base/* 与 /output/* 的受控文件映射
 *   - /api/crawl/* 爬虫作业接口
 *
 * 设计要点
 * --------
 * 1. 本文件**不 require('electron')**，因此同一份代码可以被：
 *      - launch.js（Node 直接跑，系统浏览器当窗口）
 *      - main.js（Electron 外壳，可选）
 *      - node server.js（纯命令行，排错用）
 *    三者共用，不会出现两套服务器逻辑各自演化。
 *
 * 2. 所有路径都以显式传入的 root 为基准，不再依赖 __dirname 的巧合位置。
 *    root 由调用方给出（Electron 传 __dirname，Node 传项目根），
 *    这样打包成 asar 时路径依然正确。
 *
 * 3. 端口保持固定（默认 19876）。Local Storage 按 origin 隔离，
 *    端口一变就等于换了一份数据 —— 因此**任何情况下都不要随机端口**，
 *    宁可启动失败让用户看到，也不要静默换端口把记录"变没"。
 *
 * CLI: node server.js [--port=19876] [--host=127.0.0.1] [--root=<目录>]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFileSync } = require('child_process');

const CrawlerEngine = require('./crawler-engine');
const ImgExport = require('./img-export');

// ---- 常量 ----
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19876;

/**
 * 需要放行 POST 的接口前缀（其余一律只读）。
 * /api/images/save 是「录入日戳 → 上传图片」的落盘入口：渲染层没有 Node 权限，
 * 编码好的图片只能通过它交给服务端写盘。
 */
const POST_ROUTES = [
  '/api/crawl/start', '/api/crawl/cancel',
  '/api/images/save', '/api/images/delete',
];

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
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ---- 控制台编码 ----
// 中文 Windows 的控制台代码页是 GBK(936)，而 Node 写出去的是裸 UTF-8 字节，
// 中文日志会变成乱码。这里在写出前把文本转成控制台使用的代码页。
// 设置 POSTMARK_CONSOLE_ENCODING=utf-8 可关闭本处理。
const CONSOLE_ENCODINGS = { 936: 'gbk', 54936: 'gb18030' };

function setupConsoleEncoding() {
  if (process.platform !== 'win32') return;
  if (process.stdout.isTTY) return;                    // TTY 由 Node 自己写，已是正确显示
  if (String(process.env.POSTMARK_CONSOLE_ENCODING).toLowerCase() === 'utf-8') return;

  let iconv;
  try { iconv = require('iconv-lite'); } catch (e) { return; }  // 没装依赖就保持原样

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

  // 代码页装不下中文时（例如英文系统的 437）宁可保持 UTF-8，免得整成乱码
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

// ---- 目录解析 ----
// root 是应用根目录（静态文件与 base/ 的所在处）。
// packagedExeDir 仅在 Electron 打包版传入：便携版/安装版允许把 base/ 与 output/
// 放在 exe 同级，用户替换 CSV 即可更新参考数据，无需重新打包。

/**
 * 创建一份目录解析器。返回的函数都绑定到同一个 root，
 * 避免各处散落的 __dirname 让打包后的路径失配。
 */
function createPaths(opts) {
  const root = path.resolve(opts.root);
  const packagedExeDir = opts.packagedExeDir || '';
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
  // 外壳（Tauri / Electron）可以显式指定产出目录。打包安装后应用目录是只读的，
  // 产出必须落到用户可写的数据目录，否则爬取作业会因目录不可写而静默失败。
  const envOutputDir = process.env.POSTMARK_OUTPUT_DIR || '';

  /**
   * base 网点数据目录（只读参考数据）。
   * 查找顺序：便携版 exe 同级 → 安装版 exe 同级 → 打包内置的兜底副本。
   * 外部目录优先，因此用户换掉 exe 旁的 CSV 就能更新数据。
   */
  function resolveBaseDir() {
    const candidates = [];
    if (portableDir) candidates.push(path.join(portableDir, 'base'));
    if (packagedExeDir) candidates.push(path.join(packagedExeDir, 'base'));
    candidates.push(path.join(root, 'base'));

    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir)) return dir;
      } catch (e) {
        // 该候选不可访问，继续下一个
      }
    }
    return path.join(root, 'base');
  }

  /**
   * 爬虫产出目录（必须可写）。
   * base/ 是只读参考数据，爬取结果必须写到可写目录。
   * 查找顺序：外壳显式指定 → 便携版 exe 同级 → 安装版 exe 同级 → 项目目录。
   * 前两个是"用户能直接取到 CSV"的位置，后者是开发期兜底。
   */
  function resolveOutputDir() {
    const candidates = [];
    if (envOutputDir) candidates.push(envOutputDir);
    if (portableDir) candidates.push(path.join(portableDir, 'output'));
    if (packagedExeDir) candidates.push(path.join(packagedExeDir, 'output'));
    candidates.push(path.join(root, 'output'));

    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      } catch (e) {
        // 不可创建或不可写，继续下一个
      }
    }
    return path.join(root, 'output');
  }

  /**
   * 对比工具 txt_compare.exe 的候选路径。
   * 打包后 exe 可能位于 app.asar 内而无法直接 spawn，
   * engine 内部会自行改写为 app.asar.unpacked。
   */
  function compareExeCandidates() {
    const list = [];
    const push = (dir) => { if (dir) list.push(path.join(dir, 'txt_compare.exe')); };
    if (portableDir) push(portableDir);
    if (packagedExeDir) push(packagedExeDir);
    push(root);
    return list;
  }

  /**
   * 图片保存目录（必须可写）。
   * 默认落在产出目录下的 images/，与爬虫产出共用同一个可写位置；
   * 用 POSTMARK_IMAGES_DIR 可以显式指到任意目录（例如 D:\ApplicationData\Images）。
   * 具体解析、创建与存在性检查都交给 img-export.js，这里只把 outputDir 传下去并缓存结果。
   */
  let imagesDirCache = '';
  function resolveImagesDir() {
    if (imagesDirCache) return imagesDirCache;
    imagesDirCache = ImgExport.configure({ outputDir: resolveOutputDir() }).imagesDir;
    return imagesDirCache;
  }

  return { root, resolveBaseDir, resolveOutputDir, resolveImagesDir, compareExeCandidates };
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
// maxBytes 可按路由放宽：图片走 base64 传输，1 MiB 的默认上限连一张手机照都装不下。
function readJsonBody(req, maxBytes) {
  const limit = maxBytes || MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`请求体过大（上限 ${Math.round(limit / 1048576)} MB）`);
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

/** 列出目录下的 CSV（name/size/mtime），目录不可读时返回空数组 */
function listCsv(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error('[Postmark] 读取目录失败:', dir, e);
    return [];
  }
}

/**
 * 处理一次请求。抽成独立函数是为了让 createServer 保持简短，
 * 也方便将来单独测路由。
 */
function createRequestHandler(paths) {
  const { root, resolveBaseDir, resolveOutputDir, resolveImagesDir } = paths;

  return async function handleRequest(req, res) {
    // 解析路径 (去掉 query string + URL 解码)
    const qIndex = req.url.indexOf('?');
    const query = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex + 1) : '');
    let urlPath = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url;
    try { urlPath = decodeURIComponent(urlPath); } catch (e) { /* 保留原始路径 */ }

    // 方法的限制：作业与图片接口放行 POST，其余一律 GET
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

    // ---------- 图片接口（录入日戳 → 上传图片） ----------
    // 渲染层负责解码/裁剪/旋转/增强并编码，服务端只负责「校验 + 落到正确的位置」。
    if (urlPath.startsWith('/api/images/')) {
      try {
        const info = ImgExport.getInfo();

        // 配置与目录信息（前端用它显示「保存位置」）
        if (urlPath === '/api/images/config') {
          return sendJson(res, 200, {
            imagesDir: info.imagesDir,
            custom: info.custom,
            maxFileBytes: info.maxFileBytes,
            unfiledDir: info.unfiledDir,
          });
        }

        // 重名检测: ?name=&subdir=
        if (urlPath === '/api/images/exists') {
          const name = query.get('name') || '';
          const subdir = query.get('subdir') || '';
          if (!name) return sendJson(res, 400, { error: '缺少 name 参数' });
          const hit = ImgExport.exists(name, subdir);
          return sendJson(res, 200, {
            exists: hit.exists,
            fileName: hit.relPath.split('/').pop(),
            relPath: hit.relPath,
            size: hit.size,
          });
        }

        // 图片列表: ?subdir=&limit=
        if (urlPath === '/api/images/list') {
          const files = ImgExport.list({
            subdir: query.get('subdir') || '',
            limit: Number(query.get('limit')) || 500,
          });
          return sendJson(res, 200, { imagesDir: info.imagesDir, files });
        }

        // 保存: body { dataUrl, fileName, subdir, conflict }
        if (urlPath === '/api/images/save') {
          const body = await readJsonBody(req, info.maxUploadBytes);
          const result = ImgExport.save({
            dataUrl: body.dataUrl,
            fileName: body.fileName,
            subdir: body.subdir,
            conflict: body.conflict,
          });
          return sendJson(res, 200, {
            ok: true,
            imagesDir: info.imagesDir,
            relPath: result.relPath,
            fileName: result.fileName,
            size: result.size,
            renamed: result.renamed,
            overwritten: result.overwritten,
          });
        }

        // 删除: body { fileName, subdir }
        if (urlPath === '/api/images/delete') {
          const body = await readJsonBody(req);
          const result = ImgExport.remove(body.fileName, body.subdir);
          return sendJson(res, 200, { ok: true, deleted: result.deleted, relPath: result.relPath });
        }

        res.writeHead(404);
        return res.end('Not Found');
      } catch (e) {
        const status = e.statusCode || 500;
        if (status >= 500) console.error('[Postmark] 图片接口异常:', e);
        return sendJson(res, status, {
          error: e.message || String(e),
          conflict: Boolean(e.conflict),
          fileName: e.fileName || '',
        });
      }
    }

    // 产出目录文件列表（镜像 /api/base-files）
    if (urlPath === '/api/output-files') {
      return sendJson(res, 200, listCsv(resolveOutputDir()));
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

    // 已保存图片: /images/<子目录>/<文件名> 映射到解析后的图片目录
    if (urlPath.startsWith('/images/')) {
      const imgDir = path.resolve(resolveImagesDir());
      const target = path.resolve(imgDir, urlPath.slice('/images/'.length));
      if (target !== imgDir && !target.startsWith(imgDir + path.sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      return sendFile(res, target);
    }

    // API: 列出 base 目录下的网点 CSV 文件
    if (urlPath === '/api/base-files') {
      return sendJson(res, 200, listCsv(resolveBaseDir()));
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
    let filePath = path.join(root, safePath === '/' ? 'index.html' : safePath);

    // 检查文件是否在项目目录内
    // 注意：这里沿用 main.js 原有的 startsWith 判断，不做更严格的收紧 ——
    // 绝对路径（/foo）与 `..`（normalize 后为 /<root>/..，已不在 root 之下）都已被拦，
    // 改动这段只会引入行为漂移，不会增加实际安全性。
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(root))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    // 如果是目录，尝试 index.html
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      filePath = path.join(resolved, 'index.html');
    }

    sendFile(res, filePath);
  };
}

/**
 * 创建（但不启动）HTTP 服务器。
 * @param {{root?:string, packagedExeDir?:string}} [opts]
 */
function createServer(opts) {
  const options = opts || {};
  const root = options.root || path.join(__dirname);
  const paths = createPaths({ root, packagedExeDir: options.packagedExeDir });

  // 爬虫引擎的目录配置（必须在任何爬虫接口被调用前注入）
  CrawlerEngine.configure({
    outputDir: paths.resolveOutputDir(),
    baseDir: paths.resolveBaseDir(),
    compareExeCandidates: paths.compareExeCandidates(),
  });

  // 图片目录配置（必须在任何 /api/images/* 被调用前注入）
  paths.resolveImagesDir();

  const server = http.createServer(createRequestHandler(paths));
  server.__postmarkPaths = paths;              // 供测试脚本检查解析结果
  return server;
}

/**
 * 启动服务器。
 * @param {{root?:string, packagedExeDir?:string, host?:string, port?:number,
 *          onListening?:function}} [opts]
 * @returns {Promise<{server:http.Server, port:number, host:string, root:string, paths:object}>}
 */
function start(opts) {
  const options = opts || {};
  const host = options.host || DEFAULT_HOST;
  const port = options.port === undefined ? DEFAULT_PORT : options.port;

  return new Promise((resolve, reject) => {
    const server = createServer(options);

    // 端口被占用时**不切换到随机端口**：Local Storage 按 origin 隔离，
    // 换端口等于换一份数据，用户会以为记录丢了。这里直接报错，由调用方决定怎么办。
    server.once('error', (err) => {
      server.removeAllListeners('error');
      reject(err);
    });

    server.listen(port, host, () => {
      const actual = server.address().port;
      server.removeAllListeners('error');
      resolve({
        server,
        port: actual,
        host,
        root: server.__postmarkPaths.root,
        paths: server.__postmarkPaths,
      });
      if (typeof options.onListening === 'function') options.onListening(actual);
    });
  });
}

/** 停止服务器（未启动时静默返回） */
function stop(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch (e) {
      resolve();
    }
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  setupConsoleEncoding,
  createServer,
  start,
  stop,
  // 供测试/复用
  createPaths,
  MIME,
};

// ---- CLI 直跑：node server.js ----
if (require.main === module) {
  setupConsoleEncoding();

  const argv = process.argv.slice(2);
  const readArg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };

  const host = readArg('host') || process.env.POSTMARK_HOST || DEFAULT_HOST;
  const portArg = readArg('port') || process.env.POSTMARK_PORT;
  const port = portArg ? Number(portArg) : DEFAULT_PORT;
  const root = readArg('root') || path.join(__dirname);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[Postmark] 端口不合法: ${portArg}`);
    process.exit(1);
  }

  start({ root, host, port }).then(({ server, port: actual }) => {
    console.log('============================================================');
    console.log(` 新一代日戳管理系统 — 本地服务器`);
    console.log(` 根目录: ${root}`);
    console.log(` 地址  : http://${host}:${actual}`);
    console.log(' 按 Ctrl+C 停止');
    console.log('============================================================');

    const shutdown = () => {
      stop(server).then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[Postmark] 端口 ${port} 已被占用。`);
      console.error('           若已有本应用在运行，直接打开上面的地址即可；');
      console.error('           否则请先关闭它，或用 --port=<其它端口> 启动（注意：');
      console.error('           换端口会使浏览器里的既有记录不可见）。');
    } else {
      console.error('[Postmark] 启动失败:', err && err.message ? err.message : err);
    }
    process.exit(1);
  });
}
