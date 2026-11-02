/**
 * 港澳台网点采集 · 校验与去重
 * =================================
 * 规则：
 *   - 必填字段为空 → 丢弃并记录（不让空记录进 CSV）
 *   - 可选字段为空 → 保留空值并记录（需求允许「页面确实没提供」）
 *   - 邮递区号按字符串校验，保留前导零；格式不符 → 丢弃
 *   - 完全相同 / 同一业务键的重复记录 → 去重并记录
 *   - 结果为空、低于最低阈值、或分页明显不完整 → 抛错，调用方不得覆盖旧文件
 */

'use strict';

/** 统一空白：NBSP → 空格，连续空白折叠，去首尾 */
function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/**
 * @param {string} name 站点键（用于日志）
 * @param {object[]} records 原始记录（字段名与输出表头一致）
 * @param {object} spec { fields, required?, optional?, key?, postcodeField? }
 * @param {object} logger
 */
function validateRecords(name, records, spec, logger) {
  const fields = spec.fields;
  const required = new Set(spec.required || fields);
  const optional = spec.optional || [];
  const input = Array.isArray(records) ? records : [];

  const normalized = [];
  let dropped = 0;

  for (const raw of input) {
    const rec = {};
    for (const f of fields) rec[f] = normalizeText(raw ? raw[f] : '');
    const missing = [...required].filter((f) => !rec[f]);
    if (missing.length) {
      dropped++;
      if (dropped <= 5) {
        logger.warn(`[${name}] 丢弃缺失必填字段（${missing.join('、')}）的记录：${rec['局名'] || rec['名称'] || '(无名称)'}`);
      }
      continue;
    }
    normalized.push(rec);
  }

  if (dropped > 5) logger.warn(`[${name}] 其余 ${dropped - 5} 条缺失记录不再逐条输出`);

  // 邮递区号：字符串保存，校验前导零
  if (spec.postcodeField) {
    const field = spec.postcodeField;
    let bad = 0;
    let leadingZero = 0;
    for (let i = normalized.length - 1; i >= 0; i--) {
      const p = normalized[i][field];
      if (!/^\d{3}(\d{3})?$/.test(p)) {
        bad++;
        dropped++;
        if (bad <= 5) logger.warn(`[${name}] 邮递区号格式异常，丢弃：${p || '(空)'}（${normalized[i]['局名'] || ''}）`);
        normalized.splice(i, 1);
      } else if (p.startsWith('0')) {
        leadingZero++;
      }
    }
    if (bad > 5) logger.warn(`[${name}] 其余 ${bad - 5} 条邮递区号异常不再逐条输出`);
    if (leadingZero) logger.info(`[${name}] 已保留 ${leadingZero} 条邮递区号的前导零`);
  }

  // 可选字段为空：保留空值，但记录数量
  for (const f of optional) {
    const empty = normalized.filter((r) => !r[f]).length;
    if (empty) logger.warn(`[${name}] ${f} 为空 ${empty} 条（按需求保留空值）`);
  }

  // 去重：优先用业务键，否则用整行
  const keyFields = Array.isArray(spec.key) && spec.key.length ? spec.key : fields;
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const rec of normalized) {
    const key = keyFields.map((f) => rec[f]).join('\u0001');
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(rec);
  }
  if (duplicates) logger.warn(`[${name}] 去重 ${duplicates} 条重复记录`);

  return { records: unique, dropped, duplicates };
}

/**
 * 数量核验。
 * @param {string} name
 * @param {number} count 校验/去重后的记录数
 * @param {object} spec {
 *   sourceTotal?: number|null, 页面自己标注的总笔数
 *   min?: number,              最低可接受条数
 *   minRatio?: number,         sourceTotal 不完整时的容忍比例（默认 0.95）
 *   reference?: number|null,   文档中的参考条数
 *   tolerance?: number,        参考值差异容忍比例（默认 0.05）
 *   minReferenceRatio?: number, 低于参考值的该比例时判定为明显不完整
 * }
 * @param {object} logger
 * @returns {string[]} 警告信息
 */
function checkCount(name, count, spec, logger) {
  const warnings = [];

  if (!count) {
    throw new Error(`[${name}] 采集结果为空，拒绝用空文件覆盖已有数据`);
  }

  if (spec.min && count < spec.min) {
    throw new Error(`[${name}] 记录数 ${count} 低于最低阈值 ${spec.min}，判定为采集不完整`);
  }

  if (spec.sourceTotal != null) {
    if (count < spec.sourceTotal) {
      const ratio = count / spec.sourceTotal;
      const msg = `页面标注 ${spec.sourceTotal} 条，实际解析 ${count} 条（${(ratio * 100).toFixed(1)}%）`;
      if (ratio < (spec.minRatio == null ? 0.95 : spec.minRatio)) {
        throw new Error(`[${name}] ${msg}，判定为采集不完整`);
      }
      warnings.push(msg);
      logger.warn(`[${name}] ${msg}`);
    } else if (count > spec.sourceTotal) {
      const msg = `实际解析 ${count} 条，多于页面标注 ${spec.sourceTotal} 条`;
      warnings.push(msg);
      logger.warn(`[${name}] ${msg}`);
    }
  }

  if (spec.reference != null) {
    const diff = count - spec.reference;
    const tolerance = spec.tolerance == null ? 0.05 : spec.tolerance;
    const limit = spec.reference * tolerance;
    const diffText = `${diff > 0 ? '+' : ''}${diff}`;

    if (spec.minReferenceRatio != null && count < spec.reference * spec.minReferenceRatio) {
      throw new Error(
        `[${name}] 记录数 ${count} 仅为参考值 ${spec.reference} 的 ` +
        `${((count / spec.reference) * 100).toFixed(1)}%，判定为明显不完整`
      );
    }

    if (Math.abs(diff) > limit) {
      const msg = `记录数 ${count} 与参考值 ${spec.reference} 相差 ${diffText}（超过 ±${(tolerance * 100).toFixed(0)}%）`;
      warnings.push(msg);
      logger.warn(`[${name}] ${msg}`);
    } else if (diff !== 0) {
      logger.info(`[${name}] 记录数 ${count} 与参考值 ${spec.reference} 相差 ${diffText}（在容忍范围内）`);
    }
  }

  return warnings;
}

module.exports = { normalizeText, validateRecords, checkCount };
