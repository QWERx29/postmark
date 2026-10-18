/**
 * 记录存储 — localStorage 持久化 CRUD
 * ====================================
 * 依赖: 无 (纯数据管理)
 *
 * 每条记录结构:
 * {
 *   id: string,           // UUID
 *   province: string,     // 省名
 *   city: string,         // 市名
 *   district: string,     // 县/区/县级市名
 *   postOffice: string,   // 邮局名称
 *   status: string,       // 邮局状态: 'open'=营业 | 'closed'=已撤销 | 'themed'=主题邮局 | 'temporary'=临时邮局
 *   postalCode: string,   // 邮政编码 (6位)
 *   institutionCode: string, // 机构号 (主键，8位数字，可手动编辑)
 *   cancelDate: string,   // 盖销日期 YYYY.MM.DD.HH
 *   stampNumbers: string[], // 戳号列表
 *   material: string,     // 材质
 *   hasPostageMeter: boolean,
 *   meterModel: string,   // 邮资机型号
 *   meterNo: string,      // 邮资机编号
 *   meterHeader: string,  // 表头
 *   meterLowerRing: string, // 下环
 *   hasScenicPostmark: boolean,
 *   scenicNames: string[], // 风景/文化日戳名称列表
 *   notes: string,
 *   photos: string[],     // 已保存图片文件名（相对 output/images/，见 img-export.js）
 *   createdAt: string     // ISO 时间戳
 * }
 */

const STORE_KEY = 'postmark_records';

const RecordStore = {

  // ==========================================================
  // 内部方法
  // ==========================================================
  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const records = JSON.parse(raw);
      // 向后兼容: 将旧 isClosed 字段迁移为 status
      let migrated = false;
      for (const r of records) {
        if (r.status == null) {
          r.status = r.isClosed ? 'closed' : 'open';
          delete r.isClosed;
          migrated = true;
        }
      }
      if (migrated) this._save(records);
      return records;
    } catch {
      return [];
    }
  },

  _save(records) {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
  },

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  // ==========================================================
  // CRUD
  // ==========================================================

  /** 生成机构号: 6位邮编 + 1位随机数 + 1位校验位 (=8位) */
  generateInstCode(postalCode) {
    const prefix = postalCode.slice(0, 6);
    const rand = Math.floor(Math.random() * 10);
    const digits = prefix.split('').map(Number);
    digits.push(rand);
    const weights = [6, 5, 4, 7, 2, 8, 3];
    const sum = digits.reduce((s, d, i) => s + d * weights[i], 0);
    const checkDigit = sum % 10;
    return `${prefix}${rand}${checkDigit}`;
  },

  /** 获取所有记录 */
  getAll() {
    return this._load();
  },

  /** 根据 ID 获取 */
  getById(id) {
    return this._load().find(r => r.id === id) || null;
  },

  /** 根据机构号获取 */
  getByInstCode(code) {
    return this._load().find(r => r.institutionCode === code) || null;
  },

  /** 添加记录 */
  add(record) {
    const records = this._load();
    // 确保必填字段
    if (!record.id) record.id = this._genId();
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    if (!record.stampNumbers) record.stampNumbers = [];
    if (!record.scenicNames) record.scenicNames = [];
    if (!record.photos) record.photos = [];
    records.push(record);
    this._save(records);
    return record;
  },

  /** 更新记录 */
  update(id, updates) {
    const records = this._load();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...updates, id }; // 保护 ID
    this._save(records);
    return records[idx];
  },

  /** 删除记录 */
  delete(id) {
    const records = this._load();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return false;
    records.splice(idx, 1);
    this._save(records);
    return true;
  },

  /** 清空所有记录 */
  clear() {
    localStorage.removeItem(STORE_KEY);
  },

  // ==========================================================
  // 查询与统计
  // ==========================================================

  /** 按省份筛选 */
  getByProvince(provinceName) {
    return this._load().filter(r => r.province === provinceName);
  },

  /** 按城市筛选 */
  getByCity(cityName) {
    return this._load().filter(r => r.city === cityName);
  },

  /** 获取所有记录的汇总统计 */
  getSummary() {
    const records = this._load();
    const provinces = new Set();
    const cities = new Set();
    records.forEach(r => {
      provinces.add(r.province);
      cities.add(r.city);
    });
    return {
      totalRecords: records.length,
      coveredProvinces: provinces.size,
      coveredCities: cities.size,
      records
    };
  },

  /** 按省份聚合统计 (仅统计营业中的邮局，用于完成率计算) */
  getProvinceStats() {
    const records = this._load().filter(r => r.status === 'open');
    const map = {};
    records.forEach(r => {
      if (!map[r.province]) map[r.province] = { collected: 0, cities: new Set() };
      map[r.province].collected++;
      map[r.province].cities.add(r.city);
    });
    return map;
  },

  /** 按城市聚合统计 (仅统计营业中的邮局，用于完成率计算) */
  getCityStats(provinceName) {
    const records = (provinceName
      ? this._load().filter(r => r.province === provinceName)
      : this._load()).filter(r => r.status === 'open');
    const map = {};
    records.forEach(r => {
      if (!map[r.city]) map[r.city] = { collected: 0 };
      map[r.city].collected++;
    });
    return map;
  },

  /** 按区县聚合统计（直辖市用，仅统计营业中的邮局） */
  getDistrictStats(provinceName) {
    const records = this._load().filter(r => r.province === provinceName && r.status === 'open');
    const map = {};
    records.forEach(r => {
      const key = r.district || r.city;
      if (!map[key]) map[key] = { collected: 0 };
      map[key].collected++;
    });
    return map;
  },

  /** 获取记录总数 */
  count() {
    return this._load().length;
  },

  /** 记录数变化时通知回调 */
  _changeListeners: [],

  onChange(cb) {
    this._changeListeners.push(cb);
  },

  _notifyChange() {
    this._changeListeners.forEach(cb => cb(this.count()));
  }
};

// 覆写 CRUD 方法以触发通知
const _origAdd = RecordStore.add;
RecordStore.add = function (record) {
  const r = _origAdd.call(this, record);
  this._notifyChange();
  return r;
};
const _origUpdate = RecordStore.update;
RecordStore.update = function (id, updates) {
  const r = _origUpdate.call(this, id, updates);
  this._notifyChange();
  return r;
};
const _origDelete = RecordStore.delete;
RecordStore.delete = function (id) {
  const r = _origDelete.call(this, id);
  this._notifyChange();
  return r;
};
const _origClear = RecordStore.clear;
RecordStore.clear = function () {
  _origClear.call(this);
  this._notifyChange();
};
