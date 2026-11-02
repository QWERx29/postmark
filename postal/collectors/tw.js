/**
 * 台湾普通邮局 · posttw.csv
 * =================================
 * 数据源：https://www.post.gov.tw/post/internet/I_location/index_all.html
 * 实测该 URL 直接返回完整表格（共 1277 笔），无需分页、无需浏览器。
 *
 * 源表列：郵遞區號 / 電腦局號 / 局名 / 電腦局名 / 局址 / 郵務電話 / 儲匯電話
 * 输出四列：邮递区号 / 局名 / 电脑局名 / 地址
 *
 * 「电脑局号」与「电脑局名」按项目约定只保留一列，列名用「电脑局名」，
 * 取值用源表的「電腦局名」（如 臺北901支）；源表的 000100-6 这类电脑局号不另设列。
 */

'use strict';

const {
  stripTags,
  firstLinkText,
  extractDivById,
  extractTableRows,
  parseTotalCount,
} = require('../html-parser');

const TW_PAGE = 'https://www.post.gov.tw/post/internet/I_location/index_all.html';

/** 纯函数：解析全国营业据点一览表 HTML */
function parseTaiwanPostHtml(html) {
  const table = extractDivById(html, 'table');
  if (!table) throw new Error('未找到全国营业据点表格（#table）');

  const sourceTotal = parseTotalCount(html);
  const rows = extractTableRows(table);
  const records = [];

  for (const cells of rows) {
    // 数据行至少要有 郵遞區號 / 電腦局號 / 局名 / 電腦局名 / 局址 五列
    if (cells.length < 6) continue;

    const zip = stripTags(cells[1]);
    const name = firstLinkText(cells[3]);
    const computerName = stripTags(cells[4]);
    const address = stripTags(cells[5]);

    // 表头行没有 <td>，这里再按邮递区号形状兜底过滤
    if (!/^\d{3,6}$/.test(zip)) continue;

    records.push({
      '邮递区号': zip,
      '局名': name,
      '电脑局名': computerName,
      '地址': address,
    });
  }

  return { records, sourceTotal };
}

async function collect({ http, logger }) {
  logger.info(`[tw] 请求全国营业据点一览表: ${TW_PAGE}`);
  const res = await http.getText(TW_PAGE, {
    tag: '[tw] ',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      Referer: 'https://www.post.gov.tw/post/internet/I_location/',
    },
  });

  logger.info(`[tw] 最终地址: ${res.finalUrl}（HTTP ${res.status}）`);
  let parsed;
  try {
    parsed = parseTaiwanPostHtml(res.text);
  } catch (e) {
    e.context = res.text.slice(0, 500).replace(/\s+/g, ' ');
    throw e;
  }

  logger.info(`[tw] 解析到 ${parsed.records.length} 条记录` +
    (parsed.sourceTotal == null ? '' : `，页面标注 ${parsed.sourceTotal} 条`));
  return { records: parsed.records, sourceTotal: parsed.sourceTotal };
}

module.exports = { TW_PAGE, parseTaiwanPostHtml, collect };
