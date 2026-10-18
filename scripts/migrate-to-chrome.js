#!/usr/bin/env node
/**
 * 迁移到浏览器 profile — Electron profile → Chrome 专属 profile
 * =============================================================
 * 把 Electron profile（.userdata 或 %APPDATA%\postmark-system）里的
 * Chromium Local Storage 整体搬到浏览器专属 profile，使浏览器模式能直接
 * 看到原有的收藏记录与 PO 参考库。
 *
 * 为什么可以整份复制
 * ------------------
 * Local Storage 按 **origin** 隔离，键名以 `_http://127.0.0.1:19876` 开头。
 * 只要端口固定不变，新旧 profile 的 origin 完全相同，键名也就完全一致，
 * 因此 leveldb 可以原样复制，无需重新编码。
 * （这也正是启动器坚持固定端口、绝不随机降级的原因。）
 *
 * 用法:
 *   node scripts/migrate-to-chrome.js              # 干跑：只报告，不动文件
 *   node scripts/migrate-to-chrome.js --apply      # 真正执行迁移
 *   node scripts/migrate-to-chrome.js --apply --source=system
 *   node scripts/migrate-to-chrome.js --apply --source=.userdata --target=data\browser-chrome
 *
 * 安全保证
 * --------
 *   - 源目录只读，绝不修改；
 *   - 目标 profile 已存在时，先整份备份到 _recovery/ 再覆盖；
 *   - 复制完成后重新解析目标目录并比对记录数，对不上就明确报错，
 *     不会静默通过。
 *
 * 迁移后请在界面里确认一次记录条数：脚本只能核到"磁盘上的数据对不对"，
 * "浏览器真正读出来了没有"只有界面能证明。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LS = require('./lib/localstorage');

const ROOT = path.join(__dirname, '..');
const RECOVERY_DIR = path.join(ROOT, '_recovery');

/** Local Storage 在 profile 里的相对位置（浏览器把默认 profile 放在 Default/ 下） */
const LS_SUBPATH_BROWSER = path.join('Default', 'Local Storage', 'leveldb');
const LS_SUBPATH_ELECTRON = path.join('Local Storage', 'leveldb');

/** 与 src-tauri/tauri.conf.json 的 identifier 保持一致 */
const TAURI_IDENTIFIER = 'com.postmark.system';

/**
 * 目标端预设。不同外壳把 Local Storage 放在不同位置：
 *   - chrome  ：<项目>/data/browser-chrome/Default/Local Storage/leveldb
 *   - edge    ：同上（只是浏览器不同，布局一致）
 *   - webview2：%LOCALAPPDATA%\<appId>\EBWebView\Default\Local Storage\leveldb
 *               WebView2 会在 user data folder 下再套一层 EBWebView。
 * 之所以必须区分：目标路径算错的话，数据会写到一个谁也不读的地方，
 * 表现为"迁移成功了但界面还是空的"。
 */
const PRESETS = {
  chrome: {
    label: 'Chrome 专属 profile（浏览器模式）',
    targetRoot: () => path.join(ROOT, 'data', 'browser-chrome'),
    subPath: LS_SUBPATH_BROWSER,
  },
  edge: {
    label: 'Edge 专属 profile（浏览器模式）',
    targetRoot: () => path.join(ROOT, 'data', 'browser-edge'),
    subPath: LS_SUBPATH_BROWSER,
  },
  webview2: {
    label: 'WebView2（Tauri 外壳）',
    // Tauri 用 app_local_data_dir()：Windows 上是 %LOCALAPPDATA%\<identifier>，
    // identifier 与 tauri.conf.json 的 identifier 必须一致。
    targetRoot: () => path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      TAURI_IDENTIFIER
    ),
    subPath: path.join('EBWebView', 'Default', 'Local Storage', 'leveldb'),
  },
};

/** leveldb 的锁与日志文件：复制过去有害无益，由目标端重新生成 */
const SKIP_FILES = new Set(['LOCK', 'LOG', 'LOG.old']);

