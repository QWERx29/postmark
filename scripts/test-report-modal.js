#!/usr/bin/env node
/**
 * 报告弹窗与日志折叠测试（不依赖 Electron / 浏览器）
 * ===================================================
 * GUI 无法在本环境里自动化，但弹窗渲染是纯函数：
 * 引擎结果 → buildCompareSpec / buildCrossSpec → DOM 树。
 * 这里用一套极小的 DOM 垫片把 js/crawler.js 跑起来，喂真实引擎产出的
 * 结果进去，验证：
 *
 *   1. 汇总卡片的数值与引擎计数一致；
 *   2. 省份下拉框：未选择时只有概览卡片（详情容器为空），选中后才建 DOM，
 *      横向对比多省时下拉框里多一个「汇总表」；
 *   3. 选中省份后的详情里，智能判别明细排在 txt_compare 原始对比之前；
 *   4. 截断提示只在真的被截断时出现，且条数与引擎 cap 一致；
 *   5. 所有外部数据一律经 textContent 赋值 —— 网点名里的 <img onerror>
 *      不会变成 DOM 节点（XSS 回归）；
 *   6. 三个日志区默认折叠、作业启动时自动展开（走真实的按钮点击链路）。
 *
 * 用法: node scripts/test-report-modal.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'crawler-engine.js'));

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  → ' + detail : ''}`); }
}

function eq(label, got, want) {
  check(label, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

// ============================================================
// 最小 DOM 垫片
// ============================================================
// 只实现 crawler.js 用到的那部分：createElement / createDocumentFragment、
// className、textContent、style、appendChild、addEventListener、classList。
// textContent 是「真」实现的简化版：赋值时清空子节点，读取时拼接子树文本。

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._listeners = {};
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      contains: (c) => set.has(c),
      _set: set,
    };
  }

  set className(v) {
    this._className = v;
    this.classList._set.clear();
    for (const c of String(v).split(/\s+/)) if (c) this.classList._set.add(c);
  }
  get className() { return this._className || ''; }

  set textContent(v) {
    this.children = [];       // 与真实 DOM 一致：赋值即清空子节点
    this._text = v === null || v === undefined ? '' : String(v);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  // innerHTML 一旦被用到就说明有拼接 HTML 的写法，测试里会把它揪出来
  set innerHTML(v) { this._usedInnerHTML = String(v); }

  /** 与真实 DOM 的 previousElementSibling 对齐（registerLog 依赖它找标题行） */
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
  }

  appendChild(node) {
    if (node && node.__fragment) {
      for (const c of node.children.slice()) this.appendChild(c);
      node.children = [];
      return node;
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** 触发监听器；返回 false 表示没有监听器 */
  fire(type, ev) {
    const l = this._listeners[type];
    if (!l || !l.length) return false;
    const e = Object.assign({ type, target: this, preventDefault() {} }, ev || {});
    for (const fn of l.slice()) fn(e);
    return true;
  }
  closest(sel) {
    const want = String(sel).replace(/^\./, '');
    let n = this;
    while (n) {
      if (n.classList && n.classList.contains(want)) return n;
      if (n.tagName && n.tagName.toLowerCase() === sel) return n;
      n = n.parentNode;
    }
    return null;
  }
  setAttribute() {}
  focus() {}
  /** loadProvinces() → updateProvinceCount() 会数已有多少个省份复选框 */
  querySelectorAll() { return []; }
}

function makeDocument() {
  const byId = new Map();
  const docListeners = {};
  const doc = {
    body: new FakeNode('body'),
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => {
      const n = new FakeNode('#text');
      n.textContent = t;
      return n;
    },
    createDocumentFragment: () => {
      const f = new FakeNode('#fragment');
      f.__fragment = true;
      return f;
    },
    // 未注册的 id 自动生成节点：init() 会一次性绑定三个面板的全部控件
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new FakeNode('div'));
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const l = docListeners[t];
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    fire: (t, ev) => {
      const l = docListeners[t] || [];
      const e = Object.assign({ type: t, target: doc, preventDefault() {} }, ev || {});
      for (const fn of l.slice()) fn(e);
    },
    _listenerCount: (t) => (docListeners[t] || []).length,
    _register(id, node) { byId.set(id, node); return node; },
  };
  return doc;
}

// ============================================================
// 装载 js/crawler.js
// ============================================================

let fakeFetch = null;

function loadCrawlerPage(doc) {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'crawler.js'), 'utf8');
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    fetch: (...args) => {
      if (!fakeFetch) return Promise.reject(new Error('测试未注入 fetch 桩'));
      return fakeFetch(...args);
    },
    Dialog: { alert: async () => {}, confirm: async () => false },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'js/crawler.js' });
  return sandbox.window.CrawlerPage;
}

// ============================================================
// DOM 遍历辅助
// ============================================================

/** 后代节点（不含自身） */
function descendants(node) {
  const out = [];
  const go = (n) => {
    for (const c of n.children || []) { out.push(c); go(c); }
  };
  go(node);
  return out;
}

function findAll(root, cls) {
  return descendants(root).filter((n) => n.classList && n.classList.contains(cls));
}

function findOne(root, cls) {
  return findAll(root, cls)[0] || null;
}

/** 顶层分段：祖先里没有 rm-sec-body 的那些 rm-section */
function topSections(root) {
  return findAll(root, 'rm-section').filter((s) => {
    let p = s.parentNode;
    while (p && p !== root) {
      if (p.classList && p.classList.contains('rm-sec-body')) return false;
      p = p.parentNode;
    }
    return true;
  });
}

/** 按标签名找（表格的 th/td/pre 是标签不是类） */
function findTag(root, tag) {
  const want = String(tag).toUpperCase();
  return descendants(root).filter((n) => n.tagName === want);
}

function headerOf(section) {
  return findOne(section, 'rm-sec-header');
}

function bodyOf(section) {
  return findOne(section, 'rm-sec-body');
}

function headerSummary(header) {
  const badge = findOne(header, 'rm-badge');
  return (badge ? badge.textContent + ' · ' : '') + header.textContent.replace(/\s+/g, ' ').trim();
}

/** 点击折叠标题（走 makeCollapsible 注册的真实监听器） */
function clickHeader(header) {
  header.fire('click', { target: header });
}

/** 报告弹窗里唯一的下拉框 */
function selectOf(body) {
  return findTag(body, 'select')[0] || null;
}

