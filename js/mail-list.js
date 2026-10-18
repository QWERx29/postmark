/**
 * 邮件管理 · 待发 / 在途 / 妥收 — 共用一张表的列表界面
 * =====================================================
 * 依赖: MailStore（数据）、Dialog（提示）、Ship24 查询组件（index.html，可选）
 *
 * 三个模块是同一张表的三个状态视图：
 *   - 列表按当前模块的状态过滤；
 *   - **只有「待发」出现「+ 新增」**（业务约定：条目一律先落到待发）；
 *   - 状态流转按钮把条目推向下一个模块，也可退回，便于纠错。
 *
 * 对外接口（app.js 使用）: window.MailList
 */
(function () {

  const $ = (id) => document.getElementById(id);

  /** 当前模块状态 */
  let currentStatus = 'pending';
  let formOpen = false;
  /** 每个状态各自的搜索词（切换模块时互不干扰） */
  const searchTerms = { pending: '', transit: '', delivered: '' };

  let els = null;

  function cacheEls() {
    els = {
      card: $('mail-list-card'),
      cardTitle: $('mail-list-card-title'),
      count: $('mail-list-count'),
      search: $('mail-list-search'),
      addBtn: $('btn-mail-add'),
      tbody: $('mail-tbody'),
      empty: $('mail-list-empty'),
      overlay: $('mail-form-overlay'),
      form: $('mail-form'),
      formTitle: $('mail-form-title'),
      fId: $('m-id'),
      dateInput: $('m-date-input'),
      dateText: $('m-date-text'),
      calPopup: $('m-cal-popup'),
      calTitle: $('m-cal-title'),
      calGrid: $('m-cal-grid'),
      calPrev: $('m-cal-prev'),
      calNext: $('m-cal-next'),
      fType: $('m-type'),
      fNo: $('m-no'),
      fNoRequired: $('m-no-required'),
      fFrom: $('m-from'),
      fTo: $('m-to'),
      fContent: $('m-content'),
    };
  }

  // ============================================================
  // 发出日期：与「录入日戳」同款日历弹窗（同一套 .cal-* / .date-input 样式）
  // ============================================================
  /** 表单当前值：YYYY-MM-DD，空串表示还没选 */
  let dateValue = '';
  /** 日历正在显示（兼当前选中）的年月日 */
  let calY = 0, calM = 0, calD = 0;

  const pad2 = (n) => String(n).padStart(2, '0');

  function renderCalendar() {
    if (!els) cacheEls();
    els.calTitle.textContent = `${calY}年${pad2(calM)}月`;
    const firstDow = new Date(calY, calM - 1, 1).getDay();
    const days = new Date(calY, calM, 0).getDate();
    const now = new Date();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
    for (let d = 1; d <= days; d++) {
      const isToday = calY === now.getFullYear() && calM === now.getMonth() + 1 && d === now.getDate();
      const cls = (isToday ? ' cal-today' : '') + (d === calD ? ' cal-sel' : '');
      cells.push(`<span class="cal-day${cls}" data-d="${d}">${d}</span>`);
    }
    els.calGrid.innerHTML = cells.join('');
  }

  function openCalendar() {
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

  /** 写入日期；silent=true 时不关弹窗（用于回填已有记录） */
  function setDate(y, m, d, silent) {
    calY = y; calM = m; calD = d;
    dateValue = `${y}-${pad2(m)}-${pad2(d)}`;
    els.dateText.textContent = `${y}年${pad2(m)}月${pad2(d)}日`;
    els.dateText.style.color = '#333';
    if (!silent) closeCalendar();
  }

  /** 清空日期，回到「请选择日期」的灰色占位 */
  function clearDate() {
    const n = new Date();
    calY = n.getFullYear(); calM = n.getMonth() + 1; calD = n.getDate();
    dateValue = '';
    els.dateText.textContent = '请选择日期';
    els.dateText.style.color = '';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /** 按当前模块 + 搜索词过滤 */
  function currentList() {
    const term = (searchTerms[currentStatus] || '').trim().toLowerCase();
    const list = MailStore.getByStatus(currentStatus);
    if (!term) return list;
    return list.filter(r =>
      [r.mailNo, r.mailType, r.fromPlace, r.toPlace, r.content, r.sendDate]
        .some(v => String(v || '').toLowerCase().includes(term))
    );
  }

  // ============================================================
  // 渲染
  // ============================================================
  function render() {
    if (!els) cacheEls();
    const list = currentList();
    const total = MailStore.count(currentStatus);
    const term = (searchTerms[currentStatus] || '').trim();

    els.cardTitle.textContent = MailStore.STATUS_LABEL[currentStatus];
    els.count.textContent = term ? `筛选出 ${list.length} / 共 ${total} 条` : `共 ${total} 条`;
    // 业务约定：只有「待发」能新增
    els.addBtn.style.display = currentStatus === 'pending' ? '' : 'none';

    if (list.length === 0) {
      els.tbody.innerHTML = '';
      els.empty.style.display = '';
      els.empty.textContent = total === 0
        ? `暂无${MailStore.STATUS_LABEL[currentStatus]}邮件`
        : '没有匹配的记录';
      return;
    }
    els.empty.style.display = 'none';

    els.tbody.innerHTML = list.map(r => `
      <tr>
        <td style="width:110px;">${esc(r.sendDate) || '-'}</td>
        <td style="width:110px;">${esc(r.mailType) || '-'}</td>
        <td style="width:170px;" class="mail-no-cell">${esc(r.mailNo) || '-'}</td>
        <td style="width:130px;">${esc(r.fromPlace) || '-'}</td>
        <td style="width:130px;">${esc(r.toPlace) || '-'}</td>
        <td class="mail-content-cell" title="${esc(r.content)}">${esc(r.content) || '-'}</td>
        <td style="width:250px;" class="mail-actions">${rowActions(r)}</td>
      </tr>
    `).join('');

    bindRowEvents();
  }

  /** 行内操作按钮：编辑 / 状态流转 / 删除 */
  function rowActions(r) {
    const btns = [`<button type="button" class="btn-edit" data-act="edit" data-id="${r.id}">编辑</button>`];
    if (r.status === 'pending') {
      btns.push(`<button type="button" class="btn-move" data-act="status" data-id="${r.id}" data-to="transit" title="标记为已发出">发出 →</button>`);
    } else if (r.status === 'transit') {
      btns.push(`<button type="button" class="btn-move" data-act="status" data-id="${r.id}" data-to="delivered" title="标记为已妥收">妥收 ✓</button>`);
      btns.push(`<button type="button" class="btn-back" data-act="status" data-id="${r.id}" data-to="pending" title="退回待发">← 退回</button>`);
    } else if (r.status === 'delivered') {
      btns.push(`<button type="button" class="btn-back" data-act="status" data-id="${r.id}" data-to="transit" title="退回在途">← 退回</button>`);
    }
    btns.push(`<button type="button" class="btn-del" data-act="del" data-id="${r.id}">删除</button>`);
    return btns.join('');
  }

  function bindRowEvents() {
    els.tbody.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAction(btn.dataset.act, btn.dataset.id, btn.dataset.to));
    });
  }

  async function handleAction(act, id, to) {
    const rec = MailStore.getById(id);
    if (!rec) return;

    if (act === 'edit') { openForm(rec); return; }

    if (act === 'status') {
      const label = MailStore.STATUS_LABEL[to];
      if (to === 'transit' && rec.status === 'pending') {
        if (!(await Dialog.confirm(`把「${rec.mailNo || '该邮件'}」标记为已发出，移入「在途」？`))) return;
      } else if (to === 'delivered') {
        if (!(await Dialog.confirm(`把「${rec.mailNo || '该邮件'}」标记为已妥收，移入「妥收」？`))) return;
      } else {
        if (!(await Dialog.confirm(`把「${rec.mailNo || '该邮件'}」退回「${label}」？`))) return;
      }
      MailStore.setStatus(id, to);
      return;
    }

    if (act === 'del') {
      if (!(await Dialog.confirm(`确定删除「${rec.mailNo || '该邮件'}」？此操作不可恢复！`))) return;
      MailStore.remove(id);
    }
  }

  // 单号查询改由 Ship24 自带组件承载（见 index.html 的 <ship24-tracking-widget>），
  // 它没有「预填单号」的公开接口，因此列表里的号码不再做成跳转按钮。

  // ============================================================
  // 新增 / 编辑表单
  // ============================================================

  /**
   * 按当前种类刷新「邮件号码」的必填标记与提示。
   * 平信没有条码 → 不强制填写；挂号信 → 必填。
   */
  function syncTypeUI() {
    const need = MailStore.requiresMailNo(els.fType.value);
    if (els.fNoRequired) els.fNoRequired.style.display = need ? '' : 'none';
    els.fNo.placeholder = need ? '邮件号码' : '邮件号码 (选填)';
  }

  /**
   * 填充种类下拉。
   * 历史数据里可能有 EMS / 包裹 之类（本功能早期是自由输入），
   * 编辑到这种记录时把原值作为一个选项保留，避免保存时被悄悄改掉。
   */
  function populateTypeOptions(currentType) {
    const types = MailStore.MAIL_TYPES.slice();
    if (currentType && !types.includes(currentType)) types.push(currentType);
    els.fType.innerHTML = types
      .map(t => `<option value="${esc(t)}">${esc(t)}${MailStore.MAIL_TYPES.includes(t) ? '' : '（原有值）'}</option>`)
      .join('');
  }

  function openForm(rec) {
    if (!els) cacheEls();
    const isEdit = !!rec;
    els.formTitle.textContent = isEdit ? '编辑邮件记录' : '新增邮件记录（待发）';
    els.fId.value = isEdit ? rec.id : '';
    // 发出日期：编辑时回填已存值，新增时保持「请选择日期」占位（与录入日戳一致）
    const sd = isEdit ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.sendDate || '') : null;
    if (sd) setDate(+sd[1], +sd[2], +sd[3], true);
    else clearDate();
    populateTypeOptions(isEdit ? rec.mailType : '');
    els.fType.value = isEdit && rec.mailType ? rec.mailType : MailStore.DEFAULT_MAIL_TYPE;
    els.fNo.value = isEdit ? rec.mailNo : '';
    els.fFrom.value = isEdit ? rec.fromPlace : '';
    els.fTo.value = isEdit ? rec.toPlace : '';
    els.fContent.value = isEdit ? rec.content : '';
    syncTypeUI();

    formOpen = true;
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    // 挂号信先聚焦号码框；平信没有号码可填，落到寄出地
    setTimeout(() => (MailStore.requiresMailNo(els.fType.value) ? els.fNo : els.fFrom).focus(), 50);
  }

  /** @returns {boolean} 是否真的关掉了一个打开中的表单（供 Esc 处理判断） */
  function closeForm() {
    if (!formOpen) return false;
    formOpen = false;
    closeCalendar();
    els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    return true;
  }

  async function submitForm(e) {
    if (e) e.preventDefault();
    const sendDate = dateValue;
    const mailType = els.fType.value;
    const mailNo = els.fNo.value.trim();

    if (!sendDate) { await Dialog.alert('请选择发出日期'); return; }
    // 平信没有条码，不强制；挂号信必须填
    if (MailStore.requiresMailNo(mailType) && !mailNo) {
      await Dialog.alert(`${mailType}请填写邮件号码`);
      els.fNo.focus();
      return;
    }

    const data = {
      sendDate,
      mailType,
      mailNo,
      fromPlace: els.fFrom.value.trim(),
      toPlace: els.fTo.value.trim(),
      content: els.fContent.value.trim(),
    };

    const id = els.fId.value;
    if (id) {
      const rec = MailStore.getById(id);
      if (!rec) { closeForm(); await Dialog.alert('该记录已不存在，可能已被删除'); return; }
      MailStore.update(id, data);
    } else {
      // 新增一律落到「待发」
      MailStore.add({ ...data, status: 'pending' });
    }
    closeForm();
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    cacheEls();
    if (!els.card) return;

    els.addBtn.addEventListener('click', () => openForm(null));
    els.search.addEventListener('input', () => {
      searchTerms[currentStatus] = els.search.value;
      render();
    });
    els.form.addEventListener('submit', submitForm);
    els.fType.addEventListener('change', syncTypeUI);

    // 发出日期：日历弹窗（与录入日戳同款交互）
    els.dateInput.addEventListener('click', toggleCalendar);
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
      if (cell) setDate(calY, calM, parseInt(cell.dataset.d, 10));
    });
    document.addEventListener('click', (e) => {
      if (els.calPopup.classList.contains('active') &&
          !els.dateInput.contains(e.target) && !els.calPopup.contains(e.target)) {
        closeCalendar();
      }
    });

    $('m-cancel').addEventListener('click', closeForm);
    $('m-cancel-top').addEventListener('click', closeForm);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) closeForm(); });

    // 数据变化（含别处改动）时刷新当前列表
    MailStore.onChange(() => { if (els.card.style.display !== 'none') render(); });

    render();
  }

  /**
   * 切到某个模块的状态视图。
   * @param {'pending'|'transit'|'delivered'} status
   */
  function show(status) {
    if (!els) cacheEls();
    currentStatus = MailStore.STATUSES.includes(status) ? status : 'pending';
    els.search.value = searchTerms[currentStatus] || '';
    render();
  }

  window.MailList = {
    show: (status) => show(status),
    render: () => render(),
    openForm: (rec) => openForm(rec || null),
    closeForm: () => closeForm(),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
