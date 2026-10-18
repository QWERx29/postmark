#!/usr/bin/env node
/**
 * 「录入日戳 → 上传图片」端到端回归测试
 * ======================================
 * 前面的两个测试分别覆盖服务端落盘（test-image-export.js）与图片核心算法
 * （test-image-core.js）。这里补上最后一环：**真实应用页面里的完整操作链**。
 *
 *   node scripts/test-image-e2e.js
 *   node scripts/test-image-e2e.js --keep     # 保留临时页面与截图，便于排查
 *   node scripts/test-image-e2e.js --browser="C:\path\to\chrome.exe"
 *
 * 覆盖的链路
 * ----------
 *   选择文件 → 校验 → 打开编辑器 → EXIF 归一化 → 旋转 → 裁剪 → 增强
 *   → 生成业务文件名 → 重名检测 → 保存到磁盘 → 表单里出现缩略图
 *   → 一起存进记录（photos 字段）→ 重开表单/编辑记录时能读回来
 *
 * 做法与取舍
 * ----------
 *   - 页面通过本地服务器加载真实的 index.html + js/*，不 mock 业务代码；
 *   - 只替换 ImageCore.createSession 的**解码器**（页面里画不出真实照片），
 *     注入一张四象限图，这样旋转/裁剪的结果可以逐像素断言；
 *   - fetch 只在「保存」这一段做包装：既验证发给服务端的请求体，
 *     又不放弃真实服务端的落盘校验 —— 包装后仍把请求转发给真服务端。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Server = require(path.join(ROOT, 'server.js'));
const BrowserTest = require(path.join(__dirname, '_lib', 'browser-test.js'));

const FIXTURE_REL = 'scripts/_tmp_image-e2e.html';

function writeFixture() {
  const abs = path.join(ROOT, FIXTURE_REL);
  fs.writeFileSync(abs, FIXTURE_HTML, 'utf8');
  return abs;
}

// ============================================================
// 页面（内联脚本，避免 file:// 跨源限制）
// ============================================================

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>图片功能端到端测试</title>
</head>
<body>
<!-- ============================================================
     录入表单的 DOM（与 index.html 的 #form-overlay 结构保持一致）
     必须排在脚本之前：EntryForm.init() 是同步 cacheDoms()
     ============================================================ -->
<div id="dialog-overlay" class="modal-overlay">
  <div class="modal-container">
    <p id="dialog-message"></p>
    <button type="button" id="dialog-cancel">取消</button>
    <button type="button" id="dialog-confirm">确定</button>
  </div>
</div>
<div id="form-overlay" class="modal-overlay">
  <div class="modal-container">
    <h2 id="form-title">录入日戳记录</h2>
    <form id="entry-form">
      <input type="hidden" id="f-save-id">
      <select id="f-province" class="form-select"></select>
      <select id="f-city" class="form-select" disabled></select>
      <div id="f-district-container">
        <select id="f-district" class="form-select" disabled><option value="">请先选择市</option></select>
      </div>
      <input type="text" id="f-postoffice">
      <input type="text" id="f-postalcode" maxlength="6">
      <div id="f-postalcode-hint"></div>
      <input type="text" id="f-instcode" maxlength="8">
      <select id="f-status"><option value="open">营业</option></select>
      <div class="date-wrap">
        <div class="date-input" id="date-input"><span id="date-text">请选择日期</span></div>
        <div class="cal-popup" id="cal-popup">
          <div class="cal-head">
            <button class="cal-btn" id="cal-prev">‹</button>
            <span id="cal-title"></span>
            <button class="cal-btn" id="cal-next">›</button>
          </div>
          <div class="cal-grid" id="cal-grid"></div>
        </div>
        <select id="f-canceldate-hour" class="hour-select"></select>
      </div>
      <select id="f-material" class="form-select"></select>
      <div id="f-stamp-list"></div>
      <button type="button" id="f-add-stamp" class="btn-small">+ 添加戳号</button>
      <input type="checkbox" id="f-has-meter">
      <div id="f-meter-fields" style="display:none;">
        <input type="text" id="f-meter-model">
        <input type="text" id="f-meter-no">
        <input type="text" id="f-meter-header">
        <input type="text" id="f-meter-lower">
      </div>
      <input type="checkbox" id="f-has-scenic">
      <div id="f-scenic-fields" style="display:none;">
        <div id="f-scenic-list"></div>
        <button type="button" id="f-add-scenic" class="btn-small">+ 添加名称</button>
      </div>
      <div class="form-section">
        <span>日戳图片</span><span class="photo-count" id="f-photo-count"></span>
        <div id="f-photo-area" class="photo-area">
          <div id="f-photo-list" class="photo-list"></div>
          <div class="photo-actions">
            <button type="button" id="f-photo-add" class="btn-small">+ 上传图片</button>
          </div>
          <input type="file" id="f-photo-input" multiple style="display:none">
        </div>
      </div>
      <textarea id="f-notes"></textarea>
      <button type="button" id="f-cancel" class="btn-cancel">取消</button>
      <button type="submit" id="f-submit" class="btn-primary">保存</button>
    </form>
  </div>
</div>

<script>
// ============================================================
// 测试骨架（必须最先定义：注入脚本会用到 results/check）
// ============================================================
// 运行标记由测试脚本经 ?r= 传入：用它包住结果，避免 Node 侧把脚本源码里的
// 字面量误当成"页面已跑完"（--dump-dom 是边写边出的）。
const RUN_MARKER = new URLSearchParams(location.search).get('r') || 'no-marker';
function wrapResult(results) {
  return '@@R:' + RUN_MARKER + JSON.stringify(results) + '@@R:' + RUN_MARKER + ':END';
}
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
}
function check(name, fn) {
  try { const d = fn(); record(name, true, d); }
  catch (e) { record(name, false, (e && e.message) || String(e)); }
}
async function checkAsync(name, fn) {
  try { const d = await fn(); record(name, true, d); }
  catch (e) { record(name, false, (e && e.message) || String(e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
function waitFor(fn, timeout, label) {
  const limit = timeout || 6000;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) { resolve(v); return; }
      if (Date.now() - t0 > limit) { reject(new Error('等待超时: ' + (label || '条件未满足'))); return; }
      setTimeout(tick, 40);
    };
    tick();
  });
}
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = wrapResult(results);
  document.body.appendChild(pre);
}
// 页面里任何未捕获的错误都收进来：图片链路是异步的，
// 出错时往往只表现为"编辑器一直没出现"，没有这条线索就只能瞎猜。
window.__errors = [];
window.addEventListener('error', (e) => {
  window.__errors.push('error: ' + ((e && e.message) || 'unknown'));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  window.__errors.push('rejection: ' + ((r && (r.stack || r.message)) || String(r)));
});
// 看门狗：任何一步卡住也要把已有结果交出去，而不是让外层空等
setTimeout(() => {
  if (!finished) {
    record('测试超时未跑完', false,
      '错误记录: ' + (window.__errors.length ? window.__errors.join(' ∥ ') : '（无）'));
    finish();
  }
}, 90000);
</script>

<!-- 应用真实依赖（与 index.html 加载的完全一致）。
     路径必须是绝对的：本测试页由 /scripts/ 提供，相对路径会解析成
     /scripts/js/... 而 404，页面直接变成空壳。 -->
<script src="/node_modules/echarts/dist/echarts.min.js"></script>
<script src="/node_modules/xlsx/dist/xlsx.full.min.js"></script>
<script src="/node_modules/jsbarcode/dist/JsBarcode.all.min.js"></script>

<script src="/js/data.js"></script>
<script src="/js/idb.js"></script>
<script src="/js/store.js"></script>
<script src="/js/postodb.js"></script>
<script src="/js/stats.js"></script>
<script src="/js/map.js"></script>
<script src="/js/img-naming.js"></script>
<script src="/js/image.js"></script>

<!-- ============================================================
     注入：解码器 + 导出记录
     只替换「解码」这一步（页面里画不出真实照片），
     其余（EXIF 解析、旋转、裁剪、增强、编码、命名）全部走真实实现。
     ============================================================ -->
<script>
(function () {
  // 五块取样图：四象限 + 中央中灰块。
  // 中央那块是给增强用的：四象限的纯色主通道都顶在 255，
  // 增益类操作（亮度/对比度）在那里是饱和区，看不出变化。
  window.QUAD = { TL: [255,0,0], TR: [0,255,0], BL: [0,0,255], BR: [255,255,0], MID: [100,100,100] };
  window.quadrantCanvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const hw = Math.floor(w/2), hh = Math.floor(h/2);
    const paint = (x,y,cw,ch,rgb) => { ctx.fillStyle = 'rgb('+rgb.join(',')+')'; ctx.fillRect(x,y,cw,ch); };
    paint(0,0,hw,hh,QUAD.TL); paint(hw,0,w-hw,hh,QUAD.TR);
    paint(0,hh,hw,h-hh,QUAD.BL); paint(hw,hh,w-hw,h-hh,QUAD.BR);
    const bw = Math.max(4, Math.round(w*0.25));
    const bh = Math.max(4, Math.round(h*0.25));
    paint(Math.round((w-bw)/2), Math.round((h-bh)/2), bw, bh, QUAD.MID);
    return c;
  };
  window.colorAt = function (cv, nx, ny) {
    const ctx = cv.getContext('2d');
    const x = Math.min(cv.width-1, Math.max(0, Math.round(nx*cv.width)));
    const y = Math.min(cv.height-1, Math.max(0, Math.round(ny*cv.height)));
    const d = ctx.getImageData(x,y,1,1).data;
    return [d[0],d[1],d[2]];
  };
  window.quadName = function (rgb) {
    const tol = 40;
    for (const k of Object.keys(QUAD)) {
      const w = QUAD[k];
      if (Math.abs(rgb[0]-w[0])<=tol && Math.abs(rgb[1]-w[1])<=tol && Math.abs(rgb[2]-w[2])<=tol) return k;
    }
    return 'rgb('+rgb.join(',')+')';
  };

  const origCreate = ImageCore.createSession;
  window.__inject = { orientation: 1, width: 240, height: 160, mime: 'image/png' };
  window.__e2eSession = null;
  ImageCore.createSession = async function (file, opts) {
    const s = await origCreate.call(ImageCore, file, Object.assign({}, opts, {
      decoder: async () => {
        const inj = window.__inject;
        const canvas = quadrantCanvas(inj.width, inj.height);
        return { bitmap: canvas, width: inj.width, height: inj.height, sniffed: inj.mime, release: () => {} };
      },
    }));
    // 留一份引用给测试取样（编辑器内部不暴露会话）
    window.__e2eSession = s;
    return s;
  };

  const origExport = ImageCore.exportBlob;
  window.__exports = [];
  ImageCore.exportBlob = async function (session, opts) {
    const out = await origExport.call(ImageCore, session, opts);
    // 用导出路径再渲染一次小图，逐像素确认"导出的就是看到的"
    const cv = document.createElement('canvas');
    ImageCore.renderToCanvas(session, cv, { usePreviewSource: false, maxSize: 400 });
    window.__exports.push({
      fileName: out.fileName, width: out.width, height: out.height,
      mime: out.mime, bytes: out.bytes,
      quadrants: [
        quadName(colorAt(cv,0.25,0.25)), quadName(colorAt(cv,0.75,0.25)),
        quadName(colorAt(cv,0.25,0.75)), quadName(colorAt(cv,0.75,0.75)),
      ].join(','),
      rotation: session.rotation,
      crop: JSON.parse(JSON.stringify(session.crop)),
      base: session._sourceCanvas ? session._sourceCanvas.width + 'x' + session._sourceCanvas.height : 'null',
      adjust: JSON.parse(JSON.stringify(session.adjust)),
    });
    return out;
  };
})();
</script>

<!-- Dialog：与 index.html 里的定义同签名，但立即 resolve，避免测试卡在弹窗上 -->
<script>
window.__dialogs = [];
const Dialog = {
  alert(msg) { window.__dialogs.push({ kind: 'alert', msg: String(msg) }); return Promise.resolve(); },
  confirm(msg) { window.__dialogs.push({ kind: 'confirm', msg: String(msg) }); return Promise.resolve(true); },
};
</script>

<!-- 真实应用脚本 -->
<script src="/js/tools.js"></script>
<script src="/js/crawler.js"></script>
<script src="/js/image-editor.js"></script>
<script src="/js/form.js"></script>

<script>
// ============================================================
// 端到端用例
// ============================================================

/** 造一个"看起来是真 PNG"的文件（含真实 CRC 与 zlib 流），内容是 1×1 像素 */
async function makeRealPngFile(name) {
  const crcTable = (() => {
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
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, false);
    const typeBytes = new TextEncoder().encode(type);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0); body.set(data, typeBytes.length);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(body), false);
    const out = new Uint8Array(len.length + body.length + crc.length);
    out.set(len, 0); out.set(body, 4); out.set(crc, 4 + body.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 1, false); dv.setUint32(4, 1, false);
  ihdr[8] = 8; ihdr[9] = 6;
  // 用 CompressionStream 产出合法的 zlib 流（PNG 的 IDAT）
  const raw = new Uint8Array([0x00, 0xff, 0x00, 0x00, 0xff]);
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw); writer.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  const sig = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = sig.length + chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  png.set(sig, o); o += sig.length;
  for (const c of chunks) { png.set(c, o); o += c.length; }
  return new File([png], name, { type: 'image/png' });
}

