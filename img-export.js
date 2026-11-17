/**
 * 图片导出 — 文件系统边界（服务端）
 * ==================================
 * 本文件是「录入日戳 → 上传图片」功能里**唯一**碰文件系统的地方。
 *
 * 为什么在服务端而不是 Electron 主进程
 * ------------------------------------
 * 本应用的外壳有三种：Electron（main.js）、系统浏览器（launch.js）、纯 Node（server.js）。
 * 渲染层（js/*）只用 fetch 和 localStorage，从不 require('electron') —— 这是
 * launch.js 能拿浏览器当窗口的前提。所以「图片落盘」这件事只能由渲染层通过
 * HTTP 交给本地服务器做，放在 Electron preload/IPC 里会让浏览器模式直接失去该功能。
 *
 * 设计稿第 15 节要求「文件系统操作与渲染层 UI 解耦」——本文件正是那条边界：
 *   渲染层   : 编辑参数、预览、编码（canvas）
 *   本模块   : 目录、命名清洗（兜底）、存在性检查、原子写入、删除
 *
 * 安全约定
 * --------
 *   1. 所有路径都必须落在 imagesDir 之内（resolvePath 强制校验），
 *      文件名只取 basename，杜绝 ../ 穿越；
 *   2. 写入前校验图片魔数，拒绝扩展名与实际内容不符的数据；
 *   3. 先写 .part 临时文件 → 校验大小 → rename 原子替换，
 *      任何一步失败都不会在目标目录留下「看似成功」的半截文件（设计稿第 18 节）。
 *
 * 目录结构
 * --------
 *   images/                        ← 默认根目录（项目根下的 images/，可用 POSTMARK_IMAGES_DIR 覆盖）
 *   ├── <记录ID>/                  ← 同一条日戳记录的图片
 *   │   ├── 10000123_2026093015_中南海邮政支局_01.jpg
 *   │   └── 10000123_2026093015_中南海邮政支局_02.jpg
 *   └── _unfiled/                  ← 尚未保存记录时上传的图片
 *
 * 旧目录兼容
 * ----------
 *   1.1 及更早版本把图片放在 output/images/。升级后默认目录变成 <项目根>/images/，
 *   旧文件仍会被读取（exists / list / /images/* 都有回退），并可在「数据安全 →
 *   图片管理」里一键迁移到新目录。备份包同时包含两个目录的图片。
 *
 * 用法
 * ----
 *   const out = ImgExport.configure({ rootDir, outputDir, legacyDir });
 *   ImgExport.exists('10000123_2026093015_中南海邮政支局_01.jpg', recId);
 *   ImgExport.save({ dataUrl, fileName, subdir, conflict: 'error'|'overwrite'|'rename' });
 *   ImgExport.list({ subdir });
 *   ImgExport.listAll();                 // 递归全量（图片管理 / 孤儿治理）
 *   ImgExport.remove('xxx.jpg', recId);
 *   ImgExport.removePath('k3f9a2/xxx.jpg', { legacy: false });
 *   ImgExport.migrateLegacy({ overwrite: false });
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 命名与扩展名规则与渲染层共用同一份实现（js/img-naming.js）。
// 服务端这一遍清洗是兜底：前端已经清洗过，但 HTTP 接口可以被直接调用。
const ImgNaming = require('./js/img-naming.js');

// ============================================================
// 常量
// ============================================================

/** 文件大小上限（与前端 image.js 的 MAX_FILE_BYTES 保持一致） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 单次请求体上限：base64 会让体积膨胀约 4/3，再留一点余量 */
const MAX_UPLOAD_BYTES = Math.ceil(MAX_FILE_BYTES * 4 / 3) + (2 * 1024 * 1024);

/** 未关联记录时的子目录名 */
const UNFILED_DIR = ImgNaming.UNFILED_DIR;

