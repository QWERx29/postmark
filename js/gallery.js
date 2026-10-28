/**
 * 邮戳图片 — 照片画廊
 * ===================
 * 依赖: RecordStore（日戳记录，图片路径在记录的 photos 字段里）
 *
 * 数据来源
 * --------
 *   「录入日戳 → 日戳图片」保存的图片不会单独登记，只把**相对路径**写进
 *   记录的 photos: string[]（相对 output/images/，见 img-export.js）。
 *   所以画廊不需要额外的索引：把所有记录的 photos 摊平，就是全部邮戳图片。
 *
 * 版式
 * ----
 *   每个展示区是正方形（CSS aspect-ratio: 1/1），图片 object-fit: cover 裁切填满，
 *   底部叠一条半透明标题（邮局名 + 盖销日期）。
 *   单击展示区打开详情：大图 + 该图片所属记录的字段；← / → 在筛选结果里逐张翻阅。
 *
 * 对外接口（app.js 使用）: window.GalleryPage
 */
(function () {

  const $ = (id) => document.getElementById(id);

  /** 排序偏好（界面偏好，不进记录） */
  const SORT_PREF_KEY = 'postmark_gallery_sort';

  const SORT_OPTIONS = [
    { key: 'date-desc', label: '盖销日期（新 → 旧）' },
    { key: 'date-asc', label: '盖销日期（旧 → 新）' },
    { key: 'office-asc', label: '邮局名称（A → Z）' },
    { key: 'created-desc', label: '录入时间（新 → 旧）' },
  ];

  const STATUS_LABEL = {
    open: '营业',
    closed: '已撤销',
    themed: '主题邮局',
    temporary: '临时邮局',
  };

  let els = null;

  /** 全部图片（摊平后的 { record, relPath, fileName, photoIndex, photoCount }） */
  let allItems = [];
  /** 当前筛选 + 排序后的结果，详情弹窗按这个数组翻页 */
  let viewItems = [];

  let keyword = '';
  let provinceFilter = '';
  let sortKey = 'date-desc';

  let detailIndex = -1;
  let detailOpen = false;

  let searchTimer = null;

  // ============================================================
  // 小工具
  // ============================================================
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /** esc() 不转引号，值要塞进 title/src 之类的属性时必须再转一次 */
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 图片地址：/images/<相对路径>，逐段编码（文件名里可能有中文 / 空格） */
  function photoUrl(relPath) {
    return '/images/' + String(relPath == null ? '' : relPath)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  function fileNameOf(relPath) {
    const i = String(relPath).lastIndexOf('/');
    return i >= 0 ? String(relPath).slice(i + 1) : String(relPath);
  }

  /** 盖销日期显示：兼容 10 位整数 YYYYMMDDHH 与旧格式 YYYY.MM.DD.HH */
  function fmtCancelDate(val) {
    if (!val) return '';
    const s = String(val);
    if (/^\d{10}$/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:00`;
    }
    if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      return s.replace(/\./g, '-').replace(/-(\d{2})$/, ' $1:00');
    }
    return s;
  }

  /** 排序用的日期键：统一成 10 位数字，非数字格式就整体剔除 */
  function dateKey(rec) {
    return String(rec.cancelDate == null ? '' : rec.cancelDate).replace(/\D/g, '');
  }

  function locOf(rec) {
    return [rec.province, rec.city, rec.district].filter(Boolean).join(' / ');
  }

  function cacheEls() {
    els = {
      page: $('gallery-page'),
      count: $('gallery-count'),
      province: $('f-gallery-province'),
      search: $('f-gallery-search'),
      sortSel: $('f-gallery-sort'),
      grid: $('gallery-grid'),
      empty: $('gallery-empty'),
      overlay: $('gallery-detail-overlay'),
      figure: $('gallery-detail-figure'),
      detailTitle: $('gallery-detail-title'),
      detailImg: $('gallery-detail-img'),
      detailPos: $('gallery-detail-pos'),
      detailHead: $('gallery-detail-head'),
      detailList: $('gallery-detail-list'),
      detailPrev: $('gallery-detail-prev'),
      detailNext: $('gallery-detail-next'),
      detailEdit: $('gallery-detail-edit'),
    };
  }

  // ============================================================
  // 数据：把记录里的 photos 摊平成图片列表
  // ============================================================
  function buildItems() {
    const items = [];
    if (typeof RecordStore === 'undefined') return items;
    for (const rec of RecordStore.getAll()) {
      const photos = Array.isArray(rec.photos)
        ? rec.photos.filter((p) => typeof p === 'string' && p.trim())
        : [];
      photos.forEach((relPath, i) => {
        items.push({
          record: rec,
          relPath,
          fileName: fileNameOf(relPath),
          photoIndex: i + 1,
          photoCount: photos.length,
        });
      });
    }
    return items;
  }

  function haystack(rec) {
    return [
      rec.postOffice, rec.institutionCode, rec.postalCode,
      Array.isArray(rec.stampNumbers) ? rec.stampNumbers.join(' ') : '',
      Array.isArray(rec.scenicNames) ? rec.scenicNames.join(' ') : '',
      rec.material, rec.notes, rec.province, rec.city, rec.district,
    ].map((v) => String(v == null ? '' : v)).join(' ').toLowerCase();
  }

  /** 排序：日期类空值一律垫底，同值再按邮局名 / 文件名稳定排列 */
  function compareItems(a, b) {
    const x = a.record;
    const y = b.record;
    let result = 0;

    if (sortKey === 'date-desc' || sortKey === 'date-asc') {
      const dx = dateKey(x);
      const dy = dateKey(y);
      if (!dx && !dy) result = 0;
      else if (!dx) result = 1;
      else if (!dy) result = -1;
      else if (dx === dy) result = 0;
      else {
        const sign = dx < dy ? 1 : -1;
        result = sortKey === 'date-desc' ? -sign : sign;
      }
    } else if (sortKey === 'office-asc') {
      result = String(x.postOffice || '').localeCompare(String(y.postOffice || ''), 'zh-Hans-CN');
    } else {
      result = String(y.createdAt || '').localeCompare(String(x.createdAt || ''));
    }

    if (result !== 0) return result;
    const byName = String(x.postOffice || '').localeCompare(String(y.postOffice || ''), 'zh-Hans-CN');
    return byName !== 0 ? byName : String(a.relPath).localeCompare(String(b.relPath));
  }

  function currentView() {
    const term = keyword.trim().toLowerCase();
    const list = allItems.filter((it) => {
      if (provinceFilter && it.record.province !== provinceFilter) return false;
      if (!term) return true;
      return haystack(it.record).includes(term);
    });
    list.sort(compareItems);
    return list;
  }

  // ============================================================
  // 筛选下拉
  // ============================================================
  function renderProvinceOptions() {
    if (!els || !els.province) return;
    const present = new Set(allItems.map((it) => it.record.province).filter(Boolean));

    // 按行政区划顺序排列（取不到 PostmarkData 时退回字典序）
    let names = [];
    if (typeof PostmarkData !== 'undefined' && typeof PostmarkData.getAllProvinces === 'function') {
      names = PostmarkData.getAllProvinces().map((p) => p.name).filter((n) => present.has(n));
      // 记录里可能有参考库没有的省名，补在末尾
      present.forEach((n) => { if (!names.includes(n)) names.push(n); });
    } else {
      names = Array.from(present).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
    }

    els.province.innerHTML = '<option value="">全部省份</option>'
      + names.map((n) => `<option value="${escAttr(n)}">${esc(n)}</option>`).join('');
    els.province.value = present.has(provinceFilter) ? provinceFilter : '';
    if (!els.province.value) provinceFilter = '';
  }

  // ============================================================
  // 画廊渲染
  // ============================================================
  function tileHtml(it, idx) {
    const r = it.record;
    const date = fmtCancelDate(r.cancelDate);
    const stamps = Array.isArray(r.stampNumbers) && r.stampNumbers.length
      ? ` · ${r.stampNumbers.join(',')} 号`
      : '';
    const countBadge = it.photoCount > 1
      ? `<span class="gallery-tile-count">${it.photoIndex}/${it.photoCount}</span>`
      : '';
    const tip = [r.postOffice || '(无名称)', date || '未记录盖销日期', locOf(r)]
      .filter(Boolean).join('\n');

    return `
      <button type="button" class="gallery-tile" data-idx="${idx}" title="${escAttr(tip)}">
        <img src="${escAttr(photoUrl(it.relPath))}" alt="${escAttr(r.postOffice || '邮戳图片')}" loading="lazy">
        <span class="gallery-tile-fallback">图片缺失</span>
        ${countBadge}
        <span class="gallery-tile-cap">
          <span class="gallery-tile-name">${esc(r.postOffice) || '(无名称)'}</span>
          <span class="gallery-tile-meta">${esc(date) || '未记录盖戳日期'}${esc(stamps)}</span>
        </span>
      </button>`;
  }

  function bindTiles() {
    els.grid.querySelectorAll('.gallery-tile').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(Number(btn.dataset.idx)));

      // 记录的 photos 里可能残留已被删除的文件：图片加载失败时显示占位，不留破图
      const img = btn.querySelector('img');
      if (!img) return;
      const markMissing = () => btn.classList.add('gallery-tile-missing');
      img.addEventListener('error', markMissing);
      // 命中缓存的失败不会触发 error，补一次判断
      if (img.complete && img.naturalWidth === 0) markMissing();
    });
  }

  function render() {
    if (!els) cacheEls();
    if (!els.grid) return;

    viewItems = currentView();
    const totalImages = allItems.length;
    const totalRecords = new Set(allItems.map((it) => it.record.id)).size;

    if (totalImages === 0) {
      els.count.textContent = '共 0 张';
    } else if (viewItems.length === totalImages) {
      els.count.textContent = `共 ${totalImages} 张图片 · ${totalRecords} 条记录`;
    } else {
      els.count.textContent = `筛选出 ${viewItems.length} / 共 ${totalImages} 张`;
    }

    if (viewItems.length === 0) {
      els.grid.innerHTML = '';
      els.empty.style.display = 'block';
      els.empty.textContent = totalImages === 0
        ? '暂无邮戳图片。请先在「录入日戳 → 日戳图片」里上传图片并保存记录。'
        : '没有符合条件的图片';
      // 结果变了，原来打开的详情可能已经对不上号
      if (detailOpen) closeDetail();
      return;
    }

    els.empty.style.display = 'none';
    els.grid.innerHTML = viewItems.map((it, idx) => tileHtml(it, idx)).join('');
    bindTiles();

    if (detailOpen) {
      if (detailIndex >= viewItems.length) closeDetail();
      else renderDetail();
    }
  }

  /** 重新读记录 + 重建筛选下拉 + 重画（记录增删改 / 进入页面时） */
  function refresh() {
    allItems = buildItems();
    renderProvinceOptions();
    render();
  }

  // ============================================================
  // 详情弹窗
  // ============================================================
  function renderDetail() {
    const it = viewItems[detailIndex];
    if (!it || !els.detailList) return;
    const r = it.record;

    els.detailTitle.textContent = r.postOffice || '邮戳图片';
    if (els.figure) els.figure.classList.remove('gallery-detail-missing');
    els.detailImg.src = photoUrl(it.relPath);
    els.detailImg.alt = r.postOffice || '邮戳图片';
    els.detailPos.textContent = `第 ${detailIndex + 1} / ${viewItems.length} 张`
      + (it.photoCount > 1 ? ` · 本条记录第 ${it.photoIndex} / ${it.photoCount} 张` : '');

    // 只有一张时没必要显示左右箭头
    const showNav = viewItems.length > 1;
    if (els.detailPrev) els.detailPrev.style.display = showNav ? '' : 'none';
    if (els.detailNext) els.detailNext.style.display = showNav ? '' : 'none';

    els.detailHead.innerHTML =
      `<div class="gallery-detail-office">${esc(r.postOffice) || '(无名称)'}</div>`
      + `<div class="gallery-detail-loc">${esc(locOf(r)) || '-'}</div>`;

    /** 值为空且没有占位文案时整行不渲染；有占位文案则显示成灰色说明 */
    function row(label, value, placeholder) {
      const text = value == null ? '' : String(value).trim();
      if (!text && !placeholder) return '';
      return `<div class="gallery-detail-line">`
        + `<span class="gallery-detail-label">${esc(label)}</span>`
        + `<span class="gallery-detail-value${text ? '' : ' gallery-detail-empty'}">`
        + `${esc(text || placeholder)}</span></div>`;
    }

    const rows = [];
    rows.push(row('邮政编码', r.postalCode, '-'));
    rows.push(row('机构号', r.institutionCode, '-'));
    rows.push(row('邮局状态', STATUS_LABEL[r.status] || r.status, '-'));
    rows.push(row('盖销日期', fmtCancelDate(r.cancelDate), '-'));
    rows.push(row('戳号', Array.isArray(r.stampNumbers) ? r.stampNumbers.join(', ') : ''));
    rows.push(row('材质', r.material));
    if (r.hasScenicPostmark) {
      rows.push(row('风景（文化）日戳',
        Array.isArray(r.scenicNames) ? r.scenicNames.join('、') : '', '（已标记，未填名称）'));
    }
    if (r.hasPostageMeter) {
      const meter = [r.meterModel, r.meterNo, r.meterHeader, r.meterLowerRing]
        .filter(Boolean).join(' · ');
      rows.push(row('邮资机', meter, '（已标记，未填型号 / 编号）'));
    }
    rows.push(row('图片文件', it.fileName));
    rows.push(row('备注', r.notes, '无'));

    els.detailList.innerHTML = rows.join('');
  }

  function openDetail(idx) {
    if (!els) cacheEls();
    if (!Number.isInteger(idx) || idx < 0 || idx >= viewItems.length) return;
    detailIndex = idx;
    renderDetail();
    detailOpen = true;
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  /** @returns {boolean} 是否真的关掉了一个打开中的详情弹窗（供 Esc 处理判断） */
  function closeDetail() {
    if (!detailOpen) return false;
    detailOpen = false;
    detailIndex = -1;
    if (els && els.overlay) els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    return true;
  }

  /** 在筛选结果里翻上一张 / 下一张（首尾循环） */
  function stepDetail(delta) {
    if (!detailOpen || viewItems.length === 0) return;
    detailIndex = (detailIndex + delta + viewItems.length) % viewItems.length;
    renderDetail();
  }

  // ============================================================
  // 排序偏好
  // ============================================================
  function loadSortPref() {
    try {
      const raw = localStorage.getItem(SORT_PREF_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && SORT_OPTIONS.some((o) => o.key === saved.key)) sortKey = saved.key;
    } catch (e) { /* 隐私模式 / 脏数据：用默认排序 */ }
  }

  function saveSortPref() {
    try {
      localStorage.setItem(SORT_PREF_KEY, JSON.stringify({ key: sortKey }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  // ============================================================
  // 初始化 & 对外接口
  // ============================================================
  function init() {
    cacheEls();
    if (!els.page || !els.grid) return;

    // 排序下拉
    if (els.sortSel) {
      els.sortSel.innerHTML = SORT_OPTIONS
        .map((o) => `<option value="${o.key}">${esc(o.label)}</option>`)
        .join('');
      loadSortPref();
      els.sortSel.value = sortKey;
      els.sortSel.addEventListener('change', () => {
        sortKey = els.sortSel.value;
        saveSortPref();
        render();
      });
    }

    if (els.search) {
      els.search.addEventListener('input', () => {
        keyword = els.search.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(render, 200);
      });
      els.search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { clearTimeout(searchTimer); render(); }
      });
    }

    if (els.province) {
      els.province.addEventListener('change', () => {
        provinceFilter = els.province.value;
        render();
      });
    }

    // 详情弹窗：× / 关闭 / 点遮罩 / 左右翻页
    const closeBtn = $('gallery-detail-close');
    const okBtn = $('gallery-detail-ok');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
    if (okBtn) okBtn.addEventListener('click', closeDetail);
    if (els.overlay) {
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) closeDetail();
      });
    }
    if (els.detailPrev) els.detailPrev.addEventListener('click', () => stepDetail(-1));
    if (els.detailNext) els.detailNext.addEventListener('click', () => stepDetail(1));

    // 图片文件可能已被删除（记录里还留着路径）：失败时给占位，不留破图
    if (els.detailImg) {
      els.detailImg.addEventListener('error', () => {
        if (els.figure) els.figure.classList.add('gallery-detail-missing');
      });
      els.detailImg.addEventListener('load', () => {
        if (els.figure) els.figure.classList.remove('gallery-detail-missing');
      });
    }

    // 「编辑记录」：关掉详情，直接打开这条日戳记录的录入表单
    if (els.detailEdit) {
      els.detailEdit.addEventListener('click', () => {
        const it = viewItems[detailIndex];
        if (!it) return;
        const rec = (typeof RecordStore !== 'undefined') ? RecordStore.getById(it.record.id) : null;
        closeDetail();
        if (!rec) { refresh(); return; }
        if (typeof EntryForm !== 'undefined' && typeof EntryForm.open === 'function') {
          EntryForm.open(rec);
        }
      });
    }

    // 详情打开时用 ← / → 翻页（Esc 由 app.js 统一处理）
    document.addEventListener('keydown', (e) => {
      if (!detailOpen) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepDetail(1); }
    });

    // 记录变化（新增 / 编辑 / 删除 / 导入）→ 本页可见时立即刷新
    if (typeof RecordStore !== 'undefined' && typeof RecordStore.onChange === 'function') {
      RecordStore.onChange(() => {
        if (!els || !els.page) return;
        // 页面默认 display:none 是写在样式表里的，没有内联样式 —— 必须看计算值
        if (window.getComputedStyle(els.page).display === 'none') return;
        refresh();
      });
    }
  }

  /** 切到本页时调用（app.js）：重置筛选，按最新记录重画 */
  function show() {
    if (!els) cacheEls();
    keyword = '';
    provinceFilter = '';
    if (els.search) els.search.value = '';
    refresh();
  }

  window.GalleryPage = {
    show: () => show(),
    refresh: () => refresh(),
    closeDetail: () => closeDetail(),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
