/**
 * 图片命名规范化 — 渲染层与服务端共用
 * ======================================
 * 设计稿第 12 节要求「文件名清洗独立成一个模块」，第 12.2 节要求
 * 「主名与扩展名分开处理」。本文件就是那条规则的**唯一**实现：
 *
 *   - 浏览器：<script src="js/img-naming.js"> → window.ImgNaming
 *   - Node  ：require('./js/img-naming.js') → module.exports
 *
 * 为什么必须共用
 * --------------
 * 前端拿它生成候选文件名并做即时预览，服务端在真正写盘前再清洗一遍兜底。
 * 两份实现迟早会漂移，于是出现「界面显示的名字」和「磁盘上的名字」不一致 ——
 * 记录里存的文件名也就对不上了。所以规则只有这一份。
 *
 * 规则（与设计稿 12.1 一致）
 * --------------------------
 *   1. 主名与扩展名分开处理，扩展名只保留安全白名单；
 *   2. Windows 非法字符 \ / : * ? " < > | 与控制字符 → '_'；
 *   3. 路径分隔符不会跨越目录：整串先按路径处理，只取最后一段；
 *   4. 前后空格与点（Windows 不允许文件名以点结尾）一律去掉；
 *   5. 折叠重复的下划线、去掉首尾下划线；
 *   6. 主名超长截断（默认 80 字符），避免超出路径长度限制；
 *   7. 清洗后为空时给出兜底名（默认 'image'）。
 *
 * 例子
 * ----
 *   sanitizeFileName('测试/图片:01?.jpg')      → '测试_图片_01.jpg'
 *   sanitizeFileName('  ..\\..\\evil.png ')    → 'evil.png'
 *   sanitizeFileName('微信图片_20260930153012.png') → '微信图片_20260930153012.png'
 *   sanitizeFileName('')                       → 'image.jpg'   （无扩展名时按 MIME 兜底）
 */

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImgNaming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** 文件名主体长度上限 */
  const MAX_STEM_LENGTH = 80;

  /** 允许的扩展名 → MIME（也用于内容魔数校验的键） */
  const EXT_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };

  /** MIME → 首选扩展名 */
  const MIME_EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
  };

  /** 未关联记录时图片落在的子目录名 */
  const UNFILED_DIR = '_unfiled';

  const DEFAULT_EXT = '.jpg';
  const FALLBACK_STEM = 'image';

  /**
   * 清洗一段名称（不含扩展名）。
   *
   * 路径分隔符**不做保留**：/\ 一律替换成下划线。
   * 设计稿 12.1 的例子就是「测试/图片:01?.jpg → 测试_图片_01.jpg」——
   * 期望的是把分隔符换掉，而不是把它当路径、只取最后一段。
   * （真正的目录穿越防护在调用方：先 path.basename，再交给本函数。）
   *
   * @param {string} input
   * @param {{maxLength?:number, fallback?:string, emptyFallback?:boolean}} [opts]
   *        fallback      清洗后为空时的取值
   *        emptyFallback 是否启用上述兜底；false 时返回 ''，
   *                      供「拼名字时可选字段不该凭空变成 image」的场景使用
   */
  function sanitizeStem(input, opts) {
    const o = opts || {};
    const maxLength = o.maxLength || MAX_STEM_LENGTH;
    const fallback = o.fallback || FALLBACK_STEM;
    const useFallback = o.emptyFallback !== false;

    let s = String(input == null ? '' : input).trim();

    // 路径分隔符 → 下划线（含两个方向）
    s = s.replace(/[\\/]+/g, '_');

    // 其余 Windows 非法字符与控制字符
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[:*?"<>|\u0000-\u001f]/g, '_');

    // 折叠重复下划线：'..\_.._evil' 这类结果不会留下一串噪音
    s = s.replace(/_{2,}/g, '_');

    // 前后空格与点（Windows 上以点结尾的文件名会被静默截断）
    s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    s = s.replace(/^_+/, '').replace(/_+$/, '').trim();

    if (s.length > maxLength) s = s.slice(0, maxLength).replace(/_+$/, '');
    const empty = !s || s === '.' || s === '..';
    if (empty) return useFallback ? fallback : '';
    return s;
  }

  /**
   * 拆分文件名为主名 + 扩展名（设计稿 12.2）。
   * @returns {{stem:string, ext:string}} ext 为小写且带点，未识别时为 ''
   */
  function splitName(fileName) {
    const raw = String(fileName == null ? '' : fileName).trim();
    const dot = raw.lastIndexOf('.');
    // 形如 ".gitignore" 的前导点不算扩展名
    if (dot <= 0 || dot === raw.length - 1) return { stem: raw, ext: '' };
    return { stem: raw.slice(0, dot), ext: raw.slice(dot).toLowerCase() };
  }

  /**
   * 清洗完整文件名，扩展名不在白名单时按 MIME 兜底。
   * @param {string} fileName
   * @param {{mimeType?:string, maxLength?:number}} [opts]
   * @returns {string}
   */
  function sanitizeFileName(fileName, opts) {
    const o = opts || {};
    const parts = splitName(fileName);
    const stem = sanitizeStem(parts.stem, { maxLength: o.maxLength });
    let ext = parts.ext;
    if (!ext || !EXT_MIME[ext]) {
      ext = MIME_EXT[String(o.mimeType || '').toLowerCase()] || DEFAULT_EXT;
    }
    return stem + ext;
  }

  /**
   * 清洗子目录名（通常传记录 ID）。
   * 先取 basename 再清洗，因此 'a/b' → 'b'、'../../..' → '_unfiled'，
   * 绝不会返回 '..' 之类可以跳出图片目录的值。
   */
  function sanitizeSegment(segment) {
    const raw = String(segment == null ? '' : segment).trim();
    const base = raw.replace(/\\/g, '/');
    const slash = base.lastIndexOf('/');
    const last = slash >= 0 ? base.slice(slash + 1) : base;
    return sanitizeStem(last, { fallback: UNFILED_DIR, maxLength: 60 });
  }

  /**
   * 生成业务文件名: [机构号]_[盖销时间]_[邮局名]_[序号].[扩展名]
   * 设计稿第 12 节：不使用 IMG_/微信图片_ 之类的原始名。
   *
   * @param {object} ctx
   * @param {string} [ctx.instCode]  机构号（8 位数字）
   * @param {string} [ctx.cancelDate] 盖销日期 YYYYMMDDHH，或 YYYY.MM.DD.HH
   * @param {string} [ctx.officeName] 邮局名称
   * @param {number} [ctx.index=1]    同一次录入内的序号（从 1 开始）
   * @param {string} [ctx.ext]        扩展名（含点）
   * @param {string} [ctx.fallback]   三段都缺失时使用（一般是清洗过的原始文件名）
   * @returns {{fileName:string, stem:string, ext:string}}
   */
  function buildFileName(ctx) {
    const c = ctx || {};

    const inst = sanitizeStem(c.instCode || '', { fallback: '', emptyFallback: false });
    // 盖销时间统一成 10 位 YYYYMMDDHH，界面上的点号只是展示格式
    const date = sanitizeStem(String(c.cancelDate || '').replace(/\./g, ''), { fallback: '', emptyFallback: false });
    const office = sanitizeStem(c.officeName || '', { fallback: '', emptyFallback: false });

    const segments = [inst, date, office].filter(Boolean);
    let stem = segments.join('_');

    // 退回原始文件名时只取主名：'IMG_1234.jpg' → 'IMG_1234'，
    // 否则会拼出 'IMG_1234.jpg_01.jpg' 这种带两个扩展名的名字
    const fallbackStem = sanitizeStem(splitName(c.fallback || '').stem, { fallback: '', emptyFallback: false });
    if (!stem) {
      // 关键字段一个都没填（例如用户先传图再填表）：退回清洗过的原始文件名，
      // 而不是生成一个空壳名字
      stem = fallbackStem || FALLBACK_STEM;
    }

    const idx = Number.isFinite(c.index) && c.index > 0 ? Math.floor(c.index) : 1;
    stem = `${stem}_${String(idx).padStart(2, '0')}`;

    let ext = String(c.ext || '').toLowerCase();
    if (!EXT_MIME[ext]) ext = DEFAULT_EXT;

    return { fileName: stem + ext, stem, ext };
  }

  return {
    MAX_STEM_LENGTH,
    EXT_MIME,
    MIME_EXT,
    UNFILED_DIR,
    DEFAULT_EXT,
    sanitizeStem,
    splitName,
    sanitizeFileName,
    sanitizeSegment,
    buildFileName,
  };
});
