/**
 * 爬虫引擎 — crawler.py 的 Node.js 移植（主进程）
 * ================================================
 * 三大功能：
 *   ① 爬取数据   中国邮政官网(POST) / 国家邮政局备案(SPB) → output/*.csv (GBK)
 *   ② 对比更新    output vs base，调用 txt_compare.exe，生成报告并回写 base
 *   ③ 横向对比    同省 POST vs SPB 多阶名称匹配，生成报告
 *
 * 与渲染进程的通信走 main.js 的本地 HTTP 服务器（与 /api/base-files 同一套机制），
 * 本模块不做任何网络监听，只暴露可被路由调用的函数。
 *
 * 与原脚本的差异（均为有意为之）：
 *   - parsePostPage 的「市」字段：弃用地址回溯，改为「抓取的区县名 + 地名表反查」
 *     （见 crawler-cities.js），更稳定。
 *   - 对比后「是否更新 base」的 input() 交互改为由 UI 二次确认后单独调用 applyBase()。
 *   - base 覆盖式更新时，涉及名称变化 / 撤销 / 疑似撤下的记录不再被直接丢掉，而是
 *     转进同目录的 base_old.csv 归档（单一文件、不分省，只存当前已没有的记录）；
 *     营业状态变化只覆盖原有内容，不进归档。见 computeBaseUpdate。
 *   - 参考库刷新挪到「对比」阶段：爬取结束只产出 output，不动应用内参考库。
 *   - 不依赖 Python，无需 requests / bs4；SPB 页面用正则解析（页面结构固定）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const iconv = require('iconv-lite');

const { cityByDistrict } = require('./crawler-cities');
const Matcher = require('./crawler-match');
const Intelligent = require('./crawler-intelligent');

// ===================== 31个省级行政区配置 =====================
// 格式: { name: 中文名(短), abbr: 缩写, code: 行政区划代码六位 }
const PROVINCES = [
  { name: '北京',   abbr: 'bj', code: '110000' },
  { name: '天津',   abbr: 'tj', code: '120000' },
  { name: '河北',   abbr: 'he', code: '130000' },
  { name: '山西',   abbr: 'sx', code: '140000' },
  { name: '内蒙古', abbr: 'nm', code: '150000' },
  { name: '辽宁',   abbr: 'ln', code: '210000' },
  { name: '吉林',   abbr: 'jl', code: '220000' },
  { name: '黑龙江', abbr: 'hl', code: '230000' },
  { name: '上海',   abbr: 'sh', code: '310000' },
  { name: '江苏',   abbr: 'js', code: '320000' },
  { name: '浙江',   abbr: 'zj', code: '330000' },
  { name: '安徽',   abbr: 'ah', code: '340000' },
  { name: '福建',   abbr: 'fj', code: '350000' },
  { name: '江西',   abbr: 'jx', code: '360000' },
  { name: '山东',   abbr: 'sd', code: '370000' },
  { name: '河南',   abbr: 'ha', code: '410000' },
  { name: '湖北',   abbr: 'hb', code: '420000' },
  { name: '湖南',   abbr: 'hn', code: '430000' },
  { name: '广东',   abbr: 'gd', code: '440000' },
  { name: '广西',   abbr: 'gx', code: '450000' },
  { name: '海南',   abbr: 'hi', code: '460000' },
  { name: '重庆',   abbr: 'cq', code: '500000' },
  { name: '四川',   abbr: 'sc', code: '510000' },
  { name: '贵州',   abbr: 'gz', code: '520000' },
  { name: '云南',   abbr: 'yn', code: '530000' },
  { name: '西藏',   abbr: 'xz', code: '540000' },
  { name: '陕西',   abbr: 'sn', code: '610000' },
  { name: '甘肃',   abbr: 'gs', code: '620000' },
  { name: '青海',   abbr: 'qh', code: '630000' },
  { name: '宁夏',   abbr: 'nx', code: '640000' },
  { name: '新疆',   abbr: 'xj', code: '650000' },
];

const COMPARE_EXE_NAME = 'txt_compare.exe';

// 通用请求头（不含 Referer，适用于邮政 API）
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

// 邮管局专用请求头（含 Referer）
const SPB_HEADERS = Object.assign({}, HEADERS, {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://zwfw.spb.gov.cn/',
});

// 邮政官网 API
const POST_API_URL = 'https://iframe.chinapost.com.cn/api/institutionalsite/findlist.do';
const POST_IFRAME_URL = 'https://iframe.chinapost.com.cn/jsp/type/institutionalsite/SiteSearchJTApi.jsp';

// 邮管局备案页面
const SPB_URL_TEMPLATE = 'https://zwfw.spb.gov.cn/sj/{}/pfyycsml?currentPage={}';
const SPB_ROOT = 'https://zwfw.spb.gov.cn';

// 直辖市（城市名 = 省名 + "市"）
const DIRECT_MUNICIPALITIES = new Set(['北京', '天津', '上海', '重庆']);

// POST 表列顺序（与 base/post*+base.csv 一致）
const POST_FIELDS = ['省', '市', '区/市/县', '网点名称', '邮编', '地址'];
// SPB 表列顺序（与 base/spb*+base.csv 一致）
const SPB_FIELDS = ['所属省', '所属市', '所属县', '场所名称', '开办业务', '详情链接'];

/** 需要重试的 HTTP 状态码（复刻 urllib3 Retry 的 status_forcelist） */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

// ===================== 邮管局省份并发 =====================
// 只对「邮管局（SPB）省份任务」生效：同一省份内部仍按页串行。
// 默认 2 是保守的工程参数，不代表邮管局官方允许的额度；上限 4 需实测后再考虑调整。
const SPB_CONCURRENCY_DEFAULT = 2;
const SPB_CONCURRENCY_MAX = 4;

/**
 * 归一化并发数。
 * - 未提供 / 空串 / 非数字 → 默认值（旧调用方行为不变）
 * - 其余取整后夹到 [1, SPB_CONCURRENCY_MAX]：0 或负数按 1（串行）处理
 * 传 1 即退化为串行，方便与并发版本做对照测试。
 */
function normalizeSpbConcurrency(value) {
  if (value === undefined || value === null || value === '') return SPB_CONCURRENCY_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return SPB_CONCURRENCY_DEFAULT;
  return Math.min(SPB_CONCURRENCY_MAX, Math.max(1, Math.floor(n)));
}

// ===================== 运行期配置（由 main.js 注入） =====================

const config = {
  outputDir: path.join(__dirname, 'output'),
  baseDir: path.join(__dirname, 'base'),
  /** txt_compare.exe 的候选路径（按序取第一个存在的） */
  compareExeCandidates: [path.join(__dirname, COMPARE_EXE_NAME)],
};

/**
 * 注入运行期目录配置。主进程启动时调用一次；
 * 独立测试脚本也可直接调用以指向任意目录。
 */
function configure(opts) {
  if (!opts) return;
  if (opts.outputDir) config.outputDir = opts.outputDir;
  if (opts.baseDir) config.baseDir = opts.baseDir;
  if (Array.isArray(opts.compareExeCandidates) && opts.compareExeCandidates.length) {
    config.compareExeCandidates = opts.compareExeCandidates;
  }
}

/** 把 app.asar 内的路径映射到 app.asar.unpacked（asar 内的 exe 无法直接执行） */
function asarUnpackPath(p) {
  const marker = 'app.asar' + path.sep;
  const idx = p.indexOf(marker);
  if (idx === -1) return p;
  return p.slice(0, idx) + 'app.asar.unpacked' + path.sep + p.slice(idx + marker.length);
}

/** 定位 txt_compare.exe，找不到返回 null */
function resolveCompareExe() {
  const candidates = [];
  for (const c of config.compareExeCandidates) {
    candidates.push(c, asarUnpackPath(c));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (e) {
      // 该候选不可访问，继续下一个
    }
  }
  return null;
}

// ===================== 作业管理 =====================

let jobSeq = 0;
const jobs = new Map();

/** 作业被用户取消时抛出，用于跳出深层循环 */
class CancelledError extends Error {
  constructor() {
    super('作业已取消');
    this.name = 'CancelledError';
  }
}

/**
 * 创建作业对象。日志以数组累积，渲染进程按 cursor 增量拉取。
 */
function createJob(kind) {
  const job = {
    id: `job${++jobSeq}_${Date.now()}`,
    kind,
    state: 'running',      // running | done | error | cancelled
    lines: [],
    cursor: 0,             // 已产出的日志行数（等于 lines.length）
    cancelled: false,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    progress: null,         // { done, total, label } — 供前端画进度条
    controllers: new Set(), // 进行中的 fetch AbortController
    stats: { retries: 0, gaveUp: 0 }, // 请求重试 / 放弃计数，作业收尾时汇总输出
  };
  jobs.set(job.id, job);
  return job;
}

/** 追加一行日志 */
function log(job, text) {
  const msg = String(text == null ? '' : text);
  job.lines.push(msg);
  job.cursor = job.lines.length;
  console.log('[Crawler] ' + msg);
}

/** 累加作业统计（供收尾时报告重试/放弃次数） */
function bumpStat(job, key, n = 1) {
  if (!job || !job.stats) return;
  job.stats[key] = (job.stats[key] || 0) + n;
}

function checkCancelled(job) {
  if (job.cancelled) throw new CancelledError();
}

/** 可取消的 sleep：被取消时提前返回，由调用方的 checkCancelled 抛出 */
function sleep(ms, job) {
  return new Promise((resolve) => {
    if (!job || job.cancelled) return resolve();
    const timer = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (job.cancelled) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    // 正常结束时清掉轮询
    setTimeout(() => clearInterval(poll), ms + 50);
  });
}

/**
 * 查询作业状态。
 * @param {string} jobId
 * @param {number} cursor 只返回该位置之后的新日志
 */
function getStatus(jobId, cursor) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const from = Math.max(0, Math.min(Number(cursor) || 0, job.lines.length));
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    lines: job.lines.slice(from),
    cursor: job.lines.length,
    progress: job.progress,
    result: (job.state === 'running') ? null : job.result,
    error: job.error,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

/** 取消作业：置标志位并中断进行中的请求 */
function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'running') return false;
  job.cancelled = true;
  for (const ctl of job.controllers) {
    try { ctl.abort(); } catch (e) { /* 已结束 */ }
  }
  job.controllers.clear();
  return true;
}

/** 清理已结束的旧作业，避免长时间运行后内存累积 */
function pruneJobs(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt && now - job.finishedAt > maxAgeMs) {
      jobs.delete(id);
    }
  }
}

/** 是否存在指定类型的运行中作业（防止同类型任务并发） */
function hasRunningJob(kind) {
  for (const job of jobs.values()) {
    if (job.kind === kind && job.state === 'running') return true;
  }
  return false;
}

/**
 * 统一的作业执行包装：负责状态流转与异常归类。
 * 同步返回 job（异步执行在后台推进），job.done 可用于等待完成（测试用）。
 */
function runJob(kind, fn) {
  pruneJobs();
  const job = createJob(kind);
  job.done = (async () => {
    try {
      job.result = await fn(job);
      job.state = job.cancelled ? 'cancelled' : 'done';
    } catch (e) {
      if (e instanceof CancelledError || job.cancelled) {
        job.state = 'cancelled';
        log(job, '  [已取消] 作业被用户中断');
      } else {
        job.state = 'error';
        job.error = e && e.message ? e.message : String(e);
        log(job, `  [错误] ${job.error}`);
      }
    } finally {
      job.finishedAt = Date.now();
      job.controllers.clear();
    }
    return job;
  })();
  return job;
}

