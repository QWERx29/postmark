/**
 * Chromium Local Storage (leveldb) 读取工具
 * ==========================================
 * 本应用的记录与 PO 参考库都存在 Chromium/Electron 的 Local Storage 里，
 * 落地为 `<profile>/Local Storage/leveldb/` 下的一组 leveldb 文件。
 * 本模块提供只读解析能力，供以下场景复用：
 *
 *   - scripts/recover-localstorage.js  ：离线把数据导出成 JSON（灾备/恢复）
 *   - scripts/migrate-to-chrome.js     ：从 Electron profile 迁移到浏览器 profile
 *
 * 格式要点
 * --------
 *   - `.ldb` 是 leveldb 的 sorted table，data block 可能经过 snappy 压缩；
 *   - 键形如 `_<origin>\x00\x01<键名>\x01<序号>`，**序号大的更新**；
 *   - 值首字节是编码标记：0 = UTF-16LE，1 = Latin-1；
 *   - `.log` 里的最新写入未合入 `.ldb`，正常退出后通常已经落盘，
 *     因此本模块只读 `.ldb`（与原有行为一致，不做 WAL 回放）。
 *
 * 只读保证：本模块只调用 fs.readFileSync / readdirSync，绝不写源目录。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// varint / snappy
// ============================================================
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
  return [result, pos];
}

function snappyDecompress(src) {
  let pos = 0;
  const [ulen, p0] = readVarint(src, pos); pos = p0;
  const out = Buffer.alloc(ulen);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {                            // literal
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const extra = len - 60;                  // 1..4 字节小端长度
        let v = 0;
        for (let i = 0; i < extra; i++) v += src[pos++] * Math.pow(2, 8 * i);
        len = v + 1;
      }
      src.copy(out, o, pos, pos + len);
      pos += len; o += len;
    } else {                                     // copy（可能自重叠，逐字节复制）
      let len, offset;
      if (type === 1) { len = 4 + ((tag >> 2) & 7); offset = ((tag >> 5) << 8) | src[pos++]; }
      else if (type === 2) { len = (tag >> 2) + 1; offset = src[pos] | (src[pos + 1] << 8); pos += 2; }
      else { len = (tag >> 2) + 1; offset = src.readUInt32LE(pos); pos += 4; }
      let sp = o - offset;
      for (let i = 0; i < len; i++) out[o++] = out[sp++];
    }
  }
  return out.subarray(0, o);
}

// ============================================================
// leveldb table (.ldb)
// ============================================================
/** BlockHandle 的 size 不含末尾 5 字节 trailer(1 字节压缩类型 + 4 字节 CRC) */
function readBlock(buf, offset, size) {
  const content = buf.subarray(offset, offset + size);
  const type = buf[offset + size];
  return type === 1 ? snappyDecompress(content) : Buffer.from(content);
}

