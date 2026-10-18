#!/usr/bin/env node
/**
 * 图片处理核心回归测试（浏览器内执行）
 * ====================================
 * js/image.js 的核心是 canvas 坐标变换：EXIF 方向归一化、旋转、裁剪、
 * 增强与导出的复合顺序。这些逻辑只有在真实浏览器里跑才算数（Node 没有 canvas），
 * 而且**一旦算错就是「导出的图和预览不一样」这种最难发现的问题**，
 * 所以这里用无头浏览器逐像素验证。
 *
 *   node scripts/test-image-core.js
 *   node scripts/test-image-core.js --keep     # 保留临时文件，便于排查
 *   node scripts/test-image-core.js --browser="C:\path\to\chrome.exe"
 *
 * 做法
 * ----
 *   1. 生成一张自带测试用例的 HTML（把已存在的 js/*.js 内联进去，
 *      避免 file:// 下的跨源限制）；
 *   2. 用本地服务器把它挂到 http://127.0.0.1:<随机端口>/；
 *   3. 用 Chrome/Edge 的无头模式打开，页面把结果写进 #result 的 JSON；
 *   4. 用 --dump-dom 取回并断言。
 *
 * 页面内的用例见 fixture 源码（每个 check 都带一句「为什么这么测」）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Server = require(path.join(ROOT, 'server.js'));
const BrowserTest = require(path.join(__dirname, '_lib', 'browser-test.js'));

// ============================================================
// 生成页面内联脚本
// ============================================================

function inlineScripts() {
  const files = ['js/img-naming.js', 'js/image.js'];
  return files.map((rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 关掉模块导出分支：浏览器里走 window 全局
    return `<script>\n${code}\n</script>`;
  }).join('\n');
}

const FIXTURE_HEAD = `<!DOCTYPE html>
<meta charset="utf-8">
<title>ImageCore 测试</title>
<pre id="result">RUNNING</pre>
<script>
// 运行标记由测试脚本经 ?r= 传入：用它包住结果，避免 Node 侧把脚本源码里的
// 字面量误当成"页面已跑完"（--dump-dom 是边写边出的）。
const RUN_MARKER = new URLSearchParams(location.search).get('r') || 'no-marker';
function wrapResult(results) {
  return '@@R:' + RUN_MARKER + JSON.stringify(results) + '@@R:' + RUN_MARKER + ':END';
}
</script>
`;

const FIXTURE_BODY = `
<script>
// ============================================================
// 测试骨架
// ============================================================
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
function assertNear(a, b, tol, msg) {
  if (Math.abs(a - b) > (tol === undefined ? 2 : tol)) {
    throw new Error((msg || '数值超出容差') + ': ' + a + ' vs ' + b);
  }
}

// ============================================================
// 夹具：带 EXIF Orientation 的最小 JPEG
// ============================================================
function buildTiffLE(orientation) {
  const b = new Uint8Array(26);
  const dv = new DataView(b.buffer);
  b[0] = 0x49; b[1] = 0x49;            // 'II' 小端
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);            // IFD0 偏移
  dv.setUint16(8, 1, true);            // 一个条目
  dv.setUint16(10, 0x0112, true);      // Orientation
  dv.setUint16(12, 3, true);           // SHORT
  dv.setUint32(14, 1, true);           // count
  dv.setUint16(18, orientation, true); // value
  dv.setUint32(22, 0, true);           // next IFD
  return b;
}
function buildExifJpeg(orientation) {
  const tiff = buildTiffLE(orientation);
  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\\0\\0"
  const payloadLen = exifHeader.length + tiff.length;
  const app1 = new Uint8Array(4 + payloadLen);
  app1[0] = 0xFF; app1[1] = 0xE1;
  new DataView(app1.buffer).setUint16(2, payloadLen + 2, false);
  app1.set(exifHeader, 4);
  app1.set(tiff, 4 + exifHeader.length);
  const dqt = new Uint8Array([0xFF, 0xDB, 0x00, 0x43, 0x00,
    16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,
    14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,
    49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99]);
  const sof = new Uint8Array([0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const dht = new Uint8Array([0xFF, 0xC4, 0x00, 0x14, 0x00,
    0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0x00]);
  const sos = new Uint8Array([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
  const out = new Uint8Array(2 + app1.length + dqt.length + sof.length + dht.length + sos.length + 2);
  let o = 0;
  const put = (arr) => { out.set(arr, o); o += arr.length; };
  out[o++] = 0xFF; out[o++] = 0xD8;
  put(app1); put(dqt); put(sof); put(dht); put(sos);
  out[o++] = 0xFF; out[o++] = 0xD9;
  return out.buffer;
}
function exifFile(orientation) {
  return new File([buildExifJpeg(orientation)], 'photo.jpg', { type: 'image/jpeg' });
}

/** 最小合法 PNG（1×1）：给需要"确实是 PNG"的用例用 */
function buildPng() {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, false);
    const t = new TextEncoder().encode(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t, 0); body.set(data, t.length);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(body), false);
    const out = new Uint8Array(4 + body.length + 4);
    out.set(len, 0); out.set(body, 4); out.set(crc, 4 + body.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 1, false); dv.setUint32(4, 1, false);
  ihdr[8] = 8; ihdr[9] = 6;
  // 固定的 zlib 流（8 位 RGBA 单像素），避免依赖 CompressionStream
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = sig.length + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  out.set(sig, o); o += sig.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function pngFile(name) {
  return new File([buildPng()], name || 'photo.png', { type: 'image/png' });
}

