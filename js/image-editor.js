/**
 * 图片编辑器 — 模态窗口
 * ==========================
 * 依赖: ImageCore (js/image.js)、ImgNaming (js/img-naming.js)、Dialog (index.html)
 *
 * 界面结构（对应设计稿第 5 节的线框图）：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ 编辑图片                                    ×│
 *   ├───────────────────────┬──────────────────────┤
 *   │                       │ 裁剪  旋转  增强      │
 *   │       图片预览         │ ─────────────────    │
 *   │     （含裁剪框）        │ 比例 / 旋转按钮       │
 *   │                       │ 亮度/对比度/饱和/锐度 │
 *   ├───────────────────────┴──────────────────────┤
 *   │ 文件名: ____  保存位置: ____                  │
 *   │ 尺寸 1200×900 · 356 KB      [取消] [保存]     │
 *   └──────────────────────────────────────────────┘
 *
 * 关键约定
 * --------
 *   1. 预览永远是「最终导出效果」：渲染走的是 ImageCore.renderToCanvas，
 *      与导出用的同一套变换，不存在"所见非所得"；
 *   2. 裁剪框在旋转后的坐标系里，所以旋转后框会重置（而不是错位）；
 *   3. 编辑过程不产生任何文件，也不动原始文件；取消即丢弃。
 */

'use strict';