/** 下拉框所有选项的文字（含首项占位） */
function selectOptions(body) {
  const sel = selectOf(body);
  return sel ? sel.children.map((o) => o.textContent) : [];
}

/** 下拉框所有选项的 value（含首项占位）——真实浏览器选中后 sel.value 就是它 */
function selectValues(body) {
  const sel = selectOf(body);
  return sel ? sel.children.map((o) => o.value) : [];
}

/**
 * 选一个省：设 value 并触发 change（走 makeSelector 注册的真实监听器）。
 * 返回详情容器；弹窗里没有下拉框时返回 null。
 */
function pickProvince(body, value) {
  const sel = selectOf(body);
  if (!sel) return null;
  sel.value = value;
  sel.fire('change', { target: sel });
  return findOne(body, 'rm-selector-detail');
}

/**
 * 一个文件块（buildCompareFileDetail 的返回）里各子节点的角色，按顺序列出。
 * 用来断言「智能判别在上、txt_compare 在下」。
 */
function blockRoles(box) {
  return box.children.map((n) => {
    if (n.classList.contains('rm-heading')) return n.textContent;
    if (n.classList.contains('rm-footnote')) return 'footnote';
    // makePre 返回的是「pre + 可能的截断提示」的包裹 div
    if (n.classList.contains('rm-pre') || findTag(n, 'pre').length) return 'pre';
    return 'detail';
  });
}

/** 文件块里「智能判别」的明细容器（紧跟在同名小标题之后的那个 div） */
function intelBoxOf(fileBox) {
  const kids = fileBox.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].classList.contains('rm-heading') &&
        kids[i].textContent === '智能判别（语义级差异）') return kids[i + 1];
  }
  return null;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * 把省份表灌进 crawler.js —— 生产环境里 refresh() 会去 /api/crawl/provinces 拉。
 * 下拉框的中文标签与排序都依赖它，所以先喂一份「北京/天津/上海」的桩。
 */
async function loadTestProvinces(Page) {
  fakeFetch = async (url) => {
    if (/\/api\/crawl\/provinces/.test(url)) {
      return {
        ok: true, status: 200,
        json: async () => ([
          { name: '北京', abbr: 'bj', code: '110000' },
          { name: '天津', abbr: 'tj', code: '120000' },
          { name: '上海', abbr: 'sh', code: '310000' },
        ]),
      };
    }
    throw new Error('未预期的请求: ' + url);
  };
  Page.refresh();          // refresh() 不返回 loadProvinces() 的 promise，等一拍
  await settle();
  await settle();
  fakeFetch = null;
}

// ============================================================
// 1. 智能比较弹窗
// ============================================================

function testCompareModal(Page) {
  console.log('\n[1] 智能比较弹窗（buildCompareSpec）');

  const result = {
    compared: 2, added: 1, missing: 1,
    reportPath: 'E:\\tmp\\compare_report_x.txt',
    reportText: '完整报告正文',
    outputFileCount: 3, baseFileCount: 2, canApply: true,
    pairs: [
      { prefix: 'postbj', outFile: 'postbj-20260917.csv', baseFile: 'postbj+base.csv',
        status: 'compared', report: '仅有 <b>差异</b> 3 处 & 更多' },
      { prefix: 'spbbj', outFile: 'spbbj-20260917.csv', baseFile: 'spbbj+base.csv',
        status: 'compared', report: '' },
      { prefix: 'posttj', outFile: 'posttj-20260917.csv', baseFile: null, status: 'new' },
      { prefix: 'spbsh', outFile: null, baseFile: 'spbsh+base.csv', status: 'missing' },
    ],
  };

  const spec = Page._buildCompareSpec(result, () => {});
  eq('标题', spec.title, '智能比较报告');
  check('副标题含 output/base 文件数',
    /output 3 个文件/.test(spec.subtitle) && /base 2 个文件/.test(spec.subtitle),
    spec.subtitle);

  // ---- 概览：不选省份时只有卡片 ----
  const cards = findAll(spec.body, 'rm-card');
  eq('汇总卡片数', cards.length, 3);
  eq('卡片1 数值/标签', cards[0].textContent, '2对比文件对');
  eq('卡片2 数值/标签', cards[1].textContent, '1新增');
  eq('卡片3 数值/标签', cards[2].textContent, '1缺失');

  const sections = topSections(spec.body);
  eq('未选择时顶层只有完整报告一个分段', sections.length, 1);
  check('该分段是完整报告文本',
    headerOf(sections[0]).textContent.includes('完整报告文本'), headerOf(sections[0]).textContent);
  const detail = findOne(spec.body, 'rm-selector-detail');
  check('详情区存在且为空', !!detail && detail.children.length === 0);

  // ---- 下拉框：按省份去重，并按省份表顺序排 ----
  const opts = selectOptions(spec.body);
  eq('选项数（占位 + 3 个省）', opts.length, 4);
  eq('首项为占位', opts[0], '— 请选择 —');
  check('选项按省份表顺序（北京→天津→上海）',
    /^北京/.test(opts[1]) && /^天津/.test(opts[2]) && /^上海/.test(opts[3]),
    opts.slice(1).join(' | '));
  check('选项带文件数与差异提示',
    opts[1].includes('2 个文件') && opts[3].includes('1 个文件'), opts.join(' | '));
  eq('选项 value 依次为省份缩写（真实浏览器选中后据此回调）',
    selectValues(spec.body).join(','), ',bj,tj,sh');

  // ---- 选中北京：邮政与邮管两个文件的详情 ----
  const bjDetail = pickProvince(spec.body, 'bj');
  const bjHeads = findAll(bjDetail, 'rm-heading').map((h) => h.textContent);
  check('北京详情含邮政与邮管两个文件',
    bjHeads.includes('北京 · 邮政') && bjHeads.includes('北京 · 邮管'), bjHeads.join(' ; '));
  check('邮政排在邮管之前',
    bjHeads.indexOf('北京 · 邮政') < bjHeads.indexOf('北京 · 邮管'), bjHeads.join(' ; '));

  const files = findAll(bjDetail, 'rm-footnote').map((f) => f.textContent);
  check('列出 output ⟷ base 文件名',
    files.some((f) => f.includes('postbj-20260917.csv') && f.includes('postbj+base.csv')),
    files.join(' | '));

  // txt_compare 输出：有输出的原样显示，无输出的说明「内容一致」
  const pres = findAll(bjDetail, 'rm-pre').map((p) => p.textContent);
  check('对比器输出原样保留（不解析 HTML）',
    pres.some((t) => t.includes('<b>') && t.includes('差异')), pres.join(' | '));
  check('无输出的文件说明两份内容一致',
    pres.some((t) => /对比器无输出/.test(t)), pres.join(' | '));

  // 换选天津：邮管文件缺失，要说明 output 侧无对应文件
  const tjDetail = pickProvince(spec.body, 'tj');
  check('换省后详情被重建（北京内容已清空）',
    !findAll(tjDetail, 'rm-heading').some((h) => h.textContent.includes('北京')),
    findAll(tjDetail, 'rm-heading').map((h) => h.textContent).join(' ; '));
  check('新增文件给出状态说明',
    findAll(tjDetail, 'rm-pre').some((t) => /视为新增|（无对应文件）/.test(t.textContent)),
    findAll(tjDetail, 'rm-pre').map((t) => t.textContent).join(' | '));

  // 上海只有邮管侧（missing）：output 侧无文件
  const shDetail = pickProvince(spec.body, 'sh');
  check('缺失文件说明 output 侧无对应文件',
    findAll(shDetail, 'rm-pre').some((t) => /（无对应文件）/.test(t.textContent)),
    findAll(shDetail, 'rm-pre').map((t) => t.textContent).join(' | '));

  // 回到占位项应清空详情
  const back = pickProvince(spec.body, '');
  eq('选回占位项后详情清空', back.children.length, 0);

  // ---- 展开完整报告 ----
  const reportSection = topSections(spec.body)[0];
  eq('完整报告默认未构建', bodyOf(reportSection).children.length, 0);
  clickHeader(headerOf(reportSection));
  eq('完整报告内容 === reportText',
    findOne(bodyOf(reportSection), 'rm-pre').textContent, '完整报告正文');

  // ---- 底部按钮 ----
  eq('按钮列表（canApply 时含确认更新）',
    spec.buttons.map((b) => b.label).join(','), '确认更新 base');
  eq('canApply=false 时无更新按钮',
    Page._buildCompareSpec(Object.assign({}, result, { canApply: false }), () => {}).buttons.length, 0);
  eq('onApply=null 时无更新按钮', Page._buildCompareSpec(result, null).buttons.length, 0);
}

