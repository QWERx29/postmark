/**
 * 极简 ZIP 读写（无第三方依赖）
 * ================================
 * 只做「备份包」需要的两件事：把一个目录（连同若干 JSON）打成一个 zip，
 * 以及从 zip 里按条目取出内容。刻意不实现的能力：
 *
 *   - 不支持 ZIP64：单个文件与总大小上限都是 4 GB，超出时明确报错，
 *     而不是悄悄写坏一个包；
 *   - 不支持加密、分卷、ZIP 注释；
 *   - 只支持 STORE(0) 与 DEFLATE(8) 两种压缩方式。
 *
 * 为什么不用第三方库
 * ------------------
 * 打包版只随附 iconv-lite / safer-buffer 两个 Node 依赖（见 scripts/stage-tauri-resources.js），
 * 再引一个 zip 库就得同时改打包清单与前端 <script>。备份包格式本身很稳定，
 * 自己实现一百多行比多一个运行时依赖更划算。
 *
 * 内存策略
 * --------
 *   - 图片用 STORE（不压缩）**分块**写入/取出：图片本身已是压缩格式，
 *     再 deflate 一遍既费 CPU 又几乎不省空间，分块还能避免把整张图读进内存；
 *   - JSON 用 DEFLATE：体积小、压缩收益明显。
 *
 * 用法
 * ----
 *   const w = new ZipWriter(destPath);
 *   w.addBuffer('manifest.json', Buffer.from(json), { compress: true });
 *   w.addFile('images/a.jpg', absPath);           // STORE，分块复制
 *   const info = w.close();                        // { entries, size }
 *
 *   const r = new ZipReader(zipPath);
 *   const entry = r.entries.find(e => e.name === 'manifest.json');
 *   const data = r.read(entry);
 *   r.extractTo(imageEntry, targetPath);
 *   r.close();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- 常量 ----
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 通用标志位：文件名按 UTF-8 解释（中文文件名必需） */
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 分块大小：1 MiB */
const CHUNK = 1024 * 1024;

/** 单个条目上限（ZIP 非 ZIP64 格式的硬限制） */
const MAX_ENTRY_BYTES = 0xFFFFFFFF;

// ============================================================
// CRC32
// ============================================================

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 增量 CRC32。
 * @param {Buffer} buf
 * @param {number} [seed] 上一次调用返回的值（用于分块续算）
 * @returns {number} 无符号 32 位
 */
function crc32(buf, seed) {
  let crc = ((seed == null ? 0 : seed) ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
// 时间戳
// ============================================================

/** JS 时间 → DOS 时间/日期（ZIP 用 1980 纪年，秒精度 2 秒） */
function dosDateTime(mtimeMs) {
  const d = new Date(mtimeMs || Date.now());
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1F) << 11)
    | ((d.getMinutes() & 0x3F) << 5)
    | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((year - 1980) & 0x7F) << 9)
    | (((d.getMonth() + 1) & 0x0F) << 5)
    | (d.getDate() & 0x1F);
  return { time, date };
}

// ============================================================
// 条目名校验
// ============================================================

/**
 * 规范化并校验条目名：
 *   - 反斜杠统一成 /；
 *   - 不允许绝对路径、盘符、`..`；
 *   - 去掉开头的 `./`。
 * @returns {string}
 */
function normalizeEntryName(name) {
  let n = String(name == null ? '' : name).replace(/\\/g, '/');
  n = n.replace(/^\.\/+/, '');
  if (!n) throw new Error('ZIP 条目名为空');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) {
    throw new Error(`ZIP 条目名不能是绝对路径: ${name}`);
  }
  const parts = n.split('/');
  if (parts.some((p) => p === '..')) {
    throw new Error(`ZIP 条目名不能包含 ..: ${name}`);
  }
  return parts.filter((p) => p && p !== '.').join('/');
}

// ============================================================
// 写
// ============================================================

function localHeader(entry) {
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(20, 4);          // version needed
  buf.writeUInt16LE(FLAG_UTF8, 6);
  buf.writeUInt16LE(entry.method, 8);
  buf.writeUInt16LE(entry.time, 10);
  buf.writeUInt16LE(entry.date, 12);
  buf.writeUInt32LE(entry.crc >>> 0, 14);
  buf.writeUInt32LE(entry.compSize >>> 0, 18);
  buf.writeUInt32LE(entry.size >>> 0, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);          // extra length
  return Buffer.concat([buf, nameBuf]);
}

