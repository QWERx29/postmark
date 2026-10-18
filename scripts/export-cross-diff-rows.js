#!/usr/bin/env node
/**
 * 把某一天的横向对比（cross_compare）结果导出为结构化差异行（JSON）。
 *
 * 复用 crawler-engine / crawler-match 的同一套读取与匹配逻辑，
 * 保证与 output/cross_compare_*.txt 报告完全一致，只是额外带上
 * 每条记录的「省 / 市 / 区县」原始字段，供表格化输出使用。
 *
 * 用法: node scripts/export-cross-diff-rows.js [YYYYMMDD]
 * 产出: output/cross_diff_rows_<YYYYMMDD>.json
 *
 * 差异分类（即「差异原因」的来源）：
 *   normalized      官网与邮管局名称写法不同，归一化后一致
 *   suspected       疑似同一网点（仅有公共字串），需人工确认
 *   cross_district  跨区县匹配（双方登记区县不同）
 *   post_only       邮政官网有、邮管局备案无
 *   spb_only        邮管局备案有、邮政官网无
 */

'use strict';

const fs = require('fs');
const path = require('path');

const engine = require('../crawler-engine');
const Matcher = require('../crawler-match');
const { cityByDistrict } = require('../crawler-cities');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output');

// ===================== 名称差异归因 =====================

const ANNOTATION_RE = /[（(][^）)]*[）)]/g;

const SUFFIXES = [
  '（假期暂停）', '(假期暂停)', '（暂停）', '(暂停)', '（装修中）', '(装修中)',
  '（临时停业）', '(临时停业)', '邮政营业厅', '邮政服务中心', '邮政代办所',
  '邮政支局', '邮政所', '邮政营业', '邮政', '支局',
];

function annotationsOf(name) {
  return String(name == null ? '' : name).match(ANNOTATION_RE) || [];
}

function stripAnnotations(name) {
  return String(name == null ? '' : name).replace(ANNOTATION_RE, '').trim();
}

/** 名称里带「（暂停）」「（假期暂停）」这类停业状态标注时返回该标注，否则返回 '' */
function pausedAnnotationOf(name) {
  return annotationsOf(name).find(a => a.includes('暂停')) || '';
}

function trailingSuffix(name) {
  const n = stripAnnotations(name);
  for (const s of SUFFIXES) {
    if (n.endsWith(s) && n.length > s.length) return s;
  }
  return '';
}

/** 归一化匹配（名称写法不同）的归因说明 */
function whyNormalized(postName, spbName) {
  const notes = [];

  const pa = annotationsOf(postName).join('');
  const sa = annotationsOf(spbName).join('');
  if (pa !== sa) {
    if (pa && !sa) notes.push(`官网名称带状态标注“${pa}”，邮管局名称无该标注`);
    else if (!pa && sa) notes.push(`邮管局名称带标注“${sa}”，官网名称无该标注`);
    else notes.push(`双方标注不同（官网“${pa}”/邮管局“${sa}”）`);
  }

  const bp = stripAnnotations(postName);
  const bs = stripAnnotations(spbName);
  if (bp !== bs) {
    const ps = trailingSuffix(postName);
    const ss = trailingSuffix(spbName);
    if (ps !== ss) {
      notes.push(`网点类型后缀不同（官网“${ps || '无后缀'}”/邮管局“${ss || '无后缀'}”）`);
    }
    const idx = bs.indexOf(bp);
    if (idx > 0) notes.push(`邮管局名称多出前缀“${bs.slice(0, idx)}”`);
    else if (idx === 0 && bs.length > bp.length) notes.push(`邮管局名称多出后缀“${bs.slice(bp.length)}”`);
    else if (bs.indexOf(bp) === -1) {
      const idx2 = bp.indexOf(bs);
      if (idx2 > 0) notes.push(`官网名称多出前缀“${bp.slice(0, idx2)}”`);
      else if (idx2 === 0 && bp.length > bs.length) notes.push(`官网名称多出后缀“${bp.slice(bs.length)}”`);
    }
  }

  if (!notes.length) notes.push('名称写法不同');
  return notes.join('；');
}

