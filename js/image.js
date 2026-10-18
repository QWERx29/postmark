/**
 * 图片处理核心 — 导入 / 校验 / EXIF / 编辑会话 / 导出
 * =====================================================
 * 依赖: js/img-naming.js (ImgNaming)
 *
 * 本文件只做「图片本身」的事，不碰 DOM 结构、不发 HTTP 请求：
 *   - 导入与校验（类型、大小、尺寸）
 *   - EXIF Orientation 归一化（设计稿第 8 节）
 *   - 编辑会话：原图 + 参数，而不是一串临时文件（第 10 节）
 *   - 渲染：旋转 → 裁剪 → 增强 → 一次编码（第 11 节，全流程只编码一次）
 *   - 命名规范化（复用 ImgNaming，与 服务端 img-export.js 同一份规则）
 *
 * 三条不能破的约束
 * ----------------
 *   1. 原始文件永不修改，也不复制第二份 —— 内存里只有解码后的位图；
 *   2. 编辑过程不产生中间文件，预览全程走内存 canvas；
 *   3. 最终文件只在用户点「保存」时编码一次，避免 JPEG 反复压缩。
 *
 * 用法
 * ----
 *   const session = await ImageCore.createSession(file);
 *   session.rotation = 90; session.crop = {x,y,w,h};   // 归一化 0~1
 *   await ImageCore.renderToCanvas(session, canvas, { maxSize: 1200 });
 *   const out = await ImageCore.exportBlob(session, { fileName: 'xxx.jpg' });
 */

'use strict';