function blockEntries(block) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const entriesEnd = block.length - 4 - numRestarts * 4;
  const out = [];
  let pos = 0, lastKey = Buffer.alloc(0);
  while (pos < entriesEnd) {
    let shared, nonShared, valueLen;
    [shared, pos] = readVarint(block, pos);
    [nonShared, pos] = readVarint(block, pos);
    [valueLen, pos] = readVarint(block, pos);
    const key = Buffer.concat([lastKey.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    lastKey = key;
    out.push({ key, value });
  }
  return out;
}

/** 解析单个 .ldb 文件，返回 [{key, value}] */
function readTable(file) {
  const buf = fs.readFileSync(file);
  const footer = buf.subarray(buf.length - 48);
  let p = 0, metaOff, metaSize, idxOff, idxSize;
  [metaOff, p] = readVarint(footer, p); [metaSize, p] = readVarint(footer, p);
  [idxOff, p] = readVarint(footer, p); [idxSize, p] = readVarint(footer, p);
  const entries = [];
  for (const ie of blockEntries(readBlock(buf, idxOff, idxSize))) {
    let q = 0, off, size;
    [off, q] = readVarint(ie.value, q); [size, q] = readVarint(ie.value, q);
    for (const e of blockEntries(readBlock(buf, off, size))) entries.push(e);
  }
  return entries;
}

// ============================================================
// Chromium Local Storage 键 / 值
// ============================================================
/** 值首字节: 0 = UTF-16LE, 1 = Latin-1 */
function decodeValue(v) {
  if (v.length === 0) return '';
  const fmt = v[0], body = v.subarray(1);
  if (fmt === 0) return body.toString('utf16le');
  if (fmt === 1) return body.toString('latin1');
  return v.toString('utf8');
}

/** 键形如 `_<origin>\x00\x01<键名>\x01<序号>`，序号大的更新 */
function parseKey(k) {
  const m = /^(.*?)\u0000\u0001(.*?)\u0001/.exec(k);
  if (!m) return { origin: '', name: k, seq: -1 };
  let v = 0, shift = 0;
  for (const b of Buffer.from(k.slice(m[0].length), 'latin1')) {
    v += (b & 0x7f) * Math.pow(2, shift); shift += 7;
    if (!(b & 0x80)) break;
  }
  return { origin: m[1], name: m[2], seq: v };
}

// ============================================================
// 读取整个 Local Storage 目录
// ============================================================
/**
 * 读取 leveldb 目录，按键去重（保留最后出现的版本）。
 * @param {string} lsDir leveldb 目录
 * @param {{quiet?:boolean}} [opts]
 * @returns {{store: Map<string,Buffer>, files: Array<{file:string,count:number,error?:string}>}}
 */
function readLocalStorageDir(lsDir, opts) {
  const quiet = !!(opts && opts.quiet);
  const files = [];
  const store = new Map();

  const list = fs.readdirSync(lsDir).filter((f) => f.endsWith('.ldb'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));   // 序号大的更新，后写覆盖先写

  for (const f of list) {
    try {
      const entries = readTable(path.join(lsDir, f));
      for (const e of entries) store.set(e.key.toString('latin1'), e.value);
      files.push({ file: f, count: entries.length });
      if (!quiet) console.log(`  ${f}: ${entries.length} 条键值`);
    } catch (e) {
      files.push({ file: f, count: 0, error: e.message });
      if (!quiet) console.log(`  ! ${f} 解析失败: ${e.message}`);
    }
  }
  return { store, files };
}

/** 该目录是否长得像 Chromium 的 Local Storage */
function looksLikeLocalStorage(lsDir) {
  try {
    if (!fs.existsSync(lsDir)) return false;
    const items = fs.readdirSync(lsDir);
    return items.includes('CURRENT') || items.some((f) => f.endsWith('.ldb'));
  } catch (e) {
    return false;
  }
}

/**
 * 取出某个键名在指定 origin 上的最新值。
 * @returns {{origin:string,name:string,seq:number,value:string}|null}
 */
function latestEntry(store, name, origin) {
  let best = null;
  for (const [k, v] of store) {
    const info = parseKey(k);
    if (info.name !== name) continue;
    if (origin !== undefined && info.origin !== origin) continue;
    if (!best || info.seq > best.seq) best = { ...info, value: decodeValue(v) };
  }
  return best;
}

/** 列出某键名在所有 origin 上的版本，按 origin / 序号排序 */
function listEntries(store, name) {
  const out = [];
  for (const [k, v] of store) {
    const info = parseKey(k);
    if (info.name !== name) continue;
    out.push({ ...info, value: decodeValue(v) });
  }
  return out.sort((a, b) => a.origin.localeCompare(b.origin) || a.seq - b.seq);
}

module.exports = {
  readVarint,
  snappyDecompress,
  readBlock,
  blockEntries,
  readTable,
  decodeValue,
  parseKey,
  readLocalStorageDir,
  looksLikeLocalStorage,
  latestEntry,
  listEntries,
};
