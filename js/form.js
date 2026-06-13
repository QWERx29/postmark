/**
 * 数据录入表单 — 模态框
 * ======================
 * 依赖: PostmarkData (data.js), RecordStore (store.js)
 *
 * 功能:
 *   1. 省/市/县三级联动下拉框
 *   2. 机构号根据邮政编码自动生成
 *   3. 戳号动态增删
 *   4. 邮资机条件字段
 *   5. 风景/文化日戳条件字段 + 动态名称增删
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
    if (el) el.value = val || '';
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

    // 邮政编码 → 机构号
    dom.postalCode.addEventListener('input', autoGenerateInstCode);

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
