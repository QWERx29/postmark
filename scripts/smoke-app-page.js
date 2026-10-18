#!/usr/bin/env node
/**
 * 开发期自检：把真实 index.html 在无头浏览器里跑一遍，确认入口页面能正常渲染。
 *
 * 为什么需要它
 * ------------
 * 各模块的测试都是各自搭一个测试页；`index.html` 自己的 <script> 顺序、
 * 新增 DOM 的 id、样式是否被引用，只有在真页面上才验证得到。
 * 曾经出现过「测试全绿但入口页少引一个脚本」这类问题，所以补这一道。
 *
 *   node scripts/smoke-app-page.js
 *   node scripts/smoke-app-page.js --keep
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Server = require(path.join(ROOT, 'server.js'));
const BrowserTest = require(path.join(__dirname, '_lib', 'browser-test.js'));

/** 临时站点里用目录联接接回项目的目录（删除时必须先摘链接，见 removeSite） */
const LINKED_DIRS = ['js', 'css', 'geo', 'base', 'node_modules'];
const linked = [];

/**
 * 把「项目根目录 + 自检脚本」搭成一个临时站点。
 *
 * 为什么不在 /scripts/ 下直接放一份 index.html：
 * index.html 里的 <script src="js/..."> 是**相对路径**，
 * 从 /scripts/ 打开会解析成 /scripts/js/... 全部 404，
 * 自检就会报一堆"模块未加载"的假故障。真实应用是从根目录提供 index.html 的，
 * 这里必须复现同样的情形：根目录放自检页，其余目录用软链接接回项目。
 */