// ===================== HTTP：手动 cookie jar + 重试 =====================

/** 极简 cookie jar（对应 requests.Session 的 cookie 行为） */
function createSession() {
  return { cookies: new Map() };
}

function cookieHeader(session) {
  if (!session || session.cookies.size === 0) return '';
  const parts = [];
  for (const [k, v] of session.cookies) parts.push(`${k}=${v}`);
  return parts.join('; ');
}

function storeCookies(session, res) {
  if (!session) return;
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = [raw];
  }
  for (const line of list) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) session.cookies.set(name, value);
    }
  }
}

/** 指数退避：第 n 次重试等待 2^n 秒（对应 urllib3 backoff_factor=2） */
function backoffMs(attempt) {
  return Math.pow(2, attempt) * 1000;
}

/**
 * 带 cookie 与重试的请求。
 * 复刻 urllib3 Retry(total=5, backoff_factor=2, status_forcelist=[429,500,502,503,504])。
 * @returns {Promise<Response>}
 */
async function sessionFetch(session, job, url, options = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const timeout = opts.timeout || 45000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    checkCancelled(job);
    const ctl = new AbortController();
    job.controllers.add(ctl);
    const timer = setTimeout(() => ctl.abort(), timeout);

    try {
      const headers = Object.assign({}, options.headers || {});
      const ck = cookieHeader(session);
      if (ck) headers['Cookie'] = ck;

      const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: ctl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      job.controllers.delete(ctl);
      storeCookies(session, res);

      if (RETRY_STATUS.has(res.status) && attempt < maxAttempts) {
        const wait = backoffMs(attempt);
        bumpStat(job, 'retries');
        log(job, `    [重试 ${attempt}/${maxAttempts}] HTTP ${res.status}，${wait / 1000}s 后重试`);
        await sleep(wait, job);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      job.controllers.delete(ctl);
      if (job.cancelled) throw new CancelledError();
      lastError = e;
      if (attempt < maxAttempts) {
        const wait = backoffMs(attempt);
        bumpStat(job, 'retries');
        log(job, `    [重试 ${attempt}/${maxAttempts}] ${e.message}，${wait / 1000}s 后重试`);
        await sleep(wait, job);
      }
    }
  }
  throw lastError || new Error(`请求失败: ${url}`);
}

/**
 * 邮管局页面专用 GET：带异常处理与退避重试（对应 crawler.py 的 safe_get）。
 * @param {string} [tag] 日志前缀（并发抓取时带上省份名，便于定位交错日志）
 * @returns {Promise<string|null>} 页面文本，失败返回 null
 */
async function safeGet(session, job, url, maxAttempts = 3, tag = '') {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    checkCancelled(job);
    try {
      const res = await sessionFetch(session, job, url, { headers: SPB_HEADERS }, {
        maxAttempts: 1,          // 重试由本函数的外层循环负责
        timeout: 45000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return decodePage(buf);
    } catch (e) {
      if (job.cancelled) throw new CancelledError();
      bumpStat(job, 'retries');
      log(job, `${tag}    [重试 ${attempt}/${maxAttempts}] ${e.message}`);
      if (attempt < maxAttempts) await sleep(Math.pow(2, attempt) * 1000, job);
    }
  }
  bumpStat(job, 'gaveUp');
  log(job, `${tag}    [放弃] 多次重试后仍失败: ${url}`);
  return null;
}

/**
 * 解码网页字节流。
 * 邮管局页面实测为 UTF-8；为兼容可能的变动，先尝试严格 UTF-8，
 * 失败则回退 GBK（对应 requests 的 apparent_encoding 探测）。
 */
function decodePage(buf) {
  // 有 BOM 时直接按 BOM 解码
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return iconv.decode(buf, 'gbk');
  }
}

// ===================== 中国邮政官网爬取 =====================

/** 调用邮政官网 JSON API 获取一页数据 */
async function fetchPostPage(session, job, page, provinceName, size = 100) {
  const params = new URLSearchParams({
    act: 'list',
    page: String(page),
    size: String(size),
    community: 'ChinaPostJT',
    province: provinceName,
  });
  const res = await sessionFetch(session, job, POST_API_URL, {
    method: 'POST',
    headers: Object.assign({}, HEADERS, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body: params.toString(),
  }, { timeout: 30000 });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('接口返回的不是合法 JSON');
  }
}

/**
 * 解析邮政官网 JSON 响应，提取有效字段（省/市/区/网点名称/邮编/地址）。
 *
 * 「市」字段的填充（已按需求改造）：
 *   用抓取到的区县名 county 查地名表 crawler-cities.js，按省作用域反查市名。
 *   未命中时的降级顺序：county 本身以「市」结尾 → 取 county；
 *   直辖市 → 省名 + 「市」；其余留空，交由渲染端 _correctCity 用邮编前缀兜底。
 *   —— 不再做原脚本的地址回溯截取。
 */
function parsePostPage(data, provinceName = '') {
  const records = (data && data.list) || [];
  const result = [];

  for (const item of records) {
    const postcode = String(item.zipcode || '').trim();
    // 仅保留6位数字邮编
    if (!/^\d{6}$/.test(postcode)) continue;

    let name = String(item.sitename || '').trim();
    const suffix = String(item.sitenameSuffix || '').trim();
    if (suffix) name += suffix;
    // 无名称的记录无意义（且会让后续匹配出现空键）
    if (!name) continue;

    const county = String(item.county || '').trim();
    const address = String(item.address || '').trim();

    // 1. 省：优先从 JSON 提取，否则使用传入的省份名
    const province =
      String(item.province || '').trim() ||
      String(item.provinceName || '').trim() ||
      String(item.PROVINCE || '').trim() ||
      provinceName;

    // 2. 市：接口无 city 字段，用区县名 + 地名表反查
    let city = String(item.city || '').trim() ||
               String(item.cityName || '').trim() ||
               String(item.CITY || '').trim();
    if (!city) {
      city = cityByDistrict(province, county);
    }
    if (!city) {
      if (county && county.endsWith('市')) {
        // county 字段本身就是市名（如「东莞市」）
        city = county;
      } else if (DIRECT_MUNICIPALITIES.has(provinceName)) {
        city = provinceName + '市';
      }
      // 仍未命中则留空：渲染端 _correctCity 阶段3 会用邮编前缀兜底
    }

    result.push({
      '省': province,
      '市': city,
      '区/市/县': county,
      '网点名称': name,
      '邮编': postcode,
      '地址': address,
    });
  }
  return result;
}

/** 爬取指定省份邮政官网所有网点数据 */
async function crawlPostProvince(session, job, provinceName) {
  // 先访问 iframe 页面获取 cookies
  try {
    const iframeUrl = POST_IFRAME_URL + '?' + new URLSearchParams({
      community: 'ChinaPostJT',
      prov: provinceName,
    }).toString();
    await sessionFetch(session, job, iframeUrl, { headers: HEADERS }, { timeout: 30000 });
  } catch (e) {
    if (job.cancelled) throw new CancelledError();
    log(job, `    [警告] 获取cookies失败: ${e.message}`);
  }

  const allData = [];
  let page = 1;
  let total = null;

  while (true) {
    checkCancelled(job);
    let data;
    try {
      data = await fetchPostPage(session, job, page, provinceName);
    } catch (e) {
      if (job.cancelled) throw new CancelledError();
      log(job, `    [错误] 第${page}页请求失败: ${e.message}`);
      break;
    }

    if (!data.success) break;

    const pageData = parsePostPage(data, provinceName);
    if (pageData.length === 0) break;

    allData.push(...pageData);

    if (total === null) {
      total = Number(data.total) || 0;
      log(job, `    邮政官网: 共 ${total} 条记录`);
      if (total === 0) break;
    }

    // 判断是否已抓完（接口每页固定 100 条）
    if (page * 100 >= total) break;
    page++;
  }

  return allData;
}

// ===================== 邮管局备案爬取 =====================

/** 去掉 HTML 标签并解码实体，等价于 BeautifulSoup 的 get_text(strip=True) */
function stripTags(html) {
  let s = String(html).replace(/<[^>]*>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  return s.replace(/\s+/g, ' ').trim();
}

/** 从 <a ...> 标签的属性串中取出 href */
function extractHref(attrs) {
  const m = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
  if (!m) return '';
  return m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] || ''));
}

/**
 * 解析邮管局备案公示页面，提取表格数据。
 * 对应 crawler.py 的 parse_spb_page，用正则替代 BeautifulSoup
 * （页面表格结构固定：<table><tr><td><a>…，已在真实页面上验证）。
 */
function parseSpbPage(html, pageUrl, job, tag = '') {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) rows.push(m[1]);

  if (rows.length === 0) {
    log(job, `${tag}    [警告] 未找到表格数据: ${pageUrl}`);
    return [];
  }

  const pageData = [];
  for (const tr of rows.slice(1)) {          // 跳过表头
    const tds = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let t;
    while ((t = tdRe.exec(tr)) !== null) tds.push(t[1]);
    if (tds.length < 5) continue;

    // 前五列通常包含 <a> 标签
    const cells = [];
    let ok = true;
    for (let i = 0; i < 5; i++) {
      const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(tds[i]);
      if (!a) { ok = false; break; }
      cells.push({ href: extractHref(a[1]), text: stripTags(a[2]) });
    }
    if (!ok) continue;

    let detailLink = '';
    try {
      detailLink = new URL(cells[0].href || '', SPB_ROOT).href;
    } catch (e) {
      detailLink = cells[0].href || '';
    }

    pageData.push([
      cells[0].text, cells[1].text, cells[2].text,
      cells[3].text, cells[4].text, detailLink,
    ]);
  }

  return pageData;
}

/**
 * 爬取指定省份邮管局备案所有页面数据。
 * 省内分页保持串行；并发只发生在省份任务之间（见 startCrawl 的 worker pool）。
 * @param {string} [tag] 日志前缀（带省份名，并发日志交错时便于定位）
 */
async function crawlSpbProvince(session, job, areaCode, tag = '') {
  const allData = [];
  let page = 1;
  let consecutiveEmpty = 0;
  const maxEmpty = 3;          // 连续空页数达到此值则停止

  while (true) {
    checkCancelled(job);
    const url = SPB_URL_TEMPLATE.replace('{}', areaCode).replace('{}', String(page));

    const html = await safeGet(session, job, url, 3, tag);
    if (!html) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= maxEmpty) {
        log(job, `${tag}    邮管局: 连续${maxEmpty}页失败，停止抓取`);
        break;
      }
      page++;
      continue;
    }

    const pageData = parseSpbPage(html, url, job, tag);
    if (pageData.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= maxEmpty) {
        log(job, `${tag}    邮管局: 连续${maxEmpty}页无数据，停止抓取`);
        break;
      }
    } else {
      allData.push(...pageData);
      consecutiveEmpty = 0;
    }

    page++;
    await sleep(300, job);          // 礼貌性延迟
  }

  log(job, `${tag}    邮管局: 共获取 ${allData.length} 条记录`);
  return allData;
}