const ImageEditor = (function () {

  // ============================================================
  // 状态
  // ============================================================
  let dom = null;
  let session = null;
  let cropRatio = 0;              // 0 = 自由
  let zoom = 1;
  let dirty = false;              // 有未保存的修改
  let busy = false;               // 正在保存
  let resolveOpen = null;         // open() 的 resolve
  let savedResult = null;         // 保存成功后的结果
  let fileNameEdited = false;     // 用户是否手动改过文件名
  let renderTimer = null;
  let dragState = null;

  const FILTER_TABS = [
    { id: 'crop', label: '裁剪' },
    { id: 'rotate', label: '旋转' },
    { id: 'enhance', label: '增强' },
  ];

  const ADJUST_SLIDERS = [
    { key: 'brightness', label: '亮度', hint: '整体明暗' },
    { key: 'contrast', label: '对比度', hint: '明暗差距' },
    { key: 'saturation', label: '饱和度', hint: '色彩浓度' },
    { key: 'sharpness', label: '锐度', hint: '边缘清晰度（较慢）' },
  ];

  // ============================================================
  // 小工具
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function notify(msg, kind) {
    if (typeof window.showToast === 'function') { window.showToast(msg, kind); return; }
    console.log('[ImageEditor]', msg);
  }

  // ============================================================
  // 构建 DOM
  // ============================================================
  function build() {
    if (dom) return dom;

    const overlay = el('div', 'modal-overlay');
    overlay.id = 'image-editor-overlay';

    const container = el('div', 'modal-container modal-image-editor');

    // ---- 头部 ----
    const header = el('div', 'modal-header');
    const title = el('h2', null, '编辑图片');
    const closeBtn = el('button', 'modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（Esc）';
    header.append(title, closeBtn);

    // ---- 主体 ----
    const body = el('div', 'modal-body ie-body');

    // 预览区
    const stage = el('div', 'ie-stage');
    const viewport = el('div', 'ie-viewport');
    const canvasWrap = el('div', 'ie-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvas.className = 'ie-canvas';
    const overlayBox = el('div', 'ie-crop-overlay');
    const cropBox = el('div', 'ie-crop-box');
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => {
      const h = el('div', `ie-crop-handle ie-h-${dir}`);
      h.dataset.dir = dir;
      cropBox.appendChild(h);
    });
    // 裁剪框外的遮罩（四条，避免用 box-shadow 在缩放时出现缝隙）
    const masks = ['top', 'right', 'bottom', 'left'].map((side) => {
      const m = el('div', `ie-crop-mask ie-mask-${side}`);
      overlayBox.appendChild(m);
      return m;
    });
    overlayBox.appendChild(cropBox);
    canvasWrap.append(canvas, overlayBox);
    viewport.appendChild(canvasWrap);
    stage.appendChild(viewport);

    const stageHint = el('div', 'ie-stage-hint', '');
    stage.appendChild(stageHint);

    // 控制区
    const side = el('div', 'ie-side');

    // 标签页
    const tabs = el('div', 'ie-tabs');
    const tabButtons = {};
    FILTER_TABS.forEach((t) => {
      const b = el('button', 'ie-tab', t.label);
      b.type = 'button';
      b.dataset.tab = t.id;
      tabButtons[t.id] = b;
      tabs.appendChild(b);
    });
    side.appendChild(tabs);

    const panels = el('div', 'ie-panels');
    const panelCrop = el('div', 'ie-panel');
    panelCrop.dataset.panel = 'crop';
    const panelRotate = el('div', 'ie-panel');
    panelRotate.dataset.panel = 'rotate';
    const panelEnhance = el('div', 'ie-panel');
    panelEnhance.dataset.panel = 'enhance';
    panels.append(panelCrop, panelRotate, panelEnhance);
    side.appendChild(panels);

    // ---- 裁剪面板 ----
    panelCrop.appendChild(el('div', 'ie-field-label', '裁剪比例'));
    const ratioRow = el('div', 'ie-ratio-row');
    const ratioButtons = {};
    const ratioList = ImageCore.CROP_RATIOS.slice();
    ratioList.push({ id: 'fill', label: '回满', value: -1, fill: true });
    ratioList.forEach((r) => {
      const b = el('button', 'ie-ratio-btn', r.label);
      b.type = 'button';
      b.dataset.ratio = String(r.value);
      b.dataset.ratioId = r.id;
      ratioButtons[r.id] = b;
      ratioRow.appendChild(b);
    });
    panelCrop.appendChild(ratioRow);
    const cropInfo = el('div', 'ie-field-hint', '拖动框内移动，拖角或边改变大小。');
    panelCrop.appendChild(cropInfo);

    panelCrop.appendChild(el('div', 'ie-field-label', '显示缩放'));
    const zoomRow = el('div', 'ie-zoom-row');
    const zoomOut = el('button', 'btn-small', '−');
    zoomOut.type = 'button';
    const zoomRange = document.createElement('input');
    zoomRange.type = 'range';
    zoomRange.className = 'ie-range';
    zoomRange.min = '100';
    zoomRange.max = '400';
    zoomRange.step = '5';
    zoomRange.value = '100';
    const zoomIn = el('button', 'btn-small', '+');
    zoomIn.type = 'button';
    const zoomLabel = el('span', 'ie-zoom-label', '100%');
    zoomRow.append(zoomOut, zoomRange, zoomIn, zoomLabel);
    panelCrop.appendChild(zoomRow);

    // ---- 旋转面板 ----
    // 旋转 = 任意角度：滑块负责微调（摆正倾斜的扫描件/翻拍），
    // 三个按钮负责 90° 的整数倍（拍歪了整张转过来这种最常见的操作）。
    panelRotate.appendChild(el('div', 'ie-field-label', '角度（顺时针）'));
    const angleRow = el('div', 'ie-angle-row');
    const angleRange = document.createElement('input');
    angleRange.type = 'range';
    angleRange.className = 'ie-range';
    angleRange.id = 'ie-angle-range';
    angleRange.min = '-180';
    angleRange.max = '180';
    angleRange.step = '1';
    angleRange.value = '0';
    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.className = 'form-input ie-angle-input';
    angleInput.id = 'ie-angle-input';
    angleInput.min = '-180';
    angleInput.max = '180';
    angleInput.step = '1';
    angleInput.value = '0';
    const angleUnit = el('span', 'ie-angle-unit', '°');
    angleRow.append(angleRange, angleInput, angleUnit);
    panelRotate.appendChild(angleRow);

    const rotRow = el('div', 'ie-rot-buttons');
    const rotLeft = el('button', 'btn-small', '↺ 逆时针 90°');
    const rotRight = el('button', 'btn-small', '↻ 顺时针 90°');
    const rot180 = el('button', 'btn-small', '⇅ 180°');
    const rotReset = el('button', 'btn-small', '重置旋转');
    [rotLeft, rotRight, rot180, rotReset].forEach((b) => { b.type = 'button'; });
    rotRow.append(rotLeft, rotRight, rot180, rotReset);
    panelRotate.appendChild(rotRow);
    panelRotate.appendChild(el('div', 'ie-field-hint',
      '滑块可微调到任意角度（用于摆正拍歪的图）。旋转后裁剪框会按当前角度重新收进图内，避免把透明边裁进结果。'));

    // ---- 增强面板 ----
    panelEnhance.appendChild(el('div', 'ie-field-label', '快速'));
    const quickRow = el('div', 'ie-quick-row');
    const autoBtn = el('button', 'btn-small', '自动增强');
    const resetEnhance = el('button', 'btn-small', '重置增强');
    autoBtn.type = 'button';
    resetEnhance.type = 'button';
    quickRow.append(autoBtn, resetEnhance);
    panelEnhance.appendChild(quickRow);

    const sliders = {};
    ADJUST_SLIDERS.forEach((s) => {
      const wrap = el('div', 'ie-slider');
      const head = el('div', 'ie-slider-head');
      head.append(el('span', 'ie-slider-label', s.label), el('span', 'ie-slider-value', '0'));
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'ie-range';
      range.min = String(ImageCore.ADJUST_RANGE.min);
      range.max = String(ImageCore.ADJUST_RANGE.max);
      range.step = '1';
      range.value = '0';
      range.dataset.key = s.key;
      const hint = el('div', 'ie-field-hint', s.hint);
      wrap.append(head, range, hint);
      panelEnhance.appendChild(wrap);
      sliders[s.key] = { range, value: head.querySelector('.ie-slider-value') };
    });

    // 格式
    panelEnhance.appendChild(el('div', 'ie-field-label', '输出格式'));
    const formatSel = document.createElement('select');
    formatSel.className = 'form-select';
    [
      { v: 'source', t: '保持原格式' },
      { v: 'jpeg', t: 'JPEG（体积小）' },
      { v: 'png', t: 'PNG（无损/透明）' },
      { v: 'webp', t: 'WebP（体积更小）' },
    ].forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.t;
      formatSel.appendChild(opt);
    });
    panelEnhance.appendChild(formatSel);

    // ---- 底部：文件名 / 保存位置 / 操作 ----
    const footer = el('div', 'ie-footer');

    const nameRow = el('div', 'ie-name-row');
    const nameLabel = el('label', 'ie-field-label', '文件名');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-input';
    nameInput.id = 'ie-file-name';
    nameInput.placeholder = '保存时使用的文件名';
    nameInput.autocomplete = 'off';
    nameRow.append(nameLabel, nameInput);
    footer.appendChild(nameRow);

    const dirRow = el('div', 'ie-dir-row');
    dirRow.append(el('span', 'ie-field-label', '保存位置'));
    const dirText = el('span', 'ie-dir-text', '读取中…');
    dirRow.appendChild(dirText);
    footer.appendChild(dirRow);

    const statusRow = el('div', 'ie-status-row');
    const status = el('div', 'ie-status', '');
    const actions = el('div', 'form-actions ie-actions');
    const cancelBtn = el('button', 'btn-cancel', '取消');
    cancelBtn.type = 'button';
    const saveBtn = el('button', 'btn-primary', '保存');
    saveBtn.type = 'button';
    actions.append(cancelBtn, saveBtn);
    statusRow.append(status, actions);
    footer.appendChild(statusRow);

    container.append(header, body, footer);
    body.append(stage, side);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    dom = {
      overlay, container, title, closeBtn,
      viewport, canvasWrap, canvas, overlayBox, cropBox, masks,
      stageHint,
      tabs, tabButtons, panels,
      panelCrop, panelRotate, panelEnhance,
      ratioRow, ratioButtons, cropInfo, zoomRow, zoomRange, zoomLabel, zoomOut, zoomIn,
      angleRange, angleInput, rotRow, rotLeft, rotRight, rot180, rotReset,
      autoBtn, resetEnhance, sliders, formatSel,
      nameInput, dirText, status, saveBtn, cancelBtn,
      config: null,
    };

    bindEvents();
    showTab('crop');
    return dom;
  }

  // ============================================================
  // 事件
  // ============================================================
  function bindEvents() {
    dom.closeBtn.addEventListener('click', () => requestClose());
    dom.cancelBtn.addEventListener('click', () => requestClose());
    dom.overlay.addEventListener('click', (e) => { if (e.target === dom.overlay) requestClose(); });

    dom.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.ie-tab');
      if (btn) showTab(btn.dataset.tab);
    });

    // ---- 裁剪比例 ----
    dom.ratioRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.ie-ratio-btn');
      if (!btn || !session) return;
      const value = Number(btn.dataset.ratio);
      ImageCore.pushUndo(session);
      if (value < 0) {
        // 回满
        session.crop = { x: 0, y: 0, w: 1, h: 1 };
        cropRatio = 0;
      } else {
        cropRatio = value;
        ImageCore.setCropRatio(session, value);
      }
      markDirty();
      render();
      updateRatioButtons();
    });

    // ---- 缩放 ----
    dom.zoomRange.addEventListener('input', () => {
      zoom = Number(dom.zoomRange.value) / 100;
      updateZoomLabel();
      render();
    });
    dom.zoomOut.addEventListener('click', () => nudgeZoom(-0.25));
    dom.zoomIn.addEventListener('click', () => nudgeZoom(0.25));

    // ---- 旋转 ----
    // 滑块：拖动时实时预览，并让数字框跟着走；pointerdown 记一个撤销点
    dom.angleRange.addEventListener('pointerdown', () => {
      if (session) ImageCore.pushUndo(session);
    });
    dom.angleRange.addEventListener('input', () => {
      applyAngle(Number(dom.angleRange.value));
    });
    dom.angleInput.addEventListener('pointerdown', () => {
      if (session) ImageCore.pushUndo(session);
    });
    dom.angleInput.addEventListener('input', () => {
      const v = dom.angleInput.value.trim();
      if (v === '' || v === '-' || v === '+') return;      // 还在输入负数，等下一拍
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      applyAngle(clamp(n, -180, 180), { syncControls: false });
    });
    // 输入框失焦时把显示值规范化（例如把 999 纠正成 180）
    dom.angleInput.addEventListener('blur', () => syncAngleControls());

    dom.rotLeft.addEventListener('click', () => applyAngle(session ? session.rotation - 90 : -90));
    dom.rotRight.addEventListener('click', () => applyAngle(session ? session.rotation + 90 : 90));
    dom.rot180.addEventListener('click', () => applyAngle(session ? session.rotation + 180 : 180));
    dom.rotReset.addEventListener('click', () => applyAngle(0));

    // ---- 增强 ----
    dom.autoBtn.addEventListener('click', () => {
      if (!session) return;
      ImageCore.pushUndo(session);
      const adj = ImageCore.autoEnhance(session);
      Object.assign(session.adjust, adj);
      markDirty();
      syncSliders();
      scheduleRender();
      notify('已应用自动增强，不满意可以撤销（Ctrl+Z）或重置增强');
    });
    dom.resetEnhance.addEventListener('click', () => {
      if (!session) return;
      ImageCore.pushUndo(session);
      Object.assign(session.adjust, ImageCore.DEFAULT_ADJUST);
      markDirty();
      syncSliders();
      scheduleRender();
    });

    // 滑块：拖动时立即更新数值显示，渲染做节流
    Object.keys(dom.sliders).forEach((key) => {
      const { range, value } = dom.sliders[key];
      range.addEventListener('pointerdown', () => {
        if (session) ImageCore.pushUndo(session);
      });
      range.addEventListener('keydown', () => {
        if (session) ImageCore.pushUndo(session);
      });
      range.addEventListener('input', () => {
        if (!session) return;
        session.adjust[key] = Number(range.value);
        value.textContent = range.value;
        markDirty();
        scheduleRender();
      });
    });

    dom.formatSel.addEventListener('change', () => {
      if (!session) return;
      session.format = dom.formatSel.value;
      markDirty();
      updateFileNameFromRecord();
      updateStatus(estimateInfo());
    });

    // ---- 文件名 ----
    dom.nameInput.addEventListener('input', () => {
      fileNameEdited = true;
      dom.nameInput.classList.remove('ie-input-error');
    });

    // ---- 保存 ----
    dom.saveBtn.addEventListener('click', () => doSave());

    // ---- 裁剪框拖拽 ----
    dom.cropBox.addEventListener('pointerdown', onCropPointerDown);

    // ---- 快捷键 ----
    document.addEventListener('keydown', onKeyDown);

    // 窗口尺寸变化时重新适配预览
    window.addEventListener('resize', () => { if (session) scheduleRender(); });

    // 关闭前拦截 Esc 冒泡到录入表单（避免把两个模态框一起关掉）
    dom.overlay.addEventListener('keydown', (e) => e.stopPropagation());
  }

  function showTab(id) {
    Object.keys(dom.tabButtons).forEach((k) => {
      dom.tabButtons[k].classList.toggle('active', k === id);
    });
    [dom.panelCrop, dom.panelRotate, dom.panelEnhance].forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === id);
    });
  }

  function nudgeZoom(delta) {
    zoom = clamp(Number((zoom + delta).toFixed(2)), 1, 4);
    dom.zoomRange.value = String(Math.round(zoom * 100));
    updateZoomLabel();
    render();
  }

  function updateZoomLabel() {
    dom.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function updateRatioButtons() {
    Object.keys(dom.ratioButtons).forEach((id) => {
      const btn = dom.ratioButtons[id];
      const value = Number(btn.dataset.ratio);
      const on = value < 0 ? false : (value === 0 ? !cropRatio : Math.abs(value - cropRatio) < 1e-6);
      btn.classList.toggle('active', on);
    });
  }

  function onKeyDown(e) {
    if (!dom || !dom.overlay.classList.contains('active')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (session && ImageCore.undo(session)) { afterHistoryChange(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      if (session && ImageCore.redo(session)) { afterHistoryChange(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!busy) doSave();
    }
  }

  function afterHistoryChange() {
    markDirty();
    syncSliders();
    render();
    updateRatioButtons();
  }

  // ============================================================
  // 渲染
  // ============================================================
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 60);
  }

  function markDirty() {
    dirty = true;
    dom.saveBtn.disabled = false;
  }

  /**
   * 计算预览画布在屏幕上的显示尺寸（等比适配 + 缩放）。
   *
   * 画布尺寸 = **整张图旋转后的外接矩形**，因此旋转过程中图的四角不会被切掉；
   * 而裁剪框用源坐标系直接折算成画布上的像素，所以它永远是正的、跟随内容旋转 ——
   * 这就是"图在转、框不动"的实现方式。
   */
  function computeDisplaySize() {
    const frame = ImageCore.frameBounds(session, true);   // 旋转后的外接矩形（源坐标系单位）
    const availW = Math.max(120, dom.viewport.clientWidth - 24);
    const availH = Math.max(120, dom.viewport.clientHeight - 24);
    const fit = Math.min(availW / frame.width, availH / frame.height, 1);
    const scale = fit * zoom;
    return {
      width: Math.max(1, Math.round(frame.width * scale)),
      height: Math.max(1, Math.round(frame.height * scale)),
      scale,
      baseFit: fit,
    };
  }

  function render() {
    if (!session || !dom) return;

    const size = computeDisplaySize();

    // 渲染分辨率：按显示尺寸 × DPR（避免发虚），但不超过导出上限
    const renderMax = Math.max(size.width, size.height) * (window.devicePixelRatio || 1);
    ImageCore.renderToCanvas(session, dom.canvas, {
      usePreviewSource: true,
      maxSize: Math.min(ImageCore.MAX_OUTPUT_SIZE, Math.round(renderMax)),
    });

    dom.canvas.style.width = size.width + 'px';
    dom.canvas.style.height = size.height + 'px';
    dom.canvasWrap.style.width = size.width + 'px';
    dom.canvasWrap.style.height = size.height + 'px';
    dom.overlayBox.style.width = size.width + 'px';
    dom.overlayBox.style.height = size.height + 'px';

    drawCropOverlay();
    updateStatus(estimateInfo());
  }

  /**
   * 把裁剪参数画成覆盖层（纯 CSS 定位，不重画图片）。
   *
   * 坐标换算：裁剪框是源坐标系里的归一化矩形，而画布显示的是"旋转后的外接矩形"。
   * 源图绕中心旋转，中心在画布上的位置恒为画布中心，所以
   *   画布上的左边界 = 画布中心 + (源归一化坐标 - 0.5) × 画布尺寸
   * 与角度无关 —— 这正是想要的"框不动、内容转"。
   */
  function drawCropOverlay() {
    if (!session) return;
    const W = dom.canvasWrap.clientWidth || parseFloat(dom.canvasWrap.style.width) || 1;
    const H = dom.canvasWrap.clientHeight || parseFloat(dom.canvasWrap.style.height) || 1;
    const c = ImageCore.normalizeCrop(session.crop);

    // 源坐标系的中心恒对应画布中心，所以归一化坐标直接乘画布尺寸就是像素位置
    // （这个式子对任意角度都成立 —— 框不动、内容转）
    const left = c.x * W;
    const top = c.y * H;
    const width = Math.max(8, c.w * W);
    const height = Math.max(8, c.h * H);

    const box = dom.cropBox.style;
    box.left = left + 'px';
    box.top = top + 'px';
    box.width = width + 'px';
    box.height = height + 'px';

    const [topMask, rightMask, bottomMask, leftMask] = dom.masks;
    const setMask = (m, l, t, w, h) => {
      m.style.left = l + 'px';
      m.style.top = t + 'px';
      m.style.width = Math.max(0, w) + 'px';
      m.style.height = Math.max(0, h) + 'px';
    };
    setMask(topMask, 0, 0, W, top);
    setMask(bottomMask, 0, top + height, W, H - top - height);
    setMask(leftMask, 0, top, left, height);
    setMask(rightMask, left + width, top, W - left - width, height);
  }

  // ============================================================
  // 裁剪框拖拽
  // ============================================================
  function onCropPointerDown(e) {
    if (!session || busy) return;
    const handle = e.target.closest('.ie-crop-handle');
    const inside = e.target.closest('.ie-crop-box');
    if (!handle && !inside) return;

    e.preventDefault();
    const W = dom.canvasWrap.clientWidth || 1;
    const H = dom.canvasWrap.clientHeight || 1;
    const rect = dom.canvasWrap.getBoundingClientRect();

    dragState = {
      dir: handle ? handle.dataset.dir : 'move',
      startX: e.clientX,
      startY: e.clientY,
      W,
      H,
      orig: ImageCore.normalizeCrop(session.crop),
      minSize: 16,
      pushed: false,
    };
    dom.cropBox.classList.add('dragging');
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onCropPointerMove);
    window.addEventListener('pointerup', onCropPointerUp);
    void rect;
  }

  function onCropPointerMove(e) {
    if (!dragState || !session) return;
    const st = dragState;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;

    if (!st.pushed) {
      // 真正开始移动时才记撤销点，单纯点一下不算编辑
      ImageCore.pushUndo(session);
      st.pushed = true;
    }

    const o = st.orig;
    let x = o.x;
    let y = o.y;
    let w = o.w;
    let h = o.h;

    const dxN = dx / st.W;
    const dyN = dy / st.H;
    const minW = st.minSize / st.W;
    const minH = st.minSize / st.H;

    const dir = st.dir;
    const lim = ImageCore.maxCropSize(session);   // 当前角度允许的最大范围
    if (dir === 'move') {
      x = clamp(o.x + dxN, 0, 1 - o.w);
      y = clamp(o.y + dyN, 0, 1 - o.h);
      // 只移动不缩放：越界与否交给 clampCrop 统一判定（它会连尺寸一起收）
      session.crop = ImageCore.clampCrop(session, { x, y, w: o.w, h: o.h });
      drawCropOverlay();
      updateStatus(estimateInfo());
      return;
    }

    // 角/边：分别调整四边，最后统一夹进允许范围。
    // 上界用 lim 而不是 1：倾斜时图的有效范围更小（超出会带进透明区域）
    let left = o.x;
    let top = o.y;
    let right = o.x + o.w;
    let bottom = o.y + o.h;

    if (dir.includes('w')) left = clamp(o.x + dxN, 0, right - minW);
    if (dir.includes('e')) right = clamp(o.x + o.w + dxN, left + minW, lim.w);
    if (dir.includes('n')) top = clamp(o.y + dyN, 0, bottom - minH);
    if (dir.includes('s')) bottom = clamp(o.y + o.h + dyN, top + minH, lim.h);

    x = left;
    y = top;
    w = right - left;
    h = bottom - top;

    // 固定比例：拖动角时按宽度反算高度（宽高比在像素空间保持一致）
    if (cropRatio && dir.length === 2) {
      const pxW = w * session.width;
      const wantH = pxW / cropRatio / session.height;
      let newTop = y;
      let newBottom = y + wantH;
      if (dir.includes('n')) {
        newTop = bottom - wantH;
        if (newTop < 0) { newTop = 0; newBottom = Math.min(1, wantH); }
      } else {
        newBottom = top + wantH;
        if (newBottom > 1) { newBottom = 1; newTop = Math.max(0, 1 - wantH); }
      }
      session.crop = { x, y: newTop, w, h: newBottom - newTop };
    } else {
      session.crop = { x, y, w, h };
    }

    session.crop = ImageCore.clampCrop(session, session.crop);
    drawCropOverlay();
    updateStatus(estimateInfo());
  }

  function onCropPointerUp() {
    if (dragState) dom.cropBox.classList.remove('dragging');
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onCropPointerMove);
    window.removeEventListener('pointerup', onCropPointerUp);
    if (dragState && dragState.pushed) markDirty();
    dragState = null;
  }

  // ============================================================
  // 旋转（任意角度）
  // ============================================================
  /**
   * 应用一个绝对角度。
   *
   * 三个容易踩的点：
   *   1. 角度要归一到 [-180, 180]：滑块的量程就是这样，用户看到 190° 会困惑
   *      （虽然数学上等价于 -170°）；
   *   2. 旋转后要把裁剪框收进"当前角度还留在图内"的范围。不收敛的话，
   *      倾斜后四角会转出画面，导出结果里就混进图外内容；
   *   3. 从"正着"大跨度转到"明显歪着"时，顺手把裁剪框重置为当前角度下的
   *      最大可用范围 —— 否则会被第一步收缩成一条细缝，用户一脸问号。
   *
   * @param {number} deg 目标角度（顺时针为正，可传任意值）
   * @param {{syncControls?:boolean}} [opts] 是否回写滑块/输入框
   */
  function applyAngle(deg, opts) {
    if (!session) return;
    const o = opts || {};
    const next = toDisplayAngle(deg);
    const changed = next !== session.rotation;

    // 大跨度倾斜（跨过 45° 量级）时，裁剪框多半已经不是用户想要的了，
    // 直接给成"这个角度下能取的最大范围"，避免出现一条细缝
    const bigSwing = changed && crossesTilt(session.rotation, next);
    session.rotation = next;
    if (bigSwing) {
      cropRatio = 0;
      session.crop = ImageCore.clampCrop(session, { x: 0, y: 0, w: 1, h: 1 });
      updateRatioButtons();
    } else {
      session.crop = ImageCore.clampCrop(session, session.crop);
    }

    if (o.syncControls !== false) syncAngleControls();
    if (changed) {
      markDirty();
      render();
    }
  }

  /**
   * 这次角度变化是否跨过了"整数角度 ↔ 倾斜"的边界。
   * 同侧的小幅微调不该重置裁剪框（用户正在对准），跨侧才重置。
   */
  function crossesTilt(from, to) {
    const tilted = (d) => Math.abs(normalizeTo180(d) % 90) > 1e-6;
    return tilted(from) !== tilted(to);
  }

  /** 归一到 (-180, 180] */
  function normalizeTo180(deg) {
    const n = ImageCore.normalizeAngle(deg);          // [0, 360)
    return n > 180 ? n - 360 : n;
  }

  /** 归一到 [-180, 180]，0 表示不旋转 */
  function toDisplayAngle(deg) {
    return normalizeTo180(deg);
  }

  /** 把当前角度写回滑块与输入框 */
  function syncAngleControls() {
    if (!session) return;
    const v = toDisplayAngle(session.rotation);
    dom.angleRange.value = String(Math.round(v));
    // 输入框正在被编辑时不要抢用户的输入
    if (document.activeElement !== dom.angleInput) {
      dom.angleInput.value = String(Math.round(v));
    }
  }

  // ============================================================
  // 状态与尺寸
  // ============================================================
  function estimateInfo() {
    const out = ImageCore.outputSize(session);
    return {
      width: out.width,
      height: out.height,
      format: ImageCore.resolveFormat(session),
    };
  }

  function updateStatus(info) {
    const i = info || estimateInfo();
    const ext = ImageCore.FORMAT_EXT[i.format] || '.jpg';
    const warn = ImageCore.qualityWarnings(session);
    // 角度可能带小数（滑块与输入框都允许），状态栏只显示整数度，避免一行里塞太多数字；
    // 精确角度仍保留在 session.rotation 里
    const angle = Math.round(ImageCore.normalizeAngle(session.rotation));
    const parts = [`尺寸 ${i.width} × ${i.height}`, `格式 ${ext.replace('.', '').toUpperCase()}`];
    if (angle) parts.push(`旋转 ${angle}°`);
    if (!ImageCore.isPristine(session)) parts.push('已编辑');
    dom.status.innerHTML = '';
    dom.status.appendChild(el('span', 'ie-status-main', parts.join(' · ')));
    if (warn.length) {
      dom.status.appendChild(el('span', 'ie-status-warn', warn[0]));
    }
    dom.stageHint.textContent = `${i.width} × ${i.height}`;
  }

  function syncSliders() {
    ADJUST_SLIDERS.forEach((s) => {
      const { range, value } = dom.sliders[s.key];
      const v = session.adjust[s.key] || 0;
      range.value = String(v);
      value.textContent = String(v);
    });
    dom.formatSel.value = session.format || 'source';
  }

  // ============================================================
  // 文件名
  // ============================================================
  /** 按当前记录信息生成候选文件名（用户手动改过就不覆盖） */
  function buildCandidateName() {
    const f = dom.form || {};
    const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
    const ext = ImageCore.FORMAT_EXT[ImageCore.resolveFormat(session)] || '.jpg';
    if (!naming) return `image_01${ext}`;
    return naming.buildFileName({
      instCode: f.institutionCode,
      cancelDate: f.cancelDate,
      officeName: f.postOffice,
      index: dom.index || 1,
      ext,
      fallback: session.fileName,
    }).fileName;
  }

  function updateFileNameFromRecord() {
    if (fileNameEdited) {
      // 用户手填过：只把扩展名对齐到实际输出格式
      const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
      const ext = ImageCore.FORMAT_EXT[ImageCore.resolveFormat(session)] || '.jpg';
      if (naming) {
        const parts = naming.splitName(dom.nameInput.value);
        dom.nameInput.value = parts.stem + ext;
      }
      return;
    }
    dom.nameInput.value = buildCandidateName();
  }

  // ============================================================
  // 保存
  // ============================================================
  async function doSave() {
    if (!session || busy) return;

    const rawName = dom.nameInput.value.trim();
    if (!rawName) {
      dom.nameInput.classList.add('ie-input-error');
      await Dialog.alert('请填写文件名。');
      dom.nameInput.focus();
      return;
    }

    const naming = (typeof ImgNaming !== 'undefined') ? ImgNaming : null;
    const ext = ImageCore.FORMAT_EXT[ImageCore.resolveFormat(session)] || '.jpg';
    let fileName = naming ? naming.sanitizeFileName(rawName, { mimeType: ImageCore.FORMAT_MIME[ImageCore.resolveFormat(session)] }) : rawName;
    if (naming) {
      const parts = naming.splitName(fileName);
      fileName = parts.stem + ext;
    }
    if (fileName !== rawName) {
      dom.nameInput.value = fileName;
    }

    busy = true;
    setBusy(true, '正在处理图片…');

    try {
      // 1) 编码（全流程唯一一次编码）
      const out = await ImageCore.exportBlob(session, {
        fileName,
        format: ImageCore.resolveFormat(session),
      });

      if (out.bytes > ImageCore.MAX_FILE_BYTES) {
        busy = false;
        setBusy(false, '');
        await Dialog.alert(
          `生成的文件为 ${ImageCore.formatBytes(out.bytes)}，超过 ${ImageCore.MAX_FILE_BYTES / 1048576} MB 上限。\n` +
          '请改用 JPEG 格式或先裁剪掉多余部分。'
        );
        return;
      }

      // 2) 质量提醒（不阻止保存 —— 设计稿 4.3）
      const warns = ImageCore.qualityWarnings(session);
      if (warns.length) {
        const go = await Dialog.confirm(`${warns.join('\n')}\n\n仍要保存吗？`);
        if (!go) { busy = false; setBusy(false, ''); return; }
      }

      // 3) 重名检测（设计稿第 17 节：不静默改名）
      let conflict = 'error';
      const hit = await apiExists(out.fileName, subdir());
      if (hit && hit.exists) {
        const choice = await askConflict(out.fileName, hit.size);
        if (choice === 'cancel') { busy = false; setBusy(false, ''); return; }
        conflict = choice;   // 'overwrite' | 'rename'
      }

      // 4) 提交给服务端原子写入
      setBusy(true, '正在保存…');
      const res = await apiSave({
        dataUrl: out.dataUrl,
        fileName: out.fileName,
        subdir: subdir(),
        conflict,
      });

      if (!res.ok) {
        throw new Error(res.error || '保存失败');
      }

      savedResult = {
        relPath: res.relPath,
        fileName: res.fileName,
        imagesDir: res.imagesDir,
        width: out.width,
        height: out.height,
        bytes: res.size || out.bytes,
        renamed: res.renamed,
        overwritten: res.overwritten,
      };
      dirty = false;
      busy = false;
      setBusy(false, '');

      // 5) 结果反馈（设计稿第 19 节）
      await Dialog.alert(
        '图片保存成功\n\n' +
        `文件名：${savedResult.fileName}\n` +
        `尺寸：${savedResult.width} × ${savedResult.height}\n` +
        `大小：${ImageCore.formatBytes(savedResult.bytes)}\n` +
        `目录：${savedResult.imagesDir}`
      );

      close(true);
    } catch (err) {
      busy = false;
      setBusy(false, '');
      const msg = (err && err.message) || '保存失败';
      await Dialog.alert(friendlyError(msg));
    }
  }

  function friendlyError(msg) {
    if (/没有写入权限|EACCES|EPERM/.test(msg)) return '当前目录没有写入权限，请选择其他目录。';
    if (/端口|Failed to fetch|NetworkError|Failed to fetch/.test(msg)) return '无法连接本地服务，请确认应用仍在运行。';
    if (/磁盘空间/.test(msg)) return '磁盘空间不足，无法保存图片。';
    return `保存失败：${msg}`;
  }

  function setBusy(on, text) {
    dom.saveBtn.disabled = on;
    dom.cancelBtn.disabled = on;
    dom.saveBtn.textContent = on ? '处理中…' : '保存';
    if (text) {
      dom.status.innerHTML = '';
      dom.status.appendChild(el('span', 'ie-status-main', text));
    }
  }

  /** 重名三选（设计稿第 17 节的 [覆盖][另存为][取消]） */
  function askConflict(fileName, size) {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay active ie-conflict-overlay');
      const box = el('div', 'modal-container ie-conflict');
      const head = el('div', 'modal-header');
      head.appendChild(el('h2', null, '发现同名文件'));
      const bodyEl = el('div', 'modal-body');
      bodyEl.appendChild(el('p', 'ie-conflict-msg',
        `目标目录中已存在：\n${fileName}${size ? `（${ImageCore.formatBytes(size)}）` : ''}`));
      bodyEl.appendChild(el('p', 'ie-field-hint', '覆盖会替换原文件内容，且无法撤销。'));
      const actions = el('div', 'form-actions');
      const bCancel = el('button', 'btn-cancel', '取消');
      const bRename = el('button', 'btn-secondary', '自动编号');
      const bOver = el('button', 'btn-primary', '覆盖');
      [bCancel, bRename, bOver].forEach((b) => { b.type = 'button'; });
      actions.append(bCancel, bRename, bOver);
      box.append(head, bodyEl, actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const done = (v) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); }
      };
      bCancel.addEventListener('click', () => done('cancel'));
      bRename.addEventListener('click', () => done('rename'));
      bOver.addEventListener('click', () => done('overwrite'));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done('cancel'); });
      document.addEventListener('keydown', onKey);
      bOver.focus();
    });
  }

  /** 图片子目录 = 记录 ID；没有记录时落到 _unfiled */
  function subdir() {
    const f = dom.form || {};
    return f.recordId || (typeof ImgNaming !== 'undefined' ? ImgNaming.UNFILED_DIR : '_unfiled');
  }

  // ---- HTTP ----
  async function apiExists(fileName, sub) {
    try {
      const res = await fetch(`/api/images/exists?name=${encodeURIComponent(fileName)}&subdir=${encodeURIComponent(sub || '')}`);
      if (!res.ok) return { exists: false };
      return await res.json();
    } catch (e) {
      return { exists: false };
    }
  }

  async function apiSave(payload) {
    const res = await fetch('/api/images/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      return { ok: false, error: data.error || `服务端返回 ${res.status}` };
    }
    return Object.assign({ ok: true }, data);
  }

  async function loadConfig() {
    if (dom.config) return dom.config;
    try {
      const res = await fetch('/api/images/config');
      if (res.ok) dom.config = await res.json();
    } catch (e) { /* 拿不到就显示占位文字 */ }
    return dom.config || {};
  }

  // ============================================================
  // 打开 / 关闭
  // ============================================================
  /**
   * 等布局完成。
   *
   * 打开编辑器时要先让浏览器把模态框排好版，否则 viewport.clientWidth 还是 0，
   * 预览会被算成 1×1 像素。
   *
   * 这里不用 requestAnimationFrame 单点等待：无头/后台标签页里 rAF 可能长时间
   * 不触发，整个 open() 就卡在那里（表现为"编辑器打开了但一直是空白"）。
   * 改成 rAF 与定时器赛跑 + 尺寸轮询，任一条件满足即可。
   */
  function waitForLayout(el, timeoutMs) {
    const limit = timeoutMs || 500;
    const t0 = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // 只要元素量出来有尺寸就够了；轮询比 rAF 稳
      const poll = () => {
        if (done) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if ((w > 4 && h > 4) || Date.now() - t0 > limit) { finish(); return; }
        setTimeout(poll, 16);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
      setTimeout(finish, limit);          // rAF 不来也要往下走
      poll();
    });
  }
  /**
   * 打开编辑器。
   * @param {File} file
   * @param {object} ctx
   * @param {object} ctx.record     当前表单里的记录（用于生成文件名）
   * @param {string} [ctx.recordId] 记录 ID（决定图片落在哪个子目录）
   * @param {number} [ctx.index]    同一记录里的序号
   * @returns {Promise<object|null>} 保存后的结果，取消则为 null
   */
  async function open(file, ctx) {
    build();

    // 已经开着就先收掉上一次的等待者，避免 Promise 悬空
    if (resolveOpen) {
      const prev = resolveOpen;
      resolveOpen = null;
      prev(null);
    }

    const context = ctx || {};
    dom.form = context.record || {};
    dom.recordId = context.recordId || '';
    dom.index = context.index || 1;

    // 每次打开都重置交互状态
    cropRatio = 0;
    zoom = 1;
    dirty = false;
    busy = false;
    savedResult = null;
    fileNameEdited = false;
    dragState = null;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

    dom.zoomRange.value = '100';
    updateZoomLabel();
    updateRatioButtons();
    syncAngleControls();
    dom.nameInput.value = '';
    dom.nameInput.classList.remove('ie-input-error');
    dom.saveBtn.disabled = false;
    dom.saveBtn.textContent = '保存';
    dom.cancelBtn.disabled = false;
    dom.status.innerHTML = '';
    dom.stageHint.textContent = '';
    showTab('crop');

    dom.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (session) { ImageCore.disposeSession(session); session = null; }

    try {
      dom.status.appendChild(el('span', 'ie-status-main', '正在读取图片…'));
      session = await ImageCore.createSession(file);
    } catch (err) {
      const msg = (err && err.message) || '无法读取该图片。';
      dom.overlay.classList.remove('active');
      document.body.style.overflow = '';
      await Dialog.alert(msg);
      return null;
    }

    dom.title.textContent = '编辑图片';
    syncSliders();

    // 先让浏览器完成一次布局，否则 viewport.clientWidth 还是 0
    await waitForLayout(dom.viewport, 500);

    if (!dom.overlay.classList.contains('active')) {
      // 等待布局期间被关掉了：不要再往下走
      ImageCore.disposeSession(session);
      session = null;
      return null;
    }

    updateFileNameFromRecord();
    updateRatioButtons();
    syncAngleControls();
    render();

    const info = await loadConfig();
    dom.dirText.textContent = info.imagesDir || '（未获取到保存目录）';
    dom.dirText.title = info.imagesDir || '';

    return new Promise((resolve) => { resolveOpen = resolve; });
  }

  async function requestClose() {
    if (!dom || !dom.overlay.classList.contains('active')) return;
    if (busy) return;

    if (dirty) {
      const go = await Dialog.confirm('图片尚未保存，确定退出吗？\n\n选择「确定」放弃修改，选择「取消」继续编辑。');
      if (!go) return;
    }
    close(false);
  }

  function close(keep) {
    if (!dom) return;
    dom.overlay.classList.remove('active');
    document.body.style.overflow = '';
    if (session) { ImageCore.disposeSession(session); session = null; }
    dirty = false;
    const result = keep ? savedResult : null;
    savedResult = null;
    if (resolveOpen) {
      const fn = resolveOpen;
      resolveOpen = null;
      fn(result);
    }
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return {
    open,
    close,
    /** 供测试与外部调用：编辑器当前是否打开 */
    isOpen() { return Boolean(dom && dom.overlay.classList.contains('active')); },
  };

})();
