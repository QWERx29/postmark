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
 *   status: string,       // 邮局类型/状态: 'open'=营业 | 'delivery'=投递部 | 'closed'=已撤销 | 'themed'=主题邮局 | 'temporary'=临时邮局
 *   postalCode: string,   // 邮政编码 (6位)
 *   institutionCode: string, // 机构号 (主键，8位数字，可手动编辑)
 *   cancelDate: string,   // 盖销日期 YYYY.MM.DD.HH
 *   stamps: Array<{number: string, material: string}>, // 每把日戳：戳号 + 材质
 *                        //   number 为空串表示「无戳号」
 *   stampNumbers: string[], // 旧字段：仅有戳号的戳号列表（由 stamps 派生，兼容旧代码）
 *   material: string,     // 旧字段：材质摘要（由 stamps 派生，兼容旧代码）
 *   hasPostageMeter: boolean,
 *   meterModel: string,   // 邮资机型号
 *   meterNo: string,      // 邮资机编号
 *   meterHeader: string,  // 表头
 *   meterLowerRing: string, // 下环
 *   hasScenicPostmark: boolean,
 *   scenicNames: string[], // 风景/文化日戳名称列表
 *   notes: string,
 *   photos: string[],     // 已保存图片相对路径（相对 images/，见 img-export.js）
 *   createdAt: string     // ISO 时间戳
 * }
 */

const STORE_KEY = 'postmark_records';
/** 回收站：软删除的记录（保留 30 天，可恢复） */
const TRASH_KEY = 'postmark_trash_records';
const TRASH_RETENTION_DAYS = 30;

// ============================================================
// 戳号 / 材质归一化
// ------------------------------------------------------------
// 记录里的日戳是「一把一条」：{ number, material }。
// 旧记录只有 stampNumbers: string[] + material: string，读取时在这里补齐；
// 空戳号不是「没填」，而是明确的「无戳号」，所以不能被 filter 掉。
// ============================================================

function cleanStampText(value) {
  return value == null ? '' : String(value).trim();
}

/** 用户把「无戳号」直接填进戳号框时，等同于留空 */
function normalizeStampNumber(value) {
  const text = cleanStampText(value);
  return text === '无戳号' ? '' : text;
}

/** 把一条记录归一化成 stamps: [{ number, material }]（兼容旧 stampNumbers + material） */
function normalizeStamps(record) {
  if (!record) return [];

  // 已经是新结构：保留显式空行（{number:'', material:''} 表示无戳号且材质未填）
  if (Array.isArray(record.stamps)) {
    const out = [];
    record.stamps.forEach((item) => {
      if (item && typeof item === 'object') {
        out.push({
          number: normalizeStampNumber(item.number),
          material: cleanStampText(item.material),
        });
      } else {
        const rawText = cleanStampText(item);
        const number = normalizeStampNumber(item);
        if (number) out.push({ number, material: cleanStampText(record.material) });
        else if (rawText === '无戳号') out.push({ number: '', material: cleanStampText(record.material) });
      }
    });
    return out;
  }

  // 旧结构：stampNumbers + 一个材质，材质套到每一把日戳上
  const raw = record.stampNumbers;
  const numbers = Array.isArray(raw) ? raw : (cleanStampText(raw) ? [raw] : []);
  const material = cleanStampText(record.material);
  const out = [];
  numbers.forEach((n) => {
    const rawText = cleanStampText(n);
    const number = normalizeStampNumber(n);
    if (number) out.push({ number, material });
    // 旧表里显式写了「无戳号」也保留成一把无号日戳
    else if (rawText === '无戳号') out.push({ number: '', material });
  });
  if (out.length === 0 && material) out.push({ number: '', material });
  return out;
}

/** 反向派生旧字段，避免旧导出 / 外部脚本读到过期数据 */
function syncLegacyStampFields(record) {
  const stamps = Array.isArray(record.stamps) ? record.stamps : [];
  record.stampNumbers = stamps.map(s => s.number).filter(Boolean);
  const materials = Array.from(new Set(stamps.map(s => s.material).filter(Boolean)));
  record.material = materials.join('、');
}

