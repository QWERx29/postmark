/**
 * 数据安全 — 备份 / 恢复 / 图片管理 / 回收站
 * ===========================================
 * 依赖: RecordStore / MeterStore / MailStore / ReturnStore（四张表）
 *       Dialog（自定义对话框）
 *       服务端 /api/backup/* 与 /api/images/*（见 backup.js / img-export.js）
 *
 * 分工
 * ----
 *   四张表在 localStorage（渲染层），图片在磁盘（服务端）。
 *   - 备份：本模块把四表交给服务端，由服务端连同图片打成一个 zip；
 *   - 恢复：服务端先解到暂存目录并回传清单，用户确认「合并 / 覆盖」后，
 *           服务端把图片搬进正式目录，本模块负责把四表写回 localStorage；
 *   - 自动快照：每次启动把四表写一份 JSON 到 output/backup/（保留最近 N 份）。
 *
 * 页面结构
 * --------
 *   #maintenance-page
 *     ├── 备份与恢复（汇总 / 一键备份 / 恢复 / 备份文件列表）
 *     ├── 图片管理（引用统计 / 孤儿清理 / 挂接到记录 / 旧目录迁移）
 *     └── 回收站（软删除记录，30 天内可恢复）
 *
 * 对外接口（app.js 使用）: window.MaintenancePage
 */
