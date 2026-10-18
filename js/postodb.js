/**
 * PO 参考数据库 — 导入 crawler.py 输出的 CSV，支持市名校正与自动填充查询
 * ======================================================================
 * 依赖: PostmarkData (data.js), IdbKV (idb.js), DISTRICT_MAP, POSTAL_CODE_HINTS
 *
 * 数据分层存储（IndexedDB，见 idb.js）:
 *   poref_meta        → { totalCount, provinces: [...], sources, lastImportTime,
 *                         histCount, fromCompare }
 *   poref_data_{adcode} → 该省所有 PO 记录数组
 *   poref_base_old    → 历史归档记录数组（base_old.csv 的内容）
 *
 * 当前库与历史归档
 * ----------------
 *   「对比并更新 base」在覆盖 base 的同时，会把涉及名称变化 / 撤销 / 疑似撤下的
 *   记录归档到 base/base_old.csv（单一文件、不分省，只存当前库里已经没有的记录）。
 *   归档记录单独放在 _historyData 里：它们**参与网点检索**（带 historical 标记，
 *   由检索界面加「历史」徽标），但不计入网点总数，也不进录入候选、随机网点等
 *   依赖 _buildAllRecords() 的路径 —— 撤销/更名前的旧名称不该再被推荐使用。
 *
 * 为什么不在 localStorage
 * ----------------------
 *   参考库来自 base/ 目录（62 个 CSV、约 10.9 万条记录），序列化后约 2200 万
 *   字符，是 Chromium「每 origin 5 MiB」localStorage 配额的 4 倍以上。旧实现
 *   写到第 3~4 个省就抛 QuotaExceededError，启动时必然弹
 *   「网点数据导入失败：存储空间不足，请清理部分数据后重试」。
 *   现在参考库落在 IndexedDB，localStorage 只留日戳记录（store.js，约 0.4M 字符）。
 *
 * 读写模型
 * --------
 *   - 启动时 ready() 把 IndexedDB 的全量分片一次性水合进内存 (_provinceData)，
 *     之后所有**查询** API 保持同步，调用方无需改动；
 *   - **写入**先在一个事务里落盘、成功后再提交内存镜像，避免出现
 *     「内存里看着有、磁盘上没有」的假成功；
 *   - 旧版本的 localStorage 副本在 ready() 里一次性搬走并清掉，腾出配额。
 */

