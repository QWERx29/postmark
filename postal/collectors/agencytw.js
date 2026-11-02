/**
 * 台湾邮政代办所 · agencytw.csv
 * =================================
 * 数据源：https://www.post.gov.tw/post/internet/I_location/index.jsp?ID=1906
 * 实测每页 10 笔，页面显示共 371 笔（38 页），通过表单 POST topage 翻页。
 *
 * 源表列：名稱 / 郵遞區號 / 營業地址 / 電話 / 營業項目 / 管轄郵局 / 郵件條碼代號 / 營業時段 / 電子地圖
 * 输出四列：邮递区号 / 局名 / 地址 / 管辖邮局
 *
 * 代办所没有普通邮局的「电脑局号 / 电脑局名」，不能把普通邮局字段硬填进来。
 */

'use strict';

const {
  stripTags,
  extractDivById,
  extractTableRows,
  parseTotalCount,
} = require('../html-parser');

const AGENCY_PAGE = 'https://www.post.gov.tw/post/internet/I_location/index.jsp?ID=1906';
const PAGE_SIZE = 10;
const MAX_PAGES = 200;

/** 纯函数：解析一页代办所 HTML */
function parseAgencyPage(html) {
  const table = extractDivById(html, 'table');
  if (!table) throw new Error('未找到代办所表格（#table）');

  const sourceTotal = parseTotalCount(html);
  const rows = extractTableRows(table);
  const records = [];

  for (const cells of rows) {
    // 名稱 / 郵遞區號 / 營業地址 / 電話 / 營業項目 / 管轄郵局 / 郵件條碼代號 / 營業時段 / 電子地圖
    if (cells.length < 8) continue;

    const name = stripTags(cells[0]);
    const zip = stripTags(cells[1]);
    const address = stripTags(cells[2]);
    const jurisdiction = stripTags(cells[5]);

    if (!/^\d{3,6}$/.test(zip)) continue;

    const gidMatch =
      /G_id=(\d+)/i.exec(cells[4] || '') ||
      /G_id=(\d+)/i.exec(cells[7] || '') ||
      /G_id=(\d+)/i.exec(cells[8] || '');
    records.push({
      '邮递区号': zip,
      '局名': name,
      '地址': address,
      '管辖邮局': jurisdiction,
      // 仅用于翻页去重，不会写进 CSV（validators 只取输出字段）
      _gid: gidMatch ? gidMatch[1] : '',
    });
  }

  return { records, sourceTotal };
}

function buildPageForm(page) {
  const form = new URLSearchParams();
  form.set('topage', String(page));
  form.set('PreRowDatas', String(PAGE_SIZE));
  form.set('search_text', '%');
  for (const key of [
    'city', 'city_area', 'keyword', 'county_cdesc', 'style',
    'st_7', 'st_6', 'is_night', 'st_1_5', 'mid_area_sn',
    'Arry_S', 'Arry_ST',
  ]) {
    form.set(key, '');
  }
  form.set('ID', '1906');
  return form.toString();
}

/** 从一页结果中收集记录；按 G_id（缺失时用名称+地址）去重 */
function mergePage(all, seen, pageRecords) {
  let added = 0;
  for (const rec of pageRecords) {
    const key = rec._gid || `${rec['局名']}\u0001${rec['地址']}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(rec);
    added++;
  }
  return added;
}

async function collect({ http, logger }) {
  logger.info(`[agencytw] 请求代办所首页: ${AGENCY_PAGE}`);
  const first = await http.getText(AGENCY_PAGE, {
    tag: '[agencytw] ',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      Referer: 'https://www.post.gov.tw/post/internet/I_location/',
    },
  });

  let firstPage;
  try {
    firstPage = parseAgencyPage(first.text);
  } catch (e) {
    e.context = first.text.slice(0, 500).replace(/\s+/g, ' ');
    throw e;
  }

  const total = firstPage.sourceTotal;
  if (!total) throw new Error('无法从页面读取代办所总笔数');

  const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE));
  logger.info(`[agencytw] 页面标注 ${total} 条，每页 ${PAGE_SIZE} 条，共 ${pages} 页`);

  const all = [];
  const seen = new Set();
  mergePage(all, seen, firstPage.records);

  const failedPages = [];
  for (let page = 2; page <= pages; page++) {
    try {
      const res = await http.postForm(AGENCY_PAGE, buildPageForm(page), {
        tag: '[agencytw] ',
        headers: { Referer: AGENCY_PAGE },
      });
      let parsed;
      try {
        parsed = parseAgencyPage(res.text);
      } catch (e) {
        e.context = res.text.slice(0, 500).replace(/\s+/g, ' ');
        throw e;
      }
      if (parsed.sourceTotal != null && parsed.sourceTotal !== total) {
        logger.warn(`[agencytw] 第 ${page} 页总笔数变为 ${parsed.sourceTotal}（首页为 ${total}）`);
      }
      const added = mergePage(all, seen, parsed.records);
      logger.info(`[agencytw] 第 ${page}/${pages} 页: ${parsed.records.length} 条，新增 ${added}，累计 ${all.length}`);
    } catch (e) {
      failedPages.push(page);
      logger.warn(`[agencytw] 第 ${page}/${pages} 页失败: ${e.message}`);
    }
  }

  // 失败页再试一轮；仍失败则判定不完整，不覆盖旧文件
  if (failedPages.length) {
    logger.warn(`[agencytw] 有 ${failedPages.length} 页失败，开始补抓: ${failedPages.join(', ')}`);
    const stillFailed = [];
    for (const page of failedPages) {
      try {
        const res = await http.postForm(AGENCY_PAGE, buildPageForm(page), {
          tag: '[agencytw] ',
          headers: { Referer: AGENCY_PAGE },
        });
        const parsed = parseAgencyPage(res.text);
        const added = mergePage(all, seen, parsed.records);
        logger.info(`[agencytw] 补抓第 ${page}/${pages} 页: 新增 ${added}，累计 ${all.length}`);
      } catch (e) {
        stillFailed.push(page);
        logger.error(`[agencytw] 补抓第 ${page} 页仍失败: ${e.message}`);
      }
    }
    if (stillFailed.length) {
      throw new Error(`仍有 ${stillFailed.length} 页抓取失败（${stillFailed.join(', ')}），判定为不完整`);
    }
  }

  logger.info(`[agencytw] 解析到 ${all.length} 条记录（页面标注 ${total} 条）`);
  return { records: all, sourceTotal: total, meta: { pages } };
}

module.exports = {
  AGENCY_PAGE,
  PAGE_SIZE,
  parseAgencyPage,
  buildPageForm,
  collect,
};
