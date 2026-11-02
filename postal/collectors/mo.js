/**
 * 澳门邮电局 · postmo.csv
 * =================================
 * 页面是 Webflow 模板，网点详情由前端按 itemid 拉取：
 *   GET https://www.ctt.gov.mo/apis/web/post-office/list?culture=zh-CN&mode=None
 * 请求头需要 X-Web-Code: FIL。
 *
 * 接口的 data.itemListElement 就是「邮政服务」分类下的完整网点列表，
 * 不包含电信 / 邮政储金局 / 通讯博物馆等其它独立标签页。
 * 页面本身是繁体，接口支持 culture=zh-CN，这里取简体版本。
 *
 * 字段映射：
 *   名称 = legalName
 *   地址 = address
 * 注意：alternateName 是「郵政總」这类简称，不是正式名称，不采用；
 *       telephone / openingHours / hasMap 都不能当地址。
 */

'use strict';

const MO_PAGE = 'https://www.ctt.gov.mo/Contents/branches?tab=macaupost';
const MO_API = 'https://www.ctt.gov.mo/apis/web/post-office/list?culture=zh-CN&mode=None';

function pickText(...values) {
  for (const v of values) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** 纯函数：把接口响应映射为输出记录 */
function parseMacauPayload(payload) {
  const raw = payload && payload.data ? payload.data.itemListElement : null;
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const records = items.map((item) => ({
    '名称': pickText(item && item.legalName, item && item.alternateName),
    '地址': pickText(item && item.address),
  }));
  return { records };
}

async function collect({ http, logger }) {
  logger.info(`[mo] 请求澳门邮电局网点接口: ${MO_API}`);
  const payload = await http.getJson(MO_API, {
    tag: '[mo] ',
    headers: {
      'X-Web-Code': 'FIL',
      Referer: MO_PAGE,
      Accept: 'application/json',
    },
  });

  const { records } = parseMacauPayload(payload);
  logger.info(`[mo] 解析到 ${records.length} 条记录`);
  return { records, sourceTotal: null };
}

module.exports = { MO_PAGE, MO_API, parseMacauPayload, collect };