// ===================== 文件保存（GBK） =====================

/**
 * 按 Python csv.writer 的默认方言拼一行：
 * 含分隔符/引号/换行的字段加引号，内部引号翻倍。
 */
function csvLine(fields) {
  return fields.map((f) => {
    const s = f == null ? '' : String(f);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

/** 以 GBK 写 CSV（不可编码字符由 iconv-lite 替换为 ?，对应 errors="replace"） */
function writeGbkCsv(filepath, headerFields, rows) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const lines = [csvLine(headerFields)];
  for (const row of rows) lines.push(csvLine(Array.isArray(row) ? row : headerFields.map(f => row[f])));
  // Python csv.writer 使用 CRLF 行终止符
  const text = lines.join('\r\n') + '\r\n';
  fs.writeFileSync(filepath, iconv.encode(text, 'gbk'));
}

/** 保存邮政官网数据为 CSV */
function savePostCsv(job, data, abbr, dateStr, outputDir) {
  const filepath = path.join(outputDir, `post${abbr}-${dateStr}.csv`);
  writeGbkCsv(filepath, POST_FIELDS, data);
  log(job, `    已保存: ${filepath} (${data.length} 条)`);
  return filepath;
}

/** 保存邮管局数据为 CSV */
function saveSpbCsv(job, data, abbr, dateStr, outputDir) {
  const filepath = path.join(outputDir, `spb${abbr}-${dateStr}.csv`);
  writeGbkCsv(filepath, SPB_FIELDS, data);
  log(job, `    已保存: ${filepath} (${data.length} 条)`);
  return filepath;
}

// ===================== CSV 读取（横向对比用） =====================

/** 解析 CSV 文本为行数组（支持引号转义），等价 Python csv.reader */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 读取 CSV（GBK），返回行数组 */
function readCsvRows(filepath) {
  const buf = fs.readFileSync(filepath);
  // 极少数文件可能是 UTF-8（手工编辑过），带 BOM 时按 UTF-8 处理
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return parseCsvText(buf.slice(3).toString('utf8'));
  }
  return parseCsvText(iconv.decode(buf, 'gbk'));
}

/** 读取 POST CSV，返回记录列表 */
function readPostCsv(filepath) {
  const records = [];
  try {
    const rows = readCsvRows(filepath);
    for (let i = 1; i < rows.length; i++) {      // 跳过表头
      const row = rows[i];
      if (row.length >= 6) {
        records.push({
          province: row[0].trim(),
          city: row[1].trim(),
          district: row[2].trim(),
          name: row[3].trim(),
          postcode: row[4].trim(),
          address: row[5].trim(),
        });
      }
    }
  } catch (e) {
    console.error(`[Crawler] 读取 POST 文件失败: ${filepath} - ${e.message}`);
    return [];
  }
  return records;
}

/** 读取 SPB CSV，返回记录列表 */
function readSpbCsv(filepath) {
  const records = [];
  try {
    const rows = readCsvRows(filepath);
    for (let i = 1; i < rows.length; i++) {      // 跳过表头
      const row = rows[i];
      if (row.length >= 6) {
        records.push({
          province: row[0].trim(),
          city: row[1].trim(),
          district: row[2].trim(),
          name: row[3].trim(),
          services: row[4].trim(),
          detail_link: row[5].trim(),
        });
      }
    }
  } catch (e) {
    console.error(`[Crawler] 读取 SPB 文件失败: ${filepath} - ${e.message}`);
    return [];
  }
  return records;
}

/** 在 dataDir 中查找以 prefix 开头的最新 CSV 文件。返回完整路径或 null。 */
function findLatestFile(dataDir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch (e) {
    return null;
  }
  let best = null;
  let bestTime = -1;
  for (const f of entries) {
    if (!f.startsWith(prefix) || !f.endsWith('.csv')) continue;
    // 日期部分: prefix-YYYYMMDD.csv
    const datePart = f.slice(prefix.length + 1, f.length - 4);
    if (!/^\d{8}$/.test(datePart)) continue;
    const t = Date.UTC(
      Number(datePart.slice(0, 4)),
      Number(datePart.slice(4, 6)) - 1,
      Number(datePart.slice(6, 8))
    );
    if (Number.isNaN(t)) continue;
    if (t > bestTime) { bestTime = t; best = f; }
  }
  return best ? path.join(dataDir, best) : null;
}

// ===================== 时间戳 =====================

function pad2(n) { return String(n).padStart(2, '0'); }

/** YYYYMMDD */
function dateStr(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** YYYYMMDD_HHMMSS */
function stampStr(d = new Date()) {
  return `${dateStr(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** YYYY-MM-DD HH:MM:SS */
function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ===================== 功能①：爬取数据 =====================

/**
 * 单省 · 邮政官网抓取（对应原 crawlOneProvince 的 POST 段）。
 * 始终串行调度，请求节奏与改造前一致；session 由本任务独占。
 */
async function crawlPostProvinceTask(job, prov, dateStrVal, outputDir) {
  const session = createSession();
  try {
    checkCancelled(job);
    log(job, '  >> 抓取邮政官网数据...');
    const postData = await crawlPostProvince(session, job, prov.name);
    if (postData.length === 0) {
      log(job, '    [提示] 邮政官网无数据');
      return { postCount: 0, postFile: null };
    }
    const postFile = savePostCsv(job, postData, prov.abbr, dateStrVal, outputDir);
    return { postCount: postData.length, postFile };
  } catch (e) {
    if (e instanceof CancelledError || job.cancelled) throw new CancelledError();
    log(job, `    [错误] 邮政官网爬取异常: ${e.message}`);
    return { postCount: 0, postFile: null };
  }
}

/**
 * 单省 · 邮管局抓取（对应原 crawlOneProvince 的 SPB 段）。
 * 这是并发池的调度单位：每省一个独立会话，省内分页仍串行。
 */
async function crawlSpbProvinceTask(job, prov, dateStrVal, outputDir) {
  const session = createSession();
  const tag = `[${prov.name}/${prov.abbr}] `;
  try {
    checkCancelled(job);
    log(job, `${tag}>> 抓取邮管局备案数据...`);
    const spbData = await crawlSpbProvince(session, job, prov.code, tag);
    if (spbData.length === 0) {
      log(job, `${tag}    [提示] 邮管局无数据`);
      return { spbCount: 0, spbFile: null };
    }
    const spbFile = saveSpbCsv(job, spbData, prov.abbr, dateStrVal, outputDir);
    return { spbCount: spbData.length, spbFile };
  } catch (e) {
    if (e instanceof CancelledError || job.cancelled) throw new CancelledError();
    log(job, `${tag}    [错误] 邮管局爬取异常: ${e.message}`);
    return { spbCount: 0, spbFile: null };
  }
}

/**
 * 爬取作业入口。
 *
 * 调度分两个阶段（并发只作用于邮管局，邮政官网始终保持原有串行节奏）：
 *   阶段 1  POST：逐省串行，省间沿用 interDelay；
 *   阶段 2  SPB ：有界 worker pool（spbConcurrency 个 worker），每省独占会话，
 *                 省内分页仍按页串行。只有 doPost=false 时才会退化成单阶段。
 *
 * @param {object} opts
 * @param {string[]} opts.provinces  省份短名数组（如 ['上海','北京']）
 * @param {boolean}  opts.doPost     是否爬邮政官网
 * @param {boolean}  opts.doSpb      是否爬邮管局
 * @param {number}   opts.delay      源间延迟（秒）
 * @param {number}   opts.interDelay 省间延迟（秒）
 * @param {number}   [opts.spbConcurrency] 邮管局省份并发数（默认 2，范围 1~4；1 = 串行）
 */
function startCrawl(opts = {}) {
  const wanted = Array.isArray(opts.provinces) && opts.provinces.length
    ? opts.provinces
    : PROVINCES.map(p => p.name);
  const doPost = opts.doPost !== false;
  const doSpb = opts.doSpb !== false;
  const delay = Number.isFinite(+opts.delay) ? +opts.delay : 1.0;
  const interDelay = Number.isFinite(+opts.interDelay) ? +opts.interDelay : 2.0;
  const spbConcurrency = normalizeSpbConcurrency(opts.spbConcurrency);

  return runJob('crawl', async (job) => {
    const startTime = Date.now();
    const today = dateStr();
    const outputDir = config.outputDir;
    fs.mkdirSync(outputDir, { recursive: true });

    log(job, '='.repeat(60));
    log(job, '全国邮政网点信息爬取');
    log(job, '='.repeat(60));
    log(job, `输出目录: ${outputDir}`);
    log(job, `数据来源: ${doPost ? '邮政官网 ' : ''}${doSpb ? '邮管局' : ''}`);
    log(job, `请求间隔: ${delay}s (省间 ${interDelay}s)`);

    // ---- 省份校验：未知省份只记日志、不进队列；重复省份只跑一次 ----
    // 重复省份若都进队列，两个 worker 会同时写同一个 spb<abbr>-<date>.csv，
    // 文件内容会互相覆盖，因此在这里先去重（进度条也不用为此留空位）。
    const tasks = [];
    const seen = new Set();
    for (const name of wanted) {
      const prov = PROVINCES.find(p => p.name === name);
      if (!prov) {
        log(job, `[跳过] 未知省份: ${name}`);
        continue;
      }
      if (seen.has(prov.name)) {
        log(job, `[跳过] 重复省份: ${name}`);
        continue;
      }
      seen.add(prov.name);
      tasks.push(prov);
    }
    const total = tasks.length;
    log(job, `省份数量: ${total}`);

    // 结果槽位按输入顺序预留：完成后直接填槽，输出顺序不受网络快慢影响
    const results = tasks.map(prov => ({
      province: prov.name,
      abbr: prov.abbr,
      postCount: 0,
      spbCount: 0,
      postFile: null,
      spbFile: null,
    }));

    // done 只按「已完成处理的省份」计数，不再使用循环下标（并发完成顺序不固定）
    let done = 0;
    const setProgress = (label) => {
      job.progress = { done, total, label: label || '' };
    };
    const finishProvince = (prov) => {
      done++;
      setProgress(prov.name);
    };
    setProgress('');            // 首个状态轮询就能看到正确的分母

    log(job, '-'.repeat(60));

    // ---- 阶段 1：邮政官网（串行，保留原节奏） ----
    if (doPost && total > 0) {
      log(job, doSpb ? '[阶段 1/2] 邮政官网抓取（串行）' : '[抓取] 邮政官网（串行）');
      for (let i = 0; i < total; i++) {
        checkCancelled(job);
        const prov = tasks[i];
        log(job, '');
        log(job, `[${i + 1}/${total}] ${prov.name} (${prov.abbr})`);
        setProgress(prov.name);

        Object.assign(results[i], await crawlPostProvinceTask(job, prov, today, outputDir));
        if (!doSpb) finishProvince(prov);

        if (i < total - 1) await sleep(interDelay * 1000, job);
      }
    }

    // ---- 阶段 2：邮管局（有界 worker pool） ----
    let effectiveConcurrency = 0;
    if (doSpb && total > 0) {
      effectiveConcurrency = Math.min(spbConcurrency, total);
      log(job, doPost ? '[阶段 2/2] 邮管局抓取（省份并发）' : '[抓取] 邮管局（省份并发）');
      log(job, `  实际生效并发数: ${effectiveConcurrency}（配置 ${spbConcurrency}，上限 ${SPB_CONCURRENCY_MAX}）`);
      log(job, '  提示: 并发仅作用于省份任务，单个省份内部仍按页串行请求');

      // 两个阶段之间保留「源间间隔」，对应原流程 POST → SPB 之间的停顿
      if (doPost && delay > 0) await sleep(delay * 1000, job);

      let next = 0;
      const worker = async () => {
        while (!job.cancelled) {
          const i = next++;
          if (i >= total) return;

          const prov = tasks[i];
          // 已取消时不再领新省份；已领到的任务由 fetch 的 AbortController 中断
          checkCancelled(job);

          log(job, '');
          log(job, `[${i + 1}/${total}] ${prov.name} (${prov.abbr})`);
          setProgress(prov.name);

          Object.assign(results[i], await crawlSpbProvinceTask(job, prov, today, outputDir));
          finishProvince(prov);

          if (i < total - 1) await sleep(interDelay * 1000, job);
        }
      };

      // 等所有 worker 退出后再收尾：取消时不能留下仍在写文件的后台任务
      const settled = await Promise.allSettled(
        Array.from({ length: effectiveConcurrency }, () => worker())
      );
      checkCancelled(job);
      const failure = settled.find(s => s.status === 'rejected');
      if (failure) throw failure.reason;
    }

    const totalPost = results.reduce((s, r) => s + r.postCount, 0);
    const totalSpb = results.reduce((s, r) => s + r.spbCount, 0);
    const okCount = results.filter(r => r.postCount > 0 || r.spbCount > 0).length;

    log(job, '');
    log(job, '='.repeat(60));
    log(job, `爬取完成: ${okCount}/${total} 个省份有数据`);
    log(job, `邮政官网合计: ${totalPost} 条`);
    log(job, `邮管局合计  : ${totalSpb} 条`);
    if (doSpb) log(job, `邮管局并发  : ${effectiveConcurrency}`);
    log(job, `请求统计    : 重试 ${job.stats.retries} 次，放弃 ${job.stats.gaveUp} 次`);
    log(job, `耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    log(job, '='.repeat(60));

    return {
      date: today,
      outputDir,
      results,
      totalPost,
      totalSpb,
      okCount,
      provinceCount: total,
      spbConcurrency: effectiveConcurrency,
      files: results.flatMap(r => [r.postFile, r.spbFile]).filter(Boolean),
    };
  });
}

