/**
 * 数据录入表单 — 模态框
 * ======================
 * 依赖: PostmarkData (data.js), RecordStore (store.js),
 *       ImageEditor (image-editor.js), ImageCore (image.js)
 *
 * 功能:
 *   1. 省/市/县三级联动下拉框
 *   2. 机构号根据邮政编码自动生成
 *   3. 戳号动态增删
 *   4. 邮资机条件字段
 *   5. 风景/文化日戳条件字段 + 动态名称增删
 *   6. 日戳图片上传/编辑/保存（ImageEditor 负责编辑，见 image-editor.js）
 */

const EntryForm = (function () {

  // ============================================================
  // 材质选项
  // ============================================================
  const MATERIAL_OPTIONS = [
    '拨轮', '字钉', '回墨', '储墨', '光敏', '其他'
  ];

  // ============================================================
  // 状态
  // ============================================================
  let isEditMode = false;
  let editId = null;

  // ============================================================
  // DOM 引用 (初始化时设置)
  // ============================================================
  let dom = {};
  let els = {};

  function cacheDoms() {
    const districtContainer = document.getElementById('f-district-container');
    dom = {
      overlay:      document.getElementById('form-overlay'),
      form:         document.getElementById('entry-form'),
      title:        document.getElementById('form-title'),
      province:     document.getElementById('f-province'),
      city:         document.getElementById('f-city'),
      districtContainer,
      district:     districtContainer ? districtContainer.querySelector('#f-district') || districtContainer.querySelector('input, select') : null,
      postOffice:   document.getElementById('f-postoffice'),
      postalCode:   document.getElementById('f-postalcode'),
      postalCodeHint: document.getElementById('f-postalcode-hint'),
      instCode:     document.getElementById('f-instcode'),
      status:     document.getElementById('f-status'),
      dateInput:    document.getElementById('date-input'),
      dateText:     document.getElementById('date-text'),
      calPopup:     document.getElementById('cal-popup'),
      calGrid:      document.getElementById('cal-grid'),
      calTitle:     document.getElementById('cal-title'),
      calPrev:      document.getElementById('cal-prev'),
      calNext:      document.getElementById('cal-next'),
      cancelDateHour: document.getElementById('f-canceldate-hour'),
      stampList:    document.getElementById('f-stamp-list'),
      addStampBtn:  document.getElementById('f-add-stamp'),
      material:     document.getElementById('f-material'),
      hasMeter:     document.getElementById('f-has-meter'),
      meterFields:  document.getElementById('f-meter-fields'),
      meterModel:   document.getElementById('f-meter-model'),
      meterNo:      document.getElementById('f-meter-no'),
      meterHeader:  document.getElementById('f-meter-header'),
      meterLower:   document.getElementById('f-meter-lower'),
      hasScenic:    document.getElementById('f-has-scenic'),
      scenicFields: document.getElementById('f-scenic-fields'),
      scenicList:   document.getElementById('f-scenic-list'),
      addScenicBtn: document.getElementById('f-add-scenic'),
      notes:        document.getElementById('f-notes'),
      photoArea:    document.getElementById('f-photo-area'),
      photoList:    document.getElementById('f-photo-list'),
      photoAddBtn:  document.getElementById('f-photo-add'),
      photoInput:   document.getElementById('f-photo-input'),
      photoCount:   document.getElementById('f-photo-count'),
      submitBtn:    document.getElementById('f-submit'),
      cancelBtn:    document.getElementById('f-cancel'),
      saveId:       document.getElementById('f-save-id'),
    };
    // 缓存原始的区县 select 元素引用
    dom._originalDistrictSelect = document.querySelector('#f-district-container select');
  }

  // ============================================================
  // 工具函数
  // ============================================================
  function getDistrictValue() {
    const el = dom.districtContainer.querySelector('#f-district, input');
    return el ? el.value : '';
  }

  function setDistrictValue(val) {
    const el = dom.districtContainer.querySelector('#f-district, input');
    if (!el) return;
    // 历史记录中的区县名可能已不在参考表中 (如后来撤销或新设的行政区)，
    // 临时补一个选项，避免编辑保存时被静默清空
    if (el.tagName === 'SELECT' && val && !Array.from(el.options).some(o => o.value === val)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      el.appendChild(opt);
    }
    el.value = val || '';
  }

  function resetDistrictToSelect() {
    const orig = dom._originalDistrictSelect;
    if (orig) {
      dom.districtContainer.innerHTML = '';
      dom.districtContainer.appendChild(orig.cloneNode(true));
      dom.district = dom.districtContainer.querySelector('select');
    }
  }

  function clearSelect(sel, placeholder) {
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    sel.disabled = false;
  }

  function populateSelect(sel, items, placeholder) {
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    items.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item;
      sel.appendChild(opt);
    });
    sel.disabled = false;
  }

  // ============================================================
  // 日历弹窗
  // ============================================================
  let _selYear = 0, _selMonth = 0, _selDay = 0;

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  function isToday(y, m, d) {
    const t = new Date();
    return y === t.getFullYear() && m === t.getMonth() + 1 && d === t.getDate();
  }

  function isSelected(y, m, d) {
    return y === _selYear && m === _selMonth && d === _selDay;
  }

  function renderCalendar(year, month) {
    dom.calTitle.textContent = `${year}年${String(month).padStart(2, '0')}月`;
    const firstDow = new Date(year, month - 1, 1).getDay();
    const days = daysInMonth(year, month);
    const cells = [];
    // 空白格
    for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
    // 日期格
    for (let d = 1; d <= days; d++) {
      const cls = isToday(year, month, d) ? ' cal-today' : '';
      const sel = isSelected(year, month, d) ? ' cal-sel' : '';
      cells.push(`<span class="cal-day${cls}${sel}" data-d="${d}">${d}</span>`);
    }
    dom.calGrid.innerHTML = cells.join('');
  }

  function openCalendar() {
    if (!_selYear) { const n = new Date(); _selYear = n.getFullYear(); _selMonth = n.getMonth() + 1; _selDay = n.getDate(); }
    renderCalendar(_selYear, _selMonth);
    const rect = dom.dateInput.getBoundingClientRect();
    // 移至 body 以避开 modal-container 的 transform 影响 fixed 定位
    document.body.appendChild(dom.calPopup);
    dom.calPopup.style.left = rect.left + 'px';
    dom.calPopup.style.top = (rect.bottom + 4) + 'px';
    dom.calPopup.style.width = Math.max(rect.width, 272) + 'px';
    dom.calPopup.classList.add('active');
    dom.dateInput.classList.add('active');
  }

  function closeCalendar() {
    dom.calPopup.classList.remove('active');
    dom.dateInput.classList.remove('active');
    // 移回原位置以便下次打开（如果还在 body 中）
    if (dom.calPopup.parentNode === document.body) {
      dom.dateInput.parentNode.appendChild(dom.calPopup);
    }
  }

  function toggleCalendar() {
    if (dom.calPopup.classList.contains('active')) closeCalendar();
    else openCalendar();
  }

  function selectDate(y, m, d) {
    _selYear = y; _selMonth = m; _selDay = d;
    dom.dateText.textContent = `${y}年${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日`;
    dom.dateText.style.color = '#333';
    closeCalendar();
  }

  function populateHourSelect(sel, selected) {
    const h = selected || '08';
    sel.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const v = String(i).padStart(2, '0');
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v + ':00';
      if (v === h) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /** 将 10 位整数日期或旧格式设为日历选中值 */
  function setCancelDateValue(val) {
    if (!val) { clearDate(); return; }
    const s = String(val);
    let y, m, d, h = '08';
    if (/^\d{10}$/.test(s)) {
      y = parseInt(s.slice(0,4), 10); m = parseInt(s.slice(4,6), 10);
      d = parseInt(s.slice(6,8), 10); h = s.slice(8,10);
    } else if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      const p = s.split('.'); y = +p[0]; m = +p[1]; d = +p[2]; h = p[3];
    } else { return; }
    _selYear = y; _selMonth = m; _selDay = d;
    dom.dateText.textContent = `${y}年${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日`;
    dom.dateText.style.color = '#333';
    dom.cancelDateHour.value = h;
  }

  function clearDate() {
    _selYear = 0; _selMonth = 0; _selDay = 0;
    dom.dateText.textContent = '请选择日期';
    dom.dateText.style.color = '#bbb';
  }

  /** 合并日历 + 小时为 10 位整数 (YYYYMMDDHH) */
  function getCancelDateValue() {
    if (!_selYear) return '';
    const y = String(_selYear);
    const m = String(_selMonth).padStart(2, '0');
    const d = String(_selDay).padStart(2, '0');
    const h = dom.cancelDateHour.value;
    return y + m + d + h;
  }

  // ============================================================
  // 级联更新
  // ============================================================
  function updateCities() {
    const provName = dom.province.value;
    const cities = PostmarkData.getProvinceCityNames(provName);
    populateSelect(dom.city, cities, '请选择市');
    dom.city.disabled = !provName;

    // 重置区县
    resetDistrictToSelect();
    clearSelect(dom.district, '请先选择市');
    dom.district.disabled = true;

    // 省份变更，隐藏邮政编码提示
    updatePostalCodeHint();
  }

  function updateDistricts() {
    const cityName = dom.city.value;
    const dists = PostmarkData.getDistricts(cityName);

    // 清空容器
    dom.districtContainer.innerHTML = '';

    function onDistrictChange() {
      updatePostalCodeHint();
    }

    if (dists.length > 0) {
      const sel = document.createElement('select');
      sel.id = 'f-district';
      sel.className = 'form-select';
      sel.innerHTML = '<option value="">请选择区/县</option>';
      dists.forEach(d => {
        sel.innerHTML += `<option value="${d}">${d}</option>`;
      });
      sel.disabled = false;
      sel.addEventListener('change', onDistrictChange);
      dom.districtContainer.appendChild(sel);
      dom.district = sel;
    } else {
      const inp = document.createElement('input');
      inp.id = 'f-district';
      inp.type = 'text';
      inp.className = 'form-input';
      inp.placeholder = '直接输入区/县名称';
      inp.addEventListener('input', onDistrictChange);
      dom.districtContainer.appendChild(inp);
      dom.district = inp;
    }

    // 同步邮政编码提示
    updatePostalCodeHint();
  }

  // ============================================================
  // 邮政编码提示
  // ============================================================
  function updatePostalCodeHint() {
    const prov = dom.province.value;
    const city = dom.city.value;
    const dist = getDistrictValue();
    const hint = PostmarkData.getPostalCodeHint(prov, city, dist);
    if (hint) {
      dom.postalCodeHint.textContent = '该地区邮政编码大致为 ' + hint;
      dom.postalCodeHint.style.display = 'block';
    } else {
      dom.postalCodeHint.style.display = 'none';
    }
  }

  // ============================================================
  // 机构号自动生成 (8位数字)
  // ============================================================
  function autoGenerateInstCode() {
    const pc = dom.postalCode.value.trim();
    if (pc.length === 6) {
      dom.instCode.value = RecordStore.generateInstCode(pc);
    }
  }

  // ============================================================
  // PO 数据库自动填充 (双触发器: 邮编 + 网点名称)
  // ============================================================
  let _poDebounceTimer = null;
  let _poSuggestionsEl = null;

  function poEnsureSuggestionsEl() {
    if (!_poSuggestionsEl) {
      _poSuggestionsEl = document.createElement('div');
      _poSuggestionsEl.id = 'f-po-suggestions';
      _poSuggestionsEl.className = 'po-suggestions';
      dom.postOffice.parentNode.style.position = 'relative';
      dom.postOffice.parentNode.appendChild(_poSuggestionsEl);
    }
    return _poSuggestionsEl;
  }

  function hidePOSuggestions() {
    const el = _poSuggestionsEl;
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  function showPOSuggestions(matches) {
    const container = poEnsureSuggestionsEl();
    if (matches.length === 0) { hidePOSuggestions(); return; }

    container.innerHTML = '<div class="po-suggestions-header">匹配的网点（点击选择）：</div>';
    matches.slice(0, 8).forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'po-suggestion-item';
      item.innerHTML = `<span class="po-si-name">${escHtml(m.name)}</span>` +
        `<span class="po-si-code">${m.postalCode || ''}</span>` +
        `<span class="po-si-loc">${m.province}/${m.city}/${m.district}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 阻止 blur 先触发
        applyPOFill(m, true);
        hidePOSuggestions();
      });
      container.appendChild(item);
    });
    container.style.display = 'block';
  }

  /** 构建当前已选行政区划过滤条件 */
  function poGetFilter() {
    const filter = {};
    if (dom.province.value) filter.province = dom.province.value;
    if (dom.city.value)     filter.city     = dom.city.value;
    return filter;
  }

  function applyPOFill(record, forceName) {
    // 省 — 未选择时自动补齐
    if (record.province && !dom.province.value) {
      dom.province.value = record.province;
      updateCities();
    }
    // 市 — 未选择时自动补齐
    if (record.city && !dom.city.value) {
      dom.city.value = record.city;
      updateDistricts();
    }
    // 区 — 未选择时自动补齐
    if (record.district && !getDistrictValue()) {
      setTimeout(() => setDistrictValue(record.district), 50);
    }
    // 邮局名称 — 点击建议强制填入，邮编触发仅空时填入
    if (record.name && (forceName || !dom.postOffice.value.trim())) {
      dom.postOffice.value = record.name;
    }
    // 邮编 — 仅空时填充
    if (record.postalCode && !dom.postalCode.value.trim()) {
      dom.postalCode.value = record.postalCode;
      autoGenerateInstCode();
    }
    updatePostalCodeHint();
  }

  /** 触发器 A: 邮编精确匹配（限定已选行政区） */
  function poAutoFillByCode(code) {
    if (typeof PODatabase === 'undefined') return;
    const filter = poGetFilter();
    const matches = PODatabase.searchByPostalCode(code, filter);
    if (matches.length === 0) return;
    applyPOFill(matches[0], false);
    if (matches.length > 1) {
      showPOSuggestions(matches);
    }
  }

  /** 触发器 B: 网点名称模糊搜索（限定已选行政区） */
  function poSearchByName(query) {
    if (typeof PODatabase === 'undefined') { hidePOSuggestions(); return; }
    if (!query || query.length < 2) { hidePOSuggestions(); return; }
    const filter = poGetFilter();
    const matches = PODatabase.searchByName(query, 8, filter);
    if (matches.length === 0) { hidePOSuggestions(); return; }
    showPOSuggestions(matches);
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ============================================================
  // 动态列表: 戳号
  // ============================================================
  function addStampRow(value) {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <input type="text" class="form-input stamp-input" value="${value || ''}" placeholder="如: 1, 2-1, 甲">
      <button type="button" class="btn-remove" title="删除">×</button>
    `;
    row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
    dom.stampList.appendChild(row);
    return row;
  }

  function getStampValues() {
    return Array.from(dom.stampList.querySelectorAll('.stamp-input'))
      .map(inp => inp.value.trim())
      .filter(Boolean);
  }

  // ============================================================
  // 动态列表: 风景/文化日戳名称
  // ============================================================
  function addScenicRow(value) {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <input type="text" class="form-input scenic-input" value="${value || ''}" placeholder="风景/文化日戳名称">
      <button type="button" class="btn-remove" title="删除">×</button>
    `;
    row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
    dom.scenicList.appendChild(row);
    return row;
  }

  function getScenicValues() {
    return Array.from(dom.scenicList.querySelectorAll('.scenic-input'))
      .map(inp => inp.value.trim())
      .filter(Boolean);
  }

  // ============================================================
  // 条件字段切换
  // ============================================================
  function toggleMeterFields() {
    dom.meterFields.style.display = dom.hasMeter.checked ? 'block' : 'none';
  }

  function toggleScenicFields() {
    dom.scenicFields.style.display = dom.hasScenic.checked ? 'block' : 'none';
  }

  // ============================================================
  // 日戳图片
  // ============================================================
  // 图片本身由服务端写到 output/images/<记录ID>/，记录里只存相对路径
  // （设计稿第 14 / 15 节：目录由服务端管，渲染层不碰文件系统）。
  //
  // 表单里的图片有两种状态：
  //   - 已保存：photoSaved 里有相对路径，缩略图直接走 /images/<relPath>
  //   - 待保存：只有原始文件对象，缩略图是本地的 objectURL
  // 记录只在点「保存」时把已保存的那些写进 photos 字段。

  let photoSaved = [];                 // 已保存的相对路径
  let photoPending = [];               // [{file, name, url}] 尚未保存
  let imagesDir = '';                  // 服务端图片根目录（用于提示里显示完整路径）

  function imagesBase() {
    return '/images/';
  }

  function savedFileName(relPath) {
    const i = String(relPath).lastIndexOf('/');
    return i >= 0 ? relPath.slice(i + 1) : relPath;
  }

  /** 未关联记录时服务端会把它放进 _unfiled/，界面上提示一下 */
  function isUnfiled(relPath) {
    const unfiled = (typeof ImgNaming !== 'undefined') ? ImgNaming.UNFILED_DIR : '_unfiled';
    return String(relPath).startsWith(unfiled + '/');
  }

  function updatePhotoCount() {
    const saved = photoSaved.length;
    const pending = photoPending.length;
    const total = saved + pending;
    if (!dom.photoCount) return;
    if (total === 0) {
      dom.photoCount.textContent = '';
      return;
    }
    dom.photoCount.textContent = pending
      ? `已保存 ${saved} 张，待保存 ${pending} 张`
      : `已保存 ${saved} 张`;
    dom.photoCount.classList.toggle('has-pending', pending > 0);
  }

  function makePhotoThumb(entry) {
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb' + (entry.pending ? ' photo-pending' : '');

    const img = document.createElement('img');
    img.alt = entry.name;
    img.loading = 'lazy';
    if (entry.pending) {
      const url = URL.createObjectURL(entry.file);
      entry.url = url;
      img.src = url;
    } else {
      img.src = imagesBase() + String(entry.relPath).split('/').map(encodeURIComponent).join('/');
    }
    if (entry.width && entry.height) {
      img.title = `${entry.name}\n${entry.width} × ${entry.height}`;
    } else {
      img.title = entry.name;
    }

    const bar = document.createElement('div');
    bar.className = 'photo-thumb-bar';
    const nameEl = document.createElement('span');
    nameEl.className = 'photo-thumb-name';
    nameEl.textContent = entry.name;
    bar.appendChild(nameEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'photo-thumb-del';
    btn.textContent = '×';
    btn.title = entry.pending ? '放弃这张图片' : '从记录中移除';
    btn.addEventListener('click', () => {
      if (entry.pending) removePendingPhoto(entry);
      else removeSavedPhoto(entry.relPath);
    });

    thumb.append(img, bar, btn);
    return thumb;
  }

  function renderPhotos() {
    if (!dom.photoList) return;
    dom.photoList.innerHTML = '';

    photoSaved.forEach((relPath, i) => {
      dom.photoList.appendChild(makePhotoThumb({
        pending: false,
        relPath,
        name: savedFileName(relPath),
        width: 0,
        height: 0,
        index: i + 1,
      }));
    });

    photoPending.forEach((entry, i) => {
      dom.photoList.appendChild(makePhotoThumb({
        pending: true,
        file: entry.file,
        name: entry.name,
        index: photoSaved.length + i + 1,
      }));
    });

    updatePhotoCount();
  }

  function removePendingPhoto(entry) {
    const i = photoPending.indexOf(entry);
    if (i >= 0) photoPending.splice(i, 1);
    if (entry.url) URL.revokeObjectURL(entry.url);
    renderPhotos();
  }

  function removeSavedPhoto(relPath) {
    const i = photoSaved.indexOf(relPath);
    if (i >= 0) photoSaved.splice(i, 1);
    // 服务端文件不在这里删：记录还没保存，删了文件反而会让"取消"无法回退。
    // 文件清理交给记录删除流程（或在编辑保存时按 photos 差集处理）。
    renderPhotos();
  }

  /** 当前表单里的记录快照 —— 图片命名要用到机构号/盖销时间/邮局名 */
  function currentRecordDraft() {
    return {
      institutionCode: dom.instCode ? dom.instCode.value.trim() : '',
      cancelDate: getCancelDateValue(),
      postOffice: dom.postOffice ? dom.postOffice.value.trim() : '',
    };
  }

  /** 图片子目录 = 记录 ID；记录还没保存过时服务端会落到 _unfiled/ */
  function photoSubdir() {
    return dom.saveId.value || '';
  }

  /** 读取服务端图片目录，用于界面提示 */
  async function loadImagesDir() {
    if (imagesDir) return imagesDir;
    try {
      const res = await fetch('/api/images/config');
      if (res.ok) {
        const data = await res.json();
        imagesDir = data.imagesDir || '';
      }
    } catch (e) { /* 拿不到就只显示文件名 */ }
    return imagesDir;
  }

  async function handleFilesPicked(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    // 一次选多张时提示会很多，这里统一说明一次
    if (files.length > 1) {
      const go = await Dialog.confirm(`已选择 ${files.length} 张图片，将逐张进入编辑界面。\n\n继续吗？`);
      if (!go) return;
    }

    for (const file of files) {
      const result = await openEditorFor(file);
      if (!result) continue;         // 用户取消了这一张：继续下一张，不算错误
      photoSaved.push(result.relPath);
      renderPhotos();
    }
  }

  /**
   * 打开编辑器处理一张图。
   * @returns {Promise<object|null>} 保存结果；用户取消返回 null
   */
  async function openEditorFor(file) {
    // 先做一次本地校验，避免为明显不合法的文件开编辑器。
    // validate 是 async 的：它要读文件头做内容嗅探，不能只信扩展名。
    if (typeof ImageCore !== 'undefined') {
      const invalid = await ImageCore.validate(file);
      if (invalid) {
        await Dialog.alert(invalid.message);
        return null;
      }
    }

    const editorCtx = {
      record: currentRecordDraft(),
      recordId: photoSubdir(),
      // 序号接在已保存的图片之后，文件名不会互相顶掉
      index: photoSaved.length + 1,
    };

    let result = null;
    try {
      result = await ImageEditor.open(file, editorCtx);
    } catch (err) {
      await Dialog.alert((err && err.message) || '无法打开图片编辑器。');
      return null;
    }
    if (!result) return null;

    if (!photoSubdir() && isUnfiled(result.relPath)) {
      // 记录还没保存过，图片先落在 _unfiled/，提示一次让用户心里有数
      const dir = await loadImagesDir();
      if (!sessionStorage.getItem('postmark_unfiled_hint')) {
        sessionStorage.setItem('postmark_unfiled_hint', '1');
        await Dialog.alert(
          '图片已保存到临时目录（因为这条记录还没保存过）。\n\n' +
          (dir ? `目录：${dir}\n\n` : '') +
          '保存记录后，新上传的图片会自动按机构号归档。'
        );
      }
    }
    return result;
  }

  function resetPhotos() {
    photoPending.forEach((e) => { if (e.url) URL.revokeObjectURL(e.url); });
    photoPending = [];
    photoSaved = [];
    renderPhotos();
  }

  function setPhotos(list) {
    photoPending.forEach((e) => { if (e.url) URL.revokeObjectURL(e.url); });
    photoPending = [];
    photoSaved = Array.isArray(list) ? list.slice() : [];
    renderPhotos();
  }

  function getPhotoPaths() {
    return photoSaved.slice();
  }

  function hasPendingPhotos() {
    return photoPending.length > 0;
  }

  // ============================================================
  // 表单填充 (编辑模式)
  // ============================================================
  function populateForm(record) {
    isEditMode = true;
    editId = record.id;
    dom.title.textContent = '编辑记录';
    dom.saveId.value = record.id;

    // 填充省份并触发城市更新
    dom.province.value = record.province;
    updateCities();
    dom.city.value = record.city;
    updateDistricts();

    // 区县 (可能是 input 或 select)
    setDistrictValue(record.district);
    updatePostalCodeHint();

    dom.postOffice.value = record.postOffice || '';
    dom.status.value = record.status || 'open';
    dom.postalCode.value = record.postalCode || '';
    dom.instCode.value = record.institutionCode || '';
    // 兼容新旧日期格式
    setCancelDateValue(record.cancelDate);
    dom.material.value = record.material || '';

    // 戳号
    dom.stampList.innerHTML = '';
    if (record.stampNumbers && record.stampNumbers.length > 0) {
      record.stampNumbers.forEach(s => addStampRow(s));
    } else {
      addStampRow('');
    }

    // 邮资机
    dom.hasMeter.checked = record.hasPostageMeter || false;
    dom.meterModel.value = record.meterModel || '';
    dom.meterNo.value = record.meterNo || '';
    dom.meterHeader.value = record.meterHeader || '';
    dom.meterLower.value = record.meterLowerRing || '';
    toggleMeterFields();

    // 风景戳
    dom.hasScenic.checked = record.hasScenicPostmark || false;
    dom.scenicList.innerHTML = '';
    if (record.scenicNames && record.scenicNames.length > 0) {
      record.scenicNames.forEach(s => addScenicRow(s));
    }
    toggleScenicFields();

    // 图片：记录里只存相对路径，界面按路径从 /images/ 取缩略图
    setPhotos(record.photos);

    dom.notes.value = record.notes || '';
  }

  // ============================================================
  // 表单提交
  // ============================================================
  async function handleSubmit(e) {
    e.preventDefault();

    // 基础验证
    const prov = dom.province.value;
    const city = dom.city.value;
    const po = dom.postOffice.value.trim();
    const pc = dom.postalCode.value.trim();
    const ic = dom.instCode.value.trim();
    const cd = getCancelDateValue();

    if (!prov) { await Dialog.alert('请选择省份'); return; }
    if (!city) { await Dialog.alert('请选择城市'); return; }
    if (!po)   { await Dialog.alert('请输入邮局名称'); return; }
    if (!pc || !/^\d{6}$/.test(pc)) { await Dialog.alert('请输入有效的6位邮政编码'); return; }
    if (!ic || !/^\d{8}$/.test(ic)) { await Dialog.alert('机构号必须为8位数字'); return; }
    if (!cd || !/^\d{10}$/.test(cd)) { await Dialog.alert('请选择完整的盖销日期和时间'); return; }

    // 还有图片没走完"编辑→保存"：存进记录只会在列表里显示成破图，先问清楚
    if (hasPendingPhotos()) {
      const n = photoPending.length;
      const go = await Dialog.confirm(
        `还有 ${n} 张图片没有保存。\n\n` +
        '选择「确定」放弃这些图片并保存记录，选择「取消」回去继续处理。'
      );
      if (!go) return;
    }

    // 获取区县值 (select 或 input)
    const dist = getDistrictValue();

    // 构建记录对象
    const record = {
      province: prov,
      city,
      district: dist,
      postOffice: po,
      postalCode: pc,
      institutionCode: ic,
      status: dom.status.value,
      cancelDate: cd,
      stampNumbers: getStampValues(),
      material: dom.material.value,
      hasPostageMeter: dom.hasMeter.checked,
      meterModel: dom.hasMeter.checked ? dom.meterModel.value.trim() : '',
      meterNo: dom.hasMeter.checked ? dom.meterNo.value.trim() : '',
      meterHeader: dom.hasMeter.checked ? dom.meterHeader.value.trim() : '',
      meterLowerRing: dom.hasMeter.checked ? dom.meterLower.value.trim() : '',
      hasScenicPostmark: dom.hasScenic.checked,
      scenicNames: dom.hasScenic.checked ? getScenicValues() : [],
      photos: getPhotoPaths(),
      notes: dom.notes.value.trim(),
    };

    // 重复机构号校验
    if (!isEditMode) {
      const existing = RecordStore.getByInstCode(ic);
      if (existing) {
        await Dialog.alert(`机构号 "${ic}" 已存在，请确认邮政编码是否正确`);
        return;
      }
    }

    // 保存
    if (isEditMode) {
      RecordStore.update(editId, record);
    } else {
      RecordStore.add(record);
    }

    closeForm();
  }

  // ============================================================
  // 辅助: 当前时间格式化为 YYYY.MM.DD.HH
  // ============================================================
  function nowFormatted() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}`;
  }

  // ============================================================
  // 开关
  // ============================================================
  function openForm(record) {
    dom.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (record) {
      populateForm(record);
    } else {
      // 新建模式：重置表单
      isEditMode = false;
      editId = null;
      dom.title.textContent = '录入日戳记录';
      dom.saveId.value = '';
      dom.form.reset();
      dom.meterFields.style.display = 'none';
      dom.scenicFields.style.display = 'none';
      dom.stampList.innerHTML = '';
      addStampRow('');
      dom.instCode.value = '';
      resetPhotos();
      // 默认日期为今天，时间为当前小时
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      _selYear = now.getFullYear(); _selMonth = now.getMonth() + 1; _selDay = now.getDate();
      dom.dateText.textContent = `${_selYear}年${String(_selMonth).padStart(2,'0')}月${String(_selDay).padStart(2,'0')}日`;
      dom.dateText.style.color = '#333';
      dom.cancelDateHour.value = pad(now.getHours());
      clearSelect(dom.city, '请先选择省份');
      dom.city.disabled = true;
      // 重置区县下拉框
      resetDistrictToSelect();
      clearSelect(dom.district, '请先选择市');
      dom.district.disabled = true;
    }
  }

  function closeForm() {
    // 清掉待保存图片的 objectURL，避免长时间占用内存
    resetPhotos();
    dom.overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    cacheDoms();

    // 填充省份下拉
    const provs = PostmarkData.getAllProvinces();
    populateSelect(dom.province, provs.map(p => p.name), '请选择省份');

    // 材质下拉
    populateSelect(dom.material, MATERIAL_OPTIONS, '请选择材质');

    // 日历默认今天 + 小时下拉
    const now = new Date();
    _selYear = now.getFullYear(); _selMonth = now.getMonth() + 1; _selDay = now.getDate();
    dom.dateText.textContent = `${_selYear}年${String(_selMonth).padStart(2,'0')}月${String(_selDay).padStart(2,'0')}日`;
    dom.dateText.style.color = '#333';
    populateHourSelect(dom.cancelDateHour, String(now.getHours()).padStart(2, '0'));

    // 默认添加一行戳号
    addStampRow('');

    // ---- 事件绑定 ----

    // 省 → 市 联动
    dom.province.addEventListener('change', updateCities);

    // 市 → 县 联动
    dom.city.addEventListener('change', updateDistricts);

    // 邮政编码 → 机构号 + PO 自动填充
    dom.postalCode.addEventListener('input', function () {
      autoGenerateInstCode();
      const code = this.value.trim();
      if (code.length === 6 && /^\d{6}$/.test(code)) {
        poAutoFillByCode(code);
      } else {
        hidePOSuggestions();
      }
    });

    // 网点名称 → PO 模糊搜索
    dom.postOffice.addEventListener('input', function () {
      clearTimeout(_poDebounceTimer);
      const query = this.value.trim();
      if (query.length >= 2) {
        _poDebounceTimer = setTimeout(() => poSearchByName(query), 300);
      } else {
        hidePOSuggestions();
      }
    });
    // 网点名称失焦时隐藏建议 (延迟以允许点击)
    dom.postOffice.addEventListener('blur', () => {
      setTimeout(hidePOSuggestions, 200);
    });
    dom.postOffice.addEventListener('focus', function () {
      const query = this.value.trim();
      if (query.length >= 2) poSearchByName(query);
    });

    // 日历弹窗：点击输入框切换
    dom.dateInput.addEventListener('click', toggleCalendar);

    // 日历导航
    dom.calPrev.addEventListener('click', (e) => { e.stopPropagation(); _selMonth--; if (_selMonth < 1) { _selMonth = 12; _selYear--; } renderCalendar(_selYear, _selMonth); });
    dom.calNext.addEventListener('click', (e) => { e.stopPropagation(); _selMonth++; if (_selMonth > 12) { _selMonth = 1; _selYear++; } renderCalendar(_selYear, _selMonth); });

    // 日期点击
    dom.calGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day');
      if (!cell) return;
      selectDate(_selYear, _selMonth, parseInt(cell.dataset.d, 10));
    });

    // 点击外部关闭日历
    document.addEventListener('click', (e) => {
      if (dom.calPopup.classList.contains('active') && !dom.dateInput.contains(e.target) && !dom.calPopup.contains(e.target)) {
        closeCalendar();
      }
    });

    // 添加戳号
    dom.addStampBtn.addEventListener('click', () => addStampRow(''));

    // 邮资机条件切换
    dom.hasMeter.addEventListener('change', toggleMeterFields);

    // 风景戳条件切换
    dom.hasScenic.addEventListener('change', toggleScenicFields);

    // 添加风景戳名称
    dom.addScenicBtn.addEventListener('click', () => addScenicRow(''));

    // ---- 图片上传 ----
    if (dom.photoAddBtn) {
      dom.photoAddBtn.addEventListener('click', () => dom.photoInput.click());
    }
    if (dom.photoInput) {
      dom.photoInput.addEventListener('change', async function () {
        // 先把 FileList 拷成真数组，再清空 input.value。
        // FileList 是**活对象**：直接 this.value = '' 会把它一并清空，
        // 于是"选了文件却什么都没发生"，而且不报任何错。
        const files = Array.from(this.files || []);
        this.value = '';
        await handleFilesPicked(files);
      });
    }
    if (dom.photoArea) {
      // 拖拽上传（设计稿 3.1：作为"后续功能"，这里顺手支持，不额外增加界面）
      dom.photoArea.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        dom.photoArea.classList.add('photo-dragover');
      });
      dom.photoArea.addEventListener('dragleave', (e) => {
        if (e.target === dom.photoArea) dom.photoArea.classList.remove('photo-dragover');
      });
      dom.photoArea.addEventListener('drop', async (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        dom.photoArea.classList.remove('photo-dragover');
        await handleFilesPicked(e.dataTransfer.files);
      });
    }

    // 提交
    dom.form.addEventListener('submit', handleSubmit);

    // 取消
    dom.cancelBtn.addEventListener('click', closeForm);

    // 点击遮罩关闭
    dom.overlay.addEventListener('click', (e) => {
      if (e.target === dom.overlay) closeForm();
    });

    // 键盘 ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.overlay.classList.contains('active')) {
        closeForm();
      }
    });
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return { init, open: openForm, close: closeForm };

})();
