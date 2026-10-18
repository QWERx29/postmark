/**
 * 邮资机戳 — 独立数据表的列表与录入界面
 * ======================================
 * 依赖: MeterStore（数据）、PostmarkData（行政区划）、PODatabase（可选，网点候选）、
 *       RecordStore（可选，从自己录入的日戳记录里出候选）、Dialog（index.html 内联）
 *
 * 页面只认 MeterStore 这一张表：日戳记录里的邮资机字段只在
 * 「从日戳记录移植」时被读一次，之后两边的修改互不影响
 * （业务约定：邮资机戳一律在本页维护）。
 *
 * 列表列 = 型号 / 编号 / 上环 / 下环 / 表头 / 打印日期 / 打印网点 / 备注。
 * 「打印网点」由 省 → 市 → 县 三级选定后再填网点名称，候选建议与「录入日戳」同源：
 * 先给本机日戳记录里已录入的邮局，再补 base 参考库的匹配项。
 * 列表支持按不同要素升降序排序（选择记在 localStorage，下次打开保持）。
 *
 * 对外接口（app.js 使用）: window.MeterList
 */
(function () {

  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 排序偏好的存储键（与侧边栏折叠状态一样，属于界面偏好，不进记录） */
  const SORT_PREF_KEY = 'postmark_meter_sort';

  let els = null;
  let formOpen = false;
  let searchTerm = '';

  /** 排序要素与方向（默认打印日期新的在前） */
  let sortKey = 'printDate';
  let sortDir = 'desc';

  /** 已选中的打印日期；selY === 0 表示还没选（提交时按空处理） */
  let selY = 0, selM = 0, selD = 0;
  /** 日历面板当前显示的年月：翻月只动它，不会改变已选值 */
  let viewY = 0, viewM = 0;

  /** 网点候选下拉（懒建） */
  let suggestionsEl = null;
  let officeDebounce = null;

  function cacheEls() {
    els = {
      page: $('meter-page'),
      count: $('meter-count'),
      search: $('f-meter-search'),
      sortSel: $('f-meter-sort'),
      sortDirBtn: $('btn-meter-sort-dir'),
      addBtn: $('btn-meter-add'),
      seedBtn: $('btn-meter-seed'),
      exportBtn: $('btn-meter-export'),
      importBtn: $('btn-meter-import'),
      importFile: $('f-meter-import-file'),
      tbody: $('meter-tbody'),
      overlay: $('meter-form-overlay'),
      form: $('meter-form'),
      formTitle: $('meter-form-title'),
      fId: $('mf-id'),
      fProvince: $('mf-province'),
      fCity: $('mf-city'),
      districtContainer: $('mf-district-container'),
      officeGroup: $('mf-office-group'),
      fOffice: $('mf-print-office'),
      fModel: $('mf-model'),
      fNo: $('mf-no'),
      fUpper: $('mf-upper'),
      fLower: $('mf-lower'),
      fHeader: $('mf-header'),
      fNotes: $('mf-notes'),
      dateInput: $('mf-date-input'),
      dateText: $('mf-date-text'),
      dateHour: $('mf-date-hour'),
      calPopup: $('mf-cal-popup'),
      calTitle: $('mf-cal-title'),
      calGrid: $('mf-cal-grid'),
      calPrev: $('mf-cal-prev'),
      calNext: $('mf-cal-next'),
    };
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /**
   * 属性值转义。
   * esc() 走的是 textContent → innerHTML，只转 & < >，**不转引号**；
   * 值要塞进 title="..." 之类的属性时必须再转一次，否则备注里的一个引号
   * 就能把属性截断、把后面的内容变成新的属性（注入）。
   */
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 打印日期显示：兼容 10 位整数与旧格式 YYYY.MM.DD.HH */
  function fmtPrintDate(val) {
    if (!val) return '-';
    const s = String(val);
    if (/^\d{10}$/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:00`;
    }
    if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      return s.replace(/\./g, '-').replace(/-(\d{2})$/, ' $1:00');
    }
    return esc(s);
  }

  // ============================================================
  // 打印日期：与「录入日戳」同款日历弹窗
  // ============================================================
  function renderCalendar() {
    els.calTitle.textContent = `${viewY}年${pad2(viewM)}月`;
    const firstDow = new Date(viewY, viewM - 1, 1).getDay();
    const days = new Date(viewY, viewM, 0).getDate();
    const now = new Date();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
    for (let d = 1; d <= days; d++) {
      const isToday = viewY === now.getFullYear() && viewM === now.getMonth() + 1 && d === now.getDate();
      const isSel = selY === viewY && selM === viewM && d === selD;
      const cls = (isToday ? ' cal-today' : '') + (isSel ? ' cal-sel' : '');
      cells.push(`<span class="cal-day${cls}" data-d="${d}">${d}</span>`);
    }
    els.calGrid.innerHTML = cells.join('');
  }

  function openCalendar() {
    // 打开时默认停在已选月份，没选过就停在今天
    const n = new Date();
    viewY = selY || n.getFullYear();
    viewM = selM || n.getMonth() + 1;
    renderCalendar();
    const rect = els.dateInput.getBoundingClientRect();
    // 移到 body：modal-container 有 transform，会让 fixed 定位失效
    document.body.appendChild(els.calPopup);
    els.calPopup.style.left = rect.left + 'px';
    els.calPopup.style.top = (rect.bottom + 4) + 'px';
    els.calPopup.style.width = Math.max(rect.width, 272) + 'px';
    els.calPopup.classList.add('active');
    els.dateInput.classList.add('active');
  }

  function closeCalendar() {
    if (!els) return;
    els.calPopup.classList.remove('active');
    els.dateInput.classList.remove('active');
    // 放回原位置，避免一直挂在 body 上
    if (els.calPopup.parentNode === document.body) {
      els.dateInput.parentNode.appendChild(els.calPopup);
    }
  }

  function toggleCalendar() {
    if (els.calPopup.classList.contains('active')) closeCalendar();
    else openCalendar();
  }

  /** 选中日期；silent=true 时不关弹窗（用于回填已有记录） */
  function setDate(y, m, d, silent) {
    selY = y; selM = m; selD = d;
    viewY = y; viewM = m;
    els.dateText.textContent = `${y}年${pad2(m)}月${pad2(d)}日`;
    els.dateText.style.color = '#333';
    if (!silent) closeCalendar();
  }

  /** 清空日期，回到「请选择日期」的灰色占位（selY = 0 → 提交时按空处理） */
  function clearDate() {
    selY = 0; selM = 0; selD = 0;
    const n = new Date();
    viewY = n.getFullYear(); viewM = n.getMonth() + 1;
    els.dateText.textContent = '请选择日期';
    els.dateText.style.color = '';
  }

  function populateHourSelect(selected) {
    const h = selected || '08';
    els.dateHour.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const v = pad2(i);
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v + ':00';
      if (v === h) opt.selected = true;
      els.dateHour.appendChild(opt);
    }
  }

  /** 回填 10 位整数 / 旧格式；无法识别时保持"未选" */
  function setPrintDateValue(val) {
    const s = String(val || '');
    let y = 0, m = 0, d = 0, h = '08';
    if (/^\d{10}$/.test(s)) {
      y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8); h = s.slice(8, 10);
    } else if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      const p = s.split('.'); y = +p[0]; m = +p[1]; d = +p[2]; h = p[3];
    }
    if (!y) { clearDate(); populateHourSelect(null); return; }
    setDate(y, m, d, true);
    populateHourSelect(h);
  }

  /** 日历 + 小时 → 10 位整数 YYYYMMDDHH；没选日期返回空串 */
  function getPrintDateValue() {
    if (!selY) return '';
    return `${selY}${pad2(selM)}${pad2(selD)}${els.dateHour.value}`;
  }

  // ============================================================
  // 省 → 市 → 县（与「录入日戳」同款三级联动）
  // ============================================================
  function districtEl() {
    return els.districtContainer.querySelector('#mf-district, input');
  }

  function getDistrictValue() {
    const el = districtEl();
    return el ? el.value : '';
  }

  /** 行政区名可能不在参考表里（旧记录 / 手工导入），临时补一个选项免得被静默清空 */
  function setSelectValue(sel, val) {
    const v = val || '';
    if (v && !Array.from(sel.options).some(o => o.value === v)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    sel.value = v;
  }

  function setDistrictValue(val) {
    const el = districtEl();
    if (!el) return;
    if (el.tagName === 'SELECT' && val && !Array.from(el.options).some(o => o.value === val)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      el.appendChild(opt);
    }
    el.value = val || '';
  }

  function updateCities() {
    const provName = els.fProvince.value;
    const cities = provName ? PostmarkData.getProvinceCityNames(provName) : [];
    els.fCity.innerHTML = '<option value="">请选择市</option>';
    cities.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      els.fCity.appendChild(opt);
    });
    els.fCity.disabled = !provName;
    updateDistricts();
  }

  /** 按当前市重建区县控件：参考表里有区县就用下拉，没有则退化成文本框 */
  function updateDistricts() {
    const cityName = els.fCity.value;
    const dists = cityName ? PostmarkData.getDistricts(cityName) : [];
    els.districtContainer.innerHTML = '';

    let el;
    if (!cityName) {
      el = document.createElement('select');
      el.innerHTML = '<option value="">请先选择市</option>';
      el.disabled = true;
    } else if (dists.length > 0) {
      el = document.createElement('select');
      el.innerHTML = '<option value="">请选择区/县</option>';
      dists.forEach(d => { el.innerHTML += `<option value="${d}">${d}</option>`; });
    } else {
      el = document.createElement('input');
      el.type = 'text';
      el.placeholder = '直接输入区/县名称';
      el.addEventListener('input', refreshSuggestionsIfOpen);
    }
    el.id = 'mf-district';
    el.className = el.tagName === 'SELECT' ? 'form-select' : 'form-input';
    el.addEventListener('change', refreshSuggestionsIfOpen);
    els.districtContainer.appendChild(el);
  }

  function populateProvinces() {
    els.fProvince.innerHTML = '<option value="">请选择省份</option>';
    PostmarkData.getAllProvinces().forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      els.fProvince.appendChild(opt);
    });
  }

  // ============================================================
  // 网点候选建议（与「录入日戳」同源，另加本机日戳记录）
  // ============================================================
  function ensureSuggestionsEl() {
    if (!suggestionsEl) {
      suggestionsEl = document.createElement('div');
      suggestionsEl.id = 'mf-office-suggestions';
      suggestionsEl.className = 'po-suggestions';
      els.officeGroup.appendChild(suggestionsEl);
    }
    return suggestionsEl;
  }

  function hideSuggestions() {
    if (suggestionsEl) { suggestionsEl.style.display = 'none'; suggestionsEl.innerHTML = ''; }
  }

  function refreshSuggestionsIfOpen() {
    if (suggestionsEl && suggestionsEl.style.display === 'block') refreshSuggestions();
  }

  /** 省 / 市 / 县 / 网点名称的当前取值 */
  function currentFilter() {
    return {
      province: els.fProvince.value,
      city: els.fCity.value,
      district: getDistrictValue().trim(),
    };
  }

  /**
   * 候选网点：先给本机日戳记录里已录入的邮局（按已选行政区过滤），再补参考库匹配。
   * 关键字不足 2 个字、但已经选了省份时，也把该辖区的网点列出来供挑选。
   */
  function findCandidates(keyword) {
    const f = currentFilter();
    const kw = (keyword || '').trim().toLowerCase();
    const out = [];
    const seen = new Set();

    function push(name, postalCode, province, city, district, from) {
      if (!name) return;
      const key = `${name}|${province || ''}|${city || ''}|${district || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, postalCode, province, city, district, from });
    }

    // 1) 自己录入过的日戳记录
    if (typeof RecordStore !== 'undefined') {
      RecordStore.getAll().forEach(r => {
        if (f.province && r.province !== f.province) return;
        if (f.city && r.city !== f.city) return;
        if (f.district && r.district && r.district !== f.district) return;
        if (kw && !String(r.postOffice || '').toLowerCase().includes(kw)) return;
        push(r.postOffice, r.postalCode, r.province, r.city, r.district, '日戳记录');
      });
    }

    // 2) base 参考库（_buildAllRecords 有缓存，重复调用不重建）
    //    只取当前有效网点：归档里的已撤销 / 更名前旧名称不该出现在录入候选里
    if (typeof PODatabase !== 'undefined') {
      try {
        const base = {
          keyword: kw, province: f.province, city: f.city,
          limit: 8, includeHistory: false,
        };
        let found = PODatabase.search({ ...base, district: f.district });
        // 参考库的区县写法未必与行政区划表一致：按区县查空了就放宽到市，别让候选整片空掉
        if (found.length === 0 && f.district) found = PODatabase.search(base);
        found.forEach(r => push(r.name, r.postalCode, r.province, r.city, r.district, '参考库'));
      } catch (e) { /* 参考库还没水合时忽略，候选为空即可 */ }
    }

    return out.slice(0, 8);
  }

  function showSuggestions(list) {
    const container = ensureSuggestionsEl();
    if (list.length === 0) { hideSuggestions(); return; }

    container.innerHTML = '<div class="po-suggestions-header">候选网点（点击选择）：</div>';
    list.forEach(c => {
      const item = document.createElement('div');
      item.className = 'po-suggestion-item';
      const loc = [c.province, c.city, c.district].filter(Boolean).join('/');
      item.innerHTML =
        `<span class="po-si-name">${esc(c.name)}</span>` +
        `<span class="po-si-code">${esc(c.postalCode || '')}</span>` +
        `<span class="po-si-loc">${esc(loc)}${c.from ? ' · ' + esc(c.from) : ''}</span>`;
      // mousedown：抢在 blur 之前处理，否则先收起就没得点了
      item.addEventListener('mousedown', (e) => { e.preventDefault(); applyCandidate(c); });
      container.appendChild(item);
    });
    container.style.display = 'block';
  }

  /** 选中候选：网点名填入，省 / 市 / 县若还空着则一并补齐（与「录入日戳」一致） */
  function applyCandidate(c) {
    if (c.province && !els.fProvince.value) {
      setSelectValue(els.fProvince, c.province);
      updateCities();
    }
    if (c.city && !els.fCity.value) {
      setSelectValue(els.fCity, c.city);
      updateDistricts();
    }
    if (c.district && !getDistrictValue()) setDistrictValue(c.district);
    els.fOffice.value = c.name;
    hideSuggestions();
  }

  function refreshSuggestions() {
    if (!formOpen) return;
    const f = currentFilter();
    const q = els.fOffice.value.trim();
    // 关键字太短又没有行政区条件时，全库扫描没有意义
    if (q.length < 2 && !f.province && !f.city) { hideSuggestions(); return; }
    showSuggestions(findCandidates(q));
  }

  // ============================================================
  // 排序
  // ============================================================
  function loadSortPref() {
    try {
      const raw = localStorage.getItem(SORT_PREF_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      // 只认当前支持的要素：键被改坏时退回默认，免得下拉框显示空白
      if (o && typeof o.key === 'string' && MeterStore.SORT_OPTIONS.some(x => x.key === o.key)) sortKey = o.key;
      if (o && o.dir === 'asc') sortDir = 'asc';
    } catch (e) { /* 隐私模式 / 脏数据：用默认排序 */ }
  }

  function saveSortPref() {
    try {
      localStorage.setItem(SORT_PREF_KEY, JSON.stringify({ key: sortKey, dir: sortDir }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function renderSortUI() {
    els.sortSel.innerHTML = MeterStore.SORT_OPTIONS
      .map(o => `<option value="${o.key}">${esc(o.label)}</option>`)
      .join('');
    els.sortSel.value = sortKey;
    const desc = sortDir !== 'asc';
    els.sortDirBtn.textContent = desc ? '↓ 降序' : '↑ 升序';
    els.sortDirBtn.title = desc ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序';
  }

  // ============================================================
  // 列表渲染
  // ============================================================
  /** 搜索范围覆盖列表上的全部字段（含备注与省 / 市 / 县） */
  function haystack(r) {
    return [
      r.meterModel, r.meterNo, r.meterUpperRing, r.meterLowerRing, r.meterHeader,
      r.printOffice, r.notes, r.province, r.city, r.district,
      fmtPrintDate(r.printDate).replace(/-/g, ''),
    ].map(v => String(v || '')).join(' ').toLowerCase();
  }

  function currentList() {
    const term = searchTerm.trim().toLowerCase();
    const list = MeterStore.getSorted(sortKey, sortDir);
    if (!term) return list;
    return list.filter(r => haystack(r).includes(term));
  }

  /** 打印网点单元格：主行网点名称 + 浅色行政区辅行（直辖市同名部分不重复显示） */
  function officeCell(r) {
    const name = esc(r.printOffice) || '-';
    const parts = [r.province, r.city, r.district].filter(Boolean)
      .filter((p, i, arr) => p !== arr[i - 1]);
    const loc = parts.join(' ');
    return loc ? `${name}<span class="meter-office-loc">${esc(loc)}</span>` : name;
  }

  function render() {
    if (!els) cacheEls();
    const list = currentList();
    const total = MeterStore.count();
    const term = searchTerm.trim();

    const seeded = (MeterStore.lastSeed && MeterStore.lastSeed.added > 0)
      ? `（已从日戳记录移植 ${MeterStore.lastSeed.added} 条）`
      : '';
    els.count.textContent = term
      ? `筛选出 ${list.length} / 共 ${total} 条`
      : `共 ${total} 条${seeded}`;

    if (list.length === 0) {
      els.tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#999;padding:20px;">${
        total === 0 ? '暂无邮资机戳，可点「+ 新增」录入，或「从日戳记录移植」' : '没有匹配的记录'
      }</td></tr>`;
      return;
    }

    els.tbody.innerHTML = list.map(r => `
      <tr>
        <td>${esc(r.meterModel) || '-'}</td>
        <td>${esc(r.meterNo) || '-'}</td>
        <td>${esc(r.meterUpperRing) || '-'}</td>
        <td>${esc(r.meterLowerRing) || '-'}</td>
        <td>${esc(r.meterHeader) || '-'}</td>
        <td>${fmtPrintDate(r.printDate)}</td>
        <td>${officeCell(r)}</td>
        <td class="meter-notes-cell" title="${escAttr(r.notes)}">${esc(r.notes) || '-'}</td>
        <td class="rec-actions">
          <button type="button" class="btn-edit" data-id="${r.id}">编辑</button>
          <button type="button" class="btn-del" data-id="${r.id}">删除</button>
        </td>
      </tr>
    `).join('');

    els.tbody.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => openForm(MeterStore.getById(btn.dataset.id)));
    });
    els.tbody.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rec = MeterStore.getById(btn.dataset.id);
        if (!rec) return;
        const label = rec.meterNo || rec.meterModel || rec.printOffice || '该邮资机戳';
        if (await Dialog.confirm(`确定删除「${label}」？此操作不可恢复！`)) {
          MeterStore.remove(btn.dataset.id);
        }
      });
    });
  }

  // ============================================================
  // 新增 / 编辑表单
  // ============================================================
  function openForm(rec) {
    if (!els) cacheEls();
    const isEdit = !!rec;
    els.formTitle.textContent = isEdit ? '编辑邮资机戳' : '新增邮资机戳';
    els.fId.value = isEdit ? rec.id : '';

    // 省 → 市 → 县：逐级回填（历史记录里的行政区名可能已不在参考表里，setSelectValue 会兜住）
    setSelectValue(els.fProvince, isEdit ? rec.province : '');
    updateCities();
    setSelectValue(els.fCity, isEdit ? rec.city : '');
    updateDistricts();
    setDistrictValue(isEdit ? rec.district : '');

    els.fOffice.value = isEdit ? rec.printOffice : '';
    els.fModel.value = isEdit ? rec.meterModel : '';
    els.fNo.value = isEdit ? rec.meterNo : '';
    els.fUpper.value = isEdit ? rec.meterUpperRing : '';
    els.fLower.value = isEdit ? rec.meterLowerRing : '';
    els.fHeader.value = isEdit ? rec.meterHeader : '';
    els.fNotes.value = isEdit ? rec.notes : '';
    hideSuggestions();

    // 打印日期：编辑时回填已存值，新增时默认今天 + 当前小时（与「录入日戳」一致）
    if (isEdit && rec.printDate) {
      setPrintDateValue(rec.printDate);
    } else {
      const n = new Date();
      setDate(n.getFullYear(), n.getMonth() + 1, n.getDate(), true);
      populateHourSelect(pad2(n.getHours()));
    }

    formOpen = true;
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    // 聚焦网点名称：已选省 / 市时顺手把候选列出来
    setTimeout(() => { els.fOffice.focus(); refreshSuggestions(); }, 50);
  }

  /** @returns {boolean} 是否真的关掉了一个打开中的表单（供 Esc 处理判断） */
  function closeForm() {
    if (!formOpen) return false;
    formOpen = false;
    closeCalendar();
    hideSuggestions();
    els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    return true;
  }

  async function submitForm(e) {
    if (e) e.preventDefault();
    const prov = els.fProvince.value;
    const city = els.fCity.value;
    const printOffice = els.fOffice.value.trim();

    if (!prov) { await Dialog.alert('请选择省/自治区/直辖市'); return; }
    if (!city) { await Dialog.alert('请选择市'); return; }
    if (!printOffice) {
      await Dialog.alert('请填写打印网点');
      els.fOffice.focus();
      return;
    }

    const data = {
      province: prov,
      city,
      district: getDistrictValue().trim(),
      printOffice,
      meterModel: els.fModel.value.trim(),
      meterNo: els.fNo.value.trim(),
      meterUpperRing: els.fUpper.value.trim(),
      meterLowerRing: els.fLower.value.trim(),
      meterHeader: els.fHeader.value.trim(),
      printDate: getPrintDateValue(),
      notes: els.fNotes.value.trim(),
    };

    const id = els.fId.value;
    if (id) {
      const rec = MeterStore.getById(id);
      if (!rec) { closeForm(); await Dialog.alert('该记录已不存在，可能已被删除'); return; }
      // 移植来源等辅助字段原样保留，不在表单里出现
      MeterStore.update(id, data);
    } else {
      MeterStore.add(data);
    }
    closeForm();
  }

  // ============================================================
  // 从日戳记录移植
  // ============================================================
  async function handleSeed() {
    const p = MeterStore.previewSeed();
    if (p.pending === 0) {
      await Dialog.alert(p.done > 0
        ? `没有新的可移植记录（已移植 ${p.done} 条）。`
        : '日戳记录里还没有勾选「有邮资机」的记录。');
      return;
    }
    const ok = await Dialog.confirm(
      `将把 ${p.pending} 条日戳记录里的邮资机信息复制到本表：\n` +
      '省 / 市 / 县 / 打印网点 / 型号 / 编号 / 表头 / 下环 / 打印日期（取盖销日期）。\n\n' +
      '日戳记录本身不会被修改，已移植过的不重复；\n' +
      '注意：日戳记录里没有「上环」和「备注」，移植后为空，可在本表补充。\n\n' +
      '确定移植吗？'
    );
    if (!ok) return;
    const r = MeterStore.seedFromRecords();
    render();
    await Dialog.alert(`已移植 ${r.added} 条，跳过 ${r.skipped} 条（之前已移植）。`);
  }

  // ============================================================
  // 导出 / 导入 JSON
  // ============================================================
  async function handleExport() {
    const data = MeterStore.getAll();
    if (data.length === 0) { await Dialog.alert('暂无数据可导出'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `postmark-meter-stamps-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const list = JSON.parse(ev.target.result);
        if (!Array.isArray(list)) throw new Error('格式错误：应为记录数组');
        let imported = 0;
        list.forEach(r => {
          if (!r || typeof r !== 'object') return;
          // 至少要有一个能认出来的字段，避免把无关 JSON 灌进来
          if (!MeterStore.FIELDS.some(f => r[f])) return;
          MeterStore.add(r);
          imported++;
        });
        await Dialog.alert(`成功导入 ${imported} 条记录`);
      } catch (err) {
        await Dialog.alert('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // 重置 input，便于再次选择同一个文件
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    cacheEls();
    if (!els.page) return;

    loadSortPref();
    renderSortUI();
    populateProvinces();
    updateCities();

    els.search.addEventListener('input', () => {
      searchTerm = els.search.value;
      render();
    });
    els.sortSel.addEventListener('change', () => {
      sortKey = els.sortSel.value;
      saveSortPref();
      render();
    });
    els.sortDirBtn.addEventListener('click', () => {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      saveSortPref();
      renderSortUI();
      render();
    });

    els.addBtn.addEventListener('click', () => openForm(null));
    els.seedBtn.addEventListener('click', handleSeed);
    els.exportBtn.addEventListener('click', handleExport);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', handleImportFile);

    els.form.addEventListener('submit', submitForm);
    $('mf-cancel').addEventListener('click', closeForm);
    $('mf-cancel-top').addEventListener('click', closeForm);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) closeForm(); });

    // 省 → 市 → 县联动
    els.fProvince.addEventListener('change', () => { updateCities(); refreshSuggestionsIfOpen(); });
    els.fCity.addEventListener('change', () => { updateDistricts(); refreshSuggestionsIfOpen(); });

    // 网点名称 → 候选建议（与「录入日戳」同款交互：300ms 防抖 + 失焦延迟收起）
    els.fOffice.addEventListener('input', () => {
      clearTimeout(officeDebounce);
      officeDebounce = setTimeout(refreshSuggestions, 300);
    });
    els.fOffice.addEventListener('focus', refreshSuggestions);
    els.fOffice.addEventListener('blur', () => { setTimeout(hideSuggestions, 200); });

    // 打印日期：日历弹窗（与「录入日戳」同款交互）
    els.dateInput.addEventListener('click', toggleCalendar);
    els.calPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      viewM--; if (viewM < 1) { viewM = 12; viewY--; }
      renderCalendar();
    });
    els.calNext.addEventListener('click', (e) => {
      e.stopPropagation();
      viewM++; if (viewM > 12) { viewM = 1; viewY++; }
      renderCalendar();
    });
    els.calGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day');
      if (cell) setDate(viewY, viewM, parseInt(cell.dataset.d, 10));
    });
    document.addEventListener('click', (e) => {
      if (els.calPopup.classList.contains('active') &&
          !els.dateInput.contains(e.target) && !els.calPopup.contains(e.target)) {
        closeCalendar();
      }
    });

    // 数据变化（含移植 / 导入 / 别处改动）时刷新列表
    MeterStore.onChange(() => { if (els.page.style.display !== 'none') render(); });

    render();
  }

  /** 切到本页时调用（app.js） */
  function show() {
    if (!els) cacheEls();
    searchTerm = '';
    els.search.value = '';
    render();
  }

  window.MeterList = {
    show: () => show(),
    render: () => render(),
    openForm: (rec) => openForm(rec || null),
    closeForm: () => closeForm(),
    setSort: (key, dir) => {
      if (key) sortKey = key;
      if (dir) sortDir = dir === 'asc' ? 'asc' : 'desc';
      saveSortPref();
      if (els) { renderSortUI(); render(); }
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
