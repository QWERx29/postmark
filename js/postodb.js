/**
 * PO 参考数据库 — 导入 crawler.py 输出的 CSV，支持市名校正与自动填充查询
 * ======================================================================
 * 依赖: PostmarkData (data.js), DISTRICT_MAP, POSTAL_CODE_HINTS, PROVINCE_DATA
 *
 * 数据分层存储:
 *   poref_meta        → { totalCount, provinces: [...], sources, lastImportTime }
 *   poref_data_{adcode} → 该省所有 PO 记录数组
 */

const PODatabase = (function () {

  const META_KEY = 'poref_meta';
  const DATA_PREFIX = 'poref_data_';

  // ================================================================
  // 内部缓存
  // ================================================================
  let _metaCache = null;
  /** 邮编 → 记录 的内存索引 (惰性构建) */
  let _postalCodeIndex = null;
  /** 全量记录内存缓存 (惰性构建，用于综合检索) */
  let _allRecords = null;
  /** 区县→市 反向查找缓存 (按省名) */
  const _districtCityCache = {};

  // ================================================================
  // 元数据
  // ================================================================

  function _loadMeta() {
    if (_metaCache) return _metaCache;
    try {
      const raw = localStorage.getItem(META_KEY);
      _metaCache = raw ? JSON.parse(raw) : {
        totalCount: 0,
        sources: [],
        provinces: [],
        lastImportTime: null,
      };
    } catch {
      _metaCache = { totalCount: 0, sources: [], provinces: [], lastImportTime: null };
    }
    return _metaCache;
  }

  function _saveMeta() {
    if (!_metaCache) return;
    try {
      localStorage.setItem(META_KEY, JSON.stringify(_metaCache));
    } catch (e) {
      console.error('[PODB] 保存元数据失败:', e);
    }
  }

  // ================================================================
  // 省份数据读写
  // ================================================================

  function _getProvinceData(adcode) {
    try {
      const raw = localStorage.getItem(DATA_PREFIX + adcode);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function _saveProvinceData(adcode, records) {
    try {
      localStorage.setItem(DATA_PREFIX + adcode, JSON.stringify(records));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        throw new Error('存储空间不足，请清理部分数据后重试');
      }
      throw e;
    }
  }

  // ================================================================
  // GBK → UTF-8 解码
  // ================================================================

  function _decodeGBK(buffer) {
    // TextDecoder 在现代浏览器中支持 'gbk'
    const decoder = new TextDecoder('gbk', { fatal: false });
    return decoder.decode(buffer);
  }

  // ================================================================
  // 手动 CSV 解析 (支持引号转义、混合换行)
  // ================================================================

  function _parseCSV(text) {
    const rows = [];
    let current = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          current.push(field.trim());
          field = '';
        } else if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          // CRLF
          current.push(field.trim());
          field = '';
          if (current.some(f => f !== '')) rows.push(current);
          current = [];
          i++;
        } else if (ch === '\n' || ch === '\r') {
          // LF or lone CR
          current.push(field.trim());
          field = '';
          if (current.some(f => f !== '')) rows.push(current);
          current = [];
        } else {
          field += ch;
        }
      }
    }
    // 最后一行（无尾随换行）
    current.push(field.trim());
    if (current.some(f => f !== '')) rows.push(current);

    return rows;
  }

  // ================================================================
  // 市名校正 — 核心算法
  // ================================================================

  /**
   * 构建 "区县名 → 市名" 反向查找表 (按省作用域)
   */
  function _buildDistrictCityLookup(provinceName) {
    if (_districtCityCache[provinceName]) return _districtCityCache[provinceName];

    const province = (typeof PostmarkData !== 'undefined')
      ? PostmarkData.getProvinceByName(provinceName)
      : null;
    const lookup = {};

    if (province) {
      for (const city of province.cities) {
        const districts = (typeof PostmarkData !== 'undefined')
          ? PostmarkData.getDistricts(city.name)
          : (DISTRICT_MAP[city.name] || []);
        for (const dist of districts) {
          if (!lookup[dist]) lookup[dist] = city.name;
        }
        // 市名本身也作为 key（县级市情况）
        if (!lookup[city.name]) lookup[city.name] = city.name;
      }
    }
    _districtCityCache[provinceName] = lookup;
    return lookup;
  }

  /**
   * 校正"市"字段
   * @param {string} provinceName - 省 (可靠)
   * @param {string} districtName  - 区/市/县 (可靠)
   * @param {string} originalCity  - 原始市名 (不可靠)
   * @param {string} postalCode    - 邮编 (POST 数据有，SPB 无)
   * @returns {string} 校正后市名
   */
  function _correctCity(provinceName, districtName, originalCity, postalCode) {
    if (!provinceName || !districtName) return originalCity || '';

    const lookup = _buildDistrictCityLookup(provinceName);

    // 阶段1: DISTRICT_MAP 反查
    if (lookup[districtName]) {
      return lookup[districtName];
    }

    // 阶段2: 去掉"市/县/区"后缀后重试
    const stripped = districtName.replace(/[市县区]$/, '');
    if (stripped !== districtName && lookup[stripped]) {
      return lookup[stripped];
    }

    // 阶段3: 邮编前缀匹配
    if (postalCode && postalCode.length >= 6) {
      const prefix = postalCode.slice(0, 4);
      const province = (typeof PostmarkData !== 'undefined')
        ? PostmarkData.getProvinceByName(provinceName) : null;
      if (province) {
        for (const city of province.cities) {
          if (POSTAL_CODE_HINTS[city.name] === prefix) return city.name;
        }
        // 直辖市：区名作为 key
        if (MUNICIPALITIES.includes(provinceName)) {
          for (const city of province.cities) {
            if (POSTAL_CODE_HINTS[city.name] === prefix) return city.name;
          }
        }
      }
    }

    // 阶段4: 原始市名校验 — 以"市"结尾且其下属区县包含目标区县
    if (originalCity && originalCity.endsWith('市') && DISTRICT_MAP[originalCity]) {
      if (DISTRICT_MAP[originalCity].includes(districtName)) return originalCity;
    }

    // 阶段5: 兜底
    return originalCity || '';
  }

  // ================================================================
  // 邮编推导 (SPB 数据无邮编)
  // ================================================================

  function _derivePostalCode(provinceName, cityName, districtName) {
    // 1. 区县级别覆盖
    if (typeof POSTAL_CODE_DISTRICT_OVERRIDE !== 'undefined' && POSTAL_CODE_DISTRICT_OVERRIDE[districtName]) {
      return POSTAL_CODE_DISTRICT_OVERRIDE[districtName] + '00';
    }
    // 2. 区县名直接作为 POSTAL_CODE_HINTS 的 key (直辖市)
    if (POSTAL_CODE_HINTS[districtName]) return POSTAL_CODE_HINTS[districtName] + '00';
    // 3. 市名 hint
    if (cityName && POSTAL_CODE_HINTS[cityName]) return POSTAL_CODE_HINTS[cityName] + '00';
    // 4. 省名 hint (直辖市)
    if (POSTAL_CODE_HINTS[provinceName]) return POSTAL_CODE_HINTS[provinceName] + '00';
    return '';
  }

  // ================================================================
  // 省份检测: 根据省名找 adcode
  // ================================================================

  function _findProvinceAdcode(provinceName) {
    const prov = (typeof PostmarkData !== 'undefined')
      ? PostmarkData.getProvinceByName(provinceName) : null;
    return prov ? prov.adcode : null;
  }

  // ================================================================
  // 邮编索引 (惰性构建)
  // ================================================================

  function _buildPostalCodeIndex() {
    if (_postalCodeIndex) return;
    _postalCodeIndex = {};
    const meta = _loadMeta();
    for (const p of meta.provinces) {
      const records = _getProvinceData(p.adcode);
      for (const r of records) {
        if (r.postalCode && r.postalCode.length === 6) {
          if (!_postalCodeIndex[r.postalCode]) _postalCodeIndex[r.postalCode] = [];
          if (_postalCodeIndex[r.postalCode].length < 15) { // 每个邮编最多存15条
            _postalCodeIndex[r.postalCode].push(r);
          }
        }
      }
    }
  }

  function _applyFilter(matches, filter) {
    if (!filter) return matches;
    let result = matches;
    if (filter.province) result = result.filter(r => r.province === filter.province);
    if (filter.city)     result = result.filter(r => r.city === filter.city);
    return result;
  }

  function _invalidateIndex() {
    _postalCodeIndex = null;
    _allRecords = null;
  }

  // ================================================================
  // 清空参考库数据
  // ================================================================

  /**
   * 删除所有省份分片数据。
   * 只操作本模块自己的 poref_data_* 键，日戳记录 (store.js)、
   * 地图缓存等其他 localStorage 数据不受影响。
   */
  function _clearAllProvinceData() {
    // 先收集、后删除：边遍历边删会让 localStorage 的索引错位
    const keys = new Set();
    for (const p of _loadMeta().provinces) keys.add(DATA_PREFIX + p.adcode);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DATA_PREFIX)) keys.add(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  }

  // ================================================================
  // 全量记录缓存 (用于综合检索与筛选下拉)
  // ================================================================

  function _buildAllRecords() {
    if (_allRecords) return _allRecords;
    const all = [];
    const meta = _loadMeta();
    for (const p of meta.provinces) {
      const records = _getProvinceData(p.adcode);
      for (const r of records) all.push(r);
    }
    _allRecords = all;
    return _allRecords;
  }

  // ================================================================
  // 筛选下拉排序 (按行政区划代码顺序)
  // ================================================================

  /**
   * 按参考表顺序排列名称数组 (参考表本身按行政区划代码升序)。
   * 参考表中没有的名称排在最后，彼此按名称字典序，保证结果稳定。
   * @param {string[]} names
   * @param {string[]} refOrder
   * @returns {string[]}
   */
  function _sortByRefOrder(names, refOrder) {
    const rank = new Map();
    refOrder.forEach((name, i) => {
      if (!rank.has(name)) rank.set(name, i);
    });
    const unknown = refOrder.length;
    return names.slice().sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a) : unknown;
      const rb = rank.has(b) ? rank.get(b) : unknown;
      if (ra !== rb) return ra - rb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  /**
   * 某省的城市参考顺序 — 按 city.adcode 升序。
   * 直辖市下 cities 即各区，同样适用。
   * @param {string} provinceName
   * @returns {string[]}
   */
  function _refCityOrder(provinceName) {
    if (typeof PostmarkData === 'undefined') return [];
    const prov = PostmarkData.getProvinceByName(provinceName);
    if (!prov || !prov.cities) return [];
    return prov.cities.slice().sort((a, b) => a.adcode - b.adcode).map(c => c.name);
  }

  /**
   * 某市的区县参考顺序 — DISTRICT_MAP 未记录区县 adcode，
   * 沿用其数组录入顺序 (即行政区划代码顺序)。
   * @param {string} cityName
   * @returns {string[]}
   */
  function _refDistrictOrder(cityName) {
    if (typeof PostmarkData === 'undefined') return [];
    return PostmarkData.getDistricts(cityName) || [];
  }

  // ================================================================
  // 公开 API
  // ================================================================

  return {

    // ---- 导入 ----

    /**
     * 批量导入多个 CSV 文件 (一次完成元数据重建)
     * @param {Array<{buffer: ArrayBuffer, sourceType: 'post'|'spb', name?: string}>} files
     * @param {Function} onProgress - (doneFiles, totalFiles) => void
     * @param {Object} [opts]
     * @param {'merge'|'replace'} [opts.mode='merge']
     *        'merge'   — 按 来源|名称|区县 去重后追加到现有数据
     *        'replace' — 全量覆盖：先清空参考库再写入，结果完全等于本次导入内容，
     *                    不保留上一版本的数据 (省份文件被移除时该省数据一并消失)
     * @returns {{imported: number, errors: string[], stats: object}}
     */
    importCSVBulk(files, onProgress, opts) {
      if (!files || files.length === 0) throw new Error('没有可导入的文件');

      const mode = (opts && opts.mode) === 'replace' ? 'replace' : 'merge';
      const errors = [];
      const byProvince = {}; // adcode → records[]

      // 1. 解析所有文件，按省份聚合
      files.forEach((file, fi) => {
        const text = _decodeGBK(file.buffer);
        const rows = _parseCSV(text);
        if (rows.length <= 1) return; // 空文件或仅表头

        const dataRows = rows.slice(1);
        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i];
          const label = file.name ? `${file.name} 第 ${i + 2} 行` : `第 ${i + 2} 行`;
          try {
            let record;
            if (file.sourceType === 'post') {
              record = this._parsePostRow(row);
            } else {
              record = this._parseSpbRow(row);
            }
            if (!record) { errors.push(`${label}: 数据不完整`); continue; }

            const adcode = _findProvinceAdcode(record.province);
            if (!adcode) { errors.push(`${label}: 无法识别省份 "${record.province}"`); continue; }

            if (!byProvince[adcode]) byProvince[adcode] = [];
            byProvince[adcode].push(record);
          } catch (e) {
            errors.push(`${label}: ${e.message}`);
          }
        }
        if (onProgress) onProgress(fi + 1, files.length);
      });

      // 2. 覆盖模式：丢弃上一版本 base 的全部数据
      //    放在解析之后，避免解析期异常导致参考库被清空
      if (mode === 'replace') {
        _clearAllProvinceData();
        localStorage.removeItem(META_KEY);
        _metaCache = null;
      }

      // 3. 合并到现有数据并保存 (按 来源|名称|区县 去重)
      //    replace 模式下上一步已清空，此处等同于纯写入，但仍保留批内去重
      let totalImported = 0;
      const meta = _loadMeta();
      const existingSources = new Set(meta.sources);
      files.forEach(f => existingSources.add(f.sourceType));

      for (const [adcode, newRecords] of Object.entries(byProvince)) {
        const adc = parseInt(adcode);
        const existing = _getProvinceData(adc);
        const seenKeys = new Set(existing.map(r => `${r.source}|${r.name}|${r.district}`));
        const merged = [...existing];
        for (const rec of newRecords) {
          const key = `${rec.source}|${rec.name}|${rec.district}`;
          if (!seenKeys.has(key)) {
            merged.push(rec);
            seenKeys.add(key);
            totalImported++;
          }
        }
        _saveProvinceData(adc, merged);
      }

      // 4. 更新元数据 (provinces / totalCount 均按当前实际数据全量重建)
      meta.sources = Array.from(existingSources);
      meta.lastImportTime = new Date().toISOString();
      const allProvs = [];
      let grandTotal = 0;
      for (const prov of (typeof PostmarkData !== 'undefined' ? PostmarkData.getAllProvinces() : [])) {
        const data = _getProvinceData(prov.adcode);
        if (data.length > 0) {
          allProvs.push({
            name: prov.name, adcode: prov.adcode,
            postCount: data.filter(r => r.source === 'post').length,
            spbCount: data.filter(r => r.source === 'spb').length,
          });
          grandTotal += data.length;
        }
      }
      meta.provinces = allProvs;
      meta.totalCount = grandTotal;
      _saveMeta();
      _invalidateIndex();

      return {
        imported: totalImported,
        errors,
        stats: {
          totalCount: meta.totalCount,
          postCount: allProvs.reduce((s, p) => s + p.postCount, 0),
          spbCount: allProvs.reduce((s, p) => s + p.spbCount, 0),
        },
      };
    },

    /** 兼容旧接口：导入单个 CSV 文件 (内部转批量，已无调用方，保留以兼容) */
    importCSV(buffer, sourceType, onProgress) {
      return this.importCSVBulk([{ buffer, sourceType }], onProgress);
    },

    /** 解析 POST 行: 省, 市, 区/市/县, 网点名称, 邮编, 地址 */
    _parsePostRow(row) {
      if (row.length < 5) return null;
      const province = row[0] || '';
      const originalCity = row[1] || '';
      const district = row[2] || '';
      const name = row[3] || '';
      const postalCode = (row[4] || '').replace(/\D/g, '').slice(0, 6);
      const address = row[5] || '';
      if (!province || !name || postalCode.length !== 6) return null;

      const city = _correctCity(province, district, originalCity, postalCode);

      return { province, city, district, name, postalCode, address, services: '', detailLink: '', source: 'post' };
    },

    /** 解析 SPB 行: 所属省, 所属市, 所属县, 场所名称, 开办业务, 详情链接 */
    _parseSpbRow(row) {
      if (row.length < 4) return null;
      const province = row[0] || '';
      const city = row[1] || '';
      const district = row[2] || '';
      const name = row[3] || '';
      const services = row[4] || '';
      const detailLink = row[5] || '';
      if (!province || !name) return null;

      const postalCode = _derivePostalCode(province, city, district);

      return { province, city, district, name, postalCode, address: '', services, detailLink, source: 'spb' };
    },

    // ---- 查询 ----

    /**
     * 根据邮编精确查找
     * @param {string} code - 6位邮编
     * @param {Object} [filter] - 行政区划过滤 { province, city }
     * @returns {Array} 匹配记录
     */
    searchByPostalCode(code, filter) {
      if (!code || code.length !== 6) return [];
      _buildPostalCodeIndex();
      const matches = _postalCodeIndex[code] || [];
      return _applyFilter(matches, filter);
    },

    /**
     * 根据网点名称模糊查找
     * @param {string} query
     * @param {number} limit
     * @param {Object} [filter] - 行政区划过滤 { province, city }
     * @returns {Array}
     */
    searchByName(query, limit, filter) {
      if (!query || query.length < 2) return [];
      const results = [];
      const meta = _loadMeta();
      const q = query.toLowerCase();
      for (const p of meta.provinces) {
        if (filter && filter.province && p.name !== filter.province) continue;
        const records = _getProvinceData(p.adcode);
        for (const r of records) {
          if (filter && filter.city && r.city !== filter.city) continue;
          if (r.name.toLowerCase().includes(q)) {
            results.push(r);
            if (results.length >= (limit || 20)) return results;
          }
        }
      }
      return results;
    },

    /**
     * 综合检索 — 按行政区划 + 关键字 + 来源筛选网点
     * @param {Object} query - { keyword, postalCode, province, city, district, source, limit }
     * @returns {Array}
     */
    search(query) {
      const q = query || {};
      let results = _buildAllRecords();
      if (q.province) results = results.filter(r => r.province === q.province);
      if (q.city)     results = results.filter(r => r.city === q.city);
      if (q.district) results = results.filter(r => r.district === q.district);
      if (q.source)   results = results.filter(r => r.source === q.source);
      if (q.postalCode) {
        const code = q.postalCode.replace(/\D/g, '');
        if (code) results = results.filter(r => r.postalCode === code);
      }
      if (q.keyword) {
        const k = q.keyword.trim().toLowerCase();
        if (k) {
          results = results.filter(r =>
            (r.name && r.name.toLowerCase().includes(k)) ||
            (r.address && r.address.toLowerCase().includes(k)) ||
            (r.postalCode && r.postalCode.includes(k))
          );
        }
      }
      return results.slice(0, q.limit || 200);
    },

    /** 获取有数据的省份列表 (用于检索筛选下拉) */
    getDataProvinces() {
      return _loadMeta().provinces;
    },

    /** 获取某省份下出现过的城市列表 (按行政区划代码排序) */
    getDataCities(provinceName) {
      const cities = new Set();
      for (const r of _buildAllRecords()) {
        if (r.province === provinceName && r.city) cities.add(r.city);
      }
      return _sortByRefOrder(Array.from(cities), _refCityOrder(provinceName));
    },

    /** 获取某省某市下出现过的区县列表 (按行政区划代码排序) */
    getDataDistricts(provinceName, cityName) {
      const districts = new Set();
      for (const r of _buildAllRecords()) {
        if (r.province === provinceName && r.city === cityName && r.district) districts.add(r.district);
      }
      return _sortByRefOrder(Array.from(districts), _refDistrictOrder(cityName));
    },

    // ---- 统计与管理 ----

    getStats() {
      return _loadMeta();
    },

    count() {
      return _loadMeta().totalCount;
    },

    /**
     * 删除指定省份的单个数据源
     * @param {number} adcode
     * @param {'post'|'spb'} source
     */
    deleteProvinceSource(adcode, source) {
      const records = _getProvinceData(adcode);
      const filtered = records.filter(r => r.source !== source);
      if (filtered.length === records.length) return; // 无变化

      if (filtered.length === 0) {
        localStorage.removeItem(DATA_PREFIX + adcode);
      } else {
        _saveProvinceData(adcode, filtered);
      }

      // 更新 meta
      const meta = _loadMeta();
      const prov = meta.provinces.find(p => p.adcode === adcode);
      if (prov) {
        if (source === 'post') prov.postCount = 0;
        if (source === 'spb') prov.spbCount = 0;
        if (prov.postCount === 0 && prov.spbCount === 0) {
          meta.provinces = meta.provinces.filter(p => p.adcode !== adcode);
        }
      }
      meta.totalCount = meta.provinces.reduce((s, p) => s + p.postCount + p.spbCount, 0);
      if (!meta.provinces.some(p => p.postCount > 0)) {
        meta.sources = meta.sources.filter(s => s !== 'post');
      }
      if (!meta.provinces.some(p => p.spbCount > 0)) {
        meta.sources = meta.sources.filter(s => s !== 'spb');
      }
      _saveMeta();
      _invalidateIndex();
    },

    clear() {
      _clearAllProvinceData();
      localStorage.removeItem(META_KEY);
      _metaCache = null;
      _invalidateIndex();
    },
  };

})();
