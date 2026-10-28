#!/usr/bin/env node
/**
 * 邮管局（SPB）省份并发 — 离线测试
 * =================================
 * 用桩件替换 global.fetch 模拟邮管局 / 邮政官网，不联网即可验证：
 *   - spbConcurrency 的归一化（默认 2、范围 1~4、1 = 串行）
 *   - 省份任务的最大并发数确实受 worker pool 限制
 *   - 省内分页仍然串行（同一省份同时只有一个请求）
 *   - 结果 / 文件按输入顺序输出，与完成顺序无关
 *   - 未知省份跳过、重复省份去重，进度按实际进入队列的省份计数
 *   - 混合模式（POST + SPB）下 POST 仍严格串行，只有 SPB 并发
 *   - 取消作业：不再分配新省份、在途请求被中断、不误报完成、不遗留后台任务
 *   - CSV 仍是 GBK / 原有表头与字段顺序
 *
 * 用法:
 *   node scripts/test-crawler-concurrency.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'crawler-engine.js'));

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`);
  }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

// ============================================================
// 模拟网络
// ============================================================

const SPB_RE = /zwfw\.spb\.gov\.cn\/sj\/(\d{6})\/pfyycsml\?currentPage=(\d+)/;
const POST_API_RE = /iframe\.chinapost\.com\.cn\/api\/institutional/;
const POST_IFRAME_RE = /SiteSearchJTApi\.jsp/;

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('This operation was aborted', 'AbortError');
  }
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** 可被 AbortSignal 打断的延时；被打断时 reject AbortError */
function waitAbortable(ms, signal, onAbort) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      if (onAbort) onAbort();
      return reject(abortError());
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    function handleAbort() {
      clearTimeout(timer);
      if (onAbort) onAbort();
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', handleAbort, { once: true });
  });
}

/** 生成一页邮管局表格（rows 条数据行） */
function spbPageHtml(code, rows) {
  const trs = [];
  for (let i = 0; i < rows; i++) {
    const link = `/sj/${code}/pfyycsml/detail?id=${i}`;
    trs.push(
      '<tr>' +
      `<td><a href="${link}">测试省</a></td>` +
      `<td><a href="${link}">测试市</a></td>` +
      `<td><a href="${link}">测试县${i}</a></td>` +
      `<td><a href="${link}">测试支局${code}-${i}</a></td>` +
      `<td><a href="${link}">信件</a></td>` +
      '</tr>'
    );
  }
  return '<table><tr><th>所属省</th><th>所属市</th><th>所属县</th><th>场所名称</th><th>开办业务</th></tr>' +
    trs.join('') + '</table>';
}

/**
 * 安装 fetch 桩件。
 * @param {object} [options]
 * @param {number} [options.spbDelay=10]      每个 SPB 请求的耗时
 * @param {number} [options.postDelay=10]     每个 POST 请求的耗时
 * @param {number} [options.spbRows=1]        第 1 页的数据行数（第 2 页起为空页）
 * @param {object} [options.perAreaDelay]     按行政区划代码覆盖延迟 { '110000': 120 }
 */
