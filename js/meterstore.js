/**
 * 邮资机戳存储 — localStorage 持久化 CRUD
 * =========================================
 * 依赖: RecordStore（**仅**「从日戳记录移植」时读取，见 seedFromRecords）
 *
 * 「邮资机戳」是与「日戳记录」并列的**独立**数据表：
 * 移植只是把日戳记录里已有的邮资机字段**复制**进来（按 sourceRecordId 去重，
 * 可重复调用而不会重复插入），此后两边互不影响 ——
 * 再改日戳记录的邮资机字段不会回流到这张表，邮资机戳一律在本表维护。
 *
 * 每条记录结构:
 * {
 *   id: string,             // 内部 id
 *   province: string,       // 打印网点所在省
 *   city: string,           // 打印网点所在市
 *   district: string,       // 打印网点所在县/区（可为空）
 *   printOffice: string,    // 打印网点（网点名称）
 *   meterModel: string,     // 型号
 *   meterNo: string,        // 编号
 *   meterUpperRing: string, // 上环
 *   meterLowerRing: string, // 下环
 *   meterHeader: string,    // 表头
 *   printDate: string,      // 打印日期 YYYYMMDDHH（与日戳的盖销日期同格式，可直接按字符串排序）
 *   notes: string,          // 备注
 *   sourceRecordId: string, // 移植来源的日戳记录 id（去重用；手工新增为空）
 *   createdAt: string,      // ISO 时间戳
 *   updatedAt: string       // ISO 时间戳
 * }
 */

const METER_STORE_KEY = 'postmark_meter_records';
/** 首次启动自动移植的标记：只是提示"自动那一次"做过没有，去重本身靠 sourceRecordId */
const METER_SEED_KEY = 'postmark_meter_seeded';

