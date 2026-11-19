/**
 * 图片直传 — 校验 / 自动摆正 / 编码 / 落盘
 * ============================================
 * 依赖: ImageCore (image.js), ImgNaming (img-naming.js)
 *
 * 上传流程里不再打开图片编辑器：选好文件后直接按原始画面保存，
 * 只做三件必要的事 ——
 *   1. 读文件头校验格式 / 尺寸 / 大小；
 *   2. 按 EXIF 方向摆正（手机照片常见），不裁剪、不调色；
 *   3. 编码后 POST 给 /api/images/save 原子写盘。
 *
 * 记录里只存相对路径（相对 images/），与「日戳图片」完全一致。
 *
 * 对外接口: window.ImageUpload
 */
const ImageUpload = (function () {

  function unfiledDir() {
    return (typeof ImgNaming !== 'undefined' && ImgNaming.UNFILED_DIR) || '_unfiled';
  }

  /** 表单没保存过记录时落到 _unfiled/，保存过则用记录 ID 作为子目录 */
  function resolveSubdir(ctx) {
    const sub = ctx && ctx.subdir ? String(ctx.subdir) : '';
    return sub || unfiledDir();
  }

  /** 业务文件名：[机构号]_[日期]_[网点]_[序号].[扩展名] */
  function buildName(file, ctx, ext) {
    const rec = (ctx && ctx.record) || {};
    const info = ImageCore.buildFileName({
      record: {
        institutionCode: rec.institutionCode || '',
        cancelDate: rec.cancelDate || '',
        postOffice: rec.postOffice || '',
      },
      index: (ctx && ctx.index) || 1,
      ext,
      fallback: file && file.name ? file.name : '',
    });
    return info.fileName;
  }

  async function apiSave(payload) {
    let res;
    try {
      res = await fetch('/api/images/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error('无法连接本地服务，请确认应用仍在运行。');
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 错误页 */ }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `保存失败（HTTP ${res.status}）`);
    }
    return data;
  }

  /**
   * 直接保存一张图片（不进入编辑器）。
   *
   * @param {File|Blob} file
   * @param {{record?:object, subdir?:string, index?:number}} [ctx]
   *        record  当前表单草稿（机构号 / 日期 / 网点名，用于生成文件名）
   *        subdir  图片子目录；为空时落到 _unfiled
   *        index   同一记录内的序号（从 1 开始）
   * @returns {Promise<{relPath:string, fileName:string, width:number,
   *                    height:number, bytes:number, renamed:boolean}>}
   */
  async function save(file, ctx) {
    if (!file) throw new Error('没有可上传的图片。');
    if (typeof ImageCore === 'undefined') throw new Error('图片处理模块未加载，请刷新页面后重试。');

    const invalid = await ImageCore.validate(file);
    if (invalid) throw invalid;

    const session = await ImageCore.createSession(file);
    try {
      const format = ImageCore.resolveFormat(session);
      const ext = ImageCore.FORMAT_EXT[format] || '.jpg';
      const fileName = buildName(file, ctx, ext);

      const out = await ImageCore.exportBlob(session, { fileName, format });
      if (out.bytes > ImageCore.MAX_FILE_BYTES) {
        throw new Error(
          `图片处理后为 ${ImageCore.formatBytes(out.bytes)}，超过 ` +
          `${ImageCore.MAX_FILE_BYTES / 1048576} MB 上限，请先压缩后再上传。`
        );
      }

      const res = await apiSave({
        dataUrl: out.dataUrl,
        fileName: out.fileName,
        subdir: resolveSubdir(ctx),
        // 不进入编辑器就无法让用户选「覆盖 / 另存」；同名时自动编号，绝不覆盖已有图片
        conflict: 'rename',
      });

      return {
        relPath: res.relPath,
        fileName: res.fileName,
        width: out.width,
        height: out.height,
        bytes: res.size || out.bytes,
        renamed: Boolean(res.renamed),
      };
    } finally {
      ImageCore.disposeSession(session);
    }
  }

  return { save };
})();
