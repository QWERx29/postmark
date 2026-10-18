#!/usr/bin/env node
/**
 * 本地开发 registry 回归测试
 * ==========================
 * 这套 registry 是为了绕过本机 schannel 故障而写的，路径规则一旦错就会
 * 变成 cargo 一句无从下手的 502（已经踩过一次）。因此这里对新版服务器
 * 逐条断言路由行为，而不是靠手工 curl 猜。
 *
 *   node scripts/test-dev-registry.js
 *
 * 需要联网（会真的去 index.crates.io / static.crates.io 取数据）。
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createRegistryServer, indexPathFor } = require('./lib/dev-registry');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.rust', 'registry-cache-test');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  [ok]   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}\n         ${e.message}`);
  }
};

async function main() {
  console.log('\n--- 索引路径规则（对照上游实测结果）---');
  check('anyhow(6) -> an/yh/anyhow', () => assert.strictEqual(indexPathFor('anyhow'), 'an/yh/anyhow'));
  check('syn(3) -> 3/s/syn', () => assert.strictEqual(indexPathFor('syn'), '3/s/syn'));
  check('libc(4) -> li/bc/libc', () => assert.strictEqual(indexPathFor('libc'), 'li/bc/libc'));
  check('serde(5) -> se/rd/serde', () => assert.strictEqual(indexPathFor('serde'), 'se/rd/serde'));
  check('windows_i686_msvc -> wi/nd/windows_i686_msvc',
    () => assert.strictEqual(indexPathFor('windows_i686_msvc'), 'wi/nd/windows_i686_msvc'));
  check('大写与连字符被规范化 (Foo-Bar -> fo/o_/foo_bar)',
    () => assert.strictEqual(indexPathFor('Foo-Bar'), 'fo/o_/foo_bar'));
  check('单字符 a -> 1/a', () => assert.strictEqual(indexPathFor('a'), '1/a'));
  check('双字符 io -> 2/io', () => assert.strictEqual(indexPathFor('io'), '2/io'));

  // 用独立缓存目录，避免污染真实构建缓存
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });

  // 主动播种一份"上游形态"的 config.json（dl 指向 https 官方地址）。
  // 这样测试就不依赖缓存里恰好是什么内容：
  // 本机已有真实 registry 在跑时，它会往缓存写入 dl=127.0.0.1:19780 的版本，
  // 而测试用随机端口，若不播种就会因端口不同而误报失败。
  fs.mkdirSync(path.join(CACHE_DIR, 'index'), { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, 'index', 'config.json'),
    JSON.stringify({ dl: 'https://static.crates.io/crates', api: 'https://crates.io' })
  );

  const server = createRegistryServer({
    cacheDir: CACHE_DIR,
    port: 0,
    log: () => {},                                  // 测试期间静音
    error: (m) => console.error(m),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n测试用 registry: ${base}\n`);

  const get = async (p) => {
    const res = await fetch(base + p);
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, text: buf.toString('utf8') };
  };

  try {
    console.log('--- config.json ---');
    const cfg = await get('/config.json');
    check('/config.json 返回 200', () => assert.strictEqual(cfg.status, 200));
    const cfgJson = JSON.parse(cfg.text);
    // 断言 dl 指向**本服务器实际监听的端口**，而不是一个写死的常量：
    // 端口取值逻辑一旦出错（例如把 port=0 当成"未提供"而退回默认值），
    // 测试就会失败，而不是恰好通过。
    check('dl 指向本服务器实际监听端口（否则 cargo 会拿到错误地址）', () =>
      assert.strictEqual(cfgJson.dl, `http://127.0.0.1:${port}/crates`));
    check('api 置空（本地不提供 Web API）', () => assert.strictEqual(cfgJson.api, null));

    const cfg2 = await get('/index/config.json');
    check('/index/config.json 也提供 config.json（路径差异不该变成 502）', () =>
      assert.strictEqual(cfg2.status, 200));

    console.log('\n--- 索引 ---');
    const idx = await get('/index/an/yh/anyhow');
    check('/index/an/yh/anyhow 返回 200 且是 JSON lines', () => {
      assert.strictEqual(idx.status, 200);
      const first = idx.text.trim().split('\n')[0];
      const obj = JSON.parse(first);
      assert.strictEqual(obj.name, 'anyhow');
    });
    const idxCached = await get('/index/an/yh/anyhow');
    check('二次请求走缓存且内容一致', () => {
      assert.strictEqual(idxCached.status, 200);
      assert.ok(idxCached.buf.equals(idx.buf));
    });
    check('缓存确实落盘', () =>
      assert.ok(fs.existsSync(path.join(CACHE_DIR, 'index', 'an', 'yh', 'anyhow'))));

    const idx404 = await get('/index/zz/zz/definitely_not_a_real_crate_xyz');
    check('不存在的包回 404（而不是 502）', () => assert.strictEqual(idx404.status, 404));

    console.log('\n--- crate 下载与校验 ---');
    // serde 的官方 checksum 从 Cargo.lock 读，用来验证完整性
    const lock = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.lock'), 'utf8');
    const serde = /name = "serde"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([0-9a-f]+)"/.exec(lock);
    check('Cargo.lock 中能找到 serde 的官方 checksum', () => assert.ok(serde));

    const crate = await get(`/crates/serde/${serde[1]}/download`);
    check(`/crates/serde/${serde[1]}/download 返回 200`, () => assert.strictEqual(crate.status, 200));
    check('下载内容 sha256 与 Cargo.lock 官方值一致（证明完整性未降低）', () => {
      const got = crypto.createHash('sha256').update(crate.buf).digest('hex');
      assert.strictEqual(got, serde[2]);
    });
    const crateCached = await get(`/crates/serde/${serde[1]}/download`);
    check('crate 二次请求走缓存且一致', () => assert.ok(crateCached.buf.equals(crate.buf)));

    const crate404 = await get('/crates/nope/9.9.9/download');
    check('不存在的 crate 回 404', () => assert.strictEqual(crate404.status, 404));

    console.log('\n--- 其它 ---');
    const unknown = await get('/whatever');
    check('未知路径回 404 且带说明', () => {
      assert.strictEqual(unknown.status, 404);
      assert.ok(unknown.text.includes('registry'));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n===== ${passed} 通过, ${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身出错:', e);
  process.exit(1);
});