/** 允许的扩展名 → 内容魔数校验函数（buf 至少 12 字节） */
const SIGNATURES = {
  '.jpg': (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.jpeg': (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.jfif': (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.jpe': (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  '.webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.bmp': (b) => b[0] === 0x42 && b[1] === 0x4D,
};

/** MIME → 扩展名（前端不带扩展名时兜底） */
const MIME_EXT = ImgNaming.MIME_EXT;

// ============================================================
// 模块状态
// ============================================================

let _imagesDir = '';
let _legacyDir = '';        // 旧版目录（output/images），只读回退 + 可迁移
let _customDir = false;      // 是否由环境变量显式指定（用于前端提示）

/**
 * 解析并（尝试）创建图片根目录。
 * 查找顺序：环境变量 POSTMARK_IMAGES_DIR → <rootDir>/images → <outputDir>/images
 * @param {{rootDir?:string, outputDir?:string}} opts
 * @returns {string} 最终使用的目录（可能是「创建失败」的候选目录）
 */
function resolveImagesDir(opts) {
  const envDir = process.env.POSTMARK_IMAGES_DIR || '';
  const candidates = [];
  if (envDir) candidates.push(path.resolve(envDir));
  if (opts && opts.rootDir) candidates.push(path.join(path.resolve(opts.rootDir), 'images'));
  if (opts && opts.outputDir) candidates.push(path.join(opts.outputDir, 'images'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      // 不可创建或不可写，继续下一个候选
    }
  }
  return candidates[candidates.length - 1] || path.join(process.cwd(), 'images');
}

/**
 * 注入目录配置。必须在任何图片接口被调用前执行一次。
 * @param {{rootDir?:string, outputDir?:string, imagesDir?:string, legacyDir?:string}} opts
 */
function configure(opts) {
  const o = opts || {};
  const envDir = process.env.POSTMARK_IMAGES_DIR || '';
  const imagesDir = o.imagesDir
    ? path.resolve(o.imagesDir)
    : resolveImagesDir({ rootDir: o.rootDir, outputDir: o.outputDir });

  _imagesDir = imagesDir;
  _customDir = Boolean(envDir || o.imagesDir);

  // 旧目录只在「确实不是当前目录」时才启用，否则会把同一个目录读两遍
  const legacy = o.legacyDir
    ? path.resolve(o.legacyDir)
    : (o.outputDir ? path.join(path.resolve(o.outputDir), 'images') : '');
  _legacyDir = legacy && path.resolve(legacy) !== path.resolve(_imagesDir) ? legacy : '';

  try {
    fs.mkdirSync(_imagesDir, { recursive: true });
  } catch (e) {
    // 创建失败不抛：写盘时会给出明确错误，前端能显示「请选择其他目录」
  }

  return { imagesDir: _imagesDir, legacyDir: _legacyDir, custom: _customDir };
}

function getImagesDir() {
  if (!_imagesDir) configure({});
  return _imagesDir;
}

/** 旧版图片目录（output/images）；没有或与当前目录相同时返回 '' */
function getLegacyDir() {
  return _legacyDir;
}

function getInfo() {
  return {
    imagesDir: getImagesDir(),
    legacyDir: _legacyDir,
    legacyExists: Boolean(_legacyDir && fs.existsSync(_legacyDir)),
    custom: _customDir,
    maxFileBytes: MAX_FILE_BYTES,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    unfiledDir: UNFILED_DIR,
  };
}

// ============================================================
// 路径与文件名
// ============================================================

/**
 * 清洗单个路径片段（子目录名）。规则来自共享模块 js/img-naming.js。
 */
function sanitizeSegment(seg) {
  return ImgNaming.sanitizeSegment(seg);
}

/**
 * 清洗文件名（主名与扩展名分开处理 —— 设计稿第 12.2 节）。
 * @param {string} name 用户/前端给出的文件名
 * @param {string} [mimeType] 扩展名不可信时按 MIME 兜底
 * @returns {string} 清洗后的完整文件名
 */
function sanitizeFileName(name, mimeType) {
  return ImgNaming.sanitizeFileName(name, { mimeType });
}

/**
 * 把「子目录 + 文件名」解析为绝对路径，并强制其落在 imagesDir 之内。
 * @throws {Error} 越界或文件名非法
 */
function resolvePath(fileName, subdir) {
  const root = path.resolve(getImagesDir());
  const seg = subdir ? sanitizeSegment(subdir) : '';
  const dir = seg ? path.join(root, seg) : root;
  const base = path.basename(String(fileName == null ? '' : fileName));

  if (!base || base === '.' || base === '..') {
    const err = new Error('文件名不合法');
    err.statusCode = 400;
    throw err;
  }

  const target = path.resolve(dir, base);
  // 越界校验：必须以 root + 分隔符 开头（root 自身下的文件也允许，故额外判等）
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error('目标路径越界');
    err.statusCode = 403;
    throw err;
  }
  return { dir, target, fileName: base };
}

/**
 * 相对 imagesDir 的相对路径（存进记录里的就是它），用 / 分隔。
 * @returns {string} 例如 "k3f9a2/10000123_2026093015_中南海邮政支局_01.jpg"
 */
function toRelPath(fileName, subdir) {
  const seg = subdir ? sanitizeSegment(subdir) : '';
  const base = path.basename(String(fileName == null ? '' : fileName));
  return seg ? `${seg}/${base}` : base;
}

/**
 * 把「相对路径」安全地拼到某个根目录下。
 * 只接受 / 分隔的相对路径；`..`、绝对路径一律拒绝。
 * @throws {Error} 路径非法
 */
function safeJoin(rootDir, relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..')) {
    const err = new Error('图片路径不合法');
    err.statusCode = 400;
    throw err;
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segs);
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error('目标路径越界');
    err.statusCode = 403;
    throw err;
  }
  return target;
}