// ============================================================
// 1b. 超大报告的截断（真实场景：全国 62 文件对比 = 29.5 MB / 40 万行）
// ============================================================

function testHugeReportTruncation(Page) {
  console.log('\n[1b] 超大报告的截断保护');

  const line = '第[2 / 2]行 - 第[7]个字符开始有差异  ' + 'x'.repeat(60);
  const huge = new Array(400000).fill(line).join('\n');   // ≈ 29 MB，与实测同量级
  const result = {
    compared: 1, added: 0, missing: 0, canApply: false,
    reportPath: 'E:\\Git\\postmark\\output\\compare_report_20260917_210839.txt',
    reportText: huge, outputFileCount: 62, baseFileCount: 62,
    pairs: [{ prefix: 'postah', outFile: 'postah-20260917.csv', baseFile: 'postah+base.csv',
              status: 'compared', report: huge }],
  };

  const spec = Page._buildCompareSpec(result, null);
  const sections = topSections(spec.body);

  // 展开「完整报告文本」：不能把 29 MB 原样塞进文本节点
  const reportSection = sections[sections.length - 1];
  clickHeader(headerOf(reportSection));
  const body = bodyOf(reportSection);

  const pre = findOne(body, 'rm-pre');
  check('完整报告被截断', !!pre && pre.textContent.length < 1024 * 1024,
    pre && `${pre.textContent.length} 字符`);
  eq('截断到 3000 行', pre.textContent.split('\n').length, 3000);
  check('开头内容保留', pre.textContent.startsWith('第[2 / 2]行'));

  const note = findOne(body, 'rm-footnote');
  check('截断提示给出体积与行数',
    !!note && /内容过长（共 \d+\.\d MB），此处只显示前 3000 行。/.test(note.textContent),
    note && note.textContent);
  check('截断提示指向落盘的报告文件',
    !!note && note.textContent.includes('compare_report_20260917_210839.txt'),
    note && note.textContent);

  // 单文件详情里的 txt_compare 输出同样受保护（选中省份才建 DOM）
  const detail = pickProvince(spec.body, 'ah');
  const pairPre = findOne(detail, 'rm-pre');
  check('单文件的对比输出也被截断',
    !!pairPre && pairPre.textContent.length < 1024 * 1024,
    pairPre && `${pairPre.textContent.length} 字符`);
  eq('单文件输出同样截到 3000 行', pairPre.textContent.split('\n').length, 3000);

  // 小文本不该被加提示（避免虚报截断）
  const small = Page._buildCompareSpec(Object.assign({}, result, {
    reportText: '只有一行', pairs: [],
  }), null);
  eq('无文件对时没有下拉框', selectOf(small.body), null);
  const tiny = topSections(small.body)[0];
  clickHeader(headerOf(tiny));
  eq('小报告不加截断提示', findAll(bodyOf(tiny), 'rm-footnote').length, 0);
  eq('小报告原样显示', findOne(bodyOf(tiny), 'rm-pre').textContent, '只有一行');
}

// ============================================================
// 1c. 智能判别报告区块（对应 crawler.py 的 intelligent_compare）
// ============================================================

