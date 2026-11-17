/**
 * 数据录入表单 — 模态框
 * ======================
 * 依赖: PostmarkData (data.js), RecordStore (store.js),
 *       ImageEditor (image-editor.js), ImageCore (image.js)
 *
 * 功能:
 *   1. 省/市/县三级联动下拉框
 *   2. 机构号根据邮政编码自动生成
 *   3. 戳号动态增删（每把日戳单独选材质，戳号留空 = 无戳号）
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
      submitContinueBtn: document.getElementById('f-submit-continue'),
      cancelBtn:    document.getElementById('f-cancel'),
      copyLastBtn:  document.getElementById('f-copy-last'),
      recentBtn:    document.getElementById('f-recent-office'),
      recentList:   document.getElementById('f-recent-list'),
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
  // 日历弹窗（统一组件，见 js/calendar.js）
  // ============================================================
  let _selYear = 0, _selMonth = 0, _selDay = 0;
  let cal = null;

  function openCalendar() {
    if (!cal) return;
    cal.open({
      selected: _selYear ? { y: _selYear, m: _selMonth, d: _selDay } : null,
      anchor: dom.dateInput,
    });
  }

  function closeCalendar() {
    if (cal) cal.close();
  }

  function toggleCalendar() {
    if (!cal) return;
    if (cal.isOpen()) closeCalendar();
    else openCalendar();
  }

  function selectDate(y, m, d) {
    _selYear = y; _selMonth = m; _selDay = d;
    dom.dateText.textContent = `${y}年${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日`;
    dom.dateText.style.color = '#333';
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

  /** 属性值转义：escHtml 不转引号，值要塞进 value="..." 时必须再处理一次 */
  function escAttr(s) {
    return escHtml(String(s == null ? '' : s))
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ============================================================
  // 动态列表: 戳号 + 材质（一把日戳一行）
  // ============================================================
  function addStampRow(value, material, isDefault) {
    const row = document.createElement('div');
    row.className = 'dynamic-row stamp-row';
    // 新建表单默认带一行：用户没填它、却另外填了别的戳号时，这一行不应变成多余的「无戳号」
    if (isDefault) row.dataset.defaultRow = '1';
    const number = value == null ? '' : String(value);
    const selectedMaterial = material || '';
    // 旧记录 / 导入数据里可能有不在固定选项里的材质，编辑时保留原值
    const materialOptions = MATERIAL_OPTIONS.slice();
    if (selectedMaterial && !materialOptions.includes(selectedMaterial)) {
      materialOptions.push(selectedMaterial);
    }
    row.innerHTML = `
      <input type="text" class="form-input stamp-input" value="${escAttr(number)}" placeholder="戳号（留空=无戳号）">
      <select class="form-select stamp-material" title="这把日戳的材质">
        <option value="">材质</option>
        ${materialOptions.map(m => `<option value="${escAttr(m)}"${m === selectedMaterial ? ' selected' : ''}>${escHtml(m)}</option>`).join('')}
      </select>
      <button type="button" class="btn-remove" title="删除">×</button>
    `;
    row.querySelector('.btn-remove').addEventListener('click', () => removeStampRow(row));
    dom.stampList.appendChild(row);
    syncStampRowControls();
    return row;
  }

  /** 删除一行；只剩一行时不允许删除（按钮会置灰，这里再兜一层） */
  function removeStampRow(row) {
    if (!row || !row.parentNode) return;
    if (dom.stampList.querySelectorAll('.stamp-row').length <= 1) return;
    row.remove();
    syncStampRowControls();
  }

  /**
   * 把「新增戳号」按钮放到最后一行，和戳号 / 材质同一行；
   * 同时控制删除按钮：只剩一行时置灰，不能把列表减到 0。
   */
  function syncStampRowControls() {
    const rows = Array.from(dom.stampList.querySelectorAll('.stamp-row'));
    const onlyOne = rows.length <= 1;

    rows.forEach((row) => {
      const removeBtn = row.querySelector('.btn-remove');
      if (!removeBtn) return;
      removeBtn.disabled = onlyOne;
      removeBtn.title = onlyOne ? '至少保留一把日戳' : '删除';
    });

    if (dom.addStampBtn && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      // 放在最后一行的末尾：前面各行的删除按钮仍能对齐
      lastRow.appendChild(dom.addStampBtn);
    }
  }

  /**
   * 表单里的日戳列表。
   * 戳号留空不是「没填」，而是「无戳号」；完全相同的行只保留一条。
   */
  function getStampValues() {
    const rows = Array.from(dom.stampList.querySelectorAll('.stamp-row')).map((row) => {
      const rawNumber = row.querySelector('.stamp-input').value.trim();
      return {
        number: rawNumber === '无戳号' ? '' : rawNumber,
        material: row.querySelector('.stamp-material').value,
        isDefault: row.dataset.defaultRow === '1',
      };
    });

    // 默认空行只有在「别的行也没填」时才作为「无戳号」保留
    const hasOtherContent = rows.some(r => !r.isDefault && (r.number || r.material));
    const kept = rows.filter(r => !(r.isDefault && !r.number && !r.material && hasOtherContent));

    const seen = new Set();
    const out = [];
    kept.forEach((r) => {
      const key = `${r.number}\u0000${r.material}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ number: r.number, material: r.material });
    });
    return out;
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
  // 图片本身由服务端写到 images/<记录ID>/（默认在项目根，见 img-export.js），记录里只存相对路径
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
  // 草稿（关闭表单 / 刷新页面后仍可恢复）
  // ============================================================
  const DRAFT_KEY = 'postmark_entry_draft';

  /** 表单快照：只存可序列化的文本字段，图片文件本身已落盘，不重复存 */
  function captureFormState() {
    return {
      province: dom.province.value,
      city: dom.city.value,
      district: getDistrictValue(),
      postOffice: dom.postOffice.value,
      postalCode: dom.postalCode.value,
      instCode: dom.instCode.value,
      status: dom.status.value,
      cancelDate: getCancelDateValue(),
      stamps: getStampValues().map(s => ({ number: s.number, material: s.material })),
      hasMeter: dom.hasMeter.checked,
      meterModel: dom.meterModel.value,
      meterNo: dom.meterNo.value,
      meterHeader: dom.meterHeader.value,
      meterLowerRing: dom.meterLower.value,
      hasScenic: dom.hasScenic.checked,
      scenicNames: getScenicValues(),
      notes: dom.notes.value,
      savedAt: new Date().toISOString(),
    };
  }

  /** 有没有值得保存的内容（只有区划 / 邮编 / 日期不算，避免无意义的恢复提示） */
  function hasDraftContent(state) {
    if (!state) return false;
    if (state.postOffice || state.notes) return true;
    if (Array.isArray(state.stamps) && state.stamps.some(s => s && (s.number || s.material))) return true;
    if (state.hasMeter || state.meterModel || state.meterNo || state.meterHeader || state.meterLowerRing) return true;
    if (state.hasScenic || (Array.isArray(state.scenicNames) && state.scenicNames.length > 0)) return true;
    return false;
  }

  function saveDraft() {
    try {
      const state = captureFormState();
      if (!hasDraftContent(state)) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
    } catch (e) {
      // 隐私模式 / 配额满：草稿失败不影响正常录入
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      return state && typeof state === 'object' ? state : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }

  function draftTimeText(savedAt) {
    const d = new Date(savedAt || '');
    if (Number.isNaN(d.getTime())) return '未知时间';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 把草稿写回表单（新建模式） */
  function applyFormState(state) {
    if (!state) return;
    isEditMode = false;
    editId = null;
    dom.saveId.value = '';
    dom.title.textContent = '录入日戳记录';

    dom.province.value = state.province || '';
    updateCities();
    dom.city.value = state.city || '';
    updateDistricts();
    setDistrictValue(state.district || '');

    dom.postOffice.value = state.postOffice || '';
    dom.postalCode.value = state.postalCode || '';
    dom.instCode.value = state.instCode || '';
    dom.status.value = state.status || 'open';
    if (state.cancelDate) setCancelDateValue(state.cancelDate);

    dom.stampList.innerHTML = '';
    const stamps = Array.isArray(state.stamps) && state.stamps.length
      ? state.stamps
      : [{ number: '', material: '' }];
    stamps.forEach((s, i) => {
      addStampRow(s.number || '', s.material || '', i === 0 && !s.number && !s.material);
    });

    dom.hasMeter.checked = Boolean(state.hasMeter);
    dom.meterModel.value = state.meterModel || '';
    dom.meterNo.value = state.meterNo || '';
    dom.meterHeader.value = state.meterHeader || '';
    dom.meterLower.value = state.meterLowerRing || '';
    toggleMeterFields();

    dom.hasScenic.checked = Boolean(state.hasScenic);
    dom.scenicList.innerHTML = '';
    (Array.isArray(state.scenicNames) ? state.scenicNames : []).forEach(n => addScenicRow(n));
    toggleScenicFields();

    dom.notes.value = state.notes || '';

    // 草稿里可能只有邮编（机构号还没生成）：补一个，免得恢复后保存被拦
    const pc = dom.postalCode.value.trim();
    if (!dom.instCode.value && /^\d{6}$/.test(pc)) {
      dom.instCode.value = RecordStore.generateInstCode(pc);
    }

    updatePostalCodeHint();
  }

  // ============================================================
  // 保存并继续：保留省 / 市 / 县 / 日期，清掉识别字段
  // ============================================================
  function resetForNextRecord() {
    const keep = {
      province: dom.province.value,
      city: dom.city.value,
      district: getDistrictValue(),
      postalCode: dom.postalCode.value.trim(),
      status: dom.status.value,
      cancelDate: getCancelDateValue(),
    };

    isEditMode = false;
    editId = null;
    dom.saveId.value = '';
    dom.title.textContent = '录入日戳记录';

    dom.postOffice.value = '';
    dom.instCode.value = '';
    dom.stampList.innerHTML = '';
    addStampRow('', '', true);

    dom.hasMeter.checked = false;
    dom.meterModel.value = '';
    dom.meterNo.value = '';
    dom.meterHeader.value = '';
    dom.meterLower.value = '';
    toggleMeterFields();

    dom.hasScenic.checked = false;
    dom.scenicList.innerHTML = '';
    toggleScenicFields();

    dom.notes.value = '';
    resetPhotos();

    // 恢复位置 / 日期；机构号按保留的邮编重新生成，免得留空挡住下一次保存
    dom.province.value = keep.province;
    updateCities();
    dom.city.value = keep.city;
    updateDistricts();
    setDistrictValue(keep.district);
    dom.postalCode.value = keep.postalCode;
    dom.status.value = keep.status;
    if (keep.cancelDate) setCancelDateValue(keep.cancelDate);
    if (/^\d{6}$/.test(keep.postalCode)) {
      dom.instCode.value = RecordStore.generateInstCode(keep.postalCode);
    }
    updatePostalCodeHint();

    dom.postOffice.focus();
  }

  // ============================================================
  // 复制上一条
  // ============================================================
  function copyLastRecord() {
    const records = RecordStore.getAll();
    if (records.length === 0) {
      Dialog.alert('还没有已保存的记录。');
      return;
    }
    const last = records.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    populateForm(last);

    // 复制出来的是一张新记录：清掉 id 与图片引用，机构号按邮编重新生成
    isEditMode = false;
    editId = null;
    dom.saveId.value = '';
    dom.title.textContent = '录入日戳记录（复制自上一条）';
    setPhotos([]);
    const pc = dom.postalCode.value.trim();
    if (/^\d{6}$/.test(pc)) {
      dom.instCode.value = RecordStore.generateInstCode(pc);
    }

    dom.postOffice.focus();
    dom.postOffice.select();
  }

  // ============================================================
  // 最近网点
  // ============================================================
  function recentOffices(limit) {
    const seen = new Set();
    const out = [];
    const records = RecordStore.getAll()
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    for (const r of records) {
      const name = String(r.postOffice || '').trim();
      if (!name) continue;
      const key = [r.province || '', r.city || '', r.district || '', name].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= (limit || 20)) break;
    }
    return out;
  }

  function renderRecentList() {
    if (!dom.recentList) return;
    const list = recentOffices(20);
    if (list.length === 0) {
      dom.recentList.hidden = true;
      Dialog.alert('还没有已保存的记录。');
      return;
    }

    dom.recentList.innerHTML = list.map((r, i) => `
      <button type="button" class="recent-office-item" data-idx="${i}">
        <span class="recent-office-name">${escHtml(r.postOffice)}</span>
        <span class="recent-office-meta">${escHtml([r.province, r.city, r.district].filter(Boolean).join(' / '))}
          · 机构号 ${escHtml(r.institutionCode || '—')}</span>
      </button>
    `).join('');

    dom.recentList.querySelectorAll('[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => applyRecentOffice(list[Number(btn.dataset.idx)]));
    });
    dom.recentList.hidden = false;
  }

  function applyRecentOffice(record) {
    if (!record) return;
    dom.province.value = record.province || '';
    updateCities();
    dom.city.value = record.city || '';
    updateDistricts();
    setDistrictValue(record.district || '');
    dom.postOffice.value = record.postOffice || '';
    dom.postalCode.value = record.postalCode || '';
    dom.instCode.value = record.institutionCode || '';
    dom.status.value = record.status || 'open';
    updatePostalCodeHint();
    if (dom.recentList) dom.recentList.hidden = true;
    dom.postOffice.focus();
  }

  function toggleRecentList() {
    if (!dom.recentList) return;
    if (!dom.recentList.hidden) { dom.recentList.hidden = true; return; }
    renderRecentList();
  }

  // ============================================================
  // 同网点：把本次日戳追加到已有记录
  // ============================================================
  async function appendStampsToRecord(existing, incoming) {
    const merged = RecordStore.getStamps(existing).slice();
    let added = 0;

    (incoming.stamps || []).forEach((s) => {
      const number = String(s.number || '').trim();
      const material = String(s.material || '').trim();
      if (!number && !material) return;
      if (merged.some(m => m.number === number && m.material === material)) return;
      merged.push({ number, material });
      added++;
    });

    const photos = Array.isArray(existing.photos) ? existing.photos.slice() : [];
    let photoAdded = 0;
    (incoming.photos || []).forEach((p) => {
      if (p && !photos.includes(p)) { photos.push(p); photoAdded++; }
    });

    RecordStore.update(existing.id, { stamps: merged, photos });

    const head = added > 0
      ? `已把 ${added} 把日戳追加到「${existing.postOffice}」。`
      : `「${existing.postOffice}」已有相同的戳号 / 材质，未新增日戳。`;
    const photoNote = photoAdded > 0 ? `\n同时追加了 ${photoAdded} 张图片。` : '';
    await Dialog.alert(
      `${head}${photoNote}\n\n原记录保留盖销日期 ${existing.cancelDate || '—'}；如需改日期请编辑该记录。`
    );
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

    // 戳号 / 材质：旧记录的 stampNumbers + material 由 RecordStore 归一化
    dom.stampList.innerHTML = '';
    const stamps = RecordStore.getStamps(record);
    if (stamps.length > 0) {
      stamps.forEach(s => addStampRow(s.number, s.material));
    } else {
      addStampRow('', '', true);
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
    await saveEntry(false);
  }

  /**
   * 保存一条记录。
   * @param {boolean} continueNext true = 保存并继续（保留省 / 市 / 县 / 日期，清空邮局与戳号）
   */
  async function saveEntry(continueNext) {
    if (dom.recentList) dom.recentList.hidden = true;

    // 基础验证
    const prov = dom.province.value;
    const city = dom.city.value;
    const po = dom.postOffice.value.trim();
    const pc = dom.postalCode.value.trim();
    const ic = dom.instCode.value.trim();
    const cd = getCancelDateValue();
    const stampValues = getStampValues();

    if (!prov) { await Dialog.alert('请选择省份'); return; }
    if (!city) { await Dialog.alert('请选择城市'); return; }
    if (!po)   { await Dialog.alert('请输入邮局名称'); return; }
    if (!pc || !/^\d{6}$/.test(pc)) { await Dialog.alert('请输入有效的6位邮政编码'); return; }
    if (!ic || !/^\d{8}$/.test(ic)) { await Dialog.alert('机构号必须为8位数字'); return; }
    if (!cd || !/^\d{10}$/.test(cd)) { await Dialog.alert('请选择完整的盖销日期和时间'); return; }
    if (stampValues.length === 0) { await Dialog.alert('请至少保留一把日戳'); return; }

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
      stamps: stampValues,
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

    // 同网点识别：省 + 市 + 县 + 邮局名完全相同
    if (!isEditMode) {
      const sameOffice = RecordStore.findSameOffice(record);
      if (sameOffice.length > 0) {
        const existing = sameOffice
          .slice()
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
        const loc = [record.province, record.city, record.district].filter(Boolean).join(' / ');
        const choice = await Dialog.choice(
          `「${loc} / ${record.postOffice}」已有 ${sameOffice.length} 条记录。\n\n`
          + `现有：机构号 ${existing.institutionCode || '—'}，`
          + `盖销 ${existing.cancelDate || '—'}，`
          + `${RecordStore.formatStamps(existing) || '无戳号'}\n\n`
          + '请选择处理方式：\n'
          + '· 追加戳号：把本次填写的日戳并入已有记录（保留原盖销日期）\n'
          + '· 编辑已有记录：打开已有记录，并把本次戳号带过去\n'
          + '· 仍然新建：另存为一条新记录',
          [
            { value: 'append', label: '追加戳号', primary: true },
            { value: 'edit', label: '编辑已有记录' },
            { value: 'new', label: '仍然新建' },
            { value: 'cancel', label: '取消' },
          ]
        );
        if (!choice || choice === 'cancel') return;

        if (choice === 'append') {
          await appendStampsToRecord(existing, record);
          clearDraft();
          if (continueNext) resetForNextRecord();
          else closeForm({ skipDraft: true });
          return;
        }
        if (choice === 'edit') {
          clearDraft();
          openForm(existing, { extraStamps: record.stamps, extraPhotos: record.photos });
          return;
        }

        // 仍然新建：机构号若与已有记录冲突，自动换一个（机构号本来就是邮编 + 随机 + 校验）
        if (record.institutionCode && RecordStore.getByInstCode(record.institutionCode)) {
          record.institutionCode = RecordStore.generateInstCode(record.postalCode);
          dom.instCode.value = record.institutionCode;
        }
      }
    }

    // 重复机构号校验
    if (!isEditMode) {
      const existing = RecordStore.getByInstCode(record.institutionCode);
      if (existing) {
        await Dialog.alert(`机构号 "${record.institutionCode}" 已存在，请确认邮政编码是否正确`);
        return;
      }
    }

    // 保存
    if (isEditMode) {
      RecordStore.update(editId, record);
    } else {
      RecordStore.add(record);
    }

    clearDraft();

    if (continueNext) {
      resetForNextRecord();
    } else {
      closeForm({ skipDraft: true });
    }
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
  /** 编辑模式打开时，把「同网点」流程里当前表单的戳号 / 图片一起带过去 */
  function applyExtraToForm(options) {
    const opts = options || {};

    if (Array.isArray(opts.extraStamps) && opts.extraStamps.length > 0) {
      let merged = getStampValues()
        .filter(s => s.number || s.material)
        .map(s => ({ number: s.number, material: s.material }));
      opts.extraStamps.forEach((s) => {
        const number = String(s.number || '').trim();
        const material = String(s.material || '').trim();
        if (!number && !material) return;
        if (!merged.some(m => m.number === number && m.material === material)) {
          merged.push({ number, material });
        }
      });
      if (merged.length === 0) merged = [{ number: '', material: '' }];
      dom.stampList.innerHTML = '';
      merged.forEach(s => addStampRow(s.number, s.material, false));
    }

    if (Array.isArray(opts.extraPhotos) && opts.extraPhotos.length > 0) {
      const photos = Array.from(new Set([...(photoSaved || []), ...opts.extraPhotos.filter(Boolean)]));
      setPhotos(photos);
    }
  }

  function openForm(record, options) {
    if (dom.recentList) dom.recentList.hidden = true;
    dom.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (record) {
      populateForm(record);
      applyExtraToForm(options);
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
      addStampRow('', '', true);
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

      // 上次关闭时留下的草稿：问一次要不要恢复
      const draft = loadDraft();
      if (draft && hasDraftContent(draft)) {
        setTimeout(async () => {
          if (!dom.overlay.classList.contains('active')) return;
          const ok = await Dialog.confirm(
            `发现上次未保存的草稿（保存于 ${draftTimeText(draft.savedAt)}），是否恢复？\n\n`
            + '选择「取消」会丢弃这份草稿。'
          );
          if (ok) applyFormState(draft);
          else clearDraft();
        }, 60);
      }
    }
  }

  /** 某个独立模态层（图片编辑器 / Dialog）当前是否打开 */
  function isModalLayerOpen(id) {
    const el = document.getElementById(id);
    return Boolean(el && el.classList.contains('active'));
  }

  function closeForm(options) {
    const skipDraft = Boolean(options && options.skipDraft);
    // 新建模式下关闭表单 = 用户可能只是暂时离开：留一份草稿，下次打开可恢复
    if (!isEditMode && !skipDraft && dom.overlay.classList.contains('active')) {
      saveDraft();
    }
    closeCalendar();
    // 清掉待保存图片的 objectURL，避免长时间占用内存
    resetPhotos();
    if (dom.recentList) dom.recentList.hidden = true;
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

    // 日历默认今天 + 小时下拉
    const now = new Date();
    _selYear = now.getFullYear(); _selMonth = now.getMonth() + 1; _selDay = now.getDate();
    dom.dateText.textContent = `${_selYear}年${String(_selMonth).padStart(2,'0')}月${String(_selDay).padStart(2,'0')}日`;
    dom.dateText.style.color = '#333';
    populateHourSelect(dom.cancelDateHour, String(now.getHours()).padStart(2, '0'));

    // 日历组件（独立测试页可能没有加载 calendar.js，此时只保留日期默认值）
    if (typeof CalendarPopup !== 'undefined' && CalendarPopup && CalendarPopup.create) {
      cal = CalendarPopup.create({
        popup: dom.calPopup,
        title: dom.calTitle,
        grid: dom.calGrid,
        prev: dom.calPrev,
        next: dom.calNext,
        onPick: selectDate,
      });
    }

    // 默认添加一行戳号（留空即「无戳号」）
    addStampRow('', '', true);

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

    // 日历弹窗：点击输入框切换（翻月 / 年历切换由组件内部处理）
    dom.dateInput.addEventListener('click', toggleCalendar);

    // 添加戳号
    dom.addStampBtn.addEventListener('click', () => addStampRow('', ''));

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

    // 提交 / 保存并继续
    dom.form.addEventListener('submit', handleSubmit);
    if (dom.submitContinueBtn) {
      dom.submitContinueBtn.addEventListener('click', () => saveEntry(true));
    }

    // 取消
    dom.cancelBtn.addEventListener('click', closeForm);

    // 快捷：复制上一条 / 最近网点
    if (dom.copyLastBtn) dom.copyLastBtn.addEventListener('click', copyLastRecord);
    if (dom.recentBtn) {
      dom.recentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRecentList();
      });
    }
    document.addEventListener('click', (e) => {
      if (!dom.recentList || dom.recentList.hidden) return;
      if (dom.recentList.contains(e.target) || (dom.recentBtn && dom.recentBtn.contains(e.target))) return;
      dom.recentList.hidden = true;
    });

    // 点击遮罩关闭
    dom.overlay.addEventListener('click', (e) => {
      if (e.target === dom.overlay) closeForm();
    });

    // 页面刷新 / 关闭窗口前留一份草稿
    window.addEventListener('beforeunload', () => {
      if (!isEditMode && dom.overlay && dom.overlay.classList.contains('active')) saveDraft();
    });

    // 快捷键：Ctrl/Cmd+S 保存；Esc 关闭（图片编辑器 / 对话框优先）
    document.addEventListener('keydown', (e) => {
      if (!dom.overlay.classList.contains('active')) return;
      if (isModalLayerOpen('image-editor-overlay') || isModalLayerOpen('dialog-overlay')) return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        saveEntry(false);
        return;
      }

      if (e.key !== 'Escape') return;

      // 最近网点列表展开时，Esc 先收起它
      if (dom.recentList && !dom.recentList.hidden) {
        dom.recentList.hidden = true;
        return;
      }

      closeForm();
    });
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return { init, open: openForm, close: closeForm };

})();
