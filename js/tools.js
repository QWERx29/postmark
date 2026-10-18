/**
 * 工具箱 — 常用小工具集
 * =======================
 * 依赖: RecordStore (机构号生成), PostmarkData (数据查询)
 * 独立初始化，由 app.js 协调页面切换
 */
(function () {

  const $ = (id) => document.getElementById(id);

  // 网点检索 / 随机网点：供 app.js 在进入页面时刷新
  // （网点数据在应用启动后才从 base 导入，初始化时下拉可能还是空的）
  let refreshPOSearch = () => {};
  let refreshRandomPO = () => {};

  // ============================================================
  // 工具1: 机构号生成器
  // ============================================================
  function initInstCodeTool() {
    const input = $('tool-inst-input');
    const btn = $('tool-inst-gen');
    const result = $('tool-inst-result');
    const codeEl = $('tool-inst-code');
    const listEl = $('tool-inst-list');

    if (!btn) return;

    const history = JSON.parse(sessionStorage.getItem('tool_inst_history') || '[]');

    function renderHistory() {
      listEl.innerHTML = history.length === 0
        ? '<span style="color:#bbb;font-size:12px;">暂无历史</span>'
        : history.slice().reverse().slice(0, 20).map(h =>
            `<div class="tool-history-item">
              <code style="font-size:15px;font-weight:600;color:#00991A;letter-spacing:2px;">${h.code}</code>
              <span class="tool-hi-time">← ${h.postal}</span>
            </div>`
          ).join('');
    }

    btn.addEventListener('click', () => {
      const raw = input.value.trim();
      if (!/^\d{6}$/.test(raw)) {
        codeEl.textContent = '请输入 6 位数字邮编';
        codeEl.style.color = '#ff4d4f';
        result.style.display = 'flex';
        result.style.borderColor = '#ffa39e';
        result.style.background = '#fff2f0';
        return;
      }
      result.style.borderColor = '#b7eb8f';
      result.style.background = '#f6ffed';
      codeEl.style.color = '#00991A';
      const code = RecordStore.generateInstCode(raw);
      codeEl.textContent = code;
      result.style.display = 'flex';
      history.push({ postal: raw, code, time: new Date().toLocaleTimeString() });
      sessionStorage.setItem('tool_inst_history', JSON.stringify(history));
      renderHistory();
    });

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '');
    });

    // Enter 键触发
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });

    renderHistory();
  }

  // ============================================================
  // 工具2: 信函条码校验与生成
  // ============================================================
  /**
   * 计算校验码 — 根据 8 位序列号
   * 算法: 加权和 mod 11, 余数 0 → 5, 余数 10 → 0, 其他 → 11−余数
   */
  function calcCheckDigit(serial) {
    const weights = [8, 6, 4, 2, 3, 5, 9, 7];
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      sum += parseInt(serial[i], 10) * weights[i];
    }
    const remainder = sum % 11;
    if (remainder === 0) return 5;
    const check = 11 - remainder;
    return check === 10 ? 0 : check;
  }

  /** 根据 adcode 前两位查找省级行政区名称 */
  function lookupProvince(prefix) {
    // 从 PROVINCE_DATA 构建映射: "11" → "北京市", "31" → "上海市", ...
    if (!lookupProvince._map) {
      lookupProvince._map = {};
      PROVINCE_DATA.forEach(p => {
        const key = String(p.adcode).slice(0, 2);
        lookupProvince._map[key] = p.name;
      });
    }
    return lookupProvince._map[prefix] || null;
  }

  /** 国家/地区代码映射 */
  const COUNTRY_MAP = {
    'CN': '中国', 'JP': '日本', 'KR': '韩国', 'US': '美国',
    'GB': '英国', 'DE': '德国', 'FR': '法国', 'RU': '俄罗斯',
    'AU': '澳大利亚', 'CA': '加拿大', 'SG': '新加坡', 'TH': '泰国',
    'VN': '越南', 'MY': '马来西亚', 'IN': '印度', 'IT': '意大利',
    'ES': '西班牙', 'NL': '荷兰', 'CH': '瑞士', 'NZ': '新西兰',
    'HK': '中国香港', 'MO': '中国澳门', 'TW': '中国台湾',
  };

  /** 信函种类说明 (第一位) */
  const LETTER_TYPE_MAP = {
    'X': '国内给据信函',
    'S': '国内给据印刷品',
    'R': '国际挂号信刷',
  };

  function initBarcodeTool() {
    // ---- 校验 ----
    const input = $('tool-bc-input');
    const btnCheck = $('tool-bc-check');
    const verifyBox = $('tool-bc-verify');
    const elTypeInfo = $('tool-bc-type-info');
    const elRegionInfo = $('tool-bc-region-info');
    const elVerdict = $('tool-bc-verdict');

    if (!btnCheck) return;

    btnCheck.addEventListener('click', () => {
      const raw = input.value.trim().toUpperCase();
      if (raw.length !== 13) {
        showError('错误：条码必须为 13 位'); return;
      }

      // 第3-10位 (1-indexed) = indices 2-9 为序列号，必须是数字
      const serial = raw.slice(2, 10);
      if (!/^\d{8}$/.test(serial)) {
        showError('错误：第3-10位序列号必须为 8 位数字'); return;
      }

      // 第11位 (index 10) 校验码，必须是数字
      if (!/^\d$/.test(raw[10])) {
        showError('错误：第11位校验码必须为数字'); return;
      }

      // ---- 解析信函种类 ----
      const typeChar = raw[0];
      const subType = raw[1];
      const typeDesc = LETTER_TYPE_MAP[typeChar];
      if (typeDesc) {
        elTypeInfo.textContent = typeChar + ' ( ' + typeDesc + ' )  子类: ' + subType;
        elTypeInfo.style.color = '#333';
      } else {
        elTypeInfo.textContent = raw.slice(0, 2) + ' — 未知信函种类';
        elTypeInfo.style.color = '#faad14';
      }

      // ---- 解析地区代码 ----
      const regionCode = raw.slice(11, 13);
      if (typeChar === 'X' || typeChar === 'S') {
        // 国内：两位数字对应省级行政区 adcode 前两位
        if (/^\d{2}$/.test(regionCode)) {
          const provName = lookupProvince(regionCode);
          if (provName) {
            elRegionInfo.textContent = regionCode + ' ( ' + provName + ' )';
            elRegionInfo.style.color = '#333';
          } else {
            elRegionInfo.textContent = regionCode + ' ( 未知省份代码 )';
            elRegionInfo.style.color = '#faad14';
          }
        } else {
          elRegionInfo.textContent = regionCode + ' — 国内条码地区代码应为数字';
          elRegionInfo.style.color = '#ff4d4f';
        }
      } else if (typeChar === 'R') {
        // 国际：字母代表国家/地区
        if (/^[A-Z]{2}$/.test(regionCode)) {
          const countryName = COUNTRY_MAP[regionCode];
          if (countryName) {
            elRegionInfo.textContent = regionCode + ' ( ' + countryName + ' )';
            elRegionInfo.style.color = '#333';
          } else {
            elRegionInfo.textContent = regionCode + ' ( 未知国家/地区 )';
            elRegionInfo.style.color = '#faad14';
          }
        } else {
          elRegionInfo.textContent = regionCode + ' — 国际条码地区代码应为字母';
          elRegionInfo.style.color = '#ff4d4f';
        }
      } else {
        elRegionInfo.textContent = regionCode + ' ( 无法解析：未知信函种类 )';
        elRegionInfo.style.color = '#999';
      }

      // ---- 校验 ----
      const expectedCheck = calcCheckDigit(serial);
      const actualCheck = parseInt(raw[10], 10);

      verifyBox.style.display = 'block';
      if (expectedCheck === actualCheck) {
        elVerdict.textContent = '✓ 校验通过';
        elVerdict.style.color = '#00991A';
        verifyBox.style.borderColor = '#b7eb8f';
        verifyBox.style.background = '#f6ffed';
      } else {
        elVerdict.textContent = '✗ 校验失败，期望校验码为 ' + expectedCheck + '，实际为 ' + actualCheck;
        elVerdict.style.color = '#ff4d4f';
        verifyBox.style.borderColor = '#ffa39e';
        verifyBox.style.background = '#fff2f0';
      }
    });

    /** 显示错误信息 */
    function showError(msg) {
      elTypeInfo.textContent = '-';
      elTypeInfo.style.color = '#999';
      elRegionInfo.textContent = '-';
      elRegionInfo.style.color = '#999';
      verifyBox.style.display = 'block';
      elVerdict.textContent = msg;
      elVerdict.style.color = '#ff4d4f';
      verifyBox.style.borderColor = '#ffa39e';
      verifyBox.style.background = '#fff2f0';
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnCheck.click();
    });

    // ---- 批量生成 ----
    const genKind = $('tool-bc-gen-kind');
    const genRegion = $('tool-bc-gen-region');
    const genStart = $('tool-bc-gen-start');
    const genCount = $('tool-bc-gen-count');
    const btnGen = $('tool-bc-generate');
    const genResult = $('tool-bc-gen-result');
    const genList = $('tool-bc-gen-list');

    // 限制输入为字母和数字（种类、地区）；序列号仅数字
    [genKind, genRegion].forEach(el => {
      el.addEventListener('input', () => {
        el.value = el.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      });
    });
    genStart.addEventListener('input', () => {
      genStart.value = genStart.value.replace(/\D/g, '');
    });

    btnGen.addEventListener('click', () => {
      const kind = genKind.value.trim();
      const region = genRegion.value.trim();
      const startSerial = genStart.value.trim();
      const count = parseInt(genCount.value, 10) || 5;

      if (kind.length !== 2) { genList.value = '错误：信函种类必须为 2 位（字母或数字）'; genResult.style.display = 'block'; return; }
      if (region.length !== 2) { genList.value = '错误：地区代码必须为 2 位（字母或数字）'; genResult.style.display = 'block'; return; }
      if (!/^\d{8}$/.test(startSerial)) { genList.value = '错误：起始序列号必须为 8 位数字'; genResult.style.display = 'block'; return; }
      if (count < 1 || count > 100) { genList.value = '错误：生成数量需在 1-100 之间'; genResult.style.display = 'block'; return; }

      const start = parseInt(startSerial, 10);
      const codes = [];
      for (let i = 0; i < count; i++) {
        const serial = String(start + i).padStart(8, '0');
        if (serial.length > 8) { genList.value = '错误：起始序列号过大，超出 8 位范围'; genResult.style.display = 'block'; return; }
        const check = calcCheckDigit(serial);
        // 格式: 信函种类(2) + 序列号(8) + 校验码(1) + 地区代码(2) = 13 位
        codes.push(kind + serial + check + region);
      }
      genList.value = codes.join('\n');
      genResult.style.display = 'block';
    });

    // ---- 复制全部 ----
    $('tool-bc-copy-all').addEventListener('click', () => {
      const text = genList.value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('tool-bc-copy-all');
        const orig = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {});
    });
  }

  // ============================================================
  // 工具3: 条码展示
	  // ============================================================
	  function initBarcodeDisplayTool() {
		const input = $('tool-bc-show-input');
		const btnGen = $('tool-bc-show-gen');
		const formatSelect = $('tool-bc-show-format');
		const resultBox = $('tool-bc-show-result');
		const msgEl = $('tool-bc-show-msg');
		const svgEl = $('tool-bc-show-svg');
		const textEl = $('tool-bc-show-text');
		const btnDownload = $('tool-bc-show-download');

		if (!btnGen) return;

		/** 显示错误信息 */
		function showError(msg) {
			msgEl.textContent = msg;
			msgEl.style.display = 'block';
			svgEl.innerHTML = '';
			textEl.textContent = '';
			resultBox.style.display = 'block';
		}

		/** 显示成功条码 */
		function showBarcode(value, format) {
			msgEl.style.display = 'none';
			textEl.textContent = value;
			resultBox.style.display = 'block';

			try {
				// 使用 JsBarcode 渲染到 SVG
				svgEl.innerHTML = '';
				JsBarcode(svgEl, value, {
					format: format,
					width: 2,
					height: 80,
					displayValue: false,
					margin: 10,
					background: '#ffffff',
					lineColor: '#000000',
					valid: function (valid) {
						if (!valid) {
							showError('条码号不符合所选格式 "' + format + '" 的编码规则，请检查输入或更换格式');
						}
					}
				});
			} catch (e) {
				showError('生成条码失败: ' + e.message);
			}
		}

		btnGen.addEventListener('click', () => {
			const value = input.value.trim();
			const format = formatSelect.value;

			if (!value) {
				showError('请输入条码号');
				return;
			}

			// 根据格式进行基本校验
			if (format === 'EAN13' || format === 'EAN8' || format === 'UPC') {
				if (!/^\d+$/.test(value)) {
					showError('错误: ' + format + ' 格式要求纯数字');
					return;
				}
			}

			if (format === 'pharmacode') {
				if (!/^\d+$/.test(value)) {
					showError('错误: Pharmacode 格式要求纯数字');
					return;
				}
			}

			showBarcode(value, format);
		});

		// Enter 键触发
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') btnGen.click();
		});

		// 下载 SVG
		btnDownload.addEventListener('click', () => {
			const svgMarkup = svgEl.innerHTML;
			if (!svgMarkup) return;

			const svgFull = '<?xml version="1.0" standalone="no"?>\n' +
				'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
				svgEl.outerHTML;

			const blob = new Blob([svgFull], { type: 'image/svg+xml' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'barcode-' + (textEl.textContent || 'output') + '.svg';
			a.click();
			URL.revokeObjectURL(url);
		});
	}
  // ============================================================
  // 已收集记录索引 — 用于在网点检索结果中标记「已收集」
  // 匹配口径: 属地(省 + 区县) + 名称 + 邮编 全部一致，不计「市」
  // 仅参考 POST 数据源，SPB 不参与匹配
  // ============================================================
  const COLLECTED_SEP = '\u0001';

  function normField(s) {
    return (s == null ? '' : String(s)).trim();
  }

  /**
   * 归一化网点名称: 去掉末尾的状态括注
   * 参考库里有 651 条形如「安大新区邮政所（暂停）」「新何邮政所（撤销）」
   * 括注是状态标注而非名称本身，不参与匹配
   */
  function normName(s) {
    let name = normField(s);
    const trailingParen = /\s*[（(][^（()）]*[）)]\s*$/;
    while (trailingParen.test(name)) name = name.replace(trailingParen, '');
    return name.trim();
  }

  /** 匹配键: 省 + 区县 + 名称(去尾部括注) + 邮编 */
  function collectedKey(r) {
    return [r.province, r.district, normName(r.name), r.postalCode]
      .map(normField).join(COLLECTED_SEP);
  }

  let _collectedKeys = null;

  function getCollectedKeys() {
    if (_collectedKeys) return _collectedKeys;
    const keys = new Set();
    if (typeof RecordStore !== 'undefined') {
      for (const rec of RecordStore.getAll()) {
        // 记录里叫 postOffice，参考库里叫 name
        keys.add(collectedKey({
          province: rec.province,
          district: rec.district,
          name: rec.postOffice,
          postalCode: rec.postalCode,
        }));
      }
    }
    _collectedKeys = keys;
    return _collectedKeys;
  }

  // 记录增删改后索引失效，下次检索时重建
  if (typeof RecordStore !== 'undefined') {
    RecordStore.onChange(() => { _collectedKeys = null; });
  }

  /** 判断参考库网点是否已被收集（SPB 不参与） */
  function isCollected(rec) {
    if (rec.source !== 'post') return false;
    return getCollectedKeys().has(collectedKey(rec));
  }

  // ============================================================
  // 工具4: 网点检索
  // ============================================================
  /** 未指定省级行政区时的展示上限；指定省份后不再截断 */
  const SEARCH_LIMIT = 200;

  function initPOSearchTool() {
    const provinceSel = $('tool-po-search-province');
    const citySel = $('tool-po-search-city');
    const districtSel = $('tool-po-search-district');
    const sourceSel = $('tool-po-search-source');
    const keywordInput = $('tool-po-search-input');
    const historyCb = $('tool-po-search-history');
    const clearBtn = $('tool-po-search-clear');
    const bodyEl = $('tool-po-search-body');
    const metaEl = $('tool-po-search-meta');
    const emptyEl = $('tool-po-search-empty');

    if (!provinceSel) return;

    let debounceTimer = null;

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    // ---- 填充筛选下拉 ----
    function populateProvinces() {
      const provs = PODatabase.getDataProvinces();
      provinceSel.innerHTML = '<option value="">全部省份</option>';
      provs.forEach(p => {
        provinceSel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}（${p.postCount + p.spbCount}）</option>`;
      });
    }

    function populateCities() {
      const provName = provinceSel.value;
      citySel.innerHTML = '<option value="">全部城市</option>';
      citySel.disabled = !provName;
      if (provName) {
        PODatabase.getDataCities(provName).forEach(c => {
          citySel.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`;
        });
      }
    }

    function populateDistricts() {
      const provName = provinceSel.value;
      const cityName = citySel.value;
      districtSel.innerHTML = '<option value="">全部区县</option>';
      districtSel.disabled = !cityName;
      if (provName && cityName) {
        PODatabase.getDataDistricts(provName, cityName).forEach(d => {
          districtSel.innerHTML += `<option value="${esc(d)}">${esc(d)}</option>`;
        });
      }
    }

    // ---- 执行检索 ----
    function runSearch() {
      const withHistory = !historyCb || historyCb.checked;
      const query = {
        province: provinceSel.value,
        city: citySel.value,
        district: districtSel.value,
        source: sourceSel.value,
        keyword: keywordInput.value.trim(),
        // 历史归档（base_old）默认一起检索；取消勾选就只看当前有效网点
        includeHistory: withHistory,
        // 已指定省级行政区时不再截断，有多少展示多少
        limit: provinceSel.value ? Number.MAX_SAFE_INTEGER : SEARCH_LIMIT,
      };
      const results = PODatabase.search(query);
      const total = PODatabase.count();
      const historyTotal = PODatabase.historyCount();

      if (results.length === 0) {
        bodyEl.innerHTML = '';
        emptyEl.style.display = 'block';
        emptyEl.textContent = total === 0
          ? '暂无网点数据，请确保 base 目录有数据并重启应用'
          : '没有符合条件的网点';
        metaEl.textContent = `网点总数 ${total} 条` + metaHistoryNote(historyTotal, withHistory);
        return;
      }

      let collectedCount = 0;
      let historyCount = 0;
      const rows = results.map(r => {
        // 省 + 区县 + 名称 + 邮编 与已收集记录一致的 POST 网点，名称标绿
        const hit = !r.historical && isCollected(r);
        if (hit) collectedCount++;
        if (r.historical) historyCount++;
        const badge = r.historical
          ? `<span class="po-history" title="${esc(historyTitle(r))}">历史</span>`
          : '';
        return `
        <tr${r.historical ? ' class="po-history-row"' : ''}>
          <td${hit ? ' class="po-collected" title="该网点已有收集记录"' : ''}>${esc(r.name)}${badge}</td>
          <td>${esc(r.province)}${r.city ? ' / ' + esc(r.city) : ''}${r.district ? ' / ' + esc(r.district) : ''}</td>
          <td>${r.postalCode ? esc(r.postalCode) : '-'}</td>
          <td><span class="tpo-src ${r.source}">${r.source === 'post' ? 'POST' : 'SPB'}</span></td>
        </tr>`;
      }).join('');

      emptyEl.style.display = 'none';
      const limitNote = provinceSel.value ? '' : `（最多显示 ${SEARCH_LIMIT} 条）`;
      metaEl.textContent = `网点总数 ${total} 条，匹配 ${results.length} 条${limitNote}`
        + (historyCount > 0 ? `，其中历史归档 ${historyCount} 条` : '')
        + (collectedCount > 0 ? `，${collectedCount} 条已收集` : '')
        + metaHistoryNote(historyTotal, withHistory);
      bodyEl.innerHTML = rows;
    }

    /** 历史归档的提示语（取消勾选时说明为什么看不到旧网点） */
    function metaHistoryNote(historyTotal, withHistory) {
      if (!historyTotal) return '';
      return withHistory
        ? `（含历史归档共 ${historyTotal} 条）`
        : `（已排除历史归档 ${historyTotal} 条）`;
    }

    /** 历史记录徽标的悬浮说明：归档原因 + 归档时间 */
    function historyTitle(r) {
      const parts = ['历史归档（当前库中已无此网点）'];
      if (r.archiveReason) parts.push('原因：' + r.archiveReason);
      if (r.archiveDate) parts.push('归档于 ' + r.archiveDate);
      return parts.join('，');
    }

    // ---- 事件绑定 ----
    provinceSel.addEventListener('change', () => {
      populateCities();
      populateDistricts();
      runSearch();
    });
    citySel.addEventListener('change', () => {
      populateDistricts();
      runSearch();
    });
    districtSel.addEventListener('change', runSearch);
    sourceSel.addEventListener('change', runSearch);
    if (historyCb) historyCb.addEventListener('change', runSearch);
    keywordInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, 200);
    });
    keywordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(debounceTimer); runSearch(); }
    });
    clearBtn.addEventListener('click', () => {
      provinceSel.value = '';
      citySel.value = '';
      districtSel.value = '';
      sourceSel.value = '';
      keywordInput.value = '';
      if (historyCb) historyCb.checked = true;
      populateCities();
      populateDistricts();
      runSearch();
    });

    // ---- 刷新（重建筛选下拉，尽量保留当前选择） ----
    function refresh() {
      const keepProvince = provinceSel.value;
      const keepCity = citySel.value;
      const keepDistrict = districtSel.value;

      populateProvinces();
      provinceSel.value = keepProvince;
      populateCities();
      citySel.value = keepCity;
      populateDistricts();
      districtSel.value = keepDistrict;

      runSearch();
    }

    // ---- 初始渲染 ----
    refresh();
    refreshPOSearch = refresh;
  }

  // ============================================================
  // 工具5: JSON 格式化
  // ============================================================
  function initJsonTool() {
    const input = $('tool-json-input');
    const output = $('tool-json-output');
    const btn = $('tool-json-exec');
    const mode = $('tool-json-mode');

    if (!btn) return;

    btn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) { output.value = '请输入 JSON'; return; }

      try {
        const parsed = JSON.parse(text);
        if (mode.value === 'format') {
          output.value = JSON.stringify(parsed, null, 2);
        } else {
          output.value = JSON.stringify(parsed);
        }
      } catch (e) {
        output.value = 'JSON 解析错误: ' + e.message;
      }
    });

    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btn.click();
    });
  }

  // ============================================================
  // 全局复制功能
  // ============================================================
  function initCopyButtons() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-copy');
      if (!btn) return;
      const targetId = btn.dataset.target;
      const el = document.getElementById(targetId);
      if (!el) return;

      const text = el.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      }).catch(() => {
        // fallback
        const range = document.createRange();
        range.selectNode(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
      });
    });
  }

  // ============================================================
  // 工具5: 随机网点
  // ============================================================
  function initRandomPOTool() {
    const sourceSel = $('tool-rnd-source');
    const provinceSel = $('tool-rnd-province');
    const citySel = $('tool-rnd-city');
    const districtSel = $('tool-rnd-district');
    const genBtn = $('tool-rnd-gen');
    const resultEl = $('tool-rnd-result');
    const nameEl = $('tool-rnd-name');
    const locEl = $('tool-rnd-loc');
    const postalEl = $('tool-rnd-postal');
    const srcEl = $('tool-rnd-src');
    const countEl = $('tool-rnd-count');

    if (!genBtn) return;

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    // ---- 填充筛选下拉 ----
    function populateProvinces() {
      provinceSel.innerHTML = '<option value="">全部省份</option>';
      PODatabase.getDataProvinces().forEach(p => {
        provinceSel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}（${p.postCount + p.spbCount}）</option>`;
      });
    }

    function populateCities() {
      const provName = provinceSel.value;
      citySel.innerHTML = '<option value="">全部城市</option>';
      citySel.disabled = !provName;
      if (provName) {
        PODatabase.getDataCities(provName).forEach(c => {
          citySel.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`;
        });
      }
    }

    function populateDistricts() {
      const provName = provinceSel.value;
      const cityName = citySel.value;
      districtSel.innerHTML = '<option value="">全部区县</option>';
      districtSel.disabled = !cityName;
      if (provName && cityName) {
        PODatabase.getDataDistricts(provName, cityName).forEach(d => {
          districtSel.innerHTML += `<option value="${esc(d)}">${esc(d)}</option>`;
        });
      }
    }

    // ---- 随机抽取 ----
    function show(record) {
      nameEl.textContent = record.name || '(无名称)';
      locEl.textContent = [record.province, record.city, record.district]
        .filter(Boolean).join(' / ') || '-';
      postalEl.textContent = record.postalCode || '-';
      srcEl.textContent = record.source === 'post' ? 'POST' : 'SPB';
      srcEl.className = 'tpo-src ' + record.source;
      resultEl.style.display = 'flex';
    }

    function currentPool() {
      return PODatabase.search({
        source: sourceSel.value,
        province: provinceSel.value,
        city: citySel.value,
        district: districtSel.value,
        // 随机网点只从当前有效网点里抽：归档里的已撤销/旧名称不该被抽中
        includeHistory: false,
        limit: Number.MAX_SAFE_INTEGER,
      });
    }

    /** 更新候选数量提示 */
    function updateCount(pool) {
      countEl.textContent = pool.length > 0
        ? `候选 ${pool.length} 个网点`
        : (PODatabase.count() === 0
            ? '暂无网点数据，请确保 base 目录有数据并重启应用'
            : '没有符合条件的网点');
    }

    function generate() {
      const pool = currentPool();
      updateCount(pool);
      if (pool.length === 0) { resultEl.style.display = 'none'; return; }
      show(pool[Math.floor(Math.random() * pool.length)]);
    }

    // ---- 事件绑定 ----
    sourceSel.addEventListener('change', generate);
    provinceSel.addEventListener('change', () => {
      populateCities();
      populateDistricts();
      generate();
    });
    citySel.addEventListener('change', () => {
      populateDistricts();
      generate();
    });
    districtSel.addEventListener('change', generate);
    genBtn.addEventListener('click', generate);

    // ---- 刷新（重建筛选下拉，尽量保留当前选择） ----
    function refresh() {
      const keepProvince = provinceSel.value;
      const keepCity = citySel.value;
      const keepDistrict = districtSel.value;

      populateProvinces();
      provinceSel.value = keepProvince;
      populateCities();
      citySel.value = keepCity;
      populateDistricts();
      districtSel.value = keepDistrict;

      // 只更新候选数，不重新抽签，避免每次进入工具箱都换掉已生成的结果
      updateCount(currentPool());
    }

    // ---- 初始渲染 ----
    refresh();
    refreshRandomPO = refresh;
  }
  function init() {
    initInstCodeTool();
    initBarcodeTool();
    initBarcodeDisplayTool();
    initPOSearchTool();
    initJsonTool();
    initRandomPOTool();
    initCopyButtons();
  }

  // 对外接口（app.js 使用）
  window.Tools = {
    refreshPOSearch: () => refreshPOSearch(),
    refreshRandomPO: () => refreshRandomPO(),
  };

  // DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
