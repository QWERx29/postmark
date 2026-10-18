#!/usr/bin/env node
/**
 * server.js 回归测试
 * ==================
 * 抽服务器是纯重构，因此这里逐条比对"抽之前 main.js 提供的行为"是否仍然成立：
 *   路由状态码、API 响应结构、静态文件、路径穿越防护、端口占用时的明确报错。
 *
 *   node scripts/test-server.js
 *
 * 用随机端口跑，不碰 19876，因此不会影响正在运行的应用实例。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Server = require('../server.js');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok]   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}\n         ${e.message}`);
  }
}

async function get(base, p, init) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function main() {
  // 随机端口：port 0 让内核分配，避免和正在运行的应用抢占 19876
  const started = await Server.start({ root: ROOT, port: 0 });
  const base = `http://127.0.0.1:${started.port}`;
  console.log(`\n服务器测试实例: ${base}\n`);

  try {
    console.log('--- 静态文件 ---');
    const index = await get(base, '/');
    check('/ 返回 200 且是 HTML', () => {
      assert.strictEqual(index.status, 200);
      assert.ok(index.text.includes('新一代日戳管理系统'));
      assert.ok(index.headers.get('content-type').includes('text/html'));
    });
    const css = await get(base, '/css/style.css');
    check('/css/style.css 返回 200 且 MIME 正确', () => {
      assert.strictEqual(css.status, 200);
      assert.ok(css.headers.get('content-type').includes('text/css'));
    });
    const js = await get(base, '/js/app.js');
    check('/js/app.js 返回 200', () => assert.strictEqual(js.status, 200));
    const geojson = await get(base, '/geo/110000_full.json');
    check('/geo/*.json 返回 200', () => assert.strictEqual(geojson.status, 200));

    console.log('\n--- API ---');
    const provinces = await get(base, '/api/crawl/provinces');
    const provinceList = JSON.parse(provinces.text);
    check('/api/crawl/provinces 返回省份数组', () => {
      assert.strictEqual(provinces.status, 200);
      assert.ok(Array.isArray(provinceList) && provinceList.length > 0);
    });

    const baseFiles = await get(base, '/api/base-files');
    const baseList = JSON.parse(baseFiles.text);
    check('/api/base-files 返回 CSV 列表（含 name/size/mtime）', () => {
      assert.strictEqual(baseFiles.status, 200);
      assert.ok(Array.isArray(baseList) && baseList.length > 0);
      assert.ok(baseList.every((f) => f.name && typeof f.size === 'number' && typeof f.mtime === 'number'));
      assert.ok(baseList.every((f) => f.name.toLowerCase().endsWith('.csv')));
    });

    const outFiles = await get(base, '/api/output-files');
    check('/api/output-files 返回数组', () => {
      assert.strictEqual(outFiles.status, 200);
      assert.ok(Array.isArray(JSON.parse(outFiles.text)));
    });

    const status404 = await get(base, '/api/crawl/status?job=nonexistent');
    check('/api/crawl/status 未知作业返回 404', () => {
      assert.strictEqual(status404.status, 404);
      assert.ok(JSON.parse(status404.text).error);
    });

    console.log('\n--- 方法限制 ---');
    const postToStatic = await get(base, '/api/base-files', { method: 'POST' });
    check('非放行接口的 POST 返回 405', () => assert.strictEqual(postToStatic.status, 405));

    const badJson = await get(base, '/api/crawl/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    check('/api/crawl/start 非法 JSON 返回 400', () => {
      assert.strictEqual(badJson.status, 400);
      assert.ok(JSON.parse(badJson.text).error.includes('JSON'));
    });

    const unknownKind = await get(base, '/api/crawl/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nope' }),
    });
    check('/api/crawl/start 未知 kind 返回 400', () => {
      assert.strictEqual(unknownKind.status, 400);
      assert.ok(JSON.parse(unknownKind.text).error.includes('未知的作业类型'));
    });

    console.log('\n--- 路径穿越防护 ---');
    // 用原始 socket 发请求：fetch/Invoke-WebRequest 会在客户端把 ../ 规范化掉，
    // 那样测的就不是服务器了。
    const net = require('net');
    const raw = (p) => new Promise((resolve) => {
      const s = net.connect(started.port, '127.0.0.1', () => {
        s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      s.on('data', (d) => { buf += d.toString('latin1'); });
      s.on('end', () => resolve(parseInt((buf.split(' ')[1] || '0'), 10)));
      s.on('error', () => resolve(-1));
    });

    const escape1 = await raw('/base/../server.js');    check('  → /base/../server.js 得到 403', () => assert.strictEqual(escape1, 403));
    const escape2 = await raw('/base/%2e%2e/server.js');
    check('  → /base/%2e%2e/server.js 得到 403', () => assert.strictEqual(escape2, 403));
    const escape3 = await raw('/output/../main.js');
    check('  → /output/../main.js 得到 403', () => assert.strictEqual(escape3, 403));

    console.log('\n--- 端口占用行为 ---');
    // 固定端口被占用时必须明确报错，而不是悄悄换随机端口
    // （换端口 = 换 origin = 浏览器里的记录"消失"）
    let err = null;
    try {
      await Server.start({ root: ROOT, port: started.port });
    } catch (e) {
      err = e;
    }
    check('端口被占用时 start() 以 EADDRINUSE 拒绝，不静默换端口', () => {
      assert.ok(err, '期望抛出错误，实际成功启动');
      assert.strictEqual(err.code, 'EADDRINUSE');
    });

    console.log('\n--- 目录解析 ---');
    const paths = started.paths;
    check('resolveBaseDir 指向项目 base/', () => {
      assert.strictEqual(path.resolve(paths.resolveBaseDir()), path.resolve(ROOT, 'base'));
    });
    check('resolveOutputDir 指向项目 output/ 且可写', () => {
      assert.strictEqual(path.resolve(paths.resolveOutputDir()), path.resolve(ROOT, 'output'));
      fs.accessSync(paths.resolveOutputDir(), fs.constants.W_OK);
    });
    check('compareExeCandidates 含 txt_compare.exe', () => {
      assert.ok(paths.compareExeCandidates().some((p) => p.endsWith('txt_compare.exe')));
    });
  } finally {
    await Server.stop(started.server);
  }

  console.log(`\n===== ${passed} 通过, ${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身出错:', e);
  process.exit(1);
});
