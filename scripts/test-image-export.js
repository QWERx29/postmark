#!/usr/bin/env node
/**
 * 图片导出接口回归测试
 * ====================
 * 「录入日戳 → 上传图片」的落盘链路全部经过 /api/images/*，这里逐条验证：
 *   配置读取、重名检测、原子保存、覆盖/自动编号策略、内容校验（魔数）、
 *   路径穿越防护、静态预览、删除、目录列表。
 *
 *   node scripts/test-image-export.js
 *
 * 用随机端口 + 临时目录跑，不碰 19876，也不写项目里的 output/，
 * 因此不会影响正在运行的应用实例和已有数据。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// ---- 临时目录：必须先于 server.js 的 createPaths() 设好环境变量 ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'postmark-img-test-'));
process.env.POSTMARK_OUTPUT_DIR = path.join(TMP_ROOT, 'output');
process.env.POSTMARK_IMAGES_DIR = path.join(TMP_ROOT, 'images');

const Server = require(path.join(ROOT, 'server.js'));

const IMAGES_DIR = process.env.POSTMARK_IMAGES_DIR;

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

async function req(base, p, init) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
}

function postJson(base, p, body) {
  return req(base, p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ============================================================
// 图片夹具：构造真实字节，让魔数校验走的是「像真图片」的输入
// ============================================================

/** 1×1 真 PNG */
function makePng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);           // width
  ihdr.writeUInt32BE(1, 4);           // height
  ihdr[8] = 8;                        // bit depth
  ihdr[9] = 6;                        // color type: RGBA
  const idat = zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00, 0xff]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 最小 JPEG 头（足以通过 SOI 魔数校验；本测试不解析内容） */
function makeJpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function dataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const PNG = makePng();
const JPEG = makeJpeg();
const PNG_URL = dataUrl(PNG, 'image/png');
const JPEG_URL = dataUrl(JPEG, 'image/jpeg');

// ============================================================
// 主流程
// ============================================================

