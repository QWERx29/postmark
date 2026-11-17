/**
 * 整包备份 / 恢复 / 自动快照 — 文件系统边界（服务端）
 * ===================================================
 * 为什么在服务端
 * -------------
 * 记录存在 localStorage（渲染层），图片存在磁盘（服务端）。要把两者打成**一个**
 * 备份包，只能由服务端把图片读出来、把渲染层发来的四张表写进去；恢复时同理，
 * 图片必须由服务端落盘，渲染层只负责把表写回 localStorage。
 *
 * 备份包结构（zip）
 * -----------------
 *   manifest.json       格式标识 / 版本 / 创建时间 / 四表条数 / 图片数量与大小 / base 签名
 *   tables.json         { records, meters, mails, returns, trash }
 *   base.json           base 目录签名（可选，用来提示"参考库需要重新导入"）
 *   images/<相对路径>    图片，路径与记录里的 photos 字段一一对应
 *
 * 恢复流程
 * --------
 *   1. inspect(zip, token)  解出 manifest / tables，并把图片解到
 *                           output/backup/_staging/<token>/images/（不动正式目录）
 *   2. 前端展示清单，用户选「合并 / 覆盖」
 *   3. applyRestore(token)  把暂存图片搬进正式图片目录，返回图片处理统计
 *   4. 前端把 tables 写回 localStorage，然后刷新页面
 *   5. 用户取消时 discard(token) 清掉暂存目录
 *
 * 自动快照
 * --------
 *   writeSnapshot() 把四表写成 output/backup/autosnapshot-YYYYMMDD-HHMMSS.json，
 *   并按 keep 份数清理旧快照。手动备份包（.zip）不参与自动清理。
 *
 * 安全约定
 * --------
 *   - 所有 zip 条目名在解出前都校验过（不允许绝对路径 / ..）；
 *   - token 只接受 16 位十六进制，杜绝用 token 拼出别的路径；
 *   - 上传的 zip 先落盘再解析，解析成功即删除，不长期占用空间。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Zip = require('./zip-lite');
const ImgExport = require('./img-export');

// ============================================================
// 常量
// ============================================================

const FORMAT = 'postmark-backup';
const SNAPSHOT_FORMAT = 'postmark-snapshot';
const VERSION = 1;

/** 自动快照默认保留份数 */
const DEFAULT_KEEP = 20;

/** 单个备份包上传上限（可用 POSTMARK_BACKUP_MAX_BYTES 覆盖） */
const DEFAULT_MAX_UPLOAD = 2 * 1024 * 1024 * 1024;   // 2 GiB

/** manifest / base.json 读取上限 */
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

/** tables.json 读取上限（四表纯文本，足够大） */
const TABLES_MAX_BYTES = 512 * 1024 * 1024;

/** 备份包内图片数量上限（防御异常包） */
const MAX_IMAGES = 200000;

/** 暂存目录超过这个时间就视为废弃 */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** 图片扩展名（与 img-export 的魔数表保持一致） */
const IMAGE_EXT = new Set(Object.keys(ImgExport.SIGNATURES));

// ============================================================
// 模块状态
// ============================================================

let _cfg = {
  rootDir: '',
  outputDir: '',
  imagesDir: '',
  legacyImagesDir: '',
  keep: DEFAULT_KEEP,
};

/**
 * 注入目录配置。必须在任何备份接口被调用前执行一次。
 * @param {{rootDir?:string, outputDir:string, imagesDir:string,
 *          legacyImagesDir?:string, keep?:number}} opts
 */
function configure(opts) {
  const o = opts || {};
  _cfg = {
    rootDir: o.rootDir ? path.resolve(o.rootDir) : '',
    outputDir: o.outputDir ? path.resolve(o.outputDir) : '',
    imagesDir: o.imagesDir ? path.resolve(o.imagesDir) : '',
    legacyImagesDir: o.legacyImagesDir ? path.resolve(o.legacyImagesDir) : '',
    keep: Number.isInteger(o.keep) && o.keep > 0 ? o.keep : DEFAULT_KEEP,
  };
  if (_cfg.legacyImagesDir && _cfg.legacyImagesDir === _cfg.imagesDir) {
    _cfg.legacyImagesDir = '';
  }
  return getConfig();
}