// ===================== 功能②：对比并更新 base =====================

/**
 * base_old 归档文件名（与 base 同目录）。
 *
 * 与 base/{前缀}+base.csv 不同，归档是**一个**文件、不分省，只保存
 * 「当前库里已经没有、但历史上存在过」的记录：
 *   - 名称变化 —— 更名前的旧名称那一条（新名称照常进 base）
 *   - 撤销     —— 名称带「（撤销）」标记的那一条（不进 base）
 *   - 疑似撤下 —— output 里已经不存在的旧记录
 * 营业状态变化（暂停/装修中/临时停业/假期营业…）只覆盖原有内容，不进归档。
 */
const BASE_OLD_FILE = 'base_old.csv';

/** base_old.csv 的统一列 —— POST 与 SPB 混排，靠「来源」列区分 */
const BASE_OLD_FIELDS = [
  '来源', '省', '市', '区/市/县', '网点名称', '邮编', '地址',
  '开办业务', '详情链接', '归档原因', '归档时间',
];

/** 归档原因（写进 base_old.csv 的「归档原因」列） */
const ARCHIVE_REASON = {
  rename: '名称变化',
  revoked: '撤销',
  removed: '疑似撤下',
};

/** 对比时生成的「应用后 base 快照」暂存目录名（位于 output/ 下） */
const REF_STAGE_DIR = '_refstage';

/** base_old.csv 的完整路径 */
function baseOldPath() {
  return path.join(config.baseDir, BASE_OLD_FILE);
}

/**
 * 记录身份键：来源 + 属地 + 名称。
 * 用来判断一条归档记录是否「重新出现在当前库里」（名称含状态括注，
 * 所以「XX（暂停）」与「XX」是两条不同的记录）。
 */
function recordKey(source, r) {
  return [source, r.province, r.city, r.district, r.name]
    .map((s) => String(s == null ? '' : s).trim()).join('\u0001');
}

/** 名称里是否带「（撤销）」标记 —— 撤销的网点不再进当前库 */
function isRevoked(r) {
  return Intelligent.extractStatus(r && r.name).statuses.indexOf('已撤销') >= 0;
}

/** 名称里是否带「撤销」字样（宽口径，不要求带括号：含「已撤销」等写法） */
function hasRevokedMark(r) {
  return /撤销/.test(String((r && r.name) || ''));
}

/**
 * base_old 查表键：来源 + 属地 + 名称（去掉「（撤销）」「（暂停）」等状态括注）。
 *
 * 归档里存的名称可能带状态标记，而 output 里同一条记录可能只有其中一种形态
 * （例如归档是「XX（撤销）」、output 是「XX」；或反过来），所以先剥掉状态括注再比。
 * 只用于「是否已在历史库」判断，不替代 recordKey（后者仍是精确身份键，
 * 决定归档记录是否因重新出现而移出）。
 */
function archivedLookupKey(source, r) {
  // extractStatus 只认「（撤销）」；这里再兼容「（已撤销）」「（ 撤销 ）」等写法
  const cleanName = Intelligent.extractStatus(r && r.name).clean
    .replace(/[（(]\s*(?:已)?撤销\s*[）)]/g, '')
    .trim();
  return [source, r && r.province, r && r.city, r && r.district, cleanName]
    .map((s) => String(s == null ? '' : s).trim()).join('\u0001');
}

/**
 * 构造「不算新增」过滤器：带「撤销」字样、且已在 base_old 历史库中的 output 记录。
 *
 * 这类记录本来就该归档、不会进当前库，但智能判别是把 output 与 base 逐条比，
 * base 里没有它们，于是每次都算成疑似新增网点。按需求把它们从「新增」统计中剔除。
 *
 * @param {'post'|'spb'} sourceType
 * @param {object[]} archiveEntries readBaseOld() 的结果
 * @returns {(r: object) => boolean}
 */
function makeArchivedRevokedFilter(sourceType, archiveEntries) {
  const keys = new Set();
  for (const e of archiveEntries || []) {
    // 只收集同来源的归档：POST 与 SPB 的属地/名称可能撞车，不能交叉匹配
    if (String(e.source || '') !== sourceType) continue;
    keys.add(archivedLookupKey(sourceType, e));
  }
  if (keys.size === 0) return () => false;
  return (r) => hasRevokedMark(r) && keys.has(archivedLookupKey(sourceType, r));
}

/** 统一归档字段：把 POST / SPB 的字段差异抹平成一行的「专属列」 */
function archiveFields(source, r) {
  return source === 'spb'
    ? ['', '', r.services || '', r.detail_link || '']
    : [r.postcode || '', r.address || '', '', ''];
}

/** 一条记录 → base_old.csv 的一行 */
function archiveRow(source, r, reason, at) {
  return [
    source,
    r.province || '', r.city || '', r.district || '', r.name || '',
  ].concat(archiveFields(source, r), [reason || '', at || '']);
}

/**
 * 读取 base_old.csv（GBK 统一列）。文件不存在或不可读返回 []。
 * 表头按列名定位，列顺序变化、将来追加列都不会读错。
 */
function readBaseOld(filepath) {
  const entries = [];
  let rows;
  try {
    rows = readCsvRows(filepath);
  } catch (e) {
    return entries;                             // 没有归档文件就是空归档
  }
  if (!rows.length) return entries;

  const header = rows[0].map((s) => String(s == null ? '' : s).trim());
  const hasHeader = header[0] === '来源';
  const col = (name, fallback) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const idx = {
    source: hasHeader ? 0 : -1,
    province: col('省', 1), city: col('市', 2), district: col('区/市/县', 3),
    name: col('网点名称', 4), postcode: col('邮编', 5), address: col('地址', 6),
    services: col('开办业务', 7), link: col('详情链接', 8),
    reason: col('归档原因', 9), at: col('归档时间', 10),
  };
  const cell = (row, i) => String((i >= 0 && row[i] != null) ? row[i] : '').trim();

  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length || !row.some((f) => String(f == null ? '' : f).trim())) continue;
    const source = idx.source >= 0 ? cell(row, idx.source) : 'post';
    const rec = {
      source: source === 'spb' ? 'spb' : 'post',
      province: cell(row, idx.province),
      city: cell(row, idx.city),
      district: cell(row, idx.district),
      name: cell(row, idx.name),
      postcode: cell(row, idx.postcode),
      address: cell(row, idx.address),
      services: cell(row, idx.services),
      detail_link: cell(row, idx.link),
      reason: cell(row, idx.reason),
      archivedAt: cell(row, idx.at),
    };
    if (!rec.name || !rec.province) continue;   // 脏行直接跳过
    entries.push(rec);
  }
  return entries;
}

/** 写 base_old.csv（GBK 统一列） */
function writeBaseOld(filepath, entries) {
  writeGbkCsv(filepath, BASE_OLD_FIELDS,
    (entries || []).map((e) => archiveRow(e.source, e, e.reason, e.archivedAt)));
}

/** 从文件名中提取前缀，如 postbj, spbsh */
function getFilePrefix(filename) {
  const m = /^(post|spb)([a-z]+)/.exec(filename);
  return m ? m[0] : null;
}

/** 扫描目录下所有 CSV，按前缀建映射 */
function scanByPrefix(dir) {
  const map = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return map;
  }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const prefix = getFilePrefix(f);
    if (prefix) map.set(prefix, f);
  }
  return map;
}

/** 解码外部进程输出（txt_compare.exe 在中文 Windows 下输出 GBK） */
function decodeProcessOutput(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return utf8;
  } catch (e) {
    return iconv.decode(buf, 'gbk');
  }
}

/** 调用 txt_compare.exe 比较两个文件，返回 {stdout, stderr} */
function runTxtCompare(exePath, file1, file2, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exePath, ['--file1', file1, '--file2', file2, '--display', 'detailed'], {
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* 已退出 */ }
      reject(new Error('对比超时 (>120s)'));
    }, timeoutMs);

    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: decodeProcessOutput(Buffer.concat(outChunks)),
        stderr: decodeProcessOutput(Buffer.concat(errChunks)),
      });
    });
  });
}

/**
 * 对比作业：扫描 output 与 base，逐前缀调用 txt_compare.exe，
 * 生成报告写入 output/compare_report_*.txt。**不修改 base**。
 */