function installMockFetch(options = {}) {
  const opts = Object.assign({ spbDelay: 10, postDelay: 10, spbRows: 1, perAreaDelay: {} }, options);
  const originalFetch = global.fetch;

  const state = {
    spbRequests: 0,
    postRequests: 0,
    inflightSpb: 0,
    inflightPost: 0,
    active: 0,
    maxInflightSpb: 0,
    maxInflightPost: 0,
    /** 每个省份第 1 页请求的开始时间（用于验证取消后不再开新省份） */
    provinceStarts: [],
    aborted: 0,
  };

  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const signal = init.signal;
    const isSpb = u.includes('zwfw.spb.gov.cn');
    const isPost = u.includes('iframe.chinapost.com.cn');
    if (!isSpb && !isPost) throw new Error('模拟网络：未知 URL ' + u);
    if (signal && signal.aborted) {
      state.aborted++;
      throw abortError();
    }

    state.active++;
    if (isSpb) {
      state.spbRequests++;
      state.inflightSpb++;
      state.maxInflightSpb = Math.max(state.maxInflightSpb, state.inflightSpb);
    } else {
      state.postRequests++;
      state.inflightPost++;
      state.maxInflightPost = Math.max(state.maxInflightPost, state.inflightPost);
    }

    const onAbort = () => { state.aborted++; };

    try {
      if (isSpb) {
        const m = SPB_RE.exec(u);
        if (!m) throw new Error('模拟网络：无法解析 SPB URL ' + u);
        const code = m[1];
        const page = Number(m[2]);
        if (page === 1) state.provinceStarts.push({ code, at: Date.now() });

        await waitAbortable(opts.perAreaDelay[code] || opts.spbDelay, signal, onAbort);
        // 第 1 页有数据，第 2 页起只剩表头（等价于「无数据」），
        // 引擎会在连续 3 页无数据后结束该省。
        const html = page === 1
          ? spbPageHtml(code, opts.spbRows)
          : '<table><tr><th>所属省</th></tr></table>';
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (POST_IFRAME_RE.test(u)) {
        await waitAbortable(opts.postDelay, signal, onAbort);
        return new Response('ok', { status: 200 });
      }
      if (POST_API_RE.test(u)) {
        await waitAbortable(opts.postDelay, signal, onAbort);
        const body = JSON.stringify({
          success: true,
          total: 1,
          list: [{
            sitename: '测试邮局',
            sitenameSuffix: '',
            zipcode: '100000',
            county: '东城区',
            address: '北京市东城区',
            province: '北京市',
          }],
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('模拟网络：无法解析 POST URL ' + u);
    } finally {
      state.active--;
      if (isSpb) state.inflightSpb--;
      else state.inflightPost--;
    }
  };

  state.restore = () => { global.fetch = originalFetch; };
  return state;
}

// ============================================================
// 场景工具
// ============================================================

let scenarioSeq = 0;

/** 在独立输出目录里跑一次抓取作业，返回作业、网络统计与耗时 */
async function runCrawl(tmpDir, opts, fetchOptions) {
  const outDir = path.join(tmpDir, 'out-' + (++scenarioSeq));
  fs.mkdirSync(outDir, { recursive: true });
  Engine.configure({ outputDir: outDir });

  const net = installMockFetch(fetchOptions);
  const startedAt = Date.now();
  const job = Engine.startCrawl(opts);
  await job.done;
  const elapsed = Date.now() - startedAt;
  net.restore();

  return { job, net, elapsed, outDir };
}

function namesOf(results) {
  return results.map(r => r.province).join(',');
}

// ============================================================
// 1. 并发参数归一化
// ============================================================
function testNormalize() {
  console.log('\n[1] spbConcurrency 参数校验');

  eq('未提供 → 默认 2', Engine.normalizeSpbConcurrency(undefined), 2);
  eq('null → 默认 2', Engine.normalizeSpbConcurrency(null), 2);
  eq('空串 → 默认 2', Engine.normalizeSpbConcurrency(''), 2);
  eq('非数字 → 默认 2', Engine.normalizeSpbConcurrency('abc'), 2);
  eq('字符串数字 → 3', Engine.normalizeSpbConcurrency('3'), 3);
  eq('小数向下取整 → 2', Engine.normalizeSpbConcurrency(2.7), 2);
  eq('0 → 夹到 1（串行）', Engine.normalizeSpbConcurrency(0), 1);
  eq('负数 → 夹到 1（串行）', Engine.normalizeSpbConcurrency(-3), 1);
  eq('超过上限 → 4', Engine.normalizeSpbConcurrency(9), 4);
  eq('上限常量', Engine.SPB_CONCURRENCY_MAX, 4);
  eq('默认常量', Engine.SPB_CONCURRENCY_DEFAULT, 2);
}

// ============================================================
// 2. 默认并发（不传参数）
// ============================================================
async function testDefaultConcurrency(tmpDir) {
  console.log('\n[2] 默认并发数（旧调用方不传 spbConcurrency）');

  const { job, net } = await runCrawl(tmpDir, {
    provinces: ['北京', '上海'],
    doPost: false,
    doSpb: true,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 15 });

  eq('作业状态', job.state, 'done');
  eq('实际生效并发数（结果）', job.result.spbConcurrency, 2);
  eq('最大并发 SPB 请求数', net.maxInflightSpb, 2);
  eq('进度最终值', JSON.stringify(job.progress), JSON.stringify({ done: 2, total: 2, label: '上海' }));
  check('日志打印实际生效并发数',
    job.lines.some(l => /实际生效并发数: 2/.test(l)),
    job.lines.filter(l => l.includes('并发')).join(' | '));
}

// ============================================================
// 3. 并发 2：最大并发、省内串行、结果顺序
// ============================================================
async function testConcurrencyTwo(tmpDir) {
  console.log('\n[3] 并发 2 — 最大并发、省内分页串行、结果顺序');

  const provinces = ['北京', '上海', '广东'];
  const { job, net, outDir } = await runCrawl(tmpDir, {
    provinces,
    doPost: false,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 10 });

  eq('作业状态', job.state, 'done');
  eq('最大并发 SPB 请求数（= 省份并发）', net.maxInflightSpb, 2);
  eq('省份任务总数', job.result.provinceCount, 3);
  eq('有数据省份数', job.result.okCount, 3);
  eq('SPB 总条数', job.result.totalSpb, 3);
  eq('结果顺序 = 输入顺序', namesOf(job.result.results), provinces.join(','));
  eq('每省记录数', job.result.results.map(r => r.spbCount).join(','), '1,1,1');
  eq('进度最终值', JSON.stringify(job.progress), JSON.stringify({ done: 3, total: 3, label: '广东' }));

  // 每省 4 次请求：第 1 页有数据 + 第 2/3/4 页无数据（连续 3 页结束）
  eq('每省请求数（分页串行）', net.spbRequests, provinces.length * 4);

  // 文件按输入顺序返回
  eq('文件顺序 = 输入顺序',
    job.result.files.map(f => path.basename(f)).map(n => Engine.getFilePrefix(n)).join(','),
    'spbbj,spbsh,spbgd');
  check('文件都落在 output 目录',
    job.result.files.every(f => path.dirname(f) === outDir),
    job.result.files.join(' | '));

  // CSV 兼容性：GBK + 原表头 + 原字段顺序
  const bjFile = job.result.files[0];
  const rawHeader = iconv.decode(fs.readFileSync(bjFile), 'gbk').split('\r\n')[0];
  eq('CSV 表头', rawHeader, Engine.SPB_FIELDS.join(','));
  const recs = Engine.readSpbCsv(bjFile);
  eq('CSV 记录数', recs.length, 1);
  eq('CSV 省字段', recs[0].province, '测试省');
  eq('CSV 场所名称', recs[0].name, '测试支局110000-0');
  eq('CSV 开办业务', recs[0].services, '信件');
  check('CSV 详情链接已补全',
    recs[0].detail_link === 'https://zwfw.spb.gov.cn/sj/110000/pfyycsml/detail?id=0',
    recs[0].detail_link);

  check('并发日志带省份标识',
    job.lines.some(l => l.includes('[北京/bj]') && l.includes('共获取')),
    job.lines.filter(l => l.includes('共获取')).slice(0, 3).join(' | '));
}

// ============================================================
// 4. 并发 1：退化为串行，作为对照基线
// ============================================================
async function testConcurrencyOne(tmpDir) {
  console.log('\n[4] 并发 1 — 退化为串行（对照基线）');

  const provinces = ['北京', '上海', '广东'];
  const { job, net, elapsed, outDir } = await runCrawl(tmpDir, {
    provinces,
    doPost: false,
    doSpb: true,
    spbConcurrency: 1,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 10 });

  eq('作业状态', job.state, 'done');
  eq('最大并发 SPB 请求数', net.maxInflightSpb, 1);
  eq('实际生效并发数（结果）', job.result.spbConcurrency, 1);
  eq('结果顺序 = 输入顺序', namesOf(job.result.results), provinces.join(','));
  eq('进度最终值', JSON.stringify(job.progress), JSON.stringify({ done: 3, total: 3, label: '广东' }));

  return { elapsed, outDir, job };
}

// ============================================================
// 5. 完成顺序 ≠ 输入顺序时，结果仍按输入顺序
// ============================================================
async function testResultOrdering(tmpDir) {
  console.log('\n[5] 完成顺序与输入顺序不同');

  const { job, net } = await runCrawl(tmpDir, {
    provinces: ['北京', '上海'],
    doPost: false,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  }, {
    // 北京很慢、上海很快：上海先完成
    perAreaDelay: { 110000: 120, 310000: 5 },
  });

  eq('作业状态', job.state, 'done');
  eq('最大并发 SPB 请求数', net.maxInflightSpb, 2);
  eq('结果顺序仍是输入顺序', namesOf(job.result.results), '北京,上海');
  eq('文件顺序仍是输入顺序',
    job.result.files.map(f => Engine.getFilePrefix(path.basename(f))).join(','), 'spbbj,spbsh');
  eq('完成计数', job.progress.done, 2);
}

// ============================================================
// 6. 混合模式：POST 串行 + SPB 并发
// ============================================================
async function testMixedSources(tmpDir) {
  console.log('\n[6] POST + SPB 混合模式 — POST 串行，仅 SPB 并发');

  const provinces = ['北京', '上海', '广东', '江苏'];
  const { job, net } = await runCrawl(tmpDir, {
    provinces,
    doPost: true,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 15, postDelay: 8 });

  eq('作业状态', job.state, 'done');
  eq('POST 最大并发（必须串行）', net.maxInflightPost, 1);
  eq('SPB 最大并发', net.maxInflightSpb, 2);
  eq('POST 每省 2 次请求（iframe + 第 1 页）', net.postRequests, provinces.length * 2);
  eq('SPB 每省 4 次请求', net.spbRequests, provinces.length * 4);
  eq('POST 总条数', job.result.totalPost, provinces.length);
  eq('SPB 总条数', job.result.totalSpb, provinces.length);
  eq('结果顺序 = 输入顺序', namesOf(job.result.results), provinces.join(','));
  eq('每省两种来源都有数据',
    job.result.results.map(r => `${r.postCount}/${r.spbCount}`).join(','),
    provinces.map(() => '1/1').join(','));
  eq('文件数（每省 2 个）', job.result.files.length, provinces.length * 2);
  eq('进度最终值', JSON.stringify(job.progress),
    JSON.stringify({ done: 4, total: 4, label: '江苏' }));
  check('日志区分两个阶段',
    job.lines.some(l => l.includes('[阶段 1/2]')) && job.lines.some(l => l.includes('[阶段 2/2]')),
    job.lines.filter(l => l.includes('阶段')).join(' | '));
}

// ============================================================
// 7. 未知省份 / 重复省份 / 进度分母
// ============================================================
async function testProvinceValidation(tmpDir) {
  console.log('\n[7] 未知省份跳过、重复省份去重');

  const { job, net } = await runCrawl(tmpDir, {
    provinces: ['北京', '北京', '火星', '上海'],
    doPost: false,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 10 });

  eq('作业状态', job.state, 'done');
  eq('实际进入队列的省份数', job.result.provinceCount, 2);
  eq('结果不含重复/未知省份', namesOf(job.result.results), '北京,上海');
  eq('每省只跑一次', net.provinceStarts.map(s => s.code).sort().join(','), '110000,310000');
  eq('进度分母 = 去重后省份数', job.progress.total, 2);
  eq('进度完成数', job.progress.done, 2);
  eq('SPB 总条数', job.result.totalSpb, 2);
  check('记录了未知省份跳过',
    job.lines.some(l => l.includes('[跳过] 未知省份: 火星')),
    job.lines.filter(l => l.includes('跳过')).join(' | '));
  check('记录了重复省份跳过',
    job.lines.some(l => l.includes('[跳过] 重复省份: 北京')),
    job.lines.filter(l => l.includes('跳过')).join(' | '));
}

// ============================================================
// 8. 取消作业
// ============================================================
async function testCancel(tmpDir) {
  console.log('\n[8] 取消作业 — 不再分配省份、在途请求中断、不误报完成');

  const outDir = path.join(tmpDir, 'out-cancel');
  fs.mkdirSync(outDir, { recursive: true });
  Engine.configure({ outputDir: outDir });

  const net = installMockFetch({ spbDelay: 600 });
  const job = Engine.startCrawl({
    provinces: ['北京', '上海', '广东', '江苏'],
    doPost: false,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  });

  await new Promise(r => setTimeout(r, 150));
  const cancelAt = Date.now();
  check('取消请求被接受', Engine.cancel(job.id) === true);

  await job.done;
  net.restore();

  eq('作业状态 = cancelled', job.state, 'cancelled');
  eq('取消后没有作业结果', job.result, null);
  check('进度没有被误报为完成',
    !!job.progress && job.progress.done < job.progress.total,
    JSON.stringify(job.progress));
  check('取消后在途请求被中断', net.aborted > 0, String(net.aborted));
  check('取消后不再开始新省份',
    net.provinceStarts.every(s => s.at <= cancelAt + 20),
    net.provinceStarts.map(s => s.at - cancelAt).join(','));
  check('取消后没有遗留后台请求', net.active === 0, String(net.active));

  const spbFiles = fs.readdirSync(outDir).filter(f => /^spb.*\.csv$/.test(f));
  eq('取消时未完成的省份没有落盘', spbFiles.length, 0);
}

// ============================================================
// 8b. 取消作业（POST 阶段）—— 不能顺延进入 SPB 阶段
// ============================================================
async function testCancelDuringPost(tmpDir) {
  console.log('\n[8b] 取消作业（POST 阶段）');

  const outDir = path.join(tmpDir, 'out-cancel-post');
  fs.mkdirSync(outDir, { recursive: true });
  Engine.configure({ outputDir: outDir });

  const net = installMockFetch({ postDelay: 600, spbDelay: 10 });
  const job = Engine.startCrawl({
    provinces: ['北京', '上海', '广东'],
    doPost: true,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  });

  await new Promise(r => setTimeout(r, 150));
  check('取消请求被接受', Engine.cancel(job.id) === true);

  await job.done;
  net.restore();

  eq('作业状态 = cancelled', job.state, 'cancelled');
  eq('取消后没有作业结果', job.result, null);
  check('取消后不再开始新的 POST 省份', net.postRequests <= 2, String(net.postRequests));
  eq('取消后未进入 SPB 阶段', net.spbRequests, 0);
  check('取消后在途请求被中断', net.aborted > 0, String(net.aborted));
  check('取消后没有遗留后台请求', net.active === 0, String(net.active));
  check('进度没有被误报为完成',
    !!job.progress && job.progress.done < job.progress.total,
    JSON.stringify(job.progress));
  eq('取消时没有落盘文件', fs.readdirSync(outDir).length, 0);
}

// ============================================================
// 9. 并发收益（对照基线）
// ============================================================
async function testSpeedup(tmpDir, serial) {
  console.log('\n[9] 并发 2 vs 并发 1（同省份数、同延迟）');

  // 重新跑一遍并发 2（与 [4] 相同的参数），确保对照条件一致
  const { job, net, elapsed, outDir } = await runCrawl(tmpDir, {
    provinces: ['北京', '上海', '广东'],
    doPost: false,
    doSpb: true,
    spbConcurrency: 2,
    delay: 0,
    interDelay: 0,
  }, { spbDelay: 10 });

  eq('作业状态', job.state, 'done');
  eq('最大并发 SPB 请求数', net.maxInflightSpb, 2);
  check('并发 2 快于并发 1',
    elapsed < serial.elapsed,
    `并发 2: ${elapsed}ms，串行: ${serial.elapsed}ms`);
  console.log(`       并发 2: ${elapsed}ms / 串行: ${serial.elapsed}ms ` +
    `(固定 300ms 礼貌延迟主导，约 ${(serial.elapsed / elapsed).toFixed(2)}×)`);

  // 验收要求：对照并发前后的 CSV，表头 / 字段 / 记录数应完全一致
  eq('并发前后 SPB 总条数一致', job.result.totalSpb, serial.job.result.totalSpb);
  for (const abbr of ['bj', 'sh', 'gd']) {
    const pick = (dir) => fs.readdirSync(dir).find(f => f.startsWith('spb' + abbr) && f.endsWith('.csv'));
    const serialFile = pick(serial.outDir);
    const concurrentFile = pick(outDir);
    const same = !!serialFile && !!concurrentFile &&
      fs.readFileSync(path.join(serial.outDir, serialFile))
        .equals(fs.readFileSync(path.join(outDir, concurrentFile)));
    check(`并发前后 spb${abbr} CSV 字节一致`, same,
      `${serialFile || '(无)'} vs ${concurrentFile || '(无)'}`);
  }
}

// ============================================================
// main
// ============================================================

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-concurrency-'));
  console.log(`临时目录: ${tmpDir}`);

  testNormalize();
  await testDefaultConcurrency(tmpDir);
  await testConcurrencyTwo(tmpDir);
  const serial = await testConcurrencyOne(tmpDir);
  await testResultOrdering(tmpDir);
  await testMixedSources(tmpDir);
  await testProvinceValidation(tmpDir);
  await testCancel(tmpDir);
  await testCancelDuringPost(tmpDir);
  await testSpeedup(tmpDir, serial);

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed === 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  } else {
    console.log(`（保留临时目录以便排查: ${tmpDir}）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[测试异常]', e);
  process.exit(1);
});
