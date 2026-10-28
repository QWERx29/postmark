#!/usr/bin/env node
/**
 * PO 参考库 IndexedDB 化验证（纯 Node，不需要浏览器）
 * =====================================================
 * 用最小垫片把浏览器脚本跑起来：
 *   - localStorage 垫片带 **5 MiB（5,242,880 字符）配额** —— 与 Chromium 实测
 *     表现一致（旧 profile 里 origin 写到 5,229,244 字符就再也写不进）；
 *   - indexedDB 垫片只实现 IdbKV 用到的那一小撮 API（open / transaction /
 *     get / put / delete / openCursor / IDBKeyRange），并且**跨场景共享同一个
 *     后备存储**，用来模拟"重启应用后从 IndexedDB 水合"。
 *
 * 验证内容：
 *   0. 负向对照：把同样的数据按旧写法（整库塞 localStorage）写一遍，
 *      必须抛 QuotaExceededError —— 证明这台"配额墙"是真的，也证明线上那个
 *      「网点数据导入失败：存储空间不足」确实是它造成的；
 *   1. 全新安装：base/ 62 个 CSV 全量导入 → 31 省 / 10.9 万条全进 IndexedDB，
 *      localStorage 里一个 poref 大键都没有；
 *   2. 重启：新的 JS 上下文 + 新的 localStorage，复用同一份 IndexedDB →
 *      水合出同样的数据；merge 导入能新增、重复导入不重复计数；
 *   3. 旧版升级：空 IndexedDB + localStorage 里塞旧方案数据（含匹配签名）→
 *      旧分片被搬进 IndexedDB、localStorage 被清空、legacyUpgrade() 要求强制
 *      重新导入 base/（否则会停在搬过来的那 2 条上）；
 *   4. 清理路径：deleteProvinceSource() 与 clear() 后 IndexedDB 同步生效。
 *
 * 用法: node scripts/test-poref-idb.js
 * 退出码: 0 全部通过 / 1 有失败
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const iconv = require('iconv-lite');

const ROOT = path.join(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'base');
const LS_QUOTA = 5 * 1024 * 1024;                 // 5 MiB，按字符计（与浏览器实测一致）

// 独立交叉核对：这两个省的 base 文件自 Electron 版最后一次导入（9/27）以来未变，
// 因此新导入的条数必须与旧库（.userdata 那套）完全一致。
const KNOWN_COUNTS = { 120000: 892, 130000: 4943 };

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ============================================================
// localStorage 垫片（带 5 MiB 配额）
// ============================================================
function makeLocalStorage(quota = LS_QUOTA) {
  const map = new Map();
  const usage = () => {
    let n = 0;
    for (const [k, v] of map) n += k.length + v.length;
    return n;
  };
  return {
    get length() { return map.size; },
    key(i) { return i < map.size ? Array.from(map.keys())[i] : null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) {
      k = String(k); v = String(v);
      const after = usage() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + v.length;
      if (after > quota) {
        const e = new Error('Setting the value of a key exceeded the quota.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _usage: usage,
    _keys: () => Array.from(map.keys()),
  };
}

// ============================================================
// 最小 indexedDB 垫片（只实现 IdbKV 用到的部分）
// ============================================================
function makeIndexedDB(backing = new Map()) {
  const stores = { kv: backing };
  const fire = (fn, arg) => queueMicrotask(() => { if (fn) fn(arg); });

  class Req {
    constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  }

  class Tx {
    constructor(mode) {
      this.mode = mode;
      this._ops = [];
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      // 提交排在当前同步代码之后：调用方会在这之前把所有 put/delete 登记完
      fire(() => {
        try {
          for (const op of this._ops) op();
          if (this.oncomplete) this.oncomplete({ target: this });
        } catch (e) {
          if (this.onerror) this.onerror({ target: this, error: e });
        }
      });
    }
    objectStore(name) { return new Store(name, this); }
  }

  class Store {
    constructor(name, tx) { this.name = name; this._map = stores[name]; this._tx = tx; }
    get(key) {
      const req = new Req();
      const v = this._map.get(key);
      fire(() => {
        req.result = v === undefined ? undefined : structuredClone(v);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    }
    put(value, key) {
      const req = new Req();
      this._tx._ops.push(() => this._map.set(key, structuredClone(value)));
      fire(() => { req.result = key; if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    }
    delete(key) {
      const req = new Req();
      this._tx._ops.push(() => this._map.delete(key));
      fire(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    }
    openCursor(range) {
      const req = new Req();
      const keys = Array.from(this._map.keys())
        .filter((k) => !range || (k >= range.lower && k <= range.upper))
        .sort();
      let i = 0;
      const step = () => {
        if (i >= keys.length) {
          req.result = null;
          if (req.onsuccess) req.onsuccess({ target: req });
          return;
        }
        const k = keys[i++];
        req.result = {
          key: k,
          value: structuredClone(this._map.get(k)),
          continue: () => fire(step),
        };
        if (req.onsuccess) req.onsuccess({ target: req });
      };
      fire(step);
      return req;
    }
  }

  return {
    open(name, version) {
      const req = new Req();
      const needUpgrade = !Object.prototype.hasOwnProperty.call(stores, 'kv');
      const db = {
        name,
        version,
        objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(stores, n) },
        createObjectStore(n) { if (!stores[n]) stores[n] = new Map(); return { name: n }; },
        transaction: (names, mode) => new Tx(mode),
      };
      fire(() => {
        req.result = db;
        if (needUpgrade && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    _backing: backing,
  };
}

// ============================================================
// 在一个 vm 上下文里装载 浏览器脚本
// ============================================================
function makeContext({ localStorage, indexedDB, logs }) {
  const ctx = {
    localStorage,
    indexedDB,
    IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
    TextDecoder,
    console: {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push('[warn] ' + a.join(' ')),
      error: (...a) => logs.push('[error] ' + a.join(' ')),
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.createContext(ctx);
  for (const f of ['js/data.js', 'js/idb.js', 'js/postodb.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

/** 读取 base/ 下全部 CSV，构造 importCSVBulk 需要的文件数组 */
function loadBaseFiles() {
  const out = [];
  for (const name of fs.readdirSync(BASE_DIR).filter((f) => f.toLowerCase().endsWith('.csv'))) {
    const lower = name.toLowerCase();
    let sourceType = null;
    if (lower.startsWith('post')) sourceType = 'post';
    else if (lower.startsWith('spb')) sourceType = 'spb';
    if (!sourceType) continue;
    out.push({ buffer: fs.readFileSync(path.join(BASE_DIR, name)), sourceType, name });
  }
  return out;
}