class ZipWriter {
  constructor(destPath) {
    this.destPath = destPath;
    this.fd = fs.openSync(destPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  _write(buf) {
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(this.fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error('写入 ZIP 失败：磁盘可能已满');
      written += n;
    }
    this.offset += buf.length;
  }

  _claimName(name) {
    const n = normalizeEntryName(name);
    if (this.names.has(n)) throw new Error(`ZIP 条目重复: ${n}`);
    this.names.add(n);
    return n;
  }

  /**
   * 写入一段内存数据。
   * @param {string} name
   * @param {Buffer|string} buffer
   * @param {{compress?:boolean, mtime?:number}} [opts] compress 默认 true
   */
  addBuffer(name, buffer, opts) {
    const entryName = this._claimName(name);
    const o = opts || {};
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    if (raw.length > MAX_ENTRY_BYTES) throw new Error(`条目超过 4 GB: ${entryName}`);

    const method = o.compress === false ? METHOD_STORE : METHOD_DEFLATE;
    const data = method === METHOD_DEFLATE
      ? zlib.deflateRawSync(raw, { level: zlib.constants.Z_BEST_SPEED })
      : raw;

    const { time, date } = dosDateTime(o.mtime);
    const entry = {
      name: entryName,
      method,
      time,
      date,
      crc: crc32(raw),
      size: raw.length,
      compSize: data.length,
      offset: this.offset,
    };

    this._write(localHeader(entry));
    this._write(data);
    this.entries.push(entry);
    return entry;
  }

  /**
   * 写入磁盘上的一个文件（STORE，分块复制，不整读进内存）。
   * @param {string} name
   * @param {string} filePath
   * @param {{mtime?:number}} [opts]
   */
  addFile(name, filePath, opts) {
    const entryName = this._claimName(name);
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error(`不是普通文件: ${filePath}`);
    if (st.size > MAX_ENTRY_BYTES) throw new Error(`文件超过 4 GB，超出本工具支持的 ZIP 格式: ${filePath}`);

    const o = opts || {};
    const { time, date } = dosDateTime(o.mtime || st.mtimeMs);
    const entry = {
      name: entryName,
      method: METHOD_STORE,
      time,
      date,
      crc: 0,
      size: st.size,
      compSize: st.size,
      offset: this.offset,
    };

    const headerOffset = this.offset;
    this._write(localHeader(entry));       // 先写占位头，数据写完回填 CRC

    const src = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, st.size)));
      let crc = 0;
      let total = 0;
      for (;;) {
        const n = fs.readSync(src, buf, 0, buf.length, null);
        if (n <= 0) break;
        const chunk = n === buf.length ? buf : buf.subarray(0, n);
        crc = crc32(chunk, crc);
        this._write(chunk);
        total += n;
      }
      if (total !== st.size) {
        throw new Error(`读取文件时长度发生变化: ${filePath}`);
      }
      entry.crc = crc;
    } finally {
      try { fs.closeSync(src); } catch (e) { /* ignore */ }
    }

    // 回填本地头里的 CRC（central directory 里也会写一份）
    const patched = localHeader(entry);
    fs.writeSync(this.fd, patched, 0, patched.length, headerOffset);
    this.entries.push(entry);
    return entry;
  }

  /** 写中央目录 + EOCD 并关闭文件 */
  close() {
    if (this.fd === null) return { entries: this.entries.length, size: this.offset };

    const cdStart = this.offset;
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const buf = Buffer.alloc(46);
      buf.writeUInt32LE(SIG_CENTRAL, 0);
      buf.writeUInt16LE(20, 4);        // version made by
      buf.writeUInt16LE(20, 6);        // version needed
      buf.writeUInt16LE(FLAG_UTF8, 8);
      buf.writeUInt16LE(e.method, 10);
      buf.writeUInt16LE(e.time, 12);
      buf.writeUInt16LE(e.date, 14);
      buf.writeUInt32LE(e.crc >>> 0, 16);
      buf.writeUInt32LE(e.compSize >>> 0, 20);
      buf.writeUInt32LE(e.size >>> 0, 24);
      buf.writeUInt16LE(nameBuf.length, 28);
      buf.writeUInt16LE(0, 30);        // extra
      buf.writeUInt16LE(0, 32);        // comment
      buf.writeUInt16LE(0, 34);        // disk start
      buf.writeUInt16LE(0, 36);        // internal attrs
      buf.writeUInt32LE(0, 38);        // external attrs
      buf.writeUInt32LE(e.offset >>> 0, 42);
      this._write(buf);
      this._write(nameBuf);
    }

    const cdSize = this.offset - cdStart;
    if (this.entries.length > 0xFFFF) {
      fs.closeSync(this.fd);
      this.fd = null;
      throw new Error('ZIP 条目超过 65535 个，超出本工具支持的 ZIP 格式');
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize >>> 0, 12);
    eocd.writeUInt32LE(cdStart >>> 0, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    fs.closeSync(this.fd);
    this.fd = null;
    return { entries: this.entries.length, size: this.offset };
  }

  /** 出错时清理：关闭句柄并删掉半截文件 */
  abort() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (e) { /* ignore */ }
      this.fd = null;
    }
    try { fs.unlinkSync(this.destPath); } catch (e) { /* ignore */ }
  }
}

// ============================================================
// 读
// ============================================================

class ZipReader {
  constructor(zipPath) {
    this.zipPath = zipPath;
    this.fd = fs.openSync(zipPath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = [];
    try {
      this._readDirectory();
    } catch (e) {
      try { fs.closeSync(this.fd); } catch (e2) { /* ignore */ }
      this.fd = null;
      throw e;
    }
  }

  _readAt(position, length) {
    if (length === 0) return Buffer.alloc(0);
    if (position < 0 || position + length > this.size) {
      throw new Error('ZIP 文件不完整（读取越界）');
    }
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(this.fd, buf, read, length - read, position + read);
      if (n <= 0) throw new Error('ZIP 文件不完整（读取中断）');
      read += n;
    }
    return buf;
  }

