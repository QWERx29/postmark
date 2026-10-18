/**
 * 国际退信存储 — localStorage 持久化 CRUD
 * =========================================
 * 依赖: 无（纯数据管理；国家/地区候选表 CountryData 只在界面层用）
 *
 * 「国际退信」是一张独立的数据表：记录一件寄往境外的邮件被退回、
 * 直至收回的完整过程（寄出 → 寄达 → 返回 → 收回）与邮路。
 *
 * 每条记录结构:
 * {
 *   id: string,            // 内部 id
 *   countryZh: string,     // 寄达国家（地区）中文名
 *   countryEn: string,     // 寄达国家（地区）英文名
 *   countryCode: string,   // 寄达国家（地区）二字代码（ISO 3166-1 alpha-2，大写）
 *   sendMethod: string,    // 寄出方式：航空 / SAL / 水陆路
 *   mailNo: string,        // 邮件号码（13 位，大写；国际邮件为 2 字母 + 9 数字 + 2 字母）
 *   sendDate: string,      // 寄出时间 YYYY-MM-DD（可直接按字符串排序）
 *   arriveDate: string,    // 寄达时间 YYYY-MM-DD
 *   returnDate: string,    // 返回时间 YYYY-MM-DD
 *   recoverDate: string,   // 收回时间 YYYY-MM-DD
 *   acceptOffice: string,  // 境外接收互换局（六位字母，大写）
 *   exportOffice: string,  // 境外出口互换局（六位字母，大写）
 *   route: {               // 邮路信息
 *     nodes: string[],     //   途经点（按先后顺序）
 *     legs: string[]       //   相邻两点之间的运送信息（自由填写，可空；长度 = nodes - 1）
 *   },
 *   notes: string,         // 备注
 *   createdAt: string,     // ISO 时间戳
 *   updatedAt: string      // ISO 时间戳
 * }
 */

const RETURN_STORE_KEY = 'postmark_return_items';