async function main() {
  const started = await Server.start({ root: ROOT, port: 0 });
  const base = `http://127.0.0.1:${started.port}`;
  console.log(`\n服务器测试实例: ${base}`);
  console.log(`图片目录: ${IMAGES_DIR}\n`);

  const recId = 'rec001';
  // 注意：扩展名必须与内容相符，否则会被魔数校验拒掉（这正是要测的行为之一）
  const name = '10000123_2026093015_中南海邮政支局_01.png';
  const jpgName = '10000123_2026093015_中南海邮政支局_01.jpg';

  try {
    // ---------- 配置 ----------
    console.log('--- 配置与列表 ---');
    const cfg = await req(base, '/api/images/config');
    check('/api/images/config 返回图片目录', () => {
      assert.strictEqual(cfg.status, 200);
      const d = cfg.json();
      assert.strictEqual(path.resolve(d.imagesDir), path.resolve(IMAGES_DIR));
      assert.strictEqual(d.custom, true, '环境变量指定的目录应标记为 custom');
      assert.ok(d.maxFileBytes > 0);
    });

    const emptyList = await req(base, '/api/images/list?subdir=' + encodeURIComponent(recId));
    check('空目录的列表返回空数组而不是报错', () => {
      assert.strictEqual(emptyList.status, 200);
      assert.deepStrictEqual(emptyList.json().files, []);
    });

    // ---------- 保存 ----------
    console.log('\n--- 保存 ---');
    const save1 = await postJson(base, '/api/images/save', {
      dataUrl: PNG_URL, fileName: name, subdir: recId, conflict: 'error',
    });
    check('POST /api/images/save 保存成功', () => {
      assert.strictEqual(save1.status, 200, save1.text);
      const d = save1.json();
      assert.strictEqual(d.ok, true);
      assert.strictEqual(d.relPath, `${recId}/${name}`);
      assert.strictEqual(d.size, PNG.length);
      assert.strictEqual(d.renamed, false);
    });
    check('文件真的落盘且字节完全一致', () => {
      const p = path.join(IMAGES_DIR, recId, name);
      assert.ok(fs.existsSync(p), `文件不存在: ${p}`);
      assert.ok(fs.readFileSync(p).equals(PNG), '写出的内容与输入不一致');
    });
    check('目录里没有残留 .part 临时文件', () => {
      const left = fs.readdirSync(path.join(IMAGES_DIR, recId)).filter((f) => f.endsWith('.part'));
      assert.deepStrictEqual(left, [], `残留: ${left.join(', ')}`);
    });

    // ---------- 重名策略 ----------
    console.log('\n--- 重名策略 ---');
    const exists1 = await req(base,
      `/api/images/exists?name=${encodeURIComponent(name)}&subdir=${encodeURIComponent(recId)}`);
    check('/api/images/exists 能发现同名文件', () => {
      assert.strictEqual(exists1.status, 200);
      const d = exists1.json();
      assert.strictEqual(d.exists, true);
      assert.strictEqual(d.size, PNG.length);
    });

    const dup = await postJson(base, '/api/images/save', {
      dataUrl: PNG_URL, fileName: name, subdir: recId, conflict: 'error',
    });
    check('conflict=error 时返回 409 且带 conflict 标记', () => {
      assert.strictEqual(dup.status, 409, dup.text);
      const d = dup.json();
      assert.strictEqual(d.conflict, true);
      assert.ok(/已存在/.test(d.error), d.error);
    });

    const renamed = await postJson(base, '/api/images/save', {
      dataUrl: PNG_URL, fileName: name, subdir: recId, conflict: 'rename',
    });
    check('conflict=rename 自动加序号', () => {
      assert.strictEqual(renamed.status, 200, renamed.text);
      const d = renamed.json();
      assert.strictEqual(d.renamed, true);
      assert.ok(/_1\.png$/.test(d.fileName), d.fileName);
    });

    // 先无冲突地写入一张 JPEG，再用不同字节覆盖它
    const jpgFirst = await postJson(base, '/api/images/save', {
      dataUrl: JPEG_URL, fileName: jpgName, subdir: recId, conflict: 'error',
    });
    const jpgSecond = Buffer.concat([JPEG, Buffer.from('/* overwrite marker */', 'latin1')]);
    const jpgSecondUrl = dataUrl(jpgSecond, 'image/jpeg');
    const overwritten = await postJson(base, '/api/images/save', {
      dataUrl: jpgSecondUrl, fileName: jpgName, subdir: recId, conflict: 'overwrite',
    });
    check('conflict=overwrite 原地覆盖', () => {
      assert.strictEqual(jpgFirst.status, 200, jpgFirst.text);
      assert.strictEqual(overwritten.status, 200, overwritten.text);
      assert.strictEqual(overwritten.json().overwritten, true);
      const onDisk = fs.readFileSync(path.join(IMAGES_DIR, recId, jpgName));
      assert.ok(onDisk.equals(jpgSecond), '磁盘内容不是覆盖后的新字节');
    });

    // ---------- 校验与防穿越 ----------
    console.log('\n--- 校验与安全 ---');
    const badMagic = await postJson(base, '/api/images/save', {
      dataUrl: dataUrl(Buffer.from('这不是图片，只是文本'), 'image/png'),
      fileName: 'fake.png', subdir: recId,
    });
    check('内容与扩展名不符时拒绝写入', () => {
      assert.strictEqual(badMagic.status, 400, badMagic.text);
      assert.ok(/不匹配/.test(badMagic.json().error));
      assert.ok(!fs.existsSync(path.join(IMAGES_DIR, recId, 'fake.png')));
    });

    const traversal = await postJson(base, '/api/images/save', {
      dataUrl: PNG_URL, fileName: '../../escaped.png', subdir: '../../..',
    });
    check('路径穿越被拦在图片目录内', () => {
      assert.strictEqual(traversal.status, 200, traversal.text);
      const d = traversal.json();
      // 文件名里出现 '..' 是允许的（'_.._x.png' 本身是合法文件名），
      // 不允许的是它**逃出**图片目录
      assert.ok(!d.fileName.includes('/') && !d.fileName.includes('\\'), d.fileName);
      assert.ok(!d.relPath.startsWith('../') && !d.relPath.includes('/../'), d.relPath);
      const resolved = path.resolve(IMAGES_DIR, d.relPath);
      assert.ok(resolved.startsWith(path.resolve(IMAGES_DIR) + path.sep), resolved);
      assert.ok(fs.existsSync(resolved), `应当落在图片目录内: ${resolved}`);
      assert.ok(!fs.existsSync(path.join(TMP_ROOT, 'escaped.png')));
      assert.ok(!fs.existsSync(path.join(path.dirname(TMP_ROOT), 'escaped.png')));
    });

    const traversalGet = await req(base, '/images/..%2F..%2Fsecret.txt');
    check('GET /images/ 的路径穿越返回 403/404', () => {
      assert.ok([403, 404].includes(traversalGet.status), String(traversalGet.status));
    });

    const badJson = await req(base, '/api/images/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ 不是 JSON',
    });
    check('请求体不是合法 JSON 返回 400', () => assert.strictEqual(badJson.status, 400));

    const notAllowed = await req(base, '/api/images/config', { method: 'POST', body: '{}' });
    check('只读的图片接口拒绝 POST', () => assert.strictEqual(notAllowed.status, 405));

    // ---------- 预览与列表 ----------
    console.log('\n--- 预览与列表 ---');
    const preview = await fetch(base + `/images/${recId}/${encodeURIComponent(name)}`);
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    check('GET /images/* 能预览已保存的图片', () => {
      assert.strictEqual(preview.status, 200);
      assert.ok(preview.headers.get('content-type').includes('image/png'));
      assert.ok(previewBytes.equals(PNG), '预览出来的字节与保存前不一致');
    });

    const previewJpg = await fetch(base + `/images/${recId}/${encodeURIComponent(jpgName)}`);
    check('覆盖后的 JPEG 预览类型正确', () => {
      assert.strictEqual(previewJpg.status, 200);
      assert.ok(previewJpg.headers.get('content-type').includes('image/jpeg'));
    });

    const listed = await req(base, '/api/images/list?subdir=' + encodeURIComponent(recId));
    check('列表返回本次写入的文件', () => {
      assert.strictEqual(listed.status, 200);
      const names = listed.json().files.map((f) => f.name);
      assert.ok(names.includes(name), names.join(', '));
      assert.ok(names.includes(jpgName), names.join(', '));
      assert.ok(names.some((n) => /_1\.png$/.test(n)), names.join(', '));
    });

    // ---------- 删除 ----------
    console.log('\n--- 删除 ---');
    const del = await postJson(base, '/api/images/delete', { fileName: name, subdir: recId });
    check('删除已存在的图片返回 deleted=true', () => {
      assert.strictEqual(del.status, 200, del.text);
      assert.strictEqual(del.json().deleted, true);
      assert.ok(!fs.existsSync(path.join(IMAGES_DIR, recId, name)));
    });
    const delAgain = await postJson(base, '/api/images/delete', { fileName: name, subdir: recId });
    check('删除不存在的图片是幂等的', () => {
      assert.strictEqual(delAgain.status, 200);
      assert.strictEqual(delAgain.json().deleted, false);
    });
  } finally {
    await Server.stop(started.server);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('\n测试自身出错:', e && e.stack ? e.stack : e);
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
  process.exitCode = 1;
});
