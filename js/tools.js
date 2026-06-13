/**
 * 工具箱 — 常用小工具集
 * =======================
 * 依赖: RecordStore (机构号生成), PostmarkData (数据查询)
 * 独立初始化，由 app.js 协调页面切换
 */
(function () {

  const $ = (id) => document.getElementById(id);

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
// 工具4: Base64 编解码
  // ============================================================
  function initBase64Tool() {
    const input = $('tool-b64-input');
    const output = $('tool-b64-output');
    const btn = $('tool-b64-exec');
    const mode = $('tool-b64-mode');

    if (!btn) return;

    btn.addEventListener('click', () => {
      const text = input.value;
      const isEncode = mode.value === 'encode';

      try {
        if (isEncode) {
          output.value = btoa(unescape(encodeURIComponent(text)));
        } else {
          output.value = decodeURIComponent(escape(atob(text.trim())));
        }
      } catch (e) {
        output.value = '错误: ' + e.message;
      }
    });

    // Ctrl+Enter 快捷键
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btn.click();
    });
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
  // 工具6: 随机地名生成器
  // ============================================================
  function initPlaceTool() {
    const btn = $('tool-place-gen');
    const codeEl = $('tool-place-code');
    const maxInput = $('tool-place-max');
    const btnRand = $('tool-place-rand');

    if (!btn) return;

    let currentPlace = '';

    function pickRandom(arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    }

    function generatePlace() {
      const provinces = PostmarkData.getAllProvinces();
      if (!provinces.length) { codeEl.textContent = '暂无行政区数据'; return ''; }

      const prov = pickRandom(provinces);
      let cityName, district;

      if (MUNICIPALITIES.includes(prov.name)) {
        cityName = prov.name;
        const dists = PostmarkData.getDistricts(cityName);
        district = dists.length ? pickRandom(dists) : cityName;
      } else {
        const cityNames = PostmarkData.getProvinceCityNames(prov.name);
        if (!cityNames.length) { codeEl.textContent = '无城市数据'; return ''; }
        cityName = pickRandom(cityNames);
        const dists = PostmarkData.getDistricts(cityName);
        district = dists.length ? pickRandom(dists) : cityName;
      }

      return prov.name + '/' + cityName + '/' + district;
    }

    function appendRandom() {
      if (!currentPlace) { btn.click(); return; }
      const max = parseInt(maxInput.value, 10);
      if (isNaN(max) || max < 0 || max > 100) { maxInput.value = '99'; }
      const rand = String(Math.floor(Math.random() * (max + 1))).padStart(2, '0');
      codeEl.textContent = currentPlace + '/' + rand;
    }

    btn.addEventListener('click', () => {
      currentPlace = generatePlace();
      if (currentPlace) appendRandom();
    });

    btnRand.addEventListener('click', appendRandom);
    maxInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') appendRandom();
    });
  }
  function init() {
    initInstCodeTool();
    initBarcodeTool();
    initBarcodeDisplayTool();
    initBase64Tool();
    initJsonTool();
    initPlaceTool();
    initCopyButtons();
  }

  // DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