function startCompare() {
  return runJob('compare', async (job) => {
    const outputDir = config.outputDir;
    const baseDir = config.baseDir;
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });

    const compareExePath = resolveCompareExe();
    if (!compareExePath) {
      const tried = config.compareExeCandidates.join(' | ');
      log(job, `[错误] 未找到对比工具 ${COMPARE_EXE_NAME}`);
      log(job, `  已尝试: ${tried}`);
      throw new Error(`未找到对比工具 ${COMPARE_EXE_NAME}`);
    }

    const outputMap = scanByPrefix(outputDir);
    const baseMap = scanByPrefix(baseDir);

    if (outputMap.size === 0 && baseMap.size === 0) {
      log(job, '[提示] output 和 base 文件夹中均无 CSV 文件，无需对比。');
      return {
        compared: 0, added: 0, missing: 0,
        reportPath: null, reportText: '', pairs: [],
        intelligentReportPath: null, intelligentReportText: '', intelligent: [],
        outputFileCount: 0, baseFileCount: 0, canApply: false,
      };
    }

    const reportLines = [];
    reportLines.push(`对比报告 — ${humanTime()}`);
    reportLines.push('='.repeat(60));
    reportLines.push(`output 目录: ${path.resolve(outputDir)}  (${outputMap.size} 个文件)`);
    reportLines.push(`base   目录: ${path.resolve(baseDir)}  (${baseMap.size} 个文件)`);
    reportLines.push('='.repeat(60));

    const allPrefixes = Array.from(new Set([...outputMap.keys(), ...baseMap.keys()])).sort();

    let compared = 0;
    let added = 0;
    let missing = 0;
    const pairs = [];          // 供前端展示的逐个前缀结果

    log(job, '');
    log(job, '  正在执行文件对比...');
    log(job, '  ' + '-'.repeat(50));

    for (const prefix of allPrefixes) {
      checkCancelled(job);
      job.progress = { done: compared + added + missing, total: allPrefixes.length, label: prefix };
      const outFile = outputMap.get(prefix);
      const baseFile = baseMap.get(prefix);

      if (outFile && baseFile) {
        const outPath = path.join(outputDir, outFile);
        const basePath = path.join(baseDir, baseFile);
        try {
          const { stdout, stderr } = await runTxtCompare(compareExePath, outPath, basePath);
          reportLines.push(`\n--- ${prefix} ---`);
          reportLines.push(`  Output : ${outFile}`);
          reportLines.push(`  Base   : ${baseFile}`);
          if (stdout) reportLines.push(stdout.replace(/\s+$/, ''));
          if (stderr) reportLines.push(`  [stderr]: ${stderr.replace(/\s+$/, '')}`);
          log(job, `    对比: ${prefix} ... 完成`);
          compared++;
          pairs.push({ prefix, outFile, baseFile, status: 'compared', report: stdout });
        } catch (e) {
          reportLines.push(`\n--- ${prefix} ---`);
          reportLines.push(`  [错误] 对比失败: ${e.message}`);
          log(job, `    对比: ${prefix} ... 失败: ${e.message}`);
          pairs.push({ prefix, outFile, baseFile, status: 'error', error: e.message });
          // 找不到 exe 后续也无法处理，与原脚本一致直接跳出
          if (/ENOENT/.test(e.message || '') || /not found/i.test(e.message || '')) break;
        }
      } else if (outFile) {
        reportLines.push(`\n--- ${prefix} ---`);
        reportLines.push(`  Output : ${outFile}`);
        reportLines.push('  Base   : (无对应文件，视为新增)');
        added++;
        pairs.push({ prefix, outFile, baseFile: null, status: 'new' });
      } else if (baseFile) {
        reportLines.push(`\n--- ${prefix} ---`);
        reportLines.push('  Output : (无对应文件)');
        reportLines.push(`  Base   : ${baseFile} (output 中缺失)`);
        missing++;
        pairs.push({ prefix, outFile: null, baseFile, status: 'missing' });
      }
    }

    // 两份报告共用同一个时间戳，和 crawler.py 一样（report_date 只取一次）
    const stamp = stampStr();

    const reportPath = path.join(outputDir, `compare_report_${stamp}.txt`);

    log(job, '  ' + '-'.repeat(50));
    log(job, `  对比 ${compared} 对 | 新增 ${added} | 缺失 ${missing}`);

    // ── 智能判别分析 ──
    // crawler.py --compare 在这里还要再跑一遍：对每一对「output+base 都在」的文件做
    // 语义级判别（名称/邮编/地址/区划/营业状态/开办业务变化、疑似新增撤下、连续变化
    // 区块、⚠综合变化），产出 intelligent_report_*.txt。这段以前没移植过来。
    const intelligentSections = [];
    const intelligent = [];          // 结构化明细，供面板②弹窗渲染

    // 历史归档（base_old）里的「撤销」记录不再算新增网点，见 makeArchivedRevokedFilter
    const archiveEntries = readBaseOld(baseOldPath());

    log(job, '');
    log(job, '  正在执行智能判别分析...');
    log(job, '  ' + '-'.repeat(50));

    for (const prefix of allPrefixes) {
      checkCancelled(job);
      const outFile = outputMap.get(prefix);
      const baseFile = baseMap.get(prefix);
      if (!(outFile && baseFile)) continue;      // 只对「已对比」的前缀做智能分析

      try {
        // 数据源按 output 文件名前缀判断（post*/spb*），与原脚本 get_file_prefix 一致
        const sourceType = /^spb/.test(outFile) ? 'spb' : 'post';
        const read = sourceType === 'spb' ? readSpbCsv : readPostCsv;
        const records1 = read(path.join(outputDir, outFile));
        const records2 = read(path.join(baseDir, baseFile));

        // 「带撤销字样 + 已在 base_old」的记录不计入新增网点
        const ignoreNew = makeArchivedRevokedFilter(sourceType, archiveEntries);
        const res = Intelligent.intelligentCompare(
          records1, records2, sourceType, outFile, { ignoreNew }
        );

        intelligentSections.push('');
        intelligentSections.push(...res.lines);
        intelligent.push({
          prefix,
          sourceType,
          newCount: res.newCount,
          oldCount: res.oldCount,
          ignoredNew: res.ignoredNew || 0,   // 已归档撤销、不计入新增的条数
          summary: res.summary,
          changes: res.changes,
          unmatched1: res.unmatched1,
          unmatched2: res.unmatched2,
          blocks: res.blocks,
        });
        const ignoredNew = res.ignoredNew || 0;
        log(job, `    智能分析: ${prefix} ... 完成` +
          (ignoredNew ? `（已归档撤销 ${ignoredNew} 条不计新增）` : ''));
      } catch (e) {
        log(job, `    智能分析: ${prefix} ... 失败: ${e.message}`);
        intelligentSections.push('');
        intelligentSections.push(`--- ${prefix} 智能分析失败 ---`);
        intelligentSections.push(`  错误: ${e.message}`);
      }
    }
    log(job, '  ' + '-'.repeat(50));

    // ── 单独保存智能判别报告 ──
    let intelligentReportPath = null;
    let intelligentReportText = '';
    if (intelligentSections.length) {
      const iLines = [];
      iLines.push(`智能判别报告 — ${humanTime()}`);
      iLines.push('='.repeat(60));
      iLines.push(`output 目录: ${path.resolve(outputDir)}  (${outputMap.size} 个文件)`);
      iLines.push(`base   目录: ${path.resolve(baseDir)}  (${baseMap.size} 个文件)`);
      iLines.push('='.repeat(60));
      iLines.push('');
      iLines.push(...intelligentSections);

      intelligentReportText = iLines.join('\n');
      intelligentReportPath = path.join(outputDir, `intelligent_report_${stamp}.txt`);
      fs.writeFileSync(intelligentReportPath, intelligentReportText, 'utf8');
      log(job, `  智能判别报告已保存: ${intelligentReportPath}`);
    }

    if (outputMap.size === 0) {
      log(job, '\n  output 中无文件，无需更新 base。');
    }

    // ── 更新方案 ──
    // 对比阶段就把「确认更新 base」之后的样子算出来：
    //   ① 报告里写清楚哪些记录会被归档，人工确认时有据可依；
    //   ② 生成一份应用后的 base 快照 + base_old，供渲染进程立即刷新参考库
    //      —— 参考库只在对比时更新，爬取结束后不再自动合并。
    log(job, '');
    log(job, '  正在计算更新方案...');
    log(job, '  ' + '-'.repeat(50));
    const plan = computeBaseUpdate(job);

    reportLines.push('');
    reportLines.push('='.repeat(60));
    reportLines.push('更新方案（点「确认更新 base」后执行）');
    reportLines.push('='.repeat(60));
    reportLines.push(`  本次写入当前库记录    : ${plan.currentTotal} 条`);
    if (plan.revokedTotal) {
      reportLines.push(`  其中已撤销(不进当前库): ${plan.revokedTotal} 条`);
    }
    reportLines.push(`  base_old 归档         : ${plan.archiveTotal} 条` +
      `（本次新增 ${plan.archiveAdded}` +
      (plan.archiveRestored ? ` / 移出 ${plan.archiveRestored}` : '') + '）');
    for (const reason of Object.keys(plan.archiveByReason)) {
      reportLines.push(`    ${reason}: ${plan.archiveByReason[reason]} 条`);
    }
    log(job, `  本次写入当前库 ${plan.currentTotal} 条` +
      (plan.revokedTotal ? `（另有已撤销 ${plan.revokedTotal} 条不进当前库）` : ''));
    log(job, `  base_old 归档 ${plan.archiveTotal} 条（本次新增 ${plan.archiveAdded}` +
      (plan.archiveRestored ? ` / 移出 ${plan.archiveRestored}` : '') + '）');

    fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
    log(job, `  对比报告已保存: ${reportPath}`);

    // ── 应用后的 base 快照（暂存）──
    // 渲染进程按这份快照全量替换应用内参考库；base_old 一起放进去，
    // 于是「当前网点 + 历史归档」在对比完成的那一刻就是可检索的。
    const stageDir = path.join(outputDir, REF_STAGE_DIR);
    let refLibrary = null;
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true });
      writeBaseSnapshot(stageDir, plan, { includeBaseOnly: true });
      const stageOldPath = path.join(stageDir, BASE_OLD_FILE);
      writeBaseOld(stageOldPath, plan.archiveEntries);

      const files = plan.prefixes
        .map((p) => ({ name: `${p.prefix}+base.csv`, sourceType: p.sourceType }))
        .filter((f) => fs.existsSync(path.join(stageDir, f.name)));

      refLibrary = {
        stageDir,
        files,
        archivePath: stageOldPath,
        archiveRelPath: `${REF_STAGE_DIR}/${BASE_OLD_FILE}`,
        currentTotal: plan.currentTotal,
        revokedTotal: plan.revokedTotal,
        archiveTotal: plan.archiveTotal,
        archiveAdded: plan.archiveAdded,
        archiveByReason: plan.archiveByReason,
      };
      log(job, `  参考库快照已生成: ${files.length} 个文件 → ${stageDir}`);
    } catch (e) {
      log(job, `  [警告] 生成参考库快照失败，本次不刷新应用内参考库: ${e.message}`);
    }

    // 前端展示用：报告正文（太长时截断，完整内容在报告文件里）
    const reportText = reportLines.join('\n');

    return {
      compared, added, missing,
      reportPath,
      reportText,
      pairs,
      // 智能判别（crawler.py 的 intelligent_compare 那一段）
      intelligentReportPath,
      intelligentReportText,
      intelligent,
      outputFileCount: outputMap.size,
      baseFileCount: baseMap.size,
      canApply: outputMap.size > 0,
      // 更新方案 + 参考库快照（渲染进程据此刷新 PODatabase）
      plan: {
        currentTotal: plan.currentTotal,
        revokedTotal: plan.revokedTotal,
        archiveTotal: plan.archiveTotal,
        archiveAdded: plan.archiveAdded,
        archiveRestored: plan.archiveRestored,
        archiveByReason: plan.archiveByReason,
        // 逐文件的本次归档明细，供弹窗逐省展示
        byPrefix: plan.prefixes.filter((p) => p.outFile).map((p) => ({
          prefix: p.prefix,
          current: p.current.length,
          revoked: p.revoked.length,
          renamed: p.archived ? p.archived.renamed : 0,
          removed: p.archived ? p.archived.removed : 0,
        })),
      },
      refLibrary,
    };
  });
}

