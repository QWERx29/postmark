/**
 * 邮件管理 · 待发 / 在途 / 妥收 — 共用一张表的列表界面
 * =====================================================
 * 依赖: MailStore（数据）、Dialog（提示）、17TRACK 查询组件（index.html，可选）
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
      fNoHint: $('m-no-hint'),
      fNoRequired: $('m-no-required'),
      fFrom: $('m-from'),
      fTo: $('m-to'),
      fContent: $('m-content'),
      exportJsonBtn: $('btn-mail-export-json'),
      exportExcelBtn: $('btn-mail-export-excel'),
    };
  }

  // ============================================================
  // 发出日期：统一日历组件（js/calendar.js）
  // ============================================================
  /** 表单当前值：YYYY-MM-DD，空串表示还没选 */
  let dateValue = '';
  /** 当前选中 / 回填的年月日（空日期时停在今天） */
  let calY = 0, calM = 0, calD = 0;
  let cal = null;

  const pad2 = (n) => String(n).padStart(2, '0');

  function openCalendar() {
    if (!cal) return;
    cal.open({
      year: calY || undefined,
      month: calM || undefined,
      selected: dateValue ? { y: calY, m: calM, d: calD } : null,
      anchor: els.dateInput,
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

  // 单号查询改由 17TRACK 自带组件承载（见 index.html 的 #YQNum / doTrack()），
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
    updateMailNoHint();
  }

  // ============================================================
  // 邮件号码：扫码枪输入 + 即时校验
  // ------------------------------------------------------------
  // 扫码枪本质上是一个"打字很快的键盘"，会在末尾补一个回车。
  // 这里做三件事：
  //   1. 去掉空格 / 换行并转大写（扫描结果常带空白）；
  //   2. 用工具箱同一套 13 位信函条码算法即时校验，只提示不阻断；
  //   3. 回车不提交表单，而是把焦点交给「寄出地」，避免扫码后误保存。
  // ============================================================
  function validateMailNo(raw) {
    const text = String(raw == null ? '' : raw);
    if (typeof Tools !== 'undefined' && typeof Tools.validateLetterBarcode === 'function') {
      return Tools.validateLetterBarcode(text);
    }
    // 工具箱没加载时的兜底：只检查长度，不假装校验通过
    const code = text.replace(/\s+/g, '').toUpperCase();
    if (!code) return { ok: false, empty: true, message: '' };
    return {
      ok: code.length === 13,
      message: code.length === 13
        ? '长度为 13 位（未接入校验算法）'
        : `应为 13 位，当前 ${code.length} 位`,
    };
  }

  function updateMailNoHint() {
    if (!els || !els.fNoHint) return;
    const raw = els.fNo.value.trim();
    if (!raw) {
      els.fNoHint.style.display = 'none';
      els.fNoHint.textContent = '';
      els.fNoHint.className = 'mail-no-hint';
      return;
    }
    const res = validateMailNo(raw);
    els.fNoHint.style.display = 'block';
    els.fNoHint.textContent = (res.ok ? '✓ ' : '⚠ ') + (res.message || '');
    els.fNoHint.className = 'mail-no-hint ' + (res.ok ? 'is-ok' : 'is-warn');
  }

  function normalizeMailNoInput() {
    if (!els || !els.fNo) return;
    const cleaned = els.fNo.value.replace(/\s+/g, '').toUpperCase();
    if (els.fNo.value !== cleaned) els.fNo.value = cleaned;
    updateMailNoHint();
  }

  // ============================================================
  // 导出（当前状态的邮件；与「国际退信」的 JSON 备份口径一致）
  // ============================================================
  function exportHeaders() {
    return ['状态', '发出日期', '邮件种类', '邮件号码', '寄出地', '寄达地', '内容', '录入时间'];
  }

  function exportRows(list) {
    return list.map((r) => [
      MailStore.STATUS_LABEL[r.status] || r.status || '',
      r.sendDate || '',
      r.mailType || '',
      r.mailNo || '',
      r.fromPlace || '',
      r.toPlace || '',
      r.content || '',
      r.createdAt || '',
    ]);
  }

  function exportJson() {
    const list = MailStore.getByStatus(currentStatus);
    if (list.length === 0) { Dialog.alert('当前状态下暂无数据可导出'); return; }
    if (typeof ExportUtils === 'undefined') { Dialog.alert('导出组件未加载，请刷新页面'); return; }
    ExportUtils.downloadJson(
      `邮件-${MailStore.STATUS_LABEL[currentStatus]}-${ExportUtils.fileDate()}.json`,
      list
    );
  }

  function exportExcel() {
    const list = MailStore.getByStatus(currentStatus);
    if (list.length === 0) { Dialog.alert('当前状态下暂无数据可导出'); return; }
    if (typeof ExportUtils === 'undefined') { Dialog.alert('导出组件未加载，请刷新页面'); return; }
    try {
      ExportUtils.downloadXlsx(
        `邮件-${MailStore.STATUS_LABEL[currentStatus]}-${ExportUtils.fileDate()}.xlsx`,
        MailStore.STATUS_LABEL[currentStatus],
        exportHeaders(),
        exportRows(list)
      );
    } catch (e) {
      Dialog.alert('导出 Excel 失败: ' + e.message);
    }
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

    // 即时校验只是提示：号码格式不对时问一句，仍允许保存（历史数据 / 非标准单号）
    if (mailNo) {
      const check = validateMailNo(mailNo);
      if (!check.ok) {
        const go = await Dialog.confirm(
          `邮件号码「${mailNo}」校验未通过：\n${check.message || '格式不正确'}\n\n仍要保存吗？`
        );
        if (!go) { els.fNo.focus(); return; }
      }
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

    if (typeof CalendarPopup !== 'undefined' && CalendarPopup && CalendarPopup.create) {
      cal = CalendarPopup.create({
        popup: els.calPopup,
        title: els.calTitle,
        grid: els.calGrid,
        prev: els.calPrev,
        next: els.calNext,
        onPick: (y, m, d) => setDate(y, m, d),
      });
    }

    els.addBtn.addEventListener('click', () => openForm(null));
    els.search.addEventListener('input', () => {
      searchTerms[currentStatus] = els.search.value;
      render();
    });
    els.form.addEventListener('submit', submitForm);
    els.fType.addEventListener('change', syncTypeUI);

    // 扫码枪：去掉空白 + 即时校验；回车不提交表单，交给「寄出地」
    if (els.fNo) {
      els.fNo.addEventListener('input', normalizeMailNoInput);
      els.fNo.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        normalizeMailNoInput();
        els.fFrom.focus();
      });
    }

    if (els.exportJsonBtn) els.exportJsonBtn.addEventListener('click', exportJson);
    if (els.exportExcelBtn) els.exportExcelBtn.addEventListener('click', exportExcel);

    // 发出日期：日历弹窗（统一组件，含年历切换）
    els.dateInput.addEventListener('click', toggleCalendar);

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
