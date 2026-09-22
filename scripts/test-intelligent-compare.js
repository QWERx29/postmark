#!/usr/bin/env node
/**
 * 智能判别对比（crawler-intelligent.js）离线单测
 * ============================================
 * 不联网、不读文件、不依赖 Python，全部内联 fixture。
 * 与真实 crawler.py 的逐字对齐由 regression-intelligent-compare.js 负责，
 * 这里只锁行为契约（各类变化是否被识别、计数是否自洽、边界是否安全）。
 *
 * 用法: node scripts/test-intelligent-compare.js
 */

'use strict';

const I = require('../crawler-intelligent.js');
const Matcher = require('../crawler-match.js');

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`); }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

function post(district, name, postcode, address, city = '天津市') {
  return { province: '天津市', city, district, name, postcode, address };
}
function spb(district, name, services, link) {
  return { province: '天津市', city: '天津市', district, name, services, detail_link: link };
}

/** 取第 i 对匹配的匹配方式；没有第 i 对时返回 '<无匹配>' 而不是抛异常 */
function level(m, i = 0) {
  const pair = m.matchedPairs[i];
  return pair ? pair[4] : '<无匹配>';
}

/** 取第 i 条变化的类别串；缺失时返回 '<无变化>'，避免断言失败时整个脚本崩掉 */
function cat(changes, i = 0) {
  return changes[i] ? changes[i].categories.join(',') : '<无变化>';
}

/** 取第 i 条变化的某个 details 字段 */
function detail(changes, key, i = 0) {
  return changes[i] ? changes[i].details[key] : '<无变化>';
}

/** 从报告行里取某个 section 的数据行（去掉表头两行） */
function sectionRows(lines, title) {
  const i = lines.findIndex(l => l.startsWith(`--- ${title} (`));
  if (i < 0) return null;
  const rows = [];
  for (let j = i + 3; j < lines.length; j++) {
    if (lines[j].startsWith('--- ') || lines[j] === '') break;
    rows.push(lines[j]);
  }
  return rows;
}

// ============================================================
console.log('\n[1] 后缀表与归一化（真实版 21 项，比 crawler-match.js 多 5 项）');

// 真实 crawler.py 的 _NAME_SUFFIXES 共 21 项；crawler-match.js 里那份只有 16 项，
// 少的是「邮政便民服务点 / 代办所 / 邮电支局 / 邮电所 / 营业所」。
eq('后缀表 21 项', I.NAME_SUFFIXES.length, 21);
check('crawler-match.js 那份仍是 16 项（本次未被牵动）', Matcher.NAME_SUFFIXES.length === 16,
  `${Matcher.NAME_SUFFIXES.length}`);
for (const s of ['邮政便民服务点', '代办所', '邮电支局', '邮电所', '营业所']) {
  check(`本模块有「${s}」`, I.NAME_SUFFIXES.includes(s));
  check(`crawler-match.js 没有「${s}」`, !Matcher.NAME_SUFFIXES.includes(s));
}

eq('剥离长后缀', I.normalizeName('天津邮政便民服务点'), '天津');
eq('剥离裸「支局」', I.normalizeName('东贸路支局'), '东贸路');
eq('剥离括号注释', I.normalizeName('和平路邮政支局（暂停）'), '和平路');
eq('不动不含后缀的名字', I.normalizeName('南开大学'), '南开大学');
eq('空输入不炸', I.normalizeName(null), '');
eq('长后缀优先于短后缀', I.normalizeName('甲邮政服务中心'), '甲');
// 与 crawler-match.js 分叉的实证：同一名字两边结果不同
eq('分叉：本模块剥「营业所」', I.normalizeName('友谊路营业所'), '友谊路');
eq('分叉：crawler-match.js 不剥', Matcher.normalizeName('友谊路营业所'), '友谊路营业所');

eq('公共中文子串', I.findCommonCnSubstring('南开大学邮政所', '南开大学邮政支局'), '南开大学');
eq('公共子串不足 2 字返回空', I.findCommonCnSubstring('甲所', '乙所'), '');

// ============================================================
console.log('\n[2] 营业状态标记');

eq('暂停营业', JSON.stringify(I.extractStatus('师范学院邮政所（暂停）')),
  JSON.stringify({ clean: '师范学院邮政所', statuses: ['暂停营业'] }));
eq('假期暂停', I.extractStatus('甲支局(假期暂停)').statuses.join(','), '假期暂停');
eq('装修中', I.extractStatus('甲支局（装修中）').statuses.join(','), '装修中');
eq('临时停业', I.extractStatus('甲支局（临时停业）').statuses.join(','), '临时停业');
eq('撤销', I.extractStatus('甲支局（撤销）').statuses.join(','), '已撤销');
eq('无标记', I.extractStatus('甲支局').statuses.length, 0);
// 半角/全角括号都要认
eq('半角括号也认', I.extractStatus('甲支局(暂停)').statuses.join(','), '暂停营业');
// 连续多次调用不能被带 g 标志的正则的 lastIndex 影响
I.extractStatus('甲支局（暂停）');
eq('重复调用结果稳定', I.extractStatus('甲支局（暂停）').statuses.join(','), '暂停营业');

// ============================================================
console.log('\n[3] 三级匹配引擎');

{
  // 阶1: 区县+归一化名
  const r1 = [post('和平区', '和平路邮政支局', '300020', '和平路1号')];
  const r2 = [post('和平区', '和平路邮政所', '300020', '和平路1号')];
  const m = I.matchSameSource(r1, r2, 'post');
  eq('阶1 归一化后同名 → exact', level(m), 'exact');
  eq('阶1 命中后无未匹配', m.unmatched1.length + m.unmatched2.length, 0);
}
{
  // 区县不同则阶1 不命中
  const r1 = [post('和平区', '和平路邮政支局', '300020', 'a')];
  const r2 = [post('南开区', '和平路邮政支局', '300020', 'a')];
  const m = I.matchSameSource(r1, r2, 'post');
  // 同名的两条记录区县不同 → 阶1（区县参与键）、阶2（区县硬约束）、阶3（同区县约束）
  // 全部拒绝。这是原版的设计：区县是硬约束，宁可漏配也不跨区县错配。
  eq('区县不同 → 三阶全不命中', level(m), '<无匹配>');
  eq('区县不同 → 双方都算未匹配', m.unmatched1.length + m.unmatched2.length, 2);
}
{
  // 阶2: 归一化后不同名，但剥离后缀后仍有 >=2 字公共中文字串
  // 注意别用「南开大学邮政所/南开大学邮政支局」——两者归一化后都是「南开大学」，
  // 会在阶1 就精确命中，根本走不到阶2。
  const r1 = [post('南开区', '南开大学北门邮政所', '300071', 'a')];
  const r2 = [post('南开区', '南开大学邮政所', '300071', 'a')];
  eq('两名字归一化后确实不同',
    I.normalizeName('南开大学北门邮政所') !== I.normalizeName('南开大学邮政所'), true);
  const m = I.matchSameSource(r1, r2, 'post');
  eq('阶2 公共字串 → suspected', level(m), 'suspected');
}
{
  // 阶3: 邮编相同、名称无公共中文字串（前面两阶都够不着）
  const r1 = [post('东丽区', '北辰邮政所', '300300', 'a')];
  const r2 = [post('东丽区', '双青邮政所', '300300', 'a')];
  eq('两名字确无公共中文字串', I.findCommonCnSubstring('北辰邮政所', '双青邮政所'), '');
  const m = I.matchSameSource(r1, r2, 'post');
  eq('阶3 邮编 → postcode', level(m), 'postcode');
}
{
  // 区县不同则阶3 不命中
  const r1 = [post('东丽区', '北辰邮政所', '300300', 'a')];
  const r2 = [post('西青区', '双青邮政所', '300300', 'a')];
  const m = I.matchSameSource(r1, r2, 'post');
  eq('阶3 要求同区县', m.matchedPairs.length, 0);
  eq('阶3 失败后双方都算未匹配', m.unmatched1.length + m.unmatched2.length, 2);
}
{
  // SPB 没有邮编字段 → 不给走阶3
  const r1 = [spb('东丽区', '北辰邮政所', '信件', 'l1')];
  const r2 = [spb('东丽区', '双青邮政所', '信件', 'l1')];
  const m = I.matchSameSource(r1, r2, 'spb');
  eq('SPB 不走邮编阶', m.matchedPairs.length, 0);
}
{
  // 对照：同样的两条名字在 POST 下能靠邮编匹配上，SPB 下不能
  const mp = I.matchSameSource([post('东丽区', '北辰邮政所', '300300', 'a')],
                               [post('东丽区', '双青邮政所', '300300', 'a')], 'post');
  eq('POST 能靠邮编匹配', level(mp), 'postcode');
}
{
  // 特殊园区放宽区县限制（滨海新区）
  const r1 = [post('滨海新区', '塘沽邮政支局', '300450', 'a')];
  const r2 = [post('塘沽区', '塘沽邮政所', '300450', 'a')];
  const m = I.matchSameSource(r1, r2, 'post');
  eq('特殊园区可跨区县匹配', m.matchedPairs.length, 1);
  eq('且走的是阶2', level(m), 'suspected');
}
{
  // 一条记录只能被匹配一次
  const r1 = [post('和平区', '甲邮政所', '1', ''), post('和平区', '甲邮政所', '2', '')];
  const r2 = [post('和平区', '甲邮政所', '3', '')];
  const m = I.matchSameSource(r1, r2, 'post');
  eq('同名记录不重复占用', m.matchedPairs.length, 1);
  eq('多出的那条算新增', m.unmatched1.length, 1);
}

// ============================================================
console.log('\n[4] 变化分类');

{
  const oldR = [post('和平区', '师范学院邮政所', '300021', '卫津路2号')];
  const newR = [post('和平区', '师范学院邮政所（暂停）', '300021', '卫津路2号')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'post').matchedPairs, 'post');
  eq('只多状态标记 → 一个变化', changes.length, 1);
  eq('类别是营业状态变化', cat(changes), '营业状态变化');
  eq('旧状态', detail(changes, 'status_old'), '正常');
  eq('新状态', detail(changes, 'status_new'), '暂停营业');
  check('不误报名称变化', changes[0] && !changes[0].categories.includes('名称变化'));
}
{
  const oldR = [post('和平区', '和平路邮政所', '100000', '旧地址')];
  const newR = [post('和平区', '和平路邮政所', '200000', '新地址')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'post').matchedPairs, 'post');
  eq('邮编+地址两个类别', cat(changes), '邮编变化,地址变化');
  eq('旧邮编', detail(changes, 'postcode_old'), '100000');
  eq('新邮编', detail(changes, 'postcode_new'), '200000');
}
{
  // >=3 个字段 → 追加 ⚠综合变化
  // （同名不同区县会在阶2 被区县硬约束挡住配不上，所以这里让区县相同、只改市）
  const oldR = [post('和平区', '和平路邮政所', '100000', '旧地址', '天津市')];
  const newR = [post('和平区', '和平北路邮政所', '200000', '新地址', '北京市')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'post').matchedPairs, 'post');
  eq('四个类别 + ⚠', cat(changes),
    '名称变化,邮编变化,地址变化,区划变化(市),' + I.COMPREHENSIVE);
  eq('恰好 4 个真实类别 + 1 个 ⚠', changes[0] ? changes[0].categories.length : -1, 5);
}
{
  // SPB 比开办业务与详情链接
  const oldR = [spb('和平区', '和平路邮政所', '信件', 'L1')];
  const newR = [spb('和平区', '和平路邮政所', '信件,包裹', 'L2')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'spb').matchedPairs, 'spb');
  eq('开办业务+详情链接', cat(changes), '开办业务变化,详情链接变化');
}
{
  // POST 记录没有 services 字段 → 不该冒出来
  const oldR = [post('和平区', '和平路邮政所', '100000', 'a')];
  const newR = [post('和平区', '和平路邮政所', '100000', 'a')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'post').matchedPairs, 'post');
  eq('完全一致 → 无变化', changes.length, 0);
}
{
  // ⚠ 只由「>=3 个字段」触发，2 个字段不触发
  const oldR = [post('和平区', '和平路邮政所', '100000', '旧地址')];
  const newR = [post('和平区', '和平路邮政所', '200000', '新地址')];
  const changes = I.classifyChanges(I.matchSameSource(newR, oldR, 'post').matchedPairs, 'post');
  check('2 个字段不触发 ⚠',
    changes[0] && !changes[0].categories.some(c => c.startsWith('⚠')), cat(changes));
}

// ============================================================
console.log('\n[5] 连续变化区块');

{
  const oldR = [
    post('和平区', '甲邮政所', '100000', 'a'),
    post('和平区', '乙邮政所', '100001', 'b'),
    post('和平区', '丙邮政所', '100002', 'c'),
  ];
  const newR = [
    post('和平区', '甲邮政所', '100000', 'a'),
    post('和平区', '乙支局', '100001', 'b'),
    post('和平区', '丙邮政所', '100002', 'c'),
  ];
  const m = I.matchSameSource(newR, oldR, 'post');
  const changes = I.classifyChanges(m.matchedPairs, 'post');
  const blocks = I.detectConsecutiveBlocks(changes, m.unmatched1, m.unmatched2, newR, oldR);
  eq('单个差异行不构成区块（total_diff < 2）', blocks.length, 0);
}
{
  // 相邻两行都有差异 → 构成区块
  const oldR = [
    post('和平区', '甲邮政所', '100000', 'a'),
    post('和平区', '乙邮政所', '100001', 'b'),
  ];
  const newR = [
    post('和平区', '甲邮政支局', '100000', 'a'),
    post('和平区', '乙邮政支局', '100001', 'b'),
  ];
  const m = I.matchSameSource(newR, oldR, 'post');
  const changes = I.classifyChanges(m.matchedPairs, 'post');
  const blocks = I.detectConsecutiveBlocks(changes, m.unmatched1, m.unmatched2, newR, oldR);
  eq('相邻两行 → 1 个区块', blocks.length, 1);
  eq('区块起止行', `${blocks[0].startLine}-${blocks[0].endLine}`, '0-1');
  eq('区块区县', blocks[0].district, '和平区');
  check('判断含「2个网点信息发生变化」', /2个网点信息发生变化/.test(blocks[0].judgment),
    blocks[0].judgment);
}
{
  // 区块内未匹配记录：既没有公共中文字串、邮编也不同 → 全部算新增/撤下
  const oldR = [post('和平区', '甲邮政所', '100000', 'a'), post('和平区', '乙邮政所', '100001', 'b')];
  const newR = [post('和平区', '丙邮电所', '900000', 'x'), post('和平区', '丁邮电所', '900001', 'y')];
  const m = I.matchSameSource(newR, oldR, 'post');
  const c = I.classifyChanges(m.matchedPairs, 'post');
  const blocks = I.detectConsecutiveBlocks(c, m.unmatched1, m.unmatched2, newR, oldR);
  eq('两条都配不上', m.matchedPairs.length, 0);
  eq('全新增无匹配 → 1 个区块', blocks.length, 1);
  eq('区块内新版独有 2 条', blocks[0].onlyIn1.length, 2);
  eq('区块内旧版独有 2 条', blocks[0].onlyIn2.length, 2);
  check('判断含「疑似2个网点新增」', /疑似2个网点新增/.test(blocks[0].judgment), blocks[0].judgment);
  check('判断含「疑似2个网点撤下」', /疑似2个网点撤下/.test(blocks[0].judgment), blocks[0].judgment);
}
{
  // 区块内疑似更名：公共字串 >= 2 → 计入 fuzzy，并从新增/撤下里**折算掉**
  // 老名字「甲邮政所」核心是单字「甲」，够不着阶2/阶3，所以落进未匹配；
  // 新名字「甲路邮电所」核心是「甲路」，两者公共字串「甲」只有 1 字 → 也够不着。
  // 这里换成两条能互配上的：新「甲路邮政所」vs 旧「甲路邮电所」→ 公共「甲路」。
  const oldR = [post('和平区', '北海路邮电所', '100000', 'a'), post('和平区', '长江道邮电所', '100001', 'b')];
  const newR = [post('和平区', '北海路邮政所', '100000', 'a'), post('和平区', '长江道邮政所', '100001', 'b')];
  const m = I.matchSameSource(newR, oldR, 'post');
  eq('归一化后同名 → 阶1 命中', m.matchedPairs.filter(p => p[4] === 'exact').length, 2);
  const c = I.classifyChanges(m.matchedPairs, 'post');
  const blocks = I.detectConsecutiveBlocks(c, m.unmatched1, m.unmatched2, newR, oldR);
  eq('已匹配的变化不算进区块内未匹配', blocks[0].onlyIn1.length + blocks[0].onlyIn2.length, 0);
  eq('区块内已匹配变化 2 条', blocks[0].changesInBlock.length, 2);
}
{
  // 区块内二次模糊匹配：把「疑似同一网点更名」从新增/撤下里折算出来。
  // 关键是要造出**主匹配阶段漏掉、但区块内能配上**的一对 —— 主匹配的三阶都要求
  // 区县一致，而区块内的二次匹配不看区县。所以用跨区县 + 有公共中文字串的一对。
  const oldR = [post('和平区', '海河广场邮电所', '100000', 'a')];
  const newR = [post('南开区', '海河广场邮政所', '900000', 'x')];
  const m = I.matchSameSource(newR, oldR, 'post');
  eq('跨区县 → 主匹配三阶全配不上', m.matchedPairs.length, 0);
  const c = I.classifyChanges(m.matchedPairs, 'post');
  const blocks = I.detectConsecutiveBlocks(c, m.unmatched1, m.unmatched2, newR, oldR);
  eq('区块内二次匹配配上了', blocks.length === 1 ? blocks[0].fuzzyMatchesInBlock.length : -1, 1);
  eq('疑似对给出公共字串',
    blocks.length === 1 ? blocks[0].fuzzyMatchesInBlock[0][2] : '', '海河广场');
  eq('判断里计入疑似更名',
    blocks.length === 1 && blocks[0].judgment === '1对疑似同一网点更名', true);
  check('区块判断不含「新增」', blocks.length === 1 && !/新增/.test(blocks[0].judgment),
    blocks.length === 1 ? blocks[0].judgment : '<无区块>');
  check('区块判断不含「撤下」', blocks.length === 1 && !/撤下/.test(blocks[0].judgment),
    blocks.length === 1 ? blocks[0].judgment : '<无区块>');
}
{
  // 空输入
  eq('无差异 → 无区块', I.detectConsecutiveBlocks([], [], [], [], []).length, 0);
}

// ============================================================
console.log('\n[6] intelligentCompare 端到端');

{
  const oldR = [
    post('和平区', '和平路邮政支局', '300020', '和平路1号'),
    post('和平区', '师范学院邮政所', '300021', '卫津路2号'),
    post('南开区', '南开大学邮政所', '300071', '南开区3号'),
    post('津南区', '双港邮政所', '300350', '双港10号'),
  ];
  const newR = [
    post('和平区', '和平路邮政支局', '300020', '和平路1号'),              // 一致
    post('和平区', '师范学院邮政所（暂停）', '300021', '卫津路2号'),      // 营业状态
    post('南开区', '南开大学邮政支局', '300071', '新地址'),               // 名称 + 地址
    // 邮编要跟「双港邮政所」错开：同区县+同邮编会被阶3 当成同一条网点匹配上，
    // 那就变成「名称变化」而不是「新增」了。
    post('津南区', '咸水沽邮政所', '300351', '咸水沽11号'),               // 新增
  ];
  const res = I.intelligentCompare(newR, oldR, 'post', 'posttj-20260917.csv');

  eq('新版条数', res.newCount, 4);
  eq('旧版条数', res.oldCount, 4);
  eq('总计变化', res.summary.byCategory['营业状态变化'], 1);
  eq('名称变化计数', res.summary.byCategory['名称变化'], 1);
  eq('地址变化计数', res.summary.byCategory['地址变化'], 1);
  eq('新增计数', res.summary.new, 1);
  eq('撤下计数', res.summary.removed, 1);
  eq('综合变化计数', res.summary.comprehensive, 0);

  check('报告首行是标题', res.lines[0] === '=== 智能判别分析: posttj-20260917.csv ===', res.lines[0]);
  check('报告含数据来源', res.lines.some(l => l === '数据来源: 邮政官网(POST)'));
  check('报告含条数行', res.lines.some(l => l === '新版数据: 4 条  |  旧版数据: 4 条'));
  check('报告含变化汇总', res.lines.includes('--- 变化汇总 ---'));
  check('报告含名称变化详情', res.lines.some(l => l.startsWith('--- 名称变化详情 (1条)')));
  check('报告含营业状态变化详情', res.lines.some(l => l.startsWith('--- 营业状态变化详情 (1条)')));
  check('报告含疑似新增', res.lines.some(l => l.startsWith('--- 疑似新增网点 (1条)')));
  check('报告含疑似撤下', res.lines.some(l => l.startsWith('--- 疑似撤下网点 (1条)')));
  const newRows = sectionRows(res.lines, '疑似新增网点');
  check('新增按区县列出', newRows && newRows.some(l => l.startsWith('  津南区') && l.includes('咸水沽邮政所')),
    JSON.stringify(newRows));
  const goneRows = sectionRows(res.lines, '疑似撤下网点');
  check('撤下按区县列出', goneRows && goneRows.some(l => l.includes('双港邮政所')),
    JSON.stringify(goneRows));

  // 表格列宽与真实报告的排版一致（左对齐补空格）
  const nameRows = sectionRows(res.lines, '名称变化详情');
  check('名称变化行含匹配方式「精确」', /精确\s*$/.test(nameRows[0]), JSON.stringify(nameRows[0]));
  check('名称变化表头是 区县/旧名称/新名称/邮编/匹配方式',
    res.lines[res.lines.indexOf('--- 变化汇总 ---') + 0] !== undefined &&
    res.lines.some(l => /^ {2}区县\s+旧名称\s+新名称\s+邮编\s+匹配方式\s*$/.test(l)));
}
{
  // 完全一致 → 短路提示
  const same = [post('和平区', '甲邮政所', '100000', 'a')];
  const res = I.intelligentCompare(same, same, 'post', 'postk-20260917.csv');
  check('完全一致有短路提示',
    res.lines.some(l => l.includes('两份数据完全一致，无任何差异')), JSON.stringify(res.lines));
  eq('完全一致时无变化', res.summary.byCategory && Object.keys(res.summary.byCategory).length, 0);
}
{
  // 双空 → 专门的短路报告
  const res = I.intelligentCompare([], [], 'post', 'postk-20260917.csv');
  eq('双空报告两行', res.lines.length, 2);
  eq('双空提示语', res.lines[1], '两份文件均为空，无法对比。');
  eq('双空计数', res.summary.new + res.summary.removed, 0);
}
{
  // 单边
  const res = I.intelligentCompare([post('和平区', '甲邮政所', '100000', 'a')], [], 'post', 'postk.csv');
  eq('旧版为空 → 全算新增', res.summary.new, 1);
  eq('旧版为空 → 无撤下', res.summary.removed, 0);
}
{
  // 数据源自动判断（按文件名前缀）
  eq('post 前缀自动判断', I.intelligentCompare([], [], null, 'postbj-20260917.csv').sourceType, 'post');
  eq('spb 前缀自动判断', I.intelligentCompare([], [], null, 'spbbj-20260917.csv').sourceType, 'spb');
  eq('认不出时兜底 post', I.intelligentCompare([], [], null, 'weird.csv').sourceType, 'post');
}
{
  // SPB 报告要出「开办业务变化详情」，POST 不该出
  const o = [spb('和平区', '甲邮政所', '信件', 'L1')];
  const n = [spb('和平区', '甲邮政所', '信件,包裹', 'L1')];
  const resSpb = I.intelligentCompare(n, o, 'spb', 'spbtj-20260917.csv');
  check('SPB 出开办业务详情', resSpb.lines.some(l => l.startsWith('--- 开办业务变化详情')));
  check('SPB 数据来源标注', resSpb.lines.some(l => l === '数据来源: 邮管局备案(SPB)'));

  const resPost = I.intelligentCompare(
    [post('和平区', '甲邮政所', '100000', 'a')], [post('和平区', '甲邮政所', '100000', 'a')],
    'post', 'posttj.csv');
  check('POST 不出开办业务详情', !resPost.lines.some(l => l.includes('开办业务变化')));
}
{
  // 明细裁剪：cap 生效但 summary 保留真实计数
  const oldR = [];
  const newR = [];
  for (let i = 0; i < 250; i++) {
    oldR.push(post('和平区', `网点${i}邮政所`, String(100000 + i).padStart(6, '0'), 'a'));
    newR.push(post('和平区', `网点${i}邮政所（暂停）`, String(100000 + i).padStart(6, '0'), 'a'));
  }
  const res = I.intelligentCompare(newR, oldR, 'post', 'postbig.csv');
  eq('summary 保留真实计数', res.summary.byCategory['营业状态变化'], 250);
  eq('明细裁剪到 cap=200', res.changes.length, 200);
  check('报告全文仍含全部 250 条', res.lines.filter(l => l.includes('暂停营业')).length === 250,
    String(res.lines.filter(l => l.includes('暂停营业')).length));
  const wide = I.intelligentCompare(newR, oldR, 'post', 'postbig.csv', { cap: 1000 });
  eq('cap 可调', wide.changes.length, 250);
}

// ============================================================
console.log('\n[7] 健壮性');

{
  // 字段缺失不该抛异常
  const o = [{ name: '甲邮政所' }];
  const n = [{ name: '甲邮政所' }];
  let ok = true;
  let res = null;
  try { res = I.intelligentCompare(n, o, 'post', 'x.csv'); } catch (e) { ok = false; }
  check('缺字段不抛异常', ok);
  check('缺字段仍能出报告', res && res.lines.length > 0);
}
{
  // 空名字
  let ok = true;
  try { I.normalizeName(''); I.findCommonCnSubstring('', ''); I.extractStatus(''); } catch (e) { ok = false; }
  check('空字符串不抛异常', ok);
}
{
  // 返回值必须是纯 JSON 可序列化的（弹窗要经 HTTP JSON 传给渲染进程）
  const res = I.intelligentCompare(
    [post('和平区', '甲邮政所', '100000', 'a')],
    [post('和平区', '乙邮政所', '200000', 'b')],
    'post', 'postk.csv');
  let round = null;
  let ok = true;
  try { round = JSON.parse(JSON.stringify(res)); } catch (e) { ok = false; }
  check('结果可 JSON 往返', ok && round.changes.length === res.changes.length);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