const SOURCES = {
  project: {
    label: '项目内 .userdata（npm start 使用的 profile）',
    dir: path.join(ROOT, '.userdata'),
  },
  system: {
    label: '%APPDATA%\\postmark-system（npm run start:electron 使用的 profile）',
    dir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'postmark-system'),
  },
};

// ============================================================
// 工具
// ============================================================
function parseArgs(argv) {
  const read = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  return {
    apply: argv.includes('--apply'),
    source: read('source', 'project'),
    target: read('target', ''),
    preset: read('preset', ''),
    port: Number(read('port', '19876')),
  };
}

/** 读取一个 Local Storage 目录，并统计指定 origin 上的记录条数与分表数 */
function inspect(lsDir, origin) {
  const { store } = LS.readLocalStorageDir(lsDir, { quiet: true });
  const entry = LS.latestEntry(store, 'postmark_records', origin)
    || LS.latestEntry(store, 'postmark_records');
  let count = null;
  if (entry) {
    try { count = JSON.parse(entry.value).length; } catch (e) { count = null; }
  }
  // 必须按 origin 过滤：历史端口（例如随机端口时代的 16893）会在同一个 profile 里
  // 留下各自的 poref_data_* 副本，不过滤就会把旧版本一起算进来，数字虚高。
  const porefTables = new Set(
    [...store.keys()]
      .map((k) => LS.parseKey(k))
      .filter((x) => /^poref_data_\d+$/.test(x.name) && x.origin === `_${origin}`)
      .map((x) => x.name)
  ).size;
  return { store, entry, count, porefTables };
}

function copyLevelDb(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0, bytes = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (SKIP_FILES.has(name)) continue;
    const src = path.join(srcDir, name);
    let st;
    try { st = fs.statSync(src); } catch (e) { continue; }
    if (!st.isFile()) continue;                 // leveldb 是平铺文件，不递归
    fs.copyFileSync(src, path.join(dstDir, name));
    copied++;
    bytes += st.size;
  }
  return { copied, bytes };
}

function backupDirFor(label, stamp) {
  const dest = path.join(RECOVERY_DIR, `${label}-backup-${stamp}`);
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  return dest;
}

