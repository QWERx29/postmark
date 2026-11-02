/**
 * 港澳台采集器 · 纯函数单元测试
 * =================================
 * 只测字段映射、转义、去重与数量校验，不访问网络。
 * 运行：node scripts/test-postal-crawl.js
 */

'use strict';

const assert = require('node:assert/strict');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

const { serializeCsv } = require('../postal/csv-exporter');
const { validateRecords, checkCount } = require('../postal/validators');
const { parseHkPayload } = require('../postal/collectors/hk');
const { parseMacauPayload } = require('../postal/collectors/mo');
const { parseTaiwanPostHtml } = require('../postal/collectors/tw');
const { parseAgencyPage } = require('../postal/collectors/agencytw');

const quietLogger = { info() {}, warn() {}, error() {} };

test('CSV：BOM、固定表头、逗号/引号/换行转义', () => {
  const text = serializeCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['line\nbreak', '']]);
  assert.ok(text.startsWith('\uFEFFa,b\r\n'));
  assert.ok(text.includes('"x,y"'));
  assert.ok(text.includes('"he said ""hi"""'));
  assert.ok(text.includes('"line\nbreak"'));
  assert.ok(text.endsWith('\r\n'));
});

test('CSV：列数不匹配时报错', () => {
  assert.throws(() => serializeCsv(['a', 'b'], [['only-one']]), /列数不匹配/);
});

test('香港：按 region 分组映射地区/局名/代号/地址', () => {
  const payload = {
    region: [
      {
        region_name_sc: '港岛区',
        district: [
          {
            office: [
              {
                office_code: 'ABD',
                office_name_sc: '香港仔邮政局',
                office_addr_sc: '香港仔大道171号金丰大厦地下',
              },
            ],
          },
        ],
      },
      {
        region_name_sc: '离岛区',
        district: [{ office: [{ office_code: 'TCG', office_name_sc: '东涌邮政局', office_addr_sc: '大屿山东涌美东街6号地下' }] }],
      },
    ],
  };
  const { records, regionCount } = parseHkPayload(payload);
  assert.equal(regionCount, 2);
  assert.deepEqual(records[0], {
    '地区': '港岛区',
    '局名': '香港仔邮政局',
    '代号': 'ABD',
    '地址': '香港仔大道171号金丰大厦地下',
  });
  assert.equal(records[1]['地区'], '离岛区');
});

test('澳门：只取 legalName + address，不用简称/电话/地图', () => {
  const payload = {
    data: {
      itemListElement: [
        {
          legalName: '邮政总局',
          alternateName: '郵政總',
          address: '澳门议事亭前地邮电局总部大楼',
          telephone: '2832 3666',
          hasMap: 'https://example.invalid/map',
        },
      ],
    },
  };
  const { records } = parseMacauPayload(payload);
  assert.deepEqual(records, [{ '名称': '邮政总局', '地址': '澳门议事亭前地邮电局总部大楼' }]);
});

test('台湾普通邮局：局名取第一个链接，电脑局名单独一列，地址解实体', () => {
  const html = `
    <h3>全國營業據點一覽表(共1筆)</h3>
    <div id="table">
      <table>
        <tr><th>郵遞區號</th><th>電腦局號</th><th>局名</th><th>電腦局名</th><th>局址</th></tr>
        <tr>
          <td><img src="icon.gif"></td>
          <td class="detail2">100003</td>
          <td class="detail2" nowrap>000100-6<p>000500-8</td>
          <td class="detail2">
            <a class="rwd-close" href="post.jsp?prsb_no=000100-6">臺北北門郵局</a>
            <a class="rwd-open" href="post.jsp?prsb_no=000100-6">臺北北門郵局</a>
          </td>
          <td class="detail2">臺北901支</td>
          <td class="detail">&#x81fa;北市中正區忠孝西路一段120號1樓</td>
        </tr>
      </table>
    </div>`;
  const { records, sourceTotal } = parseTaiwanPostHtml(html);
  assert.equal(sourceTotal, 1);
  assert.deepEqual(records[0], {
    '邮递区号': '100003',
    '局名': '臺北北門郵局',
    '电脑局名': '臺北901支',
    '地址': '臺北市中正區忠孝西路一段120號1樓',
  });
});

