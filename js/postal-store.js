/**
 * 港澳台网点参考库 — 读取 base/{prefix}+base.csv 或 output 最新结果
 * =================================================================
 * 数据源优先级：
 *   1. base/posthk+base.csv 等（用户在抓取完成后确认更新 base 的文件）
 *   2. output/posthk-YYYYMMDD.csv 等最新一批结果（还没有 base 时兜底）
 *   3. output/posthk.csv 等旧版固定文件名（兼容升级前的数据）
 *
 * 为什么不塞进 PODatabase：
 *   PODatabase 的省级参考库由 base/ 目录整体 replace，base 里没有港澳台时
 *   一次对比/重启就会把混进去的记录清掉。这里单独用内存库保存四份 CSV，
 *   与 base 的导入/对比流程互不影响；首页总数由 data.js 合并本模块的统计。
 *
 * 记录字段（统一成查询页/标绿需要的形状）：
 *   region       hk | mo | tw
 *   regionLabel  香港 / 澳门 / 台湾
 *   type         post | agency
 *   typeLabel    邮政局 / 邮局 / 代办所
 *   province     香港特别行政区 / 澳门特别行政区 / 台湾省
 *   city         香港的“港岛区”等地区 / 台湾从地址前缀推导的县市
 *   district     留空（港澳台录入记录通常没有区县层级）
 *   name         局名
 *   code         香港代号 / 台湾电脑局名
 *   codeLabel    代号 / 电脑局名
 *   postalCode   台湾邮递区号（字符串，保留前导零）
 *   address      地址
 *   jurisdiction 台湾代办所的管辖邮局
 *   source       'post'（让 Tools 的“已收集”匹配直接复用）
 *   regionOffice true（Tools 对港澳台用“省 + 局名”宽松匹配）
 *
 * 依赖: PODatabase.parseCSV, PostmarkData
 */