function buildSite() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'postmark-site-'));
  // 入口页 = 真实 index.html + 末尾追加自检脚本
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const probe = `
<script>
/**
 * 全部检查都放在 __runSmoke 里，并等到 DOMContentLoaded 之后再跑。
 *
 * 为什么必须等：入口页每个模块都是
 *   if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init); else init();
 * 这段自检脚本是页面最后一个 <script>，执行时 readyState 仍是 'loading'，
 * 也就是各模块 init() 还没跑（下拉框还没选项、事件还没绑定）。
 * 早先直接在解析期断言 DOM，量到的其实是空壳，一批检查会假红。
 */
function __runSmoke() {
const issues = [];
function need(sel, label) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) issues.push('缺少 ' + label);
  return el;
}
// 入口页该有的东西
need('#form-overlay', '录入表单模态框');
need('#f-photo-input', '图片文件输入');
need('#f-photo-add', '上传图片按钮');
need('#f-photo-list', '图片缩略图容器');
need('#sidebar', '侧边栏');
need('#btn-show-overview', '侧边栏「总览」入口');
need('#mail-track-card', '邮件管理「查询」卡片');
need('ship24-tracking-widget', 'Ship24 查询组件');
need('#mail-list-card', '待发/在途/妥收 列表卡片');
need('#mail-tbody', '邮件表 tbody');
need('#mail-form-overlay', '邮件记录表单模态框');
need('#m-no', '邮件号码输入框');
need('#meter-page', '邮资机戳页面');
need('#btn-show-meter', '侧边栏「邮资机戳」入口');
need('#meter-tbody', '邮资机戳表 tbody');
need('#meter-form-overlay', '邮资机戳表单模态框');
need('#mf-province', '打印网点省份下拉');
need('#mf-city', '打印网点市下拉');
need('#mf-district-container', '打印网点区县容器');
need('#mf-print-office', '打印网点输入框');
need('#mf-office-group', '打印网点候选容器');
need('#mf-notes', '邮资机戳备注框');
need('#f-meter-sort', '排序要素下拉');
need('#btn-meter-sort-dir', '升降序切换按钮');
need('#mail-return-card', '邮件管理「国际退信」卡片');
need('#return-tbody', '国际退信表 tbody');
need('#f-return-search', '国际退信搜索框');
need('#f-return-sort', '国际退信排序要素下拉');
need('#return-form-overlay', '国际退信表单模态框');
need('#mr-country-zh', '寄达国家中文名输入框');
need('#mr-country-en', '寄达国家英文名输入框');
need('#mr-country-code', '寄达国家二字代码输入框');
need('#mr-method', '寄出方式下拉');
need('#mr-mail-no', '邮件号码输入框');
need('#mr-accept-office', '境外接收互换局输入框');
need('#mr-route-rows', '邮路编辑器');
need('#mr-notes', '国际退信备注框');
need('#mr-cal-popup', '国际退信日历面板');
need('#return-detail-overlay', '寄达地详情弹窗');
need('#return-detail-route', '详情里的邮路信息容器');
need('#return-detail-notes', '详情里的备注容器');
// 网点检索：当前库 + base_old 历史归档
need('#tool-po-search-history', '网点检索「含历史归档」勾选框');
need('#tool-po-search-body', '网点检索结果表 tbody');

// 依赖模块是否都加载成功（顺序也是在这里被验证的）
const mods = [];
if (typeof ImgNaming === 'undefined') issues.push('ImgNaming 未加载');
else mods.push('ImgNaming');
if (typeof ImageCore === 'undefined') issues.push('ImageCore 未加载');
else mods.push('ImageCore(max=' + ImageCore.MAX_FILE_BYTES + ')');
if (typeof ImageEditor === 'undefined') issues.push('ImageEditor 未加载');
else mods.push('ImageEditor');
if (typeof EntryForm === 'undefined') issues.push('EntryForm 未加载');
else mods.push('EntryForm');
if (typeof Dialog === 'undefined') issues.push('Dialog 未加载');
else mods.push('Dialog');
if (typeof RecordStore === 'undefined') issues.push('RecordStore 未加载');
else mods.push('RecordStore');
if (typeof Tools === 'undefined') issues.push('Tools 未加载');
else mods.push('Tools');
// Ship24 查询组件：head 里的外部脚本 + body 里的自定义元素（离线时脚本可能没加载，只校验元素在位）
if (!document.querySelector('ship24-tracking-widget')) issues.push('缺少 Ship24 查询组件元素');
if (typeof MailStore === 'undefined') issues.push('MailStore 未加载');
else mods.push('MailStore');
if (typeof MailList === 'undefined') issues.push('MailList 未加载');
else mods.push('MailList');
if (typeof MeterStore === 'undefined') issues.push('MeterStore 未加载');
else mods.push('MeterStore');
if (typeof MeterList === 'undefined') issues.push('MeterList 未加载');
else mods.push('MeterList');
if (typeof CountryData === 'undefined') issues.push('CountryData 未加载');
else mods.push('CountryData(' + CountryData.count() + ')');
if (typeof ReturnStore === 'undefined') issues.push('ReturnStore 未加载');
else mods.push('ReturnStore');
if (typeof ReturnList === 'undefined') issues.push('ReturnList 未加载');
else mods.push('ReturnList');
// 参考库：当前库之外还有 base_old 历史归档（对比刷新 + 归档检索）
if (typeof PODatabase === 'undefined') issues.push('PODatabase 未加载');
else {
  if (typeof PODatabase.historyCount !== 'function') issues.push('PODatabase 缺少 historyCount()');
  if (typeof PODatabase.importHistory !== 'function') issues.push('PODatabase 缺少 importHistory()');
  if (typeof PODatabase.refreshFromCompare !== 'function') issues.push('PODatabase 缺少 refreshFromCompare()');
  if (typeof PODatabase.isProvisional !== 'function') issues.push('PODatabase 缺少 isProvisional()');
  mods.push('PODatabase(hist=' + PODatabase.historyCount() + ')');
}

// 邮件表：共用一张表 + 状态流转
try {
  MailStore.clear();
  const rec = MailStore.add({ sendDate: '2026-01-02', mailType: '挂号信', mailNo: 'TEST0001', fromPlace: '北京', toPlace: '南京', content: '自检数据' });
  if (MailStore.count('pending') !== 1) issues.push('MailStore 新增后「待发」计数应为 1');
  MailStore.setStatus(rec.id, 'transit');
  if (MailStore.count('pending') !== 0 || MailStore.count('transit') !== 1) issues.push('MailStore 待发→在途 流转失败');
  MailStore.setStatus(rec.id, 'delivered');
  if (MailStore.count('delivered') !== 1) issues.push('MailStore 在途→妥收 流转失败');
  MailStore.remove(rec.id);
  if (MailStore.count() !== 0) issues.push('MailStore 删除失败');
} catch (e) {
  issues.push('MailStore 读写抛出: ' + ((e && e.message) || e));
}

// 业务约定：只有「待发」出现新增按钮
try {
  const addBtn = document.getElementById('btn-mail-add');
  MailList.show('pending');
  if (addBtn.style.display === 'none') issues.push('「待发」应显示新增按钮');
  MailList.show('transit');
  if (addBtn.style.display !== 'none') issues.push('「在途」不应显示新增按钮');
  MailList.show('delivered');
  if (addBtn.style.display !== 'none') issues.push('「妥收」不应显示新增按钮');
  MailList.show('pending');
} catch (e) {
  issues.push('MailList 视图切换抛出: ' + ((e && e.message) || e));
}

// 样式是否生效（图片区的规则是新增的，路径写错就会静默失效）
const cssOk = Array.from(document.styleSheets).some((sheet) => {
  try {
    return Array.from(sheet.cssRules || []).some((r) => (r.selectorText || '').includes('.photo-thumb'));
  } catch (e) { return false; }
});
if (!cssOk) issues.push('style.css 未加载或缺少 .photo-thumb 规则');

// 邮资机戳：独立数据表 + 从日戳记录移植（移植按来源去重，且不动日戳记录）
try {
  MeterStore.clear();
  localStorage.removeItem('postmark_meter_seeded');
  RecordStore.clear();
  RecordStore.add({
    province: '北京市', city: '北京市', district: '西城区', postOffice: '中南海邮政支局',
    postalCode: '100017', institutionCode: '10001700', status: 'open', cancelDate: '2026010208',
    hasPostageMeter: true, meterModel: 'YJG-1', meterNo: 'A001',
    meterHeader: '中国邮政', meterLowerRing: '下环文字',
  });

  const seeded = MeterStore.seedFromRecords();
  if (seeded.added !== 1) issues.push('移植应新增 1 条，实际 ' + seeded.added);
  const first = MeterStore.getAll()[0] || {};
  if (first.printOffice !== '中南海邮政支局') issues.push('移植未带上打印网点');
  if (first.printDate !== '2026010208') issues.push('移植未把盖销日期当作打印日期');
  if (first.meterUpperRing !== '') issues.push('日戳记录没有上环，移植后该列应为空');
  if (first.notes !== '') issues.push('日戳记录没有备注项，移植后应为空');
  if (first.district !== '西城区') issues.push('移植未带上区县');
  if (MeterStore.seedFromRecords().added !== 0) issues.push('重复移植应按来源去重');
  if (RecordStore.getAll()[0].meterModel !== 'YJG-1') issues.push('移植不应改动日戳记录');

  const rec = MeterStore.add({ meterModel: 'X', printOffice: '测试网点', notes: '备注X' });
  MeterStore.update(rec.id, { meterUpperRing: '上环文字' });
  if (MeterStore.getById(rec.id).meterUpperRing !== '上环文字') issues.push('MeterStore 更新失败');
  if (MeterStore.getById(rec.id).notes !== '备注X') issues.push('MeterStore 备注读写失败');
  if (!MeterStore.remove(rec.id)) issues.push('MeterStore 删除失败');

  // 排序：按不同要素升 / 降序，空值一律垫底
  MeterStore.clear();
  MeterStore.add({ meterModel: 'B', printOffice: '乙局', province: '上海市', city: '上海市', printDate: '2025010100' });
  MeterStore.add({ meterModel: 'A', printOffice: '甲局', province: '北京市', city: '北京市', printDate: '2026010100' });
  MeterStore.add({ meterModel: 'C', printOffice: '丙局' });
  const byModel = MeterStore.getSorted('meterModel', 'asc').map(r => r.meterModel).join('');
  if (byModel !== 'ABC') issues.push('按型号升序应为 ABC，实际 ' + byModel);
  const dateDesc = MeterStore.getSorted('printDate', 'desc').map(r => r.meterModel).join('');
  if (dateDesc !== 'ABC') issues.push('按打印日期降序应为 ABC，实际 ' + dateDesc);
  const dateAsc = MeterStore.getSorted('printDate', 'asc').map(r => r.meterModel).join('');
  if (dateAsc !== 'BAC') issues.push('按打印日期升序应为 BAC（无日期的垫底），实际 ' + dateAsc);
  const locAsc = MeterStore.getSorted('location', 'asc').map(r => r.meterModel).join('');
  if (locAsc !== 'ABC') issues.push('按省/市/县升序应为 ABC（北京市在前），实际 ' + locAsc);

  // 侧边栏入口要真的切页，列表要渲染出 8 个字段 + 操作列
  document.getElementById('btn-show-meter').click();
  if (document.getElementById('meter-page').style.display === 'none') issues.push('点「邮资机戳」没有切到该页');
  const ths = document.querySelectorAll('#meter-table th');
  if (ths.length !== 9) issues.push('邮资机戳表头应为 9 列（7 字段 + 备注 + 操作），实际 ' + ths.length);
  const tbody = document.getElementById('meter-tbody');
  if (tbody.querySelectorAll('tr').length !== 3) issues.push('列表应有 3 行，实际 ' + tbody.querySelectorAll('tr').length);
  if (!tbody.textContent.includes('甲局') || !tbody.textContent.includes('乙局')) issues.push('列表未显示打印网点');

  // 排序控件：换要素 / 切换升降序要真的改变首行
  MeterList.setSort('printDate', 'desc');
  const dirBtn = document.getElementById('btn-meter-sort-dir');
  dirBtn.click();
  if (!dirBtn.textContent.includes('升序')) issues.push('切换排序方向后按钮文案未更新：' + dirBtn.textContent);
  if ((tbody.querySelector('tr td') || {}).textContent.trim() !== 'B') {
    issues.push('按打印日期升序时首行应为 B，实际 ' + (tbody.querySelector('tr td') || {}).textContent.trim());
  }
  dirBtn.click();
  if (!dirBtn.textContent.includes('降序')) issues.push('再次切换后按钮文案应为降序：' + dirBtn.textContent);
  if ((tbody.querySelector('tr td') || {}).textContent.trim() !== 'A') {
    issues.push('按打印日期降序时首行应为 A，实际 ' + (tbody.querySelector('tr td') || {}).textContent.trim());
  }
  const sortSel = document.getElementById('f-meter-sort');
  if (sortSel.options.length !== MeterStore.SORT_OPTIONS.length) {
    issues.push('排序下拉选项数应为 ' + MeterStore.SORT_OPTIONS.length + '，实际 ' + sortSel.options.length);
  }
  if (!tbody.textContent.includes('2026-01-01 00:00')) issues.push('列表未格式化打印日期');

  // 表单：省 / 市 / 县联动 + 网点候选建议 + 备注
  MeterStore.clear();
  MeterList.openForm(null);
  if (!document.getElementById('meter-form-overlay').classList.contains('active')) issues.push('邮资机戳表单打不开');

  const provSel = document.getElementById('mf-province');
  if (!Array.from(provSel.options).some(o => o.value === '北京市')) issues.push('省份下拉应含北京市');
  provSel.value = '北京市';
  provSel.dispatchEvent(new Event('change'));

  const citySel = document.getElementById('mf-city');
  if (citySel.disabled) issues.push('选了省份后「市」应可选');
  if (!Array.from(citySel.options).some(o => o.value === '北京市')) issues.push('直辖市应能选到同名市');
  citySel.value = '北京市';
  citySel.dispatchEvent(new Event('change'));

  const distEl = document.querySelector('#mf-district-container #mf-district')
    || document.querySelector('#mf-district-container input');
  if (!distEl || distEl.tagName !== 'SELECT') issues.push('选了「北京市」后区县应为下拉');
  else if (!Array.from(distEl.options).some(o => o.value === '西城区')) issues.push('区县下拉应含西城区');

  // 候选建议：把自己日戳记录里录入过的网点列出来
  const officeInput = document.getElementById('mf-print-office');
  // 自检与 openForm 在同一个任务里跑：此刻 overlay 的 visibility 还是 hidden
  // （样式还没重算），对隐藏元素 focus() 是空操作，focus 事件自然也不发。
  // 真实使用中这两步之间必然经过一次渲染，所以这里补一次强制重算；
  // 万一仍没拿到焦点，就直接派发 focus 事件 —— 候选逻辑与焦点从哪来无关。
  void document.body.offsetHeight;
  officeInput.focus();
  if (document.activeElement !== officeInput) officeInput.dispatchEvent(new Event('focus'));
  const sug = document.getElementById('mf-office-suggestions');
  if (!sug || sug.style.display !== 'block') {
    issues.push('聚焦打印网点后应弹出候选建议');
  } else if (!sug.textContent.includes('中南海邮政支局')) {
    issues.push('候选建议里应包含自己录入过的日戳网点');
  } else {
    const item = sug.querySelector('.po-suggestion-item');
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    if (officeInput.value !== '中南海邮政支局') issues.push('点击候选没有填入网点名称');
    if (sug.style.display === 'block') issues.push('选中候选后建议列表应收起');
    // 候选自带的区县要顺手补齐
    const dEl = document.querySelector('#mf-district-container #mf-district')
      || document.querySelector('#mf-district-container input');
    if (!dEl || dEl.value !== '西城区') issues.push('选中候选后区县未补齐，实际 ' + (dEl && dEl.value));
  }

  // 必填：省 / 市 / 网点缺一不可
  const before = MeterStore.count();
  document.getElementById('mf-province').value = '';
  document.getElementById('meter-form').dispatchEvent(new Event('submit', { cancelable: true }));
  if (MeterStore.count() !== before) issues.push('缺省份时不应入库');
  document.getElementById('mf-province').value = '北京市';
  document.getElementById('mf-city').value = '';
  document.getElementById('meter-form').dispatchEvent(new Event('submit', { cancelable: true }));
  if (MeterStore.count() !== before) issues.push('缺市时不应入库');
  document.getElementById('mf-city').value = '北京市';

  // 保存：备注与行政区要一起进库。
  // 备注故意带引号 + 伪事件属性：备注会进备注列的 title 属性，
  // esc() 不转引号，属性转义漏了就会注入出一个真的 onmouseover。
  const NOTE_XSS = '备注" onmouseover="alert(1)';
  document.getElementById('mf-notes').value = NOTE_XSS;
  document.getElementById('mf-model').value = '新型号';
  document.getElementById('meter-form').dispatchEvent(new Event('submit', { cancelable: true }));
  const saved = MeterStore.getAll().find(r => r.notes === NOTE_XSS);
  if (!saved) {
    issues.push('表单保存后找不到带备注的记录');
  } else {
    if (saved.province !== '北京市' || saved.city !== '北京市' || saved.district !== '西城区') {
      issues.push('表单保存的省/市/县不对：' + [saved.province, saved.city, saved.district].join('/'));
    }
    if (saved.printOffice !== '中南海邮政支局') issues.push('表单保存的打印网点不对：' + saved.printOffice);
    if (saved.meterModel !== '新型号') issues.push('表单保存的型号不对：' + saved.meterModel);
  }
  if (document.getElementById('meter-form-overlay').classList.contains('active')) issues.push('保存后表单应关闭');
  MeterList.closeForm();

  // 保存结果要出现在列表的备注列里，且引号不能逃出属性
  MeterList.render();
  const notesCell = document.querySelector('#meter-tbody tr td.meter-notes-cell');
  if (!notesCell || notesCell.textContent.trim() !== NOTE_XSS) {
    issues.push('备注列未按原文显示备注，实际 ' + (notesCell && notesCell.textContent.trim()));
  } else {
    if (notesCell.getAttribute('title') !== NOTE_XSS) {
      issues.push('备注列 title 未按原文转义，实际 ' + notesCell.getAttribute('title'));
    }
    if (notesCell.hasAttribute('onmouseover')) issues.push('备注里的引号逃出了 title 属性（XSS 注入）');
  }
} catch (e) {
  issues.push('邮资机戳读写/渲染抛出: ' + ((e && e.message) || e));
}

// 邮资机戳页面的版式规则（与「全部记录」共用一批选择器，删错就会静默失效）
const meterCssOk = Array.from(document.styleSheets).some((sheet) => {
  try {
    return Array.from(sheet.cssRules || []).some((r) => (r.selectorText || '').includes('#meter-page'));
  } catch (e) { return false; }
});
if (!meterCssOk) issues.push('style.css 缺少 #meter-page 版式规则');

// 国际退信 · 国家参考库：代码唯一、两位字母，中英文都能检索
try {
  const all = CountryData.all();
  if (all.length < 200) issues.push('国家参考库条目过少：' + all.length);
  if (new Set(all.map(c => c.code)).size !== all.length) issues.push('国家参考库二字代码有重复');
  if (all.some(c => !/^[A-Z]{2}$/.test(c.code) || !c.zh || !c.en)) issues.push('国家参考库存在脏数据');
  if ((CountryData.findByCode(' us ') || {}).zh !== '美国') issues.push('按二字代码取国家失败');
  if ((CountryData.findByCode('ZZZ') || null) !== null) issues.push('非法二字代码应取不到国家');
  if (CountryData.search('日本')[0].code !== 'JP') issues.push('按中文名检索国家失败');
  if (!CountryData.search('united').some(c => c.code === 'US')) issues.push('按英文名检索国家失败');
  if ((CountryData.findByEn('united kingdom') || {}).code !== 'GB') issues.push('按英文名精确匹配失败');
} catch (e) {
  issues.push('CountryData 检索抛出: ' + ((e && e.message) || e));
}

// 国际退信 · 数据层：号码 / 代码规范化、邮路结构、时间自检、排序
try {
  ReturnStore.clear();
  const rec = ReturnStore.add({
    countryZh: '美国', countryEn: 'United States', countryCode: 'us',
    sendMethod: '航空', mailNo: ' rr123456789cn ',
    sendDate: '2026-01-01', arriveDate: '2026-01-05',
    acceptOffice: 'usbosa', exportOffice: 'USBOSA',
    route: {
      nodes: ['北京互换局', '东京互换局', '旧金山互换局'],
      legs: ['CA123', ''],
    },
    notes: '测试',
  });
  const got = ReturnStore.getById(rec.id) || {};
  if (got.mailNo !== 'RR123456789CN') issues.push('邮件号码未去空格转大写：' + got.mailNo);
  if (got.countryCode !== 'US') issues.push('二字代码未规范成大写：' + got.countryCode);
  if (got.acceptOffice !== 'USBOSA') issues.push('互换局代码未规范成大写：' + got.acceptOffice);
  if (!ReturnStore.isValidMailNo('RR123456789CN')) issues.push('标准 13 位国际号码应校验通过');
  if (ReturnStore.isValidMailNo('1234567890123')) issues.push('13 位纯数字不应算标准国际号码');
  if (!ReturnStore.isMailNoLengthOk('RR123456789CN') || ReturnStore.isMailNoLengthOk('RR123')) {
    issues.push('邮件号码位数校验异常');
  }
  if (!ReturnStore.isValidOfficeCode('usbosa') || ReturnStore.isValidOfficeCode('USBOS')) {
    issues.push('互换局六位字母校验异常');
  }
  const sum = ReturnStore.routeSummary(got.route);
  if (sum !== '北京互换局 →(CA123) 东京互换局 → 旧金山互换局') issues.push('邮路摘要不对：' + sum);
  if (!ReturnStore.isRouteEmpty({ nodes: [], legs: [] })) issues.push('空邮路应判为空');
  if (ReturnStore.isRouteEmpty(got.route)) issues.push('有途经点的邮路不应判为空');
  if (ReturnStore.routeSteps(got.route).length !== 5) {
    issues.push('3 个途经点应展开成 5 步（点-运送-点-运送-点），实际 ' + ReturnStore.routeSteps(got.route).length);
  }

  // 邮路规范：末尾空点清掉、不认识的运送方式归零、legs 永远与 nodes 对齐
  // 邮路规范：末尾空点清掉、运送信息转自由文本、legs 永远与 nodes 对齐
  const norm = ReturnStore._normalizeRoute({
    nodes: ['A', 'B', ''],
    legs: ['CA123', '  K3   次 ', '多余的一段'],
  });
  if (norm.nodes.length !== 2) issues.push('邮路末尾空点应被清掉，实际 ' + JSON.stringify(norm.nodes));
  if (norm.legs.length !== 1) issues.push('邮路运送信息条数应为 nodes-1，实际 ' + norm.legs.length);
  if (norm.legs[0] !== 'CA123') issues.push('邮路运送信息被改坏：' + JSON.stringify(norm.legs[0]));
  // 旧结构 {type, no} 也要能读进来（早先要在下拉里选 航班 / 车次 / 集装箱）
  const legacy = ReturnStore._normalizeRoute({ nodes: ['A', 'B'], legs: [{ type: '航班', no: 'CA123' }] });
  if (legacy.legs[0] !== '航班 CA123') issues.push('旧版 {type,no} 邮路未兼容：' + JSON.stringify(legacy.legs[0]));

  // 时间先后自检
  if (!ReturnStore.timelineWarning({ sendDate: '2026-02-01', arriveDate: '2026-01-01' })) {
    issues.push('应报出「寄达时间早于寄出时间」');
  }
  if (ReturnStore.timelineWarning({ sendDate: '2026-01-01', arriveDate: '2026-01-02', returnDate: '', recoverDate: '2026-03-01' })) {
    issues.push('空的时间字段不应参与先后比较');
  }

  // 排序：空值一律垫底
  ReturnStore.clear();
  ReturnStore.add({ mailNo: 'RR000000001CN', sendDate: '2025-01-01', countryZh: '甲' });
  ReturnStore.add({ mailNo: 'RR000000002CN', sendDate: '2026-01-01', countryZh: '乙' });
  ReturnStore.add({ mailNo: 'RR000000003CN', countryZh: '丙' });
  const rDesc = ReturnStore.getSorted('sendDate', 'desc').map(r => r.countryZh).join('');
  if (rDesc !== '乙甲丙') issues.push('按寄出时间降序应为 乙甲丙（无日期垫底），实际 ' + rDesc);
  const rAsc = ReturnStore.getSorted('sendDate', 'asc').map(r => r.countryZh).join('');
  if (rAsc !== '甲乙丙') issues.push('按寄出时间升序应为 甲乙丙（无日期垫底），实际 ' + rAsc);
  if (ReturnStore.findByMailNo('rr000000001cn').length !== 1) issues.push('按邮件号码查重失败');
  if (ReturnStore.findByMailNo('rr000000001cn', ReturnStore.getAll().find(r => r.countryZh === '甲').id).length !== 0) {
    issues.push('查重时排除自身失败');
  }
  if (!ReturnStore.remove(ReturnStore.getAll()[0].id)) issues.push('ReturnStore 删除失败');
} catch (e) {
  issues.push('ReturnStore 读写抛出: ' + ((e && e.message) || e));
}

// 国际退信 · 界面：切页 / 列表 / 国家联动 / 邮路 / 表单校验与落库
try {
  const $id = (id) => document.getElementById(id);
  ReturnStore.clear();
  document.querySelector('#sidebar [data-page="mail-return"]').click();
  if ($id('mail-return-card').style.display === 'none') issues.push('点「国际退信」没有显示该卡片');
  if ($id('mail-list-card').style.display !== 'none') issues.push('国际退信页不应同时显示待发 / 在途 / 妥收卡片');

  const ths = document.querySelectorAll('.return-table th');
  if (ths.length !== 10) issues.push('国际退信表头应为 10 列，实际 ' + ths.length);
  if ($id('return-tbody').querySelectorAll('tr').length !== 0) issues.push('空库时列表不应有数据行');
  if ($id('return-list-empty').style.display === 'none') issues.push('空库时应显示「暂无国际退信记录」');

  // 表头文字要覆盖用户点名的每一项（邮路 / 备注收进详情弹窗，不占列）
  const headText = Array.from(ths).map(t => t.textContent.trim()).join('|');
  ['寄达国家（地区）', '寄出方式', '邮件号码', '寄出时间', '寄达时间', '返回时间', '收回时间',
   '境外接收互换局', '境外出口互换局'].forEach(h => {
    if (!headText.includes(h)) issues.push('国际退信表头缺列：' + h);
  });
  ['邮路信息', '备注', '境外接受互换局'].forEach(h => {
    if (headText.includes(h)) issues.push('国际退信表头不该再出现：' + h);
  });

  // 排序下拉：选项来自 Store，切换方向按钮要改文案
  const sortSel = $id('f-return-sort');
  if (sortSel.options.length !== ReturnStore.SORT_OPTIONS.length) {
    issues.push('国际退信排序选项数应为 ' + ReturnStore.SORT_OPTIONS.length + '，实际 ' + sortSel.options.length);
  }
  const dirBtn = $id('btn-return-sort-dir');
  dirBtn.click();
  if (!dirBtn.textContent.includes('升序')) issues.push('切换排序方向后按钮文案未更新：' + dirBtn.textContent);
  dirBtn.click();
  if (!dirBtn.textContent.includes('降序')) issues.push('再次切换后按钮文案应为降序：' + dirBtn.textContent);

  // 表单：国家三项联动
  ReturnList.openForm(null);
  if (!$id('return-form-overlay').classList.contains('active')) issues.push('国际退信表单打不开');

  const zhInput = $id('mr-country-zh');
  zhInput.focus();
  zhInput.value = '日本';
  zhInput.dispatchEvent(new Event('input'));
  const sug = $id('mr-country-suggestions');
  if (!sug || sug.style.display !== 'block') {
    issues.push('在中文名框输入后应弹出国家候选');
  } else {
    sug.querySelector('.po-suggestion-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    if (zhInput.value !== '日本') issues.push('选候选后中文名未填入：' + zhInput.value);
    if ($id('mr-country-en').value !== 'Japan') issues.push('选候选后英文名未补齐：' + $id('mr-country-en').value);
    if ($id('mr-country-code').value !== 'JP') issues.push('选候选后二字代码未补齐：' + $id('mr-country-code').value);
    if (sug.style.display === 'block') issues.push('选中候选后下拉应收起');
  }
  // 手填代码反向补齐中文名 / 英文名
  const codeInput = $id('mr-country-code');
  codeInput.value = 'de';
  codeInput.dispatchEvent(new Event('input'));
  if (zhInput.value !== '德国') issues.push('手填二字代码未反查中文名：' + zhInput.value);
  if ($id('mr-country-en').value !== 'Germany') issues.push('手填二字代码未反查英文名：' + $id('mr-country-en').value);
  codeInput.value = 'JP';
  codeInput.dispatchEvent(new Event('input'));

  // 邮路编辑器：增点 / 填运送信息 / 删点（两点之间只有一个自由输入框，不选形式）
  const addBtn = $id('mr-route-add');
  addBtn.click();
  addBtn.click();
  let nodeInputs = document.querySelectorAll('#mr-route-rows .route-node-name');
  if (nodeInputs.length !== 3) issues.push('打开表单应有 1 个空行，再点两次「添加途经点」应为 3 行，实际 ' + nodeInputs.length);
  if (document.querySelectorAll('#mr-route-rows .route-leg-type').length !== 0) {
    issues.push('两点之间不应再有「运送形式」下拉');
  }
  nodeInputs[0].value = '北京互换局';
  nodeInputs[1].value = '东京互换局';
  nodeInputs[2].value = '旧金山互换局';
  let legInputs = document.querySelectorAll('#mr-route-rows .route-leg-input');
  if (legInputs.length !== 2) issues.push('3 个途经点之间应有 2 个运送信息输入框，实际 ' + legInputs.length);
  legInputs[0].value = 'CA123';
  document.querySelector('#mr-route-rows .route-del[data-del="1"]').click();
  if (document.querySelectorAll('#mr-route-rows .route-node-name').length !== 2) issues.push('删除途经点失败');
  if (document.querySelectorAll('#mr-route-rows .route-leg-input').length !== 1) {
    issues.push('删除途经点后运送信息输入框应剩 1 个');
  }
  // 补回第三个点，便于断言保存结果（末尾一个途经点故意带引号，验证弹窗渲染的转义）
  addBtn.click();
  nodeInputs = document.querySelectorAll('#mr-route-rows .route-node-name');
  nodeInputs[0].value = '北京互换局';
  nodeInputs[1].value = '旧金山互换局';
  nodeInputs[2].value = '纽约互换局" onmouseover="alert(1)';
  legInputs = document.querySelectorAll('#mr-route-rows .route-leg-input');
  legInputs[0].value = 'CA123';
  legInputs[1].value = 'K3 次';

  // 时间：点开「寄出时间」，面板要标明在编辑哪个字段，选中日期后写回文本
  document.querySelector('#return-form .mr-date-input[data-field="sendDate"]').click();
  const calPopup = $id('mr-cal-popup');
  if (!calPopup.classList.contains('active')) issues.push('点时间框未弹出日历');
  if ($id('mr-cal-label').textContent !== '寄出时间') issues.push('日历未标明在编辑哪个时间字段：' + $id('mr-cal-label').textContent);
  calPopup.querySelector('.cal-day').click();
  const sendText = document.querySelector('#return-form .mr-date-input[data-field="sendDate"] .date-text').textContent;
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(sendText)) issues.push('选中日期后未写回寄出时间：' + sendText);
  if (calPopup.classList.contains('active')) issues.push('选中日期后日历应收起');

  // 必填：号码为空不入库（弹提示，确认后回到表单）
  const before = ReturnStore.count();
  $id('return-form').dispatchEvent(new Event('submit', { cancelable: true }));
  if (ReturnStore.count() !== before) issues.push('邮件号码为空时不应入库');
  if (!$id('dialog-overlay').classList.contains('active')) issues.push('缺邮件号码应弹出提示');
  $id('dialog-confirm').click();
  if ($id('dialog-overlay').classList.contains('active')) issues.push('点确定后提示应关闭');

  // 必填：号码位数不足同样不入库
  $id('mr-mail-no').value = 'RR123';
  $id('return-form').dispatchEvent(new Event('submit', { cancelable: true }));
  if (ReturnStore.count() !== before) issues.push('邮件号码位数不足时不应入库');
  $id('dialog-confirm').click();

  // 正常保存：备注故意带引号 + 伪事件属性，验证弹窗里的转义
  const NOTE_XSS = '备注" onmouseover="alert(1)';
  $id('mr-mail-no').value = 'RR123456789CN';
  $id('mr-accept-office').value = 'usbosa';
  $id('mr-export-office').value = ' jptyop ';
  $id('mr-method').value = 'SAL';
  $id('mr-notes').value = NOTE_XSS;
  $id('return-form').dispatchEvent(new Event('submit', { cancelable: true }));

  // 两个互换局都是六位字母：标签写明，输入时自动去非字母 / 转大写 / 限六位
  const accLabel = $id('mr-accept-office').closest('.form-group').querySelector('label').textContent;
  const expLabel = $id('mr-export-office').closest('.form-group').querySelector('label').textContent;
  if (accLabel.indexOf('六位字母') === -1) issues.push('「境外接收互换局」标签应写明六位字母');
  if (expLabel.indexOf('六位字母') === -1) issues.push('「境外出口互换局」标签应写明六位字母');
  const accInput = $id('mr-accept-office');
  accInput.value = 'us bo 123sa9';
  accInput.dispatchEvent(new Event('input'));
  if (accInput.value !== 'USBOSA') issues.push('接收互换局未按六位字母清洗：' + accInput.value);
  const expInput = $id('mr-export-office');
  expInput.value = 'jptyop7';
  expInput.dispatchEvent(new Event('input'));
  if (expInput.value !== 'JPTYOP') issues.push('出口互换局未按六位字母清洗：' + expInput.value);
  // 粘贴「六位 + 一个空格」不能被截掉最后一位（用 maxlength 就会犯这个错）
  expInput.value = 'JPTYOP ';
  expInput.dispatchEvent(new Event('input'));
  if (expInput.value !== 'JPTYOP') issues.push('粘结尾随空格时被截错：' + expInput.value);

  const saved = ReturnStore.getAll()[0];
  if (!saved) {
    issues.push('表单保存后找不到国际退信记录');
  } else {
    if (saved.mailNo !== 'RR123456789CN') issues.push('保存的邮件号码不对：' + saved.mailNo);
    if (saved.countryZh !== '日本' || saved.countryEn !== 'Japan' || saved.countryCode !== 'JP') {
      issues.push('保存的国家三项不对：' + [saved.countryZh, saved.countryEn, saved.countryCode].join('/'));
    }
    if (saved.sendMethod !== 'SAL') issues.push('保存的寄出方式不对：' + saved.sendMethod);
    if (saved.acceptOffice !== 'USBOSA') issues.push('保存的接收互换局未转大写：' + saved.acceptOffice);
    if (saved.exportOffice !== 'JPTYOP') issues.push('保存的出口互换局未去空格转大写：' + saved.exportOffice);
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(saved.sendDate)) issues.push('保存的寄出时间不对：' + saved.sendDate);
    if (saved.route.nodes.length !== 3 || saved.route.nodes[0] !== '北京互换局') {
      issues.push('保存的邮路途经点不对：' + JSON.stringify(saved.route.nodes));
    }
    if (saved.route.legs[0] !== 'CA123' || saved.route.legs[1] !== 'K3 次') {
      issues.push('保存的邮路运送信息不对：' + JSON.stringify(saved.route.legs));
    }
    if (saved.notes !== NOTE_XSS) issues.push('保存的备注不对');
  }
  if ($id('return-form-overlay').classList.contains('active')) issues.push('保存后国际退信表单应关闭');
  if (ReturnList.closeForm() !== false) issues.push('表单已关闭时 closeForm 应返回 false');

  // 编辑回填：途经点 / 运送信息要原样回到输入框（曾经因为把字符串当对象展开而显示 [object Object]）
  ReturnList.openForm(saved);
  if (ReturnList.closeForm() !== true) issues.push('表单打开时 closeForm 应返回 true');
  ReturnList.openForm(saved);
  const editNodes = Array.from(document.querySelectorAll('#mr-route-rows .route-node-name')).map(i => i.value);
  const editLegs = Array.from(document.querySelectorAll('#mr-route-rows .route-leg-input')).map(i => i.value);
  if (editNodes.length !== 3 || editNodes[0] !== '北京互换局') {
    issues.push('编辑回填的途经点不对：' + JSON.stringify(editNodes));
  }
  if (editLegs.join('|') !== 'CA123|K3 次') {
    issues.push('编辑回填的运送信息不对：' + JSON.stringify(editLegs));
  }
  if (editLegs.some(v => v.indexOf('[object') !== -1)) issues.push('运送信息回填成了 [object Object]');
  if ($id('mr-export-office').value !== 'JPTYOP') issues.push('出口互换局回填不对：' + $id('mr-export-office').value);
  ReturnList.closeForm();

  // 列表渲染：只保留 10 列（邮路 / 备注不占列）
  ReturnList.render();
  const row = document.querySelector('#return-tbody tr');
  if (!row) {
    issues.push('保存后列表没有渲染出数据行');
  } else {
    if (!row.textContent.includes('日本') || !row.textContent.includes('JP')) issues.push('列表未显示寄达国家');
    if (!row.textContent.includes('RR123456789CN')) issues.push('列表未显示邮件号码');
    if (row.querySelectorAll('td').length !== 10) {
      issues.push('国际退信数据行应为 10 列，实际 ' + row.querySelectorAll('td').length);
    }
    if (row.textContent.includes('北京互换局') || row.textContent.includes(NOTE_XSS)) {
      issues.push('邮路信息 / 备注不应出现在列表里');
    }
    // 邮件号码只是展示（查询改由 Ship24 组件承载，列表不再做跳转按钮）
    if (!row.textContent.includes('RR123456789CN')) issues.push('邮件号码应显示在列表里');

    // 单击「寄达地」→ 详情弹窗展示邮路与备注（含转义）
    const countryBtn = row.querySelector('.ret-country-btn');
    if (!countryBtn) {
      issues.push('「寄达国家（地区）」单元格应可单击查看详情');
    } else {
      countryBtn.click();
      const detail = $id('return-detail-overlay');
      if (!detail.classList.contains('active')) {
        issues.push('单击寄达地未弹出详情弹窗');
      } else {
        const routeBox = $id('return-detail-route');
        if (routeBox.textContent.indexOf('北京互换局') === -1) issues.push('详情未显示邮路信息');
        if (routeBox.textContent.indexOf('CA123') === -1) issues.push('详情未显示两点之间的运送信息');
        if (!routeBox.querySelector('.ret-detail-node') || !routeBox.querySelector('.ret-detail-leg')) {
          issues.push('详情里的途经点 / 运送信息结构不对');
        }
        if (routeBox.querySelector('[onmouseover]')) issues.push('途经点里的引号逃出了转义（XSS 注入）');
        if ($id('return-detail-notes').textContent !== NOTE_XSS) {
          issues.push('详情未按原文显示备注：' + $id('return-detail-notes').textContent);
        }
        if ($id('return-detail-notes').querySelector('[onmouseover]')) {
          issues.push('备注里的引号逃出了转义（XSS 注入）');
        }
        if (ReturnList.closeDetail() !== true) issues.push('详情弹窗打开时 closeDetail 应返回 true');
        if (detail.classList.contains('active')) issues.push('关闭后详情弹窗不应还亮着');
        if (ReturnList.closeDetail() !== false) issues.push('详情弹窗已关闭时 closeDetail 应返回 false');
      }
    }
  }

  // 搜索：命中号码 / 国家，未命中时给出「没有匹配的记录」
  const searchInput = $id('f-return-search');
  searchInput.value = 'RR123456789CN';
  searchInput.dispatchEvent(new Event('input'));
  if (document.querySelectorAll('#return-tbody tr').length !== 1) issues.push('按邮件号码搜索应命中 1 行');
  searchInput.value = '不存在的关键词';
  searchInput.dispatchEvent(new Event('input'));
  if (document.querySelectorAll('#return-tbody tr').length !== 0) issues.push('未命中时列表应为空');
  if ($id('return-list-empty').textContent.indexOf('没有匹配') === -1) issues.push('未命中时应提示「没有匹配的记录」');
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input'));
  if ($id('return-count').textContent.indexOf('共 1 条') === -1) issues.push('计数显示不对：' + $id('return-count').textContent);
  ReturnStore.clear();
} catch (e) {
  issues.push('国际退信界面抛出: ' + ((e && e.message) || e));
}

// 国际退信页面的版式规则（宽表 + 粘性表头，删错就会静默失效）
const returnCssOk = Array.from(document.styleSheets).some((sheet) => {
  try {
    return Array.from(sheet.cssRules || []).some((r) => (r.selectorText || '').includes('#return-table-wrap'));
  } catch (e) { return false; }
});
if (!returnCssOk) issues.push('style.css 缺少 #return-table-wrap 版式规则');

// 打开录入表单，确认图片区真的在工作
try {
  EntryForm.init();
  EntryForm.open();
  if (!document.getElementById('form-overlay').classList.contains('active')) {
    issues.push('录入表单打不开');
  }
  // 编辑器容器是懒创建的：这里只要它"能被创建"即可
  if (typeof ImageEditor.open !== 'function') issues.push('ImageEditor.open 不是函数');
} catch (e) {
  issues.push('EntryForm 初始化抛出: ' + ((e && e.message) || e));
}

const mk = new URLSearchParams(location.search).get('r') || 'x';
const pre = document.createElement('pre');
pre.id = 'result';
pre.textContent = '@@R:' + mk + JSON.stringify({ ok: issues.length === 0, issues, mods }) + '@@R:' + mk + ':END';
document.body.appendChild(pre);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __runSmoke);
else __runSmoke();
</script>
`;
  fs.writeFileSync(path.join(site, 'index.html'), `${html}\n${probe}`, 'utf8');

  // 目录软链接回项目：Windows 上建目录联接不需要管理员权限
  for (const d of LINKED_DIRS) {
    const target = path.join(ROOT, d);
    if (!fs.existsSync(target)) continue;
    try {
      fs.symlinkSync(target, path.join(site, d), 'junction');
      linked.push(d);
    } catch (e) {
      // 建不了联接就退回整体拷贝（慢一点，但结果一样）
      fs.cpSync(target, path.join(site, d), { recursive: true });
    }
  }
  return site;
}