function testIntelligentBlock(Page) {
  console.log('\n[1c] 智能判别报告区块（buildCompareSpec）');

  const XSS = '<img src=x onerror="alert(1)">';

  // 干净的一对：不该在任何表格里出现
  const clean = {
    prefix: 'spbbj', sourceType: 'spb', newCount: 5, oldCount: 5,
    summary: { byCategory: {}, new: 0, removed: 0, blocks: 0, comprehensive: 0 },
    changes: [], unmatched1: [], unmatched2: [], blocks: [],
  };

  // 有差异的一对：名称 / 邮编 / 综合变化 + 疑似新增 + 区块
  const dirty = {
    prefix: 'postbj', sourceType: 'post', newCount: 4, oldCount: 3,
    summary: {
      byCategory: { '名称变化': 1, '邮编变化': 1, '区划变化(市)': 1 },
      new: 1, removed: 0, blocks: 1, comprehensive: 1,
    },
    changes: [
      { idx1: 0, idx2: 0, matchLevel: 'exact',
        rec1: { district: '东城区', name: '北京站邮政支局', postcode: '100001', address: '甲1号', city: '北京市' },
        rec2: { district: '东城区', name: '北京站邮政营业厅', postcode: '100001', address: '甲1号', city: '北京市' },
        categories: ['名称变化'],
        details: { name_old: '北京站邮政营业厅', name_new: '北京站邮政支局' } },
      { idx1: 1, idx2: 1, matchLevel: 'postcode',
        rec1: { district: '西城区', name: XSS, postcode: '100002', address: '乙2号', city: '北京市' },
        rec2: { district: '西城区', name: XSS, postcode: '100099', address: '乙2号', city: '北京市' },
        categories: ['邮编变化'],
        details: { postcode_old: '100099', postcode_new: '100002' } },
      { idx1: 2, idx2: 2, matchLevel: 'suspected',
        rec1: { district: '朝阳区', name: '甲地邮政所', postcode: '100010', address: '丙3号', city: '北京市' },
        rec2: { district: '朝阳区', name: '乙地邮政所', postcode: '100011', address: '丁4号', city: '天津市' },
        categories: ['区划变化(市)', '⚠综合变化(疑似不同网点被错误匹配)'],
        details: { city_old: '天津市', city_new: '北京市' } },
    ],
    // unmatched 元素是 [行号, 记录]，与 crawler.py 的元组一致
    unmatched1: [[3, { district: '海淀区', name: XSS, postcode: '100080' }]],
    unmatched2: [],
    blocks: [{
      startLine: 0, endLine: 1, district: '东城区',
      judgment: '1个网点信息发生变化；疑似1个新增',
      onlyIn1: [[3, { name: '新增点', postcode: '100080' }]],
      onlyIn2: [],
      fuzzyMatchesInBlock: [[{ name: '旧甲所', postcode: '1' }, { name: '新甲所', postcode: '2' }, '甲所']],
      changesInBlock: [{ rec1: { name: '新乙所' }, rec2: { name: '旧乙所' }, categories: ['名称变化'] }],
    }],
  };

  const base = {
    compared: 3, added: 0, missing: 0, canApply: false,
    reportPath: 'E:\\tmp\\compare_report_x.txt', reportText: '原始对比报告',
    intelligentReportPath: 'E:\\tmp\\intelligent_report_20260917_214350.txt',
    intelligentReportText: '智能判别报告正文',
    outputFileCount: 3, baseFileCount: 3,
    pairs: [
      { prefix: 'postbj', outFile: 'postbj.csv', baseFile: 'postbj+base.csv', status: 'compared', report: '' },
      { prefix: 'spbbj', outFile: 'spbbj.csv', baseFile: 'spbbj+base.csv', status: 'compared', report: '' },
    ],
    intelligent: [dirty, clean],
  };

  // ---- 没有判别结果（老引擎 / 有一侧目录为空）时弹窗保持原样 ----
  // 引擎侧这两个字段是同时有或同时无的，这里照实模拟
  const noIntel = { intelligent: undefined, intelligentReportPath: null, intelligentReportText: '' };
  const legacy = Page._buildCompareSpec(Object.assign({}, base, noIntel), null);
  eq('无 intelligent 时顶层只剩完整报告', topSections(legacy.body).length, 1);
  eq('无 intelligent 时只有 3 张概览卡', findAll(legacy.body, 'rm-card').length, 3);
  check('无 intelligent 时副标题不提判别报告',
    !/智能判别报告/.test(legacy.subtitle), legacy.subtitle);
  const empty = Page._buildCompareSpec(
    Object.assign({}, base, noIntel, { intelligent: [] }), null);
  eq('intelligent 为空数组时同样只剩完整报告', topSections(empty.body).length, 1);

  // ---- 有判别结果 ----
  const spec = Page._buildCompareSpec(base, null);
  check('副标题含智能判别报告落盘路径',
    spec.subtitle.includes('intelligent_report_20260917_214350.txt'), spec.subtitle);

  const sections = topSections(spec.body);
  eq('顶层分段数（智能判别报告全文 + 完整报告）', sections.length, 2);

  // 汇总卡片：名称/邮编/区划/疑似新增/⚠综合变化，干净的一对不产生卡片
  const cards = findAll(spec.body, 'rm-card');
  const cardText = cards.map((c) => c.textContent).join(' | ');
  check('概览卡片含各类变化', /名称变化/.test(cardText) && /邮编变化/.test(cardText) &&
    /区划变化/.test(cardText) && /疑似新增/.test(cardText) && /综合变化/.test(cardText), cardText);
  check('概览卡片数值正确',
    cards.some((c) => c.textContent === '1名称变化') &&
    cards.some((c) => c.textContent === '1区划变化') &&
    cards.some((c) => c.textContent === '1疑似新增') &&
    cards.some((c) => c.textContent === '1连续变化区块'), cardText);
  check('无差异时不出现「完全一致」卡片', !/两份数据完全一致/.test(cardText), cardText);

  // 未选择时：只有概览，详情容器是空的
  const detail = findOne(spec.body, 'rm-selector-detail');
  check('详情区存在且未选择时为空', !!detail && detail.children.length === 0);

  // 下拉框：一个省一项，标签带文件数与差异数
  const opts = selectOptions(spec.body);
  eq('选项数（占位 + 北京一个省）', opts.length, 2);
  eq('首项为占位', opts[0], '— 请选择 —');
  eq('省份项带文件数与差异数', opts[1], '北京（2 个文件 · 5 处差异）');

  // ---- 选中北京：智能判别明细在上、txt_compare 原始对比在下 ----
  const bj = pickProvince(spec.body, 'bj');
  /** rm-selector-detail 的唯一子节点就是 onPick 返回的那块 */
  const bjBox = bj.children[0];
  eq('北京详情按文件分块（邮政、邮管）', bjBox.children.length, 2);
  const postBox = bjBox.children[0];
  const spbBox = bjBox.children[1];

  const postRoles = blockRoles(postBox);
  eq('邮政块的构成（智能判别在上、原始对比在下）', postRoles.join(' → '),
    '北京 · 邮政 → footnote → 智能判别（语义级差异） → detail → ' +
    '原始对比（txt_compare）· 已对比 → pre');

  const bjHeads = findAll(bj, 'rm-heading').map((h) => h.textContent);
  check('北京详情含邮政与邮管两个文件',
    bjHeads.includes('北京 · 邮政') && bjHeads.includes('北京 · 邮管'), bjHeads.join(' ; '));
  check('邮政排在邮管之前',
    bjHeads.indexOf('北京 · 邮政') < bjHeads.indexOf('北京 · 邮管'), bjHeads.join(' ; '));
  eq('两个文件各有一段原始对比',
    bjHeads.filter((h) => /^原始对比/.test(h)).length, 2);

  const files = findAll(postBox, 'rm-footnote').map((f) => f.textContent);
  check('列出 output ⟷ base 文件名',
    files.some((f) => f.includes('postbj.csv') && f.includes('postbj+base.csv')),
    files.join(' | '));

  const postDetail = intelBoxOf(postBox);
  check('智能判别明细容器存在', !!postDetail);
  const tables = findAll(postDetail, 'rm-table');
  check('有差异的一对渲染出多张变化表', tables.length >= 4, `${tables.length} 张`);

  const headers = tables.map((t) =>
    findTag(t, 'th').map((th) => th.textContent).join('/'));
  check('名称变化表头与报告一致', headers.includes('区县/旧名称/新名称/邮编/匹配方式'), headers.join(' ; '));
  check('邮编变化表头正确', headers.includes('区县/网点名称/旧邮编/新邮编'), headers.join(' ; '));
  check('区划变化表头正确', headers.includes('网点名称/旧区划/新区划/类型'), headers.join(' ; '));
  check('疑似新增表头正确', headers.includes('区县/网点名称/邮编'), headers.join(' ; '));

  const allText = descendants(postDetail).map((n) => n.textContent).join('\u0001');
  check('匹配方式中文化（exact→精确）', allText.includes('精确'), '');
  check('区划变化类型标注为地市变化', allText.includes('地市变化'), '');
  check('区块判断语已展示', allText.includes('疑似1个新增'), '');

  // XSS：所有外部数据只做文本，绝不生成 DOM 节点
  eq('网点名中的 <img> 未变成节点', findAll(postDetail, 'img').length, 0);
  check('网点名以纯文本原样呈现', allText.includes(XSS), '');
  check('渲染全程未用 innerHTML', descendants(bj).every((n) => !n._usedInnerHTML));

  // 对比器输出原样保留（不解析 HTML）；本 fixture 无输出，走等价说明
  const postPre = findTag(postBox, 'pre')[0];
  check('无输出的文件说明两份内容一致',
    /对比器无输出/.test(postPre.textContent), postPre.textContent);

  // 区块子分段：在「有差异」段里，可展开
  const blkHeads = findAll(postDetail, 'rm-heading').map((h) => h.textContent);
  check('区块小标题列出区块数', blkHeads.includes('连续变化区块（1 个）'), blkHeads.join(' ; '));
  const blk = topSections(postDetail)
    .filter((s) => headerOf(s).textContent.includes('网点信息发生变化'));
  eq('连续变化区块子分段数', blk.length, 1);
  check('区块标题栏带判断与区县',
    headerOf(blk[0]).textContent.includes('东城区') &&
    headerOf(blk[0]).textContent.includes('疑似1个新增'), headerOf(blk[0]).textContent);
  clickHeader(headerOf(blk[0]));
  const blkBody = bodyOf(blk[0]);
  const innerHeads = findAll(blkBody, 'rm-heading').map((h) => h.textContent);
  check('区块内含疑似对应/新版独有/已匹配变化',
    innerHeads.includes('疑似对应') && innerHeads.includes('区块内新版独有') &&
    innerHeads.includes('区块内已匹配变化'), innerHeads.join(' ; '));

  // 干净的一对（邮管）：同样智能判别在上，但没有表格
  const spbRoles = blockRoles(spbBox);
  check('邮管块同样智能判别在上',
    spbRoles.indexOf('智能判别（语义级差异）') <
    spbRoles.findIndex((r) => /^原始对比/.test(r)), spbRoles.join(' → '));
  eq('干净的一对无表格', findAll(spbBox, 'rm-table').length, 0);
  check('干净的一对给出说明文字',
    /完全一致/.test(findAll(intelBoxOf(spbBox), 'rm-footnote')
      .map((n) => n.textContent).join(' | ')));

  // 换省 / 清空：详情被重建
  eq('选回占位项后详情清空', pickProvince(spec.body, '').children.length, 0);
  eq('再次选中后详情重建', pickProvince(spec.body, 'bj').children.length, 1);

  // ---- 智能判别报告全文：默认收起，展开后是 makePre ----
  check('第 1 段为智能判别报告全文',
    headerOf(sections[0]).textContent.includes('智能判别报告全文'),
    headerOf(sections[0]).textContent);
  eq('报告全文默认不构建', bodyOf(sections[0]).children.length, 0);
  clickHeader(headerOf(sections[0]));
  eq('报告全文展开后渲染正文',
    findOne(bodyOf(sections[0]), 'rm-pre').textContent, '智能判别报告正文');

  // 全干净时：汇总卡片显示 ✓，明细给一句说明
  const allClean = Page._buildCompareSpec(
    Object.assign({}, base, { intelligent: [clean] }), null);
  check('全干净时汇总卡片显示 ✓',
    findAll(allClean.body, 'rm-card').some((c) => c.textContent === '✓两份数据完全一致'));
  const cleanDetail = pickProvince(allClean.body, 'bj');
  check('全干净时明细说明两份一致',
    /完全一致/.test(findAll(cleanDetail, 'rm-footnote').map((n) => n.textContent).join(' | ')));

  // 明细被裁剪时要说清楚（cap=200），否则用户会以为变化就这么点
  const cropped = Object.assign({}, dirty, {
    changes: [dirty.changes[0]],
    summary: { byCategory: { '名称变化': 250 }, new: 0, removed: 0, blocks: 0, comprehensive: 0 },
  });
  const cropDetail = pickProvince(
    Page._buildCompareSpec(Object.assign({}, base, { intelligent: [cropped] }), null).body, 'bj');
  const notes = findAll(cropDetail, 'rm-footnote').map((n) => n.textContent).join(' | ');
  check('裁剪时提示总数与已列条数',
    /共 250 条，此处只列前 1 条/.test(notes), notes);
}