// ============================================================
// 夹具：五块测试图（便于逐像素判断旋转/镜像/增强）
// ============================================================
//   TL 红   TR 绿
//   BL 蓝   BR 黄
//        中心：中灰 (100,100,100)
//
// 中心那块是给增强用的：红/绿/蓝/黄的主通道都已经顶在 255，
// 是增益类操作（亮度、对比度都是乘/线性缩放）的饱和区，看不出变化。
// 中灰三通道都在低位，亮度、对比度、饱和度的效果都能落在可观测范围内。
const SAMPLE_COLORS = {
  TL: [255, 0, 0], TR: [0, 255, 0], BL: [0, 0, 255], BR: [255, 255, 0],
  MID: [100, 100, 100],
};
const COLORS = SAMPLE_COLORS;
function makeQuadrantCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  const paint = (x, y, cw, ch, rgb) => {
    ctx.fillStyle = 'rgb(' + rgb.join(',') + ')';
    ctx.fillRect(x, y, cw, ch);
  };
  paint(0, 0, hw, hh, COLORS.TL);
  paint(hw, 0, w - hw, hh, COLORS.TR);
  paint(0, hh, hw, h - hh, COLORS.BL);
  paint(hw, hh, w - hw, h - hh, COLORS.BR);
  // 中心取样块（增强测试用），尺寸随图缩放但至少 4px
  const bw = Math.max(4, Math.round(w * 0.25));
  const bh = Math.max(4, Math.round(h * 0.25));
  paint(Math.round((w - bw) / 2), Math.round((h - bh) / 2), bw, bh, COLORS.MID);
  return c;
}
/** 中心点取色（避开边界，blocky 缩放也不会串色） */
function colorAt(canvas, nx, ny) {
  const ctx = canvas.getContext('2d');
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(ny * canvas.height)));
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}
function nearColor(got, want, tol) {
  const t = tol === undefined ? 40 : tol;
  return Math.abs(got[0] - want[0]) <= t && Math.abs(got[1] - want[1]) <= t && Math.abs(got[2] - want[2]) <= t;
}
function nameQuadrant(rgb) {
  for (const k of Object.keys(COLORS)) if (nearColor(rgb, COLORS[k], 40)) return k;
  return 'rgb(' + rgb.join(',') + ')';
}
/** 用固定尺寸的四象限画布当作「解码结果」注入会话 */
function quadrantDecoder(w, h, mime) {
  return async () => {
    const canvas = makeQuadrantCanvas(w, h);
    return {
      bitmap: canvas,
      width: w,
      height: h,
      sniffed: mime || 'image/jpeg',
      release: () => {},
    };
  };
}

// ============================================================
// 夹具：横条纹图（验证"导出的到底是哪一块"）
// ============================================================
// 四象限图只能判断方向，判断不了裁剪位置取得对不对。
// 条纹图每一行都有唯一颜色，导出后看第一行是什么颜色，
// 就知道它对应源图的哪一行 —— 裁剪窗口算错会被立刻抓出来。
function makeStripeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    // 拼字符串而不是模板字符串：这段代码写在 Node 的模板字符串里，
    // 内层反引号会把外层模板提前截断（check-fixture 只检查内层，抓不到）
    ctx.fillStyle = 'rgb(' + (y % 256) + ',' + ((y * 3) % 256) + ',' + ((y * 7) % 256) + ')';
    ctx.fillRect(0, y, w, 1);
  }
  return c;
}
function stripeRowColor(y) {
  return [y % 256, (y * 3) % 256, (y * 7) % 256];
}
async function makeStripeSession(w, h) {
  return ImageCore.createSession(exifFile(1), {
    decoder: async () => {
      const canvas = makeStripeCanvas(w, h);
      return { bitmap: canvas, width: w, height: h, sniffed: 'image/jpeg', release: () => {} };
    },
    orientation: 1,
  });
}

/** 默认会话：四象限图 + 指定 EXIF 方向 */
async function makeSession(w, h, opts) {
  const o = opts || {};
  const type = o.type || 'image/jpeg';
  // 默认文件用**真图片字节**：validate() 会做内容嗅探（不能只信扩展名），
  // 拿一串零字节当文件的话，连"合法图片"这一关都过不了。
  // 同时文件类型要和用例声明的类型一致，否则嗅探结果与预期不符。
  const file = o.file || (type === 'image/png' ? pngFile() : exifFile(1));
  return ImageCore.createSession(file, {
    decoder: quadrantDecoder(w, h, type),
    orientation: o.orientation || 1,
  });
}