/**
 * 安全删除临时站点。
 *
 * ⚠️ 必须先把目录联接摘掉再删。
 * site 里的 js / css / geo / base / node_modules 是指向真实项目的 **junction**，
 * 而 `fs.rmSync(site, { recursive: true })` 在 Windows 上会**顺着联接递归删除**，
 * 也就是把项目里对应目录的内容一起删光（2026-10-08 就这么误删过一次，
 * 当时进程被中断在半路，js/ css/ geo/ base/ 全空，node_modules 只删了一半）。
 * 所以这里对每个联接只做「解除链接」，绝不递归。
 */
function removeSite(site) {
  for (const d of LINKED_DIRS) {
    const p = path.join(site, d);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }   // 不在就跳过
    if (st.isSymbolicLink()) {
      // 目录联接：unlink 或 rmdir 都只删链接本身，不会碰目标
      try { fs.unlinkSync(p); } catch (e) { try { fs.rmdirSync(p); } catch (e2) { /* ignore */ } }
    } else if (st.isDirectory()) {
      // 退化成真实拷贝的情况，删这一层是安全的（内容在临时目录里）
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
  try { fs.rmSync(site, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function main() {
  const keep = process.argv.includes('--keep');
  const explicit = (process.argv.find((a) => a.startsWith('--browser=')) || '').slice('--browser='.length);

  const exe = BrowserTest.findBrowser(explicit);
  if (!exe) {
    console.log('\n未找到 Chrome / Edge，跳过入口页自检。\n');
    return 0;
  }

  const site = buildSite();
  // 图片写到临时目录：入口页自检不该往项目的 output/ 里塞东西
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postmark-page-'));
  process.env.POSTMARK_OUTPUT_DIR = path.join(tmpRoot, 'output');
  process.env.POSTMARK_IMAGES_DIR = path.join(tmpRoot, 'images');

  const started = await Server.start({ root: site, port: 0 });
  const { url, marker } = BrowserTest.withResultMarker(`http://127.0.0.1:${started.port}/index.html`);
  console.log(`\n浏览器: ${exe}`);
  console.log(`入口页: ${url}\n`);

  const workDir = BrowserTest.makeWorkDir('postmark-page');
  let dom = '';
  try {
    dom = await BrowserTest.runPage(exe, url, { workDir, virtualTimeMs: 60000 });
  } finally {
    await Server.stop(started.server);
    if (!keep) {
      removeSite(site);
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      console.log(`临时站点: ${site}`);
      console.log(`浏览器输出: ${workDir}`);
    }
  }

  const raw = BrowserTest.extractJson(dom, marker);
  if (!raw) {
    console.error('入口页没有产出自检结果（页面可能报错）。');
    console.error(dom.slice(-2000));
    return 1;
  }

  console.log(`已加载模块: ${raw.mods.join(', ')}`);
  if (raw.ok) {
    console.log('\n结果: 入口页渲染正常（1 通过, 0 失败）\n');
    return 0;
  }
  console.log('\n[FAIL] 入口页存在问题:');
  for (const i of raw.issues) console.log(`  - ${i}`);
  console.log('');
  return 1;
}

main().then((c) => { process.exitCode = c; }).catch((e) => {
  console.error('\n自检自身出错:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