(function () {

  const $ = (id) => document.getElementById(id);

  /** 图片网格每次渲染的数量 */
  const IMAGE_PAGE_SIZE = 120;

  /** 启动快照的去重窗口：6 小时内数据没变就不重复写 */
  const AUTOSNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

  /** 记录启动快照元信息的 localStorage 键 */
  const AUTOSNAPSHOT_META_KEY = 'postmark_autosnapshot_meta';

  /** app.js 里 base 参考库签名用的键（恢复时只做提示，不写回） */
  const BASE_SIG_KEY = 'poref_base_signature';

  const API = {
    backupFiles: '/api/backup/files',
    backupSnapshot: '/api/backup/snapshot',
    backupCreate: '/api/backup/create',
    backupInspect: '/api/backup/inspect',
    backupApply: '/api/backup/apply',
    backupDiscard: '/api/backup/discard',
    backupDelete: '/api/backup/delete',
    imagesAll: '/api/images/all',
    imagesDelete: '/api/images/delete',
    imagesMigrate: '/api/images/migrate-legacy',
  };

  const TRASH_DAYS = 30;

  const state = {
    tab: 'backup',
    busy: false,
    files: [],
    backupDir: '',
    images: null,              // { imagesDir, legacyDir, files: [] }
    refs: null,                // Set<relPath>：被记录 / 回收站引用
    imageFilter: 'all',
    imageKeyword: '',
    imageShown: IMAGE_PAGE_SIZE,
    attachFile: null,
    previewFile: null,
  };

  let els = null;
  let inited = false;

  // ============================================================
  // 小工具
  // ============================================================
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`;
    return `${(v / 1073741824).toFixed(2)} GB`;
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 图片地址：/images/<相对路径>，逐段编码 */
  function photoUrl(relPath) {
    return '/images/' + String(relPath == null ? '' : relPath)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  /** 备份文件下载地址（/output 映射到可写产出目录） */
  function backupUrl(name) {
    return '/output/backup/' + encodeURIComponent(name);
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body == null ? {} : body),
    });
  }

  function download(name) {
    const a = document.createElement('a');
    a.href = backupUrl(name);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ============================================================
  // 四张表：读取 / 写回
  // ============================================================
  function getStore(name) {
    const map = {
      records: () => (typeof RecordStore !== 'undefined' ? RecordStore : null),
      meters: () => (typeof MeterStore !== 'undefined' ? MeterStore : null),
      mails: () => (typeof MailStore !== 'undefined' ? MailStore : null),
      returns: () => (typeof ReturnStore !== 'undefined' ? ReturnStore : null),
    };
    try { return map[name] ? map[name]() : null; } catch (e) { return null; }
  }

  /** 当前四张表 + 回收站（备份 / 快照 / 恢复对比都用它） */
  function gatherTables() {
    const records = getStore('records');
    const meters = getStore('meters');
    const mails = getStore('mails');
    const returns = getStore('returns');
    return {
      records: records ? records.getAll() : [],
      meters: meters ? meters.getAll() : [],
      mails: mails ? mails.getAll() : [],
      returns: returns ? returns.getAll() : [],
      trash: records && typeof records.getTrash === 'function' ? records.getTrash() : [],
    };
  }

  function countsOf(tables) {
    const t = tables || {};
    return {
      records: Array.isArray(t.records) ? t.records.length : 0,
      meters: Array.isArray(t.meters) ? t.meters.length : 0,
      mails: Array.isArray(t.mails) ? t.mails.length : 0,
      returns: Array.isArray(t.returns) ? t.returns.length : 0,
      trash: Array.isArray(t.trash) ? t.trash.length : 0,
    };
  }

  function baseInfo() {
    try {
      const sig = localStorage.getItem(BASE_SIG_KEY);
      if (!sig) return null;
      return { signature: sig, savedAt: new Date().toISOString() };
    } catch (e) {
      return null;
    }
  }

  /** 通用合并：按 id 只补缺失的（用于邮件 / 邮资机 / 退信） */
  function mergeStore(store, list) {
    const arr = Array.isArray(list) ? list : [];
    if (!store || typeof store.getAll !== 'function' || typeof store.replaceAll !== 'function') {
      return { added: 0, updated: 0, skipped: arr.length };
    }
    const current = store.getAll();
    const ids = new Set(current.map((r) => r && r.id));
    const extra = arr.filter((r) => r && r.id && !ids.has(r.id));
    if (extra.length > 0) store.replaceAll(current.concat(extra));
    return { added: extra.length, updated: 0, skipped: arr.length - extra.length };
  }

  function mergeTrash(list) {
    const records = getStore('records');
    const arr = Array.isArray(list) ? list : [];
    if (!records || typeof records.replaceTrash !== 'function') return { added: 0, updated: 0, skipped: arr.length };
    const current = records.getTrash();
    const ids = new Set(current.map((r) => r && r.id));
    const extra = arr.filter((r) => r && r.id && !ids.has(r.id));
    if (extra.length > 0) records.replaceTrash(current.concat(extra));
    return { added: extra.length, updated: 0, skipped: arr.length - extra.length };
  }

  /**
   * 把备份里的四表写回 localStorage。
   * @param {object} tables
   * @param {'merge'|'replace'} mode
   * @returns {{records:object, meters:object, mails:object, returns:object, trash:object}}
   */
  function applyTables(tables, mode) {
    const t = tables || {};
    const replace = mode === 'replace';
    const report = {};

    const records = getStore('records');
    if (records) {
      report.records = replace
        ? { written: records.replaceAll(t.records) }
        : records.mergeAll(t.records, { overwrite: false });
    }

    ['meters', 'mails', 'returns'].forEach((key) => {
      const store = getStore(key);
      if (!store) return;
      report[key] = replace
        ? { written: store.replaceAll(t[key]) }
        : mergeStore(store, t[key]);
    });

    if (records && typeof records.replaceTrash === 'function') {
      report.trash = replace
        ? { written: records.replaceTrash(t.trash) }
        : mergeTrash(t.trash);
    }

    return report;
  }

  /** 启动快照用的内容指纹（djb2），用来判断"数据没变就别重复写" */
  function quickSig(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return `${text.length}:${h >>> 0}`;
  }

  // ============================================================
  // 备份与恢复
  // ============================================================
  function renderSummary() {
    if (!els || !els.summary) return;
    const records = getStore('records');
    const meters = getStore('meters');
    const mails = getStore('mails');
    const returns = getStore('returns');

    const images = state.images && Array.isArray(state.images.files) ? state.images.files : [];
    const imageBytes = images.reduce((s, f) => s + (Number(f.size) || 0), 0);

    const cards = [
      { label: '日戳记录', value: records ? records.count() : 0 },
      { label: '邮资机戳', value: meters ? meters.count() : 0 },
      { label: '邮件', value: mails ? mails.count() : 0 },
      { label: '国际退信', value: returns ? returns.count() : 0 },
      { label: '回收站', value: records && typeof records.trashCount === 'function' ? records.trashCount() : 0 },
      { label: '图片', value: images.length, extra: fmtBytes(imageBytes) },
    ];

    els.summary.innerHTML = cards.map((c) => `
      <div class="maint-stat">
        <span class="maint-stat-label">${esc(c.label)}</span>
        <span class="maint-stat-value">${esc(c.value)}${c.extra ? `<small>${esc(c.extra)}</small>` : ''}</span>
      </div>
    `).join('');

    // 回收站角标跟着记录数走（切到备份页时也能看到最新条数）
    if (els.trashBadge) {
      const n = records && typeof records.trashCount === 'function' ? records.trashCount() : 0;
      els.trashBadge.hidden = n === 0;
      els.trashBadge.textContent = n;
    }

    if (els.backupDir) {
      els.backupDir.textContent = state.backupDir
        ? `备份目录：${state.backupDir}`
        : '备份目录：output/backup（服务端自动创建）';
    }
  }

  function renderBackupLists() {
    if (!els) return;
    const files = Array.isArray(state.files) ? state.files : [];
    const packages = files.filter((f) => f.kind === 'package');
    const snapshots = files.filter((f) => f.kind === 'snapshot');

    if (els.backupList) {
      els.backupList.innerHTML = packages.length === 0
        ? '<div class="maint-empty">还没有备份包。点上面的「打包备份」生成第一个。</div>'
        : packages.map((f) => `
          <div class="maint-row">
            <span class="maint-row-main">
              <span class="maint-row-name">${esc(f.name)}</span>
              <span class="maint-row-meta">${esc(fmtBytes(f.size))} · ${esc(fmtDateTime(f.mtime))}</span>
            </span>
            <span class="maint-row-actions">
              <button type="button" data-backup-download="${escAttr(f.name)}">下载</button>
              <button type="button" data-backup-delete="${escAttr(f.name)}" class="maint-danger">删除</button>
            </span>
          </div>
        `).join('');
    }

    if (els.snapshotList) {
      els.snapshotList.innerHTML = snapshots.length === 0
        ? '<div class="maint-empty">还没有四表快照。启动应用会自动保存一份。</div>'
        : snapshots.map((f) => `
          <div class="maint-row">
            <span class="maint-row-main">
              <span class="maint-row-name">${esc(f.name)}</span>
              <span class="maint-row-meta">${esc(fmtBytes(f.size))} · ${esc(fmtDateTime(f.mtime))}</span>
            </span>
            <span class="maint-row-actions">
              <button type="button" data-snapshot-restore="${escAttr(f.name)}">恢复</button>
              <button type="button" data-backup-download="${escAttr(f.name)}">下载</button>
              <button type="button" data-backup-delete="${escAttr(f.name)}" class="maint-danger">删除</button>
            </span>
          </div>
        `).join('');
    }

    bindBackupListEvents();
  }

  function bindBackupListEvents() {
    if (!els) return;

    document.querySelectorAll('[data-backup-download]').forEach((btn) => {
      btn.addEventListener('click', () => download(btn.dataset.backupDownload));
    });

    document.querySelectorAll('[data-backup-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteBackupFile(btn.dataset.backupDelete));
    });

    document.querySelectorAll('[data-snapshot-restore]').forEach((btn) => {
      btn.addEventListener('click', () => restoreSnapshot(btn.dataset.snapshotRestore));
    });
  }

  async function refreshBackupPanel() {
    try {
      await loadImages();
    } catch (e) {
      console.warn('[Maintenance] 读取图片目录失败:', e);
    }
    renderSummary();

    try {
      const data = await fetchJson(API.backupFiles);
      state.files = Array.isArray(data.files) ? data.files : [];
      state.backupDir = data.backupDir || '';
    } catch (e) {
      state.files = [];
      console.warn('[Maintenance] 读取备份列表失败:', e);
    }
    renderBackupLists();
    renderSummary();          // 备份目录路径在拿到列表后才知道，补一次
  }

  async function createPackage() {
    if (state.busy) return;
    const tables = gatherTables();
    const counts = countsOf(tables);
    if (counts.records + counts.meters + counts.mails + counts.returns === 0) {
      await Dialog.alert('当前没有可备份的数据。');
      return;
    }

    state.busy = true;
    const btn = els && els.btnBackupCreate;
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '打包中…'; }
    try {
      const res = await postJson(API.backupCreate, { tables, base: baseInfo() });
      await refreshBackupPanel();
      const ok = await Dialog.confirm(
        `备份完成：${res.name}\n\n`
        + `四表：日戳 ${res.counts.records} / 邮资机 ${res.counts.meters} / 邮件 ${res.counts.mails} / 退信 ${res.counts.returns}\n`
        + `图片：${res.images.count} 张（${fmtBytes(res.images.bytes)}）\n`
        + `文件大小：${fmtBytes(res.size)}\n\n是否立即下载到本机？`
      );
      if (ok) download(res.name);
    } catch (e) {
      await Dialog.alert('备份失败：' + e.message);
    } finally {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function saveSnapshot() {
    if (state.busy) return;
    const tables = gatherTables();
    state.busy = true;
    try {
      const res = await postJson(API.backupSnapshot, { tables, reason: 'manual' });
      await refreshBackupPanel();
      await Dialog.alert(`快照已保存：${res.name}\n大小 ${fmtBytes(res.size)}，当前保留 ${res.kept} 份。`);
    } catch (e) {
      await Dialog.alert('保存快照失败：' + e.message);
    } finally {
      state.busy = false;
    }
  }

  async function deleteBackupFile(name) {
    if (!name) return;
    const ok = await Dialog.confirm(`确定删除备份文件？\n\n${name}\n\n删除后无法恢复。`);
    if (!ok) return;
    try {
      await postJson(API.backupDelete, { name });
      await refreshBackupPanel();
    } catch (e) {
      await Dialog.alert('删除失败：' + e.message);
    }
  }

  async function discardRestore(token) {
    if (!token) return;
    try { await postJson(API.backupDiscard, { token }); } catch (e) { /* 过期就算了 */ }
  }

  function restoreSummaryText(manifest, tables, images) {
    const counts = (manifest && manifest.counts) || countsOf(tables);
    const lines = [
      `备份包：${(manifest && manifest.app) || '本应用'}  v${(manifest && manifest.version) || '?'}`,
      `创建时间：${fmtDateTime(manifest && manifest.createdAt)}`,
      `四表：日戳 ${counts.records || 0} / 邮资机 ${counts.meters || 0} / 邮件 ${counts.mails || 0} / 退信 ${counts.returns || 0}`,
      `图片：${images && images.count != null ? images.count : '?'} 张`
        + (images && images.bytes != null ? `（${fmtBytes(images.bytes)}）` : ''),
    ];
    return lines.join('\n');
  }

  async function askRestoreMode(message) {
    return Dialog.choice(
      message,
      [
        { value: 'merge', label: '合并恢复', primary: true },
        { value: 'replace', label: '覆盖恢复' },
        { value: 'cancel', label: '取消' },
      ]
    );
  }

  async function restoreFromFile(file) {
    if (!file || state.busy) return;
    state.busy = true;
    try {
      const res = await fetch(API.backupInspect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (!data || typeof data !== 'object' || !data.token || !data.tables || typeof data.tables !== 'object') {
        throw new Error('备份包内容不完整（缺少数据表或恢复标识）');
      }

      const manifest = data.manifest || {};
      const warnings = Array.isArray(data.warnings) && data.warnings.length
        ? `\n\n注意：${data.warnings.join('；')}`
        : '';
      const msg = `${restoreSummaryText(manifest, data.tables, data.images)}${warnings}\n\n`
        + '请选择恢复方式：\n'
        + '· 合并：保留现有记录，只补入备份里没有的（同 id 跳过）\n'
        + '· 覆盖：清空现有四表后整表恢复（图片同名覆盖）';

      const choice = await askRestoreMode(msg);
      if (!choice || choice === 'cancel') {
        await discardRestore(data.token);
        return;
      }

      if (choice === 'replace') {
        const ok = await Dialog.confirm(
          '覆盖恢复会清空当前的四张表（回收站也会被备份内容替换），\n'
          + '并把同名图片替换成备份里的版本。\n\n确定继续？'
        );
        if (!ok) { await discardRestore(data.token); return; }
        // 覆盖前先给当前四表留一份快照，万一恢复选错了还能找回
        await snapshotBeforeDestructive('before-restore');
      }

      const applied = await postJson(API.backupApply, {
        token: data.token,
        images: choice === 'replace' ? 'overwrite' : 'skip',
      });
      const report = applyTables(data.tables, choice);

      const img = (applied && applied.images) || {};
      const lines = [
        '恢复完成。',
        '',
        `图片：写入 ${img.copied || 0} 张，覆盖 ${img.overwritten || 0} 张，跳过 ${img.skipped || 0} 张`
          + (img.failed ? `，失败 ${img.failed} 张` : ''),
      ];
      if (img.failed && applied.stagingDir) {
        lines.push(`失败图片暂存在：${applied.stagingDir}`);
      }
      if (report.records) {
        lines.push(report.records.written != null
          ? `日戳记录：整表写入 ${report.records.written} 条`
          : `日戳记录：新增 ${report.records.added || 0}，更新 ${report.records.updated || 0}，跳过 ${report.records.skipped || 0}`);
      }
      ['meters', 'mails', 'returns'].forEach((key) => {
        const r = report[key];
        if (!r) return;
        const label = key === 'meters' ? '邮资机戳' : (key === 'mails' ? '邮件' : '国际退信');
        lines.push(r.written != null
          ? `${label}：整表写入 ${r.written} 条`
          : `${label}：新增 ${r.added || 0}，跳过 ${r.skipped || 0}`);
      });
      if (data.base && data.base.signature) {
        let current = '';
        try { current = localStorage.getItem(BASE_SIG_KEY) || ''; } catch (e) { /* ignore */ }
        if (current && current !== data.base.signature) {
          lines.push('', '提示：备份里的 base 参考库签名与当前不同，建议重新导入 base 目录的网点数据。');
        }
      }
      lines.push('', '页面即将刷新以加载恢复后的数据。');
      await Dialog.alert(lines.join('\n'));
      window.location.reload();
    } catch (e) {
      await Dialog.alert('恢复失败：' + e.message);
    } finally {
      state.busy = false;
    }
  }

  async function restoreSnapshot(name) {
    if (!name || state.busy) return;
    state.busy = true;
    try {
      const res = await fetch(backupUrl(name));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tables = data && data.tables ? data.tables : data;
      if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
        throw new Error('快照内容不完整');
      }
      const counts = countsOf(tables);
      const msg = `快照：${name}\n`
        + `创建时间：${fmtDateTime(data && data.createdAt)}\n`
        + `四表：日戳 ${counts.records} / 邮资机 ${counts.meters} / 邮件 ${counts.mails} / 退信 ${counts.returns}\n\n`
        + '快照只包含四张表，不含图片。请选择恢复方式：';

      const choice = await askRestoreMode(msg);
      if (!choice || choice === 'cancel') return;
      if (choice === 'replace') {
        const ok = await Dialog.confirm('覆盖恢复会清空当前的四张表，确定继续？');
        if (!ok) return;
        await snapshotBeforeDestructive('before-restore-snapshot');
      }

      const report = applyTables(tables, choice);
      const lines = ['快照恢复完成。'];
      if (report.records) {
        lines.push(report.records.written != null
          ? `日戳记录：整表写入 ${report.records.written} 条`
          : `日戳记录：新增 ${report.records.added || 0}，更新 ${report.records.updated || 0}，跳过 ${report.records.skipped || 0}`);
      }
      lines.push('', '页面即将刷新以加载恢复后的数据。');
      await Dialog.alert(lines.join('\n'));
      window.location.reload();
    } catch (e) {
      await Dialog.alert('恢复快照失败：' + e.message);
    } finally {
      state.busy = false;
    }
  }

  // ============================================================
  // 图片管理
  // ============================================================
  async function loadImages(force) {
    if (state.images && !force) return state.images;
    const data = await fetchJson(API.imagesAll);
    state.images = {
      imagesDir: data.imagesDir || '',
      legacyDir: data.legacyDir || '',
      files: Array.isArray(data.files) ? data.files : [],
    };
    state.refs = referencedSet();
    return state.images;
  }

  /** 被记录引用的图片（回收站里的记录也算 —— 恢复后图片还得在） */
  function referencedSet() {
    const set = new Set();
    const records = getStore('records');
    if (!records) return set;

    const add = (rec) => {
      if (!rec || !Array.isArray(rec.photos)) return;
      rec.photos.forEach((p) => { if (typeof p === 'string' && p.trim()) set.add(p); });
    };

    records.getAll().forEach(add);
    if (typeof records.getTrash === 'function') records.getTrash().forEach(add);
    // 邮资机戳也有图片，漏掉它们会把仍在使用的文件当成孤儿
    if (typeof MeterStore !== 'undefined' && typeof MeterStore.getAll === 'function') {
      MeterStore.getAll().forEach(add);
    }
    return set;
  }

  function imageUsed(file) {
    const refs = state.refs || referencedSet();
    return refs.has(file.relPath);
  }

  function isUnfiled(file) {
    const unfiled = (typeof ImgNaming !== 'undefined' && ImgNaming.UNFILED_DIR) || '_unfiled';
    return String(file.relPath).startsWith(unfiled + '/');
  }

  function currentImageList() {
    const files = state.images && Array.isArray(state.images.files) ? state.images.files : [];
    const term = state.imageKeyword.trim().toLowerCase();
    return files.filter((f) => {
      const used = imageUsed(f);
      if (state.imageFilter === 'orphan' && used) return false;
      if (state.imageFilter === 'used' && !used) return false;
      if (state.imageFilter === 'unfiled' && !isUnfiled(f)) return false;
      if (term && !String(f.relPath).toLowerCase().includes(term)) return false;
      return true;
    });
  }

  function renderImageStats() {
    if (!els || !els.imageStats) return;
    const files = state.images && Array.isArray(state.images.files) ? state.images.files : [];
    const refs = state.refs || referencedSet();

    let used = 0;
    let orphan = 0;
    let unfiled = 0;
    let bytes = 0;
    let orphanBytes = 0;
    files.forEach((f) => {
      const size = Number(f.size) || 0;
      bytes += size;
      if (refs.has(f.relPath)) used++;
      else { orphan++; orphanBytes += size; }
      if (isUnfiled(f)) unfiled++;
    });

    const cards = [
      { label: '图片总数', value: files.length, extra: fmtBytes(bytes) },
      { label: '已引用', value: used },
      { label: '未引用（孤儿）', value: orphan, extra: fmtBytes(orphanBytes) },
      { label: '未挂接（_unfiled）', value: unfiled },
    ];
    els.imageStats.innerHTML = cards.map((c) => `
      <div class="maint-stat">
        <span class="maint-stat-label">${esc(c.label)}</span>
        <span class="maint-stat-value">${esc(c.value)}${c.extra ? `<small>${esc(c.extra)}</small>` : ''}</span>
      </div>
    `).join('');
  }

  function renderImageDirHints() {
    if (!els) return;
    const info = state.images || {};
    if (els.imageDir) {
      els.imageDir.textContent = info.imagesDir ? `当前图片目录：${info.imagesDir}` : '';
    }
    if (els.imageLegacy) {
      const legacyFiles = (info.files || []).filter((f) => f.source === 'legacy');
      if (info.legacyDir && legacyFiles.length > 0) {
        const bytes = legacyFiles.reduce((s, f) => s + (Number(f.size) || 0), 0);
        els.imageLegacy.hidden = false;
        els.imageLegacy.textContent = `旧目录还有 ${legacyFiles.length} 张图片（${fmtBytes(bytes)}）：${info.legacyDir}`
          + ' —— 可点右上角「迁移旧目录图片」搬到当前目录（记录里的相对路径不变）。';
      } else {
        els.imageLegacy.hidden = true;
        els.imageLegacy.textContent = '';
      }
    }
  }

  function imageCardHtml(file, idx) {
    const used = imageUsed(file);
    const tags = [];
    if (!used) tags.push('<span class="maint-tag maint-tag-orphan">未引用</span>');
    if (used) tags.push('<span class="maint-tag maint-tag-used">已引用</span>');
    if (file.source === 'legacy') tags.push('<span class="maint-tag maint-tag-legacy">旧目录</span>');

    return `
      <div class="maint-image-card${used ? '' : ' is-orphan'}" data-idx="${idx}">
        <button type="button" class="maint-image-thumb" data-act="preview" title="预览">
          <img src="${escAttr(photoUrl(file.relPath))}" alt="${escAttr(file.name)}" loading="lazy">
          <span class="maint-image-fallback">图片缺失</span>
        </button>
        <div class="maint-image-info">
          <span class="maint-image-name" title="${escAttr(file.relPath)}">${esc(file.name)}</span>
          <span class="maint-image-meta">${esc(fmtBytes(file.size))} · ${esc(fmtDateTime(file.mtime))} ${tags.join('')}</span>
        </div>
        <div class="maint-image-actions">
          <button type="button" data-act="attach">挂接</button>
          <button type="button" data-act="delete" class="maint-danger">删除</button>
        </div>
      </div>
    `;
  }

  function bindImageCards(list) {
    if (!els || !els.imageGrid) return;
    els.imageGrid.querySelectorAll('.maint-image-card').forEach((card) => {
      const file = list[Number(card.dataset.idx)];
      if (!file) return;

      const img = card.querySelector('img');
      if (img) {
        const markMissing = () => card.classList.add('is-missing');
        img.addEventListener('error', markMissing);
        if (img.complete && img.naturalWidth === 0) markMissing();
      }

      card.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          if (act === 'preview') openPreview(file);
          else if (act === 'attach') openAttach(file);
          else if (act === 'delete') deleteImage(file);
        });
      });
    });
  }

  function renderImages() {
    if (!els || !els.imageGrid) return;
    renderImageStats();
    renderImageDirHints();

    const list = currentImageList();
    const shown = Math.min(state.imageShown, list.length);

    if (list.length === 0) {
      els.imageGrid.innerHTML = '';
      els.imageEmpty.hidden = false;
      els.imageEmpty.textContent = state.images && state.images.files.length > 0
        ? '没有符合条件的图片'
        : '还没有图片。在「录入日戳 → 日戳图片」里上传后，这里会列出全部文件。';
      if (els.imageMore) els.imageMore.hidden = true;
      return;
    }

    els.imageEmpty.hidden = true;
    els.imageGrid.innerHTML = list.slice(0, shown).map((f, i) => imageCardHtml(f, i)).join('');
    bindImageCards(list);

    if (els.imageMore) {
      els.imageMore.hidden = shown >= list.length;
      els.imageMore.textContent = `加载更多（已显示 ${shown} / ${list.length}）`;
    }
  }

  async function refreshImages() {
    try {
      await loadImages(true);
      state.imageShown = IMAGE_PAGE_SIZE;
      renderImages();
      renderSummary();
    } catch (e) {
      await Dialog.alert('读取图片目录失败：' + e.message);
    }
  }

  async function deleteImage(file) {
    const ok = await Dialog.confirm(
      `确定删除图片文件？\n\n${file.relPath}\n\n`
      + '删除后无法恢复；引用它的记录会显示「图片缺失」。'
    );
    if (!ok) return;
    try {
      const res = await postJson(API.imagesDelete, {
        relPath: file.relPath,
        legacy: file.source === 'legacy',
      });
      if (!res.deleted) await Dialog.alert('文件已不存在，列表已刷新。');
      await refreshImages();
    } catch (e) {
      await Dialog.alert('删除失败：' + e.message);
    }
  }

  async function migrateLegacyImages() {
    const info = state.images || {};
    const legacyFiles = (info.files || []).filter((f) => f.source === 'legacy');
    if (legacyFiles.length === 0) {
      await Dialog.alert('旧目录里没有需要迁移的图片。');
      return;
    }
    const ok = await Dialog.confirm(
      `把旧目录（output/images）里的 ${legacyFiles.length} 张图片搬到当前图片目录？\n\n`
      + '相对路径保持不变，记录里的引用无需修改。新目录已有同名文件时会跳过。'
    );
    if (!ok) return;

    try {
      const res = await postJson(API.imagesMigrate, {});
      await Dialog.alert(
        `迁移完成：移动 ${res.moved || 0} 张，跳过 ${res.skipped || 0} 张`
        + (res.failed ? `，失败 ${res.failed} 张` : '')
        + '。'
      );
      await refreshImages();
    } catch (e) {
      await Dialog.alert('迁移失败：' + e.message);
    }
  }

  // ---- 挂接记录 ----
  function openAttach(file) {
    if (!els || !els.attachOverlay) return;
    state.attachFile = file;
    els.attachFile.textContent = `${file.relPath}（${fmtBytes(file.size)}）`;
    if (els.attachSearch) els.attachSearch.value = '';
    renderAttachList('');
    els.attachOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    if (els.attachSearch) els.attachSearch.focus();
  }

  function closeAttach() {
    if (!els || !els.attachOverlay) return false;
    const wasOpen = els.attachOverlay.classList.contains('active');
    els.attachOverlay.classList.remove('active');
    document.body.style.overflow = '';
    state.attachFile = null;
    return wasOpen;
  }

  function renderAttachList(keyword) {
    if (!els || !els.attachList) return;
    const records = getStore('records');
    if (!records) {
      els.attachList.innerHTML = '<div class="maint-empty">记录存储不可用</div>';
      return;
    }

    const term = String(keyword || '').trim().toLowerCase();
    const hits = records.getAll().filter((r) => {
      if (!term) return true;
      return [
        r.postOffice, r.institutionCode, r.province, r.city, r.district,
        r.postalCode, r.notes,
      ].map((v) => String(v == null ? '' : v)).join(' ').toLowerCase().includes(term);
    }).slice(0, 40);

    if (hits.length === 0) {
      els.attachList.innerHTML = '<div class="maint-empty">没有匹配的记录</div>';
      return;
    }

    els.attachList.innerHTML = hits.map((r) => `
      <button type="button" class="maint-attach-item" data-record-id="${escAttr(r.id)}">
        ${esc(r.postOffice) || '(无名称)'}
        <small>${esc([r.province, r.city, r.district].filter(Boolean).join(' / '))}
          · 机构号 ${esc(r.institutionCode || '—')} · 盖销 ${esc(r.cancelDate || '—')}</small>
      </button>
    `).join('');

    els.attachList.querySelectorAll('[data-record-id]').forEach((btn) => {
      btn.addEventListener('click', () => attachToRecord(btn.dataset.recordId));
    });
  }

  async function attachToRecord(recordId) {
    const file = state.attachFile;
    if (!file) return;
    const records = getStore('records');
    const rec = records ? records.getById(recordId) : null;
    if (!rec) { await Dialog.alert('记录不存在，可能已被删除。'); return; }

    const photos = Array.isArray(rec.photos) ? rec.photos.slice() : [];
    if (photos.includes(file.relPath)) {
      await Dialog.alert('这条记录已经引用了这张图片。');
      return;
    }
    photos.push(file.relPath);
    records.update(recordId, { photos });

    const name = rec.postOffice || '(无名称)';
    closeAttach();
    await Dialog.alert(`已挂接到「${name}」（机构号 ${rec.institutionCode || '—'}）。`);
    await refreshImages();
  }

  // ---- 预览 ----
  function openPreview(file) {
    if (!els || !els.previewOverlay) return;
    state.previewFile = file;
    els.previewTitle.textContent = file.name || '图片预览';
    els.previewImg.src = photoUrl(file.relPath);
    els.previewImg.alt = file.name || '';
    els.previewMeta.textContent = [
      file.relPath,
      fmtBytes(file.size),
      fmtDateTime(file.mtime),
      file.source === 'legacy' ? '旧目录' : '',
    ].filter(Boolean).join(' · ');
    els.previewOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closePreview() {
    if (!els || !els.previewOverlay) return false;
    const wasOpen = els.previewOverlay.classList.contains('active');
    els.previewOverlay.classList.remove('active');
    els.previewImg.src = '';
    document.body.style.overflow = '';
    state.previewFile = null;
    return wasOpen;
  }

  // ============================================================
  // 回收站
  // ============================================================
  function renderTrash() {
    if (!els || !els.trashList) return;
    const records = getStore('records');
    const list = records && typeof records.getTrash === 'function' ? records.getTrash() : [];

    if (els.trashBadge) {
      els.trashBadge.hidden = list.length === 0;
      els.trashBadge.textContent = list.length;
    }

    if (list.length === 0) {
      els.trashList.innerHTML = '<div class="maint-empty">回收站是空的。</div>';
      return;
    }

    els.trashList.innerHTML = list.map((r) => {
      const deleted = Date.parse(r.deletedAt || '');
      const left = Number.isFinite(deleted)
        ? Math.max(0, TRASH_DAYS - Math.floor((Date.now() - deleted) / 86400000))
        : TRASH_DAYS;
      return `
        <div class="maint-row">
          <span class="maint-row-main">
            <span class="maint-row-name">${esc(r.postOffice) || '(无名称)'}</span>
            <span class="maint-row-meta">
              机构号 ${esc(r.institutionCode || '—')}
              · ${esc([r.province, r.city, r.district].filter(Boolean).join(' / '))}
              · 删除于 ${esc(fmtDateTime(r.deletedAt))}
              · 剩余 ${left} 天
            </span>
          </span>
          <span class="maint-row-actions">
            <button type="button" data-trash-restore="${escAttr(r.id)}">恢复</button>
            <button type="button" data-trash-purge="${escAttr(r.id)}" class="maint-danger">彻底删除</button>
          </span>
        </div>
      `;
    }).join('');

    els.trashList.querySelectorAll('[data-trash-restore]').forEach((btn) => {
      btn.addEventListener('click', () => restoreTrash(btn.dataset.trashRestore));
    });
    els.trashList.querySelectorAll('[data-trash-purge]').forEach((btn) => {
      btn.addEventListener('click', () => purgeTrash(btn.dataset.trashPurge));
    });
  }

  async function restoreTrash(id) {
    const records = getStore('records');
    if (!records) return;
    if (records.restore(id)) {
      renderTrash();
      renderSummary();
    } else {
      await Dialog.alert('恢复失败：记录不在回收站里。');
    }
  }

  async function purgeTrash(id) {
    const ok = await Dialog.confirm('彻底删除后无法恢复，确定继续？');
    if (!ok) return;
    const records = getStore('records');
    if (records) {
      records.purgeTrash(id);
      renderTrash();
      renderSummary();
    }
  }

  async function emptyTrash() {
    const records = getStore('records');
    const n = records ? records.trashCount() : 0;
    if (n === 0) { await Dialog.alert('回收站已经是空的。'); return; }
    const ok = await Dialog.confirm(`确定清空回收站？${n} 条记录将被彻底删除，无法恢复。`);
    if (!ok) return;
    const again = await Dialog.confirm('再次确认：清空回收站？');
    if (!again) return;
    records.emptyTrash();
    renderTrash();
    renderSummary();
  }

  // ============================================================
  // 页面骨架
  // ============================================================
  function cacheEls() {
    els = {
      page: $('maintenance-page'),
      tabs: Array.from(document.querySelectorAll('.maint-tab')),
      panels: {
        backup: $('maint-panel-backup'),
        images: $('maint-panel-images'),
        trash: $('maint-panel-trash'),
      },
      summary: $('maint-summary'),
      backupDir: $('maint-backup-dir'),
      backupList: $('maint-backup-list'),
      snapshotList: $('maint-snapshot-list'),
      btnBackupCreate: $('btn-backup-create'),
      btnBackupSnapshot: $('btn-backup-snapshot'),
      btnBackupRestore: $('btn-backup-restore'),
      restoreFile: $('f-backup-restore-file'),
      imageStats: $('maint-image-stats'),
      imageDir: $('maint-image-dir'),
      imageLegacy: $('maint-image-legacy'),
      imageFilter: $('f-maint-image-filter'),
      imageSearch: $('f-maint-image-search'),
      btnImageRefresh: $('btn-maint-image-refresh'),
      btnImageMigrate: $('btn-maint-image-migrate'),
      imageGrid: $('maint-image-grid'),
      imageEmpty: $('maint-image-empty'),
      imageMore: $('btn-maint-image-more'),
      trashList: $('maint-trash-list'),
      trashBadge: $('trash-tab-badge'),
      btnTrashEmpty: $('btn-trash-empty'),
      attachOverlay: $('maint-attach-overlay'),
      attachFile: $('maint-attach-file'),
      attachSearch: $('f-maint-attach-search'),
      attachList: $('maint-attach-list'),
      previewOverlay: $('maint-preview-overlay'),
      previewTitle: $('maint-preview-title'),
      previewImg: $('maint-preview-img'),
      previewMeta: $('maint-preview-meta'),
    };
  }

  function setTab(key) {
    const tab = els.panels[key] ? key : 'backup';
    state.tab = tab;
    els.tabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.maintTab === tab));
    Object.keys(els.panels).forEach((k) => {
      if (els.panels[k]) els.panels[k].hidden = k !== tab;
    });

    if (tab === 'backup') refreshBackupPanel().catch((e) => console.warn('[Maintenance] 刷新备份面板失败:', e));
    else if (tab === 'images') refreshImages();
    else if (tab === 'trash') renderTrash();
  }

  function init() {
    if (inited) return;
    inited = true;
    cacheEls();
    if (!els.page) return;

    els.tabs.forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.maintTab));
    });

    if (els.btnBackupCreate) els.btnBackupCreate.addEventListener('click', createPackage);
    if (els.btnBackupSnapshot) els.btnBackupSnapshot.addEventListener('click', saveSnapshot);
    if (els.btnBackupRestore && els.restoreFile) {
      els.btnBackupRestore.addEventListener('click', () => els.restoreFile.click());
      els.restoreFile.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        await restoreFromFile(file);
      });
    }

    if (els.imageFilter) {
      els.imageFilter.addEventListener('change', () => {
        state.imageFilter = els.imageFilter.value;
        state.imageShown = IMAGE_PAGE_SIZE;
        renderImages();
      });
    }
    if (els.imageSearch) {
      let timer = null;
      els.imageSearch.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.imageKeyword = els.imageSearch.value;
          state.imageShown = IMAGE_PAGE_SIZE;
          renderImages();
        }, 200);
      });
    }
    if (els.btnImageRefresh) els.btnImageRefresh.addEventListener('click', refreshImages);
    if (els.btnImageMigrate) els.btnImageMigrate.addEventListener('click', migrateLegacyImages);
    if (els.imageMore) {
      els.imageMore.addEventListener('click', () => {
        state.imageShown += IMAGE_PAGE_SIZE;
        renderImages();
      });
    }

    if (els.btnTrashEmpty) els.btnTrashEmpty.addEventListener('click', emptyTrash);

    // 挂接弹窗
    const attachClose = $('maint-attach-close');
    const attachCancel = $('maint-attach-cancel');
    if (attachClose) attachClose.addEventListener('click', closeAttach);
    if (attachCancel) attachCancel.addEventListener('click', closeAttach);
    if (els.attachOverlay) {
      els.attachOverlay.addEventListener('click', (e) => {
        if (e.target === els.attachOverlay) closeAttach();
      });
    }
    if (els.attachSearch) {
      els.attachSearch.addEventListener('input', () => renderAttachList(els.attachSearch.value));
    }

    // 预览弹窗
    const previewClose = $('maint-preview-close');
    if (previewClose) previewClose.addEventListener('click', closePreview);
    if (els.previewOverlay) {
      els.previewOverlay.addEventListener('click', (e) => {
        if (e.target === els.previewOverlay) closePreview();
      });
    }

    // 记录变化（新增 / 编辑 / 删除 / 恢复）→ 图片页的「已引用」标记要跟着变。
    // 只重算本地引用集合，不重新请求文件列表。
    if (typeof RecordStore !== 'undefined' && typeof RecordStore.onChange === 'function') {
      RecordStore.onChange(() => {
        if (!els || !els.page) return;
        if (state.tab !== 'images') return;
        state.refs = referencedSet();
        renderImages();
      });
    }
  }

  // ============================================================
  // 对外接口
  // ============================================================
  function show() {
    if (!els) init();
    if (!els || !els.page) return;
    els.page.style.display = 'flex';
    setTab(state.tab || 'backup');
  }

  function hide() {
    if (!els || !els.page) return;
    closeAttach();
    closePreview();
    els.page.style.display = 'none';
  }

  /** 关闭叠在页面上的弹窗（Esc 处理用）；返回 true 表示确实关了一个 */
  function closeModal() {
    if (!els) return false;
    if (closeAttach()) return true;
    if (closePreview()) return true;
    return false;
  }

  /**
   * 启动自动快照：数据没变且 6 小时内已经存过就跳过。
   * 失败只打日志，不影响应用启动。
   */
  async function autoSnapshotOnStart() {
    try {
      const tables = gatherTables();
      const total = tables.records.length + tables.meters.length + tables.mails.length + tables.returns.length;
      if (total === 0) return null;

      const sig = quickSig(JSON.stringify(tables));
      let meta = null;
      try { meta = JSON.parse(localStorage.getItem(AUTOSNAPSHOT_META_KEY) || 'null'); } catch (e) { meta = null; }
      if (meta && meta.sig === sig && Date.now() - Number(meta.at || 0) < AUTOSNAPSHOT_INTERVAL_MS) {
        return null;
      }

      const res = await postJson(API.backupSnapshot, { tables, reason: 'startup' });
      try {
        localStorage.setItem(AUTOSNAPSHOT_META_KEY, JSON.stringify({ sig, at: Date.now(), name: res.name }));
      } catch (e) { /* 隐私模式忽略 */ }
      return res;
    } catch (e) {
      console.warn('[Maintenance] 启动自动快照失败:', e);
      return null;
    }
  }

  /**
   * 破坏性操作前手动落一份快照（清空记录 / 批量删除）。
   * @param {string} reason
   * @returns {Promise<object|null>} 失败时返回 null（不阻断原操作）
   */
  async function snapshotBeforeDestructive(reason) {
    try {
      const tables = gatherTables();
      const total = tables.records.length + tables.meters.length + tables.mails.length + tables.returns.length;
      if (total === 0) return { skipped: true };
      return await postJson(API.backupSnapshot, { tables, reason: reason || 'before-destructive' });
    } catch (e) {
      console.warn('[Maintenance] 操作前快照失败:', e);
      return null;
    }
  }

  window.MaintenancePage = {
    show,
    hide,
    closeModal,
    autoSnapshotOnStart,
    snapshotBeforeDestructive,
    refresh: refreshBackupPanel,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
