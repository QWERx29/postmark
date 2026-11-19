/**
 * 日历弹窗组件（全局统一）
 * =========================
 * 依赖: 无（纯 DOM）
 *
 * 录入日戳、邮资机戳、邮件、国际退信共用同一套日历交互：
 *   - 默认月历：翻月、点日；
 *   - 点标题或右上角「年历」切到年历：一次看到 12 个月，翻年、点月，
 *     再回到月历选日，跨年 / 跨月选择不用连点很多次；
 *   - 点外部自动收起，弹窗从 modal 里挪到 body 后会自动放回原位置。
 *
 * 用法:
 *   const cal = CalendarPopup.create({
 *     popup, title, grid, prev, next,
 *     onPick(y, m, d) { ... },          // 点中某一天
 *     onOpen(anchor) { ... },           // 可选
 *     onClose() { ... },                // 可选
 *   });
 *   cal.open({ selected: { y, m, d }, anchor: inputEl });
 *   cal.close();  cal.isOpen();
 */
(function () {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');

  function create(opts) {
    opts = opts || {};
    const popup = opts.popup;
    if (!popup) return null;
    // 同一个弹窗只创建一次：避免重复 init 时把翻月 / 点日监听器挂两遍
    if (popup.__calendarPopup) return popup.__calendarPopup;

    const title = opts.title || popup.querySelector('.cal-title');
    const grid = opts.grid || popup.querySelector('.cal-grid');
    const prev = opts.prev || popup.querySelector('.cal-prev');
    const next = opts.next || popup.querySelector('.cal-next');
    const dow = popup.querySelector('.cal-dow');
    if (!title || !grid || !prev || !next) return null;

    // 年历（12 个月）网格：由组件自己补，旧页面不用改弹窗标记
    let months = popup.querySelector('.cal-months');
    if (!months) {
      months = document.createElement('div');
      months.className = 'cal-months';
      months.hidden = true;
      grid.parentNode.insertBefore(months, grid.nextSibling);
    }

    // 「年历 / 月历」切换按钮，放在标题和「下个月」之间
    let viewBtn = popup.querySelector('.cal-view-toggle');
    if (!viewBtn) {
      viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'cal-view-toggle';
      viewBtn.title = '切换到年历';
      next.parentNode.insertBefore(viewBtn, next);
    }

    // 弹窗原来的位置：从 body 挪回来后要放回这里
    const home = popup.parentNode;

    /** 'day' = 月历，'month' = 年历（12 个月） */
    let mode = 'day';
    let viewY = 0;
    let viewM = 0;
    /** 已选日期；null 表示还没选 */
    let selected = null;
    /** 当前日期框（弹窗定位与 active 样式都跟着它） */
    let anchor = null;

    // ---- 渲染 ----

    function renderDays() {
      title.textContent = `${viewY}年${pad2(viewM)}月`;
      if (dow) dow.hidden = false;
      grid.hidden = false;
      months.hidden = true;
      viewBtn.textContent = '年历';
      viewBtn.title = '切换到年历，快速选择月份';

      const firstDow = new Date(viewY, viewM - 1, 1).getDay();
      const days = new Date(viewY, viewM, 0).getDate();
      const now = new Date();
      const cells = [];
      for (let i = 0; i < firstDow; i++) cells.push('<span></span>');
      for (let d = 1; d <= days; d++) {
        const isToday = viewY === now.getFullYear() && viewM === now.getMonth() + 1 && d === now.getDate();
        const isSel = !!selected && selected.y === viewY && selected.m === viewM && selected.d === d;
        const cls = (isToday ? ' cal-today' : '') + (isSel ? ' cal-sel' : '');
        cells.push(`<span class="cal-day${cls}" data-d="${d}">${d}</span>`);
      }
      grid.innerHTML = cells.join('');
    }

    function renderMonths() {
      title.textContent = `${viewY}年`;
      if (dow) dow.hidden = true;
      grid.hidden = true;
      months.hidden = false;
      viewBtn.textContent = '月历';
      viewBtn.title = '切换到月历';

      const now = new Date();
      const cells = [];
      for (let m = 1; m <= 12; m++) {
        const isCur = viewY === now.getFullYear() && m === now.getMonth() + 1;
        const isSel = !!selected && selected.y === viewY && selected.m === m;
        cells.push(
          `<button type="button" class="cal-month${isCur ? ' cal-month-cur' : ''}${isSel ? ' cal-month-sel' : ''}"` +
          ` data-m="${m}">${m}月</button>`
        );
      }
      months.innerHTML = cells.join('');
    }

    function render() {
      if (mode === 'day') renderDays();
      else renderMonths();
    }

    // ---- 定位 / 开关 ----

    function position() {
      popup.classList.add('active');
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const width = Math.max(rect.width, 272);
      // 先定宽再量高：宽度会改变换行，量出来的高度才准
      popup.style.width = width + 'px';
      const height = popup.offsetHeight || 320;

      let left = rect.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (left < 8) left = 8;

      let top = rect.bottom + 4;
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - height - 4);
      }

      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }

    /**
     * 打开日历。
     * @param {{selected?: {y:number,m:number,d:number}, year?:number, month?:number, anchor:Element}} o
     */
    function open(o) {
      o = o || {};
      const now = new Date();
      selected = o.selected || null;
      // 有选中日期时以它为准：即使调用方同时传了 year / month（可能是上一次
      // 打开时留下的旧值），视图也必须落在选中日期所在的月份，
      // 否则日历会显示成比记录早一个月的月份。
      viewY = (selected && selected.y) || o.year || now.getFullYear();
      viewM = (selected && selected.m) || o.month || now.getMonth() + 1;
      mode = 'day';

      if (anchor && anchor !== o.anchor) anchor.classList.remove('active');
      anchor = o.anchor || anchor;

      render();
      // 先挂到 body 再量高度：隐藏元素量不到 offsetHeight
      document.body.appendChild(popup);
      // onOpen 里可能会补标题 / 字段名，先让它改完再定位
      if (typeof opts.onOpen === 'function') opts.onOpen(anchor, popup);
      position();
      if (anchor) anchor.classList.add('active');
    }

    function close() {
      const wasActive = popup.classList.contains('active');
      popup.classList.remove('active');
      if (anchor) anchor.classList.remove('active');
      // 放回原位置，避免一直挂在 body 上
      if (popup.parentNode === document.body && home) home.appendChild(popup);
      if (wasActive && typeof opts.onClose === 'function') opts.onClose();
    }

    function isOpen() {
      return popup.classList.contains('active');
    }

    function toggle(o) {
      if (isOpen()) close();
      else open(o);
    }

    // ---- 操作 ----

    function pickDay(d) {
      selected = { y: viewY, m: viewM, d };
      render();
      if (typeof opts.onPick === 'function') opts.onPick(viewY, viewM, d);
      if (opts.closeOnPick !== false) close();
    }

    function shiftMonth(delta) {
      viewM += delta;
      if (viewM < 1) { viewM = 12; viewY--; }
      if (viewM > 12) { viewM = 1; viewY++; }
      render();
    }

    function toggleMode() {
      mode = mode === 'day' ? 'month' : 'day';
      render();
      // 年历和月历高度不同，切换后重新贴回日期框
      if (isOpen()) position();
    }

    // ---- 事件 ----

    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mode === 'day') shiftMonth(-1);
      else { viewY--; render(); }
    });

    next.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mode === 'day') shiftMonth(1);
      else { viewY++; render(); }
    });

    // 标题本身也可以点：月历 ↔ 年历
    title.classList.add('cal-title-toggle');
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
    title.title = '点击切换年历 / 月历';
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMode();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleMode();
    });

    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMode();
    });

    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day');
      if (!cell) return;
      pickDay(parseInt(cell.dataset.d, 10));
    });

    months.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-month');
      if (!cell) return;
      e.stopPropagation();
      viewM = parseInt(cell.dataset.m, 10);
      mode = 'day';
      render();
      if (isOpen()) position();
    });

    // 点击外部关闭：全局统一，各模块不再各写一份
    document.addEventListener('click', (e) => {
      if (!popup.classList.contains('active')) return;
      if (popup.contains(e.target)) return;
      if (anchor && anchor.contains(e.target)) return;
      close();
    });

    const api = {
      open,
      close,
      isOpen,
      toggle,
      render,
      getMode: () => mode,
    };
    popup.__calendarPopup = api;
    return api;
  }

  window.CalendarPopup = { create };
})();