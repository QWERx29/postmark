#!/usr/bin/env node
/**
 * 爬虫引擎冒烟测试（不依赖 Electron）
 * ===================================
 * 覆盖：POST 解析（含新的「市」字段反查）、SPB 正则解析、GBK 写盘读取回环、
 * 对比作业、回写 base 作业。需要联网的部分默认跳过，用 --net 打开。
 *
 * 用法:
 *   node scripts/smoke-crawler.js          # 离线用例
 *   node scripts/smoke-crawler.js --net    # 追加联网用例（真实抓取）
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

// ============ 1. POST 解析：「市」字段改为区县名 + 地名表反查 ============
function testParsePost() {
  console.log('\n[1] parsePostPage — 「市」字段地名表反查');

  const data = {
    success: true,
    total: 5,
    list: [
      // 普通地级市：河北省 博野县 → 保定市
      { sitename: '博野县邮政局', sitenameSuffix: '东街支局', zipcode: '071300',
        county: '博野县', address: '河北省保定市博野县东街', province: '河北省' },
      // 直辖市：上海市 嘉定区 → 上海市（而非「嘉定区」）
      { sitename: '嘉定区邮政支局', sitenameSuffix: '', zipcode: '201800',
        county: '嘉定区', address: '上海市嘉定区城中路', province: '上海市' },
      // 县级市：county 本身是市名
      { sitename: '东莞邮政', sitenameSuffix: '石龙支局', zipcode: '523000',
        county: '东莞市', address: '广东省东莞市石龙镇', province: '广东省' },
      // 邮编非法 → 应被丢弃
      { sitename: '测试局', sitenameSuffix: '', zipcode: '12345',
        county: '某区', address: '某省某市某区', province: '某省' },
      // 区县无法反查 → 「市」留空，交由渲染端 _correctCity 用邮编兜底
      { sitename: '未知局', sitenameSuffix: '', zipcode: '100000',
        county: '不存在的区', address: '某省', province: '北京市' },
    ],
  };

  const rows = Engine.parsePostPage(data, '河北省');
  eq('合法记录数（丢弃 5 位邮编）', rows.length, 4);

  const byName = {};
  for (const r of rows) byName[r['网点名称']] = r;

  eq('博野县东街支局 → 市', byName['博野县邮政局东街支局'] && byName['博野县邮政局东街支局']['市'], '保定市');
  eq('嘉定区邮政支局 → 市（直辖市回填省名）',
     byName['嘉定区邮政支局'] && byName['嘉定区邮政支局']['市'], '上海市');
  eq('东莞石龙支局 → 市（县级市取 county）',
     byName['东莞邮政石龙支局'] && byName['东莞邮政石龙支局']['市'], '东莞市');
  eq('未命中区县 → 市留空（非直辖市）',
     byName['未知局'] && byName['未知局']['市'], '');
  eq('未命中区县 → 直辖市回落省名',
     byName['未知局'] && byName['未知局']['省'], '北京市');
  eq('sitename + sitenameSuffix 拼接', !!byName['博野县邮政局东街支局'], true);
  eq('省字段沿用 JSON 的 province', byName['博野县邮政局东街支局']['省'], '河北省');

  // 直辖市 + 无法反查的区县 → 回落「省名+市」
  const munRows = Engine.parsePostPage({
    success: true, total: 1,
    list: [{ sitename: '未知局', sitenameSuffix: '', zipcode: '100000',
             county: '不存在区', address: '', province: '北京市' }],
  }, '北京');
  eq('直辖市兜底 → 北京市', munRows[0]['市'], '北京市');
}

// ============ 2. SPB 正则解析 ============
function testParseSpb() {
  console.log('\n[2] parseSpbPage — 正则解析');

  const html = `
<table class="table">
  <tr><th>所属省</th><th>所属市</th><th>所属县</th><th>场所名称</th><th>开办业务</th></tr>
  <tr>
    <td><a href="/sj/110000/pfyycsml/detail?id=1">北京市</a></td>
    <td><a href="/sj/110000/x?id=1">北京市</a></td>
    <td><a href="/sj/110000/y?id=1">东城区</a></td>
    <td><a href="/sj/110000/z?id=1">东单邮政支局</a></td>
    <td><a href="/sj/110000/w?id=1">邮政普遍服务</a></td>
  </tr>
  <tr>
    <td><a href="https://other.example.com/abs">北京市</a></td>
    <td><a href="/b">北京市</a></td>
    <td><a href="/c">西城区</a></td>
    <td><a href="/d">西单邮政支局&nbsp;（临时停业）</a></td>
    <td><a href="/e">信件、包裹</a></td>
  </tr>
  <tr><td>列数不足</td><td>x</td></tr>
  <tr><td>无链接</td><td>b</td><td>c</td><td>d</td><td>e</td></tr>
</table>`;

  const rows = Engine.parseSpbPage(html, 'https://zwfw.spb.gov.cn/test', { lines: [] });
  eq('有效行数（跳过表头/列数不足/无链接）', rows.length, 2);
  eq('第 1 行省', rows[0][0], '北京市');
  eq('第 1 行县', rows[0][2], '东城区');
  eq('第 1 行场所名称', rows[0][3], '东单邮政支局');
  eq('详情链接（相对路径拼接）', rows[0][5], 'https://zwfw.spb.gov.cn/sj/110000/pfyycsml/detail?id=1');
  eq('详情链接（已是绝对地址）', rows[1][5], 'https://other.example.com/abs');
  eq('&nbsp; 与空白归一', rows[1][3], '西单邮政支局 （临时停业）');
}

// ============ 3. GBK 写盘 → 读取回环 ============
function testCsvRoundTrip(tmpDir) {
  console.log('\n[3] GBK CSV 写盘与读取回环');

  const rows = [
    { '省': '河北省', '市': '保定市', '区/市/县': '博野县', '网点名称': '博野县邮政局,东街支局',
      '邮编': '071300', '地址': '河北省保定市博野县东街' },
    { '省': '上海市', '市': '上海市', '区/市/县': '嘉定区', '网点名称': '含"引号"的支局',
      '邮编': '201800', '地址': '上海市嘉定区' },
  ];
  const file = path.join(tmpDir, 'posttest-20260917.csv');
  Engine.configure({ outputDir: tmpDir });

  // 直接用底层写盘函数（savePostCsv 需要 job，这里构造一个最小的）
  const fakeJob = { lines: [], controllers: new Set(), cancelled: false };
  Engine.PROVINCES && null;

  const { cityByDistrict } = require(path.join(ROOT, 'crawler-cities.js'));
  eq('地名表：河北省/博野县', cityByDistrict('河北省', '博野县'), '保定市');
  eq('地名表：上海市/嘉定区', cityByDistrict('上海市', '嘉定区'), '上海市');
  eq('地名表：未知省', cityByDistrict('不存在省', '某区'), '');

  // 写盘（借用 startCrawl 内部的写法：直接调用导出的 csvLine 验证转义）
  eq('CSV 转义：含逗号', Engine.csvLine(['a,b', 'c']), '"a,b",c');
  eq('CSV 转义：含引号', Engine.csvLine(['a"b']), '"a""b"');
  eq('CSV 转义：普通字段', Engine.csvLine(['北京市', '东城区']), '北京市,东城区');

  // 真正走一遍 iconv 编码 + readPostCsv 解码
  const lines = [Engine.csvLine(Engine.POST_FIELDS)];
  for (const r of rows) lines.push(Engine.csvLine(Engine.POST_FIELDS.map(f => r[f])));
  fs.writeFileSync(file, iconv.encode(lines.join('\r\n') + '\r\n', 'gbk'));

  const raw = fs.readFileSync(file);
  check('文件可被 GBK 解码', iconv.decode(raw, 'gbk').includes('河北省'));

  const back = Engine.readPostCsv(file);
  eq('回环记录数', back.length, 2);
  eq('回环：市', back[0].city, '保定市');
  eq('回环：含逗号的名称', back[0].name, '博野县邮政局,东街支局');
  eq('回环：含引号的名称', back[1].name, '含"引号"的支局');

  // 与真实 base 文件对照：确认字段顺序与既有文件一致
  const basePost = path.join(ROOT, 'base', 'postbj+base.csv');
  if (fs.existsSync(basePost)) {
    const recs = Engine.readPostCsv(basePost);
    check('真实 base/postbj 可解析', recs.length > 0, `${recs.length} 条`);
    const first = recs[0];
    check('字段名与 base 一致',
      'province' in first && 'city' in first && 'district' in first &&
      'name' in first && 'postcode' in first && 'address' in first);
  }
}

// ============ 4. findLatestFile / getFilePrefix ============
function testHelpers(tmpDir) {
  console.log('\n[4] 文件名工具');

  eq('前缀提取 postbj', Engine.getFilePrefix('postbj-20260917.csv'), 'postbj');
  eq('前缀提取 spbsh+base', Engine.getFilePrefix('spbsh+base.csv'), 'spbsh');
  eq('前缀提取 非数据文件', Engine.getFilePrefix('compare_report_1.txt'), null);

  fs.writeFileSync(path.join(tmpDir, 'postzz-20260101.csv'), 'x');
  fs.writeFileSync(path.join(tmpDir, 'postzz-20260917.csv'), 'x');
  fs.writeFileSync(path.join(tmpDir, 'postzz-20260801.csv'), 'x');
  const latest = Engine.findLatestFile(tmpDir, 'postzz');
  eq('findLatestFile 取最新日期', path.basename(latest || ''), 'postzz-20260917.csv');
  eq('findLatestFile 无匹配', Engine.findLatestFile(tmpDir, 'nosuch'), null);
}

// ============ 5. 对比作业 + 回写 base ============
async function testCompareApply(tmpDir) {
  console.log('\n[5] 对比作业与回写 base');

  const outDir = path.join(tmpDir, 'output');
  const baseDir = path.join(tmpDir, 'base');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  // 造一对同名文件用于 txt_compare
  const mk = (prov, city, dist, name, pc) =>
    Engine.csvLine([prov, city, dist, name, pc, prov + city + dist]);
  const header = Engine.csvLine(Engine.POST_FIELDS);
  fs.writeFileSync(path.join(outDir, 'postbj-20260917.csv'),
    iconv.encode([header, mk('北京市', '北京市', '东城区', '东单邮政支局', '100005')].join('\r\n') + '\r\n', 'gbk'));
  fs.writeFileSync(path.join(baseDir, 'postbj+base.csv'),
    iconv.encode([header,
      mk('北京市', '北京市', '东城区', '东单邮政支局', '100005'),
      mk('北京市', '北京市', '西城区', '西单邮政支局', '100031'),
    ].join('\r\n') + '\r\n', 'gbk'));
  // 只有 base 有的前缀 → missing
  fs.writeFileSync(path.join(baseDir, 'spbtj+base.csv'),
    iconv.encode([Engine.csvLine(Engine.SPB_FIELDS), '天津市,天津市,和平区,和平路邮政所,信件,http://x'].join('\r\n') + '\r\n', 'gbk'));

  Engine.configure({
    outputDir: outDir,
    baseDir: baseDir,
    compareExeCandidates: [path.join(ROOT, 'txt_compare.exe')],
  });

  const exe = Engine.resolveCompareExe();
  check('定位到 txt_compare.exe', !!exe, exe || '未找到');
  if (!exe) return;

  const job = Engine.startCompare();
  await job.done;
  eq('对比作业状态', job.state, 'done');
  eq('对比对数', job.result.compared, 1);
  eq('新增数', job.result.added, 0);
  eq('缺失数', job.result.missing, 1);
  check('报告已生成', fs.existsSync(job.result.reportPath || ''), job.result.reportPath);
  check('报告含差异内容',
    /东单|西单|差异|新增|删除/.test(job.result.reportText || ''),
    (job.result.reportText || '').slice(0, 200));
  check('对比未修改 base', fs.existsSync(path.join(baseDir, 'spbtj+base.csv')));

  const applyJob = Engine.applyBase();
  await applyJob.done;
  eq('回写作业状态', applyJob.state, 'done');
  eq('回写文件数', applyJob.result.updated, 1);
  check('base 出现 postbj+base.csv', fs.existsSync(path.join(baseDir, 'postbj+base.csv')));
  const after = Engine.readPostCsv(path.join(baseDir, 'postbj+base.csv'));
  eq('回写后内容 = output 内容（西单被替换掉）', after.length, 1);
}

// ============ 6. 横向对比作业 ============
async function testCross(tmpDir) {
  console.log('\n[6] 横向对比作业');

  const outDir = path.join(tmpDir, 'cross');
  fs.mkdirSync(outDir, { recursive: true });
  Engine.configure({ outputDir: outDir });

  const postHeader = Engine.csvLine(Engine.POST_FIELDS);
  const spbHeader = Engine.csvLine(Engine.SPB_FIELDS);
  fs.writeFileSync(path.join(outDir, 'postbj-20260917.csv'), iconv.encode([
    postHeader,
    '北京市,北京市,东城区,东单邮政支局,100005,北京市东城区',
    '北京市,北京市,西城区,西单邮政支局,100031,北京市西城区',
    '北京市,北京市,朝阳区,朝阳门邮政支局,100020,北京市朝阳区',
  ].join('\r\n') + '\r\n', 'gbk'));
  fs.writeFileSync(path.join(outDir, 'spbbj-20260917.csv'), iconv.encode([
    spbHeader,
    '北京市,北京市,东城区,东单邮政支局,信件,http://a',
    '北京市,北京市,西城区,中国邮政集团有限公司北京市西城区西单邮政支局,信件,http://b',
    '北京市,北京市,朝阳区,安贞邮政支局,信件,http://c',
  ].join('\r\n') + '\r\n', 'gbk'));

  const job = Engine.startCrossCompare({ provinces: ['北京'] });
  await job.done;
  eq('横向对比作业状态', job.state, 'done');
  eq('可对比省份数', job.result.provinceCount, 1);
  check('报告文件已生成', fs.existsSync(job.result.reportPath || ''));

  const s = job.result.summary[0];
  eq('POST 条数', s.postCount, 3);
  eq('SPB 条数', s.spbCount, 3);
  eq('精确匹配', s.exact, 1);
  eq('归一化匹配（剥离集团前缀）', s.normalized, 1);
  check('报告含汇总段', /横向对比报告/.test(job.result.reportText));
  check('报告含归一化段落', /归一化匹配/.test(job.result.reportText));
}

// ============ 7. 联网用例（可选） ============
async function testNetwork(tmpDir) {
  console.log('\n[7] 联网抓取（真实请求）');

  const outDir = path.join(tmpDir, 'net');
  fs.mkdirSync(outDir, { recursive: true });
  Engine.configure({ outputDir: outDir });

  // 仅邮管局 + 上海（页面小，快）
  const job = Engine.startCrawl({ provinces: ['上海'], doPost: false, doSpb: true, delay: 0 });
  await job.done;
  eq('爬取作业状态', job.state, 'done');
  const r = job.result.results[0];
  check('SPB 抓到数据', r.spbCount > 0, `${r.spbCount} 条`);
  check('SPB 文件已生成', fs.existsSync(path.join(outDir, `spbsh-${job.result.date}.csv`)));

  const recs = Engine.readSpbCsv(path.join(outDir, `spbsh-${job.result.date}.csv`));
  check('SPB 省字段为全名（上海市）',
    recs.length > 0 && recs[0].province === '上海市',
    recs.length ? recs[0].province : '(无数据)');
  check('SPB 记录字段完整',
    recs.length > 0 && recs[0].name && recs[0].district,
    recs.length ? JSON.stringify(recs[0]) : '(无数据)');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-smoke-'));
  console.log(`临时目录: ${tmpDir}`);

  testParsePost();
  testParseSpb();
  testCsvRoundTrip(tmpDir);
  testHelpers(tmpDir);
  await testCompareApply(tmpDir);
  await testCross(tmpDir);

  if (process.argv.includes('--net')) {
    await testNetwork(tmpDir);
  } else {
    console.log('\n[7] 联网抓取 — 已跳过（加 --net 启用）');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed === 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  } else {
    console.log(`（保留临时目录以便排查: ${tmpDir}）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