/** 通过真实的 change 事件把文件交给表单（等价于用户点选文件） */
function pickFiles(files) {
  const input = document.getElementById('f-photo-input');
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 造一个带 EXIF Orientation 的 JPEG 文件。
 *
 * 必须是**真 JPEG**：应用只对 JPEG 解析 EXIF（PNG 没有这个字段）。
 * 这也正是要测的东西 —— 手机竖拍照片就是「像素是横的 + EXIF 说要转 90°」，
 * 用户看到的必须是转正后的图。
 */
function makeExifJpegFile(orientation, name) {
  // TIFF 头（小端）+ IFD0 里一个 Orientation 条目
  const tiff = new Uint8Array(26);
  const tv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;              // 'II'
  tv.setUint16(2, 42, true);
  tv.setUint32(4, 8, true);                    // IFD0 偏移
  tv.setUint16(8, 1, true);                    // 条目数
  tv.setUint16(10, 0x0112, true);              // tag = Orientation
  tv.setUint16(12, 3, true);                   // 类型 SHORT
  tv.setUint32(14, 1, true);                   // count
  tv.setUint16(18, orientation, true);         // 值
  tv.setUint32(22, 0, true);                   // 下一个 IFD

  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const payloadLen = exifHeader.length + tiff.length;
  const app1 = new Uint8Array(4 + payloadLen);
  app1[0] = 0xFF; app1[1] = 0xE1;
  new DataView(app1.buffer).setUint16(2, payloadLen + 2, false);
  app1.set(exifHeader, 4);
  app1.set(tiff, 4 + exifHeader.length);

  // 让文件结构看起来像真 JPEG：SOI + APP1 + DQT + SOF0 + DHT + SOS + EOI
  const dqt = new Uint8Array([0xFF, 0xDB, 0x00, 0x43, 0x00,
    16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,
    14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,
    49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99]);
  const sof = new Uint8Array([0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const dht = new Uint8Array([0xFF, 0xC4, 0x00, 0x14, 0x00,
    0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0x00]);
  const sos = new Uint8Array([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);

  const parts = [app1, dqt, sof, dht, sos];
  const total = 2 + parts.reduce((s, p) => s + p.length, 0) + 2;
  const out = new Uint8Array(total);
  let o = 0;
  out[o++] = 0xFF; out[o++] = 0xD8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out[o++] = 0xFF; out[o++] = 0xD9;
  return new File([out], name || 'photo.jpg', { type: 'image/jpeg' });
}

/** 提交表单：先 preventDefault，否则会真的发起导航 */
function submitForm() {
  const form = document.getElementById('entry-form');
  const ev = new Event('submit', { bubbles: true, cancelable: true });
  ev.preventDefault();
  form.dispatchEvent(ev);
}

async function run() {
  // ---------- 启动表单 ----------
  EntryForm.init();
  EntryForm.open();

  // ---------- 填表单（文件名依赖这几个字段） ----------
  const provSel = document.getElementById('f-province');
  provSel.value = PostmarkData.getAllProvinces()[0].name;
  provSel.dispatchEvent(new Event('change'));
  const citySel = document.getElementById('f-city');
  citySel.value = citySel.options[1].value;
  citySel.dispatchEvent(new Event('change'));
  document.getElementById('f-postoffice').value = '中南海邮政支局';
  const pcInput = document.getElementById('f-postalcode');
  pcInput.value = '100017';
  pcInput.dispatchEvent(new Event('input'));
  document.getElementById('f-instcode').value = '10001712';

  check('表单初始化后图片区是空的', () => {
    assertEq(document.querySelectorAll('#f-photo-list .photo-thumb').length, 0);
    assertEq(document.getElementById('f-photo-count').textContent, '');
  });

  // init() 里的监听器是按顺序挂的：从后往前试几个，就能定位它是在哪一步断掉的。
  // （"图片按钮点了没反应"这类问题，根因往往是前面某个 addEventListener 抛了）
  await checkAsync('init() 已把各段监听器挂完', async () => {
    const probes = [];
    const scenicBefore = document.querySelectorAll('#f-scenic-list .dynamic-row').length;
    document.getElementById('f-add-scenic').click();
    probes.push('scenic=' + (document.querySelectorAll('#f-scenic-list .dynamic-row').length > scenicBefore));
    const stampBefore = document.querySelectorAll('#f-stamp-list .dynamic-row').length;
    document.getElementById('f-add-stamp').click();
    probes.push('stamp=' + (document.querySelectorAll('#f-stamp-list .dynamic-row').length > stampBefore));
    let addThrew = '';
    try { document.getElementById('f-photo-add').click(); } catch (e) { addThrew = String(e.message || e); }
    probes.push('photoAdd=' + (addThrew ? 'THREW:' + addThrew : 'ok'));
    return probes.join(' ');
  });

  // ---------- 上传一张图 ----------
  // 用带 EXIF orientation=6 的真 JPEG：手机竖拍照片就是这种形式，
  // 应用必须靠解析 EXIF 才能把它转正（PNG 没有这个字段，测不到这一点）。
  window.__inject = { orientation: 1, width: 240, height: 160, mime: 'image/jpeg' };
  const file = makeExifJpegFile(6, '微信图片_20260930153012.jpg');

  // 先直接用同一个文件建一个会话：把"文件/EXIF/解码/会话"这一段单独验掉，
  // 剩下若还打不开编辑器，问题就只在 UI 那一段。
  await checkAsync('同一个文件能直接建出会话（EXIF 被正确解析并归一化）', async () => {
    const s = await ImageCore.createSession(file);
    const info = 'session=' + s.width + 'x' + s.height
      + ' base=' + s._sourceCanvas.width + 'x' + s._sourceCanvas.height
      + ' exif=' + s.exifOrientation;
    assertEq(s.exifOrientation, 6, 'EXIF 方向应被解析出来 | ' + info);
    assertEq(s.width, 160, '归一化后宽 | ' + info);
    assertEq(s.height, 240, '归一化后高 | ' + info);
    ImageCore.disposeSession(s);
    return info;
  });

  await checkAsync('文件能通过 change 事件送进表单', async () => {
    const input = document.getElementById('f-photo-input');
    const seen = [];
    input.addEventListener('change', () => {
      seen.push('n=' + (input.files ? input.files.length : 'null'));
    }, true);   // 捕获阶段：即使业务监听器改过 value 也能看到当时的状态
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 业务监听器会先清空 value 再处理：value 空 = 它确实跑到了
    const valueAfter = input.value;
    // 清空 value 会不会把 files 也一起清掉？这正是"选了文件却没反应"的可疑点
    // （修好之后这里应当看到 files=0 但编辑器已经打开 —— 因为文件先被拷成了数组）
    const filesAfter = input.files ? input.files.length : 'null';
    await new Promise((r) => setTimeout(r, 300));
    return 'seen=' + JSON.stringify(seen)
      + ' 事件后value=' + JSON.stringify(valueAfter)
      + ' 事件后files=' + filesAfter
      + ' 对话框=' + JSON.stringify(window.__dialogs);
  });

  await waitFor(() => document.getElementById('image-editor-overlay') &&
    document.getElementById('image-editor-overlay').classList.contains('active'), 8000,
    '图片编辑器未打开；错误记录: ' + (window.__errors.length ? window.__errors.join(' ∥ ') : '（无）')
      + '；对话框: ' + JSON.stringify(window.__dialogs));
  check('选择文件后自动打开图片编辑器', () => true);

  const overlay = document.getElementById('image-editor-overlay');
  const canvas = overlay.querySelector('.ie-canvas');
  const nameInput = overlay.querySelector('#ie-file-name');

  await waitFor(() => canvas.width > 0 && nameInput.value.length > 0, 8000,
    '编辑器未完成首次渲染；错误=' + JSON.stringify(window.__errors)
      + '；画布=' + canvas.width + 'x' + canvas.height
      + '；文件名=' + JSON.stringify(nameInput.value));

  // ---------- EXIF 归一化 ----------
  // 注意：canvas.width/height 是**显示尺寸**（按窗口适配缩放过的），
  // 逻辑尺寸要看输出尺寸那一行。这里两者分开验证。
  check('EXIF orientation=6 在编辑器里被归一化（竖过来）', () => {
    const text = overlay.querySelector('.ie-status-main').textContent;
    const m = /尺寸 (\\d+) × (\\d+)/.exec(text);
    assert(m, '状态栏没有尺寸: ' + text);
    assertEq(m[1], '160', '归一化后宽应为原始高 | ' + text);
    assertEq(m[2], '240', '归一化后高应为原始宽 | ' + text);
    // 显示尺寸应当保持宽高比（竖图）
    assert(canvas.height > canvas.width, '预览画布应该是竖的: ' + canvas.width + 'x' + canvas.height);
    return text + '；画布 ' + canvas.width + 'x' + canvas.height;
  });

  check('文件名按 机构号_盖销时间_邮局名_序号 自动生成', () => {
    const m = /^(\\d{8})_(\\d{10})_(.+)_(\\d{2})\\.jpg$/.exec(nameInput.value);
    assert(m, '文件名不符合规则: ' + nameInput.value);
    assertEq(m[1], '10001712', '机构号段');
    assertEq(m[2].length, 10, '盖销时间应为 10 位');
    assertEq(m[3], '中南海邮政支局', '邮局名段');
    assertEq(m[4], '01', '序号段');
    return nameInput.value;
  });

  check('保存位置显示服务端图片目录', () => {
    const txt = overlay.querySelector('.ie-dir-text').textContent;
    assert(txt && txt !== '读取中…', '目录未加载: ' + txt);
    assert(/images/i.test(txt), '目录看起来不对: ' + txt);
    return txt;
  });

  // ---------- 旋转 ----------
  // 旋转按钮在 .ie-rot-buttons 里：逆时针 90° / 顺时针 90° / 180° / 重置旋转
  const rotButtons = overlay.querySelectorAll('.ie-rot-buttons .btn-small');
  check('旋转面板提供了四个按钮（含重置）', () => {
    assertEq(rotButtons.length, 4, '旋转按钮数');
    assert(/重置/.test(rotButtons[3].textContent), '第四个应是重置旋转');
  });

  const sizeOf = () => {
    // 用 [0-9] 而不是 \d：这段代码写在 Node 的模板字符串里，
    // 单个反斜杠会被模板吃掉（\d → d），只有 \\ 才能活着传到页面
    const m = /尺寸 ([0-9]+) × ([0-9]+)/.exec(overlay.querySelector('.ie-status-main').textContent);
    return m ? m[1] + 'x' + m[2] : '';
  };
  /** 状态栏里的角度（没有角度就不显示这一段） */
  const angleOf = () => {
    const m = /旋转 (-?[0-9]+)°/.exec(overlay.querySelector('.ie-status-main').textContent);
    return m ? Number(m[1]) : 0;
  };
  check('旋转前输出尺寸是 EXIF 归一化后的 160×240', () => assertEq(sizeOf(), '160x240', '旋转前尺寸'));

  rotButtons[1].click();   // 顺时针 90°
  await waitFor(() => angleOf() === 90, 5000, '旋转后角度未更新，当前 ' + angleOf());
  check('顺时针 90°：角度生效，输出尺寸不变（= 裁剪框尺寸）', () => {
    assertEq(angleOf(), 90, '角度');
    // 输出是"裁剪框那块内容随旋转带出来"的正矩形，尺寸与角度无关；
    // 旋转改变的是框里装的是哪部分内容
    assertEq(sizeOf(), '160x240', '输出尺寸不该随旋转改变');
    return sizeOf() + ' @' + angleOf() + '°';
  });

  await checkAsync('旋转 90° 后预览内容确实转了，且铺满画布', async () => {
    // 两件事一起验：
    //   1) 内容方向对了（四象限换位）；
    //   2) 内容**铺满**画布 —— 早先这里是错的：窗口把预览缩小显示时，
    //      画布 180×120 里内容只占 120×120 并贴着右侧，而 1:1 时完全正常。
    //      这类"只在缩放时出现"的错法从画面上很难一眼看出，所以专门量一下。
    const s = window.__e2eSession;
    const live = document.createElement('canvas');
    ImageCore.renderToCanvas(s, live, { usePreviewSource: true, maxSize: Math.max(canvas.width, canvas.height) });

    const coverage = (cv) => {
      const w = cv.width;
      const h = cv.height;
      const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n / (w * h);
    };
    const covLive = coverage(canvas);
    const covRef = coverage(live);
    assert(covLive > 0.98, '预览内容应铺满画布，实际覆盖率 ' + covLive.toFixed(3)
      + '（画布 ' + canvas.width + 'x' + canvas.height + '）');
    assert(Math.abs(covLive - covRef) < 0.02,
      '显示画布与同参数渲染不一致: ' + covLive.toFixed(3) + ' vs ' + covRef.toFixed(3));

    // 方向：顺时针 90° 后，源图 (sx, sy) 落到输出 (H−sy, sx)，
    // 所以画面左上来自源左下。取样点避开正中那块中灰。
    const sample = (cv, nx, ny) => quadName(colorAt(cv, nx, ny));
    const quads = [sample(canvas, 0.12, 0.12), sample(canvas, 0.88, 0.12),
                   sample(canvas, 0.12, 0.88), sample(canvas, 0.88, 0.88)].join(',');

    // 与 1:1 渲染交叉验证：1:1 那条路径已被 test-image-core.js 的几何断言锁死，
    // 两者象限若不一致，说明"缩小显示"这条路径本身有问题，而不是取样点选错
    const full = document.createElement('canvas');
    ImageCore.renderToCanvas(s, full, { usePreviewSource: true });
    const quadsFull = [sample(full, 0.12, 0.12), sample(full, 0.88, 0.12),
                       sample(full, 0.12, 0.88), sample(full, 0.88, 0.88)].join(',');

    const diag = 'display[' + canvas.width + 'x' + canvas.height + ']=' + quads
      + ' full[' + full.width + 'x' + full.height + ']=' + quadsFull
      + ' cov=' + covLive.toFixed(3) + '/' + covRef.toFixed(3);
    assertEq(quads, quadsFull, '缩放预览与 1:1 渲染方向不一致 | ' + diag);
    return quads + ' 覆盖率=' + covLive.toFixed(3);
  });

  // ---------- 任意角度 ----------
  // 这是本次新增的能力：滑块微调到任意角度，用于摆正拍歪的图。
  const angleRange = overlay.querySelector('#ie-angle-range');
  const angleInput = overlay.querySelector('#ie-angle-input');
  check('旋转面板提供了任意角度控件（滑块 + 数字输入）', () => {
    assert(angleRange, '缺少角度滑块');
    assert(angleInput, '缺少角度输入框');
    assertEq(angleRange.min, '-180', '滑块下限');
    assertEq(angleRange.max, '180', '滑块上限');
    return angleRange.min + '~' + angleRange.max;
  });

  check('滑块可以设成任意角度（例如 30°）', () => {
    angleRange.value = '30';
    angleRange.dispatchEvent(new Event('input', { bubbles: true }));
    assertEq(angleOf(), 30, '状态栏角度');
    assertEq(angleInput.value, '30', '数字框应同步');
    // 预览画布是按窗口适配缩放过的，不能断言绝对像素；
    // 但"外接矩形"的**形状**（长宽比）与角度一一对应，可以据此验证
    const rad = Math.PI / 6;
    const wantRatio = (160 * Math.cos(rad) + 240 * Math.sin(rad))
                    / (160 * Math.sin(rad) + 240 * Math.cos(rad));
    const gotRatio = canvas.width / canvas.height;
    assert(Math.abs(gotRatio - wantRatio) < 0.03,
      '预览长宽比应约 ' + wantRatio.toFixed(3) + '，实际 ' + gotRatio.toFixed(3));
    return '30° → 画布 ' + canvas.width + 'x' + canvas.height + '（比 ' + gotRatio.toFixed(3) + '）';
  });

  check('数字输入框也能设角度（可输入非整数角度）', () => {
    angleInput.value = '12.5';
    // 用 change 而不是 input：数字框在真实浏览器里也是"改完提交"才触发语义变化，
    // 我们的 handler 两种都接了，但测试用 change 更贴近实际交互
    angleInput.dispatchEvent(new Event('input', { bubbles: true }));
    angleInput.dispatchEvent(new Event('change', { bubbles: true }));
    assertEq(angleOf(), 13, '非整数角度应被接受（状态栏取整显示）');
    return '12.5° 已接受';
  });

  check('回到 90°（后续断言的前提）', () => {
    angleRange.value = '90';
    angleRange.dispatchEvent(new Event('input', { bubbles: true }));
    assertEq(angleOf(), 90, '回到 90°');
    return '90°';
  });

  await checkAsync('倾斜后裁剪框被自动收进图内', async () => {
    const s = window.__e2eSession;
    assert(s, '没有拿到会话');
    // 先要整图，倾斜状态下必须被收紧（否则旋转后框会伸到图外）
    angleRange.value = '30';
    angleRange.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => {
      const c = s.crop;
      return c.w < 0.999 || c.h < 0.999;
    }, 4000, '倾斜后裁剪框没有被收紧，当前 ' + JSON.stringify(s.crop));
    const c = s.crop;
    const lim = ImageCore.maxCropSize(s);
    assert(c.w <= lim.w + 1e-9 && c.h <= lim.h + 1e-9, '不该超过理论上限');
    return JSON.stringify(c);
  });

  // 转回整数角度（后续的裁剪/增强/保存断言都基于 90°）
  rotButtons[3].click();   // 重置旋转
  await waitFor(() => angleOf() === 0, 4000, '重置旋转未生效');
  rotButtons[1].click();   // 再顺时针 90°
  await waitFor(() => angleOf() === 90, 4000, '重新转 90° 未生效');
  check('重置旋转后可以再次旋转（步骤可重复）', () => assertEq(angleOf(), 90));

  // ---------- 裁剪 ----------
  overlay.querySelector('[data-tab="crop"]').click();
  overlay.querySelector('.ie-ratio-btn[data-ratio="1"]').click();
  await waitFor(() => {
    const m = /尺寸 (\\d+) × (\\d+)/.exec(overlay.querySelector('.ie-status-main').textContent);
    return m && m[1] === m[2];
  }, 4000, '1:1 裁剪后未变成正方形');
  check('选择 1:1 比例后输出为正方形', () => {
    const text = overlay.querySelector('.ie-status-main').textContent;
    const m = /尺寸 (\\d+) × (\\d+)/.exec(text);
    assert(m, '状态栏没有尺寸: ' + text);
    assertEq(m[1], m[2], '应为正方形，实际 ' + text);
    return text;
  });

  check('点击「回满」把裁剪框恢复为整图', () => {
    const fill = overlay.querySelector('.ie-ratio-btn[data-ratio="-1"]');
    assert(fill, '没有找到回满按钮');
    fill.click();
    const box = overlay.querySelector('.ie-crop-box');
    assert(box.style.width && parseFloat(box.style.width) > 0, '裁剪框宽度未恢复');
  });

  // ---------- 增强 ----------
  overlay.querySelector('[data-tab="enhance"]').click();
  const bri = overlay.querySelector('.ie-slider input[data-key="brightness"]');
  // 取样点用图中央：画布中心正是那块中灰（RGB 100），提亮后三通道都会上升。
  // 四象限的纯色块顶在 255 上，增益类调整在那里看不出变化。
  bri.value = '40';
  bri.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => colorAt(canvas, 0.5, 0.5)[0] > 120, 5000, '亮度增强未生效到预览');
  check('亮度滑块会即时反映到预览', () => {
    const mid = colorAt(canvas, 0.5, 0.5);
    assert(mid[0] > 120, '中灰块应被提亮: ' + mid.join(','));
    return mid.join(',');
  });

  await checkAsync('撤销可以回退增强调整（且不动裁剪范围）', async () => {
    // 撤销点是在滑块的 pointerdown 上打下的（一次拖动只记一个），
    // 所以这里必须把 pointerdown 也派发出来，否则 Ctrl+Z 无点可退。
    // 走真实控件而不是直接改内部状态，才能一并验证"撤销点确实打对了地方"。
    const s = window.__e2eSession;
    assertEq(colorAt(canvas, 0.5, 0.5)[0] > 120, true, '起点应是已提亮的状态');

    const setBrightness = (v) => {
      bri.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      bri.value = String(v);
      bri.dispatchEvent(new Event('input', { bubbles: true }));
    };

    setBrightness(0);
    await waitFor(() => s.adjust.brightness === 0, 4000,
      '亮度没被设为 0（当前 adjust=' + JSON.stringify(s.adjust) + '）');
    // 渲染有节流，等画布真正刷新
    await waitFor(() => colorAt(canvas, 0.5, 0.5)[0] < 120, 4000,
      '调回 0 后预览未变化（当前 adjust=' + JSON.stringify(s.adjust) + '）');
    const dark = colorAt(canvas, 0.5, 0.5)[0];

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await waitFor(() => colorAt(canvas, 0.5, 0.5)[0] > dark, 5000,
      '撤销后预览未变化（brightness=' + s.adjust.brightness
        + ' 可撤销=' + ImageCore.canUndo(s) + ' 撤销栈=' + s._undo.length + '）');

    const crop = JSON.stringify(s.crop);
    assertEq(crop, JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }),
      '撤销只应回退亮度，不应动裁剪范围（尺寸 ' + sizeOf() + '）');
    const restored = colorAt(canvas, 0.5, 0.5).join(',');

    // 收尾：把亮度归零，让后面的导出断言只依赖几何（几何才是这一路要测的）
    setBrightness(0);
    await waitFor(() => colorAt(canvas, 0.5, 0.5)[0] < 120, 4000, '收尾归零未生效');
    return '撤销回到 ' + restored + '；裁剪保持整图';
  });

  // ---------- 保存 ----------
  const saveBtn = overlay.querySelector('.ie-actions .btn-primary');
  const beforeDialogs = window.__dialogs.length;
  saveBtn.click();

  await waitFor(() => !overlay.classList.contains('active'), 20000, '编辑器未在保存后关闭');

  const successDialog = window.__dialogs.slice(beforeDialogs).find((d) => /保存成功/.test(d.msg));
  check('保存后弹出成功提示（含文件名/尺寸/目录）', () => {
    assert(successDialog, '没有看到保存成功提示，实际: ' + JSON.stringify(window.__dialogs.slice(beforeDialogs)));
    assert(/文件名：/.test(successDialog.msg), successDialog.msg);
    assert(/尺寸：/.test(successDialog.msg), successDialog.msg);
    assert(/目录：/.test(successDialog.msg), successDialog.msg);
  });

  check('导出走的是原始位图路径，尺寸与角度均正确', () => {
    assertEq(window.__exports.length, 1, '导出次数');
    const e = window.__exports[0];
    // 这一路做过：EXIF 归一化(160×240) → 顺时针 90° → 1:1 裁剪 → 回满 → 增强 → 保存。
    // 输出尺寸恒等于裁剪框尺寸（回满后就是整图 160×240），旋转只改变内容朝向。
    assertEq(e.width, 160, '导出宽 | ' + JSON.stringify(e));
    assertEq(e.height, 240, '导出高 | ' + JSON.stringify(e));
    assertEq(e.rotation, 90, '旋转角度 | ' + JSON.stringify(e));
    // 方向由 ImageCore 的几何断言保证（见 test-image-core.js 的逐像素比对），
    // 这里只确认导出确实带上了旋转、且格式与内容都正常
    assert(/^BL|BR/.test(e.quadrants), '导出四象限应有内容: ' + e.quadrants);
    assert(e.bytes > 500, '导出文件过小，可能没内容: ' + e.bytes);
    return e.width + '×' + e.height + ' @' + e.rotation + '° ' + e.quadrants;
  });

  const exportedName = window.__exports[0].fileName;
  check('导出的扩展名与格式一致', () => {
    assert(/\\.jpg$/.test(exportedName), 'JPEG 源图应保持 JPEG: ' + exportedName);
    return exportedName;
  });

  // ---------- 表单里出现缩略图 ----------
  await waitFor(() => document.querySelectorAll('#f-photo-list .photo-thumb').length === 1, 5000,
    '表单里没有出现缩略图');
  check('保存后表单里出现缩略图，且不再是「待保存」', () => {
    const thumb = document.querySelector('#f-photo-list .photo-thumb');
    assert(thumb, '没有缩略图');
    assert(!thumb.classList.contains('photo-pending'), '不应还标记为待保存');
    assertEq(document.getElementById('f-photo-count').textContent, '已保存 1 张');
  });

  await checkAsync('缩略图能从服务端取回真实文件（不是本地占位）', async () => {
    const img = document.querySelector('#f-photo-list .photo-thumb img');
    assert(img.src.includes('/images/'), '缩略图地址不对: ' + img.src);
    const res = await fetch(img.src);
    assert(res.ok, '缩略图请求失败: ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert(buf.length > 0, '缩略图内容为空');
    return buf.length + ' 字节';
  });

  // ---------- 存进记录 ----------
  submitForm();
  await waitFor(() => !document.getElementById('form-overlay').classList.contains('active'), 6000,
    '表单未在提交后关闭');

  check('记录里保存了图片相对路径（photos 字段）', () => {
    const saved = RecordStore.getAll();
    assertEq(saved.length, 1, '记录数');
    const rec = saved[0];
    assert(Array.isArray(rec.photos), 'photos 不是数组: ' + JSON.stringify(rec.photos));
    assertEq(rec.photos.length, 1, '图片数');
    assert(/^[^/]+\\/.+\\.(png|jpg|webp)$/i.test(rec.photos[0]), '路径格式不对: ' + rec.photos[0]);
    return rec.photos[0];
  });

  // ---------- 重新打开（编辑模式）能读回图片 ----------
  EntryForm.open(RecordStore.getAll()[0]);
  await waitFor(() => document.querySelectorAll('#f-photo-list .photo-thumb').length === 1, 5000,
    '编辑模式没有读回图片');
  check('重新打开记录时能读回已保存的图片', () => {
    const thumb = document.querySelector('#f-photo-list .photo-thumb');
    assert(thumb, '没有缩略图');
    assert(!thumb.classList.contains('photo-pending'), '已保存的图不应标记为待保存');
    assertEq(document.getElementById('f-photo-count').textContent, '已保存 1 张');
  });

  // ---------- 移除图片后保存 ----------
  document.querySelector('#f-photo-list .photo-thumb .photo-thumb-del').click();
  await new Promise((r) => setTimeout(r, 120));
  check('移除图片后列表为空', () => {
    assertEq(document.querySelectorAll('#f-photo-list .photo-thumb').length, 0);
    assertEq(document.getElementById('f-photo-count').textContent, '');
  });

  submitForm();
  await waitFor(() => !document.getElementById('form-overlay').classList.contains('active'), 6000, '表单未关闭');
  check('移除后保存，记录里的 photos 变为空数组', () => {
    const rec = RecordStore.getAll()[0];
    assert(Array.isArray(rec.photos) && rec.photos.length === 0, JSON.stringify(rec.photos));
  });

  // ---------- 异常输入 ----------
  // 注意：注入的解码器不看文件内容，所以"内容嗅探失败"这一类要用
  // 扩展名/MIME 都对、但内容不是图片的文件来触发（这正是设计稿 4.1 的场景）。
  await checkAsync('伪装成 .jpg 的非图片文件被拒绝且不开编辑器', async () => {
    const fake = new File([new TextEncoder().encode('这不是图片，只是一段文本')], 'fake.jpg', { type: 'image/jpeg' });
    const before = window.__dialogs.length;
    pickFiles([fake]);
    await waitFor(() => window.__dialogs.length > before, 6000, '非法文件没有给出提示');
    const msg = window.__dialogs[window.__dialogs.length - 1].msg;
    assert(/不支持该图片格式/.test(msg), '提示不明确: ' + msg);
    assert(!document.getElementById('image-editor-overlay').classList.contains('active'), '不应打开编辑器');
    return msg;
  });

  await checkAsync('超过 50MB 的文件被拒绝并给出上限说明', async () => {
    const big = new File([new Uint8Array(ImageCore.MAX_FILE_BYTES + 10)], 'big.jpg', { type: 'image/jpeg' });
    const before = window.__dialogs.length;
    pickFiles([big]);
    await waitFor(() => window.__dialogs.length > before, 6000, '过大文件没有提示');
    const msg = window.__dialogs[window.__dialogs.length - 1].msg;
    assert(/过大/.test(msg), msg);
    assert(/50 MB/.test(msg), msg);
    return msg;
  });

  await checkAsync('不支持的格式给出明确提示', async () => {
    const txt = new File([new Uint8Array(16)], 'note.txt', { type: 'text/plain' });
    const before = window.__dialogs.length;
    pickFiles([txt]);
    await waitFor(() => window.__dialogs.length > before, 6000, '不支持的格式没有提示');
    const msg = window.__dialogs[window.__dialogs.length - 1].msg;
    assert(/不支持/.test(msg), msg);
    return msg;
  });
}

run().then(finish).catch((e) => {
  record('测试流程异常', false, (e && e.stack) || String(e));
  finish();
});
</script>
</body>
</html>
`;


// ============================================================
// 运行
// ============================================================

async function main() {
  const keep = process.argv.includes('--keep');
  const explicit = (process.argv.find((a) => a.startsWith('--browser=')) || '').slice('--browser='.length);

  const exe = BrowserTest.findBrowser(explicit);
  if (!exe) {
    console.log('\n未找到 Chrome / Edge，跳过端到端测试。');
    console.log('可以用 --browser="<chrome.exe 路径>" 指定。\n');
    return 0;
  }

  // 图片写到临时目录，别污染项目里的 output/
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postmark-e2e-'));
  process.env.POSTMARK_OUTPUT_DIR = path.join(tmpRoot, 'output');
  process.env.POSTMARK_IMAGES_DIR = path.join(tmpRoot, 'images');

  console.log(`\n浏览器  : ${exe}`);
  console.log(`图片目录: ${process.env.POSTMARK_IMAGES_DIR}`);
  writeFixture();

  const started = await Server.start({ root: ROOT, port: 0 });
  const { url, marker } = BrowserTest.withResultMarker(
    `http://127.0.0.1:${started.port}/${FIXTURE_REL}`
  );
  console.log(`测试页  : ${url}\n`);

  const workDir = BrowserTest.makeWorkDir('postmark-e2e-prof');

  let dom = '';
  try {
    dom = await BrowserTest.runPage(exe, url, { workDir });
  } finally {
    await Server.stop(started.server);
    if (!keep) {
      try { fs.unlinkSync(path.join(ROOT, FIXTURE_REL)); } catch (e) { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      console.log(`临时页面: ${path.join(ROOT, FIXTURE_REL)}`);
      console.log(`浏览器输出: ${workDir}`);
      console.log(`图片目录: ${process.env.POSTMARK_IMAGES_DIR}`);
    }
  }

  const results = BrowserTest.extractJson(dom, marker);
  if (!results) {
    console.error('未能从页面取回测试结果（页面可能未执行完）。');
    const preIdx = dom.indexOf('@@R:');
    console.error(preIdx >= 0 ? dom.slice(preIdx, preIdx + 2000) : dom.slice(-2000));
    return 1;
  }

  const failed = BrowserTest.report(results);
  console.log(`\n结果: ${results.length - failed} 通过, ${failed} 失败\n`);
  return failed === 0 ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }).catch((e) => {
  console.error('\n测试自身出错:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