const PostalStore = (function () {

  const FILES = [
    { key: 'hk', legacyFile: 'posthk.csv', label: '香港邮政' },
    { key: 'mo', legacyFile: 'postmo.csv', label: '澳门邮电局' },
    { key: 'tw', legacyFile: 'posttw.csv', label: '台湾普通邮局' },
    { key: 'agencytw', legacyFile: 'agencytw.csv', label: '台湾邮政代办所' },
  ];

  let _records = [];
  let _byRegion = { hk: [], mo: [], tw: [] };
  let _loaded = false;
  let _loading = null;
  let _lastLoadedAt = null;
  let _errors = [];
  let _sources = {};

  function _stripBom(text) {
    return String(text == null ? '' : text).replace(/^\uFEFF/, '');
  }

  function _parseRows(text) {
    if (typeof PODatabase === 'undefined' || typeof PODatabase.parseCSV !== 'function') {
      return [];
    }
    return PODatabase.parseCSV(_stripBom(text));
  }

  function _index(header, name) {
    return header.indexOf(name);
  }

  function _cell(row, idx) {
    return idx >= 0 && row && row[idx] != null ? String(row[idx]).trim() : '';
  }

  /** 从台湾地址开头推导县市；查不到就留空，不影响查询 */
  function _cityFromAddress(address) {
    if (!address || typeof PostmarkData === 'undefined') return '';
    const prov = PostmarkData.getProvinceByName('台湾省');
    if (!prov || !Array.isArray(prov.cities)) return '';

    // 地址是繁体、data.js 的市名是简体；逐字归一化台湾县市名里会出现的差异字
    const TRAD_TO_SIMP = {
      '臺': '台', '義': '义', '縣': '县', '東': '东', '門': '门',
      '連': '连', '雲': '云', '蘭': '兰', '蓮': '莲', '園': '园',
    };
    const normalize = (s) => String(s || '').replace(/[臺義縣東門連雲蘭蓮園]/g, (ch) => TRAD_TO_SIMP[ch] || ch);
    const addr = normalize(address);
    let best = '';
    for (const c of prov.cities) {
      if (!c || !c.name) continue;
      const name = normalize(c.name);
      if (name && addr.includes(name) && name.length > best.length) best = c.name;
    }
    return best;
  }

  function _buildHk(rows) {
    if (rows.length < 2) return [];
    const header = rows[0];
    const iArea = _index(header, '地区');
    const iName = _index(header, '局名');
    const iCode = _index(header, '代号');
    const iAddr = _index(header, '地址');
    if (iName < 0) return [];

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = _cell(row, iName);
      if (!name) continue;
      const code = _cell(row, iCode);
      out.push({
        id: `hk:${code || name}`,
        region: 'hk',
        regionLabel: '香港',
        type: 'post',
        typeLabel: '邮政局',
        province: '香港特别行政区',
        city: _cell(row, iArea),
        district: '',
        name,
        code,
        codeLabel: '代号',
        postalCode: '',
        address: _cell(row, iAddr),
        jurisdiction: '',
        source: 'post',
        regionOffice: true,
      });
    }
    return out;
  }

  function _buildMo(rows) {
    if (rows.length < 2) return [];
    const header = rows[0];
    const iName = _index(header, '名称');
    const iAddr = _index(header, '地址');
    if (iName < 0) return [];

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = _cell(row, iName);
      if (!name) continue;
      out.push({
        id: `mo:${name}`,
        region: 'mo',
        regionLabel: '澳门',
        type: 'post',
        typeLabel: '邮政局/服务点',
        province: '澳门特别行政区',
        city: '',
        district: '',
        name,
        code: '',
        codeLabel: '',
        postalCode: '',
        address: _cell(row, iAddr),
        jurisdiction: '',
        source: 'post',
        regionOffice: true,
      });
    }
    return out;
  }

  function _buildTw(rows) {
    if (rows.length < 2) return [];
    const header = rows[0];
    const iPostal = _index(header, '邮递区号');
    const iName = _index(header, '局名');
    const iCode = _index(header, '电脑局名');
    const iAddr = _index(header, '地址');
    if (iName < 0) return [];

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = _cell(row, iName);
      if (!name) continue;
      const address = _cell(row, iAddr);
      const postalCode = _cell(row, iPostal);
      out.push({
        id: `tw:${postalCode}:${name}`,
        region: 'tw',
        regionLabel: '台湾',
        type: 'post',
        typeLabel: '邮局',
        province: '台湾省',
        city: _cityFromAddress(address),
        district: '',
        name,
        code: _cell(row, iCode),
        codeLabel: '电脑局名',
        postalCode,
        address,
        jurisdiction: '',
        source: 'post',
        regionOffice: true,
      });
    }
    return out;
  }

  function _buildAgencyTw(rows) {
    if (rows.length < 2) return [];
    const header = rows[0];
    const iPostal = _index(header, '邮递区号');
    const iName = _index(header, '局名');
    const iAddr = _index(header, '地址');
    const iJurisdiction = _index(header, '管辖邮局');
    if (iName < 0) return [];

    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = _cell(row, iName);
      if (!name) continue;
      const address = _cell(row, iAddr);
      const postalCode = _cell(row, iPostal);
      out.push({
        id: `agencytw:${postalCode}:${name}`,
        region: 'tw',
        regionLabel: '台湾',
        type: 'agency',
        typeLabel: '代办所',
        province: '台湾省',
        city: _cityFromAddress(address),
        district: '',
        name,
        code: '',
        codeLabel: '',
        postalCode,
        address,
        jurisdiction: _cell(row, iJurisdiction),
        source: 'post',
        regionOffice: true,
      });
    }
    return out;
  }

  const BUILDERS = {
    hk: _buildHk,
    mo: _buildMo,
    tw: _buildTw,
    agencytw: _buildAgencyTw,
  };

  async function _loadSourceMap() {
    try {
      const res = await fetch('/api/postal/files', { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.files)) return null;
      const map = {};
      for (const f of data.files) {
        if (f && f.key) map[f.key] = f;
      }
      return map;
    } catch (e) {
      // 服务端不可用时退回旧版 output/posthk.csv 路径
      return null;
    }
  }

  async function _fetchOne(spec, sourceMap) {
    const source = sourceMap ? sourceMap[spec.key] : null;
    let url;
    let label;

    if (sourceMap) {
      // 服务端明确返回 none：还没有任何 base/output 文件，属于正常空状态
      if (!source || !source.url) return { spec, rows: [] };
      url = source.url;
      label = source.name || spec.legacyFile;
    } else {
      url = '/output/' + encodeURIComponent(spec.legacyFile);
      label = spec.legacyFile;
    }

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        // 404 表示还没跑过采集，属于正常空状态；其它状态记录为异常
        if (res.status !== 404) {
          _errors.push(`${label}: HTTP ${res.status}`);
        }
        return { spec, rows: [] };
      }
      const text = await res.text();
      return { spec, rows: _parseRows(text), label };
    } catch (e) {
      _errors.push(`${label}: ${e.message || e}`);
      return { spec, rows: [] };
    }
  }

  async function _load() {
    _errors = [];
    const sourceMap = await _loadSourceMap();
    _sources = sourceMap || {};
    const results = await Promise.all(FILES.map((spec) => _fetchOne(spec, sourceMap)));
    const all = [];
    const byRegion = { hk: [], mo: [], tw: [] };

    for (const { spec, rows, label } of results) {
      if (!rows.length) continue;
      let records = [];
      try {
        records = (BUILDERS[spec.key] || (() => []))(rows);
      } catch (e) {
        _errors.push(`${label || spec.legacyFile}: 解析失败 ${e.message || e}`);
        continue;
      }
      if (!records.length) {
        _errors.push(`${label || spec.legacyFile}: 未解析出记录（表头是否变化？）`);
        continue;
      }
      for (const rec of records) {
        all.push(rec);
        if (byRegion[rec.region]) byRegion[rec.region].push(rec);
      }
    }

    _records = all;
    _byRegion = byRegion;
    _lastLoadedAt = new Date().toISOString();
    _loaded = true;
    return getStats();
  }

  function reload() {
    if (_loading) return _loading;
    _loading = _load().finally(() => { _loading = null; });
    return _loading;
  }

  function ready() {
    if (_loaded) return Promise.resolve(getStats());
    return reload();
  }

  function getStats() {
    const twPost = _byRegion.tw.filter(r => r.type === 'post').length;
    const twAgency = _byRegion.tw.filter(r => r.type === 'agency').length;
    return {
      total: _records.length,
      hk: _byRegion.hk.length,
      mo: _byRegion.mo.length,
      tw: _byRegion.tw.length,
      twPost,
      twAgency,
    };
  }

  /**
   * 首页/排名表用的“省级总数”：台湾 = 邮局 + 代办所。
   * 没有数据的地区不返回，避免把静态估算覆盖成 0。
   */
  function getProvinceCounts() {
    const s = getStats();
    const out = {};
    if (s.hk > 0) out['香港特别行政区'] = s.hk;
    if (s.mo > 0) out['澳门特别行政区'] = s.mo;
    if (s.tw > 0) out['台湾省'] = s.tw;
    return out;
  }

  function search(query) {
    const q = query || {};
    let list = _records;
    if (q.region) list = list.filter(r => r.region === q.region);
    if (q.type) list = list.filter(r => r.type === q.type);
    if (q.keyword) {
      const k = String(q.keyword).trim().toLowerCase();
      if (k) {
        list = list.filter(r => [r.name, r.address, r.code, r.postalCode, r.jurisdiction, r.city, r.regionLabel, r.typeLabel]
          .some(v => String(v == null ? '' : v).toLowerCase().includes(k)));
      }
    }
    const limit = q.limit == null ? 500 : q.limit;
    return list.slice(0, limit);
  }

  return {
    ready,
    reload,
    getStats,
    getProvinceCounts,
    search,
    getLastLoadedAt: () => _lastLoadedAt,
    getErrors: () => _errors.slice(),
    getFiles: () => FILES.map(f => {
      const s = _sources[f.key];
      return {
        key: f.key,
        file: s && s.name ? s.name : f.legacyFile,
        label: f.label,
        source: s ? s.source : 'legacy',
      };
    }),
    count: () => _records.length,
    getAll: () => _records.slice(),
  };

})();