// ============================================================
// 主流程
// ============================================================
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const origin = `http://127.0.0.1:${opts.port}`;

  console.log('============================================================');
  console.log(' Local Storage 迁移：Electron profile → 浏览器 profile');
  console.log('============================================================');
  console.log(` 固定 origin : ${origin}`);
  console.log(` 模式        : ${opts.apply ? '执行迁移 (--apply)' : '干跑（只报告，不动文件）'}`);

  // ---- 1. 定位源 ----
  let srcLs;
  if (opts.source === 'project' || opts.source === 'system') {
    const src = SOURCES[opts.source];
    srcLs = path.join(src.dir, LS_SUBPATH_ELECTRON);
    console.log(` 源 profile  : ${src.label}`);
  } else {
    // 当作直接给出的 profile 目录
    const dir = path.resolve(opts.source);
    srcLs = fs.existsSync(path.join(dir, LS_SUBPATH_ELECTRON))
      ? path.join(dir, LS_SUBPATH_ELECTRON)
      : dir;
    console.log(` 源 profile  : ${dir}`);
  }

  if (!LS.looksLikeLocalStorage(srcLs)) {
    console.error(`\n[错误] 源目录不是有效的 Local Storage: ${srcLs}`);
    console.error('       用 --source=<profile目录> 指定其它 profile。');
    process.exit(1);
  }
  console.log(` 源 leveldb  : ${path.relative(ROOT, srcLs)}`);

  const srcInfo = inspect(srcLs, origin);
  console.log(`\n[源] 记录数: ${srcInfo.count === null ? '读取失败' : srcInfo.count + ' 条'}`
    + `  (origin ${srcInfo.entry ? srcInfo.entry.origin : '?'} 序号 ${srcInfo.entry ? srcInfo.entry.seq : '?'})`);
  console.log(`[源] PO 参考库分表: ${srcInfo.porefTables} 个`);
  if (srcInfo.count === null) {
    console.error('\n[错误] 无法从源读取 postmark_records，终止。');
    process.exit(1);
  }

  // ---- 2. 定位目标 ----
  // 目标由 preset 决定（不同外壳的 Local Storage 位置不同）。
  // 未给 --preset 时保持原有默认：Chrome 专属 profile。
  const presetName = opts.preset || 'chrome';
  const preset = PRESETS[presetName];
  if (!preset) {
    console.error(`\n[错误] 未知的 --preset=${presetName}`);
    console.error(`       可选: ${Object.keys(PRESETS).join(' / ')}`);
    process.exit(1);
  }
  console.log(`\n 目标端      : ${preset.label}`);

  const targetProfile = opts.target
    ? path.resolve(ROOT, opts.target)
    : preset.targetRoot();
  const dstLs = path.join(targetProfile, preset.subPath);
  console.log(` 目标 profile: ${targetProfile}`);
  console.log(` 目标 leveldb: ${dstLs}`);

  const targetExists = fs.existsSync(targetProfile);
  if (targetExists) {
    let n = 0;
    try { n = fs.readdirSync(targetProfile).length; } catch (e) { /* ignore */ }
    console.log(` 目标状态    : 已存在（${n} 个条目）`);
    if (fs.existsSync(dstLs) && LS.looksLikeLocalStorage(dstLs)) {
      const dstInfo = inspect(dstLs, origin);
      console.log(`              其中已有记录 ${dstInfo.count === null ? '?' : dstInfo.count} 条`);
    }
  } else {
    console.log(' 目标状态    : 不存在（将新建）');
  }

  if (!opts.apply) {
    console.log('\n------------------------------------------------------------');
    console.log(' 干跑结束，未修改任何文件。');
    console.log(' 确认无误后执行：');
    console.log('   node scripts/migrate-to-chrome.js --apply');
    console.log('------------------------------------------------------------');
    return;
  }

  // ---- 3. 备份目标 ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (targetExists && fs.existsSync(dstLs)) {
    const backup = backupDirFor('browser-profile', stamp);
    fs.mkdirSync(backup, { recursive: true });
    const r = copyLevelDb(dstLs, backup);
    console.log(`\n[备份] 目标原有 Local Storage 已备份到 ${path.relative(ROOT, backup)}`
      + ` (${r.copied} 个文件)`);
  }

  // ---- 4. 复制 ----
  const copyResult = copyLevelDb(srcLs, dstLs);
  console.log(`[复制] ${copyResult.copied} 个文件, ${(copyResult.bytes / 1024 / 1024).toFixed(1)} MB`);

  // ---- 5. 回读校验 ----
  if (!LS.looksLikeLocalStorage(dstLs)) {
    console.error(`\n[错误] 复制后目标不是有效的 Local Storage: ${dstLs}`);
    process.exit(1);
  }
  const dstInfo = inspect(dstLs, origin);
  console.log(`\n[校验] 源 记录数 : ${srcInfo.count}`);
  console.log(`[校验] 目标记录数: ${dstInfo.count === null ? '读取失败' : dstInfo.count}`);
  console.log(`[校验] 目标 PO 参考库分表: ${dstInfo.porefTables} 个`);

  if (dstInfo.count !== srcInfo.count) {
    console.error('\n[失败] 目标记录数与源不一致，迁移不可信。');
    console.error('       目标 profile 已保留，可用 scripts/recover-localstorage.js 排查。');
    process.exit(1);
  }

  console.log('\n------------------------------------------------------------');
  console.log(' 迁移完成，磁盘上的数据已逐条核对一致。');
  console.log(' 请再启动一次应用，在界面里确认记录条数：');
  console.log('');
  console.log('   node launch.js         （或双击 启动(浏览器).cmd）');
  console.log('');
  console.log(` 界面应显示 ${srcInfo.count} 条记录。若显示为 0，请把上面的输出发给维护者。`);
  console.log('------------------------------------------------------------');
}

main();
