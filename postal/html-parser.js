/**
 * 港澳台网点采集 · HTML 解析公共函数
 * =========================================
 * 项目没有 cheerio，也不打算为这一个任务新增依赖；
 * 四个站点的表格结构都固定，这里用范围很窄的正则做「表格行 / 单元格」提取，
 * 字段定位仍由各采集器负责。
 */

'use strict';

/** 解码 HTML 实体（数字实体 + 常见命名实体） */
function decodeHtmlEntities(input) {
  return String(input == null ? '' : input)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : _;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * 去标签 + 解实体 + 折叠空白。
 * 只用于表格单元格这类小片段，不用于整页。
 */
function stripTags(html) {
  const s = String(html == null ? '' : html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlEntities(s).replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * 单元格里若有链接，取第一个链接的文字。
 * 台湾普通邮局表格的「局名」列同时有 rwd-close / rwd-open 两个链接，
 * 直接 stripTags 会得到「臺北北門郵局 臺北北門郵局」。
 */
function firstLinkText(html) {
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(String(html == null ? '' : html));
  const text = stripTags(m ? m[1] : html);
  // 极少数单元格可能先放一个空锚点，再放名称链接；此时退回整格文本
  return text || stripTags(html);
}

/**
 * 取指定 id 的 div 的内容。
 * 台湾两个页面的数据表格外层都是 <div id="table">…</div>，
 * 且 div 内只有 table，没有嵌套 div，所以非贪婪匹配足够。
 */
function extractDivById(html, id) {
  const re = new RegExp(
    `<div\\b[^>]*\\sid\\s*=\\s*["']${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/div>`,
    'i'
  );
  const m = re.exec(String(html == null ? '' : html));
  return m ? m[1] : '';
}

/**
 * 从一段表格 HTML 中提取数据行。
 * 跳过含 <th> 的表头行；返回每行的 <td> 内部 HTML 数组。
 */
function extractTableRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(String(html == null ? '' : html))) !== null) {
    const rowHtml = tr[1];
    if (/<th\b/i.test(rowHtml)) continue;
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(rowHtml)) !== null) cells.push(td[1]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** 读取「共1277筆 / 共371笔」里的数字；没有则返回 null */
function parseTotalCount(html) {
  const m = /共\s*([\d,]+)\s*[筆笔]/.exec(String(html == null ? '' : html));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  decodeHtmlEntities,
  stripTags,
  firstLinkText,
  extractDivById,
  extractTableRows,
  parseTotalCount,
};