const PODatabase = (function () {

  const META_KEY = 'poref_meta';
  const DATA_PREFIX = 'poref_data_';
  /** 历史归档（base_old.csv）单独一个键：它与当前库是两份数据，改动互不影响 */
  const HIST_KEY = 'poref_base_old';

  // ================================================================
  // 内部状态
  // ================================================================
  let _metaCache = null;
  /** adcode(number) → 记录数组；水合后即为 IndexedDB 的内存镜像 */
  const _provinceData = new Map();
  /**
   * 历史归档记录（base_old.csv 的内容）；每条形如
   * { ..., source, historical: true, archiveReason, archiveDate }
   */
  let _historyData = [];
  /** 邮编 → 记录 的内存索引 (惰性构建) */
  let _postalCodeIndex = null;
  /** 全量记录内存缓存 (惰性构建，用于综合检索) */
  let _allRecords = null;
  /** 区县→市 反向查找缓存 (按省名) */
  const _districtCityCache = {};
  /** 水合 Promise（多次调用共享同一份） */
  let _readyPromise = null;
  let _hydrated = false;
  /**
   * 本次启动时 IndexedDB 里还没有参考库 —— 说明是全新安装或刚从旧版
   * localStorage 方案升级上来。此时 base/ 必须强制重新导入一次，
   * 不能信任上面那份可能只覆盖了 3 个省的旧签名。
   */
  let _legacyUpgrade = false;

  function _emptyMeta() {
    return { totalCount: 0, sources: [], provinces: [], lastImportTime: null, histCount: 0 };
  }

  // ================================================================
  // 水合 / 落盘
  // ================================================================

  /**
   * 落盘一批写入与删除（单事务原子生效）。
   * IndexedDB 不可用时降级为「仅内存」：数据本次仍可用，重启后由 base/ 重建；
   * 真·配额不足仍然抛出，交给上层提示。
   */
  async function _persist(ops) {
    const n = (ops.puts ? ops.puts.length : 0) + (ops.deletes ? ops.deletes.length : 0);
    if (n === 0) return;
    try {
      await IdbKV.write(ops);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        throw new Error('存储空间不足，请清理部分数据后重试');
      }
      if (!IdbKV.isSupported()) {
        console.warn('[PODB] IndexedDB 不可用，本次数据仅驻内存:', e && e.message);
        return;
      }
      throw e;
    }
  }

  /**
   * 把旧版放在 localStorage 里的参考库副本搬进 IndexedDB 并清掉。
   * "IndexedDB 里原本有没有数据"必须由水合结果决定（idbHadData），
   * 不能去看 _metaCache / _provinceData —— ready() 是异步的，在它 await 期间
   * 别的启动代码（如 tools.js 的 DOMContentLoaded 初始化）可能已经调用过
   * count()，从而把一个空 meta 对象写进 _metaCache，让判断失真。
   */
  async function _absorbLegacyLocalStorage(idbReadable, idbHadData) {
    if (typeof localStorage === 'undefined') return;

    let legacyMetaRaw = null;
    const legacyKeys = [];
    try {
      legacyMetaRaw = localStorage.getItem(META_KEY);
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(DATA_PREFIX)) legacyKeys.push(k);
      }
    } catch (e) {
      return;                                   // localStorage 不可读就不用管了
    }
    if (legacyKeys.length === 0 && !legacyMetaRaw) return;

    const freshIdb = idbReadable && !idbHadData;
    if (freshIdb) {
      const puts = [];
      for (const k of legacyKeys) {
        try {
          const records = JSON.parse(localStorage.getItem(k));
          if (!Array.isArray(records)) continue;
          puts.push([k, records]);
          _provinceData.set(parseInt(k.slice(DATA_PREFIX.length), 10), records);
        } catch (e) { /* 分片损坏则跳过，base/ 会重建 */ }
      }
      if (legacyMetaRaw) {
        try {
          _metaCache = JSON.parse(legacyMetaRaw);
          puts.push([META_KEY, _metaCache]);
        } catch (e) { /* 元数据损坏则忽略 */ }
      } else {
        _metaCache = null;                      // 丢掉可能已被创建的空白 meta
      }
      try {
        await _persist({ puts });
        console.log(`[PODB] 已把 localStorage 里的 ${legacyKeys.length} 个省份分片搬入 IndexedDB`);
      } catch (e) {
        console.warn('[PODB] 迁移旧 localStorage 数据失败:', e && e.message);
      }
    }

    // 旧副本要清掉：它继续占着 5 MiB 配额里的绝大部分。
    // 但只有在 IndexedDB 确实可用时才清 —— 否则等于把库从磁盘上抹掉。
    if (!idbReadable) {
      console.warn('[PODB] IndexedDB 不可读，保留 localStorage 里的旧副本不动');
      return;
    }
    try {
      for (const k of legacyKeys) localStorage.removeItem(k);
      localStorage.removeItem(META_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 水合参考库：把 IndexedDB 里的分片与元数据读进内存镜像。
   * 必须在任何查询或导入之前 await；幂等；IndexedDB 不可用时按空库启动（不抛错）。
   * @returns {Promise<boolean>} IndexedDB 是否可读
   */
  function ready() {
    if (_hydrated) return Promise.resolve(true);
    if (_readyPromise) return _readyPromise;

    _readyPromise = (async () => {
      let readable = false;
      let hadData = false;
      try {
        const rows = await IdbKV.entries(DATA_PREFIX);
        const meta = await IdbKV.get(META_KEY);
        const hist = await IdbKV.get(HIST_KEY);
        for (const [k, v] of rows) {
          const adc = parseInt(k.slice(DATA_PREFIX.length), 10);
          if (Number.isFinite(adc) && Array.isArray(v)) _provinceData.set(adc, v);
        }
        if (meta && typeof meta === 'object') _metaCache = meta;
        if (Array.isArray(hist)) _historyData = hist;
        readable = true;
        hadData = rows.length > 0 || !!meta;
      } catch (e) {
        console.warn('[PODB] 参考库水合失败（按空库启动，稍后由 base/ 重建）:', e && e.message);
      }

      _legacyUpgrade = !hadData;
      await _absorbLegacyLocalStorage(readable, hadData);

      _hydrated = true;
      _invalidateIndex();
      return readable;
    })();

    return _readyPromise;
  }

  // ================================================================
  // 元数据
  // ================================================================

  function _loadMeta() {
    if (!_metaCache) _metaCache = _emptyMeta();
    return _metaCache;
  }

  /** 把当前内存里的元数据落盘（调用方已确保 _metaCache 是最新的） */
  function _saveMeta(meta) {
    return _persist({ puts: [[META_KEY, meta || _metaCache]] });
  }

  // ================================================================
  // 省份数据读写
  // ================================================================

  /** 读内存镜像（同步；水合后即磁盘内容的完整视图） */
  function _getProvinceData(adcode) {
    return _provinceData.get(Number(adcode)) || [];
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
   * 删除所有省份分片（IndexedDB + 内存镜像）。
   * 只操作本模块自己的 poref_data_* 键，日戳记录 (store.js)、
   * 地图缓存等其他数据不受影响。
   */
  async function _clearAllProvinceData() {
    const keys = Array.from(_provinceData.keys(), (adc) => DATA_PREFIX + adc);
    await _persist({ deletes: keys });
    _provinceData.clear();
  }

  // ================================================================
  // 历史归档（base_old.csv 的内容）
  // ================================================================
  // 与当前库分开存放：归档记录参与检索（historical 标记），但不计入网点总数，
  // 也不进 _buildAllRecords()，因此录入候选、随机网点、统计都不会拿到旧名称。

  /** 历史归档记录（水合后即为完整视图） */
  function _historyRecords() {
    return _historyData;
  }

  /** 整份替换历史归档（IndexedDB + 内存镜像），返回条数 */
  async function _replaceHistory(records) {
    const list = Array.isArray(records) ? records : [];
    await _persist({ puts: [[HIST_KEY, list]] });
    _historyData = list;

    // meta 在 importCSVBulk 里刚整体重建过，这里只补归档计数
    const meta = _loadMeta();
    meta.histCount = list.length;
    await _saveMeta(meta);
    return list.length;
  }

  /** 清空历史归档 */
  async function _clearHistory() {
    await _persist({ deletes: [HIST_KEY] });
    _historyData = [];
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
     *        'replace' — 全量覆盖：结果完全等于本次导入内容，
     *                    不保留上一版本的数据 (省份文件被移除时该省数据一并消失)
     * @returns {Promise<{imported: number, errors: string[], stats: object}>}
     */
    async importCSVBulk(files, onProgress, opts) {
      if (!files || files.length === 0) throw new Error('没有可导入的文件');
      await ready();                       // merge 需要内存里的旧数据，先确保已水合

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

      // 2. 算出每个省要写的内容 (replace 以空库为底，merge 以现有数据为底)
      //    落盘之前不动内存镜像 —— 万一写入失败，内存里仍是一致的旧状态
      const base = mode === 'replace' ? new Map() : _provinceData;
      const targets = new Map(); // adcode → records[]
      let totalImported = 0;

      for (const [adcode, newRecords] of Object.entries(byProvince)) {
        const adc = parseInt(adcode, 10);
        const existing = base.get(adc) || [];
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
        targets.set(adc, merged);
      }

      // 3. 一个事务里落盘：写入新分片 + 删掉 replace 模式下 base 里已消失的省
      const puts = [];
      for (const [adc, records] of targets) puts.push([DATA_PREFIX + adc, records]);
      const deletes = [];
      if (mode === 'replace') {
        for (const adc of _provinceData.keys()) {
          if (!targets.has(adc)) deletes.push(DATA_PREFIX + adc);
        }
      }
      await _persist({ puts, deletes });

      // 4. 落盘成功，提交内存镜像
      if (mode === 'replace') _provinceData.clear();
      for (const [adc, records] of targets) _provinceData.set(adc, records);

      // 5. 更新元数据 (provinces / totalCount 均按当前实际数据全量重建)
      const existingSources = new Set(mode === 'replace' ? [] : _loadMeta().sources);
      files.forEach(f => existingSources.add(f.sourceType));

      const meta = _emptyMeta();
      meta.sources = Array.from(existingSources);
      meta.lastImportTime = new Date().toISOString();
      // 归档与当前库分开存放：importCSVBulk 重建 meta 时不能把归档计数弄丢
      meta.histCount = _historyData.length;
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
      await _saveMeta(meta);
      _metaCache = meta;
      _legacyUpgrade = false;
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

    /**
     * 导入（整份替换）历史归档 —— base_old.csv 的内容。
     * @param {ArrayBuffer|null} buffer  null/空 表示没有归档，历史部分清空
     * @returns {Promise<number>} 导入条数
     */
    async importHistory(buffer) {
      await ready();
      const { records, errors } = this._parseBaseOld(buffer);
      if (errors.length) {
        console.warn(`[PODB] 归档记录有 ${errors.length} 行无法解析:`, errors.slice(0, 3));
      }
      return _replaceHistory(records);
    },

    /**
     * 对比完成后刷新参考库（爬取结束不再刷新，见 js/crawler.js）。
     *
     * @param {Array<{buffer:ArrayBuffer, sourceType:'post'|'spb', name?:string}>} files
     *        主进程给出的「应用后 base 快照」（已剔除带（撤销）标记的记录）
     * @param {ArrayBuffer|null} archiveBuffer 快照同目录的 base_old.csv
     * @param {Function} [onProgress]
     * @returns {Promise<{imported:number, errors:string[], stats:object, historyTotal:number}>}
     */
    async refreshFromCompare(files, archiveBuffer, onProgress) {
      // replace：参考库完全等于这次对比算出的当前库
      const result = await this.importCSVBulk(files, onProgress, { mode: 'replace' });
      const historyTotal = await this.importHistory(archiveBuffer || null);

      // 这是「对比快照」而非 base 目录本身，只是临时状态：
      // app.js 的 base 签名跳过逻辑据此强制下次启动从 base 重建。
      const meta = _loadMeta();
      meta.fromCompare = true;
      await _saveMeta(meta);

      return Object.assign(result, { historyTotal });
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

    /**
     * 解析 base_old.csv（主进程写出的统一列，GBK）:
     *   来源, 省, 市, 区/市/县, 网点名称, 邮编, 地址, 开办业务, 详情链接, 归档原因, 归档时间
     *
     * 两源混排成一张表，这里把各自需要的列重新映射回 POST / SPB 的位置后复用
     * _parsePostRow / _parseSpbRow —— 市名校正、SPB 邮编推导等既有逻辑都能沿用。
     * 解析出的记录带 historical / archiveReason / archiveDate 三个字段。
     *
     * @param {ArrayBuffer|null} buffer
     * @returns {{records: Array, errors: string[]}}
     */
    _parseBaseOld(buffer) {
      const records = [];
      const errors = [];
      if (!buffer) return { records, errors };

      const rows = _parseCSV(_decodeGBK(buffer));
      const header = rows.length ? rows[0] : [];
      const hasHeader = (header[0] || '') === '来源';
      // 按列名定位，列顺序变化也能读对（与 crawler-engine.readBaseOld 同一套规则）
      const col = (name, fallback) => {
        const i = header.indexOf(name);
        return i >= 0 ? i : fallback;
      };
      const idx = {
        source: hasHeader ? 0 : -1,
        province: col('省', 1), city: col('市', 2), district: col('区/市/县', 3),
        name: col('网点名称', 4), postcode: col('邮编', 5), address: col('地址', 6),
        services: col('开办业务', 7), link: col('详情链接', 8),
        reason: col('归档原因', 9), at: col('归档时间', 10),
      };

      for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
        const c = rows[i];
        if (!c || !c.some(f => f !== '')) continue;
        const cell = (k) => String(c[idx[k]] == null ? '' : c[idx[k]]);
        const source = idx.source >= 0 ? cell('source') : 'post';
        const isSpb = source === 'spb';

        // 还原成两源各自的行布局，交给既有解析器
        const row = isSpb
          ? [cell('province'), cell('city'), cell('district'), cell('name'),
             cell('services'), cell('link')]
          : [cell('province'), cell('city'), cell('district'), cell('name'),
             cell('postcode'), cell('address')];

        let rec = null;
        try {
          rec = isSpb ? this._parseSpbRow(row) : this._parsePostRow(row);
        } catch (e) {
          rec = null;
        }
        if (!rec) { errors.push(`第 ${i + 2} 行: 归档记录不完整`); continue; }

        rec.historical = true;
        rec.archiveReason = cell('reason');
        rec.archiveDate = cell('at');
        records.push(rec);
      }
      return { records, errors };
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
     * @param {Object} query - { keyword, postalCode, province, city, district, source,
     *                           limit, includeHistory }
     *        includeHistory 默认 true：历史归档（base_old）一起检索，
     *        这些记录带 historical:true，调用方据此加「历史」标记。
     * @returns {Array}
     */
    search(query) {
      const q = query || {};
      let results = _buildAllRecords();
      if (q.includeHistory !== false) results = results.concat(_historyData);
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

    /**
     * 获取某省份下出现过的城市列表 (按行政区划代码排序)
     * 含历史归档，否则「省份有、当前库里没有」的归档记录筛不出来。
     */
    getDataCities(provinceName) {
      const cities = new Set();
      for (const r of _buildAllRecords()) {
        if (r.province === provinceName && r.city) cities.add(r.city);
      }
      for (const r of _historyData) {
        if (r.province === provinceName && r.city) cities.add(r.city);
      }
      return _sortByRefOrder(Array.from(cities), _refCityOrder(provinceName));
    },

    /** 获取某省某市下出现过的区县列表 (按行政区划代码排序)，含历史归档 */
    getDataDistricts(provinceName, cityName) {
      const districts = new Set();
      for (const r of _buildAllRecords()) {
        if (r.province === provinceName && r.city === cityName && r.district) districts.add(r.district);
      }
      for (const r of _historyData) {
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

    /** 历史归档条数（base_old.csv 的内容，不计入 count()） */
    historyCount() {
      return _historyData.length;
    },

    /**
     * 参考库当前内容是否来自「对比快照」而非 base 目录。
     * 对比快照是临时状态：下次启动必须从 base 重新导入，否则会停在提交前的样子。
     */
    isProvisional() {
      return !!_loadMeta().fromCompare;
    },

    /**
     * 删除指定省份的单个数据源
     * @param {number} adcode
     * @param {'post'|'spb'} source
     */
    async deleteProvinceSource(adcode, source) {
      await ready();
      const records = _getProvinceData(adcode);
      const filtered = records.filter(r => r.source !== source);
      if (filtered.length === records.length) return; // 无变化

      const adc = Number(adcode);
      if (filtered.length === 0) {
        await _persist({ deletes: [DATA_PREFIX + adc] });
        _provinceData.delete(adc);
      } else {
        await _persist({ puts: [[DATA_PREFIX + adc, filtered]] });
        _provinceData.set(adc, filtered);
      }

      // 更新 meta
      const meta = _loadMeta();
      const prov = meta.provinces.find(p => p.adcode === adc);
      if (prov) {
        if (source === 'post') prov.postCount = 0;
        if (source === 'spb') prov.spbCount = 0;
        if (prov.postCount === 0 && prov.spbCount === 0) {
          meta.provinces = meta.provinces.filter(p => p.adcode !== adc);
        }
      }
      meta.totalCount = meta.provinces.reduce((s, p) => s + p.postCount + p.spbCount, 0);
      if (!meta.provinces.some(p => p.postCount > 0)) {
        meta.sources = meta.sources.filter(s => s !== 'post');
      }
      if (!meta.provinces.some(p => p.spbCount > 0)) {
        meta.sources = meta.sources.filter(s => s !== 'spb');
      }
      await _saveMeta(meta);
      _invalidateIndex();
    },

    async clear() {
      await ready();
      await _clearAllProvinceData();
      await _clearHistory();
      await _persist({ deletes: [META_KEY] });
      _metaCache = null;
      _invalidateIndex();
    },

    // ---- 生命周期 ----

    /**
     * 水合参考库（必须在查询/导入前 await 一次）。
     * @returns {Promise<boolean>} IndexedDB 是否可读
     */
    ready() {
      return ready();
    },

    /**
     * 本次启动时 IndexedDB 里还没有参考库 —— 调用方应忽略签名跳过逻辑，
     * 强制从 base/ 重新导入一次。
     */
    legacyUpgrade() {
      return _legacyUpgrade;
    },
  };

})();