// ============================================================
// 2. 横向对比弹窗（真实引擎结果）
// ============================================================

function runCrossOnBase() {
  return new Promise((resolve, reject) => {
    const job = Engine.startCrossCompare({ useBase: true, provinces: ['北京'] });
    if (!job || !job.done) { reject(new Error('startCrossCompare 未返回 job.done')); return; }
    job.done.then(() => resolve(job)).catch(reject);
  });
}

async function testCrossModal(Page) {
  console.log('\n[2] 横向对比弹窗（真实引擎结果，base 北京）');

  let job;
  try {
    job = await runCrossOnBase();
  } catch (e) {
    check('横向对比作业完成', false, e.message);
    return;
  }
  eq('作业状态', job.state, 'done');
  const r = job.result;
  if (!r || !r.provinceCount) {
    check('北京有可对比数据', false, JSON.stringify(r && r.grand));
    return;
  }

  check('结果含 details', Array.isArray(r.details) && r.details.length === 1);
  check('结果含 reportText', typeof r.reportText === 'string' && r.reportText.length > 0);

  const spec = Page._buildCrossSpec(r);
  eq('标题', spec.title, '横向对比报告');

  // ---- 汇总卡片须与引擎计数一致 ----
  const cardText = findAll(spec.body, 'rm-card').map((c) => c.textContent);
  eq('卡片数', cardText.length, 6);
  eq('POST 记录卡片', cardText[0], String(r.grand.postTotal) + 'POST 记录');
  eq('SPB 记录卡片', cardText[1], String(r.grand.spbTotal) + 'SPB 记录');
  eq('匹配总计卡片', cardText[2], String(r.grand.match) + '匹配总计');
  eq('匹配率卡片',
    cardText[3], ((r.grand.match / r.grand.postTotal) * 100).toFixed(1) + '%匹配率');
  eq('仅 POST 卡片', cardText[4], String(r.grand.postTotal - r.grand.match) + '仅 POST');

  // ---- 未选择时只有概览 ----
  const sections = topSections(spec.body);
  eq('顶层分段数（未选择时只剩完整报告）', sections.length, 1);
  check('该分段是完整报告文本',
    headerOf(sections[0]).textContent.includes('完整报告文本'), headerOf(sections[0]).textContent);
  const emptyDetail = findOne(spec.body, 'rm-selector-detail');
  check('详情区存在且未选择时为空',
    !!emptyDetail && emptyDetail.children.length === 0);

  const opts = selectOptions(spec.body);
  eq('选项数（占位 + 1 省，单省不给汇总表）', opts.length, 2);
  eq('首项为占位', opts[0], '— 请选择 —');
  eq('省份项为省份名（匹配/总数）', opts[1],
    `北京（${r.summary[0].matchCount}/${r.summary[0].postCount}）`);

  // ---- 选中北京：省份详情 + 需人工确认的桶 ----
  const provBox = pickProvince(spec.body, r.summary[0].abbr).children[0];
  const provHead = findOne(provBox, 'rm-heading');
  check('省份详情小标题含 POST/SPB 计数',
    !!provHead && provHead.textContent.includes(`POST ${r.summary[0].postCount}`),
    provHead && provHead.textContent);

  const bucketSections = topSections(provBox);
  const nonEmpty = ['exact', 'normalized', 'suspected', 'fuzzy', 'crossDistrict']
    .filter((k) => r.details[0].counts[k] > 0).length;
  eq('桶分段数 = 有数据的桶数 + 仅单边', bucketSections.length, nonEmpty + 1);

  const bucketHeads = bucketSections.map(headerOf);
  check('第一个桶是精确匹配', bucketHeads[0].textContent.includes('精确匹配'),
    bucketHeads[0].textContent);

  // 引擎对每桶裁剪到 cap=100，完整条数只在 counts 里
  const d = r.details[0];
  eq('精确匹配完整计数（回归基准 706）', d.counts.exact, 706);
  eq('精确匹配桶被裁剪到 cap', d.buckets.exact.length, 100);
  check('精确匹配段标注的是裁剪后的条数',
    bucketHeads[0].textContent.includes('100 条'), bucketHeads[0].textContent);

  // 展开精确匹配段
  clickHeader(bucketHeads[0]);
  const exactBody = bodyOf(bucketSections[0]);
  const tbl = findOne(exactBody, 'rm-table');
  check('精确匹配段出现表格', !!tbl);
  if (tbl) {
    eq('表头', tbl.children[0].textContent, 'POST 名称SPB 名称区县邮编');
    const rows = tbl.children[1].children;
    eq('表格行数 = 桶长度', rows.length, 100);
    eq('首行 4 列', rows[0].children.length, 4);
    check('首行有真实中文网点名', /[\u4e00-\u9fa5]/.test(rows[0].textContent), rows[0].textContent);
  }
  const note = findOne(exactBody, 'rm-footnote');
  check('出现截断提示「还有 606 条」', !!note && /还有 606 条/.test(note.textContent),
    note && note.textContent);

  // 完整报告段：默认收起，展开后等于 reportText
  const lastSection = sections[sections.length - 1];
  eq('完整报告段默认未构建', bodyOf(lastSection).children.length, 0);
  clickHeader(headerOf(lastSection));
  eq('完整报告内容 === reportText',
    findOne(bodyOf(lastSection), 'rm-pre').textContent, r.reportText);

  eq('横向对比弹窗只有关闭按钮', spec.buttons.length, 0);
}