// ============================================================
// 读
// ============================================================

/**
 * 目标文件是否已存在（设计稿第 17 节：不默认覆盖，先检测冲突）。
 * 当前目录没有时会去旧目录（output/images）里找，保证升级后旧图片仍能显示。
 * @returns {{exists:boolean, size:number, mtime:number, relPath:string, absPath:string, legacy:boolean}}
 */
function exists(fileName, subdir) {
  const { target, fileName: base } = resolvePath(fileName, subdir);
  const relPath = toRelPath(base, subdir);

  const hit = statFile(target);
  if (hit) return { ...hit, relPath, absPath: target, legacy: false };

  if (_legacyDir) {
    const legacyTarget = safeJoin(_legacyDir, relPath);
    const legacyHit = statFile(legacyTarget);
    if (legacyHit) return { ...legacyHit, relPath, absPath: legacyTarget, legacy: true };
  }

  return { exists: false, size: 0, mtime: 0, relPath, absPath: target, legacy: false };
}

/** 读一个文件的 size/mtime；不存在或不是普通文件时返回 null */
function statFile(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
    return { exists: true, size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    return null;
  }
}

/**
 * 列出目录下已保存的图片（当前目录 + 旧目录，按相对路径去重）。
 * @param {{subdir?:string, limit?:number}} [opts]
 * @returns {Array<{name:string, relPath:string, size:number, mtime:number, source:'current'|'legacy'}>}
 */
function list(opts) {
  const o = opts || {};
  const seg = o.subdir ? sanitizeSegment(o.subdir) : '';
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 500;

  const out = [];
  const seen = new Set();

  const collect = (rootDir, source) => {
    if (!rootDir) return;
    const dir = seg ? path.join(rootDir, seg) : rootDir;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      return;                       // 目录不存在 = 没有图片，不算错误
    }
    for (const name of names) {
      if (!SIGNATURES[path.extname(name).toLowerCase()]) continue;
      const relPath = toRelPath(name, seg);
      if (seen.has(relPath)) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
      } catch (e) {
        continue;                   // 遍历期间文件被删掉，跳过
      }
      seen.add(relPath);
      out.push({ name, relPath, size: st.size, mtime: st.mtimeMs, source });
    }
  };

  collect(getImagesDir(), 'current');
  collect(_legacyDir, 'legacy');

  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * 递归列出全部图片（当前目录 + 旧目录），供「图片管理 / 孤儿治理」使用。
 * 前端拿它和记录里的 photos 比对，找出没人引用的文件。
 *
 * @param {{limit?:number}} [opts] limit=0 表示不限制
 * @returns {Array<{relPath:string, name:string, size:number, mtime:number,
 *                  source:'current'|'legacy', subdir:string}>}
 */