// ============================================================
// 用例
// ============================================================
async function run() {

  // ---------- 命名规则 ----------
  check('sanitizeFileName 把路径分隔符换成下划线（不丢首段）', () => {
    // 设计稿 12.1 的原例：分隔符要变成下划线，而不是被当成路径丢前半截
    assertEq(ImgNaming.sanitizeFileName('测试/图片:01?.jpg'), '测试_图片_01.jpg');
    assertEq(ImgNaming.sanitizeFileName('a\\\\b/c.jpg'), 'a_b_c.jpg');
  });
  check('sanitizeFileName 消掉路径穿越前缀里的非法点', () => {
    assertEq(ImgNaming.sanitizeFileName('..\\\\..\\\\evil.png'), '.._evil.png');
  });
  check('sanitizeFileName 未知扩展名按 MIME 兜底', () => {
    assertEq(ImgNaming.sanitizeFileName('photo.tiff', { mimeType: 'image/png' }), 'photo.png');
  });
  check('sanitizeFileName 超出长度会被截断', () => {
    const long = 'a'.repeat(200) + '.jpg';
    assert(ImgNaming.sanitizeFileName(long).length <= 85, '截断后仍过长');
  });
  check('buildFileName 按 机构号_盖销时间_邮局名_序号 生成', () => {
    const r = ImgNaming.buildFileName({
      instCode: '10000123', cancelDate: '2026.09.30.15',
      officeName: '中南海邮政支局', index: 1, ext: '.jpg',
    });
    assertEq(r.fileName, '10000123_2026093015_中南海邮政支局_01.jpg');
  });
  check('buildFileName 序号补零到两位', () => {
    const r = ImgNaming.buildFileName({ instCode: '1', index: 12, ext: '.png' });
    assertEq(r.fileName, '1_12.png');
  });
  check('buildFileName 关键字段缺失时退回原始文件名', () => {
    const r = ImgNaming.buildFileName({ fallback: '微信图片_20260930153012.png', index: 1, ext: '.jpg' });
    assertEq(r.fileName, '微信图片_20260930153012_01.jpg');
  });
  check('sanitizeSegment 永远不会返回可跳出目录的值', () => {
    assertEq(ImgNaming.sanitizeSegment('rec001'), 'rec001');
    assertEq(ImgNaming.sanitizeSegment('../../..'), '_unfiled');
    assertEq(ImgNaming.sanitizeSegment(''), '_unfiled');
    assertEq(ImgNaming.sanitizeSegment('.'), '_unfiled');
    assertEq(ImgNaming.sanitizeSegment('a/b'), 'b');
  });

  // ---------- EXIF ----------
  check('readExifOrientation 读出各方向值', () => {
    for (let o = 1; o <= 8; o++) {
      assertEq(ImageCore.readExifOrientation(buildExifJpeg(o)), o, 'orientation=' + o);
    }
  });
  check('readExifOrientation 对非 JPEG 返回 1', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);
    assertEq(ImageCore.readExifOrientation(png.buffer), 1);
  });
  check('内容嗅探能看穿骗人的扩展名', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    assertEq(ImageCore.sniffMime(png.buffer), 'image/png');
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    assertEq(ImageCore.sniffMime(webp.buffer), 'image/webp');
  });

  // ---------- 导入与校验 ----------
  await checkAsync('createSession 读出原始尺寸', async () => {
    const s = await makeSession(120, 80);
    assertEq(s.rawWidth, 120); assertEq(s.rawHeight, 80);
    assertEq(s.width, 120); assertEq(s.height, 80);
    ImageCore.disposeSession(s);
  });

  await checkAsync('旋转类 EXIF 方向下，预览基座尺寸同样是转置后的', async () => {
    // 基座尺寸是裁剪坐标系的基准：这里错了，后面所有裁剪都会偏移
    const s = await makeSession(240, 160, { orientation: 6, file: exifFile(6) });
    assertEq(s._sourceCanvas.width, 160, '基座宽应为原始高');
    assertEq(s._sourceCanvas.height, 240, '基座高应为原始宽');
    // 未旋转时，外接矩形就是基座本身
    const frame = ImageCore.frameBounds(s, true);
    assertEq(frame.width, 160, '未旋转时外接宽');
    assertEq(frame.height, 240, '未旋转时外接高');
    ImageCore.disposeSession(s);
  });

  await checkAsync('orientation=6 时宽高对调（手机竖拍照片）', async () => {
    const s = await makeSession(120, 80, { orientation: 6, file: exifFile(6) });
    assertEq(s.exifOrientation, 6);
    assertEq(s.width, 80, '归一化后宽应为原始高');
    assertEq(s.height, 120, '归一化后高应为原始宽');
    ImageCore.disposeSession(s);
  });

  await checkAsync('过大的文件被拒绝', async () => {
    const big = new File([new Uint8Array(ImageCore.MAX_FILE_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' });
    let err = null;
    try { await ImageCore.createSession(big, { decoder: quadrantDecoder(10, 10) }); }
    catch (e) { err = e; }
    assert(err && err.code === 'TOO_LARGE', '应当抛 TOO_LARGE，实际: ' + (err && err.code));
  });

  await checkAsync('不支持的扩展名被拒绝', async () => {
    const bad = new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' });
    let err = null;
    try { await ImageCore.createSession(bad, { decoder: quadrantDecoder(10, 10) }); }
    catch (e) { err = e; }
    assert(err && err.code === 'TYPE_UNSUPPORTED', '应当抛 TYPE_UNSUPPORTED');
  });

  // ---------- EXIF 归一化后的像素方向 ----------
  // 四象限图「物理上」是 TL红 TR绿 / BL蓝 BR黄。
  // 手机竖拍(orientation=6)的含义是：显示时需把这张图顺时针转 90°。
  // 转 90° 后，画布左上角应当来自原来的 BL（蓝）—— 这就是"方向烧进像素"的证据。
  await checkAsync('orientation=6 把像素真的转正（烧进像素而非只改标记）', async () => {
    const s = await makeSession(200, 100, { orientation: 6, file: exifFile(6) });
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 100, '输出宽');
    assertEq(out.height, 200, '输出高');
    assertEq(nameQuadrant(colorAt(out, 0.25, 0.25)), 'BL', '左上应为原 BL');
    assertEq(nameQuadrant(colorAt(out, 0.75, 0.25)), 'TL', '右上应为原 TL');
    assertEq(nameQuadrant(colorAt(out, 0.25, 0.75)), 'BR', '左下应为原 BR');
    assertEq(nameQuadrant(colorAt(out, 0.75, 0.75)), 'TR', '右下应为原 TR');
    ImageCore.disposeSession(s);
  });

  await checkAsync('orientation=3（180°）像素正确', async () => {
    const s = await makeSession(200, 100, { orientation: 3, file: exifFile(3) });
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(nameQuadrant(colorAt(out, 0.25, 0.25)), 'BR');
    assertEq(nameQuadrant(colorAt(out, 0.75, 0.75)), 'TL');
    ImageCore.disposeSession(s);
  });

  await checkAsync('orientation=8（逆时针 90°）像素正确', async () => {
    const s = await makeSession(200, 100, { orientation: 8, file: exifFile(8) });
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 100); assertEq(out.height, 200);
    assertEq(nameQuadrant(colorAt(out, 0.25, 0.25)), 'TR');
    assertEq(nameQuadrant(colorAt(out, 0.75, 0.75)), 'BL');
    ImageCore.disposeSession(s);
  });

  // ---------- 预览与导出一致性 ----------
  // 这是本模块最关键的不变量。旋转改成任意角度后，两条路径的**目标尺寸**本来就不同
  // （预览画整张图，导出只画裁剪框），所以不能再直接比尺寸；要比的是
  // 「同一个源像素在两处落在哪里、是不是同一个颜色」。
  await checkAsync('旋转 90°：预览与导出的像素方向一致', async () => {
    const s = await makeSession(240, 120, { orientation: 1 });
    s.rotation = 90;
    const a = document.createElement('canvas');
    const b = document.createElement('canvas');
    ImageCore.renderToCanvas(s, a, { usePreviewSource: true });
    ImageCore.renderToCanvas(s, b, { usePreviewSource: false });
    // 直接比对两条路径的**逐像素**结果，而不是四角取色 ——
    // 取色只能看到"某个位置是什么颜色"，逐像素比对能直接指出错在哪一行
    const ctxA = a.getContext('2d');
    const ctxB = b.getContext('2d');
    let firstDiff = '';
    let diffCount = 0;
    if (a.width === b.width && a.height === b.height) {
      const da = ctxA.getImageData(0, 0, a.width, a.height).data;
      const db = ctxB.getImageData(0, 0, b.width, b.height).data;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i + 1] - db[i + 1]) > 8 || Math.abs(da[i + 2] - db[i + 2]) > 8) {
          diffCount++;
          if (!firstDiff) {
            const px = (i / 4) % a.width;
            const py = Math.floor((i / 4) / a.width);
            firstDiff = '首个差异 @(' + px + ',' + py + ') 预览=' + [da[i], da[i + 1], da[i + 2]].join(',')
              + ' 导出=' + [db[i], db[i + 1], db[i + 2]].join(',');
          }
        }
      }
    }
    const diag = 'preview=' + a.width + 'x' + a.height + ' export=' + b.width + 'x' + b.height
      + ' 差异像素=' + diffCount + '/' + (a.width * a.height) + ' ' + firstDiff;
    assertEq(diffCount, 0, '两条路径像素不一致 | ' + diag);

    // 方向断言用**几何反算**得出，不靠人脑推象限：
    // 顺时针 90° 时，源图 (sx, sy) 会落到输出的 (H − sy, sx)。
    const W = 240;
    const H = 120;
    // 源图四个象限各取一个内侧点，反算它在输出里的位置再比对颜色。
    // 期望值不写死象限名，而是**读源图对应位置的颜色**再和输出比 ——
    // 这样断言只依赖"顺时针 90° = (sx,sy) → (H−sy, sx)"这一条约定，
    // 不会再被"哪个色块算左上"这种人为标签绕进去。
    const srcCanvas = s._sourceCanvas;
    const srcColorAt = (sx, sy) => {
      const d = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const probe = (sx, sy, label) => {
      const ex = H - sy;
      const ey = sx;
      const want = srcColorAt(sx, sy);
      const got = colorAt(a, ex / a.width, ey / a.height);
      const ok = Math.abs(got[0] - want[0]) < 40 && Math.abs(got[1] - want[1]) < 40
        && Math.abs(got[2] - want[2]) < 40;
      assert(ok, label + ' 源(' + sx + ',' + sy + ') 颜色 ' + want.join(',')
        + ' 应出现在输出(' + ex + ',' + ey + ')，实际 ' + got.join(','));
      return nameQuadrant(want);
    };
    const seen = [
      probe(10, 10, '源左上'),
      probe(W - 10, 10, '源右上'),
      probe(10, H - 10, '源左下'),
      probe(W - 10, H - 10, '源右下'),
    ];
    ImageCore.disposeSession(s);
    return seen.join(',') + ' | ' + diag;
  });

  // 用条纹图确认「导出的确实是裁剪框圈住的那一块」——
  // 四象限图判方向，条纹图判位置，两者互补。
  await checkAsync('裁剪取的是正确的那一块（条纹定位）', async () => {
    const s = await makeStripeSession(40, 200);
    // 取纵向 50%~75% 的一条：对应源图第 100~149 行
    s.crop = { x: 0, y: 0.5, w: 1, h: 0.25 };
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 40, '导出宽');
    assertEq(out.height, 50, '导出高（200 × 0.25）');
    // 首行与末行分别对到源图第 100 行和第 149 行；取色点算准到具体像素，
    // 别用"贴顶"这种模糊位置（曾经因为差一行而误报）
    const w = out.width;
    const h = out.height;
    const px = (x, y) => {
      const d = out.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const top = px(Math.floor(w / 2), 0);
    const bottom = px(Math.floor(w / 2), h - 1);
    const wantTop = stripeRowColor(100);
    const wantBottom = stripeRowColor(149);
    assertNear(top[0], wantTop[0], 4, '首行应对应源图第 100 行（红）');
    assertNear(top[2], wantTop[2], 4, '首行应对应源图第 100 行（蓝）');
    assertNear(bottom[0], wantBottom[0], 4, '末行应对应源图第 149 行（红）');
    assertNear(bottom[2], wantBottom[2], 4, '末行应对应源图第 149 行（蓝）');
    ImageCore.disposeSession(s);
  });

  await checkAsync('裁剪 + 任意角度：导出取的是同一块（条纹定位）', async () => {
    const s = await makeStripeSession(40, 200);
    s.crop = { x: 0, y: 0.5, w: 1, h: 0.25 };      // 源图第 100~149 行
    const readPx = (cv, x, y) => {
      const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    // 1) 未旋转：输出与裁剪窗口 1:1，第 y 行就是源图第 100+y 行
    const straight = document.createElement('canvas');
    ImageCore.renderToCanvas(s, straight, { usePreviewSource: false });
    assertEq(straight.width, 40); assertEq(straight.height, 50);
    const row0 = readPx(straight, 20, 0);
    const want0 = stripeRowColor(100);
    assertNear(row0[0], want0[0], 2, '第 0 行应对应源图第 100 行（红）');
    assertNear(row0[2], want0[2], 2, '第 0 行应对应源图第 100 行（蓝）');

    // 2) 转 90°（整数角度，裁剪框不会被收缩）。
    //    条纹图的绿分量 = (行号×3) mod 256，在 150 行以内是严格递增的斜坡，
    //    所以"哪一行到了这里"可以直接读出来 —— 用它反推源行号，
    //    比逐色猜位置可靠得多。
    s.rotation = 90;
    const rotated = document.createElement('canvas');
    ImageCore.renderToCanvas(s, rotated, { usePreviewSource: false });
    assertEq(rotated.width, 40, '输出宽 = 裁剪框宽');
    assertEq(rotated.height, 50, '输出高 = 裁剪框高');
    const midCol = readPx(rotated, rotated.width - 2, 25);
    const srcRow = midCol[0];                       // 红分量 = 行号 mod 256
    assert(srcRow >= 100 && srcRow <= 149,
      '右侧中段应仍来自裁剪窗口内的行（100~149），实际源行 ' + srcRow);
    assertNear(midCol[1], (srcRow * 3) % 256, 8, '绿分量应与行号一致（斜坡校验）');
    // 顺时针 90°：源图最上面那一行转到最右侧，所以右侧取到的应当贴近顶部
    assert(srcRow <= 112, '右侧应对应裁剪窗口的顶部附近，实际源行 ' + srcRow);
    ImageCore.disposeSession(s);
  });

  // ---------- 旋转 ----------
  // 语义：输出 = 裁剪框那块内容**随旋转一起带出来**的正矩形，
  //       所以输出尺寸恒等于裁剪框尺寸，与角度无关。
  //       （旋转改变的是"框里装的是哪部分内容"，不是输出形状。）
  await checkAsync('旋转不改变输出尺寸（输出 = 裁剪框）', async () => {
    const s = await makeSession(240, 120);
    // 只测不触发收缩的角度：整数角度不该动裁剪框，
    // 非整数角度会（也必须）收缩裁剪框，那属于下一条用例的范围
    const at = (deg) => {
      s.rotation = deg;
      s.crop = ImageCore.clampCrop(s, { x: 0, y: 0, w: 1, h: 1 });
      const out = document.createElement('canvas');
      ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
      return out.width + 'x' + out.height;
    };
    assertEq(at(0), '240x120', '0°');
    assertEq(at(90), '240x120', '90°');
    assertEq(at(180), '240x120', '180°');
    assertEq(at(270), '240x120', '270°');
    ImageCore.disposeSession(s);
  });

  await checkAsync('非整数角度会收缩裁剪框，但输出尺寸仍等于裁剪框', async () => {
    const s = await makeSession(240, 120);
    s.rotation = 37;
    const c = ImageCore.clampCrop(s, { x: 0, y: 0, w: 1, h: 1 });
    assert(c.w < 1 || c.h < 1, '倾斜后应收缩: ' + JSON.stringify(c));
    s.crop = c;
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, Math.round(c.w * s.width), '输出宽 = 裁剪框宽');
    assertEq(out.height, Math.round(c.h * s.height), '输出高 = 裁剪框高');
    ImageCore.disposeSession(s);
  });

  await checkAsync('旋转 360° 回到原样', async () => {
    const s = await makeSession(240, 120);
    s.rotation = 360;
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 240); assertEq(out.height, 120);
    assertEq(nameQuadrant(colorAt(out, 0.25, 0.25)), 'TL');
    ImageCore.disposeSession(s);
  });

  await checkAsync('任意角度（30°）预览画布按外接矩形放大，且不丢内容', async () => {
    const s = await makeSession(200, 100);
    s.rotation = 30;
    const bounds = ImageCore.frameBounds(s, false);
    const out = document.createElement('canvas');
    // 预览路径：画整张旋转后的图，画布开成外接矩形
    ImageCore.renderToCanvas(s, out, { usePreviewSource: true });
    // 外接矩形 = W·cos + H·sin, W·sin + H·cos
    const wantW = 200 * Math.cos(Math.PI / 6) + 100 * 0.5;
    const wantH = 200 * 0.5 + 100 * Math.cos(Math.PI / 6);
    assertNear(out.width, wantW, 2, '外接宽');
    assertNear(out.height, wantH, 2, '外接高');
    assertNear(bounds.width, wantW, 1, 'frameBounds 应与画布一致');
    assertNear(bounds.height, wantH, 1, 'frameBounds 应与画布一致');
    // 四角是空的（转出去了），中心必须有内容
    const corner = colorAt(out, 0.02, 0.02);
    assert(corner[0] + corner[1] + corner[2] === 0, '旋转后四角应当是空的，实际 ' + corner.join(','));
    const mid = colorAt(out, 0.5, 0.5);
    assert(mid[0] + mid[1] + mid[2] > 0, '中心必须有内容');
    ImageCore.disposeSession(s);
  });

  await checkAsync('任意角度（45°）下输出尺寸仍是裁剪框尺寸', async () => {
    const s = await makeSession(200, 200);
    s.crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };   // 100×100
    s.rotation = 45;
    const out = ImageCore.outputSize(s);
    assertEq(out.width, 100, '45° 输出宽仍等于裁剪框宽');
    assertEq(out.height, 100, '45° 输出高仍等于裁剪框高');
    const cv = document.createElement('canvas');
    ImageCore.renderToCanvas(s, cv, { usePreviewSource: false });
    assertEq(cv.width, 100, '渲染宽');
    assertEq(cv.height, 100, '渲染高');
    ImageCore.disposeSession(s);
  });

  await checkAsync('任意角度下裁剪框被收进图内（旋转后不越界）', async () => {
    const s = await makeSession(200, 100);
    s.rotation = 30;
    // 试着要整图：必须被收紧，否则旋转后的裁剪框会伸到图外
    const c = ImageCore.clampCrop(s, { x: 0, y: 0, w: 1, h: 1 });
    assert(c.w < 1 && c.h < 1, '倾斜后不该还能取整图: ' + JSON.stringify(c));
    // maxCropSize 给的是"理论最大值"（不含抗锯齿余量），实际夹紧会再留一点，
    // 所以只断言"不超过理论上限"，不去比相等
    const lim = ImageCore.maxCropSize(s);
    assert(c.w <= lim.w + 1e-9, '宽度不该超过理论上限: ' + c.w + ' > ' + lim.w);
    assert(c.h <= lim.h + 1e-9, '高度不该超过理论上限: ' + c.h + ' > ' + lim.h);
    assert(c.w > lim.w * 0.9, '收紧幅度不该超过 10%: ' + c.w + ' vs ' + lim.w);
    s.crop = c;

    // 不变式：裁剪框绕图心旋转后的外接矩形，必须落在原图内。
    // 这就是"输出不会掺进图外内容"的充要条件，直接按几何定义验。
    const rad = s.rotation * Math.PI / 180;
    const cw = c.w * s.width;
    const ch = c.h * s.height;
    const bw = cw * Math.abs(Math.cos(rad)) + ch * Math.abs(Math.sin(rad));
    const bh = cw * Math.abs(Math.sin(rad)) + ch * Math.abs(Math.cos(rad));
    assert(bw <= s.width + 1e-6, '旋转后外接宽超出原图: ' + bw + ' > ' + s.width);
    assert(bh <= s.height + 1e-6, '旋转后外接高超出原图: ' + bh + ' > ' + s.height);

    // 每收紧一次后，四个角都必须仍是图内内容
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    const corners = [colorAt(out, 0.02, 0.02), colorAt(out, 0.98, 0.02),
                     colorAt(out, 0.02, 0.98), colorAt(out, 0.98, 0.98)];
    const empty = corners.filter((p) => p[0] + p[1] + p[2] === 0);
    const diag = 'crop=' + JSON.stringify(c) + ' out=' + out.width + 'x' + out.height
      + ' corners=' + JSON.stringify(corners);
    assertEq(empty.length, 0, '输出四角不该是空的 | ' + diag);
    ImageCore.disposeSession(s);
  });

  await checkAsync('maxCropSize 不误伤 90° 的整数倍', async () => {
    const s = await makeSession(240, 120);
    let lim = ImageCore.maxCropSize(s);
    assertNear(lim.w, 1, 1e-6, '0° 应可整图');
    assertNear(lim.h, 1, 1e-6, '0° 应可整图');
    s.rotation = 90;
    lim = ImageCore.maxCropSize(s);
    assertNear(lim.w, 1, 1e-6, '90° 也应可整图（框与图对齐，转不出界）');
    assertNear(lim.h, 1, 1e-6, '90° 也应可整图');
    s.rotation = 270;
    lim = ImageCore.maxCropSize(s);
    assertNear(lim.w, 1, 1e-6, '270° 同上');
    // 90° 下取整图，输出仍是整图尺寸（内容转了 90°）
    s.crop = { x: 0, y: 0, w: 1, h: 1 };
    const out = ImageCore.outputSize(s);
    assertEq(out.width, 240, '90° 输出宽 = 裁剪框宽');
    assertEq(out.height, 120, '90° 输出高 = 裁剪框高');
    ImageCore.disposeSession(s);
  });

  await checkAsync('旋转后裁剪框按当前角度重新夹紧', async () => {
    const s = await makeSession(240, 120);
    s.crop = { x: 0, y: 0, w: 1, h: 1 };
    s.rotation = 90;
    ImageCore.setCropRatio(s, 1);
    const c = ImageCore.normalizeCrop(s.crop);
    const out = ImageCore.outputSize(s);
    assertNear(out.width / out.height, 1, 0.05, '输出应为正方形，实际 ' + out.width + 'x' + out.height);
    assert(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, '裁剪框越界: ' + JSON.stringify(c));
  });

  // ---------- 裁剪 ----------
  await checkAsync('裁剪只保留选中区域', async () => {
    const s = await makeSession(200, 200);
    s.crop = { x: 0, y: 0, w: 0.5, h: 0.5 };   // 左上角
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 100); assertEq(out.height, 100);
    assertEq(nameQuadrant(colorAt(out, 0.5, 0.5)), 'TL');
    ImageCore.disposeSession(s);
  });

  await checkAsync('outputSize 反映裁剪与旋转', async () => {
    const s = await makeSession(400, 200);
    s.crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
    let out = ImageCore.outputSize(s);
    assertEq(out.width, 200); assertEq(out.height, 200);
    s.rotation = 90;
    s.crop = { x: 0, y: 0, w: 1, h: 1 };
    s.crop = ImageCore.clampCrop(s, s.crop);      // 90° 下整图仍然合法
    out = ImageCore.outputSize(s);
    // 输出尺寸恒等于裁剪框尺寸，与角度无关
    assertEq(out.width, 400); assertEq(out.height, 200);
    s.crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    out = ImageCore.outputSize(s);
    assertEq(out.width, 200); assertEq(out.height, 100);
    ImageCore.disposeSession(s);
  });

  await checkAsync('越界的裁剪框会被夹回画布内', async () => {
    const s = await makeSession(200, 100);
    s.crop = { x: 0.9, y: 0.9, w: 0.5, h: 0.5 };
    const c = ImageCore.normalizeCrop(s.crop);
    assert(c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, '裁剪框越界: ' + JSON.stringify(c));
    ImageCore.disposeSession(s);
  });

  await checkAsync('applyAdjustPixels 单独可用（逐像素兜底的基础）', async () => {
    const cv = document.createElement('canvas');
    cv.width = 20; cv.height = 20;
    const cx = cv.getContext('2d');
    cx.fillStyle = 'rgb(100,100,100)';       // 中灰：三段增强都有可观测的余量
    cx.fillRect(0, 0, 20, 20);
    const before = colorAt(cv, 0.5, 0.5).join(',');
    ImageCore.applyAdjustPixels(cv, { brightness: 60, contrast: 0, saturation: 0 });
    const after = colorAt(cv, 0.5, 0.5).join(',');
    assert(after !== before, 'applyAdjustPixels 没有改变像素: ' + after);
    return before + ' → ' + after;
  });

  // ---------- 增强 ----------
  // 取样点用图中央那块中灰：四个象限的纯色主通道都顶在 255，
  // 是增益类操作的饱和区，看不出变化（这一点曾经把测试自己坑了一次）。
  await checkAsync('亮度/对比度/饱和度真的改变像素（预览与导出都要变）', async () => {
    const s = await makeSession(120, 60);
    const read = (usePreview) => {
      const cv = document.createElement('canvas');
      ImageCore.renderToCanvas(s, cv, { usePreviewSource: usePreview });
      return colorAt(cv, 0.5, 0.5);          // 中央中灰块
    };
    const p0 = read(true);
    const e0 = read(false);
    assertEq(p0.join(','), e0.join(','), '未编辑时预览与导出应一致');

    s.adjust.brightness = 60;
    const p60 = read(true);
    const e60 = read(false);
    s.adjust.brightness = 0;

    s.adjust.saturation = -100;              // 全灰
    const pDesat = read(true);
    s.adjust.saturation = 0;

    s.adjust.contrast = 80;                  // 中灰(100)对比度拉高应更暗
    const pContrast = read(true);
    s.adjust.contrast = 0;

    const diag = '亮度 预览 ' + p0.join(',') + '→' + p60.join(',')
      + ' / 导出 ' + e0.join(',') + '→' + e60.join(',')
      + ' / 去饱和 ' + pDesat.join(',')
      + ' / 对比度 ' + pContrast.join(',')
      + ' / GPU滤镜=' + ImageCore.filterIsUsable();

    // 提亮：中灰三通道都应明显上升
    assert(p60[0] > p0[0] + 30, '预览提亮后应更亮 | ' + diag);
    assert(e60[0] > e0[0] + 30, '导出提亮后应更亮（导出漏掉增强=白调） | ' + diag);
    // 去饱和：中灰本来就是灰，这里验证的是"不会出错"，用纯红块另测
    assert(Math.abs(pDesat[0] - pDesat[1]) < 12, '去饱和后三通道应接近 | ' + diag);
    // 对比度：100 低于中灰 128，拉高对比度应更暗
    assert(pContrast[0] < p0[0] - 10, '提高对比度应把中灰压暗 | ' + diag);

    ImageCore.disposeSession(s);
    return diag;
  });

  await checkAsync('去饱和把纯色变成灰（用纯红块验证）', async () => {
    const s = await makeSession(120, 60);
    s.adjust.saturation = -100;
    const cv = document.createElement('canvas');
    ImageCore.renderToCanvas(s, cv, { usePreviewSource: true });
    const px = colorAt(cv, 0.25, 0.25);      // 纯红块
    assert(Math.abs(px[0] - px[1]) < 12 && Math.abs(px[1] - px[2]) < 12,
      '饱和度为 -100 时纯红应变成灰，实际 ' + px.join(','));
    ImageCore.disposeSession(s);
    return px.join(',');
  });

  await checkAsync('导出路径同样应用增强（不是只有预览变亮）', async () => {
    const s = await makeSession(120, 60);
    s.adjust.brightness = 60;
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    const c = colorAt(out, 0.25, 0.25);
    assert(c[0] > 200, '红色分量应被提亮，实际 ' + c.join(','));
    ImageCore.disposeSession(s);
  });

  await checkAsync('buildFilter 把滑块值翻译成 CSS filter', async () => {
    assertEq(ImageCore.buildFilter({ brightness: 0, contrast: 0, saturation: 0 }), 'none');
    const f = ImageCore.buildFilter({ brightness: 20, contrast: -10, saturation: 50 });
    assert(f.includes('brightness(120.0%)'), f);
    assert(f.includes('contrast(90.0%)'), f);
    assert(f.includes('saturate(150.0%)'), f);
  });

  await checkAsync('锐化不改变尺寸且不报错', async () => {
    const s = await makeSession(160, 160);
    s.adjust.sharpness = 60;
    const out = document.createElement('canvas');
    ImageCore.renderToCanvas(s, out, { usePreviewSource: false });
    assertEq(out.width, 160); assertEq(out.height, 160);
    ImageCore.disposeSession(s);
  });

  await checkAsync('自动增强在纯色图上不会失控', async () => {
    const s = await makeSession(120, 120);
    const adj = ImageCore.autoEnhance(s);
    for (const k of ['brightness', 'contrast', 'saturation', 'sharpness']) {
      assert(Number.isFinite(adj[k]), k + ' 不是有限数: ' + adj[k]);
      assert(adj[k] >= -100 && adj[k] <= 100, k + ' 超出范围: ' + adj[k]);
    }
    ImageCore.disposeSession(s);
  });

  // ---------- 撤销 / 重置 ----------
  await checkAsync('撤销与重做能回到之前的状态', async () => {
    const s = await makeSession(120, 120);
    ImageCore.pushUndo(s);
    s.rotation = 90;
    ImageCore.pushUndo(s);
    s.rotation = 180;
    assertEq(s.rotation, 180);
    assert(ImageCore.undo(s), '应当可以撤销');
    assertEq(s.rotation, 90, '撤销后');
    assert(ImageCore.undo(s), '应当可以再撤销');
    assertEq(s.rotation, 0, '撤销到底');
    assert(!ImageCore.canUndo(s), '到底后不应还能撤销');
    assert(ImageCore.redo(s), '应当可以重做');
    assertEq(s.rotation, 90, '重做后');
    ImageCore.disposeSession(s);
  });

  await checkAsync('重置回到只做了 EXIF 归一化的状态', async () => {
    const s = await makeSession(120, 120);
    s.rotation = 270;
    s.crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    s.adjust.brightness = 40;
    s.adjust.sharpness = 30;
    ImageCore.reset(s);
    assertEq(s.rotation, 0);
    assertEq(s.crop.w, 1); assertEq(s.crop.h, 1);
    assertEq(s.adjust.brightness, 0); assertEq(s.adjust.sharpness, 0);
    assert(ImageCore.isPristine(s), '重置后应当是"未编辑"状态');
    ImageCore.disposeSession(s);
  });

  // ---------- 导出 ----------
  await checkAsync('exportBlob 输出正确的格式与扩展名', async () => {
    const s = await makeSession(200, 100);
    const out = await ImageCore.exportBlob(s, { fileName: 'abc.jpg' });
    assertEq(out.width, 200); assertEq(out.height, 100);
    assertEq(out.mime, 'image/jpeg');
    assertEq(out.ext, '.jpg');
    assertEq(out.fileName, 'abc.jpg');
    assert(out.bytes > 0, '导出字节数为 0');
    assert(out.dataUrl.startsWith('data:image/jpeg;base64,'), 'dataUrl 前缀不对');
    ImageCore.disposeSession(s);
  });

  await checkAsync('PNG 源图默认保持 PNG（不会被压成 JPEG）', async () => {
    const s = await makeSession(120, 120, { type: 'image/png' });
    const out = await ImageCore.exportBlob(s);
    assertEq(out.format, 'png');
    assertEq(out.mime, 'image/png');
    assert(/\.png$/.test(out.fileName), out.fileName);
    ImageCore.disposeSession(s);
  });

  await checkAsync('导出会按扩展名纠正用户写的文件名', async () => {
    const s = await makeSession(120, 120, { type: 'image/png' });
    const out = await ImageCore.exportBlob(s, { fileName: '记录/照片?.jpg' });
    // 非法字符与路径分隔符换下划线、折叠连续下划线、再去掉首尾下划线
    assertEq(out.fileName, '记录_照片.png');
    ImageCore.disposeSession(s);
  });

  await checkAsync('超过 MAX_OUTPUT_SIZE 的图会等比缩小', async () => {
    const s = await makeSession(6000, 3000);
    const out = await ImageCore.exportBlob(s);
    assertEq(out.width, ImageCore.MAX_OUTPUT_SIZE);
    assertNear(out.width / out.height, 2, 0.02, '宽高比应保持');
    ImageCore.disposeSession(s);
  });

  await checkAsync('导出时应用了裁剪尺寸', async () => {
    const s = await makeSession(400, 400);
    s.crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const out = await ImageCore.exportBlob(s);
    assertEq(out.width, 200); assertEq(out.height, 200);
    ImageCore.disposeSession(s);
  });

  // ---------- 辅助 ----------
  check('formatBytes 输出可读大小', () => {
    assertEq(ImageCore.formatBytes(512), '512 B');
    assertEq(ImageCore.formatBytes(2048), '2.0 KB');
    assertEq(ImageCore.formatBytes(3 * 1024 * 1024), '3.00 MB');
  });
  await checkAsync('qualityWarnings 对过小的图给出提醒', async () => {
    const s = await makeSession(200, 100);
    const warns = ImageCore.qualityWarnings(s);
    assert(warns.length > 0, '应当给出尺寸提醒');
    assert(warns[0].includes('200×100'), warns[0]);
    ImageCore.disposeSession(s);
  });
  await checkAsync('isPristine 判定未编辑状态', async () => {
    const s = await makeSession(900, 700);
    assert(ImageCore.isPristine(s), '刚导入应是未编辑');
    s.adjust.contrast = 5;
    assert(!ImageCore.isPristine(s), '调过参数就不该是未编辑');
    ImageCore.disposeSession(s);
  });

  document.getElementById('result').textContent = wrapResult(results);
}

