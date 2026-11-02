/**
 * 港澳台网点页面 — 网点查询 + 数据抓取
 * =====================================
 * 查询数据来自 PostalStore（优先 base/*+base.csv，缺失时用 output 最新结果）；
 * 抓取通过服务端 /api/postal/crawl/* 触发，日志用 cursor 增量轮询；
 * 抓取完成后询问是否把本次结果复制到 base/。
 *
 * 依赖: PostalStore, Tools, Dialog(可选)
 */

const PostalPage = (function () {

  const $ = (id) => document.getElementById(id);
  const SEARCH_LIMIT = 500;
  const FILE_ROWS = [
    { key: 'hk', label: '香港邮政', baseFile: 'posthk+base.csv' },
    { key: 'mo', label: '澳门邮电局', baseFile: 'postmo+base.csv' },
    { key: 'tw', label: '台湾普通邮局', baseFile: 'posttw+base.csv' },
    { key: 'agencytw', label: '台湾邮政代办所', baseFile: 'agencytw+base.csv' },
  ];

  let lastResults = [];
  let searchTimer = null;
  let jobId = null;
  let jobRunning = false;
  let pollTimer = null;
  let pollBusy = false;
  let cursor = 0;
  let pollErrors = 0;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function collected(rec) {
    return !!(rec && window.Tools && typeof window.Tools.isCollected === 'function' && window.Tools.isCollected(rec));
  }

  // ============================================================
  // 网点查询
  // ============================================================

  function runSearch() {
    const bodyEl = $('postal-search-body');
    const metaEl = $('postal-search-meta');
    const emptyEl = $('postal-search-empty');
    if (!bodyEl || !metaEl || !emptyEl) return;
    if (typeof PostalStore === 'undefined') return;

    const regionSel = $('postal-search-region');
    const typeSel = $('postal-search-type');
    const input = $('postal-search-input');
    if (!regionSel || !typeSel || !input) return;

    const region = regionSel.value;
    const type = typeSel.value;
    const keyword = input.value.trim();
    // 选了地区就展示该地区全部（台湾 1648 条也能一次看完）；未选地区时限制 500 条
    const limit = region ? Number.MAX_SAFE_INTEGER : SEARCH_LIMIT;
    const results = PostalStore.search({ region, type, keyword, limit });
    const stats = PostalStore.getStats();
    const totalNote = `共 ${stats.total} 条（香港 ${stats.hk} / 澳门 ${stats.mo} / ` +
      `台湾 ${stats.tw}：邮局 ${stats.twPost} + 代办所 ${stats.twAgency}）`;
    const loadErrs = PostalStore.getErrors();
    const errNote = loadErrs.length ? `；载入异常 ${loadErrs.length} 条` : '';

    if (results.length === 0) {
      lastResults = [];
      bodyEl.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = stats.total === 0
        ? '暂无港澳台网点数据，请先到「数据抓取」采集'
        : '没有符合条件的网点';
      metaEl.textContent = totalNote + errNote;
      return;
    }

    lastResults = results;
    let collectedCount = 0;
    const rows = results.map((r, idx) => {
      const hit = collected(r);
      if (hit) collectedCount++;
      const area = r.city ? `${r.regionLabel} · ${r.city}` : r.regionLabel;
      return `
        <tr>
          <td>${esc(area)}</td>
          <td>${esc(r.typeLabel)}</td>
          <td${hit ? ' class="po-collected"' : ''}>
            <button type="button" class="po-name-btn" data-idx="${idx}"
                    title="单击查看该网点的详细信息">${esc(r.name)}</button>
          </td>
          <td>${r.code ? esc(r.code) : '-'}</td>
          <td>${r.postalCode ? esc(r.postalCode) : '-'}</td>
          <td class="postal-addr">${r.address ? esc(r.address) : '-'}</td>
          <td>${r.jurisdiction ? esc(r.jurisdiction) : '-'}</td>
        </tr>`;
    }).join('');

    emptyEl.style.display = 'none';
    bodyEl.innerHTML = rows;
    const limitNote = !region && results.length >= SEARCH_LIMIT
      ? `（最多显示 ${SEARCH_LIMIT} 条，请选择地区或用类型/关键字缩小范围）`
      : '';
    metaEl.textContent = `${totalNote}，匹配 ${results.length} 条${limitNote}` +
      (collectedCount > 0 ? `，其中 ${collectedCount} 条已收集` : '') + errNote;
  }

  function refreshSearch() {
    if (typeof PostalStore === 'undefined') return;
    // 启动时数据已载入；这里再 ready 一次可兼容从抓取页返回的情况
    PostalStore.ready().then(runSearch).catch((e) => {
      const metaEl = $('postal-search-meta');
      if (metaEl) metaEl.textContent = '港澳台数据载入失败：' + (e.message || e);
    });
  }

  // ============================================================
  // 数据抓取
  // ============================================================

  function appendLog(text) {
    const el = $('postal-crawl-log');
    if (!el || !text) return;
    el.textContent += text.endsWith('\n') ? text : text + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function setRunning(on) {
    jobRunning = on;
    const btn = $('btn-postal-crawl-start');
    if (btn) {
      btn.disabled = on;
      btn.textContent = on ? '抓取中...' : '开始抓取';
    }
    const status = $('postal-crawl-status');
    if (status && on) status.textContent = '正在抓取，请勿关闭应用...';
  }

  async function loadFiles() {
    const bodyEl = $('postal-files-body');
    const metaEl = $('postal-files-meta');
    if (!bodyEl || !metaEl) return;
    if (typeof PostalStore === 'undefined') return;

    const stats = PostalStore.getStats();
    const counts = {
      hk: stats.hk,
      mo: stats.mo,
      tw: stats.twPost,
      agencytw: stats.twAgency,
    };

    let sources = [];
    try {
      const res = await fetch('/api/postal/files', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.files)) sources = data.files;
      }
    } catch (e) { /* 服务端不可用时仍展示内存统计 */ }

    // 服务端不可用或旧版服务端：至少把四个站点列出来
    if (!sources.length) {
      sources = FILE_ROWS.map((s) => Object.assign({}, s, {
        source: 'none', name: null, size: 0, mtime: 0, baseExists: false,
      }));
    }

    bodyEl.innerHTML = sources.map((s) => {
      const hasFile = !!s.name;
      const count = counts[s.key] || 0;
      const sourceLabel = s.source === 'base' ? 'base'
        : (s.source === 'output' ? 'output' : '未生成');
      return `<tr>
        <td>${esc(s.label || s.key)}</td>
        <td>${esc(sourceLabel)}</td>
        <td>${hasFile ? esc(s.name) : '—'}</td>
        <td>${s.outputName ? esc(s.outputName) : '—'}</td>
        <td>${hasFile ? count : '0'}</td>
        <td>${hasFile ? fmtSize(s.size) : '—'}</td>
        <td>${hasFile ? fmtTime(s.mtime) : '—'}</td>
        <td>${s.baseExists ? esc(s.baseFile) : '—'}</td>
      </tr>`;
    }).join('');

    const loadedAt = PostalStore.getLastLoadedAt();
    const baseCount = sources.filter((s) => s.source === 'base').length;
    metaEl.textContent = `内存已载入 ${stats.total} 条；查询来源 base ${baseCount}/${sources.length}；` +
      `台湾合计 ${stats.tw}（邮局 ${stats.twPost} + 代办所 ${stats.twAgency}）` +
      (loadedAt ? `；载入时间 ${fmtTime(new Date(loadedAt).getTime())}` : '');
    const errs = PostalStore.getErrors();
    if (errs.length) {
      metaEl.textContent += `；载入异常 ${errs.length} 条（${errs.slice(0, 2).join('；')}）`;
    }
  }

  /** 重新载入查询库、文件列表、查询表，并通知首页/排名刷新 */
  async function reloadAll() {
    await PostalStore.reload();
    await loadFiles();
    runSearch();
    window.dispatchEvent(new CustomEvent('postal-data-changed'));
  }

  /** 取 summary 里本次真正写出的文件（失败站点和干跑不参与） */
  function successfulOutputs(summary) {
    return (Array.isArray(summary) ? summary : []).filter((s) =>
      s && s.status !== 'failed' && s.file && s.baseFile
    );
  }

  function outputName(item) {
    if (item.fileName) return item.fileName;
    const raw = String(item.file || '');
    const parts = raw.split(/[\\/]/);
    return parts[parts.length - 1] || raw;
  }

  /**
   * 抓取完成后询问是否更新 base。
   * 返回 null（没有可更新文件）、{skipped:true}（用户取消）或服务端结果。
   */
  async function offerBaseUpdate(summary) {
    const items = successfulOutputs(summary);
    if (!items.length) return null;

    const lines = items.map((s) => `  ${outputName(s)} → base/${s.baseFile}`).join('\n');
    const msg = `本次抓取完成。\n\n是否将结果更新到 base 目录？\n\n${lines}\n\n` +
      '选择「取消」则保留 output 文件，不修改 base；查询继续使用旧 base（如有）。';

    let ok;
    if (typeof Dialog !== 'undefined' && typeof Dialog.confirm === 'function') {
      ok = await Dialog.confirm(msg);
    } else {
      ok = window.confirm(msg);
    }
    if (!ok) return { skipped: true };
    if (!jobId) throw new Error('作业 ID 已丢失，无法更新 base');

    const res = await fetch('/api/postal/apply-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function refreshCrawler() {
    try {
      await loadFiles();
    } catch (e) {
      const status = $('postal-crawl-status');
      if (status) status.textContent = '读取数据文件失败：' + (e.message || e);
    }
    if (jobRunning && jobId && !pollTimer) poll();
  }

  async function startCrawl() {
    if (jobRunning) return;
    const keys = [];
    if ($('postal-crawl-hk').checked) keys.push('hk');
    if ($('postal-crawl-mo').checked) keys.push('mo');
    if ($('postal-crawl-tw').checked) keys.push('tw');
    if ($('postal-crawl-agencytw').checked) keys.push('agencytw');
    if (keys.length === 0) {
      if (typeof Dialog !== 'undefined') await Dialog.alert('请至少选择一个数据源');
      return;
    }

    const body = {
      only: keys,
      delay: Number($('postal-crawl-delay').value) || 0,
      timeout: Number($('postal-crawl-timeout').value) || 30,
      attempts: Number($('postal-crawl-attempts').value) || 3,
      dryRun: $('postal-crawl-dry').checked,
    };

    $('postal-crawl-log').textContent = '';
    $('postal-crawl-status').textContent = '';
    setRunning(true);
    jobId = null;
    cursor = 0;
    pollErrors = 0;

    try {
      const res = await fetch('/api/postal/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.jobId) throw new Error('服务端未返回作业 ID');
      jobId = data.jobId;
      appendLog(`[UI] 作业已启动：${jobId}`);
      poll();
    } catch (e) {
      setRunning(false);
      appendLog('[ERROR] ' + (e.message || e));
      $('postal-crawl-status').textContent = '启动失败：' + (e.message || e);
    }
  }

  async function poll() {
    if (!jobId || !jobRunning || pollBusy) return;
    pollBusy = true;
    clearTimeout(pollTimer);
    pollTimer = null;
    try {
      const res = await fetch(
        `/api/postal/crawl/status?job=${encodeURIComponent(jobId)}&cursor=${cursor}`,
        { cache: 'no-store' }
      );
      if (res.status === 404) {
        setRunning(false);
        $('postal-crawl-status').textContent = '作业已过期，请重新启动';
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      pollErrors = 0;
      if (Array.isArray(data.logs) && data.logs.length) {
        appendLog(data.logs.join('\n'));
        cursor = data.cursor || cursor;
      }
      if (data.state === 'running') {
        $('postal-crawl-status').textContent = '正在抓取，请勿关闭应用...';
        pollTimer = setTimeout(poll, 800);
        return;
      }

      pollTimer = null;
      const ok = data.state === 'done';
      $('postal-crawl-status').textContent = ok
        ? '抓取完成，正在重新载入查询数据...'
        : `抓取结束：${data.error || '部分站点失败'}`;
      appendLog(`[UI] 作业结束：${data.state}`);

      try {
        await reloadAll();

        let baseNote = '';
        try {
          const applied = await offerBaseUpdate(data.summary);
          if (applied && applied.skipped) {
            baseNote = '；base 未更新（output 已保留）';
            appendLog('[UI] 已取消更新 base，output 文件保留');
          } else if (applied) {
            if (applied.updated) {
              await reloadAll();
              baseNote = `；base 已更新 ${applied.updated} 个文件`;
              appendLog(`[UI] base 已更新 ${applied.updated} 个文件`);
            } else {
              baseNote = '；base 未更新';
            }
            if (Array.isArray(applied.errors) && applied.errors.length) {
              baseNote += `；${applied.errors.length} 个文件更新失败：${applied.errors[0]}`;
              appendLog(`[ERROR] base 更新失败：${applied.errors.join('；')}`);
            }
          }
        } catch (e) {
          baseNote = '；base 更新失败：' + (e.message || e);
        }

        $('postal-crawl-status').textContent = ok
          ? `抓取完成，当前共 ${PostalStore.count()} 条${baseNote}`
          : `抓取结束：${data.error || '部分站点失败'}（已重新载入可用数据）${baseNote}`;
      } catch (e) {
        $('postal-crawl-status').textContent = '抓取结束，但重新载入失败：' + (e.message || e);
      } finally {
        setRunning(false);
      }
    } catch (e) {
      pollErrors++;
      if (pollErrors <= 3) {
        $('postal-crawl-status').textContent = `状态查询失败，重试 ${pollErrors}/3...`;
        pollTimer = setTimeout(poll, 1200);
      } else {
        setRunning(false);
        pollTimer = null;
        $('postal-crawl-status').textContent = '状态查询失败：' + (e.message || e);
      }
    } finally {
      pollBusy = false;
      // 极短窗口内用户可能在“完成”提示后立刻启动了新作业；
      // 此时旧轮询的 finally 负责把新作业接上。
      if (jobRunning && jobId && !pollTimer) poll();
    }
  }

  async function reloadData() {
    const status = $('postal-reload-status');
    if (status) status.textContent = '正在重新载入...';
    try {
      await reloadAll();
      if (status) status.textContent = `已重新载入 ${PostalStore.count()} 条`;
    } catch (e) {
      if (status) status.textContent = '重新载入失败：' + (e.message || e);
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  function init() {
    const regionSel = $('postal-search-region');
    const typeSel = $('postal-search-type');
    const input = $('postal-search-input');
    const clearBtn = $('postal-search-clear');
    const bodyEl = $('postal-search-body');

    if (regionSel) regionSel.addEventListener('change', runSearch);
    if (typeSel) typeSel.addEventListener('change', runSearch);
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 180);
      });
    }
    if (clearBtn && regionSel && typeSel && input) {
      clearBtn.addEventListener('click', () => {
        regionSel.value = '';
        typeSel.value = '';
        input.value = '';
        runSearch();
      });
    }
    if (bodyEl) {
      bodyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.po-name-btn');
        if (!btn) return;
        const rec = lastResults[Number(btn.dataset.idx)];
        if (rec && window.Tools && window.Tools.openPODetail) window.Tools.openPODetail(rec);
      });
    }

    const startBtn = $('btn-postal-crawl-start');
    if (startBtn) startBtn.addEventListener('click', startCrawl);
    const reloadBtn = $('btn-postal-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', reloadData);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    refreshSearch,
    refreshCrawler,
    // 抓取作业的状态轮询在后台继续；离开页面不中断，
    // 以便作业完成后仍能刷新查询数据与首页总数。
    suspend: () => {},
  };

})();
