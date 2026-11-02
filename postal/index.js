/**
 * 港澳台网点采集 · 入口
 * =================================
 * 四个站点分别采集，输出带日期后缀的四份 CSV：
 *   output/posthk-YYYYMMDD.csv    地区,局名,代号,地址
 *   output/postmo-YYYYMMDD.csv    名称,地址
 *   output/posttw-YYYYMMDD.csv    邮递区号,局名,电脑局名,地址
 *   output/agencytw-YYYYMMDD.csv  邮递区号,局名,地址,管辖邮局
 *
 * 设计要点：
 *   - 接口优先：香港、澳门直接走官网 JSON 接口；台湾两个页面直接解析 HTML。
 *   - 单站失败不影响其它站；失败时不写文件，保留上一次的有效结果。
 *   - 全部校验通过后才原子替换目标 CSV。
 *   - 四份文件与省级 POST/SPB 文件的字段结构不同，crawler-engine 的对比扫描
 *     已按前缀排除它们，避免被当成 posthk / postmo / posttw 前缀。
 *   - 抓取完成后由 UI 询问是否复制到 base/{prefix}+base.csv；本模块只产出 output。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { createLogger } = require('./logger');
const { createHttpClient } = require('./http-client');
const { writeCsvAtomic } = require('./csv-exporter');
const { validateRecords, checkCount } = require('./validators');

const hk = require('./collectors/hk');
const mo = require('./collectors/mo');
const tw = require('./collectors/tw');
const agencytw = require('./collectors/agencytw');

const SITES = [
  {
    key: 'hk',
    label: '香港邮政',
    prefix: 'posthk',
    baseFile: 'posthk+base.csv',
    header: ['地区', '局名', '代号', '地址'],
    collect: hk.collect,
    validate: {
      fields: ['地区', '局名', '代号', '地址'],
      required: ['地区', '局名', '代号', '地址'],
      key: ['代号'],
      min: 50,
    },
  },
  {
    key: 'mo',
    label: '澳门邮电局',
    prefix: 'postmo',
    baseFile: 'postmo+base.csv',
    header: ['名称', '地址'],
    collect: mo.collect,
    validate: {
      fields: ['名称', '地址'],
      required: ['名称', '地址'],
      key: ['名称', '地址'],
      min: 5,
    },
  },
  {
    key: 'tw',
    label: '台湾普通邮局',
    prefix: 'posttw',
    baseFile: 'posttw+base.csv',
    header: ['邮递区号', '局名', '电脑局名', '地址'],
    collect: tw.collect,
    validate: {
      fields: ['邮递区号', '局名', '电脑局名', '地址'],
      required: ['邮递区号', '局名', '地址'],
      optional: ['电脑局名'],
      key: ['局名', '地址'],
      postcodeField: '邮递区号',
      min: 100,
      reference: 1277,
      tolerance: 0.05,
      minReferenceRatio: 0.9,
      minRatio: 0.95,
    },
  },
  {
    key: 'agencytw',
    label: '台湾邮政代办所',
    prefix: 'agencytw',
    baseFile: 'agencytw+base.csv',
    header: ['邮递区号', '局名', '地址', '管辖邮局'],
    collect: agencytw.collect,
    validate: {
      fields: ['邮递区号', '局名', '地址', '管辖邮局'],
      required: ['邮递区号', '局名', '地址'],
      optional: ['管辖邮局'],
      key: ['局名', '地址'],
      postcodeField: '邮递区号',
      min: 50,
      reference: 377,
      tolerance: 0.05,
      minReferenceRatio: 0.9,
      minRatio: 0.95,
    },
  },
];

function resolveOutputDir(outputDir) {
  if (outputDir) return path.resolve(outputDir);
  return path.resolve(__dirname, '..', 'output');
}

function parseOnly(only) {
  if (!only) return null;
  const list = Array.isArray(only) ? only : String(only).split(',');
  const keys = list.map((s) => String(s).trim()).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地日期 YYYYMMDD，与大陆 output/postxx-YYYYMMDD.csv 保持一致 */
function dateStr(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function resolveRunDate(value) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return dateStr();
  if (!/^\d{8}$/.test(s)) throw new Error('日期格式应为 YYYYMMDD');
  return s;
}

/**
 * 运行四类采集。
 * @param {object} [opts]
 * @param {string} [opts.outputDir]  输出目录，默认 <项目>/output
 * @param {string[]|string} [opts.only] 只跑指定站点（hk/mo/tw/agencytw）
 * @param {number} [opts.delayMs]    请求间隔（毫秒），默认 400
 * @param {number} [opts.timeoutMs]  单次请求超时，默认 30000
 * @param {number} [opts.maxAttempts] 最大尝试次数，默认 3
 * @param {boolean} [opts.dryRun]    只采集校验、不写文件
 * @param {string} [opts.date]       批次日期 YYYYMMDD，默认当天
 * @param {Function} [opts.onLine]   日志逐行回调（服务端作业用）
 */