// ===================== 省名规范化 =====================

const FULL_PROVINCE = {
  北京: '北京市', 天津: '天津市', 上海: '上海市', 重庆: '重庆市',
  内蒙古: '内蒙古自治区', 广西: '广西壮族自治区', 西藏: '西藏自治区',
  宁夏: '宁夏回族自治区', 新疆: '新疆维吾尔自治区',
};

function fullProvince(name, fallback) {
  const s = String(name || '').trim();
  if (s) return s;
  const key = String(fallback || '').trim();
  if (FULL_PROVINCE[key]) return FULL_PROVINCE[key];
  return key ? key + '省' : '';
}

const MUNICIPALITIES = new Set(['北京市', '天津市', '上海市', '重庆市']);

/**
 * 「市」取值：以邮政官网 CSV 的「市」为准（爬虫已做地名反查，直辖市为市名本身）；
 * 缺官网记录或官网市为空时，退回邮管局「所属市」，但邮管局在直辖市把区县写进了
 * 「所属市」（如 北京 的所属市=东城区），这种情况用省级名称代替。
 */
function resolveCity(post, spb, provName, spbCityByDistrict) {
  const pc = post ? String(post.city || '').trim() : '';
  if (pc) return pc;
  const sc = spb ? String(spb.city || '').trim() : '';
  if (sc) {
    if (MUNICIPALITIES.has(provName)) return provName;
    const sd = spb ? String(spb.district || '').trim() : '';
    if (sc === sd) return MUNICIPALITIES.has(provName) ? provName : sc;
    return sc;
  }
  if (post && post.district) {
    const guessed = cityByDistrict(post.district);
    if (guessed) return guessed;
    // 地名表未收录（如近年撤县设市）：用本省邮管局备案里同区县的「所属市」补
    const fromSpb = spbCityByDistrict && spbCityByDistrict.get(post.district);
    if (fromSpb) return fromSpb;
  }
  return provName && MUNICIPALITIES.has(provName) ? provName : '';
}

// ===================== 主流程 =====================

