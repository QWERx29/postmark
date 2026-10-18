/**
 * 国际退信 — 列表与录入界面
 * ==========================
 * 依赖: ReturnStore（数据）、CountryData（国家/地区候选）、Dialog（index.html 内联）
 *
 * 记录一件寄往境外的邮件被退回、直至收回的完整过程：
 *   寄达国家（中文名 / 英文名 / 二字代码）、寄出方式、邮件号码（13 位）、
 *   寄出 / 寄达 / 返回 / 收回 四个时间、境外接收 / 出口互换局（均为六位字母）、邮路信息、备注。
 *
 * 三处交互值得说明：
 *   1. 国家三项（中文名 / 英文名 / 二字代码）同源 CountryData：
 *      从候选里选一条就补齐三项；手填代码或英文名（精确匹配）也会反向补齐。
 *   2. 邮路是「途经点 + 点与点之间的运送信息」：
 *      可增删途经点，任意相邻两点之间是一个自由填写的输入框（不填也可以）。
 *   3. 邮路与备注不在列表里占列，单击「寄达地」单元格弹窗查看。
 *
 * 对外接口（app.js 使用）: window.ReturnList
 */
(function () {

  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 排序偏好的存储键（界面偏好，不进记录） */
  const SORT_PREF_KEY = 'postmark_return_sort';

  let els = null;
  let formOpen = false;
  let detailOpen = false;
  let searchTerm = '';

  /** 排序要素与方向（默认：寄出时间新的在前） */
  let sortKey = 'sendDate';
  let sortDir = 'desc';

  /** 四个时间字段的当前值（''=未填），提交时一并入库 */
  let dates = { sendDate: '', arriveDate: '', returnDate: '', recoverDate: '' };
  /** 日历面板正在编辑的字段（key）与显示的年月 */
  let activeDateKey = 'sendDate';
  let calY = 0, calM = 0;

  /** 邮路草稿（与表单里的途经点行双向同步） */
  let routeDraft = { nodes: [], legs: [] };

  /** 国家候选下拉（懒建） */
  let countrySuggestEl = null;

  function cacheEls() {
    els = {
      card: $('mail-return-card'),
      count: $('return-count'),
      search: $('f-return-search'),
      sortSel: $('f-return-sort'),
      sortDirBtn: $('btn-return-sort-dir'),
      addBtn: $('btn-return-add'),
      exportBtn: $('btn-return-export'),
      importBtn: $('btn-return-import'),
      importFile: $('f-return-import-file'),
      tbody: $('return-tbody'),
      empty: $('return-list-empty'),
      overlay: $('return-form-overlay'),
      form: $('return-form'),
      formTitle: $('return-form-title'),
      fId: $('mr-id'),
      fCountryZh: $('mr-country-zh'),
      fCountryEn: $('mr-country-en'),
      fCountryCode: $('mr-country-code'),
      countryGroup: $('mr-country-zh-group'),
      fMethod: $('mr-method'),
      fMailNo: $('mr-mail-no'),
      fAccept: $('mr-accept-office'),
      fExport: $('mr-export-office'),
      fNotes: $('mr-notes'),
      routeRows: $('mr-route-rows'),
      routeAdd: $('mr-route-add'),
      detailOverlay: $('return-detail-overlay'),
      detailTitle: $('return-detail-title'),
      detailCountry: $('return-detail-country'),
      detailMailNo: $('return-detail-mailno'),
      detailRoute: $('return-detail-route'),
      detailNotes: $('return-detail-notes'),
      calPopup: $('mr-cal-popup'),
      calLabel: $('mr-cal-label'),
      calTitle: $('mr-cal-title'),
      calGrid: $('mr-cal-grid'),
      calPrev: $('mr-cal-prev'),
      calNext: $('mr-cal-next'),
      calToday: $('mr-cal-today'),
      calClear: $('mr-cal-clear'),
    };
    els.dateInputs = Array.from(document.querySelectorAll('#return-form .mr-date-input'));
    els.dateTexts = {};
    els.dateInputs.forEach(d => { els.dateTexts[d.dataset.field] = d.querySelector('.date-text'); });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /**
   * 属性值转义。
   * esc() 走的是 textContent → innerHTML，只转 & < >，**不转引号**；
   * 值要塞进 value="..." / title="..." 时必须再转一次，
   * 否则备注里的一个引号就能把属性截断、把后面的内容变成新属性（注入）。
   */
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const DATE_LABELS = {
    sendDate: '寄出时间',
    arriveDate: '寄达时间',
    returnDate: '返回时间',
    recoverDate: '收回时间',
  };

  /** 时间显示：只认 YYYY-MM-DD，其余原样显示（导入的脏数据不至于显示成空白） */
  function fmtDate(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '-';
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
  }

  // ============================================================
  // 列表
  // ============================================================

  /** 按搜索词过滤（号码 / 国家 / 方式 / 互换局 / 邮路 / 备注 / 日期） */
  function currentList() {
    const term = searchTerm.trim().toLowerCase();
    const list = ReturnStore.getSorted(sortKey, sortDir);
    if (!term) return list;
    return list.filter(r => [
      r.mailNo, r.countryZh, r.countryEn, r.countryCode, r.sendMethod,
      r.acceptOffice, r.exportOffice, r.notes,
      ReturnStore.routeSummary(r.route),
      r.sendDate, r.arriveDate, r.returnDate, r.recoverDate,
    ].some(v => String(v || '').toLowerCase().includes(term)));
  }

  function render() {
    if (!els) cacheEls();
    if (!els.card) return;

    const list = currentList();
    const total = ReturnStore.count();
    els.count.textContent = searchTerm.trim() ? `筛选出 ${list.length} / 共 ${total} 条` : `共 ${total} 条`;

    if (list.length === 0) {
      els.tbody.innerHTML = '';
      els.empty.style.display = '';
      els.empty.textContent = total === 0 ? '暂无国际退信记录' : '没有匹配的记录';
      return;
    }
    els.empty.style.display = 'none';

    els.tbody.innerHTML = list.map(r => {
      const route = ReturnStore.routeSummary(r.route);
      // 邮路 / 备注不占列：单击「寄达地」弹窗看
      const detailTip = [
        route ? `邮路: ${route}` : '邮路: 未填写',
        r.notes ? `备注: ${r.notes}` : '备注: 无',
      ].join('\n');
      return `
      <tr>
        <td class="ret-country-cell">
          <button type="button" class="ret-country-btn" data-detail="${escAttr(r.id)}"
                  title="单击查看邮路信息与备注&#10;${escAttr(detailTip)}">
            <span class="ret-country-zh">${esc(r.countryZh) || '-'}</span>
            ${r.countryCode ? `<span class="ret-country-code">${esc(r.countryCode)}</span>` : ''}
            ${r.countryEn ? `<span class="ret-country-en">${esc(r.countryEn)}</span>` : ''}
          </button>
        </td>
        <td>${esc(r.sendMethod) || '-'}</td>
        <td class="mail-no-cell">${esc(r.mailNo) || '-'}</td>
        <td class="ret-date-cell">${fmtDate(r.sendDate)}</td>
        <td class="ret-date-cell">${fmtDate(r.arriveDate)}</td>
        <td class="ret-date-cell">${fmtDate(r.returnDate)}</td>
        <td class="ret-date-cell">${fmtDate(r.recoverDate)}</td>
        <td class="mail-no-cell">${esc(r.acceptOffice) || '-'}</td>
        <td class="mail-no-cell">${esc(r.exportOffice) || '-'}</td>
        <td class="mail-actions">
          <button type="button" class="btn-edit" data-act="edit" data-id="${escAttr(r.id)}">编辑</button>
          <button type="button" class="btn-del" data-act="del" data-id="${escAttr(r.id)}">删除</button>
        </td>
      </tr>`;
    }).join('');

    bindRowEvents();
  }

  function bindRowEvents() {
    els.tbody.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAction(btn.dataset.act, btn.dataset.id));
    });
    els.tbody.querySelectorAll('.ret-country-btn').forEach(btn => {
      btn.addEventListener('click', () => openDetail(btn.dataset.detail));
    });
  }

  async function handleAction(act, id) {
    const rec = ReturnStore.getById(id);
    if (!rec) { render(); return; }

    if (act === 'edit') { openForm(rec); return; }

    if (act === 'del') {
      const who = rec.mailNo || rec.countryZh || '该记录';
      if (!(await Dialog.confirm(`确定删除「${who}」？此操作不可恢复！`))) return;
      ReturnStore.remove(id);
    }
  }

  // 单号查询改由 Ship24 自带组件承载（见 index.html 的 <ship24-tracking-widget>），
  // 它没有「预填单号」的公开接口，因此列表里的号码不再做成跳转按钮。

  // ============================================================
  // 寄达地详情弹窗：邮路信息 + 备注（这两项不在列表里占列）
  // ============================================================
  /** 打开某条记录的详情（按 id 取最新数据，避免列表快照过期） */
  function openDetail(id) {
    const rec = ReturnStore.getById(id);
    if (!rec) { render(); return; }

    const country = [rec.countryZh, rec.countryEn, rec.countryCode].filter(Boolean).join(' / ');
    els.detailTitle.textContent = `寄达地 · ${rec.countryZh || rec.countryCode || '未填写'}`;
    els.detailCountry.textContent = country || '-';
    els.detailMailNo.textContent = rec.mailNo || '-';

    const steps = ReturnStore.routeSteps(rec.route);
    els.detailRoute.innerHTML = steps.length === 0
      ? '<div class="ret-detail-empty">未填写邮路信息</div>'
      : steps.map(s => (s.kind === 'node'
          ? `<div class="ret-detail-node"><span class="route-badge">${s.index + 1}</span>`
            + `<span class="ret-detail-node-name">${esc(s.text) || '（未填途经点）'}</span></div>`
          : `<div class="ret-detail-leg">↓${s.text ? ' ' + esc(s.text) : ''}</div>`
        )).join('');

    els.detailNotes.textContent = rec.notes || '（无备注）';

    detailOpen = true;
    els.detailOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  /** @returns {boolean} 是否真的关掉了一个打开中的详情弹窗（供 Esc 处理判断） */
  function closeDetail() {
    if (!detailOpen) return false;
    detailOpen = false;
    els.detailOverlay.classList.remove('active');
    if (!formOpen) document.body.style.overflow = '';
    return true;
  }

  // ============================================================
  // 排序
  // ============================================================
  function loadSortPref() {
    try {
      const raw = localStorage.getItem(SORT_PREF_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && ReturnStore.SORT_OPTIONS.some(o => o.key === p.key)) sortKey = p.key;
      if (p && (p.dir === 'asc' || p.dir === 'desc')) sortDir = p.dir;
    } catch (e) { /* 隐私模式 / 脏数据：用默认值 */ }
  }

  function saveSortPref() {
    try { localStorage.setItem(SORT_PREF_KEY, JSON.stringify({ key: sortKey, dir: sortDir })); }
    catch (e) { /* 隐私模式忽略 */ }
  }

  function renderSortUI() {
    els.sortSel.innerHTML = ReturnStore.SORT_OPTIONS
      .map(o => `<option value="${escAttr(o.key)}">${esc(o.label)}</option>`).join('');
    els.sortSel.value = sortKey;
    els.sortDirBtn.textContent = sortDir === 'asc' ? '↑ 升序' : '↓ 降序';
  }

  // ============================================================
  // 时间字段：与「录入日戳」同款日历弹窗，一个面板服务四个字段
  // ============================================================
  function renderCalendar() {
    els.calLabel.textContent = DATE_LABELS[activeDateKey] || '';
    els.calTitle.textContent = `${calY}年${pad2(calM)}月`;
    const firstDow = new Date(calY, calM - 1, 1).getDay();
    const days = new Date(calY, calM, 0).getDate();
    const now = new Date();
    const cur = dates[activeDateKey];
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
    for (let d = 1; d <= days; d++) {
      const isToday = calY === now.getFullYear() && calM === now.getMonth() + 1 && d === now.getDate();
      const isSel = cur === `${calY}-${pad2(calM)}-${pad2(d)}`;
      const cls = (isToday ? ' cal-today' : '') + (isSel ? ' cal-sel' : '');
      cells.push(`<span class="cal-day${cls}" data-d="${d}">${d}</span>`);
    }
    els.calGrid.innerHTML = cells.join('');
  }

  /** 日历面板挂到 body：modal-container 有 transform，会让 fixed 定位失效 */
  function openCalendar(field, inputEl) {
    activeDateKey = field;
    const cur = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dates[field] || '');
    const now = new Date();
    calY = cur ? +cur[1] : now.getFullYear();
    calM = cur ? +cur[2] : now.getMonth() + 1;
    renderCalendar();

    const rect = inputEl.getBoundingClientRect();
    document.body.appendChild(els.calPopup);
    els.calPopup.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    els.calPopup.style.top = Math.min(rect.bottom + 4, window.innerHeight - 360) + 'px';
    els.calPopup.style.width = Math.max(rect.width, 272) + 'px';
    els.calPopup.classList.add('active');
    inputEl.classList.add('active');
  }

  function closeCalendar() {
    if (!els) return;
    els.calPopup.classList.remove('active');
    els.dateInputs.forEach(d => d.classList.remove('active'));
    // 放回表单里，避免一直挂在 body 上
    const holder = $('mr-cal-holder');
    if (holder && els.calPopup.parentNode !== holder) holder.appendChild(els.calPopup);
  }

  /** 写入某个时间字段（''=清空） */
  function setDate(field, value) {
    dates[field] = value;
    const textEl = els.dateTexts[field];
    if (!textEl) return;
    if (value) {
      textEl.textContent = value;
      textEl.style.color = '#333';
    } else {
      textEl.textContent = '请选择日期';
      textEl.style.color = '';
    }
  }

  function resetDates(rec) {
    Object.keys(DATE_LABELS).forEach(f => setDate(f, rec && rec[f] ? String(rec[f]) : ''));
  }

  // ============================================================
  // 国家（地区）：中文名 / 英文名 / 二字代码 三项联动
  // ============================================================
  function countrySuggestionsEl() {
    if (!countrySuggestEl) {
      countrySuggestEl = document.createElement('div');
      countrySuggestEl.id = 'mr-country-suggestions';
      countrySuggestEl.className = 'po-suggestions';
      els.countryGroup.appendChild(countrySuggestEl);
    }
    return countrySuggestEl;
  }

  function hideCountrySuggestions() {
    if (countrySuggestEl) {
      countrySuggestEl.style.display = 'none';
      countrySuggestEl.innerHTML = '';
    }
  }

  /** 一次填齐三项（只有选候选 / 反查命中时才调用） */
  function fillCountry(c) {
    if (!c) return;
    els.fCountryZh.value = c.zh;
    els.fCountryEn.value = c.en;
    els.fCountryCode.value = c.code;
  }

  function refreshCountrySuggestions() {
    const term = els.fCountryZh.value.trim();
    const box = countrySuggestionsEl();
    if (!term) { hideCountrySuggestions(); return; }

    const list = CountryData.search(term, 30);
    if (list.length === 0) {
      box.innerHTML = '<div class="po-suggestions-header">参考库里没有匹配项，可直接手填</div>';
      box.style.display = 'block';
      return;
    }
    box.innerHTML = '<div class="po-suggestions-header">候选国家 / 地区（点击选择并补齐三项）：</div>'
      + list.map(c => `
        <div class="po-suggestion-item" data-code="${escAttr(c.code)}">
          <span class="po-si-name">${esc(c.zh)}</span><span class="po-si-loc">${esc(c.en)}</span><span class="po-si-code">${esc(c.code)}</span>
        </div>`).join('');
    box.style.display = 'block';
  }

  /**
   * 手填二字代码后反向补齐中文名 / 英文名。
   * 只有代码在参考库里能查到才动另外两项（查不到就保持用户输入，允许冷门代码）。
   */
  function syncFromCode() {
    const code = ReturnStore.normalizeCountryCode(els.fCountryCode.value);
    els.fCountryCode.value = code;
    if (code.length < 2) return;
    const c = CountryData.findByCode(code);
    if (c) fillCountry(c);
  }

  /** 手填中文名 / 英文名（精确匹配）后反向补齐 */
  function syncFromName(which) {
    const c = which === 'zh'
      ? CountryData.findByZh(els.fCountryZh.value)
      : CountryData.findByEn(els.fCountryEn.value);
    if (c) fillCountry(c);
  }

  /**
   * 互换局输入框：随时只留字母、转大写、最多六位。
   * 不用 maxlength —— 约束作用在原始输入上，粘贴「JPTYOP␣」会被截成「JPTYO」，
   * 悄悄丢掉最后一位；这里先清洗再截断，就不会截错。
   */
  function syncOfficeInput(el) {
    const v = String(el.value).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, ReturnStore.OFFICE_LENGTH);
    if (el.value !== v) el.value = v;
  }

  // ============================================================
  // 邮路：途经点 + 相邻两点之间的运送信息
  //   「运送信息」只给一个输入框，不限形式（航班号 / 车次号 / 集装箱号都往里写）
  // ============================================================
  function readRouteFromDom() {
    if (!els.routeRows) return;
    const names = Array.from(els.routeRows.querySelectorAll('.route-node-name'));
    const legs = Array.from(els.routeRows.querySelectorAll('.route-leg-input'));
    routeDraft.nodes = names.map(i => i.value);
    routeDraft.legs = legs.map(i => i.value);
  }

  function renderRoute() {
    const nodes = routeDraft.nodes;
    const legs = routeDraft.legs;
    if (nodes.length === 0) {
      els.routeRows.innerHTML = '<div class="route-empty">还没有途经点，点下面的「+ 添加途经点」开始填写</div>';
      return;
    }
    els.routeRows.innerHTML = nodes.map((node, i) => {
      const isLast = i === nodes.length - 1;
      const legRow = isLast ? '' : `
        <div class="route-leg">
          <span class="route-leg-arrow">↓</span>
          <input type="text" class="form-input route-leg-input" data-leg="${i}"
                 value="${escAttr(ReturnStore._normalizeLeg(legs[i]))}" placeholder="运送信息（选填）" autocomplete="off">
        </div>`;
      return `
      <div class="route-item" data-i="${i}">
        <div class="route-node">
          <span class="route-badge">${i + 1}</span>
          <input type="text" class="form-input route-node-name" data-node="${i}" value="${escAttr(node)}"
                 placeholder="${i === 0 ? '起点（如 北京互换局）' : '途经点（如 东京互换局 / 巴黎）'}" autocomplete="off">
          <button type="button" class="route-del" data-del="${i}" title="删除该点">×</button>
        </div>
        ${legRow}
      </div>`;
    }).join('');
  }

  function addRouteNode() {
    readRouteFromDom();
    routeDraft.nodes.push('');
    renderRoute();
    const inputs = els.routeRows.querySelectorAll('.route-node-name');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }

  /**
   * 删除第 i 个途经点。
   * 点被删掉后，它两侧的两段运送信息合成为一段 → 一并去掉一条，
   * 避免剩下一条「不知道属于哪两点之间」的运送信息。
   */
  function removeRouteNode(i) {
    readRouteFromDom();
    routeDraft.nodes.splice(i, 1);
    if (i > 0) routeDraft.legs.splice(i - 1, 1);
    else routeDraft.legs.splice(0, 1);
    renderRoute();
  }

  // ============================================================
  // 新增 / 编辑表单
  // ============================================================
  function openForm(rec) {
    if (!els) cacheEls();
    const isEdit = !!rec;
    els.formTitle.textContent = isEdit ? '编辑国际退信记录' : '新增国际退信记录';
    els.fId.value = isEdit ? rec.id : '';

    els.fCountryZh.value = isEdit ? rec.countryZh : '';
    els.fCountryEn.value = isEdit ? rec.countryEn : '';
    els.fCountryCode.value = isEdit ? rec.countryCode : '';
    els.fMethod.value = (isEdit && ReturnStore.SEND_METHODS.includes(rec.sendMethod))
      ? rec.sendMethod : ReturnStore.DEFAULT_SEND_METHOD;
    els.fMailNo.value = isEdit ? rec.mailNo : '';
    els.fAccept.value = isEdit ? rec.acceptOffice : '';
    els.fExport.value = isEdit ? rec.exportOffice : '';
    els.fNotes.value = isEdit ? rec.notes : '';
    resetDates(isEdit ? rec : null);

    const route = isEdit ? ReturnStore._normalizeRoute(rec.route) : { nodes: [], legs: [] };
    // legs 是字符串数组，直接 slice；早先这里是 { ...l }（那时 leg 是对象），
    // 展开字符串会得到 {0:'C',1:'A',...}，渲染出来就成了 [object Object]
    routeDraft = { nodes: route.nodes.slice(), legs: route.legs.slice() };
    if (routeDraft.nodes.length === 0) routeDraft.nodes.push('');   // 新增时先给一个空行
    renderRoute();
    hideCountrySuggestions();

    formOpen = true;
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => els.fCountryZh.focus(), 50);
  }

  /** @returns {boolean} 是否真的关掉了一个打开中的表单（供 Esc 处理判断） */
  function closeForm() {
    if (!formOpen) return false;
    formOpen = false;
    closeCalendar();
    hideCountrySuggestions();
    els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    return true;
  }

  /** 校验并落库 */
  async function submitForm(e) {
    if (e) e.preventDefault();
    readRouteFromDom();

    const id = els.fId.value;
    const mailNo = ReturnStore.normalizeMailNo(els.fMailNo.value);
    const countryZh = els.fCountryZh.value.trim();
    const countryEn = els.fCountryEn.value.trim();
    const countryCode = ReturnStore.normalizeCountryCode(els.fCountryCode.value);
    const acceptOffice = ReturnStore.normalizeOffice(els.fAccept.value);
    const exportOffice = ReturnStore.normalizeOffice(els.fExport.value);

    // —— 邮件号码：13 位（硬性），格式标准与否只做提醒（软性） ——
    if (!mailNo) { await Dialog.alert('请填写邮件号码（13 位）'); els.fMailNo.focus(); return; }
    if (mailNo.length !== ReturnStore.MAIL_NO_LENGTH) {
      await Dialog.alert(`邮件号码应为 ${ReturnStore.MAIL_NO_LENGTH} 位，当前为 ${mailNo.length} 位`);
      els.fMailNo.focus();
      return;
    }
    if (!ReturnStore.isValidMailNo(mailNo)) {
      const ok = await Dialog.confirm(`「${mailNo}」不是标准的国际邮件号码格式（2 位字母 + 9 位数字 + 2 位字母），仍要保存吗？`);
      if (!ok) { els.fMailNo.focus(); return; }
    }

    // —— 寄达国家：中文名 / 二字代码至少一项 ——
    if (!countryZh && !countryCode) {
      await Dialog.alert('请填写寄达国家（地区）：中文名与二字代码至少填一项');
      els.fCountryZh.focus();
      return;
    }
    if (countryCode && !ReturnStore.isValidCountryCode(countryCode)) {
      await Dialog.alert('寄达国家（地区）二字代码应为 2 位字母');
      els.fCountryCode.focus();
      return;
    }

    // —— 互换局 / 时间链条 / 号码重复：都只提醒，不挡保存 ——
    if (acceptOffice && !ReturnStore.isValidOfficeCode(acceptOffice)) {
      const ok = await Dialog.confirm(`境外接收互换局应为六位字母，当前为「${acceptOffice}」，仍要保存吗？`);
      if (!ok) { els.fAccept.focus(); return; }
    }
    if (exportOffice && !ReturnStore.isValidOfficeCode(exportOffice)) {
      const ok = await Dialog.confirm(`境外出口互换局应为六位字母，当前为「${exportOffice}」，仍要保存吗？`);
      if (!ok) { els.fExport.focus(); return; }
    }

    const data = {
      countryZh,
      countryEn,
      countryCode,
      sendMethod: els.fMethod.value,
      mailNo,
      sendDate: dates.sendDate,
      arriveDate: dates.arriveDate,
      returnDate: dates.returnDate,
      recoverDate: dates.recoverDate,
      acceptOffice,
      exportOffice,
      route: { nodes: routeDraft.nodes, legs: routeDraft.legs },
      notes: els.fNotes.value.trim(),
    };

    const warn = ReturnStore.timelineWarning(data);
    if (warn) {
      const ok = await Dialog.confirm(`${warn}，仍要保存吗？`);
      if (!ok) return;
    }

    const dup = ReturnStore.findByMailNo(mailNo, id || undefined);
    if (dup.length > 0) {
      const where = dup[0].countryZh || dup[0].countryCode || '已有记录';
      const ok = await Dialog.confirm(`邮件号码「${mailNo}」已存在（寄达 ${where}），仍要保存吗？`);
      if (!ok) return;
    }

    if (id) {
      const rec = ReturnStore.getById(id);
      if (!rec) { closeForm(); await Dialog.alert('该记录已不存在，可能已被删除'); return; }
      ReturnStore.update(id, data);
    } else {
      ReturnStore.add(data);
    }
    closeForm();
  }

  // ============================================================
  // 导出 / 导入（与「邮资机戳」同款：JSON 备份，便于换机搬迁）
  // ============================================================
  function handleExport() {
    const data = ReturnStore.getAll();
    if (data.length === 0) { Dialog.alert('暂无数据可导出'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `postmark-return-${new Date().toISOString().slice(0, 10)}.json`;
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
          if (!ReturnStore.FIELDS.some(f => r[f]) && ReturnStore.isRouteEmpty(r.route)) return;
          ReturnStore.add(r);
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
    if (!els.card) return;

    loadSortPref();
    renderSortUI();

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
    els.exportBtn.addEventListener('click', handleExport);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', handleImportFile);

    els.form.addEventListener('submit', submitForm);
    $('mr-cancel').addEventListener('click', closeForm);
    $('mr-cancel-top').addEventListener('click', closeForm);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) closeForm(); });

    // 寄达地详情弹窗
    $('return-detail-close').addEventListener('click', closeDetail);
    $('return-detail-ok').addEventListener('click', closeDetail);
    els.detailOverlay.addEventListener('click', (e) => {
      if (e.target === els.detailOverlay) closeDetail();
    });

    // 时间字段：点哪个框，日历就编辑哪个字段
    els.dateInputs.forEach(d => {
      d.addEventListener('click', () => openCalendar(d.dataset.field, d));
    });
    els.calPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      calM--; if (calM < 1) { calM = 12; calY--; }
      renderCalendar();
    });
    els.calNext.addEventListener('click', (e) => {
      e.stopPropagation();
      calM++; if (calM > 12) { calM = 1; calY++; }
      renderCalendar();
    });
    els.calGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day');
      if (!cell) return;
      setDate(activeDateKey, `${calY}-${pad2(calM)}-${pad2(parseInt(cell.dataset.d, 10))}`);
      closeCalendar();
    });
    els.calToday.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = new Date();
      setDate(activeDateKey, `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`);
      closeCalendar();
    });
    els.calClear.addEventListener('click', (e) => {
      e.stopPropagation();
      setDate(activeDateKey, '');
      closeCalendar();
    });
    document.addEventListener('click', (e) => {
      if (!els.calPopup.classList.contains('active')) return;
      if (els.calPopup.contains(e.target)) return;
      if (els.dateInputs.some(d => d.contains(e.target))) return;
      closeCalendar();
    });

    // 国家三项联动
    els.fCountryZh.addEventListener('input', refreshCountrySuggestions);
    els.fCountryZh.addEventListener('focus', refreshCountrySuggestions);
    els.fCountryZh.addEventListener('change', () => syncFromName('zh'));
    els.fCountryZh.addEventListener('blur', () => setTimeout(hideCountrySuggestions, 200));
    els.fCountryEn.addEventListener('change', () => syncFromName('en'));
    els.fCountryCode.addEventListener('input', syncFromCode);
    els.fAccept.addEventListener('input', () => syncOfficeInput(els.fAccept));
    els.fExport.addEventListener('input', () => syncOfficeInput(els.fExport));
    els.countryGroup.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.po-suggestion-item');
      if (!item) return;
      e.preventDefault();   // 别让输入框先失焦，否则候选项会被收起
      fillCountry(CountryData.findByCode(item.dataset.code));
      hideCountrySuggestions();
    });

    // 邮路编辑器
    els.routeAdd.addEventListener('click', addRouteNode);
    els.routeRows.addEventListener('click', (e) => {
      const del = e.target.closest('.route-del');
      if (del) removeRouteNode(parseInt(del.dataset.del, 10));
    });
    els.routeRows.addEventListener('input', readRouteFromDom);

    // 数据变化（含导入 / 别处改动）时刷新列表
    ReturnStore.onChange(() => { if (els.card.style.display !== 'none') render(); });

    render();
  }

  /** 切到本页时调用（app.js） */
  function show() {
    if (!els) cacheEls();
    closeDetail();
    els.search.value = searchTerm;
    render();
  }

  window.ReturnList = {
    show: () => show(),
    render: () => render(),
    openForm: (rec) => openForm(rec || null),
    closeForm: () => closeForm(),
    closeDetail: () => closeDetail(),
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