async function runAll(opts = {}) {
  const outputDir = resolveOutputDir(opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const runDate = resolveRunDate(opts.date);

  const logger = createLogger({ dir: outputDir, onLine: opts.onLine });
  const http = createHttpClient({
    logger,
    timeoutMs: opts.timeoutMs || 30000,
    maxAttempts: opts.maxAttempts || 3,
    delayMs: opts.delayMs == null ? 400 : opts.delayMs,
  });

  const only = parseOnly(opts.only);
  if (only) {
    const known = new Set(SITES.map((s) => s.key));
    for (const key of only) {
      if (!known.has(key)) logger.warn(`未知站点 "${key}"，可用值: ${SITES.map((s) => s.key).join(', ')}`);
    }
  }

  logger.info('='.repeat(60));
  logger.info('港澳台邮政网点采集');
  logger.info(`输出目录: ${outputDir}`);
  logger.info(`批次日期: ${runDate}`);
  logger.info(`Node: ${process.version}`);
  logger.info(`模式: ${opts.dryRun ? '干跑（不写文件）' : '正式采集'}`);
  logger.info('='.repeat(60));

  const summary = [];

  for (const site of SITES) {
    if (only && !only.has(site.key)) {
      logger.info(`[${site.key}] 跳过（--only 未选中）`);
      continue;
    }

    const started = Date.now();
    const outputFile = `${site.prefix}-${runDate}.csv`;
    const filePath = path.join(outputDir, outputFile);
    logger.info(`[${site.key}] 开始采集 ${site.label} ...`);

    try {
      const result = await site.collect({ http, logger, outputDir });
      const validated = validateRecords(site.key, result.records, site.validate, logger);
      const countWarnings = checkCount(site.key, validated.records.length, Object.assign(
        {},
        site.validate,
        { sourceTotal: result.sourceTotal }
      ), logger);

      const rows = validated.records.map((r) => site.header.map((f) => r[f]));

      let written = null;
      if (opts.dryRun) {
        logger.info(`[${site.key}] 干跑模式：未写入 ${outputFile}`);
      } else {
        written = writeCsvAtomic(filePath, site.header, rows);
        logger.info(
          `[${site.key}] 已写入 ${written.filePath}（${written.rows} 条，${written.bytes} 字节，UTF-8 BOM）`
        );
      }

      summary.push({
        key: site.key,
        label: site.label,
        prefix: site.prefix,
        baseFile: site.baseFile,
        fileName: outputFile,
        status: countWarnings.length ? 'warning' : 'ok',
        count: validated.records.length,
        file: written ? written.filePath : null,
        dropped: validated.dropped,
        duplicates: validated.duplicates,
        warnings: countWarnings,
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      logger.error(`[${site.key}] 采集失败: ${e.message}`);
      if (e.context) logger.error(`[${site.key}] 响应摘要: ${e.context}`);
      logger.error(`[${site.key}] 未写入 ${outputFile}，保留上一次的有效文件（如有）`);
      summary.push({
        key: site.key,
        label: site.label,
        prefix: site.prefix,
        baseFile: site.baseFile,
        fileName: outputFile,
        status: 'failed',
        count: 0,
        file: null,
        error: e.message,
        elapsedMs: Date.now() - started,
      });
    }
  }

  logger.info('');
  logger.info('='.repeat(60));
  logger.info('运行摘要');
  if (!summary.length) logger.info('  （没有执行任何站点）');
  for (const item of summary) {
    const parts = [`  ${item.key.padEnd(9)} ${item.status.padEnd(8)}`];
    if (item.status === 'failed') {
      parts.push(`失败: ${item.error}`);
    } else {
      parts.push(`${item.count} 条`);
      parts.push(item.file ? `→ ${item.fileName || item.file}` : '（未写入）');
      if (item.dropped) parts.push(`丢弃 ${item.dropped}`);
      if (item.duplicates) parts.push(`去重 ${item.duplicates}`);
      if (item.warnings && item.warnings.length) parts.push(`警告 ${item.warnings.length}`);
    }
    parts.push(`${(item.elapsedMs / 1000).toFixed(1)}s`);
    logger.info(parts.join('  '));
  }
  logger.info(`日志: ${logger.file}`);
  logger.info('='.repeat(60));
  logger.close();

  return {
    ok: summary.length > 0 && summary.every((s) => s.status !== 'failed'),
    summary,
    outputDir,
    logFile: logger.file,
    date: runDate,
  };
}

module.exports = { SITES, runAll };

// 允许直接 `node postal/index.js` 跑全部站点；带参数的入口见 scripts/crawl-postal.js
if (require.main === module) {
  runAll()
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exitCode = 1;
    });
}