/**
 * 计算「对比 → 更新 base」要做的事，对比与回写共用同一份方案：
 *
 *   当前库（写进 base/{前缀}+base.csv）
 *     = output 的记录，带「（撤销）」标记的除外；
 *   归档（写进 base/base_old.csv）
 *     = 更名前后的旧名称记录、带「（撤销）」的记录、output 里已消失的旧记录。
 *
 * 归档文件是累积的：与已有 base_old.csv 合并后，**只保留当前库里已经没有的**
 * 记录（某网点重新出现时会被移出归档）。已有归档条目保持其原始归档原因与时间。
 *
 * 不传 job 时静默执行（供测试直接调用）。
 *
 * @returns {object} {
 *   prefixes: [{prefix, sourceType, outFile, baseFile, fields, current, revoked,
 *               outputCount, archived:{renamed,removed}}],
 *   outputMap, baseMap,
 *   archiveEntries, archiveTotal, archiveByReason,
 *   archiveAdded, archiveRestored,
 *   currentTotal, revokedTotal, at,
 * }
 */
function computeBaseUpdate(job) {
  const outputDir = config.outputDir;
  const baseDir = config.baseDir;
  const say = (t) => { if (job) log(job, t); };
  const at = humanTime();

  const outputMap = scanByPrefix(outputDir);
  const baseMap = scanByPrefix(baseDir);
  const allPrefixes = Array.from(new Set([...outputMap.keys(), ...baseMap.keys()])).sort();

  const prefixes = [];
  const currentKeys = new Set();      // 应用后仍存在的记录（判断归档是否还有效）
  const fresh = new Map();            // 本次新归档：身份键 → 条目（先到先得）
  const addArchive = (source, r, reason) => {
    const key = recordKey(source, r);
    if (!key || fresh.has(key)) return;
    fresh.set(key, Object.assign({ source, reason, archivedAt: at }, r));
  };

  let currentTotal = 0;
  let revokedTotal = 0;

  for (const prefix of allPrefixes) {
    if (job) checkCancelled(job);
    const outFile = outputMap.get(prefix);
    const baseFile = baseMap.get(prefix);
    const sourceType = /^spb/.test(prefix) ? 'spb' : 'post';
    const read = sourceType === 'spb' ? readSpbCsv : readPostCsv;
    const fields = sourceType === 'spb' ? SPB_FIELDS : POST_FIELDS;

    // 只有 base 的前缀（output 里没有）：保持不动，其记录仍算当前库
    if (!outFile) {
      const recs = baseFile ? read(path.join(baseDir, baseFile)) : [];
      for (const r of recs) currentKeys.add(recordKey(sourceType, r));
      prefixes.push({
        prefix, sourceType, outFile: null, baseFile, fields,
        current: recs, revoked: [], outputCount: 0,
      });
      continue;
    }

    const recs1 = read(path.join(outputDir, outFile));
    const recs2 = baseFile ? read(path.join(baseDir, baseFile)) : [];
    const revoked = recs1.filter(isRevoked);
    const current = recs1.filter((r) => !isRevoked(r));
    for (const r of current) currentKeys.add(recordKey(sourceType, r));

    currentTotal += current.length;
    revokedTotal += revoked.length;
    const entry = {
      prefix, sourceType, outFile, baseFile, fields,
      current, revoked, outputCount: recs1.length,
      archived: { renamed: 0, removed: 0 },     // 本次归档明细（逐文件）
    };
    prefixes.push(entry);

    // 撤销的记录一律归档（它们不会进当前库）
    for (const r of revoked) addArchive(sourceType, r, ARCHIVE_REASON.revoked);
    if (!recs2.length) {
      say(`    ${prefix}: 新增 ${current.length} 条，base 中无对照文件`);
      continue;
    }

    // 与旧版配对：名称变化 → 旧名称那条归档；剩下的旧记录 → 疑似撤下
    const m = Intelligent.matchSameSource(recs1, recs2, sourceType);
    const changes = Intelligent.classifyChanges(m.matchedPairs, sourceType);
    let renamed = 0;
    for (const c of changes) {
      if (c.categories.indexOf('名称变化') < 0) continue;
      addArchive(sourceType, c.rec2, ARCHIVE_REASON.rename);
      renamed++;
    }
    for (const [, r] of m.unmatched2) addArchive(sourceType, r, ARCHIVE_REASON.removed);

    entry.archived = { renamed, removed: m.unmatched2.length };
    say(`    ${prefix}: 当前 ${current.length} 条` +
        (revoked.length ? `（剔除已撤销 ${revoked.length} 条）` : '') +
        `，归档 更名 ${renamed} / 疑似撤下 ${m.unmatched2.length}`);
  }

  // ── 与已有归档合并 ──
  const archiveMap = new Map();
  for (const e of readBaseOld(baseOldPath())) {
    const key = recordKey(e.source, e);
    if (key && !archiveMap.has(key)) archiveMap.set(key, e);
  }
  let archiveAdded = 0;
  for (const [key, e] of fresh) {
    if (archiveMap.has(key)) continue;          // 已在归档里：保留原原因与时间
    archiveMap.set(key, e);
    archiveAdded++;
  }

  // 只存当前没有的：重新出现在当前库里的归档记录移出
  let archiveRestored = 0;
  for (const key of Array.from(archiveMap.keys())) {
    if (!currentKeys.has(key)) continue;
    archiveMap.delete(key);
    archiveRestored++;
  }

  const archiveEntries = Array.from(archiveMap.values());
  const archiveByReason = {};
  for (const e of archiveEntries) {
    const reason = e.reason || '未标注';
    archiveByReason[reason] = (archiveByReason[reason] || 0) + 1;
  }

  return {
    prefixes, outputMap, baseMap,
    archiveEntries, archiveTotal: archiveEntries.length, archiveByReason,
    archiveAdded, archiveRestored,
    currentTotal, revokedTotal, at,
  };
}

/**
 * 把方案里的「当前库」写进 dir。
 *
 * 没有撤销记录的前缀直接字节复制（保持原始编码/换行，避免无谓的重编码）；
 * 有撤销记录时才按记录重写，把「（撤销）」那几行剔出去。
 *
 * @param {string} dir 目标目录（base 本身，或对比用的暂存目录）
 * @param {object} plan computeBaseUpdate 的结果
 * @param {object} [opts]
 * @param {boolean} [opts.includeBaseOnly] 是否连「只有 base」的前缀也复制过去
 *        （暂存目录需要一份完整快照；写回 base 时它们本来就在那儿）
 */
function writeBaseSnapshot(dir, plan, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  const rewritten = [];

  for (const p of plan.prefixes) {
    if (!p.outFile) {
      if (o.includeBaseOnly && p.baseFile) {
        fs.copyFileSync(path.join(config.baseDir, p.baseFile), path.join(dir, p.baseFile));
        copied.push(p.baseFile);
      }
      continue;
    }

    const dstName = `${p.prefix}+base.csv`;
    const dst = path.join(dir, dstName);
    if (p.revoked.length === 0) {
      fs.copyFileSync(path.join(config.outputDir, p.outFile), dst);
      copied.push(dstName);
    } else {
      writeGbkCsv(dst, p.fields, p.current.map((r) => (p.sourceType === 'spb'
        ? [r.province, r.city, r.district, r.name, r.services, r.detail_link]
        : [r.province, r.city, r.district, r.name, r.postcode, r.address])));
      rewritten.push(dstName);
    }
  }

  return { written: copied.length + rewritten.length, copied, rewritten };
}

/**
 * 把 output/*.csv 覆盖为 base/{prefix}+base.csv（删除 base 中同前缀的旧文件），
 * 并把涉及名称变化 / 撤销 / 疑似撤下的记录写进 base/base_old.csv。
 * 对应 crawler.py compare_and_update 的后半段（去掉交互确认）。
 */
function applyBase() {
  return runJob('apply-base', async (job) => {
    const baseDir = config.baseDir;
    fs.mkdirSync(baseDir, { recursive: true });

    const plan = computeBaseUpdate(job);
    if (plan.outputMap.size === 0) {
      log(job, '[提示] output 中无 CSV 文件，无需更新 base。');
      return {
        updated: 0, deleted: [], copied: [], rewritten: [],
        archived: 0, archiveByReason: {}, archivePath: null, baseDir,
      };
    }

    log(job, '  正在更新 base 文件夹...');

    // 删除 base 中同前缀的旧格式文件（非 +base 格式）
    const deleted = [];
    for (const p of plan.prefixes) {
      checkCancelled(job);
      if (!p.outFile) continue;
      const newName = `${p.prefix}+base.csv`;
      if (p.baseFile && p.baseFile !== newName) {
        const oldPath = path.join(baseDir, p.baseFile);
        try {
          if (fs.statSync(oldPath).isFile()) {
            fs.unlinkSync(oldPath);
            deleted.push(p.baseFile);
            log(job, `    删除旧文件: ${p.baseFile}`);
          }
        } catch (e) {
          // 文件不存在则忽略
        }
      }
    }

    const res = writeBaseSnapshot(baseDir, plan, { includeBaseOnly: false });
    for (const p of plan.prefixes) {
      if (!p.outFile) continue;
      log(job, `    ${p.outFile}  →  ${p.prefix}+base.csv` +
        (p.revoked.length ? `  （剔除已撤销 ${p.revoked.length} 条，转入 base_old）` : ''));
    }

    // ── 归档文件 ──
    // 有归档内容、或本来就有归档文件（可能这次被清空）时才写，避免凭空造一个空文件
    const oldPath = baseOldPath();
    let archivePath = null;
    if (plan.archiveTotal || fs.existsSync(oldPath)) {
      writeBaseOld(oldPath, plan.archiveEntries);
      archivePath = oldPath;
      log(job, `  base_old 归档: ${plan.archiveTotal} 条` +
        `（本次新增 ${plan.archiveAdded}` +
        (plan.archiveRestored ? ` / 移出 ${plan.archiveRestored}` : '') + '）');
      const reasons = Object.keys(plan.archiveByReason);
      if (reasons.length) {
        log(job, '    ' + reasons.map((r) => `${r} ${plan.archiveByReason[r]}`).join(' / '));
      }
      log(job, `    文件: ${oldPath}`);
    }

    log(job, `\n  base 文件夹已更新，共处理 ${res.written} 个文件。`);
    log(job, '  [提示] 应用内参考库在「对比」完成时刷新，重启后从 base 重新加载。');

    return {
      updated: res.written,
      deleted,
      copied: res.copied,
      rewritten: res.rewritten,
      archived: plan.archiveTotal,
      archiveByReason: plan.archiveByReason,
      archiveAdded: plan.archiveAdded,
      archiveRestored: plan.archiveRestored,
      archivePath,
      baseDir,
    };
  });
}

