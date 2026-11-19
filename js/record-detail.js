/**
 * 记录详情弹窗
 * =============
 * 依赖: RecordStore / EntryForm / Dialog
 *
 * 为什么单独做弹窗而不是直接进编辑表单
 * ------------------------------------
 * 编辑态会把「看」和「改」混在一起：只想核对照片 / 邮资机 / 备注时，
 * 打开一个满屏表单既慢又容易误改。这里用居中弹窗集中展示：
 *   - 日戳字段与照片（点击看大图）
 *   - 「编辑记录」后续动作
 *
 * 对外接口: window.RecordDetail
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

  let els = null;
  let inited = false;
  let currentId = '';
  let currentPhotos = [];

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

  function fmtTime(val) {
    if (!val) return '';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function locOf(rec) {
    return [rec.province, rec.city, rec.district].filter(Boolean).join(' / ');
  }

  function stampText(rec) {
    if (typeof RecordStore !== 'undefined' && typeof RecordStore.formatStamps === 'function') {
      return RecordStore.formatStamps(rec, '、');
    }
    const list = Array.isArray(rec.stampNumbers) ? rec.stampNumbers : [];
    return list.map((n) => n || '无戳号').join('、');
  }

  function photoList(rec) {
    return Array.isArray(rec.photos)
      ? rec.photos.filter((p) => typeof p === 'string' && p.trim())
      : [];
  }

  // ============================================================
  // 渲染
  // ============================================================
  function row(label, value, placeholder) {
    const text = value == null ? '' : String(value).trim();
    if (!text && !placeholder) return '';
    return `<div class="record-detail-line">
      <span class="record-detail-label">${esc(label)}</span>
      <span class="record-detail-value${text ? '' : ' is-empty'}">${esc(text || placeholder || '—')}</span>
    </div>`;
  }

  function renderPhotos(rec) {
    const photos = photoList(rec);
    if (photos.length === 0) {
      return '<div class="record-detail-empty">这条记录还没有图片</div>';
    }
    return `<div class="record-detail-photos">${photos.map((p, i) => `
      <button type="button" class="record-detail-photo" data-photo-idx="${i}" title="点击看大图">
        <img src="${escAttr(photoUrl(p))}" alt="${escAttr(p)}" loading="lazy">
      </button>`).join('')}</div>`;
  }

  function render(rec) {
    const title = $('record-detail-title');
    const sub = $('record-detail-sub');
    const body = $('record-detail-body');
    if (!body) return;

    currentId = rec.id;
    currentPhotos = photoList(rec);

    if (title) title.textContent = rec.postOffice || '(无名称)';
    if (sub) {
      sub.innerHTML = `${esc(locOf(rec)) || '—'}`
        + `<span class="record-detail-status">${esc(STATUS_LABEL[rec.status] || rec.status || '—')}</span>`;
    }

    const meter = rec.hasPostageMeter
      ? [rec.meterModel, rec.meterNo, rec.meterHeader, rec.meterLowerRing].filter(Boolean).join(' · ')
      : '';
    const scenic = Array.isArray(rec.scenicNames) ? rec.scenicNames.filter(Boolean) : [];

    const rows = [
      row('机构号', rec.institutionCode),
      row('邮政编码', rec.postalCode),
      row('盖销日期', fmtDate(rec.cancelDate)),
      row('戳号 / 材质', stampText(rec)),
      rec.hasPostageMeter ? row('邮资机', meter, '（已标记，未填型号 / 编号）') : '',
      rec.hasScenicPostmark ? row('风景 / 文化日戳', scenic.join('、'), '（已标记，未填名称）') : '',
      row('图片', currentPhotos.length ? `${currentPhotos.length} 张` : '', '无'),
      row('录入时间', fmtTime(rec.createdAt)),
      row('备注', rec.notes, '无'),
    ].filter(Boolean).join('');

    body.innerHTML = `
      <section class="record-detail-section">
        <h3>照片</h3>
        ${renderPhotos(rec)}
      </section>
      <section class="record-detail-section">
        <h3>日戳信息</h3>
        <div class="record-detail-lines">${rows}</div>
      </section>
    `;

    body.querySelectorAll('[data-photo-idx]').forEach((btn) => {
      btn.addEventListener('click', () => openPhoto(Number(btn.dataset.photoIdx)));
    });
  }

  // ============================================================
  // 照片大图
  // ============================================================
  function openPhoto(index) {
    const rel = currentPhotos[index];
    if (!rel) return;
    const overlay = $('record-photo-overlay');
    const img = $('record-photo-img');
    if (!overlay || !img) return;
    img.src = photoUrl(rel);
    img.alt = rel;
    overlay.classList.add('active');
  }

  function closePhoto() {
    const overlay = $('record-photo-overlay');
    const img = $('record-photo-img');
    if (overlay) overlay.classList.remove('active');
    if (img) img.src = '';
  }

  // ============================================================
  // 开关
  // ============================================================
  function cacheEls() {
    els = {
      overlay: $('record-detail-overlay'),
      closeBtn: $('record-detail-close'),
      okBtn: $('record-detail-ok'),
      editBtn: $('record-detail-edit'),
      photoOverlay: $('record-photo-overlay'),
      photoClose: $('record-photo-close'),
    };
  }

  function open(idOrRecord) {
    if (!inited) init();
    const rec = typeof idOrRecord === 'object' && idOrRecord
      ? idOrRecord
      : (typeof RecordStore !== 'undefined' ? RecordStore.getById(idOrRecord) : null);
    if (!rec) {
      if (typeof Dialog !== 'undefined') Dialog.alert('记录不存在，可能已被删除。');
      return false;
    }
    if (!els || !els.overlay) return false;
    render(rec);
    els.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    return true;
  }

  function close() {
    if (!els || !els.overlay) return false;
    const wasOpen = els.overlay.classList.contains('active');
    closePhoto();
    els.overlay.classList.remove('active');
    document.body.style.overflow = '';
    currentId = '';
    return wasOpen;
  }

  function init() {
    if (inited) return;
    inited = true;
    cacheEls();
    if (!els || !els.overlay) return;

    if (els.closeBtn) els.closeBtn.addEventListener('click', close);
    if (els.okBtn) els.okBtn.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', (e) => {
        if (e.target === els.overlay) close();
      });
    }
    if (els.photoClose) els.photoClose.addEventListener('click', closePhoto);
    if (els.photoOverlay) {
      els.photoOverlay.addEventListener('click', (e) => {
        if (e.target === els.photoOverlay) closePhoto();
      });
    }

    if (els.editBtn) {
      els.editBtn.addEventListener('click', () => {
        const rec = currentId && typeof RecordStore !== 'undefined' ? RecordStore.getById(currentId) : null;
        if (!rec) { close(); return; }
        close();
        if (typeof EntryForm !== 'undefined' && typeof EntryForm.open === 'function') {
          EntryForm.open(rec);
        }
      });
    }
  }

  window.RecordDetail = {
    open,
    close,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