function getConfig() {
  return {
    rootDir: _cfg.rootDir,
    outputDir: _cfg.outputDir,
    imagesDir: _cfg.imagesDir,
    legacyImagesDir: _cfg.legacyImagesDir,
    keep: _cfg.keep,
    backupDir: _cfg.outputDir ? backupDir() : '',
  };
}

function maxUploadBytes() {
  const raw = Number(process.env.POSTMARK_BACKUP_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD;
}

function backupDir() {
  if (!_cfg.outputDir) throw new Error('备份目录尚未配置');
  return path.join(_cfg.outputDir, 'backup');
}

function stagingRoot() {
  return path.join(backupDir(), '_staging');
}

/** 新恢复会话的 token（16 位十六进制） */
function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

function assertToken(token) {
  const t = String(token == null ? '' : token);
  if (!/^[0-9a-f]{16}$/.test(t)) {
    const err = new Error('恢复会话标识不合法');
    err.statusCode = 400;
    throw err;
  }
  return t;
}

function stagingZipPath(token) {
  const dir = stagingRoot();
  ensureDir(dir);
  return path.join(dir, `${assertToken(token)}.zip`);
}

function stagingDir(token) {
  return path.join(stagingRoot(), assertToken(token));
}

// ============================================================
// 小工具
// ============================================================

function badRequest(message, status) {
  const err = new Error(message);
  err.statusCode = status || 400;
  return err;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 递归删除（不存在时静默） */
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    // 老版本 Node 没有 fs.rmSync 时的兜底
    try { fs.rmdirSync(target, { recursive: true }); } catch (e2) { /* ignore */ }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 文件名时间戳：YYYYMMDD-HHMMSS（本地时间，用户看目录时更直观） */
function stamp(date) {
  const d = date || new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 把四张表归一成数组，脏数据不至于让备份流程崩掉 */
function normalizeTables(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    records: arr(src.records),
    meters: arr(src.meters),
    mails: arr(src.mails),
    returns: arr(src.returns),
    trash: arr(src.trash),
  };
}

function countsOf(tables) {
  const t = normalizeTables(tables);
  return {
    records: t.records.length,
    meters: t.meters.length,
    mails: t.mails.length,
    returns: t.returns.length,
    trash: t.trash.length,
  };
}

function isImageName(name) {
  return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase());
}

/**
 * 遍历目录，返回相对路径（/ 分隔）列表。
 * 跳过隐藏文件、.part 临时文件与非图片扩展名。
 */
function walkImages(rootDir) {
  const out = [];
  if (!rootDir) return out;
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch (e) {
    return out;
  }
  if (!rootStat.isDirectory()) return out;

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
      if (!isImageName(name)) continue;                  // 跳过 .part / 缩略图缓存等
      out.push(childRel);
    }
  }
  return out;
}

/** 安全拼接：拒绝绝对路径与 ..，保证目标落在 rootDir 内 */
function safeJoin(rootDir, relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) {
    throw badRequest('备份包内含非法路径');
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segs);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw badRequest('备份包内含越界路径');
  }
  return target;
}

// ============================================================
// 自动快照
// ============================================================

/**
 * 写一份四表快照（JSON），并按 keep 清理旧快照。
 * @param {object} tables
 * @param {{reason?:string, keep?:number}} [opts]
 * @returns {{name:string, size:number, createdAt:string, counts:object, kept:number}}
 */