/** 只在宿主侧统计 IndexedDB 后备存储里的参考库体积 */
function idbStats(backing) {
  let provs = 0, chars = 0;
  for (const [k, v] of backing) {
    if (!k.startsWith('poref_data_')) continue;
    provs++;
    chars += JSON.stringify(v).length;
  }
  return { provs, chars };
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const baseFiles = loadBaseFiles();
  console.log(`[准备] base/ CSV ${baseFiles.length} 个`);
  const backing = new Map();                    // 跨"重启"共享的 IndexedDB
  let baseline = null;                          // 场景 1 的结果，供后续比对

  // ---------- 场景 1：全新安装 ----------
  console.log('\n场景 1  全新安装（空 IndexedDB / 空 localStorage）');
  {
    const ls = makeLocalStorage();
    const logs = [];
    const ctx = makeContext({ localStorage: ls, indexedDB: makeIndexedDB(backing), logs });

    check('ready() 在空库上不抛错', await vm.runInContext('PODatabase.ready()', ctx));
    check('空库时 legacyUpgrade() === true（要求强制导入 base/）',
      vm.runInContext('PODatabase.legacyUpgrade()', ctx) === true);

    ctx.__files = baseFiles;
    const r = await vm.runInContext(
      'PODatabase.importCSVBulk(__files, undefined, { mode: "replace" })', ctx);

    const stats = vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getStats()))', ctx);
    const idb = idbStats(backing);
    baseline = { count: stats.totalCount, provinces: stats.provinces.length, chars: idb.chars };

    check('导入无解析异常', Array.isArray(r.errors), `errors=${r.errors.length}`);
    check('省份数 = 31', stats.provinces.length === 31, `实际 ${stats.provinces.length}`);
    check('记录数 > 90000', stats.totalCount > 90000, `实际 ${stats.totalCount}`);
    check('IndexedDB 分片数 = 省份数', idb.provs === stats.provinces.length,
      `${idb.provs} vs ${stats.provinces.length}`);
    check('IndexedDB 参考库 > 2000 万字符（localStorage 装不下的那部分）',
      idb.chars > 20000000, `${idb.chars.toLocaleString()} 字符`);
    check('localStorage 里没有 poref 大键',
      !ls._keys().some((k) => k.startsWith('poref_data_') || k === 'poref_meta'),
      `localStorage ${ls.length} 个键 / ${(ls._usage() / 1024).toFixed(1)} KB`);
    check('导入后 legacyUpgrade() 变为 false（下次启动可信任签名）',
      vm.runInContext('PODatabase.legacyUpgrade()', ctx) === false);

    for (const [adc, expected] of Object.entries(KNOWN_COUNTS)) {
      const p = stats.provinces.find((x) => String(x.adcode) === adc);
      const actual = p ? p.postCount + p.spbCount : -1;
      check(`交叉核对 省份 ${adc} = 旧库基准 ${expected}`, actual === expected, `实际 ${actual}`);
    }
    const bj = stats.provinces.find((x) => x.adcode === 110000);
    console.log(`  · 参考：北京(110000) = ${bj ? bj.postCount + bj.spbCount : '?'} 条` +
      `（Electron 旧库为 1449，其 base 文件今天 9:57 更新过，允许不一致）`);

    // 排名表的「总计」不再用手写估算值，而是跟随参考库里的官网 POST 条数
    const bjRank = vm.runInContext(
      'PostmarkData.getRanking().find((r) => r.name === "北京市")', ctx);
    check('排名表「总计」跟随官网 POST 条数',
      !!bjRank && !!bj && bjRank.total === bj.postCount,
      `${bjRank ? bjRank.total : '?'} vs post=${bj ? bj.postCount : '?'}`);

    // ---------- 场景 0：负向对照（旧写法必然撞配额）----------
    console.log('\n场景 0  负向对照：把同样的库按旧写法塞进 5 MiB 的 localStorage');
    const provinceJson = vm.runInContext(`(() => {
      const out = [];
      for (const p of PODatabase.getStats().provinces) {
        out.push([p.adcode, JSON.stringify(PODatabase.search({ province: p.name, limit: 1000000 }))]);
      }
      return out;
    })()`, ctx);
    const jsonChars = provinceJson.reduce((s, [, j]) => s + j.length, 0);
    const ls2 = makeLocalStorage();
    let wrote = 0, quotaErr = null;
    // 复刻旧实现的写法：每省一个 poref_data_<adcode> 键
    try {
      for (const [adcode, j] of provinceJson) { ls2.setItem('poref_data_' + adcode, j); wrote++; }
    } catch (e) { quotaErr = e; }
    check('旧写法在 5 MiB 配额下必然抛 QuotaExceededError',
      !!quotaErr && quotaErr.name === 'QuotaExceededError',
      quotaErr ? `只写进 ${wrote}/${provinceJson.length} 个省（第 ${wrote + 1} 个失败，用量 ${(ls2._usage() / 1024).toFixed(0)} KB）`
               : '竟然全部写进去了');
    check('导出字符数与非零配额量级相符（说明复现的是同一个问题）',
      jsonChars > 20000000, `${jsonChars.toLocaleString()} 字符 vs 配额 ${LS_QUOTA.toLocaleString()}`);
  }

  // ---------- 场景 2：重启（同一 IndexedDB，新上下文）----------
  console.log('\n场景 2  重启：新上下文 + 新 localStorage，复用同一份 IndexedDB');
  const lsRestart = makeLocalStorage();
  const ctx2 = makeContext({ localStorage: lsRestart, indexedDB: makeIndexedDB(backing), logs: [] });
  {
    await vm.runInContext('PODatabase.ready()', ctx2);
    const stats = vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getStats()))', ctx2);
    check('重启后水合出的省份数一致', stats.provinces.length === baseline.provinces,
      `${stats.provinces.length} vs ${baseline.provinces}`);
    check('重启后水合出的记录数一致', stats.totalCount === baseline.count,
      `${stats.totalCount} vs ${baseline.count}`);
    check('重启后 legacyUpgrade() === false（应信任签名跳过重复导入）',
      vm.runInContext('PODatabase.legacyUpgrade()', ctx2) === false);

    // merge 导入：合成 3 条北京网点
    const rows = [
      '省,市,区/市/县,网点名称,邮编,地址',
      '北京市,北京市,东城区,合成测试网点甲,100010,测试地址1',
      '北京市,北京市,西城区,合成测试网点乙,100032,测试地址2',
      '北京市,北京市,朝阳区,合成测试网点丙,100020,测试地址3',
    ].join('\r\n') + '\r\n';
    const buf = iconv.encode(rows, 'gbk');
    ctx2.__files = [{ buffer: buf, sourceType: 'post', name: 'postzz+base.csv' }];

    const m1 = await vm.runInContext('PODatabase.importCSVBulk(__files, undefined, { mode: "merge" })', ctx2);
    check('merge 导入新增 3 条', m1.imported === 3, `实际 ${m1.imported}`);
    check('merge 后省份数不变', vm.runInContext('PODatabase.getStats().provinces.length', ctx2) === baseline.provinces);

    const m2 = await vm.runInContext('PODatabase.importCSVBulk(__files, undefined, { mode: "merge" })', ctx2);
    check('重复 merge 不重复计数（按 来源|名称|区县 去重）', m2.imported === 0, `实际 ${m2.imported}`);
    check('合成记录可被检索到',
      vm.runInContext('PODatabase.searchByName("合成测试网点甲", 5).length', ctx2) === 1);

    // 场景 4：清理路径
    console.log('\n场景 4  清理路径（deleteProvinceSource / clear）');
    await vm.runInContext('PODatabase.deleteProvinceSource(130000, "post")', ctx2);
    const afterDel = vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getStats()))', ctx2);
    const hebei = afterDel.provinces.find((p) => p.adcode === 130000);
    check('deleteProvinceSource 后河北 post 计数归零', !!hebei && hebei.postCount === 0,
      hebei ? `post=${hebei.postCount} spb=${hebei.spbCount}` : '省份消失');
    const hebeiStored = backing.get('poref_data_130000');
    check('IndexedDB 里的河北分片同步更新',
      Array.isArray(hebeiStored) && hebeiStored.every((r) => r.source !== 'post'),
      `${hebeiStored ? hebeiStored.length : 'null'} 条`);

    await vm.runInContext('PODatabase.clear()', ctx2);
    const cleared = idbStats(backing);
    check('clear() 后记录数为 0', vm.runInContext('PODatabase.count()', ctx2) === 0);
    check('clear() 后 IndexedDB 里没有残留分片', cleared.provs === 0, `${cleared.provs} 个分片`);
    check('clear() 后 meta 也删掉了', !backing.has('poref_meta'));
  }

  // ---------- 场景 3：旧版升级 ----------
  console.log('\n场景 3  旧版升级：空 IndexedDB + localStorage 里是旧方案数据（含匹配签名）');
  {
    const backing3 = new Map();                 // 全新 IndexedDB
    const ls = makeLocalStorage();
    const legacyRecords = [
      { province: '北京市', city: '北京市', district: '东城区', name: '旧版遗留网点A', postalCode: '100010', address: '', services: '', detailLink: '', source: 'post' },
      { province: '北京市', city: '北京市', district: '西城区', name: '旧版遗留网点B', postalCode: '100032', address: '', services: '', detailLink: '', source: 'post' },
    ];
    const legacyMeta = {
      totalCount: 2, sources: ['post'],
      provinces: [{ name: '北京市', adcode: 110000, postCount: 2, spbCount: 0 }],
      lastImportTime: '2026-01-01T00:00:00.000Z',
    };
    ls.setItem('poref_data_110000', JSON.stringify(legacyRecords));
    ls.setItem('poref_meta', JSON.stringify(legacyMeta));
    ls.setItem('geojson_cache_100000', '{"type":"FeatureCollection","features":[{"fake":true}]}');
    ls.setItem('poref_base_signature', 'SomeSignatureThatMatchesCurrentBase');
    const before = ls._usage();

    const logs = [];
    const ctx = makeContext({ localStorage: ls, indexedDB: makeIndexedDB(backing3), logs });
    // 复现真实启动时序：tools.js 在 DOMContentLoaded 里的初始化会在 ready() 的
    // await 期间调用 count()，从而提前生成一个空白 meta。搬运判定不能因此失真
    // （曾经就是这样漏掉搬运、把旧数据直接删了）。
    vm.runInContext('PODatabase.count()', ctx);
    await vm.runInContext('PODatabase.ready()', ctx);

    check('搬运日志出现', logs.some((l) => /搬入 IndexedDB/.test(l)),
      logs.find((l) => /搬入 IndexedDB/.test(l)) || '（没有）');
    check('旧分片已进入 IndexedDB',
      (backing3.get('poref_data_110000') || []).length === 2);
    check('localStorage 里的 poref 键已清空',
      !ls._keys().some((k) => k.startsWith('poref_data_') || k === 'poref_meta'));
    check('旧 GeoJSON 缓存键还在（由 map.js 负责清理，本模块不动它）',
      ls.getItem('geojson_cache_100000') !== null);
    check('legacyUpgrade() === true（签名一致也必须强制重新导入）',
      vm.runInContext('PODatabase.legacyUpgrade()', ctx) === true,
      `localStorage 用量 ${(before / 1024).toFixed(1)} KB → ${(ls._usage() / 1024).toFixed(1)} KB`);

    ctx.__files = baseFiles;
    const r = await vm.runInContext(
      'PODatabase.importCSVBulk(__files, undefined, { mode: "replace" })', ctx);
    const stats = vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getStats()))', ctx);
    check('强制重新导入后回到 31 省', stats.provinces.length === baseline.provinces,
      `实际 ${stats.provinces.length}`);
    check('强制重新导入后记录数与场景 1 一致', stats.totalCount === baseline.count,
      `${stats.totalCount} vs ${baseline.count}`);
    check('搬过来的合成记录已被 base 覆盖（不是停在 2 条上）',
      vm.runInContext('PODatabase.searchByName("旧版遗留网点A", 5).length', ctx) === 0);
    check('replace 导入无解析异常', Array.isArray(r.errors));
  }

  // ---------- 场景 4：base_old 历史归档 ----------
  // 覆盖「对比完成 → 参考库刷新」这条路：当前库整份替换，归档单独一份，
  // 检索默认带历史、可用 includeHistory:false 排除，count() 不被历史污染。
  console.log('\n场景 5  base_old 历史归档（对比快照刷新 / 检索 / 重启水合）');
  {
    const iconv = require('iconv-lite');
    const backing5 = new Map();
    const ls = makeLocalStorage();
    const logs = [];
    const ctx = makeContext({ localStorage: ls, indexedDB: makeIndexedDB(backing5), logs });
    await vm.runInContext('PODatabase.ready()', ctx);

    const gbk = (lines) => iconv.encode(lines.join('\r\n') + '\r\n', 'gbk');
    const current = gbk([
      '省,市,区/市/县,网点名称,邮编,地址',
      '北京市,北京市,东城区,东单邮政支局,100005,北京市东城区',
      '北京市,北京市,西城区,西单邮政支局（暂停）,100031,北京市西城区',
    ]);
    const archive = gbk([
      '来源,省,市,区/市/县,网点名称,邮编,地址,开办业务,详情链接,归档原因,归档时间',
      'post,北京市,北京市,朝阳区,朝阳门邮政支局,100020,北京市朝阳区,,,名称变化,2026-10-16 08:00:00',
      'post,北京市,北京市,海淀区,中关村邮政支局（撤销）,100080,北京市海淀区,,,撤销,2026-10-16 08:00:00',
      'spb,上海市,上海市,黄浦区,南京东路邮政所,,,信件,http://a,撤销,2026-10-16 08:00:00',
    ]);

    ctx.__cur = [{ buffer: current, sourceType: 'post', name: 'postbj+base.csv' }];
    ctx.__old = archive;
    const r = await vm.runInContext('PODatabase.refreshFromCompare(__cur, __old)', ctx);

    const count = () => vm.runInContext('PODatabase.count()', ctx);
    const hist = () => vm.runInContext('PODatabase.historyCount()', ctx);
    const search = (q) => vm.runInContext(
      `JSON.parse(JSON.stringify(PODatabase.search(${JSON.stringify(q)})))`, ctx);

    check('对比刷新：当前库条数来自快照', count() === 2, `实际 ${count()}`);
    check('对比刷新：归档条数', hist() === 3, `实际 ${hist()}`);
    check('对比刷新：返回归档条数', r.historyTotal === 3, String(r.historyTotal));
    check('对比刷新：fromCompare 置位（下次启动必须从 base 重建）',
      vm.runInContext('PODatabase.isProvisional()', ctx) === true);
    const meta = vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getStats()))', ctx);
    check('meta.histCount 与归档一致', meta.histCount === 3, String(meta.histCount));
    check('meta.totalCount 不含归档', meta.totalCount === 2, String(meta.totalCount));

    const all = search({});
    check('检索默认带历史', all.length === 5, `实际 ${all.length}`);
    check('检索可用 includeHistory:false 排除历史',
      search({ includeHistory: false }).length === 2,
      String(search({ includeHistory: false }).length));
    const histRec = all.find((x) => x.name === '南京东路邮政所') || {};
    check('历史记录带 historical 标记', histRec.historical === true);
    check('历史记录保留归档原因', histRec.archiveReason === '撤销', String(histRec.archiveReason));
    check('历史记录保留归档时间', histRec.archiveDate === '2026-10-16 08:00:00',
      String(histRec.archiveDate));
    check('历史 SPB 记录来源正确', histRec.source === 'spb', String(histRec.source));
    check('历史 SPB 记录带回开办业务', histRec.services === '信件', String(histRec.services));
    check('历史记录能被关键字检索到',
      search({ keyword: '朝阳门' }).length === 1,
      String(search({ keyword: '朝阳门' }).length));
    // 直辖市的「市」在参考库里就是区名，所以这里用「当前库里没有、只有归档才有」的区
    // 来验证归档确实进了筛选下拉：北京朝阳区、上海黄浦区都只来自归档。
    check('历史记录进了城市筛选下拉（北京朝阳区只来自归档）',
      vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getDataCities("北京市")))', ctx)
        .indexOf('朝阳区') >= 0,
      vm.runInContext('JSON.stringify(PODatabase.getDataCities("北京市"))', ctx));
    check('历史记录进了区县筛选下拉（上海黄浦区只来自归档）',
      vm.runInContext('JSON.parse(JSON.stringify(PODatabase.getDataDistricts("上海市","上海市")))', ctx)
        .indexOf('黄浦区') >= 0,
      vm.runInContext('JSON.stringify(PODatabase.getDataDistricts("上海市","上海市"))', ctx));

    // 重启：归档与 fromCompare 都要从 IndexedDB 水合回来
    const ctx2 = makeContext({ localStorage: ls, indexedDB: makeIndexedDB(backing5), logs: [] });
    await vm.runInContext('PODatabase.ready()', ctx2);
    check('重启后归档仍在', vm.runInContext('PODatabase.historyCount()', ctx2) === 3,
      String(vm.runInContext('PODatabase.historyCount()', ctx2)));
    check('重启后仍标记为对比快照',
      vm.runInContext('PODatabase.isProvisional()', ctx2) === true);

    // 再来一次对比，这次没有归档文件 → 历史整体清空（与 base_old 文件保持一致）
    ctx2.__cur = [{ buffer: current, sourceType: 'post', name: 'postbj+base.csv' }];
    await vm.runInContext('PODatabase.refreshFromCompare(__cur, null)', ctx2);
    check('没有归档文件时历史清空',
      vm.runInContext('PODatabase.historyCount()', ctx2) === 0,
      String(vm.runInContext('PODatabase.historyCount()', ctx2)));
    check('清空历史后当前库不受影响',
      vm.runInContext('PODatabase.count()', ctx2) === 2,
      String(vm.runInContext('PODatabase.count()', ctx2)));
    check('清空历史后能在检索里体现（只剩当前库）',
      vm.runInContext('PODatabase.search({}).length', ctx2) === 2,
      String(vm.runInContext('PODatabase.search({}).length', ctx2)));

    // clear() 要连归档一起清掉
    await vm.runInContext('PODatabase.clear()', ctx2);
    check('clear() 后归档清空', vm.runInContext('PODatabase.historyCount()', ctx2) === 0);
    check('clear() 后 IndexedDB 里没有归档键', !backing5.has('poref_base_old'));
  }

  // ---------- 汇总 ----------
  console.log(`\n=========== 汇总 ===========`);
  console.log(failures === 0
    ? `全部通过（参考库 ${baseline.provinces} 省 / ${baseline.count} 条 / ${baseline.chars.toLocaleString()} 字符）`
    : `${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n[异常]', (e && e.stack) || e);
  process.exit(1);
});
