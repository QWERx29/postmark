/**
 * 数据抓取页面 — 渲染进程
 * ========================
 * 通过主进程的本地 HTTP 接口驱动爬虫引擎：
 *   ① 爬取数据    POST /api/crawl/start {kind:'crawl', ...}
 *   ② 对比更新    POST /api/crawl/start {kind:'compare'} / {kind:'apply-base'}
 *   ③ 横向对比    POST /api/crawl/start {kind:'cross', ...}
 * 状态与日志通过 GET /api/crawl/status?job=&cursor= 轮询增量拉取。
 *
 * 参考库（PODatabase）**只在「对比」环节刷新**：抓取结束只是把数据写进 output，
 * 不动参考库。对比作业会顺带产出一份「应用后的 base 快照」（output/_refstage/，
 * 当前库已剔除带（撤销）标记的记录）加 base_old.csv 归档，这里把它们拉回来整份替换
 * 参考库 —— 于是「当前网点 + 历史归档」在确认更新 base 之前就能检索到。
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 轮询间隔（毫秒） */
  const POLL_MS = 400;
  /** 单个日志区保留的最大行数，避免长时间运行后 DOM 膨胀 */
  const MAX_LOG_LINES = 4000;

  /** 邮管局并发数：1~4 的整数，非法值回落到默认 2（与引擎的校验保持一致） */
  const SPB_CONCURRENCY_DEFAULT = 2;
  const SPB_CONCURRENCY_MAX = 4;

  function readSpbConcurrency() {
    const el = $('crawl-spb-concurrency');
    if (!el) return SPB_CONCURRENCY_DEFAULT;
    const n = Number(el.value);
    const v = Number.isFinite(n)
      ? Math.min(SPB_CONCURRENCY_MAX, Math.max(1, Math.floor(n)))
      : SPB_CONCURRENCY_DEFAULT;
    el.value = String(v);
    return v;
  }

  let provincesLoaded = false;
  /** /api/crawl/provinces 的结果 [{name, abbr, code}]，用于把 postbj 之类的前缀译成中文名 */
  let provinceList = [];
  let pollTimer = null;
  let activeJob = null;      // 当前正在轮询的作业
  let lastCrossResult = null; // 上一次横向对比结果，供「查看上次报告」重开弹窗

  // ============================================================
  // 通用：日志区
  // ============================================================

  function appendLog(el, lines) {
    if (!el || !lines || lines.length === 0) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent += (el.textContent ? '\n' : '') + lines.join('\n');

    // 超出上限时丢弃最早的行
    const all = el.textContent.split('\n');
    if (all.length > MAX_LOG_LINES) {
      el.textContent = all.slice(all.length - MAX_LOG_LINES).join('\n');
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
    updateLogHint(el, lines);
  }

  function clearLog(el) {
    if (!el) return;
    el.textContent = '';
    const ctl = logPanels.get(el);
    if (ctl && ctl.hint) ctl.hint.textContent = '';
  }

  function setStatus(el, text, color) {
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#888';
  }

  // ============================================================
  // 通用：折叠
  // ============================================================

  /**
   * 让 header 的点击切换 body 的显示，并在尾部加一个 ▸/▾ 指示。
   * 日志区与报告分段共用这一套交互。
   *
   * @param {HTMLElement} headerEl
   * @param {HTMLElement} bodyEl
   * @param {object} [opts]
   * @param {boolean} [opts.open]     初始是否展开
   * @param {string}  [opts.display]  展开时的 display 值（默认 block）
   * @param {Function} [opts.onExpand] 首次展开时回调（用于惰性构建内容）
   */
  function makeCollapsible(headerEl, bodyEl, opts) {
    const o = opts || {};
    const arrow = document.createElement('span');
    arrow.className = 'collapse-arrow';
    headerEl.appendChild(arrow);
    headerEl.classList.add('collapsible');

    let open = !!o.open;
    const apply = () => {
      bodyEl.style.display = open ? (o.display || 'block') : 'none';
      headerEl.classList.toggle('is-open', open);
      arrow.textContent = open ? '▾' : '▸';
    };
    apply();

    headerEl.addEventListener('click', (e) => {
      // 标题行里可能嵌着按钮（如省份的「全选」），点按钮不应触发展开
      if (e.target.closest('button')) return;
      open = !open;
      apply();
      if (open && o.onExpand) o.onExpand();
    });

    return {
      setOpen(v) { open = !!v; apply(); if (open && o.onExpand) o.onExpand(); },
      isOpen: () => open,
      arrow,
    };
  }

  /** 日志区 → 折叠控制器（用于同步标题上的「最新一行」提示） */
  const logPanels = new WeakMap();

  /** 把一段日志折叠起来，标题右侧显示行数与最新一行 */
  function registerLog(logEl) {
    const title = logEl.previousElementSibling;
    if (!title || !title.classList.contains('tool-section-title')) return;

    const hint = document.createElement('span');
    hint.className = 'log-hint';
    title.appendChild(hint);

    // 默认收起：长时间抓取时日志会很长，需要时点开即可
    const ctl = makeCollapsible(title, logEl, { open: false });
    ctl.hint = hint;
    logPanels.set(logEl, ctl);
  }

  /** 把最新一行日志摘要显示在折叠标题上，收起时也能看到进度 */
  function updateLogHint(el, lines) {
    const ctl = logPanels.get(el);
    if (!ctl || !ctl.hint) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = String(lines[i]).trim();
      if (!t) continue;
      ctl.hint.textContent = ' ' + (t.length > 60 ? t.slice(0, 60) + '…' : t);
      return;
    }
  }

  // ============================================================
  // 通用：作业轮询
  // ============================================================

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    activeJob = null;
  }

  /**
   * 启动作业并轮询到结束。
   * @param {object} cfg
   * @param {object} cfg.body         POST /api/crawl/start 的请求体
   * @param {HTMLElement} cfg.logEl   日志区
   * @param {HTMLElement} cfg.statusEl 状态文字
   * @param {Function} [cfg.onProgress] (progress) => void
   * @param {Function} [cfg.onDone]     (status) => void  作业结束（含失败/取消）
   */
  async function runJob(cfg) {
    stopPolling();
    clearLog(cfg.logEl);

    // 作业一开始就把日志摊开，收起状态下用户只看得到标题上的摘要
    const logCtl = logPanels.get(cfg.logEl);
    if (logCtl) logCtl.setOpen(true);

    let started;
    try {
      const res = await fetch('/api/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.body),
      });
      started = await res.json();
      if (!res.ok) throw new Error(started.error || ('HTTP ' + res.status));
    } catch (e) {
      setStatus(cfg.statusEl, '启动失败: ' + e.message, '#d93025');
      appendLog(cfg.logEl, ['[错误] 启动失败: ' + e.message]);
      if (cfg.onDone) cfg.onDone(null);
      return;
    }

    activeJob = { id: started.jobId, kind: started.kind, cfg };
    setStatus(cfg.statusEl, '运行中…', '#00991A');

    let cursor = 0;

    const tick = async () => {
      // 轮询期间用户可能已切走页面，作业仍在后台跑，这里只是停止刷新 UI
      if (!activeJob || activeJob.id !== started.jobId) return;

      let st;
      try {
        const res = await fetch(
          `/api/crawl/status?job=${encodeURIComponent(started.jobId)}&cursor=${cursor}`
        );
        if (res.status === 404) {
          setStatus(cfg.statusEl, '作业已过期', '#d93025');
          stopPolling();
          if (cfg.onDone) cfg.onDone(null);
          return;
        }
        st = await res.json();
      } catch (e) {
        // 网络抖动：稍后重试，不中断作业
        pollTimer = setTimeout(tick, POLL_MS * 2);
        return;
      }

      appendLog(cfg.logEl, st.lines);
      cursor = st.cursor;
      if (st.progress && cfg.onProgress) cfg.onProgress(st.progress);

      if (st.state === 'running') {
        pollTimer = setTimeout(tick, POLL_MS);
        return;
      }

      // 作业结束
      stopPolling();
      const elapsed = (st.elapsedMs / 1000).toFixed(1);
      if (st.state === 'done') {
        setStatus(cfg.statusEl, `完成（${elapsed}s）`, '#00991A');
      } else if (st.state === 'cancelled') {
        setStatus(cfg.statusEl, '已取消', '#fa8c16');
      } else {
        setStatus(cfg.statusEl, '失败: ' + (st.error || '未知错误'), '#d93025');
      }
      if (cfg.onDone) cfg.onDone(st);
    };

    tick();
  }

  async function cancelJob(statusEl) {
    if (!activeJob) return;
    const id = activeJob.id;
    setStatus(statusEl, '正在取消…', '#fa8c16');
    try {
      await fetch('/api/crawl/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: id }),
      });
    } catch (e) {
      setStatus(statusEl, '取消失败: ' + e.message, '#d93025');
    }
  }

  // ============================================================
  // 省份选择列表
  // ============================================================

  async function loadProvinces() {
    if (provincesLoaded) return;
    let list;
    try {
      const res = await fetch('/api/crawl/provinces');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      list = await res.json();
      provinceList = Array.isArray(list) ? list : [];
    } catch (e) {
      $('crawl-province-list').textContent = '省份列表加载失败: ' + e.message;
      return;
    }

    const crawlBox = $('crawl-province-list');
    const crossBox = $('cross-province-list');
    crawlBox.textContent = '';
    crossBox.textContent = '';

    for (const p of list) {
      // 爬取面板：默认全选
      const label = document.createElement('label');
      label.className = 'crawler-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.name;
      cb.checked = true;
      cb.dataset.role = 'crawl-province';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${p.name}`));
      crawlBox.appendChild(label);

      // 横向对比面板：默认全不选（留空=自动检测有数据的省份）
      const label2 = document.createElement('label');
      label2.className = 'crawler-check';
      const cb2 = document.createElement('input');
      cb2.type = 'checkbox';
      cb2.value = p.name;
      cb2.dataset.role = 'cross-province';
      label2.appendChild(cb2);
      label2.appendChild(document.createTextNode(` ${p.name}`));
      crossBox.appendChild(label2);
    }

    [$('crawl-province-list'), $('cross-province-list')].forEach(box => {
      box.addEventListener('change', updateProvinceCount);
    });
    updateProvinceCount();
    provincesLoaded = true;
  }

  function updateProvinceCount() {
    const crawlTotal = $('crawl-province-list').querySelectorAll('input').length;
    const n = getChecked('crawl-province').length;
    $('crawl-prov-count').textContent = `已选 ${n}/${crawlTotal}`;

    const crossN = getChecked('cross-province').length;
    $('cross-prov-count').textContent = crossN
      ? `已限定 ${crossN} 个省`
      : '未限定（自动扫描有数据的省份）';
  }

  function getChecked(role) {
    return Array.from(document.querySelectorAll(`input[data-role="${role}"]:checked`))
      .map(cb => cb.value);
  }

  function setAllProvinces(role, checked) {
    document.querySelectorAll(`input[data-role="${role}"]`).forEach(cb => {
      cb.checked = checked;
    });
    updateProvinceCount();
  }

  // ============================================================
  // 面板①：爬取数据
  // ============================================================

  function bindCrawlPanel() {
    const logEl = $('crawl-log');
    const statusEl = $('crawl-status');
    const startBtn = $('btn-crawl-start');
    const cancelBtn = $('btn-crawl-cancel');
    const progWrap = $('crawl-progress-wrap');
    const progFill = $('crawl-progress-fill');
    const progText = $('crawl-progress-text');

    $('crawl-prov-all').addEventListener('click', () => setAllProvinces('crawl-province', true));
    $('crawl-prov-none').addEventListener('click', () => setAllProvinces('crawl-province', false));

    // 并发数只对邮管局生效：没勾邮管局时置灰，避免误以为改了 POST 的节奏
    const concurrencyEl = $('crawl-spb-concurrency');
    const concurrencyHint = $('crawl-concurrency-hint');
    const syncConcurrencyState = () => {
      const on = $('crawl-src-spb').checked;
      if (concurrencyEl) concurrencyEl.disabled = !on;
      if (concurrencyHint) {
        concurrencyHint.textContent = on
          ? '仅作用于邮管局省份抓取；邮政官网始终串行'
          : '未选择邮管局，本项不生效';
      }
    };
    $('crawl-src-post').addEventListener('change', syncConcurrencyState);
    $('crawl-src-spb').addEventListener('change', syncConcurrencyState);
    syncConcurrencyState();

    cancelBtn.addEventListener('click', () => cancelJob(statusEl));

    startBtn.addEventListener('click', async () => {
      const doPost = $('crawl-src-post').checked;
      const doSpb = $('crawl-src-spb').checked;
      if (!doPost && !doSpb) {
        await Dialog.alert('请至少选择一个数据来源。');
        return;
      }
      const provinces = getChecked('crawl-province');
      if (provinces.length === 0) {
        await Dialog.alert('请至少选择一个省份。');
        return;
      }
      if (activeJob) {
        await Dialog.alert('已有作业正在运行，请先等待其结束或取消。');
        return;
      }

      startBtn.disabled = true;
      cancelBtn.disabled = false;
      progWrap.style.display = 'flex';
      progFill.style.width = '0%';
      progText.textContent = `0 / ${provinces.length}`;

      await runJob({
        body: {
          kind: 'crawl',
          provinces,
          doPost,
          doSpb,
          delay: Number($('crawl-delay').value) || 0,
          interDelay: Number($('crawl-inter-delay').value) || 0,
          spbConcurrency: readSpbConcurrency(),
        },
        logEl,
        statusEl,
        onProgress: (p) => {
          if (!p || !p.total) return;
          const pct = Math.round((p.done / p.total) * 100);
          progFill.style.width = pct + '%';
          progText.textContent = `${p.done} / ${p.total}${p.label ? ' — ' + p.label : ''}`;
        },
        onDone: async (st) => {
          startBtn.disabled = false;
          cancelBtn.disabled = true;
          if (st && st.state === 'done') {
            progFill.style.width = '100%';
            progText.textContent = `完成 — 邮政 ${st.result.totalPost} 条 / 邮管 ${st.result.totalSpb} 条`;
            await afterCrawl(st.result);
          } else {
            progText.textContent = st ? (st.state === 'cancelled' ? '已取消' : '失败') : '已中断';
          }
        },
      });
    });
  }

  /**
   * 抓取产生了新数据：上一次的对比结果与「确认更新 base」都不再对应当前 output，
   * 参考库也不会再跟着变，所以先把这两个入口关掉，逼用户重新对比一次。
   */
  function invalidateCompareState() {
    const applyBtn = $('btn-compare-apply');
    const viewBtn = $('btn-compare-view-report');
    if (applyBtn) applyBtn.disabled = true;
    if (viewBtn) viewBtn.disabled = true;
  }

  /**
   * 抓取完成的收尾。
   *
   * 参考库**不在这里刷新** —— 抓取只是把数据写进 output/。参考库要等
   * 「对比并更新 base」跑完对比，按更新方案（当前库 + base_old 归档）一并刷新。
   */
  async function afterCrawl(result) {
    if (!result || (!result.totalPost && !result.totalSpb)) {
      await Dialog.alert(
        '本次抓取没有获得任何数据，日志中可能有失败原因。\n' +
        '（提示：网络不通、该省份无备案数据、或被目标站点限流）'
      );
      return;
    }

    invalidateCompareState();
    appendLog($('crawl-log'), [
      '',
      `[提示] 数据已写入 output 目录（邮政 ${result.totalPost} 条 / 邮管 ${result.totalSpb} 条）。`,
      '[提示] 参考库不在这里刷新：请到「对比并更新 base」执行对比，比对时同步刷新。',
    ]);

    await Dialog.alert(
      `抓取完成：邮政官网 ${result.totalPost} 条 / 邮管局 ${result.totalSpb} 条。\n\n` +
      `数据已写入 output 目录，应用内参考库暂未更新。\n\n` +
      `请到「对比并更新 base」执行对比 —— 参考库会在对比完成时按更新方案刷新：\n` +
      `  · 当前库替换为本次 output 的数据（带（撤销）标记的不进当前库）\n` +
      `  · 名称变化前的旧名称 / 撤销 / 疑似撤下的记录转入 base_old 归档\n` +
      `  · 营业状态变化（暂停、装修中…）只覆盖原有内容`
    );
  }

  /**
   * 对比完成后刷新应用内参考库（爬取结束时不再做这一步）。
   *
   * 数据是主进程在对比时算好的：output/_refstage/ 下是「应用后的 base 快照」
   * （当前库，已剔除带（撤销）标记的记录）+ base_old.csv（历史归档）。
   * 这里把它们拉回渲染进程，整份替换 PODatabase。
   *
   * 失败只记日志、不弹窗：报告弹窗已经打开，不该再压一个模态上去。
   *
   * @param {object|null} refLibrary 作业结果里的 refLibrary
   * @returns {Promise<{current:number, history:number, imported:number}|null>}
   */
  async function refreshReference(refLibrary) {
    const statusEl = $('compare-status');
    const logEl = $('compare-log');

    // 没有快照就静默跳过：主进程已在作业日志里说明了原因（生成快照失败等），
    // 这里再补一行只会把「最新一行」的提示挤掉。
    if (!refLibrary || !Array.isArray(refLibrary.files) || refLibrary.files.length === 0) {
      return null;
    }

    setStatus(statusEl, '正在刷新参考库…', '#00991A');
    try {
      const buffers = [];
      for (const f of refLibrary.files) {
        try {
          const r = await fetch('/output/_refstage/' + encodeURIComponent(f.name));
          if (!r.ok) continue;
          buffers.push({ buffer: await r.arrayBuffer(), sourceType: f.sourceType, name: f.name });
        } catch (e) {
          appendLog(logEl, [`  [警告] 拉取 ${f.name} 失败: ${e.message}`]);
        }
      }
      if (buffers.length === 0) {
        setStatus(statusEl, '参考库快照拉取失败', '#d93025');
        appendLog(logEl, ['[参考库] 快照文件一个都没拉到，跳过刷新']);
        return null;
      }

      // 归档文件（快照目录里的 base_old.csv）；拉不到就按「没有归档」处理
      let archiveBuffer = null;
      if (refLibrary.archiveRelPath) {
        const url = '/output/' + String(refLibrary.archiveRelPath)
          .split('/').map(encodeURIComponent).join('/');
        try {
          const r = await fetch(url);
          if (r.ok) archiveBuffer = await r.arrayBuffer();
        } catch (e) {
          appendLog(logEl, [`  [警告] 拉取归档文件失败: ${e.message}`]);
        }
      }

      const result = await PODatabase.refreshFromCompare(buffers, archiveBuffer);

      // 参考库变了，刷新依赖它的 UI
      if (typeof Tools !== 'undefined') {
        Tools.refreshPOSearch();
        Tools.refreshRandomPO();
      }
      // 排名表的「总计」取自参考库里的邮政官网网点数，也要跟着重算
      if (typeof StatsView !== 'undefined' && typeof MapView !== 'undefined') {
        const level = MapView.getCurrentLevel();
        StatsView.update(level === 'province' ? 'nation' : 'city', MapView.getCurrentProvince());
      }

      const stats = PODatabase.getStats();
      const postCount = stats.provinces.reduce((s, p) => s + p.postCount, 0);
      const spbCount = stats.provinces.reduce((s, p) => s + p.spbCount, 0);
      const history = PODatabase.historyCount();

      appendLog(logEl, [
        '',
        `[参考库] 已按对比结果刷新：当前 ${stats.totalCount} 条（邮政 ${postCount} / 邮管 ${spbCount}）`,
        `[参考库] 历史归档 ${history} 条（base_old，检索时可勾选查看）`,
        `[参考库] 不进当前库的已撤销记录 ${refLibrary.revokedTotal || 0} 条`,
        result.errors.length ? `[参考库] 跳过 ${result.errors.length} 行（数据不完整或省份无法识别）` : '',
      ].filter(Boolean));

      setStatus(statusEl,
        `参考库已刷新（当前 ${stats.totalCount} 条 / 历史 ${history} 条）`, '#00991A');
      return { current: stats.totalCount, history, imported: result.imported };
    } catch (e) {
      setStatus(statusEl, '刷新参考库失败: ' + e.message, '#d93025');
      appendLog(logEl, ['[错误] 刷新参考库失败: ' + e.message]);
      return null;
    }
  }

  // ============================================================
  // 面板②：对比并更新 base
  // ============================================================

  function bindComparePanel() {
    const logEl = $('compare-log');
    const statusEl = $('compare-status');
    const startBtn = $('btn-compare-start');
    const applyBtn = $('btn-compare-apply');
    const viewReportBtn = $('btn-compare-view-report');
    const summaryEl = $('compare-summary');
    const summaryText = $('compare-summary-text');

    let lastCompareResult = null;

    // 弹窗关掉后仍能重开上一次的报告
    viewReportBtn.addEventListener('click', () => {
      if (lastCompareResult) {
        openReportModal(buildCompareSpec(lastCompareResult,
          lastCompareResult.canApply ? doApply : null));
      }
    });

    startBtn.addEventListener('click', async () => {
      if (activeJob) {
        await Dialog.alert('已有作业正在运行，请先等待其结束或取消。');
        return;
      }
      startBtn.disabled = true;
      applyBtn.disabled = true;
      viewReportBtn.disabled = true;
      summaryEl.style.display = 'none';
      lastCompareResult = null;

      await runJob({
        body: { kind: 'compare' },
        logEl,
        statusEl,
        onDone: async (st) => {
          startBtn.disabled = false;
          if (!st || st.state !== 'done') return;

          summaryEl.style.display = 'flex';
          summaryText.textContent =
            `对比 ${st.result.compared} 对 | 新增 ${st.result.added} | 缺失 ${st.result.missing}` +
            archiveSummaryText(st.result);

          // 对比结果改为弹窗展示；能更新 base 时，弹窗底部给出「确认更新 base」
          lastCompareResult = st.result;
          applyBtn.disabled = !st.result.canApply;
          viewReportBtn.disabled = false;
          openReportModal(buildCompareSpec(st.result, st.result.canApply ? doApply : null));

          // 参考库在「对比」这一步刷新（爬取结束后不再刷新）。
          // 弹窗先弹出来，刷新在后台继续，完成后把结果补到汇总行上。
          const lib = await refreshReference(st.result.refLibrary);
          if (lib) {
            summaryText.textContent +=
              ` | 参考库：当前 ${lib.current} 条 / 历史 ${lib.history} 条`;
          }
        },
      });
    });

    applyBtn.addEventListener('click', async () => {
      if (activeJob) {
        await Dialog.alert('已有作业正在运行，请先等待其结束或取消。');
        return;
      }
      if (!(await Dialog.confirm(
        '确定把 output 的内容更新到 base 目录？此操作不可撤销。\n\n' +
        '规则：当前库按 output 覆盖；涉及名称变化 / 撤销 / 疑似撤下的记录' +
        '转入 base/base_old.csv 归档；营业状态变化只覆盖原有内容。'
      ))) return;
      await doApply();
    });

    async function doApply() {
      applyBtn.disabled = true;
      startBtn.disabled = true;
      await runJob({
        body: { kind: 'apply-base' },
        logEl,
        statusEl,
        onDone: async (st) => {
          startBtn.disabled = false;
          if (!st || st.state !== 'done') return;
          applyBtn.disabled = true;
          summaryText.textContent = `base 已更新 ${st.result.updated} 个文件` +
            (st.result.archived ? ` | base_old 归档 ${st.result.archived} 条` : '');
          await Dialog.alert(
            `base 目录已更新：${st.result.updated} 个文件。\n\n` +
            (st.result.deleted.length ? `删除旧文件：${st.result.deleted.join('、')}\n\n` : '') +
            (st.result.archived
              ? `base_old 归档：${st.result.archived} 条` +
                `（本次新增 ${st.result.archiveAdded}` +
                (st.result.archiveRestored ? ` / 移出 ${st.result.archiveRestored}` : '') + '）\n' +
                `归档文件：${st.result.archivePath}\n\n`
              : '') +
            `参考库已在对比时刷新过；下次启动应用时会从 base 重新加载。`
          );
        },
      });
    }
  }

  /** 对比结果里的归档摘要（没有归档时返回空串） */
  function archiveSummaryText(result) {
    const p = result && result.plan;
    if (!p || !p.archiveTotal) return '';
    return ` | 归档 ${p.archiveTotal} 条（本次新增 ${p.archiveAdded}）`;
  }

  // ============================================================
  // 面板③：横向对比
  // ============================================================

  function bindCrossPanel() {
    const logEl = $('cross-log');
    const statusEl = $('cross-status');
    const startBtn = $('btn-cross-start');
    const cancelBtn = $('btn-cross-cancel');
    const fuzzyCb = $('cross-fuzzy');
    const fuzzyThreshold = $('cross-fuzzy-threshold');
    const viewReportBtn = $('btn-cross-view-report');

    fuzzyCb.addEventListener('change', () => {
      fuzzyThreshold.disabled = !fuzzyCb.checked;
    });

    $('cross-prov-all').addEventListener('click', () => setAllProvinces('cross-province', true));
    $('cross-prov-none').addEventListener('click', () => setAllProvinces('cross-province', false));

    cancelBtn.addEventListener('click', () => cancelJob(statusEl));

    // 弹窗关掉后仍能重开上一次的报告
    viewReportBtn.addEventListener('click', () => {
      if (lastCrossResult) openReportModal(buildCrossSpec(lastCrossResult));
    });

    startBtn.addEventListener('click', async () => {
      if (activeJob) {
        await Dialog.alert('已有作业正在运行，请先等待其结束或取消。');
        return;
      }

      const dir = document.querySelector('input[name="cross-dir"]:checked').value;
      const provinces = getChecked('cross-province');
      const useBase = dir === 'base';

      startBtn.disabled = true;
      cancelBtn.disabled = false;

      await runJob({
        body: {
          kind: 'cross',
          useBase,
          provinces,
          enableFuzzy: fuzzyCb.checked,
          fuzzyThreshold: Number(fuzzyThreshold.value) || 0.8,
        },
        logEl,
        statusEl,
        onDone: async (st) => {
          startBtn.disabled = false;
          cancelBtn.disabled = true;
          if (!st || st.state !== 'done') return;

          const r = st.result;
          if (!r.provinceCount) {
            await Dialog.alert(
              '没有找到同时具备 POST 和 SPB 数据的省份，无法横向对比。\n\n' +
              `数据目录：${r.dataDir}\n` +
              '请先抓取两个数据源的数据，或换用另一个数据目录。'
            );
            return;
          }

          lastCrossResult = r;
          viewReportBtn.disabled = false;
          openReportModal(buildCrossSpec(r));
        },
      });
    });
  }

  function renderCrossSummary(container, result) {
    container.textContent = '';
    const table = document.createElement('table');
    table.className = 'crawler-table';

    const head = document.createElement('tr');
    ['省份', '邮政', '邮管', '匹配', '匹配率', '邮政独有', '邮管独有'].forEach((t, i) => {
      const th = document.createElement('th');
      th.textContent = t;
      if (i > 0) th.style.textAlign = 'right';
      head.appendChild(th);
    });
    table.appendChild(head);

    for (const s of result.summary) {
      const tr = document.createElement('tr');
      const cells = [
        s.province,
        s.postCount, s.spbCount, s.matchCount,
        s.matchRate.toFixed(1) + '%',
        s.postOnly, s.spbOnly,
      ];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i > 0) td.style.textAlign = 'right';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }

    if (result.summary.length > 1) {
      const tr = document.createElement('tr');
      tr.className = 'crawler-table-total';
      const g = result.grand;
      const rate = g.postTotal ? ((g.match / g.postTotal) * 100).toFixed(1) + '%' : 'N/A';
      ['合计', g.postTotal, g.spbTotal, g.match, rate,
       g.postTotal - g.match, g.spbTotal - g.match].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i > 0) td.style.textAlign = 'right';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }

    container.appendChild(table);
  }

  // ============================================================
  // 报告弹窗
  // ============================================================
  // 两份报告（智能比较 = output vs base 的 txt_compare 结果；
  // 横向对比 = 同省 POST vs SPB 的多阶匹配）都用同一套弹窗渲染：
  // 顶部汇总卡片 + 可逐段折叠的明细表格，样式参考 webui.py。

  /** 当前打开的报告弹窗（同时只允许一个） */
  let reportModal = null;

  function closeReportModal() {
    if (!reportModal) return false;
    document.removeEventListener('keydown', reportModal.onKey);
    reportModal.overlay.remove();
    document.body.style.overflow = '';
    reportModal = null;
    return true;
  }

  /**
   * 打开报告弹窗。
   * @param {object} spec
   * @param {string} spec.title
   * @param {string} [spec.subtitle]
   * @param {HTMLElement} spec.body
   * @param {Array<{label:string, primary?:boolean, onClick?:Function}>} [spec.buttons]
   *        按钮点击后默认关闭弹窗
   */
  function openReportModal(spec) {
    closeReportModal();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay report-modal';

    const box = document.createElement('div');
    box.className = 'modal-container';

    // ── 标题栏 ──
    const head = document.createElement('div');
    head.className = 'rm-head';

    const titleBox = document.createElement('div');
    titleBox.className = 'rm-head-text';
    const h = document.createElement('h3');
    h.textContent = spec.title;
    titleBox.appendChild(h);
    if (spec.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'rm-subtitle';
      sub.textContent = spec.subtitle;
      titleBox.appendChild(sub);
    }
    head.appendChild(titleBox);

    const closeX = document.createElement('button');
    closeX.type = 'button';
    closeX.className = 'rm-close';
    closeX.textContent = '×';
    closeX.title = '关闭 (Esc)';
    closeX.setAttribute('aria-label', '关闭');
    closeX.addEventListener('click', () => closeReportModal());
    head.appendChild(closeX);
    box.appendChild(head);

    // ── 正文 ──
    const bodyEl = document.createElement('div');
    bodyEl.className = 'rm-body';
    bodyEl.appendChild(spec.body);
    box.appendChild(bodyEl);

    // ── 底部按钮 ──
    const foot = document.createElement('div');
    foot.className = 'rm-actions';
    // 「关闭」放最左，业务按钮（确认更新 base）留在最右的主操作位
    const buttons = [{ label: '关闭' }].concat(spec.buttons || []);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.primary ? 'btn-primary' : 'btn-secondary';
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        closeReportModal();
        if (b.onClick) b.onClick();
      });
      foot.appendChild(btn);
    }
    box.appendChild(foot);

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeReportModal();
    });

    document.body.appendChild(overlay);
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Esc 关闭。注意 app.js 也监听 document 的 keydown，
    // 它通过 CrawlerPage.closeReport() 的返回值决定是否继续隐藏页面。
    const onKey = (e) => {
      if (e.key === 'Escape') closeReportModal();
    };
    document.addEventListener('keydown', onKey);

    reportModal = { overlay, onKey };
  }

  // ---- 省份下拉框 ----
  // 报告弹窗顶部用下拉框选省份，未选择时只留概览卡片。
  // 详情在 change 时才建 DOM —— 弹窗刚打开时（全国 62 个文件对）不必付出任何渲染成本。

  /** abbr → 中文省名；省份表还没加载回来时退回缩写本身 */
  function provinceName(abbr) {
    const hit = provinceList.find((p) => p.abbr === abbr);
    return hit ? hit.name : abbr;
  }

  /** 数据源的中文名（与索引顺序一致：邮政 vs 邮管） */
  const SOURCE_LABEL = { post: '邮政', spb: '邮管' };

  /** `postbj` → 「北京 · 邮政」，认不出的前缀原样返回 */
  function prefixLabel(prefix) {
    const m = /^(post|spb)(.+)$/.exec(String(prefix || ''));
    if (!m) return String(prefix || '');
    return `${provinceName(m[2])} · ${SOURCE_LABEL[m[1]]}`;
  }

  /**
   * 下拉框 + 详情容器。
   * @param {string} labelText 下拉框左侧的说明文字
   * @param {Array<{value:string, label:string}>} options 首项由本函数补「— 请选择 —」占位
   * @param {(value:string)=>HTMLElement} onPick 选中后生成详情；只在非空选项时调用
   */
  function makeSelector(labelText, options, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-selector-wrap';

    const bar = document.createElement('div');
    bar.className = 'rm-selector-bar';

    const label = document.createElement('label');
    label.textContent = labelText;
    bar.appendChild(label);

    const sel = document.createElement('select');
    sel.className = 'form-select';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— 请选择 —';
    sel.appendChild(placeholder);

    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;     // textContent：省份名来自抓取数据
      sel.appendChild(opt);
    }
    bar.appendChild(sel);
    wrap.appendChild(bar);

    const detail = document.createElement('div');
    detail.className = 'rm-selector-detail';
    wrap.appendChild(detail);

    sel.addEventListener('change', () => {
      detail.textContent = '';       // 换省份时先清空上一次的详情
      if (!sel.value) return;
      const box = onPick(sel.value);
      if (box) detail.appendChild(box);
    });

    wrap._select = sel;              // 供测试直接取值/触发
    return wrap;
  }

  /** 表格：所有单元格一律 textContent 赋值，抓取来的网点名不会当 HTML 解析 */
  function makeTable(columns, rows, footNote) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-table-wrap';

    const table = document.createElement('table');
    table.className = 'crawler-table rm-table';

    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      for (const cell of r) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (footNote) {
      const f = document.createElement('p');
      f.className = 'rm-footnote';
      f.textContent = footNote;
      wrap.appendChild(f);
    }
    return wrap;
  }

  // 内联展示的文本上限。整份对比报告可能几十 MB（全国 62 个文件的一对一
  // 差异明细实测 29.5 MB / 40 万行），全量塞进一个文本节点会把渲染进程卡死，
  // 所以只渲染开头，完整内容引导用户去看落盘的报告文件。
  const MAX_PRE_CHARS = 512 * 1024;
  const MAX_PRE_LINES = 3000;

  /**
   * 等宽文本块（txt_compare 输出、报告全文）。
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.path] 完整报告落盘路径，用于截断提示
   */
  function makePre(text, opts) {
    const o = opts || {};
    const raw = String(text == null ? '' : text);

    // 先按字符数粗切再找最后一个换行，避免为了数行号就把几十 MB 切成几十万个数组项
    let body = raw;
    let truncated = false;
    if (raw.length > MAX_PRE_CHARS) {
      body = raw.slice(0, MAX_PRE_CHARS);
      const nl = body.lastIndexOf('\n');
      if (nl > 0) body = body.slice(0, nl);
      truncated = true;
    }

    let shownLines = body ? body.split('\n').length : 0;
    if (shownLines > MAX_PRE_LINES) {
      body = body.split('\n').slice(0, MAX_PRE_LINES).join('\n');
      shownLines = MAX_PRE_LINES;
      truncated = true;
    }

    const wrap = document.createElement('div');

    const pre = document.createElement('pre');
    pre.className = 'crawler-log rm-pre';
    pre.textContent = body;
    wrap.appendChild(pre);

    if (truncated) {
      const note = document.createElement('p');
      note.className = 'rm-footnote';
      note.textContent =
        `内容过长（共 ${(raw.length / 1048576).toFixed(1)} MB），此处只显示前 ${shownLines} 行。` +
        (o.path ? `完整报告见 ${o.path}` : '完整报告见上方标题栏里的落盘路径。');
      wrap.appendChild(note);
    }

    return wrap;
  }

  /** 顶部数字卡片行 */
  function makeCards(items) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-cards';
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'rm-card';
      const v = document.createElement('div');
      v.className = 'rm-card-value';
      v.textContent = it.value;
      if (it.color) v.style.color = it.color;
      const l = document.createElement('div');
      l.className = 'rm-card-label';
      l.textContent = it.label;
      card.appendChild(v);
      card.appendChild(l);
      wrap.appendChild(card);
    }
    return wrap;
  }

  /** 正文里的小标题 */
  function makeHeading(text) {
    const el = document.createElement('div');
    el.className = 'rm-heading';
    el.textContent = text;
    return el;
  }

  /**
   * 标签页：标签栏 + 内容区。
   *
   * 每个标签的内容惰性构建（报告全文可能几十 MB，一开弹窗就全建出来会卡死），
   * 构建后留在 DOM 里，切换只是显隐 —— 来回切不会丢展开状态、也不会重建表格。
   *
   * @param {Array<{key:string, label:string, build:function():HTMLElement}>} tabs
   * @returns {HTMLElement} 元素上挂 _select(key) / _active()，供程序与测试切换
   */
  function makeTabs(tabs) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-tabs';

    const bar = document.createElement('div');
    bar.className = 'rm-tab-bar';
    const panels = document.createElement('div');
    panels.className = 'rm-tab-panels';

    const items = tabs.map((t, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rm-tab';
      btn.textContent = t.label;
      btn.addEventListener('click', () => select(t.key));
      bar.appendChild(btn);

      const panel = document.createElement('div');
      panel.className = 'rm-tab-panel';
      panels.appendChild(panel);

      return { key: t.key == null ? String(i) : t.key, build: t.build, btn, panel, built: false };
    });

    let activeKey = null;

    /** 切到某个标签（不存在则退回第一个），返回它的内容面板 */
    function select(key) {
      const item = items.filter((x) => x.key === key)[0] || items[0];
      if (!item) return null;

      if (!item.built) {
        item.built = true;
        const box = item.build();
        if (box) item.panel.appendChild(box);
      }

      activeKey = item.key;
      for (const x of items) {
        const on = x === item;
        x.panel.style.display = on ? 'block' : 'none';
        x.btn.classList.toggle('is-active', on);
      }
      return item.panel;
    }

    wrap.appendChild(bar);
    wrap.appendChild(panels);
    wrap._select = select;
    wrap._active = () => activeKey;
    select(items.length ? items[0].key : null);
    return wrap;
  }

  /**
   * 报告里的一段：可折叠标题 + 内容。
   * body 由 build() 惰性生成——多省报告分段极多，一次性建 DOM 会很慢。
   */
  function makeSection(spec) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-section';

    const header = document.createElement('div');
    header.className = 'rm-sec-header';
    if (spec.badge) {
      const b = document.createElement('span');
      b.className = 'rm-badge ' + (spec.badgeClass || '');
      b.textContent = spec.badge;
      header.appendChild(b);
    }
    const strong = document.createElement('strong');
    strong.textContent = spec.title;
    header.appendChild(strong);
    if (spec.count) {
      const c = document.createElement('span');
      c.className = 'rm-count';
      c.textContent = spec.count;
      header.appendChild(c);
    }
    if (spec.desc) {
      const d = document.createElement('small');
      d.className = 'rm-desc';
      d.textContent = spec.desc;
      header.appendChild(d);
    }
    wrap.appendChild(header);

    const body = document.createElement('div');
    body.className = 'rm-sec-body';
    wrap.appendChild(body);

    let built = false;
    const buildOnce = () => {
      if (built) return;
      built = true;
      body.appendChild(spec.build());
    };

    const ctl = makeCollapsible(header, body, {
      open: !!spec.open,
      onExpand: buildOnce,
    });
    if (spec.open) buildOnce();   // 初始展开时 onExpand 不会被触发，这里补上
    wrap._ctl = ctl;

    return wrap;
  }

  // ---- 横向对比：各匹配桶的展示定义 ----
  /** 每个桶的列定义与取值方式，顺序即展示顺序 */
  const CROSS_BUCKETS = [
    {
      key: 'exact', badge: '精确匹配', cls: 'rm-badge-ok',
      desc: '双方原始名称完全一致',
      cols: ['POST 名称', 'SPB 名称', '区县', '邮编'],
      row: (r) => [r.postName, r.spbName, r.district, r.postcode],
    },
    {
      key: 'normalized', badge: '归一化匹配', cls: 'rm-badge-norm',
      desc: '剥离前缀后缀后名称一致',
      cols: ['POST 名称', 'SPB 名称', '区县', '邮编'],
      row: (r) => [r.postName, r.spbName, r.district, r.postcode],
    },
    {
      key: 'suspected', badge: '疑似匹配', cls: 'rm-badge-suspect',
      desc: '存在公共中文字串，需人工确认',
      cols: ['公共字串', 'POST 名称', 'SPB 名称', '区县', '邮编'],
      row: (r) => [r.common, r.postName, r.spbName, r.district, r.postcode],
    },
    {
      key: 'fuzzy', badge: '模糊匹配', cls: 'rm-badge-fuzzy',
      desc: '相似度达到阈值，需人工确认',
      cols: ['相似度', 'POST 名称', 'SPB 名称', '区县'],
      row: (r) => [Number(r.ratio).toFixed(3), r.postName, r.spbName, r.district],
    },
    {
      key: 'crossDistrict', badge: '跨区县匹配', cls: 'rm-badge-cross',
      desc: '区县不同，不计入匹配，仅供参考',
      cols: ['方法', 'POST 名称', 'SPB 名称', 'POST 区县', 'SPB 区县', '邮编'],
      row: (r) => [r.method, r.postName, r.spbName, r.postDistrict, r.spbDistrict, r.postcode],
    },
  ];

  /** 单个省份的逐桶明细 */
  function buildProvinceDetail(d) {
    const frag = document.createDocumentFragment();
    const counts = d.counts || {};
    const buckets = d.buckets || {};

    for (const def of CROSS_BUCKETS) {
      const rows = buckets[def.key] || [];
      const total = counts[def.key] || 0;
      if (!total) continue;
      frag.appendChild(makeSection({
        badge: def.badge,
        badgeClass: def.cls,
        title: `${rows.length} 条`,
        desc: def.desc,
        open: def.key === 'normalized' || def.key === 'suspected',  // 需人工看的默认展开
        build: () => makeTable(
          def.cols,
          rows.map(def.row),
          total > rows.length ? `还有 ${total - rows.length} 条未在此列出，完整内容见下方「完整报告文本」。` : ''
        ),
      }));
    }

    // 仅 POST / 仅 SPB：按区县对齐成左右对照
    const nPostOnly = counts.postOnly || 0;
    const nSpbOnly = counts.spbOnly || 0;
    if (nPostOnly || nSpbOnly) {
      frag.appendChild(makeSection({
        badge: '仅单边',
        badgeClass: 'rm-badge-warn',
        title: `${nPostOnly} / ${nSpbOnly} 条`,
        desc: '按区县对齐，左右对照',
        open: true,
        build: () => buildUnmatched(buckets.postOnly || [], buckets.spbOnly || [],
                                   nPostOnly, nSpbOnly),
      }));
    }

    return frag;
  }

  /** 把 postOnly 与 spbOnly 按区县分组后左右并排，便于一眼看出哪边缺 */
  function buildUnmatched(postOnly, spbOnly, totalPost, totalSpb) {
    const groupBy = (list) => {
      const m = new Map();
      for (const r of list) {
        const k = r.district || '(未知区县)';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const pm = groupBy(postOnly);
    const sm = groupBy(spbOnly);
    const districts = Array.from(new Set([...pm.keys(), ...sm.keys()])).sort();

    const rows = [];
    for (const dist of districts) {
      const pl = pm.get(dist) || [];
      const sl = sm.get(dist) || [];
      for (let i = 0; i < Math.max(pl.length, sl.length); i++) {
        rows.push([
          dist,
          pl[i] ? pl[i].name : '',
          pl[i] ? pl[i].postcode : '',
          sl[i] ? sl[i].name : '',
        ]);
      }
    }

    const truncated = totalPost > postOnly.length || totalSpb > spbOnly.length;
    return makeTable(
      ['区县', '仅 POST 名称', '邮编', '仅 SPB 名称'],
      rows,
      truncated ? '该省单边记录过多，此处仅列出前若干条，完整内容见下方「完整报告文本」。' : ''
    );
  }

  /** 横向对比下拉框里「汇总表」选项的取值 —— 省份缩写不会长这样，不会撞 */
  const SUMMARY_KEY = '__summary__';

  /** 横向对比报告弹窗 */
  function buildCrossSpec(result) {
    const body = document.createElement('div');
    const g = result.grand || {};
    const rate = g.postTotal ? ((g.match / g.postTotal) * 100).toFixed(1) + '%' : 'N/A';

    body.appendChild(makeCards([
      { label: 'POST 记录', value: g.postTotal || 0, color: '#0d6efd' },
      { label: 'SPB 记录', value: g.spbTotal || 0, color: '#198754' },
      { label: '匹配总计', value: g.match || 0, color: '#28a745' },
      { label: '匹配率', value: rate, color: '#28a745' },
      { label: '仅 POST', value: (g.postTotal || 0) - (g.match || 0), color: '#fa8c16' },
      { label: '仅 SPB', value: (g.spbTotal || 0) - (g.match || 0), color: '#0dcaf0' },
    ]));

    // ── 选省看详情（不选时只剩上面的概览卡片）──
    const details = result.details || [];
    const byAbbr = new Map((result.summary || []).map((s) => [s.abbr, s]));
    const nProv = Math.max((result.summary || []).length, details.length);
    if (nProv) {
      const options = [];
      // 多省时给一个「汇总表」入口 —— 它就是原先那张一次性铺开的表
      if (nProv > 1) options.push({ value: SUMMARY_KEY, label: '汇总表' });
      for (const d of details) {
        const s = byAbbr.get(d.abbr) || {};
        options.push({
          value: d.abbr,
          label: `${d.province}（${s.matchCount || 0}/${s.postCount || 0}）`,
        });
      }
      body.appendChild(makeSelector('选择省份：', options, (value) => {
        const box = document.createElement('div');
        if (value === SUMMARY_KEY) {
          box.appendChild(makeHeading('多省汇总'));
          // renderCrossSummary 会先清空容器，所以给它一个独立的子节点
          const table = document.createElement('div');
          renderCrossSummary(table, result);
          box.appendChild(table);
          return box;
        }
        const d = details.find((x) => String(x.abbr) === value);
        if (!d) return box;
        const s = byAbbr.get(d.abbr) || {};
        box.appendChild(makeHeading(
          `${d.province} · POST ${s.postCount || 0} 条 / SPB ${s.spbCount || 0} 条`));
        box.appendChild(buildProvinceDetail(d));
        return box;
      }));
    }

    // ── 完整报告 ──
    body.appendChild(makeSection({
      badge: '报告',
      badgeClass: 'rm-badge-prov',
      title: '完整报告文本',
      desc: '未经裁剪的原始报告，可复制留档',
      open: false,
      build: () => makePre(result.reportText || '（报告为空）', { path: result.reportPath }),
    }));

    return {
      title: '横向对比报告',
      subtitle:
        `${result.provinceCount} 个省份 · 数据目录 ${result.dataDir}` +
        (result.reportPath ? ` · 报告已存至 ${result.reportPath}` : ' · 报告未能落盘'),
      body,
      buttons: [],   // 只有「关闭」
    };
  }

  // ---- 智能比较（output vs base）----

  const COMPARE_STATUS = {
    compared: { label: '已对比', cls: 'rm-badge-ok' },
    new: { label: '新增（base 中无）', cls: 'rm-badge-post' },
    missing: { label: '缺失（output 中无）', cls: 'rm-badge-warn' },
    error: { label: '对比失败', cls: 'rm-badge-fuzzy' },
  };

  // ---- 智能判别（对应 crawler.py 的 intelligent_compare）----

  const INTELLIGENT_LEVEL_CN = { exact: '精确', suspected: '疑似', postcode: '邮编' };

  /**
   * 每类字段变化在弹窗里怎么展示。表头与取值方式照抄 crawler.py
   * `_generate_intelligent_report` 的对应段落，所以弹窗里的表格与落盘的
   * intelligent_report_*.txt 是同一份内容。
   *
   * cats 是「命中就归入本视图」的类别集合；区划变化(市)/(区县) 合并成一个视图，
   * 与原报告一致（一条记录即使两种都变也只出一行，区县优先）。
   *
   * 例外：详情链接变化。原报告只在类别统计里计数、没有明细段，但汇总卡片会显示
   * 「详情链接变化 N」，不给明细用户就没法知道是哪几条，所以这里补了张表。
   */
  const INTELLIGENT_VIEWS = [
    {
      cats: ['名称变化'],
      title: '名称变化',
      columns: ['区县', '旧名称', '新名称', '邮编', '匹配方式'],
      row: (c) => [
        c.rec1.district, c.details.name_old, c.details.name_new,
        c.rec1.postcode, INTELLIGENT_LEVEL_CN[c.matchLevel] || c.matchLevel,
      ],
    },
    {
      cats: ['邮编变化'],
      title: '邮编变化',
      columns: ['区县', '网点名称', '旧邮编', '新邮编'],
      row: (c) => [c.rec1.district, c.rec1.name, c.details.postcode_old, c.details.postcode_new],
    },
    {
      cats: ['地址变化'],
      title: '地址变化',
      columns: ['区县', '网点名称', '旧地址', '新地址'],
      row: (c) => [c.rec1.district, c.rec1.name, c.details.address_old, c.details.address_new],
    },
    {
      cats: ['区划变化(市)', '区划变化(区县)'],
      title: '区划变化',
      columns: ['网点名称', '旧区划', '新区划', '类型'],
      row: (c) => (c.categories.indexOf('区划变化(区县)') >= 0
        ? [c.rec1.name, c.details.district_old, c.details.district_new, '区县变化']
        : [c.rec1.name, c.details.city_old, c.details.city_new, '地市变化']),
    },
    {
      cats: ['营业状态变化'],
      title: '营业状态变化',
      columns: ['区县', '网点名称', '旧状态', '新状态', '邮编'],
      row: (c) => [
        c.rec1.district, c.rec1.name,
        c.details.status_old, c.details.status_new, c.rec1.postcode,
      ],
    },
    {
      cats: ['开办业务变化'],
      title: '开办业务变化',
      columns: ['区县', '网点名称', '旧业务', '新业务'],
      row: (c) => [c.rec1.district, c.rec1.name, c.details.services_old, c.details.services_new],
    },
    {
      cats: ['详情链接变化'],
      title: '详情链接变化',
      columns: ['区县', '网点名称', '旧链接', '新链接'],
      row: (c) => [c.rec1.district, c.rec1.name, c.details.link_old, c.details.link_new],
    },
  ];

  /** 变化类别在弹窗卡片里的呈现顺序与配色 */
  const INTELLIGENT_CARDS = [
    { key: '名称变化', color: '#0d6efd' },
    { key: '邮编变化', color: '#0d6efd' },
    { key: '地址变化', color: '#0d6efd' },
    { key: '区划变化', color: '#6f42c1', merge: ['区划变化(市)', '区划变化(区县)'] },
    { key: '营业状态变化', color: '#fa8c16' },
    { key: '开办业务变化', color: '#0d6efd' },
    { key: '详情链接变化', color: '#6c757d' },
  ];

  /** 弹窗顶部的汇总卡片：把所有源文件对的各类变化加起来 */
  function buildIntelligentCards(list) {
    const countCat = (cat) => list.reduce(
      (n, p) => n + (((p.summary || {}).byCategory || {})[cat] || 0), 0);
    const countSum = (key) => list.reduce((n, p) => n + ((p.summary || {})[key] || 0), 0);
    /** 条目顶层的计数字段（如 ignoredNew，不在 summary 里） */
    const countTop = (key) => list.reduce((n, p) => n + (p[key] || 0), 0);

    const items = [];
    for (const c of INTELLIGENT_CARDS) {
      const n = c.merge
        ? c.merge.reduce((sum, k) => sum + countCat(k), 0)
        : countCat(c.key);
      if (n) items.push({ label: c.key, value: n, color: c.color });
    }

    const added = countSum('new');
    const removed = countSum('removed');
    const blocks = countSum('blocks');
    const comprehensive = countSum('comprehensive');
    const ignoredNew = countTop('ignoredNew');
    if (added) items.push({ label: '疑似新增', value: added, color: '#28a745' });
    if (removed) items.push({ label: '疑似撤下', value: removed, color: '#fa8c16' });
    if (blocks) items.push({ label: '连续变化区块', value: blocks, color: '#6c757d' });
    if (comprehensive) items.push({ label: '⚠综合变化', value: comprehensive, color: '#d93026' });
    if (ignoredNew) items.push({ label: '已归档撤销(不计新增)', value: ignoredNew, color: '#6c757d' });

    if (!items.length) items.push({ label: '两份数据完全一致', value: '✓', color: '#28a745' });
    return makeCards(items);
  }

  /**
   * 某个源文件对的判别明细：各类变化表 + 疑似新增/撤下 + 连续变化区块。
   * 每次调用都新建节点 —— makeSection 的 build 是惰性的，折叠时不建 DOM。
   */
  function buildIntelligentDetail(p) {
    const nodes = [];
    const changes = p.changes || [];

    // 明细被裁剪过时要说清楚，否则用户会以为变化只有这么多
    const note = (shown, total) => (shown < total
      ? `共 ${total} 条，此处只列前 ${shown} 条（完整内容见下方的报告全文）`
      : '');

    for (const view of INTELLIGENT_VIEWS) {
      const hit = changes.filter(
        (c) => (c.categories || []).some((cat) => view.cats.indexOf(cat) >= 0));
      if (!hit.length) continue;

      const total = view.cats.reduce(
        (n, cat) => n + (((p.summary || {}).byCategory || {})[cat] || 0), 0);
      nodes.push(makeHeading(view.title));
      nodes.push(makeTable(view.columns, hit.map(view.row), note(hit.length, total)));
    }

    // 疑似新增 / 疑似撤下。
    // unmatched 里的元素是 [行号, 记录] 二元组（与 crawler.py 的元组一致），取 [1]。
    const unmatchedTable = (title, list, total) => {
      if (!list.length) return;
      nodes.push(makeHeading(title));
      nodes.push(makeTable(
        ['区县', '网点名称', '邮编'],
        list.map((u) => {
          const r = u[1] || {};
          return [r.district || r.city || '未知', r.name, r.postcode || r.detail_link || ''];
        }),
        note(list.length, total)
      ));
    };
    unmatchedTable('疑似新增网点', p.unmatched1 || [], (p.summary || {}).new || 0);
    unmatchedTable('疑似撤下网点', p.unmatched2 || [], (p.summary || {}).removed || 0);

    // 带「撤销」字样、已在 base_old 历史库里的记录不计入新增，但要把数量说清楚，
    // 否则用户会疑惑「output 里明明有这条，为什么新增里没有」。
    const ignoredNew = p.ignoredNew || 0;
    if (ignoredNew) {
      const noteEl = document.createElement('p');
      noteEl.className = 'rm-footnote';
      noteEl.textContent =
        `另有 ${ignoredNew} 条带「撤销」字样的记录已在 base_old 历史库中，` +
        '不计入新增网点。';
      nodes.push(noteEl);
    }

    // 连续变化区块
    const blocks = p.blocks || [];
    if (blocks.length) {
      nodes.push(makeHeading(`连续变化区块（${blocks.length} 个）`));
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        nodes.push(makeSection({
          badge: `#${i + 1}`,
          badgeClass: 'rm-badge-prov',
          title: `行 ${b.startLine + 2}–${b.endLine + 2}`,
          desc: `${b.district || '（区县未知）'} · ${b.judgment}`,
          open: false,
          build: () => {
            const inner = [];
            if ((b.fuzzyMatchesInBlock || []).length) {
              inner.push(makeHeading('疑似对应'));
              inner.push(makeTable(['旧名称', '新名称', '公共字串', '旧邮编', '新邮编'],
                b.fuzzyMatchesInBlock.map((f) => [
                  f[1] ? f[1].name : '', f[0] ? f[0].name : '',
                  f[2] || '', (f[1] && f[1].postcode) || '', (f[0] && f[0].postcode) || '',
                ])));
            }
            const onlyTable = (title, list) => {
              if (!list.length) return;
              inner.push(makeHeading(title));
              inner.push(makeTable(['网点名称', '邮编'],
                list.map((u) => [(u[1] || {}).name, (u[1] || {}).postcode || ''])));
            };
            onlyTable('区块内新版独有', b.onlyIn1 || []);
            onlyTable('区块内旧版独有', b.onlyIn2 || []);
            if ((b.changesInBlock || []).length) {
              inner.push(makeHeading('区块内已匹配变化'));
              inner.push(makeTable(['旧名称', '新名称', '变化类型'],
                b.changesInBlock.map((c) => [
                  (c.rec2 || {}).name, (c.rec1 || {}).name, (c.categories || []).join('、'),
                ])));
            }
            if (!inner.length) {
              const p2 = document.createElement('p');
              p2.className = 'rm-footnote';
              p2.textContent = '该区块内没有可展开的明细。';
              inner.push(p2);
            }
            const box = document.createElement('div');
            for (const n of inner) box.appendChild(n);
            return box;
          },
        }));
      }
    }

    if (!nodes.length) {
      const p2 = document.createElement('p');
      p2.className = 'rm-footnote';
      p2.textContent = '✓ 两份数据完全一致，无任何差异。';
      nodes.push(p2);
    }

    const box = document.createElement('div');
    for (const n of nodes) box.appendChild(n);
    return box;
  }

  /** 一个文件对里总共多少处差异（⚠综合变化单列，区块是它的结果不重复计） */
  function intelligentDiffCount(p) {
    const s = p.summary || {};
    let n = (s.new || 0) + (s.removed || 0) + (s.comprehensive || 0);
    for (const k of Object.keys(s.byCategory || {})) n += s.byCategory[k];
    return n;
  }

  /** 该省的「邮政」「邮管」两个前缀。localeCompare 正好让 post… 排在 spb… 前 */
  function prefixesOfProvince(abbr, result) {
    const out = [];
    const add = (prefix) => {
      const m = /^(post|spb)(.+)$/.exec(String(prefix || ''));
      if (!m || m[2] !== abbr || out.indexOf(prefix) >= 0) return;
      out.push(prefix);
    };
    for (const p of result.pairs || []) add(p.prefix);
    for (const it of result.intelligent || []) add(it.prefix);
    return out.sort((a, b) => a.localeCompare(b));
  }

  /** 下拉框的省份选项，按省份表顺序排；每项带上「有几个文件、有没有差异」 */
  function compareProvinceOptions(result) {
    const abbrs = [];
    for (const p of result.pairs || []) {
      const m = /^(post|spb)(.+)$/.exec(String(p.prefix || ''));
      if (m && abbrs.indexOf(m[2]) < 0) abbrs.push(m[2]);
    }
    for (const it of result.intelligent || []) {
      const m = /^(post|spb)(.+)$/.exec(String(it.prefix || ''));
      if (m && abbrs.indexOf(m[2]) < 0) abbrs.push(m[2]);
    }

    const order = new Map(provinceList.map((p, i) => [p.abbr, i]));
    const rank = (a) => (order.has(a) ? order.get(a) : provinceList.length);
    abbrs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    return abbrs.map((abbr) => {
      const prefixes = prefixesOfProvince(abbr, result);
      const diffs = prefixes.reduce((n, prefix) => {
        const it = (result.intelligent || []).find((x) => x.prefix === prefix);
        return n + (it ? intelligentDiffCount(it) : 0);
      }, 0);
      return {
        value: abbr,        // makeSelector 读的是 value，写成 abbr 会让 option.value 变成 "undefined"
        label: `${provinceName(abbr)}（${prefixes.length} 个文件` +
               (diffs ? ` · ${diffs} 处差异` : ' · 一致') + '）',
      };
    });
  }

  /** 单个文件的原始对比输出（txt_compare.exe 的 stdout） */
  function buildCompareRawReport(pair, result) {
    if (pair.status === 'compared') {
      return makePre(pair.report || '（对比器无输出，说明两份文件内容一致）',
                     { path: result.reportPath });
    }
    const lines = [
      `output：${pair.outFile || '（无对应文件）'}`,
      `base  ：${pair.baseFile || '（无对应文件）'}`,
    ];
    if (pair.error) lines.push('', `错误：${pair.error}`);
    return makePre(lines.join('\n'));
  }

  /**
   * 单个文件的详情：智能判别在上、txt_compare 原始对比在下。
   * 先看「变了什么」，需要逐字核对时再往下看原始 diff。
   */
  function buildCompareFileDetail(prefix, result) {
    const box = document.createElement('div');
    const intel = (result.intelligent || []).find((p) => p.prefix === prefix) || null;
    const pair = (result.pairs || []).find((p) => p.prefix === prefix) || null;
    const planRow = ((result.plan || {}).byPrefix || []).find((p) => p.prefix === prefix) || null;

    const head = document.createElement('div');
    head.className = 'rm-heading';
    head.textContent = prefixLabel(prefix);
    box.appendChild(head);

    const files = pair ? [pair.outFile, pair.baseFile].filter(Boolean).join('  ⟷  ') : '';
    if (files) {
      const f = document.createElement('p');
      f.className = 'rm-footnote';
      f.textContent = files;
      box.appendChild(f);
    }

    // 这个文件在「确认更新 base」时会怎么变：当前库多少条、归档多少条
    if (planRow) {
      const pl = document.createElement('p');
      pl.className = 'rm-footnote';
      pl.textContent =
        `更新方案：当前库 ${planRow.current} 条` +
        (planRow.revoked ? ` · 已撤销不进库 ${planRow.revoked} 条` : '') +
        ` · 归档 更名 ${planRow.renamed} / 疑似撤下 ${planRow.removed}`;
      box.appendChild(pl);
    }

    if (intel) {
      box.appendChild(makeHeading('智能判别（语义级差异）'));
      box.appendChild(buildIntelligentDetail(intel));
    }
    if (pair) {
      const st = COMPARE_STATUS[pair.status] || { label: pair.status, cls: 'rm-badge-prov' };
      box.appendChild(makeHeading(`原始对比（txt_compare）· ${st.label}`));
      box.appendChild(buildCompareRawReport(pair, result));
    }
    return box;
  }

  /** 选中某个省后的详情：该省的「邮政」「邮管」两个文件 */
  function buildCompareProvinceDetail(abbr, result) {
    const box = document.createElement('div');
    for (const prefix of prefixesOfProvince(abbr, result)) {
      box.appendChild(buildCompareFileDetail(prefix, result));
    }
    return box;
  }

  /**
   * 「更新方案」标签页：确认更新 base 之后 base 会变成什么样。
   * 逐文件的归档明细来自主进程算好的 plan.byPrefix。
   */
  function buildComparePlanPanel(result) {
    const box = document.createElement('div');
    const plan = result.plan || null;

    if (!plan) {
      box.appendChild(makeHeading('更新方案'));
      const none = document.createElement('p');
      none.className = 'rm-footnote';
      none.textContent = '本次对比没有算出更新方案（主进程未返回 plan），无法预览 base 将怎么变。';
      box.appendChild(none);
      return box;
    }

    const cards = [
      { label: '写入当前库', value: plan.currentTotal, color: '#28a745' },
    ];
    if (plan.revokedTotal) {
      cards.push({ label: '已撤销(不进库)', value: plan.revokedTotal, color: '#d93026' });
    }
    cards.push({ label: 'base_old 归档', value: plan.archiveTotal, color: '#6c757d' });
    cards.push({ label: '本次新归档', value: plan.archiveAdded, color: '#6c757d' });
    box.appendChild(makeCards(cards));

    const note = document.createElement('p');
    note.className = 'rm-footnote';
    note.textContent =
      '当前库按 output 覆盖 base/{前缀}+base.csv（带（撤销）标记的记录不进当前库）；' +
      '名称变化前的旧名称、带（撤销）的记录、output 里已消失的旧记录转入 base/base_old.csv 归档；' +
      '营业状态变化（暂停、装修中、临时停业、假期营业…）只覆盖原有内容，不进归档。' +
      '归档只保留当前库里已经没有的记录，重新出现的会被移出。';
    box.appendChild(note);

    // ── 归档构成 ──
    box.appendChild(makeHeading('base_old 归档构成'));
    const reasons = Object.keys(plan.archiveByReason || {});
    if (reasons.length) {
      box.appendChild(makeTable(
        ['归档原因', '条数'],
        reasons.map((k) => [k, plan.archiveByReason[k]]),
        `归档文件共 ${plan.archiveTotal} 条，其中本次新增 ${plan.archiveAdded} 条` +
        (plan.archiveRestored ? `、移出 ${plan.archiveRestored} 条` : '') + '。'
      ));
    } else {
      const none = document.createElement('p');
      none.className = 'rm-footnote';
      none.textContent = '本次没有需要归档的记录（base_old 保持为空）。';
      box.appendChild(none);
    }

    // ── 逐文件方案 ──
    const byPrefix = plan.byPrefix || [];
    if (byPrefix.length) {
      box.appendChild(makeHeading('逐文件方案'));
      box.appendChild(makeTable(
        ['文件', '写入当前库', '已撤销', '更名归档', '疑似撤下'],
        byPrefix.map((r) => [
          prefixLabel(r.prefix), r.current, r.revoked, r.renamed, r.removed,
        ]),
        '「写入当前库」是覆盖 base 后的条数；已撤销的记录不进当前库；' +
        '更名归档 = 旧名称那条，疑似撤下 = output 里已消失的旧记录。'
      ));
    }

    return box;
  }

  /** 「对比报告」标签页：语义级判别明细 + 逐省逐文件明细 + 报告全文 */
  function buildCompareReportPanel(result) {
    const box = document.createElement('div');
    const intelList = Array.isArray(result.intelligent) ? result.intelligent : [];

    box.appendChild(makeCards([
      { label: '对比文件对', value: result.compared, color: '#28a745' },
      { label: '新增', value: result.added, color: '#0d6efd' },
      { label: '缺失', value: result.missing, color: '#fa8c16' },
    ]));

    if (intelList.length) {
      const intro = document.createElement('p');
      intro.className = 'rm-footnote';
      intro.textContent =
        '语义级判别：把两份数据按「区县+归一化名称 → 公共中文字串 → 邮编」三级规则配成对，' +
        '再逐字段比出变化类型，并识别疑似新增/撤下与连续变化区块。' +
        '带「撤销」字样且已在 base_old 历史库中的记录不计入新增。与落盘的智能判别报告同源。';
      box.appendChild(intro);
      box.appendChild(buildIntelligentCards(intelList));
    }

    // ── 选省看详情 ──
    const options = compareProvinceOptions(result);
    if (options.length) {
      box.appendChild(makeSelector('选择省份：', options,
        (abbr) => buildCompareProvinceDetail(abbr, result)));
    }

    // ── 报告全文 ──
    if (intelList.length) {
      box.appendChild(makeSection({
        badge: '报告',
        badgeClass: 'rm-badge-prov',
        title: '智能判别报告全文',
        desc: '未经裁剪的原始报告，可复制留档',
        open: false,
        build: () => makePre(result.intelligentReportText || '（报告为空）',
                              { path: result.intelligentReportPath }),
      }));
    }

    box.appendChild(makeSection({
      badge: '报告',
      badgeClass: 'rm-badge-prov',
      title: '完整报告文本',
      desc: '未经裁剪的原始报告，可复制留档',
      open: false,
      build: () => makePre(result.reportText || '（报告为空）', { path: result.reportPath }),
    }));

    return box;
  }

  /**
   * 智能比较报告弹窗。onApply 非空时提供「确认更新 base」按钮。
   *
   * 正文分两个标签页：「更新方案」= 确认后 base 会怎么变；「对比报告」= 本次差异明细。
   * 两边内容都很大，所以标签内容惰性构建（见 makeTabs）。
   */
  function buildCompareSpec(result, onApply) {
    const body = makeTabs([
      { key: 'plan', label: '更新方案', build: () => buildComparePlanPanel(result) },
      { key: 'report', label: '对比报告', build: () => buildCompareReportPanel(result) },
    ]);

    const buttons = [];
    if (onApply && result.canApply) {
      buttons.push({ label: '确认更新 base', primary: true, onClick: onApply });
    }

    return {
      title: '智能比较报告',
      subtitle:
        `output ${result.outputFileCount} 个文件 · base ${result.baseFileCount} 个文件` +
        (result.reportPath ? ` · 报告已存至 ${result.reportPath}` : '') +
        (result.intelligentReportPath ? ` · 智能判别报告已存至 ${result.intelligentReportPath}` : ''),
      body,
      buttons,
    };
  }

  // ============================================================
  // 初始化 / 对外接口
  // ============================================================

  let inited = false;

  function init() {
    if (inited) return;
    inited = true;

    // 三个面板的日志区都改成可折叠
    for (const id of ['crawl-log', 'compare-log', 'cross-log']) {
      const el = $(id);
      if (el) registerLog(el);
    }

    bindCrawlPanel();
    bindComparePanel();
    bindCrossPanel();
  }

  /** 页面显示时调用：首次加载省份列表 */
  function refresh() {
    init();
    loadProvinces();
  }

  /** 页面隐藏时调用：停止 UI 轮询（后台作业继续跑） */
  function suspend() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    // 切走页面时报告弹窗不该留在屏幕上
    closeReportModal();
  }

  window.CrawlerPage = {
    init,
    refresh,
    suspend,
    /** 是否有报告弹窗打开；app.js 的 Esc 处理据此决定是否继续隐藏页面 */
    closeReport: closeReportModal,
    /** 供调试：暴露内部函数 */
    _refreshReference: refreshReference,
    _buildCompareSpec: buildCompareSpec,
    _buildCrossSpec: buildCrossSpec,
  };
})();