const ReturnStore = {

  /** 寄出方式（下拉框选项，顺序即界面顺序） */
  SEND_METHODS: ['航空', 'SAL', '水陆路'],
  DEFAULT_SEND_METHOD: '航空',

  /** 邮件号码：13 位。国际邮件标准格式 = 2 位字母 + 9 位数字 + 2 位字母 */
  MAIL_NO_LENGTH: 13,
  MAIL_NO_RE: /^[A-Z]{2}\d{9}[A-Z]{2}$/,

  /** 境外接收互换局：六位字母 */
  OFFICE_LENGTH: 6,
  OFFICE_RE: /^[A-Z]{6}$/,

  /** 表单里的业务字段（缺省补齐与导入校验都以它为准；route 单独处理） */
  FIELDS: [
    'countryZh', 'countryEn', 'countryCode', 'sendMethod', 'mailNo',
    'sendDate', 'arriveDate', 'returnDate', 'recoverDate',
    'acceptOffice', 'exportOffice', 'notes',
  ],

  /** 时间链条：从寄出到收回，四项必须按这个先后顺序 */
  TIMELINE: [
    { key: 'sendDate',    label: '寄出时间' },
    { key: 'arriveDate',  label: '寄达时间' },
    { key: 'returnDate',  label: '返回时间' },
    { key: 'recoverDate', label: '收回时间' },
  ],

  // ==========================================================
  // 取值规范化 / 校验（表单与导入共用同一套，避免两处口径不一）
  // ==========================================================

  /** 邮件号码：去空白、转大写（用户常把号码复制成带空格的样子） */
  normalizeMailNo(v) {
    return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  },

  isMailNoLengthOk(v) {
    return this.normalizeMailNo(v).length === this.MAIL_NO_LENGTH;
  },

  /** 是否标准的国际邮件号码（2 字母 + 9 数字 + 2 字母） */
  isValidMailNo(v) {
    return this.MAIL_NO_RE.test(this.normalizeMailNo(v));
  },

  /** 互换局代码（接收 / 出口都是六位字母）：去空白、转大写 */
  normalizeOffice(v) {
    return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  },

  isValidOfficeCode(v) {
    return this.OFFICE_RE.test(this.normalizeOffice(v));
  },

  /** 国家二字代码：只保留两位大写字母 */
  normalizeCountryCode(v) {
    return String(v == null ? '' : v).replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  },

  isValidCountryCode(v) {
    return /^[A-Z]{2}$/.test(this.normalizeCountryCode(v));
  },

  /**
   * 时间先后自检（只在四项都填了的情况下比较相邻两项）。
   * @returns {string} 空串表示没问题，否则返回一句人话
   */
  timelineWarning(rec) {
    const filled = this.TIMELINE.filter(t => rec && /^\d{4}-\d{2}-\d{2}$/.test(String(rec[t.key] || '')));
    for (let i = 1; i < filled.length; i++) {
      const prev = filled[i - 1];
      const cur = filled[i];
      if (String(rec[cur.key]) < String(rec[prev.key])) {
        return `${cur.label}（${rec[cur.key]}）早于${prev.label}（${rec[prev.key]}）`;
      }
    }
    return '';
  },

  /** 邮路是否为空（没有任何途经点） */
  isRouteEmpty(route) {
    return !route || !Array.isArray(route.nodes) || route.nodes.filter(n => String(n || '').trim()).length === 0;
  },

  /**
   * 邮路一句话摘要：`北京互换局 →(CA123) 东京互换局 → 巴黎`
   * 列表提示与详情弹窗的标题都用它，保证两处显示一致。
   */
  routeSummary(route) {
    const r = this._normalizeRoute(route);
    let out = '';
    r.nodes.forEach((node, i) => {
      if (i === 0) { out = node; return; }
      const leg = String(r.legs[i - 1] || '').trim();
      out += (leg ? ` →(${leg}) ` : ' → ') + node;
    });
    return out.trim();
  },

  /**
   * 邮路逐步展开（详情弹窗用）：途经点与两点之间的运送信息交替出现。
   * @returns {Array<{kind:'node'|'leg', index:number, text:string}>}
   */
  routeSteps(route) {
    const r = this._normalizeRoute(route);
    const steps = [];
    r.nodes.forEach((node, i) => {
      steps.push({ kind: 'node', index: i, text: node });
      if (i < r.nodes.length - 1) steps.push({ kind: 'leg', index: i, text: r.legs[i] || '' });
    });
    return steps;
  },

  // ==========================================================
  // 内部方法
  // ==========================================================
  _load() {
    try {
      const raw = localStorage.getItem(RETURN_STORE_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.map(r => this._normalize(r));
    } catch (e) {
      return [];
    }
  },

  _save(list) {
    localStorage.setItem(RETURN_STORE_KEY, JSON.stringify(list));
  },

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /** 单条运送信息：自由文本，压缩空白；兼容早期 {type, no} 结构 */
  _normalizeLeg(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      // 早先要在下拉里选「航班 / 车次 / 集装箱」，旧数据合并成一句话保留信息
      return [v.type, v.no]
        .map(x => String(x == null ? '' : x).trim())
        .filter(Boolean)
        .join(' ');
    }
    const s = String(v).replace(/\s+/g, ' ').trim();
    // 回填 bug 期间存进库的占位值直接清掉（没有人的运送信息真的叫这个名字）
    return s === '[object Object]' ? '' : s;
  },

  /**
   * 邮路规范化：
   *   - nodes / legs 都转成字符串，脏数据不至于把渲染搞崩；
   *   - 去掉末尾的空途经点（末尾空点没有意义，还会凭空多出一段运送信息）；
   *   - legs 长度永远对齐 nodes - 1。
   */
  _normalizeRoute(route) {
    const src = (route && typeof route === 'object') ? route : {};
    const nodes = (Array.isArray(src.nodes) ? src.nodes : [])
      .map(n => String(n == null ? '' : n).trim());
    const legsIn = Array.isArray(src.legs) ? src.legs : [];
    while (nodes.length > 0 && !nodes[nodes.length - 1]) nodes.pop();

    const legs = [];
    for (let i = 0; i < Math.max(nodes.length - 1, 0); i++) {
      legs.push(this._normalizeLeg(legsIn[i]));
    }
    return { nodes, legs };
  },

  /** 补齐缺省字段、纠正非法取值（兼容手工改过的 localStorage / 早期导入的 JSON） */
  _normalize(rec) {
    const r = { ...rec };
    // id 会被拼进列表的 data-id 属性，而导入的 JSON 不可信：只接受字母数字
    if (!r.id || !/^[A-Za-z0-9_-]+$/.test(String(r.id))) r.id = this._genId();
    this.FIELDS.forEach(f => {
      r[f] = r[f] == null ? '' : String(r[f]);
    });
    r.countryZh = r.countryZh.trim();
    r.countryEn = r.countryEn.trim();
    r.countryCode = this.normalizeCountryCode(r.countryCode);
    if (!this.SEND_METHODS.includes(r.sendMethod)) r.sendMethod = this.DEFAULT_SEND_METHOD;
    r.mailNo = this.normalizeMailNo(r.mailNo);
    this.TIMELINE.forEach(t => { r[t.key] = r[t.key].trim(); });
    r.acceptOffice = this.normalizeOffice(r.acceptOffice);
    r.exportOffice = this.normalizeOffice(r.exportOffice);
    r.route = this._normalizeRoute(r.route);
    r.createdAt = r.createdAt || new Date().toISOString();
    r.updatedAt = r.updatedAt || r.createdAt;
    return r;
  },

  // ==========================================================
  // 排序
  // ==========================================================

  /** 可排序要素（选项顺序即界面下拉框的顺序） */
  SORT_OPTIONS: [
    { key: 'sendDate',    label: '寄出时间' },
    { key: 'arriveDate',  label: '寄达时间' },
    { key: 'returnDate',  label: '返回时间' },
    { key: 'recoverDate', label: '收回时间' },
    { key: 'mailNo',      label: '邮件号码' },
    { key: 'country',     label: '寄达国家' },
    { key: 'sendMethod',  label: '寄出方式' },
    { key: 'acceptOffice', label: '境外接收互换局' },
    { key: 'createdAt',   label: '录入时间' },
  ],

  _sortValue(rec, key) {
    if (key === 'country') return [rec.countryZh, rec.countryCode].filter(Boolean).join(' ');
    return String(rec[key] == null ? '' : rec[key]);
  },

  /**
   * 按指定要素排序（返回副本，不改动存储）。
   * 空值一律排在最后 —— 不管升序还是降序，否则「还没填日期的」会占满第一屏。
   * 同值时按录入时间新→旧回落，保证顺序稳定可预期。
   */
  _sortList(list, key, dir) {
    const k = this.SORT_OPTIONS.some(o => o.key === key) ? key : 'sendDate';
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
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  },

  /** 按要素排序后的全部记录（界面排序用） */
  getSorted(key, dir) {
    return this._sortList(this._load(), key, dir);
  },

  // ==========================================================
  // CRUD
  // ==========================================================

  /** 全部记录（默认：寄出时间新的在前） */
  getAll() {
    return this._sortList(this._load(), 'sendDate', 'desc');
  },

  getById(id) {
    return this._load().find(r => r.id === id) || null;
  },

  count() {
    return this._load().length;
  },

  /** 按邮件号码找（查重提示用；excludeId 用于「编辑自己」时不算重复） */
  findByMailNo(mailNo, excludeId) {
    const no = this.normalizeMailNo(mailNo);
    if (!no) return [];
    return this._load().filter(r => r.mailNo === no && r.id !== excludeId);
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
    localStorage.removeItem(RETURN_STORE_KEY);
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
      try { cb(); } catch (e) { console.error('[ReturnStore] 变更回调出错:', e); }
    });
  },
};
