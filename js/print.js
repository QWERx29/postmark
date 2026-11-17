/**
 * 打印 / 贴片 — 把日戳记录排成可打印的卡片
 * ==========================================
 * 依赖: RecordStore（格式化戳号 / 状态）、Dialog（提示）
 *
 * 为什么用 iframe 而不是新窗口
 * ----------------------------
 * 浏览器可能拦截 window.open；Electron / Tauri 里另开窗口又要处理生命周期。
 * 这里把一个隐藏 iframe 写满打印 HTML，等图片加载完再调它的 print()，
 * 用户在打印对话框里选「另存为 PDF」即可得到贴片 PDF。
 *
 * 版式
 * ----
 *   - 按「省 / 年 / 邮局」分组，组标题不落单；
 *   - 每张卡片 = 一张缩略图 + 邮局 / 区划 / 机构号 / 盖销日期 / 戳号材质 / 备注；
 *   - 卡片 break-inside: avoid，不会从中间被切到两页；
 *   - 每行 2 / 3 / 4 张可选，A4 纵向。
 *
 * 对外接口: window.PrintPage
 */
(function () {

  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = {
    open: '营业',
    delivery: '投递部',
    closed: '已撤销',
    themed: '主题邮局',
    temporary: '临时邮局',
  };

  const GROUP_OPTIONS = [
    { value: 'province', label: '按省' },
    { value: 'year', label: '按年' },
    { value: 'office', label: '按邮局' },
  ];

  const state = {
    records: [],
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

  function photoUrl(relPath) {
    return '/images/' + String(relPath == null ? '' : relPath)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }

  function fileNameOf(relPath) {
    const s = String(relPath == null ? '' : relPath);
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** 盖销日期显示：10 位 YYYYMMDDHH / 旧格式 YYYY.MM.DD.HH */
  function fmtDate(val) {
    const s = String(val == null ? '' : val);
    if (/^\d{10}$/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:00`;
    }
    if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      return s.replace(/\./g, '-').replace(/-(\d{2})$/, ' $1:00');
    }
    return s;
  }

  function dateKey(rec) {
    return String(rec.cancelDate == null ? '' : rec.cancelDate).replace(/\D/g, '');
  }

  function locOf(rec) {
    return [rec.province, rec.city, rec.district].filter(Boolean).join(' / ');
  }

  function stampText(rec) {
    if (typeof RecordStore !== 'undefined' && typeof RecordStore.formatStamps === 'function') {
      return RecordStore.formatStamps(rec, '、');
    }
    const numbers = Array.isArray(rec.stampNumbers) ? rec.stampNumbers : [];
    return numbers.map((n) => n || '无戳号').join('、');
  }

  function photosOf(rec) {
    return Array.isArray(rec.photos)
      ? rec.photos.filter((p) => typeof p === 'string' && p.trim())
      : [];
  }

  function groupKey(rec, mode) {
    if (mode === 'year') {
      const key = dateKey(rec).slice(0, 4);
      return key || '未记录年份';
    }
    if (mode === 'office') {
      const name = [rec.province, rec.city, rec.district, rec.postOffice]
        .filter(Boolean).join(' / ');
      return name || '(无名称)';
    }
    return rec.province || '(未填写省份)';
  }

  // ============================================================
  // 选项弹窗
  // ============================================================
  function cacheEls() {
    els = {
      overlay: $('print-overlay'),
      summary: $('print-summary'),
      group: $('print-group'),
      cols: $('print-cols'),
      withImages: $('print-with-images'),
      onlyPhotos: $('print-only-photos'),
      startBtn: $('print-start'),
    };
  }

  function syncOptions() {
    if (!els) return;
    const withImages = els.withImages ? els.withImages.checked : true;
    if (els.onlyPhotos) {
      els.onlyPhotos.disabled = !withImages;
      if (!withImages) els.onlyPhotos.checked = false;
    }
  }

  function renderSummary() {
    if (!els || !els.summary) return;
    const total = state.records.length;
    const withPhotos = state.records.filter((r) => photosOf(r).length > 0).length;
    els.summary.textContent = `共 ${total} 条记录，其中 ${withPhotos} 条有图片。`
      + (total === 0 ? '当前筛选结果为空，请先调整筛选条件。' : '打印时按当前筛选结果排版。');
  }

  function open(records) {
    if (!inited) init();
    if (!els || !els.overlay) return;
    state.records = Array.isArray(records) ? records.slice() : [];
    renderSummary();
    syncOptions();
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!els || !els.overlay) return false;
    const wasOpen = els.overlay.classList.contains('active');
    els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    return wasOpen;
  }

  // ============================================================
  // 生成打印 HTML
  // ============================================================
  function cardHtml(rec, opts) {
    const photos = photosOf(rec);
    const withImages = opts.withImages;

    let figure = '';
    if (withImages) {
      if (photos.length > 0) {
        const more = photos.length > 1 ? `<span class="print-more">+${photos.length - 1}</span>` : '';
        figure = `<div class="print-figure">
          <img src="${escAttr(photoUrl(photos[0]))}" alt="${escAttr(fileNameOf(photos[0]))}">
          ${more}
        </div>`;
      } else {
        figure = '<div class="print-figure print-figure-empty">无图片</div>';
      }
    }

    const status = STATUS_LABEL[rec.status] || rec.status || '';
    const notes = String(rec.notes || '').trim();

    return `
      <article class="print-card">
        ${figure}
        <div class="print-card-body">
          <div class="print-card-title">${esc(rec.postOffice) || '(无名称)'}</div>
          <div class="print-card-loc">${esc(locOf(rec)) || '-'}</div>
          <div class="print-card-line">机构号：${esc(rec.institutionCode) || '-'}　邮编：${esc(rec.postalCode) || '-'}</div>
          <div class="print-card-line">盖销：${esc(fmtDate(rec.cancelDate)) || '-'}　${esc(status)}</div>
          <div class="print-card-line print-card-stamps">戳号：${esc(stampText(rec)) || '-'}</div>
          ${notes ? `<div class="print-card-notes">${esc(notes)}</div>` : ''}
        </div>
      </article>`;
  }

  function buildHtml(records, opts) {
    const groups = new Map();
    records.forEach((rec) => {
      const key = groupKey(rec, opts.group);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    });

    const keys = Array.from(groups.keys()).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
    const sections = keys.map((key) => {
      const list = groups.get(key).slice().sort((a, b) => {
        const d = dateKey(a).localeCompare(dateKey(b));
        if (d !== 0) return d;
        return String(a.postOffice || '').localeCompare(String(b.postOffice || ''), 'zh-Hans-CN');
      });
      const cards = list.map((rec) => cardHtml(rec, opts)).join('');
      return `<section class="print-group">
        <h2>${esc(key)} <span class="print-group-count">${list.length} 条</span></h2>
        <div class="print-grid print-cols-${opts.cols}">${cards}</div>
      </section>`;
    }).join('');

    const groupLabel = (GROUP_OPTIONS.find((o) => o.value === opts.group) || GROUP_OPTIONS[0]).label;
    const generated = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${generated.getFullYear()}-${pad(generated.getMonth() + 1)}-${pad(generated.getDate())} `
      + `${pad(generated.getHours())}:${pad(generated.getMinutes())}`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>日戳记录贴片</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    color: #111;
    font-size: 10pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .print-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8mm;
    padding-bottom: 2mm;
    border-bottom: 1.2pt solid #222;
    margin-bottom: 4mm;
  }
  .print-head h1 { margin: 0; font-size: 16pt; letter-spacing: .5mm; }
  .print-sub { font-size: 8.5pt; color: #555; text-align: right; line-height: 1.6; }
  .print-group { margin-bottom: 5mm; }
  .print-group h2 {
    margin: 0 0 2.5mm;
    padding-bottom: 1mm;
    font-size: 11pt;
    border-bottom: .6pt solid #999;
    break-after: avoid;
    page-break-after: avoid;
  }
  .print-group-count { font-size: 8.5pt; font-weight: 400; color: #777; margin-left: 2mm; }
  .print-grid { display: grid; gap: 3.5mm; }
  .print-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .print-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .print-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .print-card {
    border: .6pt solid #999;
    border-radius: 1.5mm;
    overflow: hidden;
    break-inside: avoid;
    page-break-inside: avoid;
    background: #fff;
  }
  .print-figure {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    background: #f2f2f2;
    border-bottom: .4pt solid #ddd;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .print-figure img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .print-figure-empty { color: #aaa; font-size: 9pt; }
  .print-more {
    position: absolute;
    right: 1mm;
    bottom: 1mm;
    padding: 0 1.4mm;
    border-radius: 2mm;
    background: rgba(0, 0, 0, .55);
    color: #fff;
    font-size: 7.5pt;
    line-height: 4mm;
  }
  .print-card-body { padding: 2mm 2.4mm 2.2mm; }
  .print-card-title {
    font-size: 10pt;
    font-weight: 700;
    line-height: 1.35;
    margin-bottom: .8mm;
    word-break: break-all;
  }
  .print-card-loc { font-size: 8pt; color: #555; margin-bottom: 1.2mm; word-break: break-all; }
  .print-card-line { font-size: 8pt; line-height: 1.55; color: #333; word-break: break-all; }
  .print-card-stamps { color: #111; }
  .print-card-notes {
    margin-top: 1mm;
    padding-top: 1mm;
    border-top: .4pt dashed #ddd;
    font-size: 7.5pt;
    line-height: 1.45;
    color: #666;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .print-group + .print-group { margin-top: 6mm; }
</style>
</head>
<body>
  <header class="print-head">
    <h1>日戳记录贴片</h1>
    <div class="print-sub">
      分组：${esc(groupLabel)}　共 ${records.length} 条<br>
      生成时间：${esc(stamp)}
    </div>
  </header>
  ${sections || '<p>没有可打印的记录。</p>'}
</body>
</html>`;
  }

  // ============================================================
  // 打印
  // ============================================================
  function printHtml(html) {
    const old = document.getElementById('print-frame');
    if (old) old.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'print-frame';
    iframe.setAttribute('aria-hidden', 'true');
    // 不能 visibility:hidden（部分内核会印出空白），移到屏幕外即可
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;height:1160px;border:0;';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        console.error('[Print] 调用打印失败:', e);
      }
      setTimeout(() => {
        try { iframe.remove(); } catch (e) { /* ignore */ }
      }, 60000);
    };

    const images = Array.from(doc.images || []);
    if (images.length === 0) {
      setTimeout(doPrint, 250);
      return;
    }

    let pending = images.length;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      doPrint();
    }, 8000);

    const onOne = () => {
      pending--;
      if (pending > 0 || finished) return;
      finished = true;
      clearTimeout(timer);
      setTimeout(doPrint, 150);
    };

    images.forEach((img) => {
      if (img.complete) { onOne(); return; }
      img.addEventListener('load', onOne);
      img.addEventListener('error', onOne);
    });
  }

  async function start() {
    if (!els) cacheEls();
    if (!state.records.length) {
      Dialog.alert('当前没有可打印的记录。');
      return;
    }

    const opts = {
      group: els.group ? els.group.value : 'province',
      cols: Number(els.cols ? els.cols.value : 3) || 3,
      withImages: els.withImages ? els.withImages.checked : true,
    };

    let list = state.records.slice();
    if (opts.withImages && els.onlyPhotos && els.onlyPhotos.checked) {
      list = list.filter((r) => photosOf(r).length > 0);
    }
    if (list.length === 0) {
      Dialog.alert('没有符合打印条件的记录（可能勾选了「只打印有图片的记录」）。');
      return;
    }

    if (list.length > 500) {
      const ok = await Dialog.confirm(
        `本次将排版 ${list.length} 条记录，图片较多时打印可能需要较长时间。\n\n继续吗？`
      );
      if (!ok) return;
    }

    close();
    printHtml(buildHtml(list, opts));
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    if (inited) return;
    inited = true;
    cacheEls();
    if (!els.overlay) return;

    if (els.group) {
      els.group.innerHTML = GROUP_OPTIONS
        .map((o) => `<option value="${o.value}">${esc(o.label)}</option>`)
        .join('');
    }
    if (els.cols) {
      els.cols.innerHTML = [2, 3, 4]
        .map((n) => `<option value="${n}"${n === 3 ? ' selected' : ''}>每行 ${n} 张</option>`)
        .join('');
    }

    const closeBtn = $('print-close');
    const cancelBtn = $('print-cancel');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) close();
      });
    }
    if (els.withImages) els.withImages.addEventListener('change', syncOptions);
    if (els.startBtn) els.startBtn.addEventListener('click', start);
  }

  window.PrintPage = {
    open,
    close,
    start,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
