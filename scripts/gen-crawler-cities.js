#!/usr/bin/env node
/**
 * 生成 crawler-cities.js —— 区县名 → 市名 的省级反查表
 * ==================================================
 * 数据源: js/data.js 的 PROVINCE_DATA（省→市）与 DISTRICT_MAP（市→区县）
 * 逻辑等价于 js/postodb.js 的 _buildDistrictCityLookup，但按省作用域预计算，
 * 避免「长安区」（石家庄/西安）、「朝阳区」等跨省重名产生歧义。
 *
 * 直辖市特殊处理: PROVINCE_DATA 中直辖市的下级就是区（东城区/浦东新区…），
 * 其「市」字段应回填直辖市本身（北京市），与 base/post{bj,sh,tj,cq}+base.csv 一致，
 * 而不是区名本身。
 *
 * 用法（data.js 的地名数据变更后重新生成）:
 *   node scripts/gen-crawler-cities.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DATA_JS = path.join(ROOT, 'js', 'data.js');
const OUT_JS = path.join(ROOT, 'crawler-cities.js');

// 直辖市名单 —— 与 data.js 的 MUNICIPALITIES 保持一致
const MUNICIPALITIES = ['北京市', '天津市', '上海市', '重庆市'];

/** 在隔离沙箱中求值 data.js，取出地名表（该文件为浏览器脚本，无模块导出） */
function loadDataJs() {
  const src = fs.readFileSync(DATA_JS, 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  const result = vm.runInContext(src + '\n;({ PROVINCE_DATA, DISTRICT_MAP })', ctx);
  if (!result || !result.PROVINCE_DATA || !result.DISTRICT_MAP) {
    throw new Error('无法从 data.js 取出 PROVINCE_DATA / DISTRICT_MAP');
  }
  return result;
}

/** 构建 省 → { 区县: 市 } 反查表 */
function buildCityByDistrict({ PROVINCE_DATA, DISTRICT_MAP }) {
  const table = {};
  let provinceCount = 0;
  let entryCount = 0;

  for (const province of PROVINCE_DATA) {
    const lookup = {};
    const isMunicipality = MUNICIPALITIES.includes(province.name);

    for (const city of province.cities) {
      // 该市下辖的区县（data.js 中缺失的市回退为空数组）
      const districts = DISTRICT_MAP[city.name] || [];
      for (const dist of districts) {
        if (!lookup[dist]) lookup[dist] = city.name;
      }
      // 市名本身也作为 key（县级市、以及直辖市下「区即市」的情况）
      if (!lookup[city.name]) lookup[city.name] = city.name;
    }

    if (isMunicipality) {
      // 直辖市: 所有下辖区/县一律回填直辖市名
      for (const city of province.cities) {
        lookup[city.name] = province.name;
      }
      for (const dist of (DISTRICT_MAP[province.name] || [])) {
        lookup[dist] = province.name;
      }
    }

    table[province.name] = lookup;
    provinceCount++;
    entryCount += Object.keys(lookup).length;
  }

  return { table, provinceCount, entryCount };
}

function main() {
  const data = loadDataJs();
  const { table, provinceCount, entryCount } = buildCityByDistrict(data);

  const lines = [];
  lines.push('/**');
  lines.push(' * 区县名 → 市名 反查表（按省作用域预计算）');
  lines.push(' * ================================================');
  lines.push(' * 自动生成，请勿手工编辑 —— 数据源为 js/data.js 的');
  lines.push(' * PROVINCE_DATA 与 DISTRICT_MAP。地名数据变更后运行:');
  lines.push(' *   node scripts/gen-crawler-cities.js');
  lines.push(` * 生成时间: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(` * 覆盖 ${provinceCount} 个省级行政区，共 ${entryCount} 条区县映射。`);
  lines.push(' */');
  lines.push('');
  lines.push("'use strict';");
  lines.push('');
  lines.push('const CITY_BY_DISTRICT = {');
  for (const [provinceName, lookup] of Object.entries(table)) {
    lines.push(`  ${JSON.stringify(provinceName)}: {`);
    for (const [dist, city] of Object.entries(lookup)) {
      lines.push(`    ${JSON.stringify(dist)}: ${JSON.stringify(city)},`);
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('// 区县名的常见后缀，用于精确匹配失败后的降级尝试');
  lines.push("const _SUFFIX_RE = /[市县区]$/;");
  lines.push('');
  lines.push('/**');
  lines.push(' * 依省作用域反查区县名对应的市名。');
  lines.push(' * @param {string} provinceFullName 省级全名，如「河北省」（空则无法限定作用域，直接返回空）');
  lines.push(' * @param {string} districtName     区县名，如「长安区」');
  lines.push(' * @returns {string} 市名，如「石家庄市」；未命中返回空字符串');
  lines.push(' */');
  lines.push('function cityByDistrict(provinceFullName, districtName) {');
  lines.push('  if (!provinceFullName || !districtName) return \'\';');
  lines.push('  const lookup = CITY_BY_DISTRICT[provinceFullName];');
  lines.push('  if (!lookup) return \'\';');
  lines.push('');
  lines.push('  // 阶段1: 精确匹配');
  lines.push('  if (lookup[districtName]) return lookup[districtName];');
  lines.push('');
  lines.push('  // 阶段2: 去掉「市/县/区」后缀后重试（如「东城区」↔「东城」）');
  lines.push('  const stripped = districtName.replace(_SUFFIX_RE, \'\');');
  lines.push('  if (stripped && stripped !== districtName && lookup[stripped]) return lookup[stripped];');
  lines.push('');
  lines.push('  return \'\';');
  lines.push('}');
  lines.push('');
  lines.push('module.exports = { cityByDistrict, CITY_BY_DISTRICT };');
  lines.push('');

  fs.writeFileSync(OUT_JS, lines.join('\n'), 'utf8');
  const size = fs.statSync(OUT_JS).size;
  console.log(`已生成 ${path.relative(ROOT, OUT_JS)}`);
  console.log(`  省级行政区: ${provinceCount} 个`);
  console.log(`  区县映射  : ${entryCount} 条`);
  console.log(`  文件大小  : ${(size / 1024).toFixed(1)} KB`);

  // 抽样自检：确认直辖市回填省名、跨省重名按省区分
  const checks = [
    ['北京市', '东城区', '北京市'],
    ['上海市', '嘉定区', '上海市'],
    ['重庆市', '城口县', '重庆市'],
    ['河北省', '长安区', '石家庄市'],
    ['陕西省', '长安区', '西安市'],
  ];
  const { cityByDistrict } = require(OUT_JS);
  console.log('  抽样自检:');
  let bad = 0;
  for (const [prov, dist, want] of checks) {
    const got = cityByDistrict(prov, dist);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${prov} / ${dist} → ${got || '(空)'}${ok ? '' : `  期望 ${want}`}`);
  }
  if (bad > 0) {
    console.error(`\n自检失败 ${bad} 项`);
    process.exit(1);
  }
}

main();