  _readDirectory() {
    if (this.size < 22) throw new Error('不是有效的 ZIP 文件（文件过小）');

    const tailLen = Math.min(this.size, 65557);
    const tail = this._readAt(this.size - tailLen, tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      // 末尾可能带注释：只有「注释长度正好补齐到文件尾」的那条才是真 EOCD
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录结尾）');

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw new Error('暂不支持 ZIP64 格式的备份包');
    }
    if (cdOffset + cdSize > this.size) {
      throw new Error('ZIP 目录偏移越界，文件可能已损坏');
    }
    // 目录本身也是要读进内存的：正常备份包远小于这个值，超过说明包异常
    if (cdSize > 256 * 1024 * 1024) {
      throw new Error('ZIP 目录过大，文件可能已损坏');
    }

    const cd = this._readAt(cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error('ZIP 目录损坏');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);

      if (compSize === 0xFFFFFFFF || size === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
        throw new Error('暂不支持 ZIP64 格式的备份包');
      }
      if (p + 46 + nameLen > cd.length) throw new Error('ZIP 目录损坏（文件名越界）');

      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      this.entries.push({
        name: normalizeEntryName(name),
        method,
        flags,
        crc,
        compSize,
        size,
        localOffset,
        time,
        date,
      });
    }
  }

  _dataOffset(entry) {
    const header = this._readAt(entry.localOffset, 30);
    if (header.readUInt32LE(0) !== SIG_LOCAL) throw new Error('ZIP 条目头损坏');
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    return entry.localOffset + 30 + nameLen + extraLen;
  }

  find(name) {
    const key = normalizeEntryName(name);
    return this.entries.find((e) => e.name === key) || null;
  }

  /**
   * 读取一个条目到内存。
   * @param {object} entry
   * @param {number} [maxBytes=512MB] 超出上限时抛错，避免异常包撑爆内存
   * @returns {Buffer}
   */
  read(entry, maxBytes) {
    const limit = maxBytes == null ? 512 * 1024 * 1024 : maxBytes;
    if (entry.size > limit) {
      const err = new Error(`ZIP 条目过大（${entry.name}）`);
      err.statusCode = 413;
      throw err;
    }
    const data = this._readAt(this._dataOffset(entry), entry.compSize);

    let raw;
    if (entry.method === METHOD_STORE) {
      raw = data;
    } else if (entry.method === METHOD_DEFLATE) {
      raw = zlib.inflateRawSync(data, { maxOutputLength: limit });
    } else {
      throw new Error(`不支持的 ZIP 压缩方式: ${entry.method}`);
    }

    if (raw.length !== entry.size) throw new Error(`ZIP 条目长度不符: ${entry.name}`);
    if (crc32(raw) !== entry.crc) throw new Error(`ZIP 条目校验失败: ${entry.name}`);
    return raw;
  }

  /**
   * 解出一个条目到目标文件（STORE 走分块复制，DEFLATE 先解压到内存）。
   * @param {object} entry
   * @param {string} destPath
   * @param {number} [maxBytes]
   */
  extractTo(entry, destPath, maxBytes) {
    const limit = maxBytes == null ? 512 * 1024 * 1024 : maxBytes;
    if (entry.size > limit) {
      const err = new Error(`ZIP 条目过大（${entry.name}）`);
      err.statusCode = 413;
      throw err;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (entry.method === METHOD_STORE) {
      const start = this._dataOffset(entry);
      const out = fs.openSync(destPath, 'w');
      let crc = 0;
      let pos = start;
      let remaining = entry.compSize;
      const buf = Buffer.alloc(CHUNK);
      try {
        while (remaining > 0) {
          const want = Math.min(buf.length, remaining);
          const got = fs.readSync(this.fd, buf, 0, want, pos);
          if (got <= 0) throw new Error('ZIP 数据不完整');
          const chunk = buf.subarray(0, got);
          crc = crc32(chunk, crc);
          let written = 0;
          while (written < chunk.length) {
            const n = fs.writeSync(out, chunk, written, chunk.length - written);
            if (n <= 0) throw new Error('解压写入失败：磁盘可能已满');
            written += n;
          }
          pos += got;
          remaining -= got;
        }
      } finally {
        try { fs.closeSync(out); } catch (e) { /* ignore */ }
      }
      if (crc !== entry.crc) {
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        throw new Error(`ZIP 条目校验失败: ${entry.name}`);
      }
      return;
    }

    const data = this.read(entry, limit);
    fs.writeFileSync(destPath, data);
  }

  close() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch (e) { /* ignore */ }
    this.fd = null;
  }
}

module.exports = {
  ZipWriter,
  ZipReader,
  crc32,
  normalizeEntryName,
  METHOD_STORE,
  METHOD_DEFLATE,
  MAX_ENTRY_BYTES,
};
