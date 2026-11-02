#!/usr/bin/env node
/**
 * 港澳台网点采集 CLI
 * =================================
 * 用法：
 *   node scripts/crawl-postal.js
 *   node scripts/crawl-postal.js --only=hk,mo
 *   node scripts/crawl-postal.js --dry-run
 *   node scripts/crawl-postal.js --output-dir=./output --delay=0.5
 *   node scripts/crawl-postal.js --date=20261102
 *
 * 参数：
 *   --only=hk,mo,tw,agencytw   只跑指定站点
 *   --output-dir=<dir>         输出目录（默认项目 output/）
 *   --delay=<秒>               请求间隔（默认 0.4）
 *   --timeout=<秒>             单次请求超时（默认 30）
 *   --attempts=<n>             最大尝试次数（默认 3）
 *   --dry-run                  只采集校验，不写 CSV
 *   --date=YYYYMMDD            指定批次日期（默认当天）
 *   --help                     显示帮助
 */

'use strict';

const { runAll } = require('../postal');

function printHelp() {
  console.log(`港澳台网点采集

用法:
  node scripts/crawl-postal.js [选项]

选项:
  --only=hk,mo,tw,agencytw   只跑指定站点
  --output-dir=<dir>         输出目录（默认项目 output/）
  --delay=<秒>               请求间隔（默认 0.4）
  --timeout=<秒>             单次请求超时（默认 30）
  --attempts=<n>             最大尝试次数（默认 3）
  --dry-run                  只采集校验，不写 CSV
  --date=YYYYMMDD            指定批次日期（默认当天）
  --help                     显示帮助

输出:
  output/posthk-YYYYMMDD.csv    地区,局名,代号,地址
  output/postmo-YYYYMMDD.csv    名称,地址
  output/posttw-YYYYMMDD.csv    邮递区号,局名,电脑局名,地址
  output/agencytw-YYYYMMDD.csv  邮递区号,局名,地址,管辖邮局

说明:
  CLI 只写 output/；base 更新确认仅在应用内抓取结束后弹出。
`);
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    if (raw === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = /^--([a-z-]+)=(.*)$/.exec(raw);
    if (!m) {
      throw new Error(`无法识别的参数: ${raw}`);
    }
    const key = m[1];
    const value = m[2];
    if (key === 'only') args.only = value;
    else if (key === 'output-dir') args.outputDir = value;
    else if (key === 'delay') args.delayMs = Math.max(0, Number(value) * 1000);
    else if (key === 'timeout') args.timeoutMs = Math.max(1000, Number(value) * 1000);
    else if (key === 'attempts') args.maxAttempts = Math.max(1, parseInt(value, 10) || 3);
    else if (key === 'date') args.date = value;
    else throw new Error(`未知参数: --${key}`);
  }
  return args;
}

(async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  const result = await runAll(args);
  process.exitCode = result.ok ? 0 : 1;
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
