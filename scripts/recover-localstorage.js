#!/usr/bin/env node
/**
 * Local Storage 数据恢复 / 备份（不依赖 Electron / 浏览器）
 * ========================================================
 * 收藏记录与 PO 参考库都存在 Chromium 的 Local Storage 里，落地为
 * `<profile>/Local Storage/leveldb` 下的 leveldb 文件。
 * 当应用因为 profile 不可写、端口变化（origin 变了）等原因显示为空，
 * 或需要给某个 profile 做一份离线备份时，用本脚本直接把数据读出来。
 *
 *   node scripts/recover-localstorage.js [leveldb目录] [输出目录]
 *
 * 默认:
 *   leveldb目录 = %APPDATA%\postmark-system\Local Storage\leveldb
 *   输出目录    = _recovery/
 *
 * 说明:
 *   - 只读 leveldb，不会修改原数据；
 *   - 同一个键会存在多份写入版本（键尾带序号），脚本取序号最大的那份；
 *   - 导出的 postmark-records.json 可用应用内「导入 JSON」还原；
 *   - leveldb 的解析实现已抽到 scripts/lib/localstorage.js，与迁移脚本共用。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LS = require('./lib/localstorage');

const DEFAULT_LS = path.join(os.homedir(), 'AppData', 'Roaming', 'postmark-system', 'Local Storage', 'leveldb');

// ============================================================
// 主流程
// ============================================================
function main() {
  const lsDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LS;
  const outDir = path.resolve(process.argv[3] || path.join(__dirname, '..', '_recovery'));
  if (!fs.existsSync(lsDir)) {
    console.error(`找不到 leveldb 目录: ${lsDir}`);
    process.exit(1);
  }
  console.log(`读取: ${lsDir}`);

  const { store } = LS.readLocalStorageDir(lsDir);
  console.log(`去重后共 ${store.size} 条键值（.log 中的最新写入不在此列，通常已落在 .ldb 中）`);

  // 各 origin 上的收藏记录版本（端口变化会产生新 origin，数据看起来就"不见了"）
  const recs = LS.listEntries(store, 'postmark_records').map((x) => {
    let n = '?';
    try { n = JSON.parse(x.value).length; } catch (e) { /* ignore */ }
    return { ...x, n };
  });
  console.log('\n各 origin 上的 postmark_records:');
  for (const r of recs) console.log(`  ${r.origin.padEnd(26)} 序号=${String(r.seq).padStart(4)}  ${r.n} 条`);

  const best = recs.filter((r) => /:19876$/.test(r.origin)).sort((a, b) => b.seq - a.seq)[0]
    || recs.sort((a, b) => b.seq - a.seq)[0];
  if (!best) { console.error('\n未找到 postmark_records，可能不是本应用的 profile。'); process.exit(1); }

  const records = JSON.parse(best.value);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'postmark-records.json'), JSON.stringify(records, null, 2), 'utf8');
  console.log(`\n收藏记录: ${records.length} 条  (${best.origin} 序号 ${best.seq})`);
  const byProvince = {};
  for (const r of records) byProvince[r.province] = (byProvince[r.province] || 0) + 1;
  console.log('按省分布(前 8): ' + Object.entries(byProvince).sort((a, b) => b[1] - a[1])
    .slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' / '));
  console.log(`已导出: ${path.relative(process.cwd(), path.join(outDir, 'postmark-records.json'))}`);

  // PO 参考库（当前 origin 下每个省的元数据与分表各取最新一份）
  const meta = LS.latestEntry(store, 'poref_meta', best.origin);
  if (meta) {
    fs.writeFileSync(path.join(outDir, 'poref-meta.json'), meta.value, 'utf8');
    console.log('已导出: poref-meta.json');
  }
  // 每个省的元数据与分表各取最新一份。分表的键名是 poref_data_<adcode>，
  // 需要先扫一遍键名收集出现过的 adcode，再逐个取该 origin 上的最新版本。
  const provs = [...new Set(
    [...store.keys()]
      .map((k) => LS.parseKey(k))
      .filter((x) => /^poref_data_\d+$/.test(x.name) && x.origin === best.origin)
      .map((x) => x.name)
  )].sort();
  for (const name of provs) {
    const hit = LS.latestEntry(store, name, best.origin);
    if (hit) fs.writeFileSync(path.join(outDir, name + '.json'), hit.value, 'utf8');
  }
  console.log(`已导出: poref_data_*.json (${provs.length} 个省份分表)`);
}

main();