// ============================================================
// 3. 多省折叠、截断提示与 XSS
// ============================================================

function testMultiProvinceAndSafety(Page) {
  console.log('\n[3] 多省折叠、截断提示与 XSS 防护');

  const evil = '<img src=x onerror="window.__pwned=1">';
  const rows = [];
  for (let i = 0; i < 130; i++) {
    rows.push({ postName: i === 0 ? evil : `网点${i}`, spbName: `邮管${i}`,
                district: '测试区', postcode: '100000' });
  }
  const fake = {
    provinceCount: 2, dataDir: 'E:\\tmp\\out', reportPath: null, useBase: false,
    reportText: '多省报告',
    grand: { postTotal: 200, spbTotal: 190, match: 150, exact: 130, normalized: 20,
             suspected: 0, fuzzy: 0, cross: 0 },
    summary: [
      { province: '甲省', abbr: '甲', postCount: 100, spbCount: 95, matchCount: 80,
        exact: 70, normalized: 10, suspected: 0, fuzzy: 0, cross: 0,
        postOnly: 20, spbOnly: 15, matchRate: 80 },
      { province: '乙省', abbr: '乙', postCount: 100, spbCount: 95, matchCount: 70,
        exact: 60, normalized: 10, suspected: 0, fuzzy: 0, cross: 0,
        postOnly: 30, spbOnly: 25, matchRate: 70 },
    ],
    details: [
      { province: '甲省', abbr: '甲',
        counts: { exact: 200, normalized: 0, suspected: 0, fuzzy: 0,
                  crossDistrict: 0, postOnly: 5, spbOnly: 5 },
        buckets: { exact: rows, normalized: [], suspected: [], fuzzy: [],
                   crossDistrict: [],
                   postOnly: [{ name: evil, district: '测试区', postcode: '' }],
                   spbOnly: [{ name: '甲省邮管X', district: '测试区', postcode: '' }] } },
      { province: '乙省', abbr: '乙',
        counts: { exact: 0, normalized: 0, suspected: 0, fuzzy: 0,
                  crossDistrict: 0, postOnly: 0, spbOnly: 0 },
        buckets: { exact: [], normalized: [], suspected: [], fuzzy: [],
                   crossDistrict: [], postOnly: [], spbOnly: [] } },
    ],
  };

  const spec = Page._buildCrossSpec(fake);
  const sections = topSections(spec.body);
  eq('顶层分段数（未选择时只剩完整报告）', sections.length, 1);

  // 多省时下拉框多一个「汇总表」，后接逐省选项
  const opts = selectOptions(spec.body);
  eq('选项数（占位 + 汇总表 + 2 省）', opts.length, 4);
  eq('第 2 项为汇总表', opts[1], '汇总表');
  eq('省份项带匹配/总数', opts[2] + ' | ' + opts[3], '甲省（80/100） | 乙省（70/100）');

  // ---- 选「汇总表」：多省汇总表 ----
  const summaryBox = pickProvince(spec.body, '__summary__').children[0];
  eq('汇总表小标题', findOne(summaryBox, 'rm-heading').textContent, '多省汇总');
  const sumTbl = findOne(summaryBox, 'crawler-table');
  check('汇总表出现', !!sumTbl);
  eq('汇总表表头',
    findTag(sumTbl, 'th').map((t) => t.textContent).join('/'),
    '省份/邮政/邮管/匹配/匹配率/邮政独有/邮管独有');
  eq('汇总表行数（2 省 + 合计）', findTag(sumTbl, 'tr').length - 1, 3);

  // ---- 选甲省：桶明细 ----
  const provBox = pickProvince(spec.body, '甲').children[0];
  check('省份小标题含 POST/SPB 计数',
    findOne(provBox, 'rm-heading').textContent.includes('POST 100 条'),
    findOne(provBox, 'rm-heading').textContent);
  const bucketSections = topSections(provBox);
  eq('甲省桶分段数（精确 + 仅单边）', bucketSections.length, 2);

  // 精确桶超出 cap：表格按引擎给的条数渲染，并给出截断提示
  clickHeader(headerOf(bucketSections[0]));
  const exactBody = bodyOf(bucketSections[0]);
  const exactTbl = findOne(exactBody, 'rm-table');
  eq('表格行数 = 引擎给的条数', exactTbl.children[1].children.length, 130);
  const note = findOne(exactBody, 'rm-footnote');
  check('出现截断提示「还有 70 条」', !!note && /还有 70 条/.test(note.textContent),
    note && note.textContent);

  // XSS：恶意名称必须只是文本
  const firstCell = exactTbl.children[1].children[0].children[0];
  eq('恶意名称被当作纯文本', firstCell.textContent, evil);
  eq('未创建任何子节点（未解析 HTML）', firstCell.children.length, 0);
  eq('渲染过程未使用 innerHTML',
    descendants(spec.body).filter((n) => n._usedInnerHTML).length, 0);

  // 仅单边：按区县左右对照
  const onlySection = bucketSections[bucketSections.length - 1];
  check('末个桶为仅单边', headerSummary(headerOf(onlySection)).includes('仅单边'),
    headerSummary(headerOf(onlySection)));
  eq('仅单边默认展开', bodyOf(onlySection).children.length > 0, true);
  const onlyTbl = findOne(bodyOf(onlySection), 'rm-table');
  check('仅单边出现对照表', !!onlyTbl);
  if (onlyTbl) {
    eq('仅单边表头', onlyTbl.children[0].textContent, '区县仅 POST 名称邮编仅 SPB 名称');
    const r0 = onlyTbl.children[1].children[0];
    eq('仅单边首行 4 列', r0.children.length, 4);
    eq('同区县左右对齐（左 = POST）', r0.children[1].textContent, evil);
    eq('同一行右侧为 SPB 侧', r0.children[3].textContent, '甲省邮管X');
  }

  // 乙省完全无数据：选中后不应有桶分段，但要能正常渲染
  const yiBox = pickProvince(spec.body, '乙').children[0];
  eq('无数据的省份不产生桶分段', topSections(yiBox).length, 0);

  // 选回占位项：详情清空，只剩概览
  eq('选回占位项后详情清空', pickProvince(spec.body, '').children.length, 0);
}

