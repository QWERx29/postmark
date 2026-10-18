/**
 * IndexedDB 键值封装 — 参考库与地图缓存的落地层
 * ================================================
 * 为什么不用 localStorage
 * ----------------------
 *   Chromium 对 localStorage 是**每 origin 5 MiB** 的硬配额。本应用的 PO 参考库
 *   来自 base/ 目录（62 个 CSV、约 10.9 万条记录），序列化后约 2200 万字符，
 *   是配额的 4 倍以上 —— 旧实现写到第 3~4 个省就抛 QuotaExceededError，
 *   启动时必然弹「网点数据导入失败：存储空间不足」。
 *   IndexedDB 的配额按磁盘可用空间计算（通常数百 MB 起），装得下，且写入
 *   不阻塞主线程。
 *
 * 设计要点
 * --------
 *   1. 单一 object store（名为 kv），键是字符串，值直接存结构化对象，
 *      不做 JSON.stringify —— 少一次序列化，也省一份内存；
 *   2. 所有 API 返回 Promise，失败必抛，由调用方决定降级还是提示；
 *   3. write() 支持把「写入 + 删除」放进同一个事务，保证替换导入的原子性；
 *   4. 打开失败后记住不可用（_unavailable），避免每次调用都重试拖慢启动，
 *      调用方可用 isSupported() 判断是否降级为内存模式；
 *   5. 不处理 versionchange / 多标签页升级：本项目是单实例应用（见 launch.js）。
 *
 * 用法
 * ----
 *   await IdbKV.set('geojson_cache_100000', geo);
 *   const geo = await IdbKV.get('geojson_cache_100000');
 *   await IdbKV.write({ puts: [['k1', v1]], deletes: ['k2'] });
 *   const all = await IdbKV.entries('poref_data_');   // [[key, value], ...]
 */

const IdbKV = (function () {

  const DB_NAME = 'postmark';
  const DB_VERSION = 1;
  const STORE = 'kv';

  /** 打开失败后置位：后续调用直接走拒绝分支，不再重试 */
  let _db = null;
  let _opening = null;
  let _unavailable = false;

  // ================================================================
  // 打开数据库
  // ================================================================

  function isSupported() {
    return !_unavailable && typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  /** 打开数据库（幂等） */
  function open() {
    if (_db) return Promise.resolve(_db);
    if (_opening) return _opening;
    if (!isSupported()) {
      _unavailable = true;
      return Promise.reject(new Error('IndexedDB 不可用'));
    }

    _opening = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其它窗口占用，无法升级'));
    }).catch((e) => {
      _unavailable = true;
      _opening = null;
      throw e;
    });

    return _opening;
  }

  // ================================================================
  // 读
  // ================================================================

  /**
   * 读取单个键。
   * @returns {Promise<any|null>} 不存在时返回 null
   */
  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => reject(req.error || new Error('读取失败'));
    });
  }

  /** 按前缀取出全部键值。前缀为空/省略时返回整个库。 */
  async function entries(prefix) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction(STORE, 'readonly');
      // 前缀区间：['poref_data_', 'poref_data_\uffff'] 覆盖所有以该前缀开头的键
      const range = prefix ? IDBKeyRange.bound(prefix, prefix + '\uffff') : undefined;
      const req = t.objectStore(STORE).openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        out.push([cur.key, cur.value]);
        cur.continue();
      };
      req.onerror = () => reject(req.error || new Error('遍历失败'));
    });
  }

  // ================================================================
  // 写
  // ================================================================

  /**
   * 单事务执行一批写入与删除。要么全部生效，要么全部不生效。
   * @param {{puts?: Array<[string, any]>, deletes?: string[]}} ops
   * @returns {Promise<{puts:number, deletes:number}>}
   */
  async function write(ops) {
    const puts = (ops && ops.puts) || [];
    const deletes = (ops && ops.deletes) || [];
    if (puts.length === 0 && deletes.length === 0) return { puts: 0, deletes: 0 };

    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      try {
        for (const [k, v] of puts) store.put(v, k);
        for (const k of deletes) store.delete(k);
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve({ puts: puts.length, deletes: deletes.length });
      t.onerror = () => reject(t.error || new Error('写入失败'));
      t.onabort = () => reject(t.error || new Error('写入被中止'));
    });
  }

  /** 写入单个键 */
  function set(key, value) {
    return write({ puts: [[key, value]] });
  }

  /** 批量写入 */
  function setMany(pairs) {
    return write({ puts: pairs });
  }

  /** 删除一个或多个键 */
  function del(keys) {
    return write({ deletes: Array.isArray(keys) ? keys : [keys] });
  }

  // ================================================================
  // 公开 API
  // ================================================================

  return {
    isSupported,
    open,
    get,
    entries,
    write,
    set,
    setMany,
    del,
    /** 基础信息，便于排查与自检 */
    info() {
      return { db: DB_NAME, store: STORE, version: DB_VERSION, ready: !!_db, unavailable: _unavailable };
    },
  };

})();
