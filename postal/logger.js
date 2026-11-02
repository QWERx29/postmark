/**
 * 港澳台网点采集 · 轻量日志
 * =================================
 * 现有 crawler-engine 的日志绑定在「爬取作业」对象上，供主进程 UI 轮询；
 * 本模块可被独立 CLI 或 server.js 的采集作业调用，直接写控制台 +
 * output/postal-crawl-<时间戳>.log；onLine 回调供服务端把日志回传前端。
 *
 * 只记录请求 URL、状态码、耗时、解析数量与异常原因，不记录 Cookie / 认证头。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function timeText(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * @param {object} opts
 * @param {string} opts.dir      日志目录（通常是 output/）
 * @param {string} [opts.prefix] 文件名前缀
 * @param {Function} [opts.onLine] 每写一行回调一次（供服务端作业轮询）
 * @returns {{file:string, info:Function, warn:Function, error:Function, close:Function}}
 */
function createLogger(opts = {}) {
  const dir = opts.dir || process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.prefix || 'postal-crawl'}-${stamp()}.log`);
  let closed = false;

  function write(level, msg) {
    const line = `[${timeText()}] [${level}] ${msg}`;
    if (typeof opts.onLine === 'function') {
      try { opts.onLine(line); } catch (e) { /* 回调失败不能反过来中断采集 */ }
    }
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    if (!closed) {
      try {
        fs.appendFileSync(file, line + '\n', 'utf8');
      } catch (e) {
        // 日志写失败不能反过来中断采集
        console.error(`[日志写入失败] ${e.message}`);
      }
    }
  }

  return {
    file,
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    close: () => { closed = true; },
  };
}

module.exports = { createLogger, stamp, timeText };
