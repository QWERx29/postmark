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
  function refreshAllViews() {
    const level = MapView.getCurrentLevel();
    if (level === 'province') {
      StatsView.update('nation', null);
    } else {
      StatsView.update('city', MapView.getCurrentProvince());
    }
    // 重新渲染地图
    if (level === 'province') {
      MapView.backToNation();
    } else {
      MapView.drillToProvince(MapView.getCurrentProvince());
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
    if (recordsPageOpen) renderRecordsTable(recordsSearch.value);
  });

  // ============================================================
  // 记录列表独立页面 + 批量编辑
  // ============================================================
  let recordsPageOpen = false;
  let batchModalOpen = false;
  let toolsPageOpen = false;
  const toolsPage = $('tools-page');
  const recordsPage = $('records-page');
  const recordsTbody = $('records-tbody');
  const recordsCount = $('records-count');
  const recordsSearch = $('f-records-search');
  const recordsProvince = $('f-records-province');
  const recordsCity = $('f-records-city');
  const recordsDistrict = $('f-records-district');
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
    renderRecordsTable(recordsSearch.value);
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
    $('main-container').style.display = 'flex';
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

  function renderRecordsTable(filter) {
    const all = RecordStore.getAll();
    const filtered = all.filter(r => {
      // 文本搜索
      if (filter && !r.postOffice.includes(filter) && !r.institutionCode.includes(filter)) return false;
      // 省份筛选
      if (filterProvince && r.province !== filterProvince) return false;
      // 城市筛选
      if (filterCity && r.city !== filterCity) return false;
      // 区县筛选
      if (filterDistrict && r.district !== filterDistrict) return false;
      return true;
    });
    recordsCount.textContent = `共 ${all.length} 条记录`;

    const selectedIds = new Set(getSelectedIds());
    const COLSPAN = 9;

    if (filtered.length === 0) {
      recordsTbody.innerHTML = `<tr><td colspan="${COLSPAN}" style="text-align:center;color:#999;padding:20px;">暂无记录</td></tr>`;
      return;
    }

    recordsTbody.innerHTML = filtered.map(r => `
      <tr>
        <td style="width:32px;"><input type="checkbox" class="rec-select" data-id="${r.id}"${selectedIds.has(r.id) ? ' checked' : ''}></td>
        <td style="width:110px;font-family:monospace;font-size:11px;">${r.institutionCode}</td>
        <td style="width:150px;">${escHtml(r.province)}</td>
        <td style="width:150px;">${escHtml(r.city)}</td>
        <td style="width:150px;">${escHtml(r.district || '')}</td>
        <td>${escHtml(r.postOffice)}</td>
        <td style="width:140px;">${fmtCancelDate(r.cancelDate)}</td>
        <td style="width:120px;">${r.stampNumbers ? r.stampNumbers.join(', ') : '-'}</td>
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

    // 删除按钮
    recordsTbody.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (await Dialog.confirm('确定删除此记录？')) {
          RecordStore.delete(btn.dataset.id);
          renderRecordsTable(recordsSearch.value);
        }
      });
    });
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

    ids.forEach(id => RecordStore.update(id, updates));
    closeBatchModal();
    renderRecordsTable(recordsSearch.value);
  });

  // ---- 事件绑定 ----

  // 记录列表页面开关
  $('btn-show-records').addEventListener('click', showRecordsPage);
  $('btn-records-back').addEventListener('click', hideRecordsPage);

  // ============================================================
  // 工具箱页面
  // ============================================================
  function showToolsPage() {
    toolsPageOpen = true;
    $('main-container').style.display = 'none';
    $('btn-add-record-fab').style.display = 'none';
    if (recordsPageOpen) hideRecordsPage();
    toolsPage.style.display = 'flex';
  }

  function hideToolsPage() {
    toolsPageOpen = false;
    toolsPage.style.display = 'none';
    $('main-container').style.display = 'flex';
    $('btn-add-record-fab').style.display = '';
  }

  $('btn-show-tools').addEventListener('click', showToolsPage);
  $('btn-tools-back').addEventListener('click', hideToolsPage);

  recordsSearch.addEventListener('input', () => {
    renderRecordsTable(recordsSearch.value.trim());
  });

  recordsProvince.addEventListener('change', () => {
    filterProvince = recordsProvince.value;
    filterCity = '';
    filterDistrict = '';
    populateRecordsCity();
    populateRecordsDistrict();
    renderRecordsTable(recordsSearch.value.trim());
  });

  recordsCity.addEventListener('change', () => {
    filterCity = recordsCity.value;
    filterDistrict = '';
    populateRecordsDistrict();
    renderRecordsTable(recordsSearch.value.trim());
  });

  recordsDistrict.addEventListener('change', () => {
    filterDistrict = recordsDistrict.value;
    renderRecordsTable(recordsSearch.value.trim());
  });

  // 全选
  $('select-all').addEventListener('change', function () {
    recordsTbody.querySelectorAll('.rec-select').forEach(cb => cb.checked = this.checked);
    updateBatchBar();
  });

  // 批量编辑按钮
  $('btn-batch-edit').addEventListener('click', openBatchModal);

  // 批量删除
  $('btn-batch-delete').addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    if (!(await Dialog.confirm(`确定删除选中的 ${ids.length} 条记录？`))) return;
    if (!(await Dialog.confirm('再次确认删除？此操作不可恢复！'))) return;
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
      if (batchModalOpen) closeBatchModal();
      else if (toolsPageOpen) hideToolsPage();
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

  $('btn-import-json').addEventListener('click', () => {
    $('f-import-file').click();
  });

  $('f-import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const records = JSON.parse(ev.target.result);
        if (!Array.isArray(records)) throw new Error('格式错误');
        let imported = 0;
        records.forEach(r => {
          if (r.postOffice && r.province) {
            if (!r.institutionCode && r.postalCode) {
              r.institutionCode = RecordStore.generateInstCode(r.postalCode);
            }
            RecordStore.add(r);
            imported++;
          }
        });
        await Dialog.alert(`成功导入 ${imported} 条记录`);
        renderRecordsTable(recordsSearch.value);
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
    '状态': 'status', '邮局状态': 'status',
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

        let imported = 0;
        let errors = [];
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
            RecordStore.add(record);
            imported++;
          } catch (err) {
            errors.push(`第 ${i + 2} 行: ${err.message}`);
          }
        });

        let msg = `成功导入 ${imported} 条记录`;
        if (errors.length > 0) {
          msg += `\n跳过 ${errors.length} 条:\n${errors.slice(0, 5).join('\n')}`;
          if (errors.length > 5) msg += `\n...及其他 ${errors.length - 5} 条`;
        }
        await Dialog.alert(msg);
        renderRecordsTable(recordsSearch.value);
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
    if (!(await Dialog.confirm('确定清空所有记录？此操作不可恢复！'))) return;
    if (!(await Dialog.confirm('再次确认：清空所有日戳记录？'))) return;
    RecordStore.clear();
    renderRecordsTable('');
  });

  // 初始化批量编辑模块
  cacheBatchDoms();
  handleBatchToggle();
  initBatchProvinceLink();

  // ============================================================
  // 启动
  // ============================================================
  try {
    // 初始化表单
    EntryForm.init();

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

})();