function listAll(opts) {
  const o = opts || {};
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 0;

  const out = [];
  const seen = new Set();

  const walk = (rootDir, source) => {
    if (!rootDir) return false;
    let rootStat;
    try {
      rootStat = fs.statSync(rootDir);
    } catch (e) {
      return false;
    }
    if (!rootStat.isDirectory()) return false;

    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      const dir = rel ? path.join(rootDir, rel) : rootDir;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const ent of entries) {
        const name = ent.name;
        if (!name || name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${name}` : name;
        if (childRel.split('/').length > 8) continue;      // 目录层级防护
        if (ent.isDirectory()) {
          stack.push(childRel);
          continue;
        }
        if (!ent.isFile()) continue;
        if (!SIGNATURES[path.extname(name).toLowerCase()]) continue;
        if (seen.has(childRel)) continue;
        let st;
        try {
          st = fs.statSync(path.join(rootDir, childRel));
        } catch (e) {
          continue;
        }
        seen.add(childRel);
        const slash = childRel.lastIndexOf('/');
        out.push({
          relPath: childRel,
          name,
          size: st.size,
          mtime: st.mtimeMs,
          source,
          subdir: slash >= 0 ? childRel.slice(0, slash) : '',
        });
        if (limit && out.length >= limit) return true;
      }
    }
    return false;
  };

  walk(getImagesDir(), 'current');
  walk(_legacyDir, 'legacy');

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ============================================================
// 写
// ============================================================

/**
 * 解析 data URL → { mime, buffer }
 * @throws {Error} 格式不合法
 */
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl == null ? '' : dataUrl);
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(s);
  if (!m) {
    const err = new Error('图片数据格式不合法（期望 data URL）');
    err.statusCode = 400;
    throw err;
  }
  const mime = (m[1] || 'image/jpeg').toLowerCase();
  const isBase64 = Boolean(m[2]);
  const payload = m[3];

  let buffer;
  try {
    buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'binary');
  } catch (e) {
    const err = new Error('图片数据解码失败');
    err.statusCode = 400;
    throw err;
  }

  if (buffer.length === 0) {
    const err = new Error('图片数据为空');
    err.statusCode = 400;
    throw err;
  }
  return { mime, buffer };
}

/** 校验内容与扩展名相符（不能只信扩展名 —— 设计稿第 4.1 节） */
function checkSignature(buffer, ext) {
  const check = SIGNATURES[ext] || SIGNATURES['.jpg'];
  if (buffer.length < 12 || !check(buffer)) {
    const err = new Error(`文件内容与扩展名 ${ext} 不匹配，已拒绝写入`);
    err.statusCode = 400;
    throw err;
  }
}

/** 在 dir 内为 fileName 找一个不冲突的名字: a.jpg → a_1.jpg → a_2.jpg */
function uniqueName(dir, fileName, maxTry) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const limit = maxTry || 999;
  for (let i = 1; i <= limit; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  const err = new Error('同名文件过多，无法自动编号，请修改文件名');
  err.statusCode = 409;
  throw err;
}

/**
 * 原子写入：.part 临时文件 → 校验 → rename 覆盖。
 * rename 在同一目录（同一卷）内是原子操作，因此目标路径要么是旧内容，
 * 要么是完整的新内容，不会出现半截文件。
 *
 * @returns {{written:number}}
 */
function writeAtomic(target, buffer) {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.part`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, buffer, 0, buffer.length);
    fs.fsyncSync(fd);                // 落盘后再改名，避免崩溃后留下空壳
    fs.closeSync(fd);
    fd = null;

    const st = fs.statSync(tmp);
    if (st.size !== buffer.length) {
      throw new Error(`临时文件大小校验失败（期望 ${buffer.length}，实际 ${st.size}）`);
    }

    fs.renameSync(tmp, target);      // 原子替换
    return { written: buffer.length };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/**
 * 保存一张图片。
 *
 * @param {object} opts
 * @param {string} opts.dataUrl   data:image/jpeg;base64,...
 * @param {string} opts.fileName  期望的文件名（会被清洗；扩展名不符会被纠正）
 * @param {string} [opts.subdir]  子目录（通常传记录 ID）
 * @param {'error'|'overwrite'|'rename'} [opts.conflict='error'] 重名策略
 * @returns {{relPath:string, fileName:string, dir:string, absPath:string, size:number, renamed:boolean, overwritten:boolean}}
 */
function save(opts) {
  const o = opts || {};
  const { mime, buffer } = decodeDataUrl(o.dataUrl);

  // 文件名：无扩展名时按 MIME 兜底，再统一清洗
  let requested = String(o.fileName == null ? '' : o.fileName).trim();
  if (!requested) {
    const err = new Error('缺少文件名');
    err.statusCode = 400;
    throw err;
  }
  if (!path.extname(requested)) requested += MIME_EXT[mime] || '.jpg';

  const safeName = sanitizeFileName(requested, mime);
  const ext = path.extname(safeName).toLowerCase();

  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error(`图片文件过大（${(buffer.length / 1048576).toFixed(1)} MB），上限 ${MAX_FILE_BYTES / 1048576} MB`);
    err.statusCode = 413;
    throw err;
  }
  checkSignature(buffer, ext);

  const { dir, target, fileName } = resolvePath(safeName, o.subdir);

  // 目录不存在就建（设计稿第 20 节：保存目录不存在时自动创建）
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const err = new Error(`无法创建保存目录：${e.message}`);
    err.statusCode = 500;
    err.code = e.code;
    throw err;
  }

  const conflict = o.conflict || 'error';
  let finalName = fileName;
  let renamed = false;
  let overwritten = false;

  if (fs.existsSync(target)) {
    if (conflict === 'overwrite') {
      overwritten = true;
    } else if (conflict === 'rename') {
      finalName = uniqueName(dir, fileName);
      renamed = true;
    } else {
      const err = new Error(`文件已存在：${fileName}`);
      err.statusCode = 409;
      err.conflict = true;
      err.fileName = fileName;
      throw err;
    }
  }

  const finalTarget = path.join(dir, finalName);

  try {
    writeAtomic(finalTarget, buffer);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
      const err = new Error('当前目录没有写入权限，请选择其他目录');
      err.statusCode = 403;
      err.code = e.code;
      throw err;
    }
    if (e.code === 'ENOSPC') {
      const err = new Error('磁盘空间不足，无法保存图片');
      err.statusCode = 507;
      throw err;
    }
    throw e;
  }

  return {
    relPath: toRelPath(finalName, o.subdir),
    fileName: finalName,
    dir,
    absPath: finalTarget,
    size: buffer.length,
    renamed,
    overwritten,
  };
}