// ===================== 功能③：横向对比 =====================

/**
 * 把逐省匹配结果裁剪成可序列化的精简明细，供渲染端弹窗绘制分段表格。
 *
 * 每个桶最多保留 cap 条：报告全文（reportText）始终是完整兜底，
 * 而弹窗只需展示可人工核对的一小部分，多省全选时也能把 JSON 体积压住。
 *
 * @param {Array} allResults 元素形如 { province, abbr, postFile, spbFile, result }
 * @param {number} cap       每桶最多保留的条数（够人工核对即可，全文看报告）
 */
function buildCrossDetails(allResults, cap = 100) {
  const cut = (arr) => arr.slice(0, cap).map(trimRecord);

  return allResults.map(({ province, abbr, result }) => ({
    province,
    abbr,
    // 各桶的完整条数：前端与 buckets 的长度对比即可判断是否被截断
    counts: {
      exact: result.matchedExact.length,
      normalized: result.matchedNormalized.length,
      suspected: result.matchedSuspected.length,
      fuzzy: result.matchedFuzzy.length,
      crossDistrict: result.matchedCrossDistrict.length,
      postOnly: result.postOnly.length,
      spbOnly: result.spbOnly.length,
    },
    buckets: {
      // 阶1/阶2：成对，只取双方名称与邮政侧位置
      exact: result.matchedExact.slice(0, cap).map(([post, spb]) => pairRow(post, spb)),
      normalized: result.matchedNormalized.slice(0, cap).map(([post, spb]) => pairRow(post, spb)),
      // 阶3：多一列公共中文字串
      suspected: result.matchedSuspected.slice(0, cap).map((item) => Object.assign(
        { common: item[2] || '', note: item[3] || '' },
        pairRow(item[0], item[1])
      )),
      // 阶4：多一列相似度
      fuzzy: result.matchedFuzzy.slice(0, cap).map(([post, spb, ratio]) => Object.assign(
        { ratio: Number(ratio) || 0 },
        pairRow(post, spb)
      )),
      // 阶5：为报告可读性另取双方区县
      crossDistrict: result.matchedCrossDistrict.slice(0, cap).map(([post, spb, method]) => ({
        method: method || '',
        postName: post.name,
        spbName: spb.name,
        postDistrict: post.district || post.city || '',
        spbDistrict: spb.district || spb.city || '',
        postcode: post.postcode || '',
      })),
      postOnly: cut(result.postOnly),
      spbOnly: cut(result.spbOnly),
    },
  }));
}

/** 一对匹配记录的公共字段 */
function pairRow(post, spb) {
  return {
    postName: post.name,
    spbName: spb.name,
    district: post.district || post.city || '',
    postcode: post.postcode || '',
  };
}

/** 单条记录（仅邮政/仅邮管）的精简形式 */
function trimRecord(r) {
  return {
    name: r.name,
    district: r.district || r.city || '',
    postcode: r.postcode || '',
  };
}

/**
 * 横向对比作业：按省份交叉比对 POST 与 SPB 的网点名称。
 * @param {object} opts
 * @param {boolean} opts.useBase     true 用 base/ 下的 {prefix}+base.csv
 * @param {string[]} opts.provinces  限定省份短名（空则全部）
 * @param {boolean} opts.enableFuzzy 是否启用阶4模糊匹配
 * @param {number}  opts.fuzzyThreshold
 */