// ============================================================
// 4. 折叠交互
// ============================================================

function testCollapseBehaviour(Page) {
  console.log('\n[4] 折叠交互');

  const spec = Page._buildCrossSpec({
    provinceCount: 1, dataDir: 'x', reportPath: null, reportText: 'R',
    grand: { postTotal: 1, spbTotal: 1, match: 1 },
    summary: [{ province: '甲省', abbr: '甲', postCount: 1, spbCount: 1, matchCount: 1,
                matchRate: 100, postOnly: 0, spbOnly: 0 }],
    details: [],
  });

  const section = topSections(spec.body)[0];
  const head = headerOf(section);
  const body = bodyOf(section);

  eq('初始收起', body.style.display, 'none');
  eq('收起时箭头为 ▸', findOne(head, 'collapse-arrow').textContent, '▸');

  clickHeader(head);
  eq('点击后展开', body.style.display, 'block');
  eq('展开时箭头为 ▾', findOne(head, 'collapse-arrow').textContent, '▾');

  clickHeader(head);
  eq('再次点击收起', body.style.display, 'none');

  // 标题行里的按钮不应触发展开（省份标题里有「全选」按钮的场景）
  const btn = new FakeNode('button');
  head.appendChild(btn);
  head.fire('click', { target: btn });
  eq('点标题里的按钮不切换折叠', body.style.display, 'none');
}

// ============================================================
// 5. 日志折叠 + 面板端到端接线
// ============================================================

/** 造出真实的「运行日志」标题行 + <pre> 结构，并注册到 document */
function buildLogPanel(doc, preId) {
  const card = new FakeNode('div');
  const title = new FakeNode('div');
  title.className = 'tool-section-title';
  title.textContent = '运行日志';
  const pre = new FakeNode('pre');
  pre.className = 'crawler-log';
  card.appendChild(title);
  card.appendChild(pre);
  doc.body.appendChild(card);
  doc._register(preId, pre);
  return { card, title, pre };
}

