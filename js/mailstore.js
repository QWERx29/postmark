/**
 * 邮件收发记录存储 — localStorage 持久化 CRUD
 * ===========================================
 * 依赖: 无 (纯数据管理)
 *
 * 「待发 / 在途 / 妥收」三个模块**共用这一张表**，用 status 字段区分：
 *   pending   = 待发
 *   transit   = 在途
 *   delivered = 妥收
 *
 * 每条记录结构:
 * {
 *   id: string,          // 内部 id
 *   status: string,      // 'pending' | 'transit' | 'delivered'
 *   sendDate: string,    // 发出日期 YYYY-MM-DD（可直接按字符串排序）
 *   mailType: string,    // 邮件种类
 *   mailNo: string,      // 邮件号码
 *   fromPlace: string,   // 寄出地
 *   toPlace: string,     // 寄达地
 *   content: string,     // 内容
 *   createdAt: string,   // ISO 时间戳
 *   updatedAt: string    // ISO 时间戳
 * }
 */

const MAIL_STORE_KEY = 'postmark_mail_items';

const MailStore = {

  /** 状态取值与中文名（顺序即流转顺序） */
  STATUSES: ['pending', 'transit', 'delivered'],
  STATUS_LABEL: { pending: '待发', transit: '在途', delivered: '妥收' },

  /**
   * 邮件种类限定为这两种。
   * 平信没有条码，因此**不强制**填邮件号码；挂号信必须填。
   */
  MAIL_TYPES: ['挂号信', '平信'],
  NO_BARCODE_TYPE: '平信',
  DEFAULT_MAIL_TYPE: '挂号信',

  /** 该种类是否必须填写邮件号码 */
  requiresMailNo(type) {
    return type !== this.NO_BARCODE_TYPE;
  },

  // ==========================================================
  // 内部方法
  // ==========================================================
  _load() {
    try {
      const raw = localStorage.getItem(MAIL_STORE_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.map(r => this._normalize(r));
    } catch (e) {
      return [];
    }
  },

  _save(list) {
    localStorage.setItem(MAIL_STORE_KEY, JSON.stringify(list));
  },

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /** 补齐缺省字段、纠正非法状态（兼容手工改过的 localStorage） */
  _normalize(rec) {
    const r = { ...rec };
    r.id = r.id || this._genId();
    if (!this.STATUSES.includes(r.status)) r.status = 'pending';
    r.sendDate = r.sendDate || '';
    r.mailType = r.mailType || '';
    r.mailNo = r.mailNo || '';
    r.fromPlace = r.fromPlace || '';
    r.toPlace = r.toPlace || '';
    r.content = r.content || '';
    r.createdAt = r.createdAt || new Date().toISOString();
    r.updatedAt = r.updatedAt || r.createdAt;
    return r;
  },

  /** 列表排序：待发按「最早要发的在前」，在途 / 妥收按最新在前 */
  _sort(list, status) {
    const dir = status === 'pending' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const d = String(a.sendDate).localeCompare(String(b.sendDate));
      if (d !== 0) return d * dir;
      return String(a.createdAt).localeCompare(String(b.createdAt)) * dir;
    });
  },

  // ==========================================================
  // CRUD
  // ==========================================================

  /** 全部记录（按时间倒序，不区分状态） */
  getAll() {
    return this._load();
  },

  /** 按状态取列表（已排好序） */
  getByStatus(status) {
    return this._sort(this._load().filter(r => r.status === status), status);
  },

  getById(id) {
    return this._load().find(r => r.id === id) || null;
  },

  /** 某状态下的条数（侧边栏角标等可用） */
  count(status) {
    const list = this._load();
    return status ? list.filter(r => r.status === status).length : list.length;
  },

  /**
   * 新增记录。
   * 业务上只有「待发」模块会调用它，因此缺省状态为 pending；
   * 其它状态由 setStatus() 流转而来，不要在别处直接传入别的 status。
   */
  add(record) {
    const list = this._load();
    const rec = this._normalize({
      ...record,
      status: this.STATUSES.includes(record.status) ? record.status : 'pending',
      id: record.id || this._genId(),
      createdAt: record.createdAt || new Date().toISOString(),
    });
    rec.updatedAt = new Date().toISOString();
    list.push(rec);
    this._save(list);
    this._notifyChange();
    return rec;
  },

  /** 更新记录（不允许借 update 改 id / createdAt；status 请走 setStatus） */
  update(id, updates) {
    const list = this._load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const patch = { ...updates };
    delete patch.id;
    delete patch.createdAt;
    if (patch.status && !this.STATUSES.includes(patch.status)) delete patch.status;
    list[idx] = this._normalize({ ...list[idx], ...patch, id });
    list[idx].updatedAt = new Date().toISOString();
    this._save(list);
    this._notifyChange();
    return list[idx];
  },

  /** 状态流转（待发 → 在途 → 妥收，也支持退回） */
  setStatus(id, status) {
    if (!this.STATUSES.includes(status)) return null;
    return this.update(id, { status });
  },

  /** 删除记录 */
  remove(id) {
    const list = this._load();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this._save(list);
    this._notifyChange();
    return true;
  },

  /** 清空（全部状态） */
  clear() {
    localStorage.removeItem(MAIL_STORE_KEY);
    this._notifyChange();
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
      try { cb(); } catch (e) { console.error('[MailStore] 变更回调出错:', e); }
    });
  },
};