run().catch((e) => {
  document.getElementById('result').textContent = wrapResult([
    { name: '测试自身异常', ok: false, detail: (e && e.stack) || String(e) },
  ]);
});
</script>
`;

// ============================================================
// 主流程
// ============================================================

const FIXTURE_REL = 'scripts/_tmp_image-core-test.html';

function writeFixture() {
  const html = FIXTURE_HEAD + inlineScripts() + FIXTURE_BODY;
  const abs = path.join(ROOT, FIXTURE_REL);
  fs.writeFileSync(abs, html, 'utf8');
  return abs;
}

/**
 * 用无头浏览器跑一次页面，取回 DOM。
 * 具体坑与做法见 scripts/_lib/browser-test.js 的说明。
 */
function runBrowser(exe, url, workDir) {
  // 这个套件有大量逐像素断言（getImageData 很慢），超时给得比默认更宽
  return BrowserTest.runPage(exe, url, { workDir, virtualTimeMs: 900000, timeoutMs: 480000 });
}

async function main() {
  const keep = process.argv.includes('--keep');
  const explicit = (process.argv.find((a) => a.startsWith('--browser=')) || '').slice('--browser='.length);

  const exe = BrowserTest.findBrowser(explicit);
  if (!exe) {
    console.log('\n未找到 Chrome / Edge，跳过浏览器测试。');
    console.log('可以用 --browser="<chrome.exe 路径>" 指定。\n');
    return 0;
  }

  console.log(`\n浏览器: ${exe}`);
  writeFixture();

  const started = await Server.start({ root: ROOT, port: 0 });
  const { url, marker } = BrowserTest.withResultMarker(
    `http://127.0.0.1:${started.port}/${FIXTURE_REL}`
  );
  console.log(`测试页: ${url}\n`);

  const workDir = BrowserTest.makeWorkDir('postmark-imgcore');

  let dom = '';
  try {
    dom = await runBrowser(exe, url, workDir);
  } finally {
    await Server.stop(started.server);
    if (!keep) {
      try { fs.unlinkSync(path.join(ROOT, FIXTURE_REL)); } catch (e) { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      console.log(`临时页面已保留: ${path.join(ROOT, FIXTURE_REL)}`);
      console.log(`浏览器输出已保留: ${workDir}`);
    }
  }

  const results = BrowserTest.extractJson(dom, marker);
  if (!results) {
    console.error('未能从页面取回测试结果（页面可能未执行完）。');
    // 页面没跑完时，最有用的信息是「结果标记在哪断了」，而不是 DOM 的前几行
    const preIdx = dom.indexOf('<pre id="result">');
    if (preIdx >= 0) {
      console.error('--- <pre id="result"> 附近 ---');
      console.error(dom.slice(preIdx, preIdx + 3000));
    } else {
      console.error('--- DOM 尾部（脚本之后的实际渲染结果）---');
      console.error(dom.slice(-3000));
    }
    return 1;
  }

  const failed = BrowserTest.report(results);
  console.log(`\n结果: ${results.length - failed} 通过, ${failed} 失败\n`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('\n测试自身出错:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