const MeterStore = {

  // ==========================================================
  // 内部方法
  // ==========================================================
  _load() {
    try {
      const raw = localStorage.getItem(METER_STORE_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.map(r => this._normalize(r));
    } catch (e) {
      return [];
    }
  },

  _save(list) {
    localStorage.setItem(METER_STORE_KEY, JSON.stringify(list));
  },

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /** 补齐缺省字段（兼容手工改过的 localStorage / 早期导入的 JSON） */
  _normalize(rec) {
    const r = { ...rec };
    // id 会被拼进列表的 data-id 属性，而导入的 JSON 不可信：只接受字母数字
    if (!r.id || !/^[A-Za-z0-9_-]+$/.test(String(r.id))) r.id = this._genId();
    this.FIELDS.forEach(f => { r[f] = r[f] == null ? '' : String(r[f]); });
    r.sourceRecordId = r.sourceRecordId || '';
    r.createdAt = r.createdAt || new Date().toISOString();
    r.updatedAt = r.updatedAt || r.createdAt;
    return r;
  },

  /** 列表默认排序：打印日期新的在前；没填日期的排在最后，同日期按录入时间倒序 */
  _sort(list) {
    return this._sortList(list, 'printDate', 'desc');
  },

  /** 可排序要素（选项顺序即界面下拉框的顺序） */
  SORT_OPTIONS: [
    { key: 'printDate',      label: '打印日期' },
    { key: 'printOffice',    label: '打印网点' },
    { key: 'location',       label: '省 / 市 / 县' },
    { key: 'meterModel',     label: '型号' },
    { key: 'meterNo',        label: '编号' },
    { key: 'meterUpperRing', label: '上环' },
    { key: 'meterLowerRing', label: '下环' },
    { key: 'meterHeader',    label: '表头' },
    { key: 'notes',          label: '备注' },
    { key: 'createdAt',      label: '录入时间' },
  ],

  /** 排序取值；location 是「省/市/县」的拼接，其余是按字段名取 */
  _sortValue(rec, key) {
    if (key === 'location') {
      return [rec.province, rec.city, rec.district].filter(Boolean).join('');
    }
    return String(rec[key] == null ? '' : rec[key]);
  },

  /**
   * 按指定要素排序（返回副本，不改动存储）。
   * 空值一律排在最后 —— 不管升序还是降序，否则"没填的"会占满第一屏。
   * 同值时按打印日期新→旧、录入时间新→旧回落，保证顺序稳定可预期。
   */
  _sortList(list, key, dir) {
    const k = this.SORT_OPTIONS.some(o => o.key === key) ? key : 'printDate';
    const desc = dir !== 'asc';
    return list.slice().sort((a, b) => {
      const va = this._sortValue(a, k);
      const vb = this._sortValue(b, k);
      if (va !== vb) {
        if (!va) return 1;
        if (!vb) return -1;
        const c = va.localeCompare(vb, 'zh-Hans-CN', { numeric: true });
        return desc ? -c : c;
      }
      const dp = String(b.printDate || '').localeCompare(String(a.printDate || ''));
      if (dp !== 0) return dp;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  },

  /** 按要素排序后的全部记录（界面排序用） */
  getSorted(key, dir) {
    return this._sortList(this._load(), key, dir);
  },

  /** 表单里的业务字段（缺省补齐与导入校验都以它为准） */
  FIELDS: [
    'province', 'city', 'district', 'printOffice',
    'meterModel', 'meterNo', 'meterUpperRing', 'meterLowerRing', 'meterHeader',
    'printDate', 'notes',
  ],

  // ==========================================================
  // CRUD
  // ==========================================================

  /** 全部记录（已排序） */
  getAll() {
    return this._sort(this._load());
  },

  getById(id) {
    return this._load().find(r => r.id === id) || null;
  },

  count() {
    return this._load().length;
  },

  add(record) {
    const list = this._load();
    const rec = this._normalize({
      ...record,
      id: record.id || this._genId(),
      createdAt: record.createdAt || new Date().toISOString(),
    });
    rec.updatedAt = new Date().toISOString();
    list.push(rec);
    this._save(list);
    this._notifyChange();
    return rec;
  },

  /** 更新记录（不允许借 update 改 id / createdAt） */
  update(id, updates) {
    const list = this._load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const patch = { ...updates };
    delete patch.id;
    delete patch.createdAt;
    list[idx] = this._normalize({ ...list[idx], ...patch, id });
    list[idx].updatedAt = new Date().toISOString();
    this._save(list);
    this._notifyChange();
    return list[idx];
  },

  remove(id) {
    const list = this._load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this._save(list);
    this._notifyChange();
    return true;
  },

  clear() {
    localStorage.removeItem(METER_STORE_KEY);
    this._notifyChange();
  },

  // ==========================================================
  // 从「日戳记录」移植
  // ==========================================================

  /**
   * 日戳记录 → 邮资机戳记录的字段映射。
   * 日戳记录里没有「上环」和「备注」，故留空，移植后在本表补充。
   */
  _fromRecord(rec) {
    return {
      province: rec.province || '',
      city: rec.city || '',
      district: rec.district || '',
      printOffice: rec.postOffice || '',
      meterModel: rec.meterModel || '',
      meterNo: rec.meterNo || '',
      meterUpperRing: '',
      meterLowerRing: rec.meterLowerRing || '',
      meterHeader: rec.meterHeader || '',
      printDate: rec.cancelDate || '',   // 盖销日期即打印日期，同为 YYYYMMDDHH
      notes: '',
      sourceRecordId: rec.id || '',
    };
  },

  /** 待移植 / 已移植的条数（不写库，供界面确认提示用） */
  previewSeed() {
    const seededIds = new Set(this._load().map(r => r.sourceRecordId).filter(Boolean));
    const records = (typeof RecordStore !== 'undefined') ? RecordStore.getAll() : [];
    const pending = [];
    let done = 0;
    records.forEach(rec => {
      if (!rec.hasPostageMeter) return;
      if (rec.id && seededIds.has(rec.id)) { done++; return; }
      pending.push(rec);
    });
    return { pending: pending.length, done };
  },

  /**
   * 把日戳记录里的邮资机信息复制进来（幂等：已移植过的不会重复）。
   * @returns {{added:number, skipped:number, total:number}}
   */
  seedFromRecords() {
    const seededIds = new Set(this._load().map(r => r.sourceRecordId).filter(Boolean));
    const records = (typeof RecordStore !== 'undefined') ? RecordStore.getAll() : [];
    const added = [];
    let skipped = 0;

    records.forEach(rec => {
      if (!rec.hasPostageMeter) return;
      if (rec.id && seededIds.has(rec.id)) { skipped++; return; }
      added.push(this._normalize({
        ...this._fromRecord(rec),
        id: this._genId(),
        createdAt: new Date().toISOString(),
      }));
    });

    if (added.length > 0) {
      const list = this._load();
      list.push(...added);
      this._save(list);
      this._notifyChange();
    }
    this._markSeeded();

    this.lastSeed = { added: added.length, skipped, total: this.count() };
    return this.lastSeed;
  },

  /** 首次启动的自动移植：只在从没自动移植过时执行一次 */
  autoSeed() {
    if (this._seeded()) return { auto: false, added: 0, skipped: 0, total: this.count() };
    const r = this.seedFromRecords();
    return { auto: true, ...r };
  },

  _seeded() {
    try { return localStorage.getItem(METER_SEED_KEY) === '1'; } catch (e) { return true; }
  },

  _markSeeded() {
    try { localStorage.setItem(METER_SEED_KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
  },

  // ==========================================================
  // 变更通知
  // ==========================================================
  _changeListeners: [],

  onChange(cb) {
    this._changeListeners.push(cb);
  },

  _notifyChange() {
    this._changeListeners.forEach(cb => {
      try { cb(); } catch (e) { console.error('[MeterStore] 变更回调出错:', e); }
    });
  },
};