async function testLogPanelAndCompareFlow(doc, Page) {
  console.log('\n[5] 日志折叠与「开始对比」端到端接线');

  const panels = {};
  for (const id of ['crawl-log', 'compare-log', 'cross-log']) panels[id] = buildLogPanel(doc, id);

  Page.init();
  check('init() 不抛错', true);

  for (const id of Object.keys(panels)) {
    const { title, pre } = panels[id];
    check(`${id}: 标题被标记为可折叠`, title.classList.contains('collapsible'));
    eq(`${id}: 默认折叠`, pre.style.display, 'none');
    eq(`${id}: 箭头为 ▸`, findOne(title, 'collapse-arrow').textContent, '▸');
    const hint = findOne(title, 'log-hint');
    check(`${id}: 标题上有日志摘要位`, !!hint);
    eq(`${id}: 摘要初始为空`, hint && hint.textContent, '');
    // 手动展开/收起
    clickHeader(title);
    eq(`${id}: 点击标题可展开`, pre.style.display, 'block');
    clickHeader(title);
  }

  // ---- 点「开始对比」→ 走 runJob 全链路 ----
  let statusCalls = 0;
  fakeFetch = async (url, opts) => {
    if (/\/api\/crawl\/start/.test(url)) {
      eq('启动请求体', JSON.parse(opts.body).kind, 'compare');
      return { ok: true, status: 200, json: async () => ({ jobId: 'j1', kind: 'compare' }) };
    }
    statusCalls++;
    return {
      ok: true, status: 200,
      json: async () => ({
        state: 'done', cursor: 2, elapsedMs: 12,
        lines: ['  开始对比…', '  对比报告已保存: D:\\x\\compare_report_1.txt'],
        result: {
          compared: 1, added: 0, missing: 0, canApply: true,
          reportPath: 'D:\\x\\compare_report_1.txt', reportText: '正文',
          outputFileCount: 1, baseFileCount: 1, pairs: [],
        },
      }),
    };
  };

  const cmpLog = panels['compare-log'];
  doc.getElementById('btn-compare-start').fire('click', { target: doc.getElementById('btn-compare-start') });
  for (let i = 0; i < 8; i++) await settle();

  eq('轮询到一次状态', statusCalls, 1);
  eq('作业启动后日志自动展开', cmpLog.pre.style.display, 'block');
  eq('日志写入了两行', cmpLog.pre.textContent.split('\n').length, 2);
  eq('标题摘要显示最新一行（行首缩进已被 trim）',
    findOne(cmpLog.title, 'log-hint').textContent,
    ' 对比报告已保存: D:\\x\\compare_report_1.txt');

  // 弹窗应已自动打开
  const overlay = findOne(doc.body, 'report-modal');
  check('对比完成后自动弹出报告弹窗', !!overlay);
  if (overlay) {
    eq('弹窗标题', findOne(overlay, 'rm-head').textContent.slice(0, 6), '智能比较报告');
    eq('弹窗底部按钮（关闭在左，主操作在右）', findOne(overlay, 'rm-actions').textContent,
      '关闭确认更新 base');
    check('body 滚动被锁定', doc.body.style.overflow === 'hidden');
  }

  // ---- Escape 关闭（app.js 也监听同一个事件，靠返回值决定是否继续关页面）----
  check('closeReport() 有弹窗时返回 true', Page.closeReport() === true);
  eq('Escape/关闭后弹窗从 DOM 移除', findAll(doc.body, 'report-modal').length, 0);
  eq('滚动恢复', doc.body.style.overflow, '');
  check('closeReport() 无弹窗时返回 false', Page.closeReport() === false);

  // 「查看上次报告」：关掉弹窗后必须还能把报告找回来
  const viewBtn = doc.getElementById('btn-compare-view-report');
  eq('对比完成后「查看上次报告」可用', viewBtn.disabled, false);
  viewBtn.fire('click', { target: viewBtn });
  const reopened = findOne(doc.body, 'report-modal');
  check('关掉后能重新打开智能比较报告', !!reopened);
  if (reopened) {
    check('重开的仍是智能比较报告',
      findOne(reopened, 'rm-head').textContent.startsWith('智能比较报告'),
      findOne(reopened, 'rm-head').textContent);
    Page.closeReport();
  }

  // 重开一次，验证遮罩点击可关闭
  doc.getElementById('btn-compare-start').fire('click', { target: doc.getElementById('btn-compare-start') });
  for (let i = 0; i < 8; i++) await settle();
  const ov2 = findOne(doc.body, 'report-modal');
  check('可重复打开', !!ov2);
  if (ov2) {
    ov2.fire('click', { target: ov2 });
    eq('点遮罩关闭', findAll(doc.body, 'report-modal').length, 0);
  }

  // ---- suspend() 应顺手关掉弹窗，避免切页后弹窗悬浮 ----
  doc.getElementById('btn-compare-start').fire('click', { target: doc.getElementById('btn-compare-start') });
  for (let i = 0; i < 8; i++) await settle();
  check('弹窗再次打开', findAll(doc.body, 'report-modal').length === 1);
  Page.suspend();
  eq('切走页面时弹窗被关闭', findAll(doc.body, 'report-modal').length, 0);
}

// ============================================================

async function main() {
  console.log('报告弹窗与日志折叠测试');

  const doc = makeDocument();
  const Page = loadCrawlerPage(doc);
  check('js/crawler.js 已加载并导出 CrawlerPage', !!Page);
  check('导出弹窗构建函数',
    typeof Page._buildCompareSpec === 'function' && typeof Page._buildCrossSpec === 'function');

  // 下拉框的中文标签与省份排序都来自 /api/crawl/provinces，先喂桩再测
  await loadTestProvinces(Page);

  testCompareModal(Page);
  testHugeReportTruncation(Page);
  testIntelligentBlock(Page);
  await testCrossModal(Page);
  testMultiProvinceAndSafety(Page);
  testCollapseBehaviour(Page);

  // [5] 用一页全新的沙箱：init() 有 inited 守卫，而 loadTestProvinces 已经
  // 触发过一次 refresh()，同实例再 init 不会重新绑定日志面板
  const doc2 = makeDocument();
  await testLogPanelAndCompareFlow(doc2, loadCrawlerPage(doc2));

  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
