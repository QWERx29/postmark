/**
 * 港澳台网点采集 · CSV 导出
 * =================================
 * 需求要求 UTF-8 with BOM、固定表头、标准转义、原子替换。
 * 项目没有 csv-stringify / csv-writer，这里实现 RFC 4180 所需的转义规则，
 * 不直接用 array.join(',')。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 按 RFC 4180 转义单个字段：含逗号、双引号、CR/LF 时整体加引号，内部引号翻倍 */
function escapeField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 生成完整 CSV 文本。
 * @param {string[]} header
 * @param {Array<Array<*>>} rows
 * @param {{bom?:boolean, eol?:string}} [opts]
 */
function serializeCsv(header, rows, opts = {}) {
  if (!Array.isArray(header) || header.length === 0) {
    throw new Error('CSV 表头为空');
  }
  const bom = opts.bom !== false;
  const eol = opts.eol || '\r\n';
  const lines = [header.map(escapeField).join(',')];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== header.length) {
      throw new Error(
        `CSV 第 ${i + 1} 行列数不匹配：期望 ${header.length}，实际 ${row ? row.length : '非数组'}`
      );
    }
    lines.push(row.map(escapeField).join(','));
  }

  return (bom ? '\uFEFF' : '') + lines.join(eol) + eol;
}

/**
 * 先写临时文件再 rename，避免中断时留下半份 CSV。
 * 同目录写入，保证 rename 不跨卷。
 */
function writeCsvAtomic(filePath, header, rows) {
  const content = serializeCsv(header, rows);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略清理失败 */ }
    throw e;
  }

  return {
    filePath,
    bytes: Buffer.byteLength(content, 'utf8'),
    rows: rows.length,
  };
}

module.exports = { escapeField, serializeCsv, writeCsvAtomic };
