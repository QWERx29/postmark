/**
 * 港澳台网点 · 把一次抓取结果复制到 base/
 * =========================================
 * 只在用户确认后调用。目标文件名固定为：
 *   base/posthk+base.csv
 *   base/postmo+base.csv
 *   base/posttw+base.csv
 *   base/agencytw+base.csv
 *
 * 复制的是 output 中已经写好的 UTF-8 BOM / CRLF 文件本身，不重新编码；
 * 先写同目录临时文件再 rename，避免中途失败留下半份 base。
 *
 * 设计取舍：
 *   - 只处理 status !== 'failed' 且有 file 的站点；失败站点保留旧 base。
 *   - 不删除 base 中其它文件，也不写 base_old.csv（港澳台没有大陆的撤销/更名归档语义）。
 *   - dryRun 的 summary.file 为 null，因此不会误把干跑结果写进 base。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function copyFileAtomic(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略清理失败 */ }
    throw e;
  }
}

/**
 * @param {Array<object>} summary runAll() 的 summary
 * @param {{baseDir:string}} opts
 * @returns {{updated:number, files:Array<object>, errors:string[], baseDir:string}}
 */
function applyToBase(summary, opts = {}) {
  const baseDir = path.resolve(opts.baseDir || path.join(__dirname, '..', 'base'));
  const files = [];
  const errors = [];

  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch (e) {
    return {
      updated: 0,
      files: [],
      errors: [`无法创建 base 目录 ${baseDir}: ${e.message || e}`],
      baseDir,
    };
  }

  for (const item of Array.isArray(summary) ? summary : []) {
    if (!item || item.status === 'failed' || !item.file) continue;

    const baseFile = String(item.baseFile || '').trim();
    if (!baseFile || path.basename(baseFile) !== baseFile) {
      errors.push(`${item.key || '未知站点'}: base 文件名为空或非法`);
      continue;
    }

    const src = path.resolve(item.file);
    try {
      if (!fs.statSync(src).isFile()) {
        errors.push(`${baseFile}: 源文件不是普通文件`);
        continue;
      }
    } catch (e) {
      errors.push(`${baseFile}: 源文件不存在（${e.message || e}）`);
      continue;
    }

    const dst = path.join(baseDir, baseFile);
    try {
      copyFileAtomic(src, dst);
      files.push({
        key: item.key,
        source: src,
        baseFile,
        target: dst,
      });
    } catch (e) {
      errors.push(`${baseFile}: 写入失败（${e.message || e}）`);
    }
  }

  return { updated: files.length, files, errors, baseDir };
}

module.exports = { applyToBase };