const ImageCore = (function () {

  // ============================================================
  // 常量
  // ============================================================

  /** 单文件大小上限（与 img-export.js 保持一致） */
  const MAX_FILE_BYTES = 50 * 1024 * 1024;

  /** 业务建议的最小边长：过小的图允许导入，但保存前会提醒 */
  const MIN_SUGGEST_WIDTH = 800;
  const MIN_SUGGEST_HEIGHT = 600;

  /** 单边最大像素：超过则在导出时等比缩小，避免生成无法查看的巨图 */
  const MAX_OUTPUT_SIZE = 4096;

  /** 预览用的最长边（原图可能上千万像素，预览只画这么多） */
  const PREVIEW_MAX_SIZE = 1600;

  /** 支持的输入格式（以内容嗅探为准，扩展名只作参考） */
  const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
  const SUPPORTED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

  /** 增强参数的默认值（0 表示不变） */
  const DEFAULT_ADJUST = { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 };
  const ADJUST_RANGE = { min: -100, max: 100 };

  /** 裁剪比例预设 */
  const CROP_RATIOS = [
    { id: 'free', label: '自由', value: 0 },
    { id: '1:1', label: '1:1', value: 1 },
    { id: '4:3', label: '4:3', value: 4 / 3 },
    { id: '3:2', label: '3:2', value: 3 / 2 },
    { id: '16:9', label: '16:9', value: 16 / 9 },
    { id: '3:4', label: '3:4', value: 3 / 4 },
    { id: '2:3', label: '2:3', value: 2 / 3 },
  ];

  // ============================================================
  // 错误
  // ============================================================

  /** 带用户可读提示的错误（设计稿第 20 节：每个错误都要有处理建议） */
  class ImageError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'ImageError';
      this.code = code;
    }
  }

  const MESSAGES = {
    TYPE_UNSUPPORTED: '暂不支持该图片格式，请使用 JPG / PNG / WebP / BMP 图片。',
    TOO_LARGE: `图片文件过大，无法处理（上限 ${MAX_FILE_BYTES / 1048576} MB）。`,
    CORRUPT: '无法读取该图片，请确认文件是否完整。',
    NO_FILE: '没有选择文件。',
    EMPTY: '图片内容为空，无法处理。',
    DIMENSION: '图片尺寸异常（宽或高为 0），请换一张图片。',
    ENCODE_FAILED: '图片编码失败，请重试或换一张图片。',
  };

  function fail(code, extra) {
    return new ImageError(code, extra || MESSAGES[code] || '图片处理失败。');
  }

  // ============================================================
  // 基础工具
  // ============================================================

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /** 参数是否是「未做任何编辑」 */
  function isPristine(session) {
    if (!session) return true;
    const a = session.adjust || {};
    const noAdjust = (!a.brightness && !a.contrast && !a.saturation && !a.sharpness);
    const noRotate = !session.rotation;
    const c = session.crop;
    const noCrop = !c || (c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1);
    return noAdjust && noRotate && noCrop;
  }

  // ============================================================
  // EXIF Orientation
  // ============================================================
  // 手机拍的照片常常「像素是横的、靠 EXIF 标记要竖着看」。
  // 忽略它的后果：资源管理器里竖着的图，进编辑器变横的（设计稿第 8 节）。

  /**
   * 从 JPEG 的 APP1(Exif) 段里读 Orientation。
   * 不是 JPEG 或没有该字段时返回 1（正常方向）。
   * @param {ArrayBuffer} buffer
   * @returns {number} 1~8
   */
  function readExifOrientation(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4) return 1;
      // JPEG 必须以 FFD8 开头
      if (view.getUint16(0, false) !== 0xFFD8) return 1;

      let offset = 2;
      const len = view.byteLength;
      while (offset + 4 <= len) {
        const marker = view.getUint16(offset, false);
        // 段长度（含长度字段自身 2 字节）
        const size = view.getUint16(offset + 2, false);
        if (size < 2) break;

        if (marker === 0xFFE1) {
          const segStart = offset + 4;
          // "Exif\0\0"
          if (segStart + 6 > len) return 1;
          if (view.getUint32(segStart, false) !== 0x45786966) return 1;
          if (view.getUint16(segStart + 4, false) !== 0x0000) return 1;

          const tiff = segStart + 6;
          if (tiff + 8 > len) return 1;
          const little = view.getUint16(tiff, false) === 0x4949;   // 'II' = Intel
          const ifdOffset = view.getUint32(tiff + 4, little);
          const ifd = tiff + ifdOffset;
          if (ifd + 2 > len) return 1;

          const count = view.getUint16(ifd, little);
          for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (entry + 12 > len) return 1;
            const tag = view.getUint16(entry, little);
            if (tag === 0x0112) {                                  // Orientation
              const type = view.getUint16(entry + 2, little);
              if (type !== 3) return 1;                            // 必须是 SHORT
              const value = view.getUint16(entry + 8, little);
              return value >= 1 && value <= 8 ? value : 1;
            }
          }
          return 1;
        }

        // SOS(FFDA) 之后是压缩数据，不会有 Exif 了
        if (marker === 0xFFDA) break;
        offset += 2 + size;
      }
    } catch (e) {
      // 解析失败不视为错误：当作正常方向处理，后面的解码才是真正的校验
    }
    return 1;
  }

  /** 该 Orientation 是否把宽高对调（5/6/7/8 是旋转 90/270） */
  function orientationSwapsAxes(o) {
    return o === 5 || o === 6 || o === 7 || o === 8;
  }

  /**
   * 把 EXIF 方向「烧进像素」。
   *
   * 为避免浏览器实现差异导致的双重旋转，这里**不用** createImageBitmap 的
   * imageOrientation 选项，而是自己解析 EXIF 并手动做变换：
   * 规则只有一处，出问题时也只需要看这一个函数。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} iw 传入 drawImage 的源图宽度（即原始像素宽 rawWidth）
   * @param {number} ih 传入 drawImage 的源图高度（即原始像素高 rawHeight）
   * @param {number} orientation 1~8
   * @returns {{width:number, height:number}} 归一化后的尺寸（旋转 90° 类会交换宽高）
   */
  function applyOrientationTransform(ctx, iw, ih, orientation) {
    const swap = orientationSwapsAxes(orientation);
    const w = swap ? ih : iw;
    const h = swap ? iw : ih;

    switch (orientation) {
      case 2: // 水平镜像
        ctx.translate(iw, 0); ctx.scale(-1, 1);
        break;
      case 3: // 旋转 180°
        ctx.translate(iw, ih); ctx.rotate(Math.PI);
        break;
      case 4: // 垂直镜像
        ctx.translate(0, ih); ctx.scale(1, -1);
        break;
      case 5: // 转置：沿主对角线镜像
        ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1);
        break;
      case 6: // 顺时针 90°
        ctx.rotate(0.5 * Math.PI); ctx.translate(0, -ih);
        break;
      case 7: // 反转置：沿副对角线镜像
        ctx.rotate(0.5 * Math.PI); ctx.translate(iw, -ih); ctx.scale(-1, 1);
        break;
      case 8: // 逆时针 90°
        ctx.rotate(-0.5 * Math.PI); ctx.translate(-iw, 0);
        break;
      default: // 1 = 正常
        break;
    }
    return { width: w, height: h };
  }

  // ============================================================
  // 解码
  // ============================================================

  /** 是否支持某个 WebP 导出（老 Chromium 可能不支持） */
  let _webpSupport = null;
  function supportsWebpExport() {
    if (_webpSupport !== null) return _webpSupport;
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch (e) {
      _webpSupport = false;
    }
    return _webpSupport;
  }

  /**
   * 解码文件为 ImageBitmap。
   * 优先 createImageBitmap（不占 DOM、可 close 释放内存），
   * 不支持时退回 <img> + objectURL。
   */
  async function decode(file) {
    // 先嗅探内容类型：不能只信扩展名（设计稿第 4.1 节）
    const head = await file.slice(0, 16).arrayBuffer();
    const sniffed = sniffMime(head);

    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file);
        return { bitmap: bmp, width: bmp.width, height: bmp.height, sniffed, release: () => bmp.close() };
      } catch (e) {
        throw fail('CORRUPT');
      }
    }

    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(fail('CORRUPT'));
        el.src = url;
      });
      return {
        bitmap: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        sniffed,
        release: () => URL.revokeObjectURL(url),
      };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw (e instanceof ImageError ? e : fail('CORRUPT'));
    }
  }

  /**
   * 按内容字节判断真实格式（扩展名可能是骗人的）。
   * @param {ArrayBuffer} head 前 16 字节
   * @returns {string} MIME，识别不出返回 ''
   */
  function sniffMime(head) {
    const b = new Uint8Array(head);
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b.length >= 12 &&
        String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
        String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp';
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
    return '';
  }

  // ============================================================
  // 导入与校验
  // ============================================================

  /**
   * 校验一个文件。通过则返回 null，否则返回错误对象（不抛）。
   *
   * 是 async 的：只靠扩展名和 MIME 判断是不够的（设计稿第 4.1 节），
   * 一个改名成 .jpg 的文本文件必须在这里就被拦下，而不是等解码失败。
   * 因此会读文件头做内容嗅探。
   *
   * @param {File|Blob} file
   * @returns {Promise<ImageError|null>}
   */
  async function validate(file) {
    if (!file) return fail('NO_FILE');
    if (!file.size) return fail('EMPTY');
    if (file.size > MAX_FILE_BYTES) return fail('TOO_LARGE');

    // 扩展名与 MIME 只是线索，真正作数的是内容
    const name = String(file.name || '');
    const dot = name.lastIndexOf('.');
    const ext = (dot >= 0 ? name.slice(dot) : '').toLowerCase();
    const looksSupported = SUPPORTED_EXT.includes(ext) || SUPPORTED_MIME.includes(file.type);
    if (!looksSupported) return fail('TYPE_UNSUPPORTED');

    let sniffed = '';
    try {
      const head = await file.slice(0, 16).arrayBuffer();
      sniffed = sniffMime(head);
    } catch (e) {
      return fail('CORRUPT');
    }
    if (!sniffed) return fail('TYPE_UNSUPPORTED');
    if (!SUPPORTED_MIME.includes(sniffed)) return fail('TYPE_UNSUPPORTED');

    return null;
  }

  /**
   * 建立编辑会话。
   *
   * 会话 = 原始位图 + 一组编辑参数（设计稿第 10 节），
   * 不产生任何临时文件，也不修改原始文件。
   *
   * @param {File|Blob} file
   * @param {{decoder?:Function, orientation?:number, fileName?:string}} [opts]
   *        decoder   替换默认解码器，签名 (file) => {bitmap,width,height,sniffed,release}
   *                  仅供自动化测试注入确定性像素源使用
   *        orientation 跳过 EXIF 解析，直接指定方向（同样的测试用途）
   * @returns {Promise<object>} session
   */
  async function createSession(file, opts) {
    const o = opts || {};
    const invalid = await validate(file);
    if (invalid) throw invalid;

    const decoded = o.decoder ? await o.decoder(file) : await decode(file);

    // EXIF 方向：只有 JPEG 才可能带
    let orientation = 1;
    if (typeof o.orientation === 'number') {
      orientation = clamp(Math.round(o.orientation), 1, 8);
    } else {
      try {
        const headBuf = await file.slice(0, 256 * 1024).arrayBuffer();
        orientation = readExifOrientation(headBuf);
      } catch (e) {
        orientation = 1;
      }
    }

    const rawW = decoded.width;
    const rawH = decoded.height;
    if (!rawW || !rawH) {
      decoded.release();
      throw fail('DIMENSION');
    }
    if (!decoded.sniffed && !SUPPORTED_MIME.includes(file.type)) {
      decoded.release();
      throw fail('TYPE_UNSUPPORTED');
    }

    const swap = orientationSwapsAxes(orientation);
    const srcW = swap ? rawH : rawW;
    const srcH = swap ? rawW : rawH;

    // 预览基底：把方向 + 当前旋转烘焙进去，裁剪与增强在此基础上做。
    // 这样鼠标拖动裁剪框时不必每帧重算旋转，原始位图也能保持不动。
    const session = {
      fileName: o.fileName || file.name || 'image',
      fileSize: file.size,
      fileType: decoded.sniffed || file.type || '',
      /** EXIF 方向（1~8），导入时立即归一化，导出时不会重新写回 */
      exifOrientation: orientation,
      rawWidth: rawW,
      rawHeight: rawH,
      /** 归一化方向后的尺寸 = 像素坐标系的原点 */
      width: srcW,
      height: srcH,
      /** 用户额外旋转（度，顺时针为正，任意角度） */
      rotation: 0,
      /** 裁剪框：源坐标系里的归一化正矩形 (0~1)，不随旋转倾斜 */
      crop: { x: 0, y: 0, w: 1, h: 1 },
      /** 增强参数：-100 ~ 100，0 表示不变 */
      adjust: Object.assign({}, DEFAULT_ADJUST),
      /** 导出格式：'jpeg' | 'png' | 'webp' | 'source' */
      format: 'source',

      // 内部字段
      _bitmap: decoded.bitmap,
      _release: decoded.release,
      _sourceCanvas: null,      // 方向归一化后的完整图（预览用，长边 ≤ PREVIEW_MAX_SIZE）
      _sourceScale: 1,          // _sourceCanvas 相对原图的比例
      _undo: [],
      _redo: [],
    };

    session._sourceCanvas = buildSourceCanvas(session);
    return session;
  }

  /** 释放会话占用的内存（关闭 ImageBitmap 等） */
  function disposeSession(session) {
    if (!session) return;
    if (typeof session._release === 'function') {
      try { session._release(); } catch (e) { /* 已释放 */ }
      session._release = null;
    }
    session._bitmap = null;
    session._sourceCanvas = null;
  }

  /**
   * 把方向归一化 + 缩放到预览尺寸，得到「源画布」。
   *
   * 尺寸必须用**归一化方向之后**的 session.width/height：
   * 旋转 90° 类的 EXIF 方向会交换宽高，画布却按原始宽高建的话，
   * 内容会被挤进一个转置的画布里 —— 后续所有裁剪坐标就全错了。
   *
   * 导出路径不吃这个画布（它直接画原始位图，保证画质）。
   */
  function buildSourceCanvas(session) {
    const scale = Math.min(1, PREVIEW_MAX_SIZE / Math.max(session.width, session.height));
    // 方向归一化后的目标尺寸
    const cw = Math.max(1, Math.round(session.width * scale));
    const ch = Math.max(1, Math.round(session.height * scale));
    // 画原始位图时用的尺寸（旋转类方向下与上面是转置关系）
    const bw = Math.max(1, Math.round(session.rawWidth * scale));
    const bh = Math.max(1, Math.round(session.rawHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.save();
    applyOrientationTransform(ctx, bw, bh, session.exifOrientation);
    ctx.drawImage(session._bitmap, 0, 0, bw, bh);
    ctx.restore();

    session._sourceScale = scale;
    return canvas;
  }

  // ============================================================
  // 几何：旋转 / 裁剪
  // ============================================================
  //
  // 坐标系约定（任意角度旋转的关键）
  // --------------------------------
  //   · **源坐标系**：EXIF 方向归一化之后的图，尺寸 = session.width × session.height。
  //     裁剪框永远是这个坐标系里的一个正矩形（x, y, w, h ∈ 0~1）。
  //   · **旋转只作用在显示上**：预览把整张图按 rotation 绕中心转，
  //     而裁剪框始终是正的、贴着屏幕。
  //
  // 为什么不让裁剪框跟着图一起歪：用户要的是"把歪掉的画面转正，
  // 然后框选要保留的那块"。如果框跟着转，框就永远是斜的，既没法用，
  // 也没法表达"我要这个正矩形区域"。

  /** 把任意角度归一化到 [0, 360)。**顺时针为正**，与 canvas 的 rotate() 一致。 */
  function normalizeAngle(deg) {
    const n = Number(deg);
    if (!Number.isFinite(n)) return 0;
    return ((n % 360) + 360) % 360;
  }

  /** 角度 → 弧度 */
  function toRadians(deg) {
    return normalizeAngle(deg) * Math.PI / 180;
  }

  /**
   * 源矩形绕自身中心旋转后，在源坐标系里的**外接正矩形**。
   *
   * 两个用途：
   *   1. 预览：整张图旋转后的可见范围（画布要开这么大才装得下）；
   *   2. 裁剪框的边界：框旋转后必须仍落在图内（否则会把透明边裁进结果）。
   *
   * 注意 90° 的整数倍是个特例：外接矩形恰好等于原矩形（只是宽高互换），
   * 所以老的四分之一旋转行为完全不变。
   */
  function rotatedBounds(rect, rotation) {
    const w = Math.max(0, Number(rect.width) || 0);
    const h = Math.max(0, Number(rect.height) || 0);
    const rad = toRadians(rotation);
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const width = w * cos + h * sin;
    const height = w * sin + h * cos;
    // 中心不变
    return {
      width,
      height,
      centerX: (Number(rect.x) || 0) + w / 2,
      centerY: (Number(rect.y) || 0) + h / 2,
    };
  }

  /**
   * 输出尺寸。
   *
   * 语义：把「裁剪框那块内容」连同旋转一起带出来，所以输出是**正矩形**，
   * 尺寸就等于裁剪框自身的像素尺寸 —— 与角度无关。
   * （旋转改变的是"框里装的是哪部分内容"，不是输出形状。）
   */
  function outputSize(session) {
    const c = normalizeCrop(session.crop);
    return {
      width: Math.max(1, Math.round(c.w * session.width)),
      height: Math.max(1, Math.round(c.h * session.height)),
    };
  }

  /** 把裁剪框夹回 0~1，并保证在给定角度下仍完全落在图内 */
  function normalizeCrop(crop, rotation) {
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    let w = clamp(Number(c.w) || 0, 0.01, 1);
    let h = clamp(Number(c.h) || 0, 0.01, 1);
    let x = clamp(Number(c.x) || 0, 0, 1 - w);
    let y = clamp(Number(c.y) || 0, 0, 1 - h);
    // 浮点误差兜底
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (w < 0.01) { w = 0.01; x = Math.min(x, 0.99); }
    if (h < 0.01) { h = 0.01; y = Math.min(y, 0.99); }
    return { x, y, w, h };
  }

  /**
   * 当前角度下的**理论**最大裁剪尺寸（不含安全余量）。
   * 供界面提示与测试断言用；真正夹紧用户操作的是 clampCrop。
   */
  function maxCropSize(session) {
    return clampCrop(session, { x: 0, y: 0, w: 1, h: 1 }, { safety: false });
  }

  /**
   * 把裁剪框夹进「当前角度允许的范围」。
   *
   * 约束到底是什么
   * --------------
   * 输出是"裁剪框那块内容随旋转一起带出来"的正矩形，所以只要裁剪框的
   * **四个角**在旋转后仍落在原图内，输出里就不会掺进图外内容（不会出现透明角）。
   *
   * 为什么不用"外接矩形 ≤ 原图"这种写法：外接矩形是两个方向上的极值，
   * 拿它的不等式去反解宽高会得到互相矛盾的解（实际试过，会算出明显偏大的高度）。
   * 这里直接按四个角的充要条件求解：
   *
   *   角 (xi, yj) 旋转 θ 之后（绕图心）：
   *     X = cx + (xi−cx)cosθ − (yj−cy)sinθ
   *     Y = cy + (xi−cx)sinθ + (yj−cy)cosθ
   *   要求 0 ≤ X ≤ W、0 ≤ Y ≤ H。把裁剪框整体按比例 k 收缩时这些条件
   *   对 k 是线性的，因此能直接解出最大的 k，再一次性用它收缩宽高。
   *
   * @param {object} session
   * @param {{x:number,y:number,w:number,h:number}} crop 归一化裁剪框
   * @param {{safety?:boolean}} [opts] safety 默认 true（留一点抗锯齿余量）
   * @returns {{x:number,y:number,w:number,h:number}} 合法裁剪框
   */
  function clampCrop(session, crop, opts) {
    const withSafety = !(opts && opts.safety === false);
    const c = normalizeCrop(crop);
    const W = session.width;
    const H = session.height;
    const deg = normalizeAngle(session.rotation);

    let w = c.w;
    let h = c.h;

    // 90° 的整数倍：裁剪框与图对齐，什么都不用收（也不该动，否则 0° 会被无端缩小）
    if (Math.abs(deg % 90) > 1e-6) {
      const rad = toRadians(deg);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      // 1) 宽度先压到一个"还能有高度解"的范围
      const wCap = 1 / (Math.abs(cos) + (W / H) * Math.abs(sin));
      w = Math.min(w, wCap);
      h = Math.min(h, 1 / (Math.abs(cos) + (H / W) * Math.abs(sin)));

      // 2) 求解最大收缩比例 k：四个角旋转后都必须落在原图内
      const cx = W / 2;
      const cy = H / 2;
      const pxW = w * W;
      const pxH = h * H;
      // 源坐标系里，裁剪框中心相对图心的偏移（收缩以框中心为基准，该偏移不变）
      const ox = c.x * W + pxW / 2 - cx;
      const oy = c.y * H + pxH / 2 - cy;

      let k = 1;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const ax = sx * pxW / 2;
          const ay = sy * pxH / 2;
          // 旋转后的位置 = 图心 + R(偏移) + R(角偏移)
          // 约束 X ∈ [0, W] 与 Y ∈ [0, H] 各给一个关于 k 的上界
          //   基准量（不随 k 变）: bx = cx + (ox·cos − oy·sin)
          //   随 k 变的量:          qx = ax·cos − ay·sin
          const bx = cx + (ox * cos - oy * sin);
          const qx = ax * cos - ay * sin;
          const by = cy + (ox * sin + oy * cos);
          const qy = ax * sin + ay * cos;

          // bx + k·qx ≤ W  →  k ≤ (W − bx)/qx （qx > 0 时才是上界）
          if (qx > 1e-9) k = Math.min(k, (W - bx) / qx);
          // bx + k·qx ≥ 0  →  k ≤ −bx/qx（qx < 0 时）
          if (qx < -1e-9) k = Math.min(k, -bx / qx);
          if (qy > 1e-9) k = Math.min(k, (H - by) / qy);
          if (qy < -1e-9) k = Math.min(k, -by / qy);
        }
      }

      // 留一点余量：公式给的是恰好贴边，canvas 取整 + 抗锯齿会溢出到图外。
      // 求"理论最大值"的调用方要关掉它，否则同一份余量会被叠加两次。
      if (withSafety) k *= 0.997;
      k = clamp(k, 0, 1);
      w *= k;
      h *= k;
    }

    // 以框中心为基准缩放，再夹回边界
    w = clamp(w, 0.01, 1);
    h = clamp(h, 0.01, 1);
    const maxX = 1 - w;
    const maxY = 1 - h;
    const x = clamp(c.x + c.w / 2 - w / 2, 0, maxX);
    const y = clamp(c.y + c.h / 2 - h / 2, 0, maxY);
    return { x, y, w, h };
  }

  /**
   * 图绕中心旋转后，在源坐标系里的外接矩形（预览画布要开这么大）。
   * @returns {{width:number, height:number}} 单位与传进来的 rect 相同
   */
  function frameBounds(session, usePreview) {
    const rect = usePreview && session._sourceCanvas
      ? { x: 0, y: 0, width: session._sourceCanvas.width, height: session._sourceCanvas.height }
      : { x: 0, y: 0, width: session.width, height: session.height };
    const b = rotatedBounds(rect, session.rotation);
    return { width: b.width, height: b.height };
  }

  /**
   * 按固定比例设置裁剪框。
   * 保留当前裁剪框的中心（用户已经对准了某个位置时不要跳回正中），
   * 新框按比例放大到刚好装得下，再夹进当前角度允许的范围。
   *
   * @param {object} session
   * @param {number} ratio 宽/高；0 或假值表示自由比例（框恢复整图）
   */
  function setCropRatio(session, ratio) {
    if (!ratio) {
      // 自由比例：回到当前角度允许的最大范围
      session.crop = clampCrop(session, { x: 0, y: 0, w: 1, h: 1 });
      return session.crop;
    }

    const W = session.width;
    const H = session.height;
    const baseRatio = W / H;
    const current = normalizeCrop(session.crop);
    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;
    const limit = maxCropSize(session);

    // 目标比例换算到归一化空间：归一化比例 = 真实比例 × (H/W)
    const normRatio = ratio / baseRatio;

    // 先铺满可用范围，再按比例收敛，最后夹进角度限制
    let w;
    let h;
    if (normRatio >= 1) {
      w = 1;
      h = 1 / normRatio;
    } else {
      h = 1;
      w = normRatio;
    }
    const shrink = Math.min(1, limit.w / w, limit.h / h);
    w *= shrink;
    h *= shrink;

    const x = clamp(cx - w / 2, 0, 1 - w);
    const y = clamp(cy - h / 2, 0, 1 - h);
    session.crop = { x, y, w, h };
    return session.crop;
  }

  // ============================================================
  // 增强：参数 → canvas filter
  // ============================================================

  /**
   * 把 -100~100 的滑块值映射成 CSS filter 片段。
   * 亮度/对比度/饱和度优先走 canvas 的 filter（GPU 加速、快），
   * 但**不能只依赖它** —— 见 filterIsUsable()。
   */
  function buildFilter(adjust) {
    const a = adjust || {};
    const parts = [];
    if (a.brightness) parts.push(`brightness(${(100 + a.brightness).toFixed(1)}%)`);
    // 对比度与饱和度都以 100% 为基准，负值最低压到 0%
    if (a.contrast) parts.push(`contrast(${Math.max(0, 100 + a.contrast).toFixed(1)}%)`);
    if (a.saturation) parts.push(`saturate(${Math.max(0, 100 + a.saturation).toFixed(1)}%)`);
    return parts.length ? parts.join(' ') : 'none';
  }

  // ------------------------------------------------------------
  // canvas filter 可用性探测
  // ------------------------------------------------------------
  // 背景：ctx.filter 在部分环境下是**静默无效**的 —— 赋值不报错、画出来却是原样。
  // 实测在无 GPU 的 Chromium（软件光栅化）里就是这样，此时"亮度/对比度/饱和度"
  // 三个滑块看起来能用、实际什么都没做，属于最坏的一类 bug。
  // 因此这里做一次真实像素探测，不可用就退回逐像素实现。
  let _filterUsable = null;

  function filterIsUsable() {
    if (_filterUsable !== null) return _filterUsable;
    try {
      const probe = document.createElement('canvas');
      probe.width = 2; probe.height = 2;
      const pctx = probe.getContext('2d');
      pctx.fillStyle = 'rgb(255,0,0)';
      pctx.fillRect(0, 0, 2, 2);

      const out = document.createElement('canvas');
      out.width = 2; out.height = 2;
      const octx = out.getContext('2d');
      octx.filter = 'brightness(160%)';
      octx.drawImage(probe, 0, 0);

      const px = octx.getImageData(0, 0, 1, 1).data;
      // 纯红提亮 60% 后绿色分量应当明显抬起来；还是 0 就说明滤镜没生效
      _filterUsable = px[1] > 40;
    } catch (e) {
      _filterUsable = false;
    }
    return _filterUsable;
  }

  /**
   * 逐像素的亮度 / 对比度 / 饱和度（CSS filter 的等价实现）。
   *
   * 为什么值得写这一份：canvas filter 在软件光栅化的 Chromium 里静默失效，
   * 靠它兜底的话用户会以为"调了没反应"。逐像素实现慢一些，但结果确定、
   * 在任何环境都能验证，预览和导出也不会不一致。
   *
   * @param {HTMLCanvasElement} canvas 就地修改
   * @param {{brightness:number, contrast:number, saturation:number}} adjust
   */
  function applyAdjustPixels(canvas, adjust) {
    const a = adjust || {};
    const b = (a.brightness || 0) / 100;
    const c = 1 + (a.contrast || 0) / 100;
    const s = 1 + (a.saturation || 0) / 100;
    if (!b && !a.contrast && !a.saturation) return;

    const w = canvas.width;
    const h = canvas.height;
    if (w < 1 || h < 1) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let bl = d[i + 2];

      // 亮度：整体乘一个系数
      if (b) { r += r * b; g += g * b; bl += bl * b; }
      // 对比度：以中灰 128 为中心拉伸
      if (c !== 1) {
        r = (r - 128) * c + 128;
        g = (g - 128) * c + 128;
        bl = (bl - 128) * c + 128;
      }
      // 饱和度：向灰度靠拢或远离
      if (s !== 1) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = lum + (r - lum) * s;
        g = lum + (g - lum) * s;
        bl = lum + (bl - lum) * s;
      }

      d[i] = r < 0 ? 0 : (r > 255 ? 255 : r);
      d[i + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
      d[i + 2] = bl < 0 ? 0 : (bl > 255 ? 255 : bl);
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * 反锐化掩模：原图 + amount × (原图 − 模糊图)
   * @param {HTMLCanvasElement} canvas 就地修改
   * @param {number} amount 0~100
   */
  function applySharpen(canvas, amount) {
    if (!amount || amount <= 0) return;
    const w = canvas.width;
    const h = canvas.height;
    if (w < 3 || h < 3) return;

    // willReadFrequently：锐化要 getImageData + putImageData，
    // 不开的话每次读回都要从 GPU 拷一遍，大图上会明显卡顿
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const src = ctx.getImageData(0, 0, w, h);
    const s = src.data;

    // 3×3 高斯模糊（可分离：先横后纵）。
    // 中间结果必须用 Float32Array：Uint8ClampedArray 每一步都会取整，
    // 两趟下来误差累积会让锐化出现色带。
    const tmp = new Float32Array(w * h * 3);
    const blur = new Float32Array(w * h * 3);
    const k = [1, 2, 1];
    const div = 4;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const t = (y * w + x) * 3;
        const l = (y * w + Math.max(0, x - 1)) * 4;
        const r = (y * w + Math.min(w - 1, x + 1)) * 4;
        for (let c = 0; c < 3; c++) {
          tmp[t + c] = (s[l + c] * k[0] + s[i + c] * k[1] + s[r + c] * k[2]) / div;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (y * w + x) * 3;
        const up = (Math.max(0, y - 1) * w + x) * 3;
        const dn = (Math.min(h - 1, y + 1) * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          blur[t + c] = (tmp[up + c] * k[0] + tmp[t + c] * k[1] + tmp[dn + c] * k[2]) / div;
        }
      }
    }

    const amountF = clamp(amount, 0, 100) / 100 * 1.2;
    for (let i = 0, t = 0; i < s.length; i += 4, t += 3) {
      for (let c = 0; c < 3; c++) {
        const orig = s[i + c];
        const diff = orig - blur[t + c];
        s[i + c] = clamp(orig + amountF * diff, 0, 255);
      }
    }
    ctx.putImageData(src, 0, 0);
  }

  /** 参数是否需要锐化 */
  function needsSharpen(adjust) {
    return Boolean(adjust && adjust.sharpness);
  }

  // ============================================================
  // 渲染
  // ============================================================

  /**
   * 把会话渲染到目标 canvas。
   *
   * 语义（与设计稿第 6.3 节的顺序一致）：
   *   EXIF 归一化 → 用户旋转 → 裁剪 → 增强
   *
   * 两种用途：
   *   · **预览**（usePreviewSource=true）：画整张旋转后的图，画布开成外接矩形，
   *     裁剪框由界面叠在上面 —— 这样旋转过程中四角不会被切掉；
   *   · **导出**（usePreviewSource=false）：只画裁剪框那块内容，
   *     它随旋转一起转，输出仍是正矩形、尺寸 = 裁剪框尺寸。
   * 两者用的是同一个变换公式，只是"画什么区域"不同，因此不会出现所见非所得。
   *
   * @param {object} session
   * @param {HTMLCanvasElement} target
   * @param {{maxSize?:number, usePreviewSource?:boolean}} [opts]
   *        maxSize: 输出最长边上限（预览用来缩到画布大小；导出不传 = 1:1）
   *        usePreviewSource: 默认 true，用预览基底（快）；
   *                          导出时传 false，直接吃原始位图，保证画质
   * @returns {{width:number, height:number}}
   */
  function renderToCanvas(session, target, opts) {
    const o = opts || {};
    const usePreview = o.usePreviewSource !== false;

    const src = usePreview && session._sourceCanvas ? session._sourceCanvas : null;
    const baseW = src ? src.width : session.width;
    const baseH = src ? src.height : session.height;

    // 画什么区域、开多大画布
    const crop = normalizeCrop(session.crop);
    const outW = Math.max(1, crop.w * baseW);
    const outH = Math.max(1, crop.h * baseH);
    // 预览画整张图（开成旋转外接矩形）；导出只画裁剪那块（尺寸 = 裁剪尺寸）
    const frame = usePreview
      ? rotatedBounds({ x: 0, y: 0, width: baseW, height: baseH }, session.rotation)
      : null;
    const boundsW = Math.max(1, frame ? frame.width : outW);
    const boundsH = Math.max(1, frame ? frame.height : outH);

    const maxSize = o.maxSize || 0;
    const fitScale = maxSize > 0 ? Math.min(1, maxSize / Math.max(boundsW, boundsH)) : 1;
    const dw = Math.max(1, Math.round(boundsW * fitScale));
    const dh = Math.max(1, Math.round(boundsH * fitScale));

    target.width = dw;
    target.height = dh;
    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);

    const adjust = session.adjust || DEFAULT_ADJUST;
    const sharpness = adjust.sharpness || 0;

    // 增强管线：有颜色/锐化参数时先落到暂存画布，再一次性贴回目标
    const hasColor = Boolean(adjust.brightness || adjust.contrast || adjust.saturation);
    const useGpuFilter = hasColor && filterIsUsable();
    const usePixels = hasColor && !useGpuFilter;
    const hasSharpen = needsSharpen(adjust);

    // ── 渲染结构：先在"源坐标系"里 1:1 画好，再一次性缩到目标画布 ──
    //
    // 为什么不让变换矩阵同时承担缩放：
    //   canvas 的变换是左乘累积的（translate 加的是 a·M），"缩放 + 平移 + 旋转"
    //   混在一个矩阵里时，缩放会把我算好的平移量再乘一遍。之前就是这个原因导致
    //   "窗口把预览缩小显示时，内容只铺满画布一角并贴着左侧"，而 1:1 时完全正常。
    //   现在切成两段，每段只有一个职责，出问题一眼能定位：
    //     第一段（native）：只做旋转 + 平移，画布尺寸 = 旋转后外接矩形
    //     第二段（target）：把整幅按比例缩到目标画布
    const nativeW = Math.max(1, Math.round(boundsW));
    const nativeH = Math.max(1, Math.round(boundsH));
    // 需要暂存的三类情况：逐像素增强、锐化、需要缩放（避免先画大再缩时丢失细节）
    const needNative = usePixels || hasSharpen || fitScale !== 1;

    const scratch = needNative ? document.createElement('canvas') : null;
    if (scratch) {
      scratch.width = fitScale !== 1 ? nativeW : dw;
      scratch.height = fitScale !== 1 ? nativeH : dh;
    }
    const stage = scratch || target;
    const stageCtx = scratch ? scratch.getContext('2d') : ctx;
    // 第一段里的缩放：只有"不缩放"时才等于 1，此时画布就是目标尺寸
    const nativeScale = scratch && fitScale !== 1 ? 1 : fitScale;

    stageCtx.save();
    if (useGpuFilter) stageCtx.filter = buildFilter(adjust);
    stageCtx.imageSmoothingEnabled = true;
    stageCtx.imageSmoothingQuality = 'high';

    // 摆位：基点（预览=图心 / 导出=裁剪框中心）先被旋转、再平移，落到画布中心。
    // 也就是 R(基点) + t = 画布中心  ⇒  t = 画布中心 − R(基点)。
    const pivotX = usePreview ? baseW / 2 : crop.x * baseW + outW / 2;
    const pivotY = usePreview ? baseH / 2 : crop.y * baseH + outH / 2;
    const angleRad = toRadians(session.rotation);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const tx = (stage.width / 2) - (pivotX * cos - pivotY * sin);
    const ty = (stage.height / 2) - (pivotX * sin + pivotY * cos);

    stageCtx.translate(tx, ty);
    if (angleRad) stageCtx.rotate(angleRad);
    if (nativeScale !== 1) stageCtx.scale(nativeScale, nativeScale);

    if (usePreview) {
      // 预览基底已经烘焙了 EXIF 方向，这里只补用户旋转
      stageCtx.drawImage(src, 0, 0);
    } else {
      // 导出路径：吃原始位图，保证画质。方向变换对应矩阵最右侧的 E，
      // 先作用在位图像素上，所以最后调用。
      applyOrientationTransform(stageCtx, session.rawWidth, session.rawHeight, session.exifOrientation);
      stageCtx.drawImage(session._bitmap, 0, 0, session.rawWidth, session.rawHeight);
    }
    stageCtx.restore();

    // 颜色增强的第二条路径：逐像素（GPU 滤镜不可用时的兜底）
    if (usePixels) applyAdjustPixels(scratch, adjust);
    if (hasSharpen && scratch) applySharpen(scratch, sharpness);

    // 第二段：整幅缩到目标画布（只有需要暂存时才多这一步）
    if (scratch) {
      if (fitScale !== 1) {
        ctx.drawImage(scratch, 0, 0, scratch.width, scratch.height, 0, 0, dw, dh);
      } else {
        ctx.drawImage(scratch, 0, 0);
      }
    }

    return { width: dw, height: dh };
  }

  // ============================================================
  // 撤销 / 重做 / 重置
  // ============================================================

  const UNDO_LIMIT = 20;

  /** 记录当前参数快照（在修改参数之前调用） */
  function pushUndo(session) {
    if (!session) return;
    session._undo.push(snapshot(session));
    if (session._undo.length > UNDO_LIMIT) session._undo.shift();
    session._redo.length = 0;
  }

  function snapshot(session) {
    return JSON.stringify({
      rotation: session.rotation,
      crop: session.crop,
      adjust: session.adjust,
      format: session.format,
    });
  }

  function restore(session, snap) {
    const s = JSON.parse(snap);
    session.rotation = s.rotation;
    session.crop = s.crop;
    session.adjust = s.adjust;
    session.format = s.format;
  }

  function canUndo(session) { return Boolean(session && session._undo.length); }
  function canRedo(session) { return Boolean(session && session._redo.length); }

  function undo(session) {
    if (!canUndo(session)) return false;
    session._redo.push(snapshot(session));
    restore(session, session._undo.pop());
    return true;
  }

  function redo(session) {
    if (!canRedo(session)) return false;
    session._undo.push(snapshot(session));
    restore(session, session._redo.pop());
    return true;
  }

  /** 重置到「刚导入、只做了 EXIF 归一化」的状态 */
  function reset(session) {
    if (!session) return;
    pushUndo(session);
    session.rotation = 0;
    session.crop = { x: 0, y: 0, w: 1, h: 1 };
    session.adjust = Object.assign({}, DEFAULT_ADJUST);
    session.format = 'source';
  }  // ============================================================
  // 自动增强
  // ============================================================
  // 设计稿 9.1：自动增强不能直接覆盖用户当前调整 —— 结果先落到参数上，
  // 用户可以撤销，也可以再「重置」。

  /**
   * 灰世界 + 对比度拉伸：把偏暗/偏灰的照片拉到比较正常的范围。
   * @returns {{brightness:number, contrast:number, saturation:number, sharpness:number}}
   */
  function autoEnhance(session) {
    const sample = document.createElement('canvas');
    const size = 128;
    const ratio = session.width / session.height;
    sample.width = ratio >= 1 ? size : Math.max(1, Math.round(size * ratio));
    sample.height = ratio >= 1 ? Math.max(1, Math.round(size / ratio)) : size;

    const src = session._sourceCanvas;
    const sctx = sample.getContext('2d');
    sctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, sample.width, sample.height);
    const data = sctx.getImageData(0, 0, sample.width, sample.height).data;

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    let satSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      sumSq += lum * lum;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      satSum += max === 0 ? 0 : (max - min) / max;
      count++;
    }
    if (!count) return Object.assign({}, DEFAULT_ADJUST);

    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const std = Math.sqrt(variance);
    const sat = satSum / count;

    // 目标：平均亮度 128，标准差 58 左右
    const brightness = clamp(Math.round((128 - mean) * 0.6), ADJUST_RANGE.min, ADJUST_RANGE.max);
    const contrast = clamp(Math.round((58 / Math.max(12, std) - 1) * 100 * 0.5), ADJUST_RANGE.min, ADJUST_RANGE.max);
    const saturation = clamp(Math.round((0.35 - sat) * 120), ADJUST_RANGE.min, ADJUST_RANGE.max);

    return {
      brightness,
      contrast,
      saturation,
      // 原图偏软时给一点点锐化
      sharpness: std < 50 ? 18 : 0,
    };
  }

  // ============================================================
  // 导出
  // ============================================================

  /**
   * 决定导出格式。
   * 规则：用户显式选了就听用户的；否则「保持原格式」。
   * 有透明通道的 PNG 不会被悄悄压成 JPEG（设计稿第 13 节）。
   */
  function resolveFormat(session, requested) {
    const want = requested || session.format || 'source';
    const webpOk = supportsWebpExport();

    if (want === 'png') return 'png';
    if (want === 'webp') return webpOk ? 'webp' : 'jpeg';
    if (want === 'jpeg') return 'jpeg';

    // 'source'：保持原格式
    if (session.fileType === 'image/png') return 'png';
    if (session.fileType === 'image/webp') return webpOk ? 'webp' : 'jpeg';
    if (session.fileType === 'image/bmp') return 'png';
    return 'jpeg';
  }

  const FORMAT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp' };
  const FORMAT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

  /**
   * 生成最终图片。
   *
   * 全流程只在这里编码一次（设计稿第 11 节）：JPEG 不会被反复压缩。
   *
   * @param {object} session
   * @param {{quality?:number, format?:string, fileName?:string, maxSize?:number}} [opts]
   * @returns {Promise<{blob:Blob, width:number, height:number, format:string,
   *                    ext:string, mime:string, fileName:string, bytes:number,
   *                    dataUrl:string}>}
   */
  async function exportBlob(session, opts) {
    const o = opts || {};
    const format = resolveFormat(session, o.format);
    const quality = typeof o.quality === 'number' ? clamp(o.quality, 0.1, 1) : 0.92;

    const canvas = document.createElement('canvas');
    renderToCanvas(session, canvas, {
      usePreviewSource: false,
      maxSize: o.maxSize || MAX_OUTPUT_SIZE,
    });

    const mime = FORMAT_MIME[format];
    const blob = await canvasToBlob(canvas, mime, quality);
    if (!blob) throw fail('ENCODE_FAILED');

    const ext = FORMAT_EXT[format];
    let fileName = o.fileName || session.fileName || 'image';
    // 扩展名以实际输出为准（主名与扩展名分开处理）
    const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
    if (naming) {
      fileName = naming.sanitizeFileName(fileName, { mimeType: mime });
      const parts = naming.splitName(fileName);
      fileName = parts.stem + ext;
    } else if (!fileName.toLowerCase().endsWith(ext)) {
      fileName = fileName.replace(/\.[^.]+$/, '') + ext;
    }

    const dataUrl = await blobToDataUrl(blob);

    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      format,
      ext,
      mime,
      fileName,
      bytes: blob.size,
      dataUrl,
    };
  }

  /** canvas → Blob，带 toBlob 不支持的兜底 */
  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => resolve(blob), mime, quality);
        return;
      }
      try {
        const url = canvas.toDataURL(mime, quality);
        const bin = atob(url.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: mime }));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(fail('ENCODE_FAILED'));
      reader.readAsDataURL(blob);
    });
  }

  // ============================================================
  // 命名
  // ============================================================

  /**
   * 按业务规则生成文件名: [机构号]_[盖销时间]_[邮局名]_[序号].[扩展名]
   * 规则实现放在 img-naming.js，与服务端 img-export.js 共用同一份。
   *
   * @param {object} ctx
   * @param {{institutionCode?:string, cancelDate?:string, postOffice?:string}} ctx.record
   * @param {number} ctx.index
   * @param {string} [ctx.ext]
   * @param {string} [ctx.fallback] 三段都缺失时使用（通常是清洗过的原始文件名）
   */
  function buildFileName(ctx) {
    const c = ctx || {};
    const rec = c.record || {};
    const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
    if (!naming) {
      return { fileName: `image_${String(c.index || 1).padStart(2, '0')}${c.ext || '.jpg'}`, stem: 'image', ext: c.ext || '.jpg' };
    }
    return naming.buildFileName({
      instCode: rec.institutionCode,
      cancelDate: rec.cancelDate,
      officeName: rec.postOffice,
      index: c.index,
      ext: c.ext,
      fallback: c.fallback,
    });
  }

  /** 清洗用户输入的文件名（界面里手动改过之后） */
  function sanitizeFileName(name, mimeType) {
    const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
    if (!naming) return String(name || 'image.jpg');
    return naming.sanitizeFileName(name, { mimeType });
  }

  /** 人类可读的文件大小 */
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  /** 导出前的质量提醒（设计稿第 4.3 节：过小图片不阻止，但要说清楚） */
  function qualityWarnings(session) {
    const out = outputSize(session);
    const warns = [];
    if (out.width < MIN_SUGGEST_WIDTH || out.height < MIN_SUGGEST_HEIGHT) {
      warns.push(`最终尺寸 ${out.width}×${out.height} 小于建议的 ${MIN_SUGGEST_WIDTH}×${MIN_SUGGEST_HEIGHT}，可能存在质量问题。`);
    }
    if (out.width * out.height > 24 * 1000 * 1000) {
      warns.push('最终像素较多，保存与后续打开会较慢。');
    }
    return warns;
  }

  // ============================================================
  // 公开 API
  // ============================================================

  return {
    // 常量
    MAX_FILE_BYTES,
    MAX_OUTPUT_SIZE,
    MIN_SUGGEST_WIDTH,
    MIN_SUGGEST_HEIGHT,
    SUPPORTED_MIME,
    SUPPORTED_EXT,
    DEFAULT_ADJUST,
    ADJUST_RANGE,
    CROP_RATIOS,
    FORMAT_MIME,
    FORMAT_EXT,
    ImageError,

    // 基础
    sniffMime,
    readExifOrientation,
    orientationSwapsAxes,
    applyOrientationTransform,
    supportsWebpExport,
    formatBytes,
    isPristine,
    normalizeCrop,

    // 导入
    validate,
    createSession,
    disposeSession,

    // 几何
    normalizeAngle,
    toRadians,
    rotatedBounds,
    frameBounds,
    maxCropSize,
    clampCrop,
    outputSize,
    setCropRatio,

    // 渲染
    renderToCanvas,

    // 增强
    buildFilter,
    filterIsUsable,
    applyAdjustPixels,
    applySharpen,
    autoEnhance,

    // 会话状态
    pushUndo, undo, redo, canUndo, canRedo, reset,

    // 导出与命名
    resolveFormat,
    exportBlob,
    buildFileName,
    sanitizeFileName,
    qualityWarnings,
  };

})();

if (typeof module === 'object' && module.exports) module.exports = ImageCore;