test('台湾代办所：邮递区号/局名/地址/管辖邮局，保留 G_id 供翻页去重', () => {
  const html = `
    <h3>共1筆</h3>
    <div id="table" class="agency">
      <table>
        <tr><th>名稱</th><th>郵遞區號</th><th>營業地址</th><th>電話</th><th>營業項目</th><th>管轄郵局</th><th>郵件條碼代號</th><th>營業時段</th><th>電子地圖</th></tr>
        <tr>
          <td class="detail2">臺北第5郵政代辦所</td>
          <td class="detail2">100009</td>
          <td class="detail2">市民大道1段100號地下街輕食區023號店舖</td>
          <td>02-1234</td>
          <td><a href="Agency_service.jsp?G_id=2996147">營業項目</a></td>
          <td>臺北郵局</td>
          <td>123456</td>
          <td>平常日</td>
          <td><a href="index_map.jsp?prsb_no=1">地圖</a></td>
        </tr>
      </table>
    </div>`;
  const { records, sourceTotal } = parseAgencyPage(html);
  assert.equal(sourceTotal, 1);
  assert.equal(records[0]['邮递区号'], '100009');
  assert.equal(records[0]['局名'], '臺北第5郵政代辦所');
  assert.equal(records[0]['管辖邮局'], '臺北郵局');
  assert.equal(records[0]._gid, '2996147');
});

test('校验：丢弃缺失必填、去重、保留前导零', () => {
  const spec = {
    fields: ['邮递区号', '局名', '地址', '管辖邮局'],
    required: ['邮递区号', '局名', '地址'],
    optional: ['管辖邮局'],
    key: ['局名', '地址'],
    postcodeField: '邮递区号',
  };
  const records = [
    { '邮递区号': '001234', '局名': 'A', '地址': 'X', '管辖邮局': 'P' },
    { '邮递区号': '001234', '局名': 'A', '地址': 'X', '管辖邮局': 'P' }, // 重复
    { '邮递区号': '001234', '局名': '', '地址': 'Y', '管辖邮局': 'P' },   // 缺局名
    { '邮递区号': '12', '局名': 'B', '地址': 'Z', '管辖邮局': '' },       // 区号异常
    { '邮递区号': '001235', '局名': 'C', '地址': 'W', '管辖邮局': '' },   // 可选为空
  ];
  const result = validateRecords('test', records, spec, quietLogger);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0]['邮递区号'], '001234');
  assert.equal(result.records[1]['管辖邮局'], '');
  assert.equal(result.dropped, 2);
  assert.equal(result.duplicates, 1);
});

test('数量校验：空结果/低于阈值/明显不完整时抛错，参考值差异只警告', () => {
  assert.throws(() => checkCount('x', 0, {}, quietLogger), /结果为空/);
  assert.throws(() => checkCount('x', 3, { min: 5 }, quietLogger), /最低阈值/);
  assert.throws(
    () => checkCount('x', 100, { sourceTotal: 1000, minRatio: 0.95 }, quietLogger),
    /采集不完整/
  );
  const warnings = checkCount('x', 960, { sourceTotal: 1000, minRatio: 0.95 }, quietLogger);
  assert.equal(warnings.length, 1);
  const refWarnings = checkCount('x', 371, { reference: 377, tolerance: 0.05 }, quietLogger);
  assert.equal(refWarnings.length, 0);
  assert.throws(
    () => checkCount('x', 300, { reference: 377, minReferenceRatio: 0.9 }, quietLogger),
    /明显不完整/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