function main() {
  const dateArg = (process.argv[2] || '').trim();
  const date = /^\d{8}$/.test(dateArg) ? dateArg : null;

  const rows = [];
  const stats = {};
  const skipped = { paused: 0 };
  const provinceStats = [];
  const missing = [];

  for (const p of engine.PROVINCES) {
    let postFile = date ? path.join(OUT_DIR, `post${p.abbr}-${date}.csv`) : null;
    let spbFile = date ? path.join(OUT_DIR, `spb${p.abbr}-${date}.csv`) : null;
    if (!postFile || !fs.existsSync(postFile)) postFile = engine.findLatestFile(OUT_DIR, `post${p.abbr}`);
    if (!spbFile || !fs.existsSync(spbFile)) spbFile = engine.findLatestFile(OUT_DIR, `spb${p.abbr}`);
    if (!postFile || !spbFile) {
      missing.push(`${p.name}(${p.abbr}) 缺 ${!postFile ? 'POST' : ''}${!spbFile ? '/SPB' : ''}`);
      continue;
    }

    const postRecords = engine.readPostCsv(postFile);
    const spbRecords = engine.readSpbCsv(spbFile);
    if (!postRecords.length && !spbRecords.length) continue;

    // 与 cross_compare 报告同参数：精确 + 归一化，不启用模糊匹配
    const r = Matcher.crossMatch(postRecords, spbRecords, { enableFuzzy: false });

    const provName = fullProvince(
      (postRecords[0] && postRecords[0].province) || (spbRecords[0] && spbRecords[0].province),
      p.name
    );

    // 区县 → 市 的补充对照表（邮管局备案里的「所属市」，排除直辖市那种市=县的写法）
    const spbCityByDistrict = new Map();
    for (const r of spbRecords) {
      const d = String(r.district || '').trim();
      const c = String(r.city || '').trim();
      if (d && c && c !== d && !spbCityByDistrict.has(d)) spbCityByDistrict.set(d, c);
    }

    const push = (kind, post, spb, reason, extra) => {
      const city = resolveCity(post, spb, provName, spbCityByDistrict);
      rows.push(Object.assign({
        省: provName,
        市: city,
        邮政官网区县: post ? (post.district || '') : '',
        邮政官网名称: post ? post.name : '',
        邮管局区县: spb ? (spb.district || '') : '',
        差异原因: reason,
        差异类型: kind,
        邮编: post ? (post.postcode || '') : '',
        地址: post ? (post.address || '') : '',
        邮管局名称: spb ? spb.name : '',
        备案链接: spb ? (spb.detail_link || '') : '',
        名称相似度: (post && spb) ? Matcher.sequenceRatio(post.name, spb.name) : null,
      }, extra || {}));
      stats[kind] = (stats[kind] || 0) + 1;
    };

    for (const [post, spb] of r.matchedNormalized) {
      // 官网名称只是多了「（暂停）」这类状态标注、且归一化后匹配上的，
      // 本质是同一网点在营业状态上的标注差异，不算名称差异，按需求不整理进表。
      if (pausedAnnotationOf(post.name)) {
        skipped.paused += 1;
        continue;
      }
      push('normalized', post, spb,
        `名称写法差异（归一化后为同一网点）：${whyNormalized(post.name, spb.name)}`);
    }

    for (const item of r.matchedSuspected) {
      const post = item[0];
      const spb = item[1];
      const sameDistrict = ((post.district || '') === (spb.district || ''));
      push('suspected', post, spb,
        sameDistrict
          ? '疑似匹配：双方名称仅部分相同，需人工确认'
          : '疑似匹配：名称相近但登记区县不一致，需人工确认',
        { 区县是否相同: sameDistrict, 公共字串: item[2] || '' });
    }

    for (const item of r.matchedCrossDistrict) {
      const post = item[0];
      const spb = item[1];
      const method = item[2];   // '归一化' 或 '子串:XX'
      push('cross_district', post, spb,
        method === '归一化'
          ? '跨区县差异：名称归一化后一致，仅登记区县不同'
          : '跨区县差异：仅名称部分相同且登记区县不一致，需人工确认',
        { 匹配方式: method, 公共字串: method.startsWith('子串:') ? method.slice(3) : '' });
    }

    for (const post of r.postOnly) {
      push('post_only', post, null, '邮管局备案中无此网点');
    }

    for (const spb of r.spbOnly) {
      push('spb_only', null, spb, '邮政官网中无此网点');
    }

    provinceStats.push({
      province: provName,
      abbr: p.abbr,
      postCount: postRecords.length,
      spbCount: spbRecords.length,
      exact: r.matchedExact.length,
      normalized: r.matchedNormalized.length,
      suspected: r.matchedSuspected.length,
      crossDistrict: r.matchedCrossDistrict.length,
      postOnly: r.postOnly.length,
      spbOnly: r.spbOnly.length,
    });
  }

  const payload = {
    date: date || 'latest',
    generatedAt: new Date().toISOString(),
    total: rows.length,
    stats,
    skipped,
    provinces: provinceStats,
    missing,
    rows,
  };

  const outPath = path.join(OUT_DIR, `cross_diff_rows_${date || 'latest'}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1), 'utf8');

  console.log(`省份数: ${provinceStats.length}`);
  console.log(`差异行数: ${rows.length}`);
  console.log('分类: ' + JSON.stringify(stats));
  console.log(`已剔除(官网名称带“暂停”标注且归一化匹配): ${skipped.paused}`);
  if (missing.length) console.log('跳过(缺数据): ' + missing.join(', '));
  console.log(`已写出: ${outPath}`);
}

main();