function startCrossCompare(opts = {}) {
  const useBase = !!opts.useBase;
  const enableFuzzy = !!opts.enableFuzzy;
  const fuzzyThreshold = Number.isFinite(+opts.fuzzyThreshold) ? +opts.fuzzyThreshold : 0.8;
  const wanted = Array.isArray(opts.provinces) && opts.provinces.length
    ? new Set(opts.provinces)
    : null;

  return runJob('cross', async (job) => {
    const dataDir = useBase ? config.baseDir : config.outputDir;
    fs.mkdirSync(dataDir, { recursive: true });

    const targetProvinces = PROVINCES.filter(p => !wanted || wanted.has(p.name));

    // ── 收集可用省份对 ──
    const provincePairs = [];
    for (const p of targetProvinces) {
      checkCancelled(job);
      let postFile;
      let spbFile;
      if (useBase) {
        const pf = path.join(dataDir, `post${p.abbr}+base.csv`);
        const sf = path.join(dataDir, `spb${p.abbr}+base.csv`);
        postFile = fs.existsSync(pf) ? pf : null;
        spbFile = fs.existsSync(sf) ? sf : null;
      } else {
        postFile = findLatestFile(dataDir, `post${p.abbr}`);
        spbFile = findLatestFile(dataDir, `spb${p.abbr}`);
      }

      if (postFile && spbFile) {
        provincePairs.push({ province: p.name, abbr: p.abbr, postFile, spbFile });
      } else {
        const miss = [];
        if (!postFile) miss.push('POST');
        if (!spbFile) miss.push('SPB');
        log(job, `  [跳过] ${p.name}(${p.abbr}): 缺少 ${miss.join('/')} 数据`);
      }
    }

    if (provincePairs.length === 0) {
      log(job, '\n[提示] 没有找到同时具备 POST 和 SPB 数据的省份，无法进行横向对比。');
      log(job, `  数据目录: ${path.resolve(dataDir)}`);
      log(job, '  请先爬取两个数据源的数据。');
      return { provinceCount: 0, reportPath: null, reportText: '', summary: [] };
    }

    log(job, `\n  找到 ${provincePairs.length} 个可横向对比的省份`);
    log(job, '  ' + '-'.repeat(50));

    // ── 逐省对比并收集结果 ──
    const allResults = [];
    const reportLines = [];
    reportLines.push('='.repeat(70));
    reportLines.push('横向对比报告 — 邮政(中国邮政官网) vs 邮管局(国家邮政局备案)');
    reportLines.push(`生成时间: ${humanTime()}`);
    reportLines.push(`数据目录: ${path.resolve(dataDir)}`);
    reportLines.push('匹配模式: 精确 + 归一化' + (enableFuzzy ? ' + 模糊' : ''));
    reportLines.push('='.repeat(70));

    const grand = {
      postTotal: 0, spbTotal: 0,
      exact: 0, normalized: 0, suspected: 0, fuzzy: 0, cross: 0,
    };
    const summary = [];

    for (let idx = 0; idx < provincePairs.length; idx++) {
      checkCancelled(job);
      job.progress = { done: idx, total: provincePairs.length, label: provincePairs[idx].province };
      const { province, abbr, postFile, spbFile } = provincePairs[idx];

      const postRecords = readPostCsv(postFile);
      const spbRecords = readSpbCsv(spbFile);

      if (postRecords.length === 0 && spbRecords.length === 0) {
        log(job, `  [${idx + 1}/${provincePairs.length}] ${province} (${abbr}) ... 双方均无数据，跳过`);
        continue;
      }

      const result = Matcher.crossMatch(postRecords, spbRecords, {
        enableFuzzy, fuzzyThreshold,
      });
      allResults.push({ province, abbr, postFile, spbFile, result });

      const nPost = postRecords.length;
      const nSpb = spbRecords.length;
      const nExact = result.matchedExact.length;
      const nNorm = result.matchedNormalized.length;
      const nSuspected = result.matchedSuspected.length;
      const nFuzzy = result.matchedFuzzy.length;
      const nCross = result.matchedCrossDistrict.length;
      const nMatch = nExact + nNorm + nSuspected + nFuzzy + nCross;
      const nPostOnly = result.postOnly.length;
      const nSpbOnly = result.spbOnly.length;

      grand.postTotal += nPost;
      grand.spbTotal += nSpb;
      grand.exact += nExact;
      grand.normalized += nNorm;
      grand.suspected += nSuspected;
      grand.fuzzy += nFuzzy;
      grand.cross += nCross;

      const postPct = nPost ? (nMatch / nPost * 100) : 0;
      const spbPct = nSpb ? (nMatch / nSpb * 100) : 0;

      log(job, `  [${idx + 1}/${provincePairs.length}] ${province} (${abbr}) ... ` +
               `POST ${nPost}条 / SPB ${nSpb}条 → 匹配 ${nMatch} (邮政视角 ${postPct.toFixed(1)}%)`);
      job.progress = { done: idx + 1, total: provincePairs.length, label: province };

      summary.push({
        province, abbr, postCount: nPost, spbCount: nSpb, matchCount: nMatch,
        exact: nExact, normalized: nNorm, suspected: nSuspected, fuzzy: nFuzzy,
        cross: nCross, postOnly: nPostOnly, spbOnly: nSpbOnly,
        matchRate: postPct,
      });

      // ── 省份详细报告 ──
      const postName = path.basename(postFile);
      const spbName = path.basename(spbFile);

      reportLines.push('');
      reportLines.push(`省份: ${province} (${abbr})`);
      reportLines.push('-'.repeat(50));
      reportLines.push(`文件: ${postName} (${nPost}条) vs ${spbName} (${nSpb}条)`);
      reportLines.push('');
      reportLines.push('=== 汇总 ===');
      reportLines.push(`  邮政官网记录数           : ${nPost}`);
      reportLines.push(`  邮管局备案记录数          : ${nSpb}`);
      reportLines.push(`  精确匹配                 : ${nExact}` +
        (nPost ? ` (${(nExact / nPost * 100).toFixed(1)}%)` : ''));
      if (nNorm) {
        reportLines.push(`  归一化匹配               : ${nNorm}` +
          (nPost ? ` (${(nNorm / nPost * 100).toFixed(1)}%)` : ''));
      }
      if (nSuspected) {
        reportLines.push(`  疑似匹配                 : ${nSuspected}` +
          (nPost ? ` (${(nSuspected / nPost * 100).toFixed(1)}%)` : ''));
      }
      if (nFuzzy) {
        reportLines.push(`  模糊匹配                 : ${nFuzzy}` +
          (nPost ? ` (${(nFuzzy / nPost * 100).toFixed(1)}%)` : ''));
      }
      if (nCross) {
        reportLines.push(`  跨区县末次匹配           : ${nCross}` +
          (nPost ? ` (${(nCross / nPost * 100).toFixed(1)}%)` : ''));
      }
      reportLines.push('  ─────────────────────────────────');
      reportLines.push(`  匹配总计 (邮政视角)      : ${nMatch}` +
        (nPost ? ` (${postPct.toFixed(1)}%)` : ''));
      reportLines.push(`  邮政有但邮管无           : ${nPostOnly}` +
        (nPost ? ` (${(nPostOnly / nPost * 100).toFixed(1)}%)` : ''));
      reportLines.push(`  邮管有但邮政无           : ${nSpbOnly}` +
        (nSpb ? ` (${(nSpbOnly / nSpb * 100).toFixed(1)}%)` : ''));

      // ── 按区县对齐的不匹配条目 ──
      if (result.postOnly.length || result.spbOnly.length) {
        const postByDistrict = new Map();
        for (const r of result.postOnly) {
          const key = r.district || r.city || '';
          if (!postByDistrict.has(key)) postByDistrict.set(key, []);
          postByDistrict.get(key).push(r);
        }
        const spbByDistrict = new Map();
        for (const r of result.spbOnly) {
          const key = r.district || r.city || '';
          if (!spbByDistrict.has(key)) spbByDistrict.set(key, []);
          spbByDistrict.get(key).push(r);
        }

        const allDistricts = Array.from(
          new Set([...postByDistrict.keys(), ...spbByDistrict.keys()])
        ).sort();

        reportLines.push('');
        reportLines.push(
          `=== 按区县对齐的不匹配条目（邮政 ${nPostOnly}条 / 邮管 ${nSpbOnly}条） ===`
        );
        reportLines.push(
          `  ${'区县'.padEnd(16)} ${'邮政网点'.padEnd(30)} ${'邮管网点'.padEnd(30)} ${'邮政邮编'.padEnd(8)}`
        );
        reportLines.push(
          `  ${'-'.repeat(16)} ${'-'.repeat(30)} ${'-'.repeat(30)} ${'-'.repeat(8)}`
        );

        const pairedRows = [];
        const postOnlyRows = [];
        const spbOnlyRows = [];

        for (const dist of allDistricts) {
          const postList = postByDistrict.get(dist) || [];
          const spbList = spbByDistrict.get(dist) || [];
          const maxLen = Math.max(postList.length, spbList.length);
          for (let i = 0; i < maxLen; i++) {
            const postR = i < postList.length ? postList[i] : null;
            const spbR = i < spbList.length ? spbList[i] : null;
            const pName = postR ? postR.name : '(无)';
            const sName = spbR ? spbR.name : '(无)';
            const pPc = postR ? (postR.postcode || '') : '';
            const line = `  ${dist.padEnd(14)} ${pName.padEnd(30)} ${sName.padEnd(30)} ${pPc.padEnd(8)}`;
            if (postR && spbR) pairedRows.push(line);
            else if (postR) postOnlyRows.push(line);
            else spbOnlyRows.push(line);
          }
        }

        for (const line of pairedRows) reportLines.push(line);
        for (const line of postOnlyRows) reportLines.push(line);
        for (const line of spbOnlyRows) reportLines.push(line);
      }

      // ── 跨区县末次匹配 ──
      if (result.matchedCrossDistrict.length) {
        reportLines.push('');
        reportLines.push(
          `=== 跨区县末次匹配 — 不限制区县的归一化/子串匹配 (${nCross}对) ===`
        );
        reportLines.push(
          `  ${'方法'.padEnd(8)} ${'邮政名称'.padEnd(28)} → ${'邮管名称'.padEnd(28)}   ` +
          `${'邮政区县'.padEnd(14)} ${'邮管区县'.padEnd(14)} ${'邮编'.padEnd(8)}`
        );
        reportLines.push(
          `  ${'-'.repeat(8)} ${'-'.repeat(28)}   ${'-'.repeat(28)}   ` +
          `${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(8)}`
        );
        for (const [postR, spbR, method] of result.matchedCrossDistrict) {
          const postLoc = postR.district || '';
          const spbLoc = spbR.district || '';
          reportLines.push(
            `  ${method.padEnd(8)} ${postR.name.padEnd(28)} → ${spbR.name.padEnd(28)}   ` +
            `${postLoc.padEnd(14)} ${spbLoc.padEnd(14)} ${(postR.postcode || '').padEnd(8)}`
          );
        }
      }

      // ── 归一化匹配 ──
      if (result.matchedNormalized.length) {
        reportLines.push('');
        reportLines.push(
          `=== 归一化匹配 — 含注释剥离/前缀剥离/后缀统一 (${nNorm}对) ===`
        );
        reportLines.push(
          `  ${'邮政名称'.padEnd(30)} → ${'邮管名称'.padEnd(30)}   ${'所属区县'.padEnd(16)} ${'邮编'.padEnd(8)}`
        );
        reportLines.push(
          `  ${'-'.repeat(30)}   ${'-'.repeat(30)}   ${'-'.repeat(16)} ${'-'.repeat(8)}`
        );
        for (const [postR, spbR] of result.matchedNormalized) {
          const loc = postR.district ? `${postR.city}/${postR.district}` : (postR.city || '');
          reportLines.push(
            `  ${postR.name.padEnd(30)} → ${spbR.name.padEnd(30)}   ` +
            `${loc.padEnd(16)} ${(postR.postcode || '').padEnd(8)}`
          );
        }
      }

      // ── 疑似匹配 ──
      if (result.matchedSuspected.length) {
        reportLines.push('');
        reportLines.push(
          `=== 疑似匹配 — 存在公共中文字串需人工确认 (${nSuspected}对) ===`
        );
        reportLines.push(
          `  ${'公共字串'.padEnd(10)} ${'邮政名称'.padEnd(26)} → ${'邮管名称'.padEnd(26)}   ` +
          `${'所属区县'.padEnd(14)} ${'邮编'.padEnd(8)} 备注`
        );
        reportLines.push(
          `  ${'-'.repeat(10)} ${'-'.repeat(26)}   ${'-'.repeat(26)}   ` +
          `${'-'.repeat(14)} ${'-'.repeat(8)} ${'-'.repeat(20)}`
        );
        for (const item of result.matchedSuspected) {
          const postR = item[0];
          const spbR = item[1];
          const commonStr = item[2];
          const note = item.length >= 4 ? item[3] : '';
          const loc = postR.district ? `${postR.city}/${postR.district}` : (postR.city || '');
          reportLines.push(
            `  ${commonStr.padEnd(10)} ${postR.name.padEnd(26)} → ${spbR.name.padEnd(26)}   ` +
            `${loc.padEnd(14)} ${(postR.postcode || '').padEnd(8)} ${note}`
          );
        }
      }

      // ── 模糊匹配 ──
      if (result.matchedFuzzy.length) {
        reportLines.push('');
        reportLines.push(`=== 模糊匹配 — 需人工确认 (${nFuzzy}对) ===`);
        reportLines.push(
          `  ${'相似度'.padEnd(8)} ${'邮政名称'.padEnd(30)} → ${'邮管名称'.padEnd(30)}`
        );
        reportLines.push(
          `  ${'-'.repeat(8)} ${'-'.repeat(30)}   ${'-'.repeat(30)}`
        );
        for (const [postR, spbR, ratio] of result.matchedFuzzy) {
          reportLines.push(
            `  ${ratio.toFixed(3)}   ${postR.name.padEnd(30)} → ${spbR.name.padEnd(30)}`
          );
        }
      }
    }

    // ── 多省汇总 ──
    if (provincePairs.length > 1) {
      const grandMatch = grand.exact + grand.normalized + grand.suspected + grand.fuzzy + grand.cross;
      reportLines.push('');
      reportLines.push('='.repeat(70));
      reportLines.push('多省汇总');
      reportLines.push('='.repeat(70));
      reportLines.push(
        `${'省份'.padEnd(10)} ${'邮政'.padStart(6)} ${'邮管'.padStart(6)} ` +
        `${'匹配'.padStart(6)} ${'匹配率'.padStart(8)} ${'邮政独有'.padStart(8)} ${'邮管独有'.padStart(8)}`
      );
      reportLines.push(
        `${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ` +
        `${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`
      );

      for (const { province, abbr, result } of allResults) {
        const nMatch = result.matchedExact.length + result.matchedNormalized.length +
                       result.matchedSuspected.length + result.matchedFuzzy.length +
                       result.matchedCrossDistrict.length;
        const nPost = result.postOnly.length + nMatch;
        const nSpb = result.spbOnly.length + nMatch;
        const pct = nPost ? `${(nMatch / nPost * 100).toFixed(1)}%` : 'N/A';
        reportLines.push(
          `${(province + '(' + abbr + ')').padEnd(10)} ` +
          `${String(nPost).padStart(6)} ${String(nSpb).padStart(6)} ` +
          `${String(nMatch).padStart(6)} ${pct.padStart(8)} ` +
          `${String(result.postOnly.length).padStart(8)} ${String(result.spbOnly.length).padStart(8)}`
        );
      }

      reportLines.push(
        `${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ` +
        `${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`
      );
      if (grand.postTotal) {
        reportLines.push(
          `${'合计'.padEnd(10)} ` +
          `${String(grand.postTotal).padStart(6)} ${String(grand.spbTotal).padStart(6)} ` +
          `${String(grandMatch).padStart(6)} ` +
          `${(grandMatch / grand.postTotal * 100).toFixed(1).padStart(7)}%` +
          `${String(grand.postTotal - grandMatch).padStart(8)} ` +
          `${String(grand.spbTotal - grandMatch).padStart(8)}`
        );
      } else {
        reportLines.push('');
      }
    }

    // ── 保存报告 ──
    // 报告是产出物，统一写进 output/：base/ 在安装版里可能位于只读的 exe 同级目录，
    // 写在那里会直接抛错让整个横向对比失败。output/ 已由 configure 保证可写。
    // 万一两处都写不了，也只降级为「没有落盘文件」——报告正文仍在 reportText 里返回。
    const reportText = reportLines.join('\n');
    let reportPath = null;
    for (const dir of [config.outputDir, dataDir]) {
      if (!dir) continue;
      try {
        const candidate = path.join(dir, `cross_compare_${stampStr()}.txt`);
        fs.writeFileSync(candidate, reportText, 'utf8');
        reportPath = candidate;
        break;
      } catch (e) {
        // 该目录不可写，试下一个
      }
    }

    const grandMatch = grand.exact + grand.normalized + grand.suspected + grand.fuzzy + grand.cross;
    log(job, '  ' + '-'.repeat(50));
    if (reportPath) log(job, `  横向对比报告已保存: ${reportPath}`);
    log(job, `  共对比 ${provincePairs.length} 个省份`);
    if (grand.postTotal) {
      log(job, `  邮政总计 ${grand.postTotal}条 / 匹配 ${grandMatch}条 ` +
               `(${(grandMatch / grand.postTotal * 100).toFixed(1)}%)`);
    }

    return {
      provinceCount: provincePairs.length,
      reportPath,
      reportText,
      dataDir,
      useBase,
      summary,
      // 逐省逐桶的精简明细，供弹窗绘制可折叠的分段表格
      details: buildCrossDetails(allResults),
      grand: Object.assign({}, grand, { match: grandMatch }),
    };
  });
}

// ===================== 对外接口 =====================

module.exports = {
  PROVINCES,
  POST_FIELDS,
  SPB_FIELDS,
  BASE_OLD_FILE,
  BASE_OLD_FIELDS,
  ARCHIVE_REASON,
  SPB_CONCURRENCY_DEFAULT,
  SPB_CONCURRENCY_MAX,
  normalizeSpbConcurrency,
  configure,
  resolveCompareExe,
  getStatus,
  cancel,
  hasRunningJob,
  // 三大功能
  startCrawl,
  startCompare,
  applyBase,
  startCrossCompare,
  // 供测试/复用的底层函数
  parsePostPage,
  parseSpbPage,
  normalizeName: Matcher.normalizeName,
  crossMatch: Matcher.crossMatch,
  readPostCsv,
  readSpbCsv,
  findLatestFile,
  getFilePrefix,
  csvLine,
  // base_old 归档与更新方案
  baseOldPath,
  readBaseOld,
  writeBaseOld,
  isRevoked,
  hasRevokedMark,
  archivedLookupKey,
  makeArchivedRevokedFilter,
  recordKey,
  computeBaseUpdate,
  writeBaseSnapshot,
};
