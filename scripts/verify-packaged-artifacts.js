#!/usr/bin/env node
/**
 * 打包产物校验
 * =============
 * GUI 窗口在无桌面的自动化环境里会被立刻销毁，应用随之退出，无法通过启动
 * exe 来做端到端冒烟。这里改为直接校验打包引入的两处真实风险：
 *
 *   1. txt_compare.exe 被 asarUnpack 到了 app.asar.unpacked，
 *      且 engine 的 asar → asar.unpacked 路径改写确实指向它、该文件可执行；
 *   2. iconv-lite 被完整打进 app.asar，其 GBK 编码结果与开发版逐字节一致
 *      （打包漏文件时这里会直接失败）。
 *
 * 用法: node scripts/verify-packaged-artifacts.js [releaseDir]
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.resolve(process.argv[2] || path.join(ROOT, 'release'));
const UNPACKED = path.join(RELEASE, 'win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`); }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pm-${tag}-`));
  tmpDirs.push(d);
  return d;
}

async function main() {
  console.log('打包产物校验');
  console.log(`  产物目录: ${RELEASE}`);

  check('win-unpacked 存在', fs.existsSync(UNPACKED), UNPACKED);
  check('app.asar 存在', fs.existsSync(ASAR), ASAR);
  if (!fs.existsSync(ASAR)) { report(); return; }

  const Engine = require(path.join(ROOT, 'crawler-engine.js'));

  // ---- [1] txt_compare.exe ----
  console.log('\n[1] txt_compare.exe 的 asarUnpack 与路径改写');

  const unpackedExe = path.join(UNPACKED, 'resources', 'app.asar.unpacked', 'txt_compare.exe');
  check('exe 已解包到 app.asar.unpacked', fs.existsSync(unpackedExe), unpackedExe);

  // 打包运行时 __dirname 落在 app.asar 内，engine 收到的候选路径就长这样
  const inAsar = path.join(UNPACKED, 'resources', 'app.asar', 'txt_compare.exe');
  Engine.configure({ compareExeCandidates: [inAsar] });
  const resolved = Engine.resolveCompareExe();
  eq('asar 内路径被改写到 app.asar.unpacked', resolved, unpackedExe);
  check('改写后的路径真实存在', !!resolved && fs.existsSync(resolved), String(resolved));

  // 真跑一次：用两个 base CSV 当输入，确认这个 exe 无需 Python 也能执行
  if (resolved && fs.existsSync(resolved)) {
    const f1 = path.join(ROOT, 'base', 'postbj+base.csv');
    const f2 = path.join(ROOT, 'base', 'spbbj+base.csv');
    let out = null;
    let err = null;
    try {
      // detailed 模式会把两份 700+ 行 CSV 的逐条差异全打出来，远超 execFileSync
      // 默认 1MB 的 maxBuffer（ENOBUFS）。engine 用的是 spawn + 手动聚合，无此上限。
      out = execFileSync(resolved, ['--file1', f1, '--file2', f2, '--display', 'detailed'], {
        encoding: 'buffer', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      err = e;
    }
    check('打包的 txt_compare.exe 可独立执行', !err, err && err.message);
    if (out) {
      const text = require(path.join(ROOT, 'node_modules', 'iconv-lite')).decode(out, 'gbk');
      check('对比器输出非空且含中文', text.trim().length > 0 && /[一-龥]/.test(text),
        text.slice(0, 60));
    }
  }

  // ---- [2] iconv-lite ----
  console.log('\n[2] iconv-lite 的打包完整性');

  const extractDir = tmpdir('asar');
  try {
    execFileSync('npx', ['asar', 'extract', ASAR, extractDir], {
      cwd: ROOT, stdio: 'pipe', shell: true, timeout: 300000,
    });
  } catch (e) {
    check('可从 app.asar 解出内容', false, e.message);
    report();
    return;
  }

  const packedIconv = path.join(extractDir, 'node_modules', 'iconv-lite');
  check('app.asar 内含 iconv-lite', fs.existsSync(packedIconv), packedIconv);
  if (fs.existsSync(packedIconv)) {
    // 真实校验：这个副本必须能 require 起来并正确编码 GBK
    const packed = require(packedIconv);
    const dev = require(path.join(ROOT, 'node_modules', 'iconv-lite'));

    const sample = '所属省,所属市,所属县,场所名称\n天津市,天津市,和平区,中国邮政储蓄银行和平区支行\n';
    const a = packed.encode(sample, 'gbk');
    const b = dev.encode(sample, 'gbk');
    check('打包副本的 GBK 编码与开发版逐字节一致', a.equals(b),
      `${a.length} vs ${b.length} 字节`);
    eq('GBK 解码可还原中文',
      packed.decode(a, 'gbk').split('\n')[1], sample.split('\n')[1]);

    // 打包常见的坑：iconv-lite 的编码表以 JSON 形式按需读取，
    // 漏打 tables/ 时 require 不报错、运行到 GBK 才炸。
    const tables = path.join(packedIconv, 'encodings', 'tables');
    check('编码表目录已打包', fs.existsSync(tables), tables);
    check('GBK 码表已打包', fs.existsSync(path.join(tables, 'cp936.json')));
  }

  const packedSafer = path.join(extractDir, 'node_modules', 'safer-buffer');
  check('app.asar 内含 safer-buffer（iconv-lite 的依赖）', fs.existsSync(packedSafer));

  // ---- [3] 其它运行时文件 ----
  console.log('\n[3] 应用自身文件');
  const appFiles = ['main.js', 'crawler-engine.js', 'crawler-match.js', 'crawler-cities.js',
                    'crawler-intelligent.js',
                    'img-export.js',
                    'preload.js', 'index.html', 'css/style.css',
                    'js/crawler.js', 'js/postodb.js', 'js/data.js', 'js/idb.js',
                    'js/image.js', 'js/image-editor.js', 'js/img-naming.js'];
  for (const f of appFiles) {
    check(`已打包 ${f}`, fs.existsSync(path.join(extractDir, f)));
  }
  const baseCsv = fs.readdirSync(path.join(extractDir, 'base')).filter((f) => f.endsWith('.csv'));
  eq('base CSV 数量', baseCsv.length, 62);

  // ---- [4] 打包的是当前源码，而不是上一次构建的残留 ----
  // 只查「文件在不在」会让忘记 rebuild 的旧包一路绿灯，这里比对新功能的标记。
  console.log('\n[4] 打包内容与当前源码一致（防陈旧构建）');
  const readApp = (f) => {
    const p = path.join(extractDir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const packedCrawler = readApp('js/crawler.js');
  const packedHtml = readApp('index.html');
  const packedCss = readApp('css/style.css');

  check('打包的 js/crawler.js 含报告弹窗组件',
    packedCrawler.includes('function openReportModal') &&
    packedCrawler.includes('function buildCrossSpec') &&
    packedCrawler.includes('function buildCompareSpec'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 js/crawler.js 含横向对比明细渲染', packedCrawler.includes('buildProvinceDetail'));
  check('打包的 js/crawler.js 含日志摘要提示',
    packedCrawler.includes('updateLogHint') && packedCrawler.includes('registerLog'));
  check('打包的 index.html 已移除内联汇总块', !packedHtml.includes('cross-summary-wrap'));
  check('打包的 index.html 含「查看上次报告」按钮',
    packedHtml.includes('btn-cross-view-report'));
  check('打包的 css/style.css 含报告弹窗样式',
    packedCss.includes('.report-modal') && packedCss.includes('.rm-cards') &&
    packedCss.includes('.collapse-arrow'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 css/style.css 含嵌套分段样式（智能判别区块层级）',
    packedCss.includes('.rm-sec-body .rm-section'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 css/style.css 含省份下拉框样式',
    packedCss.includes('.rm-selector-bar') && packedCss.includes('.rm-selector-detail'),
    '疑似陈旧构建：请重新 npm run build');

  // 图片功能：三块拼图缺一不可 —— server require 的落盘模块、表单里的图片区、编辑器样式
  check('打包的 server.js 已接入图片落盘模块',
    readApp('server.js').includes("require('./img-export") &&
    readApp('img-export.js').includes('function writeAtomic'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 index.html 含日戳图片区并引入图片模块',
    packedHtml.includes('f-photo-add') &&
    packedHtml.includes('js/image.js') &&
    packedHtml.includes('js/image-editor.js') &&
    packedHtml.includes('js/img-naming.js'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 css/style.css 含图片编辑器样式',
    packedCss.includes('.ie-crop-box') && packedCss.includes('.photo-thumb'),
    '疑似陈旧构建：请重新 npm run build');

  // 引擎侧：details 字段是弹窗的数据来源
  check('打包的 crawler-engine.js 含 buildCrossDetails',
    readApp('crawler-engine.js').includes('function buildCrossDetails'));

  // 智能判别：引擎 require 这个模块，漏打会在运行时才炸（且只在跑对比时）
  const packedIntel = readApp('crawler-intelligent.js');
  check('打包的 crawler-intelligent.js 含智能判别入口',
    packedIntel.includes('function intelligentCompare') &&
    packedIntel.includes('function matchSameSource') &&
    packedIntel.includes('function classifyChanges'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 crawler-intelligent.js 含连续变化区块与报告生成',
    packedIntel.includes('function detectConsecutiveBlocks') &&
    packedIntel.includes('function generateIntelligentReport'));
  check('打包的 crawler-engine.js 已接入智能判别',
    readApp('crawler-engine.js').includes("require('./crawler-intelligent") &&
    readApp('crawler-engine.js').includes('intelligentReportPath'));
  check('打包的 js/crawler.js 含智能判别渲染',
    packedCrawler.includes('makeSelector') &&
    packedCrawler.includes('buildIntelligentDetail') &&
    packedCrawler.includes('INTELLIGENT_VIEWS'));
  check('打包的 js/crawler.js 含省份下拉框与汇总表入口',
    packedCrawler.includes('buildCompareProvinceDetail') &&
    packedCrawler.includes('function buildCompareFileDetail') &&
    packedCrawler.includes('__summary__'),
    '疑似陈旧构建：请重新 npm run build');

  // PO 参考库改存 IndexedDB：漏打 js/idb.js 或漏改 index.html 的 script 顺序，
  // postodb 会在运行时才炸（IdbKV is not defined），因此这里一并核对
  const packedIdb = readApp('js/idb.js');
  const packedPoref = readApp('js/postodb.js');
  check('打包的 js/idb.js 含 IdbKV 实现',
    packedIdb.includes('const IdbKV') && packedIdb.includes('function write'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 index.html 已在 postodb.js 之前引入 js/idb.js',
    packedHtml.indexOf('js/idb.js') > 0 &&
    packedHtml.indexOf('js/idb.js') < packedHtml.indexOf('js/postodb.js'),
    '疑似陈旧构建：请重新 npm run build');
  check('打包的 js/postodb.js 已改用 IndexedDB',
    packedPoref.includes('IdbKV') && packedPoref.includes('legacyUpgrade') &&
    !/localStorage\.setItem\(DATA_PREFIX/.test(packedPoref),
    '疑似陈旧构建：请重新 npm run build');

  report();
}

function report() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('校验异常:', e);
  process.exit(1);
});
