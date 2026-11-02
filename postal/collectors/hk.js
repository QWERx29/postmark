/**
 * 香港邮政 · posthk.csv
 * =================================
 * 页面本身是框架，真正的数据在：
 *   POST https://webapp.hongkongpost.hk/api1/v1/postOffice/all-post-office
 * 响应是 region → district → office 的嵌套 JSON，正好给出「地区」分组。
 *
 * 字段映射：
 *   地区 = region_name_sc（港岛区 / 九龙区 / 新界区 / 离岛区）
 *   局名 = office_name_sc
 *   代号 = office_code
 *   地址 = office_addr_sc
 */

'use strict';

const HK_PAGE = 'https://webapp.hongkongpost.hk/sc/about_us/network/post_offices2/index.html#list';
const HK_API = 'https://webapp.hongkongpost.hk/api1/v1/postOffice/all-post-office';

function pickText(...values) {
  for (const v of values) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** 纯函数：把接口响应映射为输出记录，便于单测 */
function parseHkPayload(payload) {
  const regions = payload && Array.isArray(payload.region) ? payload.region : [];
  const records = [];

  for (const region of regions) {
    const regionName = pickText(
      region.region_name_sc,
      region.region_name_tc,
      region.region_name_en
    );
    const districts = Array.isArray(region.district) ? region.district : [];
    for (const district of districts) {
      const offices = Array.isArray(district.office) ? district.office : [];
      for (const office of offices) {
        records.push({
          '地区': regionName,
          '局名': pickText(office.office_name_sc, office.office_name_tc, office.office_name_en),
          '代号': pickText(office.office_code),
          '地址': pickText(office.office_addr_sc, office.office_addr_tc, office.office_addr_en),
        });
      }
    }
  }

  return { records, regionCount: regions.length };
}

async function collect({ http, logger }) {
  logger.info(`[hk] 请求香港邮政网点接口: ${HK_API}`);
  const payload = await http.postJson(HK_API, {}, {
    tag: '[hk] ',
    headers: {
      Referer: HK_PAGE,
      Origin: 'https://webapp.hongkongpost.hk',
      Accept: 'application/json',
    },
  });

  const { records, regionCount } = parseHkPayload(payload);
  logger.info(`[hk] 解析到 ${records.length} 条记录，覆盖 ${regionCount} 个区域`);
  return { records, sourceTotal: null, meta: { regionCount } };
}

module.exports = { HK_PAGE, HK_API, parseHkPayload, collect };