function writeSnapshot(tables, opts) {
  const o = opts || {};
  const t = normalizeTables(tables);
  const counts = countsOf(t);
  const createdAt = new Date().toISOString();

  const dir = backupDir();
  ensureDir(dir);

  let name = `autosnapshot-${stamp()}.json`;
  if (fs.existsSync(path.join(dir, name))) {
    name = `autosnapshot-${stamp()}-${crypto.randomBytes(2).toString('hex')}.json`;
  }
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.part`;

  const payload = {
    format: SNAPSHOT_FORMAT,
    version: VERSION,
    createdAt,
    reason: o.reason ? String(o.reason) : 'manual',
    counts,
    tables: t,
  };

  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }

  const keep = Number.isInteger(o.keep) && o.keep > 0 ? o.keep : _cfg.keep;
  const kept = pruneSnapshots(keep);

  return {
    name,
    size: fs.statSync(target).size,
    createdAt,
    counts,
    kept,
  };
}

/** 只清理 autosnapshot-*.json，手动备份包不动 */
function pruneSnapshots(keep) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : _cfg.keep;
  let names;
  try {
    names = fs.readdirSync(backupDir());
  } catch (e) {
    return 0;
  }
  const snapshots = names
    .filter((n) => /^autosnapshot-\d{8}-\d{6}(?:-[0-9a-f]+)?\.json$/.test(n))
    .sort();                                   // 文件名里带时间戳，字典序即时间序

  const extra = snapshots.slice(0, Math.max(0, snapshots.length - limit));
  for (const name of extra) {
    try { fs.unlinkSync(path.join(backupDir(), name)); } catch (e) { /* ignore */ }
  }
  return Math.min(snapshots.length, limit);
}

// ============================================================
// 备份包
// ============================================================

/**
 * 收集要打进包里的图片：当前目录 + 旧目录（output/images）。
 * 同一相对路径以当前目录为准。
 * @returns {Array<{relPath:string, absPath:string, size:number, source:'current'|'legacy'}>}
 */
function collectImages() {
  const out = [];
  const seen = new Set();
  const push = (relPath, absPath, source) => {
    if (seen.has(relPath)) return;
    let st;
    try { st = fs.statSync(absPath); } catch (e) { return; }
    if (!st.isFile()) return;
    seen.add(relPath);
    out.push({ relPath, absPath, size: st.size, source });
  };

  if (_cfg.imagesDir) {
    for (const rel of walkImages(_cfg.imagesDir)) {
      push(rel, path.join(_cfg.imagesDir, ...rel.split('/')), 'current');
    }
  }
  if (_cfg.legacyImagesDir) {
    for (const rel of walkImages(_cfg.legacyImagesDir)) {
      push(rel, path.join(_cfg.legacyImagesDir, ...rel.split('/')), 'legacy');
    }
  }
  return out;
}

/**
 * 打一个完整备份包。
 * @param {object} tables 四表数据
 * @param {{base?:object, note?:string}} [opts]
 * @returns {{name:string, size:number, createdAt:string, counts:object,
 *            images:object, downloadUrl:string}}
 */
function createPackage(tables, opts) {
  const o = opts || {};
  const t = normalizeTables(tables);
  const counts = countsOf(t);
  const images = collectImages();

  if (counts.records + counts.meters + counts.mails + counts.returns === 0 && images.length === 0) {
    throw badRequest('当前没有可备份的数据');
  }

  const dir = backupDir();
  ensureDir(dir);

  let name = `postmark-backup-${stamp()}.zip`;
  if (fs.existsSync(path.join(dir, name))) {
    name = `postmark-backup-${stamp()}-${crypto.randomBytes(2).toString('hex')}.zip`;
  }
  const target = path.join(dir, name);
  const createdAt = new Date().toISOString();

  const imageBytes = images.reduce((s, it) => s + it.size, 0);
  const manifest = {
    format: FORMAT,
    version: VERSION,
    app: '新一代集邮管理系统',
    createdAt,
    counts,
    images: { count: images.length, bytes: imageBytes },
    base: o.base || null,
    note: o.note ? String(o.note).slice(0, 200) : '',
    tablesFile: 'tables.json',
    imagesRoot: 'images/',
  };

  const writer = new Zip.ZipWriter(target);
  try {
    writer.addBuffer('manifest.json', JSON.stringify(manifest, null, 2), { compress: true });
    writer.addBuffer('tables.json', JSON.stringify(t), { compress: true });
    if (manifest.base) {
      writer.addBuffer('base.json', JSON.stringify(manifest.base, null, 2), { compress: true });
    }
    for (const it of images) {
      writer.addFile(`images/${it.relPath}`, it.absPath);
    }
    writer.close();
  } catch (e) {
    writer.abort();
    throw e;
  }

  return {
    name,
    size: fs.statSync(target).size,
    createdAt,
    counts,
    images: { count: images.length, bytes: imageBytes },
    downloadUrl: `/output/backup/${encodeURIComponent(name)}`,
  };
}

// ============================================================
// 恢复
// ============================================================

/**
 * 解析一个上传的备份包，把图片解到暂存目录。
 * @param {string} zipPath 上传后落盘的 zip
 * @param {string} token 恢复会话标识
 * @returns {{token:string, manifest:object, tables:object, base:object|null,
 *            images:{count:number, bytes:number}, warnings:string[]}}
 */
function inspect(zipPath, token) {
  const safeToken = assertToken(token);
  const staging = stagingDir(safeToken);
  const stagingImages = path.join(staging, 'images');

  let reader;
  try {
    reader = new Zip.ZipReader(zipPath);
  } catch (e) {
    try { fs.unlinkSync(zipPath); } catch (e2) { /* ignore */ }
    throw badRequest(e.message || '无法读取备份包');
  }

  try {
    const manifestEntry = reader.find('manifest.json');
    if (!manifestEntry) {
      throw badRequest('备份包缺少 manifest.json，可能不是本应用生成的备份');
    }
    let manifest;
    try {
      manifest = JSON.parse(reader.read(manifestEntry, MANIFEST_MAX_BYTES).toString('utf8'));
    } catch (e) {
      if (e.statusCode) throw e;
      throw badRequest('manifest.json 不是合法 JSON');
    }
    if (!manifest || manifest.format !== FORMAT) {
      throw badRequest('备份包格式不匹配（不是本应用生成的备份）');
    }
    const version = Number(manifest.version) || 0;
    if (version > VERSION) {
      throw badRequest(`备份包版本 ${version} 高于当前程序支持的 ${VERSION}，请先升级程序`);
    }

    const tablesEntry = reader.find(manifest.tablesFile || 'tables.json');
    if (!tablesEntry) throw badRequest('备份包缺少数据表文件 tables.json');
    let tables;
    try {
      tables = normalizeTables(JSON.parse(reader.read(tablesEntry, TABLES_MAX_BYTES).toString('utf8')));
    } catch (e) {
      if (e.statusCode) throw e;
      throw badRequest('tables.json 不是合法 JSON');
    }

    let base = manifest.base || null;
    const baseEntry = reader.find('base.json');
    if (baseEntry) {
      try {
        base = JSON.parse(reader.read(baseEntry, MANIFEST_MAX_BYTES).toString('utf8'));
      } catch (e) {
        base = manifest.base || null;
      }
    }

    // 图片：逐条解到暂存目录（不碰正式目录）
    rmrf(staging);
    ensureDir(stagingImages);
    let count = 0;
    let bytes = 0;
    for (const entry of reader.entries) {
      if (!entry.name.startsWith('images/') || entry.name.endsWith('/')) continue;
      if (count >= MAX_IMAGES) {
        throw badRequest(`备份包内图片超过 ${MAX_IMAGES} 张，已中止恢复`);
      }
      const rel = entry.name.slice('images/'.length);
      if (!isImageName(rel)) continue;                  // 包里夹带的其他文件不落地
      const target = safeJoin(stagingImages, rel);
      reader.extractTo(entry, target);
      count++;
      bytes += entry.size;
    }

    const warnings = [];
    if (manifest.images && Number(manifest.images.count) > count) {
      warnings.push(`备份包清单记录 ${manifest.images.count} 张图片，实际解出 ${count} 张`);
    }
    if (manifest.version !== VERSION) {
      warnings.push(`备份包版本 v${manifest.version}，当前程序 v${VERSION}`);
    }

    try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
    return {
      token: safeToken,
      manifest,
      tables,
      base,
      images: { count, bytes },
      warnings,
    };
  } catch (e) {
    rmrf(staging);
    try { fs.unlinkSync(zipPath); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    if (reader) reader.close();
  }
}

/**
 * 把暂存图片搬进正式图片目录，并清掉暂存。
 * @param {string} token
 * @param {{images?:'skip'|'overwrite'}} [opts] 默认 skip（合并模式：已有同名文件保留现状）
 * @returns {{images:{copied:number, overwritten:number, skipped:number, failed:number},
 *            imagesDir:string, mode:string}}
 */
function applyRestore(token, opts) {
  const safeToken = assertToken(token);
  const o = opts || {};
  const staging = stagingDir(safeToken);
  const stagingImages = path.join(staging, 'images');

  if (!fs.existsSync(staging)) {
    throw badRequest('恢复会话已过期，请重新选择备份包');
  }
  if (!_cfg.imagesDir) throw new Error('图片目录尚未配置');

  const mode = o.images === 'overwrite' ? 'overwrite' : 'skip';
  const result = { copied: 0, overwritten: 0, skipped: 0, failed: 0 };

  for (const rel of walkImages(stagingImages)) {
    const src = path.join(stagingImages, ...rel.split('/'));
    const target = safeJoin(_cfg.imagesDir, rel);
    const exists = fs.existsSync(target);

    if (exists && mode === 'skip') {
      result.skipped++;
      continue;
    }

    try {
      ensureDir(path.dirname(target));
      try {
        fs.renameSync(src, target);                 // 同卷：原子移动
      } catch (e) {
        fs.copyFileSync(src, target);               // 跨卷：复制后删除
        fs.unlinkSync(src);
      }
      if (exists) result.overwritten++;
      else result.copied++;
    } catch (e) {
      result.failed++;
    }
  }

  if (result.failed === 0) {
    rmrf(staging);
  }
  // 有失败时保留暂存目录，至少图片还能被人工找回（下次启动 24 小时后清理）
  return {
    images: result,
    imagesDir: _cfg.imagesDir,
    mode,
    stagingDir: result.failed > 0 ? staging : '',
  };
}

/** 放弃一次恢复：清掉暂存目录与残留的上传包 */
function discard(token) {
  const safeToken = assertToken(token);
  rmrf(stagingDir(safeToken));
  try { fs.unlinkSync(stagingZipPath(safeToken)); } catch (e) { /* ignore */ }
  return { discarded: true };
}

/** 清理超过 24 小时的暂存目录与上传包 */
function pruneStaging() {
  const root = stagingRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (now - st.mtimeMs < STAGING_TTL_MS) continue;
    rmrf(full);
    removed++;
  }
  return removed;
}

// ============================================================
// 备份文件列表 / 删除
// ============================================================

/**
 * 列出 output/backup 下的备份包与快照（新的在前）。
 * @returns {{backupDir:string, files:Array<object>}}
 */
function listBackups() {
  const dir = backupDir();
  ensureDir(dir);

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { backupDir: dir, files: [] };
  }

  const files = [];
  for (const name of names) {
    if (!/\.(zip|json)$/i.test(name)) continue;
    if (name.startsWith('.')) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
    } catch (e) {
      continue;
    }
    const isZip = /\.zip$/i.test(name);
    files.push({
      name,
      size: st.size,
      mtime: st.mtimeMs,
      kind: isZip ? 'package' : 'snapshot',
      downloadUrl: `/output/backup/${encodeURIComponent(name)}`,
    });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return { backupDir: dir, files };
}

/**
 * 删除一个备份文件（只允许 backup 目录下、文件名合法的 .zip / .json）。
 * @param {string} name
 */
function deleteFile(name) {
  const base = path.basename(String(name == null ? '' : name));
  if (!base || base !== name || !/^[A-Za-z0-9._-]+\.(zip|json)$/i.test(base) || base.startsWith('.')) {
    throw badRequest('备份文件名不合法');
  }
  const dir = path.resolve(backupDir());
  const target = path.resolve(dir, base);
  if (!target.startsWith(dir + path.sep)) throw badRequest('备份文件名不合法');

  try {
    fs.unlinkSync(target);
    return { deleted: true, name: base };
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: false, name: base };
    throw e;
  }
}

module.exports = {
  FORMAT,
  SNAPSHOT_FORMAT,
  VERSION,
  DEFAULT_KEEP,
  configure,
  getConfig,
  maxUploadBytes,
  backupDir,
  newToken,
  stagingZipPath,
  stagingDir,
  countsOf,
  normalizeTables,
  writeSnapshot,
  pruneSnapshots,
  collectImages,
  createPackage,
  inspect,
  applyRestore,
  discard,
  pruneStaging,
  listBackups,
  deleteFile,
};
