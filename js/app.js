/**
 * 主应用 — 协调地图、统计面板、数据录入
 * =======================================
 * 依赖: MapView, StatsView, PostmarkData, RecordStore, EntryForm
 */

(async function () {

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // DOM 引用
  // ============================================================
  const loadingEl = $('loading-overlay');
  const btnBack = $('btn-zoom-back');
  const breadcrumb = $('breadcrumb');
  const mapTitle = $('map-title');

  // ============================================================
  // 侧边栏：折叠 / 展开 + 导航高亮
  // ============================================================
  const SIDEBAR_KEY = 'postmark_sidebar_collapsed';
  const appShell = $('app-shell');
  const btnSidebarToggle = $('btn-sidebar-toggle');
  const navItems = Array.from(document.querySelectorAll('#sidebar .nav-item'));
  const postalNavToggle = $('btn-toggle-postal');
  const postalSubnav = $('postal-subnav');

  /** 港澳台网点默认折叠；父项与普通 nav-item 同款，点击展开/收起子项 */
  function setPostalNavExpanded(expanded) {
    if (!postalNavToggle || !postalSubnav) return;
    postalNavToggle.setAttribute('aria-expanded', String(!!expanded));
    postalSubnav.hidden = !expanded;
  }

  /** 折叠状态只落在 #app-shell 的类上，布局与动画都在 CSS 里 */
  function setSidebarCollapsed(collapsed, persist) {
    appShell.classList.toggle('sidebar-collapsed', collapsed);
    btnSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    btnSidebarToggle.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
    if (persist) {
      try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
    }
  }

  /** 高亮当前页面；pageKey 传 null 表示不高亮任何项（正常情况下总会有值） */
  function setActiveNav(pageKey) {
    navItems.forEach(el => {
      el.classList.toggle('active', !!pageKey && el.dataset.page === pageKey);
    });
  }

  (function initSidebar() {
    let stored = null;
    try { stored = localStorage.getItem(SIDEBAR_KEY); } catch (e) { /* ignore */ }
    // 窄屏默认折叠，否则抽屉会直接盖住内容
    const collapsed = stored === null ? window.innerWidth <= 900 : stored === '1';
    setSidebarCollapsed(collapsed, false);
    // 港澳台网点二级菜单默认收起
    setPostalNavExpanded(false);
    // 启动即地图总览
    setActiveNav('overview');
  })();

  if (postalNavToggle && postalSubnav) {
    postalNavToggle.addEventListener('click', () => {
      setPostalNavExpanded(postalNavToggle.getAttribute('aria-expanded') !== 'true');
    });
  }

  btnSidebarToggle.addEventListener('click', () => {
    setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'), true);
    // 侧边栏宽度动画结束后，统计页的 ECharts 需要按新宽度重算
    if (typeof StatisticsPage !== 'undefined' && StatisticsPage.isVisible()) {
      setTimeout(() => StatisticsPage.resize(), 260);
    }
  });

  // ============================================================
  // 面包屑导航
  // ============================================================
  function updateBreadcrumb(level, provinceName) {
    if (level === 'nation') {
      breadcrumb.innerHTML = `<span class="crumb active" data-level="nation">全国</span>`;
    } else if (level === 'city') {
      breadcrumb.innerHTML = `
        <span class="crumb" data-level="nation">全国</span>
        <span class="sep">›</span>
        <span class="crumb active" data-level="province">${provinceName || '省份'}</span>
      `;
    }
    breadcrumb.querySelectorAll('.crumb[data-level]').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.level === 'nation') drillUp();
      });
    });
  }

  // ============================================================
  // 钻取控制
  // ============================================================
  async function drillToProvince(adcode, name) {
    btnBack.disabled = false;
    mapTitle.textContent = `${name} — 邮局日戳收集进度`;
    updateBreadcrumb('city', name);
    StatsView.update('city', adcode);
    await MapView.drillToProvince(adcode);
  }

  async function drillUp() {
    btnBack.disabled = true;
    mapTitle.textContent = '全国邮局日戳收集进度';
    updateBreadcrumb('nation', null);
    StatsView.update('nation', null);
    await MapView.backToNation();
  }

  // ============================================================
  // 刷新所有视图
  // ============================================================
  /**
   * 只刷新统计面板。
   * 排名表的「总计」取自参考库里的邮政官网网点数，参考库一变就要重算；
   * 地图着色只看已收集数量，与网点总数无关，因此这里不动地图。
   */
  function refreshStatsOnly() {
    const level = MapView.getCurrentLevel();
    if (level === 'province') {
      StatsView.update('nation', null);
    } else {
      StatsView.update('city', MapView.getCurrentProvince());
    }
  }

  function refreshAllViews() {
    refreshStatsOnly();
    // 重新渲染地图
    const level = MapView.getCurrentLevel();
    if (level === 'province') {
      MapView.backToNation();
    } else {
      MapView.drillToProvince(MapView.getCurrentProvince());
    }
  }

  /** 统计页可见时才重绘，隐藏时留到下次进入页面再汇总 */
  function refreshStatisticsIfVisible() {
    if (typeof StatisticsPage !== 'undefined' && StatisticsPage.isVisible()) {
      StatisticsPage.refresh();
    }
  }

  // ============================================================
  // 地图回调
  // ============================================================
  MapView.onProvinceClick(async (adcode, name) => {
    await drillToProvince(adcode, name);
  });

  MapView.onCityClick((adcode, name, provinceAdcode) => {
    console.log(`城市点击: ${name} (${adcode})`);
  });

  MapView.onMapReady((level, provinceAdcode, provinceName) => {
    if (level === 'nation') {
      updateBreadcrumb('nation', null);
      mapTitle.textContent = '全国邮局日戳收集进度';
    }
  });

  btnBack.addEventListener('click', drillUp);

  // ============================================================
  // 数据录入按钮
  // ============================================================
  $('btn-add-record').addEventListener('click', () => EntryForm.open());
  $('btn-add-record-fab').addEventListener('click', () => EntryForm.open());

  // ============================================================
  // 记录变化时刷新
  // ============================================================
  RecordStore.onChange(() => {
    refreshAllViews();
    refreshStatisticsIfVisible();
    if (recordsPageOpen) renderRecordsTable(recordsSearch.value);
    // 新增/修改记录后，港澳台查询页的「已收集」标绿要立即跟着变
    if (postalSearchPageOpen && typeof PostalPage !== 'undefined') PostalPage.refreshSearch();
  });

  // 邮资机戳 / 邮件 / 国际退信也有自己的数据表，统计页打开时跟着刷新
  if (typeof MeterStore !== 'undefined' && typeof MeterStore.onChange === 'function') {
    MeterStore.onChange(refreshStatisticsIfVisible);
  }
  if (typeof MailStore !== 'undefined' && typeof MailStore.onChange === 'function') {
    MailStore.onChange(refreshStatisticsIfVisible);
  }
  if (typeof ReturnStore !== 'undefined' && typeof ReturnStore.onChange === 'function') {
    ReturnStore.onChange(refreshStatisticsIfVisible);
  }

  // 港澳台抓取完成/重新载入后，首页排名表的「总计」要跟着变
  window.addEventListener('postal-data-changed', () => {
    refreshStatsOnly();
    refreshStatisticsIfVisible();
    if (postalSearchPageOpen && typeof PostalPage !== 'undefined') PostalPage.refreshSearch();
  });

  // ============================================================
  // 记录列表独立页面 + 批量编辑
  // ============================================================
  let recordsPageOpen = false;
  let batchModalOpen = false;
  let toolsPageOpen = false;
  let activeToolPage = null;
  let poSearchPageOpen = false;
  let crawlerPageOpen = false;
  let postalSearchPageOpen = false;
  let postalCrawlerPageOpen = false;
  let mailPageOpen = false;
  let meterPageOpen = false;
  let galleryPageOpen = false;
  let statisticsPageOpen = false;
  let maintenancePageOpen = false;
  const toolsPage = $('tools-page');
  const poSearchPage = $('po-search-page');
  const crawlerPage = $('crawler-page');
  const postalSearchPage = $('postal-search-page');
  const postalCrawlerPage = $('postal-crawler-page');
  const mailPage = $('mail-page');
  const meterPage = $('meter-page');
  const galleryPage = $('gallery-page');
  const statisticsPage = $('statistics-page');
  const maintenancePage = $('maintenance-page');
  const mailPageTitle = $('mail-page-title');
  const mailPlaceholderTitle = $('mail-placeholder-title');
  const mailPlaceholderCard = $('mail-placeholder-card');
  const mailTrackCard = $('mail-track-card');
  const mailListCard = $('mail-list-card');
  const mailReturnCard = $('mail-return-card');
  const recordsPage = $('records-page');
  const recordsTbody = $('records-tbody');
  const recordsTbodyScroll = $('records-tbody-scroll');
  const recordsCount = $('records-count');
  const recordsSearch = $('f-records-search');
  const recordsProvince = $('f-records-province');
  const recordsCity = $('f-records-city');
  const recordsDistrict = $('f-records-district');
  const recordsPager = $('records-pager');
  const recordsPagerInfo = $('records-pager-info');
  const btnRecordsLoadMore = $('btn-records-load-more');
  /** 「全部记录」每次渲染的行数；未筛选时先只渲染这么多 */
  const RECORDS_PAGE_SIZE = 50;
  let recordsShown = RECORDS_PAGE_SIZE;
  let filterProvince = '';
  let filterCity = '';
  let filterDistrict = '';
  const batchOverlay = $('batch-overlay');
  const batchCountLabel = $('batch-count-label');

  // 批量编辑 DOM
  const bf = {};
  function cacheBatchDoms() {
    bf.province   = $('bf-province');
    bf.city       = $('bf-city');
    bf.district   = $('bf-district');
    bf.districtContainer = $('bf-district-container');
    bf.cancelDate = $('bf-canceldate');
    bf.material   = $('bf-material');
    bf.notes      = $('bf-notes');
  }

  function showRecordsPage() {
    recordsPageOpen = true;
    // 收起其它页面（侧边栏随时可点，这里必须保证同一时刻只有一个页面）
    if (statisticsPageOpen) hideStatisticsPage();
    if (toolsPageOpen) hideToolsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    // 隐藏主视图，显示记录页
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    recordsPage.style.display = 'flex';
    // 填充省份筛选下拉
    const provs = PostmarkData.getAllProvinces();
    recordsProvince.innerHTML = '<option value="">全部省份</option>';
    provs.forEach(p => {
      recordsProvince.innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });
    recordsProvince.value = filterProvince || '';
    // 填充城市筛选下拉
    populateRecordsCity();
    // 填充区县筛选下拉
    populateRecordsDistrict();
    renderRecordsTable(recordsSearch.value, { reset: true });
    setActiveNav('records');
  }

  function populateRecordsCity() {
    recordsCity.innerHTML = '<option value="">全部城市</option>';
    if (recordsProvince.value) {
      const cities = PostmarkData.getProvinceCityNames(recordsProvince.value);
      cities.forEach(c => {
        recordsCity.innerHTML += `<option value="${c}">${c}</option>`;
      });
      recordsCity.disabled = false;
    } else {
      recordsCity.disabled = true;
    }
    if (filterCity) recordsCity.value = filterCity;
  }

  function populateRecordsDistrict() {
    recordsDistrict.innerHTML = '<option value="">全部区县</option>';
    if (recordsCity.value) {
      const dists = PostmarkData.getDistricts(recordsCity.value);
      dists.forEach(d => {
        recordsDistrict.innerHTML += `<option value="${d}">${d}</option>`;
      });
      recordsDistrict.disabled = false;
    } else {
      recordsDistrict.disabled = true;
    }
    if (filterDistrict) recordsDistrict.value = filterDistrict;
  }

  function hideRecordsPage() {
    recordsPageOpen = false;
    // 恢复主视图
    recordsPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    // 重置筛选条件
    filterProvince = '';
    filterCity = '';
    filterDistrict = '';
    recordsProvince.value = '';
    recordsCity.innerHTML = '<option value="">全部城市</option>';
    recordsCity.disabled = true;
    recordsDistrict.innerHTML = '<option value="">全部区县</option>';
    recordsDistrict.disabled = true;
    recordsSearch.value = '';
    recordsShown = RECORDS_PAGE_SIZE;
    setActiveNav('overview');
  }

  function getSelectedIds() {
    const checked = recordsTbody.querySelectorAll('.rec-select:checked');
    return Array.from(checked).map(cb => cb.dataset.id);
  }

  function updateBatchBar() {
    const ids = getSelectedIds();
    const bar = $('batch-bar');
    if (ids.length > 0) {
      bar.style.display = 'inline';
      $('batch-count').textContent = ids.length;
    } else {
      bar.style.display = 'none';
    }
  }

  /**
   * 渲染「全部记录」。
   * 未筛选时默认只渲染前 RECORDS_PAGE_SIZE 条，避免一次插入大量 DOM；
   * 点「加载更多」继续渲染下一页，选择省份 / 搜索时回到第一页。
   */
  function filterRecords(all, filter) {
    const term = String(filter == null ? '' : filter).trim();
    return all.filter(r => {
      // 文本搜索（邮局名 / 机构号；字段缺失时按空串处理，不抛错）
      if (term) {
        const office = String(r.postOffice || '');
        const inst = String(r.institutionCode || '');
        if (!office.includes(term) && !inst.includes(term)) return false;
      }
      // 省份筛选
      if (filterProvince && r.province !== filterProvince) return false;
      // 城市筛选
      if (filterCity && r.city !== filterCity) return false;
      // 区县筛选
      if (filterDistrict && r.district !== filterDistrict) return false;
      return true;
    });
  }

  /** 当前「全部记录」页的筛选结果（打印 / 贴片按它排版） */
  function getFilteredRecords() {
    return filterRecords(RecordStore.getAll(), recordsSearch.value);
  }

  function renderRecordsTable(filter, options) {
    const opts = options || {};
    if (opts.reset) recordsShown = RECORDS_PAGE_SIZE;

    const all = RecordStore.getAll();
    const filtered = filterRecords(all, filter);
    recordsCount.textContent = `共 ${all.length} 条记录`;

    const selectedIds = new Set(getSelectedIds());
    const COLSPAN = 9;
    const total = filtered.length;
    const shown = Math.min(recordsShown, total);
    const visible = filtered.slice(0, shown);

    if (total === 0) {
      recordsTbody.innerHTML = `<tr><td colspan="${COLSPAN}" style="text-align:center;color:#999;padding:20px;">暂无记录</td></tr>`;
      renderRecordsPager(0, 0);
      updateBatchBar();
      if (opts.reset && recordsTbodyScroll) recordsTbodyScroll.scrollTop = 0;
      return;
    }

    recordsTbody.innerHTML = visible.map(r => `
      <tr>
        <td style="width:32px;"><input type="checkbox" class="rec-select" data-id="${r.id}"${selectedIds.has(r.id) ? ' checked' : ''}></td>
        <td style="width:110px;font-family:monospace;font-size:11px;">${r.institutionCode}</td>
        <td style="width:150px;">${escHtml(r.province)}</td>
        <td style="width:150px;">${escHtml(r.city)}</td>
        <td style="width:150px;">${escHtml(r.district || '')}</td>
        <td>${escHtml(r.postOffice)}</td>
        <td style="width:140px;">${fmtCancelDate(r.cancelDate)}</td>
        <td style="width:140px;">${escHtml(RecordStore.formatStampNumbers(r)) || '-'}</td>
        <td style="width:100px;" class="rec-actions">
          <button class="btn-edit" data-id="${r.id}">编辑</button>
          <button class="btn-del" data-id="${r.id}">删除</button>
        </td>
      </tr>
    `).join('');

    // 行内复选框事件
    recordsTbody.querySelectorAll('.rec-select').forEach(cb => {
      cb.addEventListener('change', updateBatchBar);
    });

    // 编辑按钮
    recordsTbody.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = RecordStore.getById(btn.dataset.id);
        if (rec) EntryForm.open(rec);
      });
    });

    // 删除按钮（移入回收站，30 天内可恢复）
    recordsTbody.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (await Dialog.confirm('确定删除此记录？\n\n记录会先移入回收站，30 天内可在「数据安全 → 回收站」恢复。')) {
          RecordStore.delete(btn.dataset.id);
          renderRecordsTable(recordsSearch.value);
        }
      });
    });

    // 全选框跟随当前可见行
    const selectAll = $('select-all');
    if (selectAll) {
      const boxes = Array.from(recordsTbody.querySelectorAll('.rec-select'));
      selectAll.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
    }

    renderRecordsPager(shown, total);
    updateBatchBar();

    // 筛选 / 搜索变化时回到列表顶部
    if (opts.reset && recordsTbodyScroll) recordsTbodyScroll.scrollTop = 0;
  }

  /** 更新「全部记录」顶部的已显示条数与加载更多按钮 */
  function renderRecordsPager(shown, total) {
    if (!recordsPager || !recordsPagerInfo || !btnRecordsLoadMore) return;

    if (total === 0) {
      recordsPager.hidden = true;
      return;
    }

    recordsPager.hidden = false;
    recordsPagerInfo.textContent = `已显示 ${shown} / ${total} 条`;
    btnRecordsLoadMore.hidden = shown >= total;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /** 格式化日期显示: 兼容 10 位整数 (YYYYMMDDHH) 和旧格式 (YYYY.MM.DD.HH) */
  function fmtCancelDate(val) {
    if (!val) return '-';
    const s = String(val);
    if (/^\d{10}$/.test(s)) {
      return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:00`;
    }
    if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) {
      return s.replace(/\./g, '-').replace(/-(\d{2})$/, ' $1:00');
    }
    return s;
  }

  // ---- 批量编辑模态框 ----

  async function openBatchModal() {
    const ids = getSelectedIds();
    if (ids.length === 0) { await Dialog.alert('请先选择要编辑的记录'); return; }

    batchModalOpen = true;
    batchCountLabel.textContent = ids.length;
    batchOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // 填充省份下拉
    const provs = PostmarkData.getAllProvinces();
    bf.province.innerHTML = '<option value="">保持不变</option>';
    provs.forEach(p => {
      bf.province.innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });
    bf.city.innerHTML = '<option value="">保持不变</option>';
    bf.city.disabled = true;
    bf.material.innerHTML = '<option value="">保持不变</option>';
    ['拨轮','字钉','回墨','储墨','光敏','其他'].forEach(m => {
      bf.material.innerHTML += `<option value="${m}">${m}</option>`;
    });

    // 重置所有 toggle
    document.querySelectorAll('.batch-field-toggle').forEach(cb => {
      cb.checked = false;
    });
    disableBatchFields(true);
  }

  function closeBatchModal() {
    batchModalOpen = false;
    batchOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  function disableBatchFields(disabled) {
    bf.province.disabled = disabled;
    bf.city.disabled = disabled;
    bf.district.disabled = disabled;
    bf.cancelDate.disabled = disabled;
    bf.material.disabled = disabled;
    bf.notes.disabled = disabled;
  }

  function handleBatchToggle() {
    document.querySelectorAll('.batch-field-toggle').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const el = $(`bf-${field}`);
        if (el) {
          el.disabled = !cb.checked;
          if (!cb.checked) el.value = '';
        }
        if (field === 'province' && !cb.checked) {
          bf.city.value = '';
          bf.city.disabled = true;
          resetBatchDistrict();
        }
        if (field === 'city' && !cb.checked) {
          resetBatchDistrict();
        }
      });
    });
  }

  /** 重置区县为文本输入 */
  function resetBatchDistrict() {
    bf.districtContainer.innerHTML = '<input type="text" id="bf-district" class="form-input" placeholder="保持不变" disabled>';
    bf.district = $('bf-district');
    bf.district.disabled = true;
  }

  // 批次编辑: 省→市联动 + 区县联动（在 cacheBatchDoms 后调用）
  function initBatchProvinceLink() {
    // 省→市
    bf.province.addEventListener('change', () => {
      const provName = bf.province.value;
      bf.city.innerHTML = '<option value="">保持不变</option>';
      bf.city.disabled = true;
      resetBatchDistrict();
      if (provName) {
        const cities = PostmarkData.getProvinceCityNames(provName);
        cities.forEach(c => {
          bf.city.innerHTML += `<option value="${c}">${c}</option>`;
        });
        bf.city.disabled = false;
      }
    });
    // 市→区县
    bf.city.addEventListener('change', () => {
      const cityName = bf.city.value;
      resetBatchDistrict();
      if (cityName) {
        const dists = PostmarkData.getDistricts(cityName);
        bf.districtContainer.innerHTML = '';
        if (dists.length > 0) {
          const sel = document.createElement('select');
          sel.id = 'bf-district';
          sel.className = 'form-select';
          sel.innerHTML = '<option value="">保持不变</option>';
          dists.forEach(d => {
            sel.innerHTML += `<option value="${d}">${d}</option>`;
          });
          sel.disabled = true;
          bf.districtContainer.appendChild(sel);
          bf.district = sel;
        } else {
          const inp = document.createElement('input');
          inp.id = 'bf-district';
          inp.type = 'text';
          inp.className = 'form-input';
          inp.placeholder = '保持不变';
          inp.disabled = true;
          bf.districtContainer.appendChild(inp);
          bf.district = inp;
        }
      }
    });
  }

  // 批量提交
  $('f-batch-submit').addEventListener('click', async (e) => {
    e.preventDefault();
    const ids = getSelectedIds();
    if (ids.length === 0) { await Dialog.alert('没有选中的记录'); return; }

    // 收集修改字段
    const updates = {};
    document.querySelectorAll('.batch-field-toggle:checked').forEach(cb => {
      const field = cb.dataset.field;
      const el = $(`bf-${field}`);
      if (!el) return;
      const val = el.value.trim();
      if (field === 'notes') {
        updates.notes = val;
      } else if (val !== '') {
        updates[field] = val;
      }
    });

    if (Object.keys(updates).length === 0) {
      await Dialog.alert('请勾选要修改的字段并填写新值');
      return;
    }

    if (!(await Dialog.confirm(`确定将更新 ${ids.length} 条记录的以下字段：\n${Object.keys(updates).join('、')}？`))) return;

    ids.forEach(id => {
      const rec = RecordStore.getById(id);
      const patch = { ...updates };
      // 材质与戳号绑定：批量改材质时，把这条记录的每一把日戳都改成该材质
      if (patch.material != null) {
        const material = patch.material;
        delete patch.material;
        const stamps = RecordStore.getStamps(rec);
        patch.stamps = stamps.length
          ? stamps.map(s => ({ ...s, material }))
          : [{ number: '', material }];
      }
      RecordStore.update(id, patch);
    });
    closeBatchModal();
    renderRecordsTable(recordsSearch.value);
  });

  // ---- 事件绑定 ----

  // 记录列表页面开关
  $('btn-show-records').addEventListener('click', showRecordsPage);
  $('btn-records-back').addEventListener('click', hideRecordsPage);

  // ============================================================
  // 工具箱页面（首页 + 每页一个工具）
  // ============================================================
  function hideActiveToolPage() {
    if (!activeToolPage) return;
    activeToolPage.style.display = 'none';
    activeToolPage = null;
  }

  function showToolsPage() {
    toolsPageOpen = true;
    // 先把其它页面收起来（hide* 会把主视图恢复成可见），再隐藏主视图
    if (recordsPageOpen) hideRecordsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    hideActiveToolPage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    toolsPage.style.display = 'flex';
    setActiveNav('tools');
  }

  /** 打开工具箱里的某个工具页；key 对应页面 id 的 tool-<key>-page */
  function showToolPage(key) {
    const page = $('tool-' + key + '-page');
    if (!page) return;

    toolsPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    hideActiveToolPage();

    activeToolPage = page;
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    toolsPage.style.display = 'none';
    page.style.display = 'flex';

    // 网点数据在启动后才从 base 目录导入，进入页面时重建「随机网点」的筛选下拉
    if (key === 'random' && typeof Tools !== 'undefined') Tools.refreshRandomPO();
    setActiveNav('tools');
  }

  function hideToolsPage() {
    toolsPageOpen = false;
    hideActiveToolPage();
    toolsPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    setActiveNav('overview');
  }

  $('btn-show-tools').addEventListener('click', showToolsPage);
  $('btn-tools-back').addEventListener('click', hideToolsPage);

  // 工具箱首页的入口卡片 → 对应工具页；工具页的返回按钮 → 工具箱首页
  document.querySelectorAll('#tools-page [data-tool]').forEach((el) => {
    el.addEventListener('click', () => showToolPage(el.dataset.tool));
  });
  document.querySelectorAll('[data-tool-back]').forEach((el) => {
    el.addEventListener('click', showToolsPage);
  });

  // ============================================================
  // 网点检索页面
  // ============================================================
  function showPOSearchPage() {
    poSearchPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    poSearchPage.style.display = 'flex';
    // 网点数据在启动后才从 base 目录导入，进入页面时重新拉取筛选条件与结果
    if (typeof Tools !== 'undefined') Tools.refreshPOSearch();
    setActiveNav('po-search');
  }

  function hidePOSearchPage() {
    poSearchPageOpen = false;
    poSearchPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    setActiveNav('overview');
  }

  $('btn-show-po-search').addEventListener('click', showPOSearchPage);
  $('btn-po-search-back').addEventListener('click', hidePOSearchPage);

  // ============================================================
  // 数据抓取页面
  // ============================================================
  function showCrawlerPage() {
    crawlerPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    crawlerPage.style.display = 'flex';
    if (typeof CrawlerPage !== 'undefined') CrawlerPage.refresh();
    setActiveNav('crawler');
  }

  function hideCrawlerPage() {
    crawlerPageOpen = false;
    crawlerPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    // 只停 UI 轮询，后台作业继续跑；再次进入页面会重新拉取状态
    if (typeof CrawlerPage !== 'undefined') CrawlerPage.suspend();
    setActiveNav('overview');
  }

  $('btn-show-crawler').addEventListener('click', showCrawlerPage);
  $('btn-crawler-back').addEventListener('click', hideCrawlerPage);

  // ============================================================
  // 港澳台网点 · 网点查询 / 数据抓取
  // ============================================================
  function showPostalSearchPage() {
    postalSearchPageOpen = true;
    setPostalNavExpanded(true);
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    postalSearchPage.style.display = 'flex';
    if (typeof PostalPage !== 'undefined') PostalPage.refreshSearch();
    setActiveNav('postal-search');
  }

  function hidePostalSearchPage() {
    postalSearchPageOpen = false;
    postalSearchPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    setActiveNav('overview');
  }

  function showPostalCrawlerPage() {
    postalCrawlerPageOpen = true;
    setPostalNavExpanded(true);
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    postalCrawlerPage.style.display = 'flex';
    if (typeof PostalPage !== 'undefined') PostalPage.refreshCrawler();
    setActiveNav('postal-crawler');
  }

  function hidePostalCrawlerPage() {
    postalCrawlerPageOpen = false;
    postalCrawlerPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    // 后台状态轮询继续，服务端作业完成时仍会刷新查询与首页统计；
    // 再次进入页面只刷新文件列表与状态展示。
    if (typeof PostalPage !== 'undefined') PostalPage.suspend();
    setActiveNav('overview');
  }

  $('btn-show-postal-search').addEventListener('click', showPostalSearchPage);
  $('btn-postal-search-back').addEventListener('click', hidePostalSearchPage);
  $('btn-show-postal-crawler').addEventListener('click', showPostalCrawlerPage);
  $('btn-postal-crawler-back').addEventListener('click', hidePostalCrawlerPage);

  // ============================================================
  // 邮资机戳页面（独立数据表，与日戳记录互不影响）
  // ============================================================
  function showMeterPage() {
    meterPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    meterPage.style.display = 'flex';
    if (typeof MeterList !== 'undefined') MeterList.show();
    setActiveNav('meter');
  }

  function hideMeterPage() {
    meterPageOpen = false;
    meterPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    if (typeof MeterList !== 'undefined') MeterList.closeForm();
    setActiveNav('overview');
  }

  $('btn-show-meter').addEventListener('click', showMeterPage);
  $('btn-meter-back').addEventListener('click', hideMeterPage);

  // ============================================================
  // 邮戳图片页面（照片画廊）
  // ============================================================
  function showGalleryPage() {
    galleryPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    galleryPage.style.display = 'flex';
    // 图片来自日戳记录，进入页面时按最新记录重建画廊
    if (typeof GalleryPage !== 'undefined') GalleryPage.show();
    setActiveNav('gallery');
  }

  function hideGalleryPage() {
    galleryPageOpen = false;
    galleryPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    // 详情是 fixed 遮罩，离开页面时必须一起收起，否则会锁住滚动
    if (typeof GalleryPage !== 'undefined') GalleryPage.closeDetail();
    setActiveNav('overview');
  }

  $('btn-show-gallery').addEventListener('click', showGalleryPage);
  $('btn-gallery-back').addEventListener('click', hideGalleryPage);

  // ============================================================
  // 统计页面（多图表数据看板）
  // ============================================================
  function showStatisticsPage() {
    statisticsPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    statisticsPage.style.display = 'flex';
    // 进入页面时重新汇总，保证看到的是当前数据
    if (typeof StatisticsPage !== 'undefined') StatisticsPage.show();
    setActiveNav('statistics');
  }

  function hideStatisticsPage() {
    statisticsPageOpen = false;
    statisticsPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    if (typeof StatisticsPage !== 'undefined') StatisticsPage.hide();
    setActiveNav('overview');
  }

  $('btn-show-statistics').addEventListener('click', showStatisticsPage);
  $('btn-statistics-back').addEventListener('click', hideStatisticsPage);
  $('btn-statistics-refresh').addEventListener('click', () => {
    if (typeof StatisticsPage !== 'undefined') StatisticsPage.refresh();
  });

  // ============================================================
  // 数据安全页面（备份 / 恢复 / 图片管理 / 回收站）
  // ============================================================
  function showMaintenancePage() {
    maintenancePageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    maintenancePage.style.display = 'flex';
    if (typeof MaintenancePage !== 'undefined') MaintenancePage.show();
    setActiveNav('maintenance');
  }

  function hideMaintenancePage() {
    maintenancePageOpen = false;
    maintenancePage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    if (typeof MaintenancePage !== 'undefined') MaintenancePage.hide();
    setActiveNav('overview');
  }

  $('btn-show-maintenance').addEventListener('click', showMaintenancePage);
  $('btn-maintenance-back').addEventListener('click', hideMaintenancePage);

  // ============================================================
  // 地图总览页面（侧边栏第一项）
  // ============================================================
  function showOverviewPage() {
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (mailPageOpen) hideMailPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    // 收起动作会把主视图恢复回来，这里再统一亮一次总览
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    setActiveNav('overview');
  }

  $('btn-show-overview').addEventListener('click', showOverviewPage);

  // ============================================================
  // 邮件管理页面
  //   mail-pending / mail-transit / mail-delivered → 共用一张表的三个状态视图
  //   mail-query                                   → 17TRACK 单号查询
  //   mail-return                                  → 国际退信（独立一张表）
  // ============================================================
  const MAIL_ROUTES = {
    'mail-pending':   { kind: 'list', status: 'pending' },
    'mail-transit':   { kind: 'list', status: 'transit' },
    'mail-delivered': { kind: 'list', status: 'delivered' },
    'mail-query':     { kind: 'track' },
    'mail-return':    { kind: 'return' },
  };

  /** 页面标题里的模块名直接取侧边栏文字，避免两处各维护一份 */
  function mailLabel(pageKey) {
    const el = document.querySelector(`#sidebar [data-page="${pageKey}"]`);
    if (el && el.dataset.label) return el.dataset.label;
    return el ? el.textContent.trim() : pageKey;
  }

  function showMailPage(pageKey) {
    const route = MAIL_ROUTES[pageKey];
    if (!route) return;
    mailPageOpen = true;
    if (recordsPageOpen) hideRecordsPage();
    if (toolsPageOpen) hideToolsPage();
    if (statisticsPageOpen) hideStatisticsPage();
    if (poSearchPageOpen) hidePOSearchPage();
    if (crawlerPageOpen) hideCrawlerPage();
    if (postalSearchPageOpen) hidePostalSearchPage();
    if (postalCrawlerPageOpen) hidePostalCrawlerPage();
    if (meterPageOpen) hideMeterPage();
    if (galleryPageOpen) hideGalleryPage();
    if (maintenancePageOpen) hideMaintenancePage();
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';

    const label = mailLabel(pageKey);
    mailPageTitle.textContent = `邮件管理 · ${label}`;
    mailPage.style.display = 'flex';

    // 卡片互斥：国际退信 / 列表 / 17TRACK 查询 / 占位
    mailListCard.style.display = 'none';
    mailReturnCard.style.display = 'none';
    mailTrackCard.style.display = 'none';
    mailPlaceholderCard.style.display = 'none';

    if (route.kind === 'list') {
      mailListCard.style.display = '';
      if (typeof MailList !== 'undefined') MailList.show(route.status);
    } else if (route.kind === 'return') {
      mailReturnCard.style.display = '';
      if (typeof ReturnList !== 'undefined') ReturnList.show();
    } else if (route.kind === 'track') {
      // 查询组件是 index.html 里的 17TRACK externalcall.js 组件（#YQNum / doTrack() / #YQContainer）
      mailTrackCard.style.display = '';
    } else {
      mailPlaceholderCard.style.display = '';
      mailPlaceholderTitle.textContent = `${label} 功能暂未开发`;
    }
    setActiveNav(pageKey);
  }

  function hideMailPage() {
    mailPageOpen = false;
    mailPage.style.display = 'none';
    $('main-container').style.display = '';
    $('btn-add-record-fab').style.display = '';
    setActiveNav('overview');
  }

  navItems.forEach(el => {
    const key = el.dataset.page;
    if (key && key.startsWith('mail-')) {
      el.addEventListener('click', () => showMailPage(key));
    }
  });
  $('btn-mail-back').addEventListener('click', hideMailPage);

  $('btn-refresh').addEventListener('click', () => {
    refreshAllViews();
    refreshStatisticsIfVisible();
    if (recordsPageOpen) renderRecordsTable(recordsSearch.value, { reset: true });
  });

  recordsSearch.addEventListener('input', () => {
    renderRecordsTable(recordsSearch.value.trim(), { reset: true });
  });

  recordsProvince.addEventListener('change', () => {
    filterProvince = recordsProvince.value;
    filterCity = '';
    filterDistrict = '';
    populateRecordsCity();
    populateRecordsDistrict();
    renderRecordsTable(recordsSearch.value.trim(), { reset: true });
  });

  recordsCity.addEventListener('change', () => {
    filterCity = recordsCity.value;
    filterDistrict = '';
    populateRecordsDistrict();
    renderRecordsTable(recordsSearch.value.trim(), { reset: true });
  });

  recordsDistrict.addEventListener('change', () => {
    filterDistrict = recordsDistrict.value;
    renderRecordsTable(recordsSearch.value.trim(), { reset: true });
  });

  if (btnRecordsLoadMore) {
    btnRecordsLoadMore.addEventListener('click', () => {
      recordsShown += RECORDS_PAGE_SIZE;
      renderRecordsTable(recordsSearch.value.trim());
    });
  }

  // 全选
  $('select-all').addEventListener('change', function () {
    recordsTbody.querySelectorAll('.rec-select').forEach(cb => cb.checked = this.checked);
    updateBatchBar();
  });

  // 批量编辑按钮
  $('btn-batch-edit').addEventListener('click', openBatchModal);

  // 批量删除（移入回收站；删除前自动落一份四表快照）
  $('btn-batch-delete').addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    if (!(await Dialog.confirm(
      `确定把选中的 ${ids.length} 条记录移入回收站？\n\n30 天内可在「数据安全 → 回收站」恢复。`
    ))) return;
    if (typeof MaintenancePage !== 'undefined') {
      await MaintenancePage.snapshotBeforeDestructive('before-batch-delete');
    }
    ids.forEach(id => RecordStore.delete(id));
    renderRecordsTable(recordsSearch.value);
  });

  // 批次模态框关闭
  $('f-batch-close').addEventListener('click', closeBatchModal);
  $('f-batch-cancel').addEventListener('click', closeBatchModal);
  batchOverlay.addEventListener('click', (e) => {
    if (e.target === batchOverlay) closeBatchModal();
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 录入表单 / 图片编辑器 / 自定义对话框都是独立模态层：
      // Esc 应由它们自己处理，不能顺手把背后的页面也切走。
      if (document.querySelector('#form-overlay.active, #image-editor-overlay.active, #dialog-overlay.active')) return;
      // 报告弹窗叠在页面之上，Esc 应先收起它，而不是把整个「数据抓取」页也关掉
      if (window.CrawlerPage && window.CrawlerPage.closeReport()) return;
      // 邮件「新增 / 编辑」表单同理
      if (window.MailList && window.MailList.closeForm()) return;
      // 国际退信：详情弹窗叠在列表之上，先收它，再收「新增 / 编辑」表单
      if (window.ReturnList && window.ReturnList.closeDetail()) return;
      if (window.ReturnList && window.ReturnList.closeForm()) return;
      // 邮资机戳同理
      if (window.MeterList && window.MeterList.closeForm()) return;
      // 网点详情叠在「网点检索」页之上
      if (window.Tools && window.Tools.closePODetail()) return;
      // 邮戳图片详情叠在画廊页之上
      if (window.GalleryPage && window.GalleryPage.closeDetail()) return;
      // 数据安全页里的挂接 / 预览弹窗叠在页面上
      if (window.MaintenancePage && window.MaintenancePage.closeModal()) return;
      // 打印 / 贴片选项弹窗
      if (window.PrintPage && window.PrintPage.close()) return;
      if (batchModalOpen) closeBatchModal();
      else if (toolsPageOpen) hideToolsPage();
      else if (poSearchPageOpen) hidePOSearchPage();
      else if (crawlerPageOpen) hideCrawlerPage();
      else if (postalSearchPageOpen) hidePostalSearchPage();
      else if (postalCrawlerPageOpen) hidePostalCrawlerPage();
      else if (mailPageOpen) hideMailPage();
      else if (meterPageOpen) hideMeterPage();
      else if (galleryPageOpen) hideGalleryPage();
      else if (statisticsPageOpen) hideStatisticsPage();
      else if (maintenancePageOpen) hideMaintenancePage();
      else if (recordsPageOpen) hideRecordsPage();
    }
  });

  // ============================================================
  // 导出 / 导入 / 清空
  // ============================================================
  $('btn-export-json').addEventListener('click', async () => {
    const data = RecordStore.getAll();
    if (data.length === 0) { await Dialog.alert('暂无数据可导出'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `postmark-records-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---- 全字段导出：Excel / CSV ----
  // 逐把戳号 / 材质各自占列（戳号1、材质1、戳号2…），图片路径、邮资机、风景戳、状态都导出。
  const RECORD_STATUS_LABEL = {
    open: '营业',
    delivery: '投递部',
    closed: '已撤销',
    themed: '主题邮局',
    temporary: '临时邮局',
  };

  /** 盖销日期导出为 YYYY.MM.DD.HH（可读，且 Excel 导入能还原小时） */
  function fmtExportDate(val) {
    const s = String(val == null ? '' : val);
    if (/^\d{10}$/.test(s)) {
      return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}.${s.slice(8, 10)}`;
    }
    return s;
  }

  function fmtExportTime(val) {
    if (!val) return '';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function buildRecordExport(records) {
    const maxStamps = records.reduce((m, r) => Math.max(m, RecordStore.getStamps(r).length), 1);
    const headers = [
      '省', '市', '县/区', '邮局名称', '邮政编码', '机构号',
      '邮局类型/状态', '盖销日期',
    ];
    for (let i = 1; i <= maxStamps; i++) headers.push(`戳号${i}`, `材质${i}`);
    headers.push('邮资机型号', '邮资机编号', '表头', '下环', '风景日戳', '图片路径', '备注', '录入时间');

    const rows = records.map((r) => {
      const stamps = RecordStore.getStamps(r);
      const row = [
        r.province || '',
        r.city || '',
        r.district || '',
        r.postOffice || '',
        r.postalCode || '',
        r.institutionCode || '',
        RECORD_STATUS_LABEL[r.status] || r.status || '',
        fmtExportDate(r.cancelDate),
      ];
      for (let i = 0; i < maxStamps; i++) {
        const s = stamps[i];
        row.push(s ? (s.number || '无戳号') : '', s ? (s.material || '') : '');
      }
      row.push(
        r.hasPostageMeter ? (r.meterModel || '') : '',
        r.hasPostageMeter ? (r.meterNo || '') : '',
        r.hasPostageMeter ? (r.meterHeader || '') : '',
        r.hasPostageMeter ? (r.meterLowerRing || '') : '',
        Array.isArray(r.scenicNames) ? r.scenicNames.join('、') : '',
        Array.isArray(r.photos) ? r.photos.join('; ') : '',
        r.notes || '',
        fmtExportTime(r.createdAt)
      );
      return row;
    });

    return { headers, rows };
  }

  $('btn-export-excel').addEventListener('click', async () => {
    const records = RecordStore.getAll();
    if (records.length === 0) { await Dialog.alert('暂无数据可导出'); return; }
    if (typeof ExportUtils === 'undefined') { await Dialog.alert('导出组件未加载，请刷新页面'); return; }
    try {
      const { headers, rows } = buildRecordExport(records);
      ExportUtils.downloadXlsx(
        `日戳记录-${ExportUtils.fileDate()}.xlsx`,
        '日戳记录',
        headers,
        rows
      );
    } catch (e) {
      await Dialog.alert('导出 Excel 失败: ' + e.message);
    }
  });

  $('btn-export-csv').addEventListener('click', async () => {
    const records = RecordStore.getAll();
    if (records.length === 0) { await Dialog.alert('暂无数据可导出'); return; }
    if (typeof ExportUtils === 'undefined') { await Dialog.alert('导出组件未加载，请刷新页面'); return; }
    const { headers, rows } = buildRecordExport(records);
    ExportUtils.downloadCsv(`日戳记录-${ExportUtils.fileDate()}.csv`, headers, rows);
  });

  // ---- Excel 导入模板 ----
  // 列名必须与 EXCEL_COL_MAP 的键一致，否则导入时认不出来。
  const EXCEL_TEMPLATE_HEADERS = [
    '省', '市', '县', '邮局名称', '邮政编码', '机构号', '盖销日期',
    '戳号', '材质', '邮局类型/状态',
    '邮资机型号', '邮资机编号', '表头', '下环', '风景日戳', '备注',
  ];
  const EXCEL_TEMPLATE_EXAMPLE = [
    '北京市', '北京市', '西城区', '中南海邮政支局', '100017', '10001701', '2026.09.30.15',
    '1', '拨轮', '营业',
    '', '', '', '', '', '示例行，导入前请删除',
  ];
  const EXCEL_TEMPLATE_NOTES = [
    ['列名', '是否必填', '说明'],
    ['省', '必填', '与参考库一致的省名，例如：北京市 / 河北省 / 香港特别行政区'],
    ['市', '必填', '地级市名；直辖市与省名相同'],
    ['县', '选填', '县 / 区 / 县级市名'],
    ['邮局名称', '必填', '例如：中南海邮政支局'],
    ['邮政编码', '必填', '6 位数字；缺机构号时会据此生成'],
    ['机构号', '选填', '8 位数字；留空则按邮编自动生成'],
    ['盖销日期', '必填', '支持 2026.09.30.15 / 2026093015 / 2026-09-30 三种写法'],
    ['戳号', '选填', '多把日戳用顿号或逗号分隔，例如：1、2、无戳号'],
    ['材质', '选填', '拨轮 / 字钉 / 回墨 / 储墨 / 光敏 / 其他；多把日戳会统一使用该材质'],
    ['邮局类型/状态', '选填', '营业 / 投递部 / 已撤销 / 主题邮局 / 临时邮局；留空按营业'],
    ['风景日戳', '选填', '多个名称用顿号或逗号分隔'],
    ['备注', '选填', '自由文本'],
    [],
    ['提示', '', '「戳号 / 材质」一列一把日戳；需要逐把不同材质时请用 JSON 导入或直接在界面录入。'],
  ];

  $('btn-excel-template').addEventListener('click', async () => {
    if (typeof ExportUtils === 'undefined') { await Dialog.alert('导出组件未加载，请刷新页面'); return; }
    try {
      ExportUtils.downloadXlsx(
        '日戳导入模板.xlsx',
        '日戳记录',
        EXCEL_TEMPLATE_HEADERS,
        [EXCEL_TEMPLATE_EXAMPLE],
        { extraSheets: [{ name: '填写说明', aoa: EXCEL_TEMPLATE_NOTES }] }
      );
    } catch (e) {
      await Dialog.alert('生成模板失败: ' + e.message);
    }
  });

  // ---- 打印 / 贴片 ----
  $('btn-print-records').addEventListener('click', async () => {
    if (typeof PrintPage === 'undefined') { await Dialog.alert('打印模块未加载，请刷新页面'); return; }
    const records = getFilteredRecords();
    if (records.length === 0) {
      await Dialog.alert('当前筛选结果为空，没有可打印的记录。');
      return;
    }
    PrintPage.open(records);
  });

  $('btn-import-json').addEventListener('click', () => {
    $('f-import-file').click();
  });

  /**
   * 导入前问一次重复处理方式（JSON / Excel 共用）。
   * @param {{total:number, duplicates:number, byId:number, byInstCode:number, invalid:number}} plan
   * @returns {Promise<'skip'|'overwrite'|'new'|null>} null 表示取消
   */
  async function askImportStrategy(plan) {
    const parts = [];
    if (plan.byId) parts.push(`id 相同 ${plan.byId} 条`);
    if (plan.byInstCode) parts.push(`机构号相同 ${plan.byInstCode} 条`);

    const msg = `共 ${plan.total} 条待导入，其中 ${plan.duplicates} 条与现有记录重复`
      + (parts.length ? `（${parts.join('，')}）` : '')
      + '。\n\n请选择处理方式：\n'
      + '· 跳过重复：保留现有记录，只导入新的\n'
      + '· 覆盖现有：用导入内容覆盖重复记录（保留原 id）\n'
      + '· 作为新记录：换新 id 导入，允许同机构号并存';

    const choice = await Dialog.choice(msg, [
      { value: 'skip', label: '跳过重复', primary: true },
      { value: 'overwrite', label: '覆盖现有' },
      { value: 'new', label: '作为新记录' },
      { value: 'cancel', label: '取消导入' },
    ]);
    return choice === 'cancel' ? null : choice;
  }

  /** 导入结果的一句话摘要 */
  function importReportText(result) {
    const parts = [`新增 ${result.added} 条`];
    if (result.updated) parts.push(`覆盖 ${result.updated} 条`);
    if (result.skipped) parts.push(`跳过重复 ${result.skipped} 条`);
    if (result.invalid) parts.push(`忽略无效 ${result.invalid} 条`);
    return parts.join('，');
  }

  $('f-import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const records = JSON.parse(ev.target.result);
        if (!Array.isArray(records)) throw new Error('格式错误');
        if (records.length === 0) { await Dialog.alert('文件里没有记录'); return; }

        // 按 id / 机构号判重：同一份备份导两次不会翻倍
        const plan = RecordStore.planImport(records);
        let strategy = 'skip';
        if (plan.duplicates > 0) {
          const choice = await askImportStrategy(plan);
          if (!choice) return;
          strategy = choice;
        }

        const result = RecordStore.importRecords(records, { strategy });
        await Dialog.alert(`导入完成：${importReportText(result)}`);
        renderRecordsTable(recordsSearch.value, { reset: true });
      } catch (err) {
        await Dialog.alert('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // 重置 input
  });

  // ============================================================
  // Excel 导入
  // ============================================================
  const EXCEL_COL_MAP = {
    '省': 'province', '省份': 'province', '省/自治区/直辖市': 'province',
    '市': 'city', '城市': 'city',
    '县': 'district', '区': 'district', '县/区': 'district', '区/县': 'district',
    '邮局名称': 'postOffice', '邮局': 'postOffice', '名称': 'postOffice',
    '邮政编码': 'postalCode', '邮编': 'postalCode',
    '机构号': 'institutionCode',
    '盖销日期': 'cancelDate', '日期': 'cancelDate',
    '戳号': 'stampNumbers',
    '材质': 'material',
    '邮资机型号': 'meterModel',
    '邮资机编号': 'meterNo', '编号': 'meterNo',
    '表头': 'meterHeader',
    '下环': 'meterLowerRing',
    '风景日戳': 'scenicNames', '风景日戳名称': 'scenicNames', '文化日戳': 'scenicNames',
    '备注': 'notes',
    '状态': 'status', '邮局状态': 'status', '邮局类型/状态': 'status',
  };

  function parseExcelValue(val, field) {
    if (val == null || val === '') return null;
    if (field === 'stampNumbers' || field === 'scenicNames') {
      // 逗号/顿号/空格分隔的列表
      return String(val).split(/[,，、\s]+/).filter(Boolean);
    }
    if (field === 'status') {
      const s = String(val).trim();
      // 兼容旧数据: 已撤销/是/true/1 → 'closed'
      if (s === '已撤销' || s === 'closed') return 'closed';
      if (s === '投递部' || s === 'delivery') return 'delivery';
      if (s === '主题邮局' || s === 'themed') return 'themed';
      if (s === '临时邮局' || s === 'temporary') return 'temporary';
      // 旧格式兼容: 是/true/1 → 'closed'
      if (s === '是' || s === 'true' || s === '1') return 'closed';
      // 旧格式兼容: 否/false/0 → 'open'
      if (s === '否' || s === 'false' || s === '0') return 'open';
      return 'open'; // 默认营业
    }
    if (field === 'cancelDate') {
      const s = String(val).trim();
      // 已为 10 位整数格式
      if (/^\d{10}$/.test(s)) return s;
      // YYYY.MM.DD.HH → YYYYMMDDHH
      if (/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s)) return s.replace(/\./g, '');
      // YYYY-MM-DD 或 YYYY/MM/DD → YYYYMMDD00
      const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
      if (m) return m[1] + m[2] + m[3] + '00';
      return s;
    }
    if (field === 'hasPostageMeter' || field === 'hasScenicPostmark') {
      const s = String(val).trim();
      return s === '是' || s === '有' || s === 'true' || s === '1';
    }
    return String(val).trim();
  }

  $('btn-import-excel').addEventListener('click', () => {
    $('f-import-excel-file').click();
  });

  $('f-import-excel-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) throw new Error('Excel 为空');

        // 检测表头映射
        const headers = Object.keys(rows[0]);
        const fieldMap = {};
        headers.forEach(h => {
          const key = h.trim();
          fieldMap[key] = EXCEL_COL_MAP[key] || null;
        });

        const mappedCount = Object.values(fieldMap).filter(Boolean).length;
        if (mappedCount === 0) throw new Error('无法识别表头列名，请参考模板');

        const parsed = [];
        const errors = [];
        rows.forEach((row, i) => {
          try {
            const record = {};
            for (const [col, field] of Object.entries(fieldMap)) {
              if (!field) continue;
              const val = parseExcelValue(row[col], field);
              if (val !== null) record[field] = val;
            }
            if (!record.province) throw new Error('缺少省份');
            if (!record.postOffice) throw new Error('缺少邮局名称');
            if (!record.institutionCode && record.postalCode) {
              record.institutionCode = RecordStore.generateInstCode(record.postalCode);
            }
            parsed.push(record);
          } catch (err) {
            errors.push(`第 ${i + 2} 行: ${err.message}`);
          }
        });

        // 与 JSON 导入共用同一套去重逻辑（按 id / 机构号）
        let strategy = 'skip';
        if (parsed.length > 0) {
          const plan = RecordStore.planImport(parsed);
          if (plan.duplicates > 0) {
            const choice = await askImportStrategy(plan);
            if (!choice) return;
            strategy = choice;
          }
        }

        const result = parsed.length > 0
          ? RecordStore.importRecords(parsed, { strategy })
          : { added: 0, updated: 0, skipped: 0, invalid: 0 };

        let msg = `导入完成：${importReportText(result)}`;
        if (errors.length > 0) {
          msg += `\n跳过 ${errors.length} 条:\n${errors.slice(0, 5).join('\n')}`;
          if (errors.length > 5) msg += `\n...及其他 ${errors.length - 5} 条`;
        }
        await Dialog.alert(msg);
        renderRecordsTable(recordsSearch.value, { reset: true });
      } catch (err) {
        await Dialog.alert('导入失败: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  });

  // ============================================================
  // 清空
  // ============================================================
  $('btn-clear-records').addEventListener('click', async () => {
    if (!(await Dialog.confirm(
      '确定清空所有日戳记录？\n\n清空前会自动保存一份四表快照到 output/backup/，'
      + '但快照只含数据、不含图片；重要数据请先用「数据安全 → 打包备份」做整包备份。'
    ))) return;
    if (!(await Dialog.confirm('再次确认：清空所有日戳记录？'))) return;

    if (typeof MaintenancePage !== 'undefined') {
      const snap = await MaintenancePage.snapshotBeforeDestructive('before-clear');
      if (!snap && !(await Dialog.confirm('快照保存失败，仍要继续清空吗？'))) return;
    }

    RecordStore.clear();
    renderRecordsTable('', { reset: true });
  });

  // 初始化批量编辑模块
  cacheBatchDoms();
  handleBatchToggle();
  initBatchProvinceLink();

  // ============================================================
  // 启动时从 base 目录自动导入网点数据
  // ============================================================
  const BASE_SIG_KEY = 'poref_base_signature';
  // 港澳台 base 文件与大陆 post*/spb* 字段不同，不能交给 PODatabase 导入
  const POSTAL_BASE_FILES = new Set([
    'posthk+base.csv', 'postmo+base.csv', 'posttw+base.csv', 'agencytw+base.csv',
  ]);

  /**
   * 拉取 base/base_old.csv（历史归档，单一文件、POST/SPB 混排）。
   * 没有这个文件返回 null —— 调用方据此把参考库的历史部分清空，
   * 保证归档视图与 base 目录始终一致。
   */
  async function fetchBaseOldBuffer() {
    try {
      const r = await fetch('/base/' + encodeURIComponent('base_old.csv'));
      if (!r.ok) return null;
      return await r.arrayBuffer();
    } catch (e) {
      console.error('[PO] 拉取 base_old.csv 失败:', e);
      return null;
    }
  }

  async function importBaseData() {
    // 1. 获取 base 目录文件列表
    let files;
    try {
      const res = await fetch('/api/base-files');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      files = await res.json();
    } catch (e) {
      return { error: '无法读取 base 目录: ' + e.message };
    }

    // 只认大陆网点数据文件（post*/spb*）；base_old.csv 与港澳台 +base 文件单独处理
    const dataFiles = (Array.isArray(files) ? files : []).filter((f) => {
      const lower = String(f.name || '').toLowerCase();
      if (POSTAL_BASE_FILES.has(lower)) return false;
      return lower.startsWith('post') || lower.startsWith('spb');
    });

    // base 目录确认为空 → 参考库同步清空，保持与 base 完全一致
    if (dataFiles.length === 0) {
      const prev = PODatabase.count();
      await PODatabase.clear();
      await PODatabase.importHistory(await fetchBaseOldBuffer());
      localStorage.removeItem(BASE_SIG_KEY);
      return {
        empty: true, cleared: prev,
        total: PODatabase.count(), historyTotal: PODatabase.historyCount(),
      };
    }
    files = dataFiles;

    // 2. 签名校验：文件未变化且已有数据则跳过，避免重复导入
    //    刚从旧版 localStorage 方案升级上来时 IndexedDB 是空的，此时不能信任
    //    旧签名（它可能只对应搬过来的那几个省），必须强制重新导入一次。
    //    上一次是「对比快照」时同样要重建：快照只是提交前的样子，base 才是准的。
    const sig = files.map(f => `${f.name}:${f.size}:${f.mtime}`).join('|');
    const prevSig = localStorage.getItem(BASE_SIG_KEY);
    if (prevSig === sig && PODatabase.count() > 0 &&
        !PODatabase.legacyUpgrade() && !PODatabase.isProvisional()) {
      return {
        skipped: true, files: files.length,
        total: PODatabase.count(), historyTotal: PODatabase.historyCount(),
      };
    }

    // 3. 拉取并解析每个 CSV
    const buffers = [];
    for (const f of files) {
      const lower = f.name.toLowerCase();
      let sourceType = null;
      if (lower.startsWith('post')) sourceType = 'post';
      else if (lower.startsWith('spb')) sourceType = 'spb';
      if (!sourceType) continue;
      try {
        const r = await fetch('/base/' + encodeURIComponent(f.name));
        if (!r.ok) continue;
        buffers.push({ buffer: await r.arrayBuffer(), sourceType, name: f.name });
      } catch (e) {
        console.error('[PO] 拉取网点文件失败:', f.name, e);
      }
    }

    if (buffers.length === 0) {
      return { error: 'base 目录下没有可导入的网点 CSV 文件' };
    }

    // 4. 批量导入 — replace 模式：参考库完全跟随 base 目录，
    //    上一版本的数据 (含已被删除的省份/网点) 不再保留
    try {
      const result = await PODatabase.importCSVBulk(buffers, undefined, { mode: 'replace' });
      // 历史归档单独一份：base_old.csv 存在就导入，不存在就清空历史。
      // 归档失败不该把「当前库已经导入成功」报成整体失败，所以单独兜一层。
      let historyTotal = PODatabase.historyCount();
      try {
        historyTotal = await PODatabase.importHistory(await fetchBaseOldBuffer());
      } catch (e) {
        console.error('[PO] 导入历史归档失败（当前库不受影响）:', e);
      }
      localStorage.setItem(BASE_SIG_KEY, sig);
      return {
        imported: result.imported,
        files: buffers.length,
        total: result.stats.totalCount,
        errors: result.errors.length,
        historyTotal,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ============================================================
  // 启动
  // ============================================================
  try {
    // 先水合 PO 参考库（IndexedDB → 内存镜像），之后所有查询 API 都是同步的
    await PODatabase.ready();

    // 港澳台四份 CSV 独立于 base 参考库；先载入，首页排名表才能拿到实际总数
    if (typeof PostalStore !== 'undefined') {
      try {
        await PostalStore.ready();
      } catch (e) {
        console.error('[Postal] 港澳台网点数据载入失败:', e);
      }
    }

    // 初始化表单
    EntryForm.init();

    // 「邮资机戳」独立表：首次启动把已有日戳记录里的邮资机信息移植过来，只做一次；
    // 之后（含用户再改日戳记录）都以本页数据为准，需要补拉时页面上有「从日戳记录移植」
    if (typeof MeterStore !== 'undefined') MeterStore.autoSeed();

    // 初始化统计面板
    StatsView.init();

    // 初始化地图 (异步加载 GeoJSON)
    await MapView.init();

    // 隐藏加载遮罩
    loadingEl.classList.remove('active');

    // 更新统计数据
    StatsView.update('nation', null);
  } catch (err) {
    console.error('应用初始化失败:', err);
    loadingEl.querySelector('p').textContent = '加载失败: ' + err.message;
    loadingEl.querySelector('.spinner').style.display = 'none';
  }

  // 启动自动快照：把四表 dump 到 output/backup/（保留最近 N 份）。
  // 不阻塞界面；失败只在控制台留一条日志，不影响应用使用。
  if (typeof MaintenancePage !== 'undefined') {
    MaintenancePage.autoSnapshotOnStart();
  }

  // 启动时自动导入 base 目录网点数据，完成后弹窗提示
  importBaseData().then(async (result) => {
    // 参考库已更新 → 排名表的「总计」（邮政官网网点数）跟着重算
    refreshStatsOnly();
    refreshStatisticsIfVisible();

    const stats = PODatabase.getStats();
    const postCount = stats.provinces.reduce((s, p) => s + p.postCount, 0);
    const spbCount = stats.provinces.reduce((s, p) => s + p.spbCount, 0);
    const total = stats.totalCount;
    const hist = PODatabase.historyCount();
    const histNote = hist ? `\n历史归档 ${hist} 条（可在「网点检索」里勾选查看）。` : '';

    let msg;
    if (result.error) {
      msg = '网点数据导入失败：' + result.error;
    } else if (result.empty) {
      msg = result.cleared > 0
        ? `base 目录下已无网点数据文件，参考库已同步清空（原有 ${result.cleared} 条）。`
        : 'base 目录下没有网点数据文件，无法自动导入。';
      if (hist) msg += `\n历史归档 ${hist} 条已保留。`;
    } else if (result.skipped) {
      msg = `网点数据已是最新，当前共 ${total} 条（POST ${postCount} / SPB ${spbCount}）。` + histNote;
    } else {
      msg = `已从 base 目录覆盖导入网点数据：本次 ${result.imported} 条，当前共 ${total} 条（POST ${postCount} / SPB ${spbCount}）。` +
        histNote;
      if (result.errors > 0) msg += `\n（另有 ${result.errors} 条解析错误）`;
    }
    await Dialog.alert(msg);
  });

})();