/**
 * 删除一张已保存的图片。
 * @returns {{deleted:boolean, relPath:string}}
 */
function remove(fileName, subdir) {
  const { target, fileName: base } = resolvePath(fileName, subdir);
  const relPath = toRelPath(base, subdir);
  try {
    fs.unlinkSync(target);
    return { deleted: true, relPath };
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: false, relPath };
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      const err = new Error('当前目录没有写入权限，无法删除');
      err.statusCode = 403;
      throw err;
    }
    throw e;
  }
}

/**
 * 按相对路径删除图片（支持子目录，如 "k3f9a2/xxx.jpg"）。
 * 与 remove() 的区别：remove 只接受「子目录 + 文件名」，这里给图片管理页用，
 * 可以直接删旧目录（output/images）里的文件。
 *
 * @param {string} relPath
 * @param {{legacy?:boolean}} [opts] legacy=true 时删旧目录里的同名文件
 * @returns {{deleted:boolean, relPath:string, legacy:boolean}}
 */
function removePath(relPath, opts) {
  const o = opts || {};
  const root = o.legacy ? _legacyDir : getImagesDir();
  if (!root) {
    const err = new Error('没有可用的旧图片目录');
    err.statusCode = 400;
    throw err;
  }

  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..')) {
    const err = new Error('图片路径不合法');
    err.statusCode = 400;
    throw err;
  }

  const target = safeJoin(root, segs.join('/'));
  const normalized = segs.join('/');
  try {
    fs.unlinkSync(target);
    return { deleted: true, relPath: normalized, legacy: Boolean(o.legacy) };
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: false, relPath: normalized, legacy: Boolean(o.legacy) };
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      const err = new Error('当前目录没有写入权限，无法删除');
      err.statusCode = 403;
      throw err;
    }
    throw e;
  }
}

/**
 * 把旧目录（output/images）里的图片搬到当前目录，保留相对路径。
 * 记录里的 photos 存的就是相对路径，搬家后无需改记录。
 *
 * @param {{overwrite?:boolean}} [opts] overwrite=true 时覆盖新目录里的同名文件
 * @returns {{moved:number, skipped:number, failed:number, bytes:number,
 *            target:string, legacyDir:string, empty:boolean}}
 */
function migrateLegacy(opts) {
  const o = opts || {};
  const target = getImagesDir();

  if (!_legacyDir) {
    return { moved: 0, skipped: 0, failed: 0, bytes: 0, target, legacyDir: '', empty: true };
  }

  const files = listAll({}).filter((f) => f.source === 'legacy');
  if (files.length === 0) {
    return { moved: 0, skipped: 0, failed: 0, bytes: 0, target, legacyDir: _legacyDir, empty: true };
  }

  let moved = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const f of files) {
    const src = safeJoin(_legacyDir, f.relPath);
    const dest = safeJoin(target, f.relPath);

    if (fs.existsSync(dest) && !o.overwrite) {
      skipped++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.renameSync(src, dest);
      } catch (e) {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
      moved++;
      bytes += f.size;
    } catch (e) {
      failed++;
    }
  }

  return { moved, skipped, failed, bytes, target, legacyDir: _legacyDir, empty: false };
}

/**
 * 模块导出。
 *
 * 有意**不导出** read()：图片预览由 server.js 直接用 sendFile 走静态文件路径，
 * 多一个"读进内存再写回"的入口只会让人以为它被用着。
 */
module.exports = {
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  UNFILED_DIR,
  SIGNATURES,
  MIME_EXT,
  configure,
  getInfo,
  getImagesDir,
  getLegacyDir,
  sanitizeSegment,
  sanitizeFileName,
  toRelPath,
  safeJoin,
  exists,
  list,
  listAll,
  save,
  remove,
  removePath,
  migrateLegacy,
};