const RecordStore = {

  // ==========================================================
  // 内部方法
  // ==========================================================
  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const records = JSON.parse(raw);
      // 向后兼容: 将旧 isClosed 字段迁移为 status；旧戳号字段迁移为 stamps
      let migrated = false;
      for (const r of records) {
        if (r.status == null) {
          r.status = r.isClosed ? 'closed' : 'open';
          delete r.isClosed;
          migrated = true;
        }
        if (!Array.isArray(r.stamps)) {
          r.stamps = normalizeStamps(r);
          syncLegacyStampFields(r);
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

  /** 补齐缺省字段并把戳号归一化（新增 / 导入 / 恢复共用同一套口径） */
  _normalizeRecord(record) {
    const rec = { ...(record || {}) };
    if (!rec.id) rec.id = this._genId();
    if (!rec.createdAt) rec.createdAt = new Date().toISOString();
    rec.stamps = normalizeStamps(rec);
    syncLegacyStampFields(rec);
    if (!Array.isArray(rec.scenicNames)) rec.scenicNames = [];
    if (!Array.isArray(rec.photos)) rec.photos = [];
    return rec;
  },

  // ==========================================================
  // 回收站（软删除）
  // ----------------------------------------------------------
  // 删除不再直接 splice：记录连同 deletedAt 一起移进 postmark_trash_records，
  // 30 天内可以在「数据安全 → 回收站」里恢复；读取回收站时顺手清掉过期的。
  // ==========================================================
  _loadTrash() {
    try {
      const raw = localStorage.getItem(TRASH_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.filter(r => r && typeof r === 'object');
    } catch (e) {
      return [];
    }
  },

  _saveTrash(list) {
    localStorage.setItem(TRASH_KEY, JSON.stringify(list));
  },

  _addToTrash(record) {
    const list = this._loadTrash();
    list.push({ ...record, deletedAt: new Date().toISOString() });
    this._saveTrash(list);
    this.purgeExpiredTrash();
  },

  /** 回收站里的记录（新的在前；顺手清理超过 30 天的） */
  getTrash() {
    this.purgeExpiredTrash();
    return this._loadTrash().sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  },

  trashCount() {
    this.purgeExpiredTrash();
    return this._loadTrash().length;
  },

  /** 从回收站恢复一条记录（原 id 已被占用时换一个新 id） */
  restore(id) {
    const trash = this._loadTrash();
    const idx = trash.findIndex(r => r.id === id);
    if (idx === -1) return false;

    const [raw] = trash.splice(idx, 1);
    const rec = this._normalizeRecord(raw);
    delete rec.deletedAt;

    const records = this._load();
    if (records.some(r => r.id === rec.id)) rec.id = this._genId();
    records.push(rec);

    this._save(records);
    this._saveTrash(trash);
    this._notifyChange();
    return true;
  },

  /** 从回收站彻底删除一条（不可恢复） */
  purgeTrash(id) {
    const trash = this._loadTrash();
    const idx = trash.findIndex(r => r.id === id);
    if (idx === -1) return false;
    trash.splice(idx, 1);
    this._saveTrash(trash);
    this._notifyChange();
    return true;
  },

  /** 清空回收站 */
  emptyTrash() {
    const n = this._loadTrash().length;
    localStorage.removeItem(TRASH_KEY);
    if (n > 0) this._notifyChange();
    return n;
  },

  /** 整表替换回收站（恢复备份用） */
  replaceTrash(list) {
    const arr = (Array.isArray(list) ? list : []).filter(r => r && typeof r === 'object');
    this._saveTrash(arr);
    this._notifyChange();
    return arr.length;
  },

  /** 删除超过保留期的回收站记录（读取回收站时自动调用） */
  purgeExpiredTrash() {
    const list = this._loadTrash();
    if (list.length === 0) return 0;
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept = list.filter(r => {
      const t = Date.parse(r.deletedAt || '');
      // 没有 / 解析不出删除时间的条目宁可保留，也不要在读取时把它悄悄清掉
      return !Number.isFinite(t) || t >= cutoff;
    });
    if (kept.length === list.length) return 0;
    this._saveTrash(kept);
    return list.length - kept.length;
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

  /**
   * 按「省 + 市 + 县 + 邮局名」找同网点记录（录入时识别重复网点用）。
   * 区县两边都为空才算相同；一边有一边空不算命中，避免把同名不同区的网点合并。
   *
   * @param {{province?:string, city?:string, district?:string, postOffice?:string}} record
   * @param {string} [excludeId] 编辑自己时排除自身
   * @returns {Array<object>}
   */
  findSameOffice(record, excludeId) {
    if (!record) return [];
    const norm = (v) => String(v == null ? '' : v).trim();
    const province = norm(record.province);
    const city = norm(record.city);
    const district = norm(record.district);
    const name = norm(record.postOffice);
    if (!province || !city || !name) return [];

    return this._load().filter(r => {
      if (excludeId && r.id === excludeId) return false;
      return norm(r.province) === province
        && norm(r.city) === city
        && norm(r.district) === district
        && norm(r.postOffice) === name;
    });
  },

  /** 添加记录 */
  add(record) {
    const records = this._load();
    // 确保必填字段
    if (!record.id) record.id = this._genId();
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    record.stamps = normalizeStamps(record);
    syncLegacyStampFields(record);
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

    const current = records[idx];
    const merged = { ...current, ...updates, id }; // 保护 ID

    // 三种更新方式都要照顾：
    //   1) 表单直接给 stamps；
    //   2) 批量编辑只给 material —— 套到这把记录的所有日戳上；
    //   3) 旧代码只给 stampNumbers / material。
    if (updates && Array.isArray(updates.stamps)) {
      merged.stamps = normalizeStamps({ stamps: updates.stamps, material: merged.material });
    } else if (updates && updates.material != null && updates.stampNumbers == null) {
      const material = cleanStampText(updates.material);
      const base = normalizeStamps(current);
      merged.stamps = base.length
        ? base.map(s => ({ ...s, material }))
        : [{ number: '', material }];
    } else if (updates && updates.stampNumbers != null) {
      merged.stamps = normalizeStamps({
        stampNumbers: updates.stampNumbers,
        material: updates.material != null ? updates.material : merged.material,
      });
    } else {
      merged.stamps = normalizeStamps(merged);
    }

    syncLegacyStampFields(merged);
    records[idx] = merged;
    this._save(records);
    return records[idx];
  },

  /**
   * 一条记录里的日戳明细（兼容旧记录）。
   * @returns {Array<{number:string, material:string}>} number 为空串表示「无戳号」
   */
  getStamps(record) {
    return normalizeStamps(record);
  },

  /** 单把日戳的显示文本：无戳号 + 材质 */
  formatStamp(stamp) {
    const s = stamp || {};
    const label = normalizeStampNumber(s.number) || '无戳号';
    const material = cleanStampText(s.material);
    return material ? `${label}（${material}）` : label;
  },

  /** 一条记录的日戳显示文本，如「1（字钉）、无戳号（拨轮）」 */
  formatStamps(record, separator) {
    return this.getStamps(record).map(s => this.formatStamp(s)).join(separator || '、');
  },

  /** 只显示戳号（不含材质），用于「全部记录」列表 */
  formatStampNumbers(record, separator) {
    const labels = this.getStamps(record)
      .map(s => normalizeStampNumber(s.number) || '无戳号');
    return Array.from(new Set(labels)).join(separator || '、');
  },

  /**
   * 删除记录 = 移入回收站（30 天内可恢复）。
   * 真正清理由「回收站 → 彻底删除 / 清空」或到期自动清理完成。
   */
  delete(id) {
    const records = this._load();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return false;
    const [removed] = records.splice(idx, 1);
    this._save(records);
    try {
      this._addToTrash(removed);
    } catch (e) {
      // 回收站写不进去（多为配额已满）：记录已经删除，这里只留下日志，
      // 不让一次删除操作因为"备份失败"而表现得像没删掉。
      console.warn('[RecordStore] 记录未能写入回收站:', e);
    }
    return true;
  },

  /**
   * 整表替换（恢复备份 / 覆盖恢复用）。
   * @param {Array} list
   * @returns {number} 写入的条数
   */
  replaceAll(list) {
    const records = (Array.isArray(list) ? list : []).map(r => this._normalizeRecord(r));
    this._save(records);
    this._notifyChange();
    return records.length;
  },

  /**
   * 按 id 合并（恢复备份 / 合并导入用）：只补缺失的，不校验业务字段。
   * @param {Array} list
   * @param {{overwrite?:boolean}} [opts] overwrite=true 时同 id 用备份内容覆盖
   * @returns {{added:number, updated:number, skipped:number}}
   */
  mergeAll(list, opts) {
    const overwrite = Boolean(opts && opts.overwrite);
    const records = this._load();
    const byId = new Map(records.map((r, i) => [r.id, i]));
    const result = { added: 0, updated: 0, skipped: 0 };

    (Array.isArray(list) ? list : []).forEach((incoming) => {
      if (!incoming || typeof incoming !== 'object') { result.skipped++; return; }
      const rec = this._normalizeRecord(incoming);
      const idx = byId.get(rec.id);
      if (idx == null) {
        records.push(rec);
        byId.set(rec.id, records.length - 1);
        result.added++;
      } else if (overwrite) {
        records[idx] = rec;
        result.updated++;
      } else {
        result.skipped++;
      }
    });

    if (result.added || result.updated) this._save(records);
    if (result.added || result.updated) this._notifyChange();
    return result;
  },

  /**
   * 预检一次导入：统计重复（按 id / 机构号）与无效条数，用于让用户先选处理方式。
   * @param {Array} list
   * @returns {{total:number, duplicates:number, byId:number, byInstCode:number, invalid:number}}
   */
  planImport(list) {
    const arr = Array.isArray(list) ? list : [];
    const records = this._load();
    const ids = new Set(records.map(r => r.id).filter(Boolean));
    const instCodes = new Set(records.map(r => r.institutionCode).filter(Boolean));

    // 同一份文件里也可能自带重复（例如把两份备份拼在一起），一并算进去
    const seenIds = new Set();
    const seenInst = new Set();

    let byId = 0;
    let byInstCode = 0;
    let invalid = 0;

    arr.forEach((r) => {
      if (!r || typeof r !== 'object' || !r.postOffice || !r.province) { invalid++; return; }

      const dupId = Boolean(r.id) && (ids.has(r.id) || seenIds.has(r.id));
      const dupInst = Boolean(r.institutionCode)
        && (instCodes.has(r.institutionCode) || seenInst.has(r.institutionCode));

      if (dupId) byId++;
      else if (dupInst) byInstCode++;

      if (r.id) seenIds.add(r.id);
      if (r.institutionCode) seenInst.add(r.institutionCode);
    });

    return { total: arr.length, duplicates: byId + byInstCode, byId, byInstCode, invalid };
  },

  /**
   * 批量导入并去重。
   *
   * 重复判定：id 相同，或机构号相同（记录没有 id 时只看机构号）。
   *   strategy = 'skip'      跳过重复，保留现有记录
   *   strategy = 'overwrite' 用导入内容覆盖重复记录（保留原 id）
   *   strategy = 'new'       作为新记录导入（换一个新 id，允许同机构号并存）
   *
   * @param {Array} list
   * @param {{strategy?:'skip'|'overwrite'|'new'}} [opts]
   * @returns {{added:number, updated:number, skipped:number, invalid:number, duplicates:number}}
   */
  importRecords(list, opts) {
    const strategy = (opts && ['skip', 'overwrite', 'new'].includes(opts.strategy))
      ? opts.strategy
      : 'skip';
    const arr = Array.isArray(list) ? list : [];

    const records = this._load();
    const byId = new Map();
    const byInst = new Map();
    records.forEach((r, i) => {
      if (r.id) byId.set(r.id, i);
      if (r.institutionCode) byInst.set(r.institutionCode, i);
    });

    const result = { added: 0, updated: 0, skipped: 0, invalid: 0, duplicates: 0 };

    arr.forEach((raw) => {
      if (!raw || typeof raw !== 'object' || !raw.postOffice || !raw.province) {
        result.invalid++;
        return;
      }

      const rec = { ...raw };
      if (!rec.institutionCode && rec.postalCode) {
        rec.institutionCode = this.generateInstCode(rec.postalCode);
      }

      const hitId = rec.id && byId.has(rec.id) ? byId.get(rec.id) : -1;
      const hitInst = rec.institutionCode && byInst.has(rec.institutionCode) ? byInst.get(rec.institutionCode) : -1;
      const hit = hitId >= 0 ? hitId : hitInst;

      if (hit >= 0) {
        result.duplicates++;
        if (strategy === 'skip') {
          result.skipped++;
          return;
        }
        if (strategy === 'overwrite') {
          // 保留现有 id，其余字段以导入内容为准。
          // 导入的是旧格式（只有 stampNumbers + material）时，不能让现有 stamps 把新值盖掉。
          const base = { ...records[hit] };
          if (!Array.isArray(rec.stamps) && rec.stampNumbers != null) delete base.stamps;
          const merged = this._normalizeRecord({ ...base, ...rec, id: records[hit].id });
          records[hit] = merged;
          if (merged.id) byId.set(merged.id, hit);
          if (merged.institutionCode) byInst.set(merged.institutionCode, hit);
          result.updated++;
          return;
        }
        // 'new'：换一个新 id，作为独立记录导入
        rec.id = this._genId();
      }

      if (!rec.id) rec.id = this._genId();
      const normalized = this._normalizeRecord(rec);
      records.push(normalized);
      byId.set(normalized.id, records.length - 1);
      if (normalized.institutionCode) byInst.set(normalized.institutionCode, records.length - 1);
      result.added++;
    });

    if (result.added || result.updated) {
      this._save(records);
      this._notifyChange();
    }
    return result;
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
