#!/usr/bin/env node
/**
 * 抓取「邮管局备案详情页」，取回 地址 / 邮政编码 / 所属市 / 所属区县 等字段，
 * 供人工复核表与官网数据逐条对照。
 *
 * 邮管局列表页只给了 省/市/县/场所名称/开办业务，详情页里才有地址和邮编。
 *
 * 用法: node scripts/fetch-spb-details.js [YYYYMMDD]
 * 产出: output/spb_details_<YYYYMMDD>.json   （可断点续跑，已抓过的链接直接复用）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'output');
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://zwfw.spb.gov.cn/',
};
const DELAY_MS = 200;
const TIMEOUT_MS = 20000;
const MAX_RETRY = 3;
const CONCURRENCY = Number(process.env.SPB_CONCURRENCY || 3);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 详情页是「字段名： + 值」的表格，按行抓取 */
function parseDetail(html) {
  const out = {};
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tds = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let t;
    while ((t = tdRe.exec(m[1])) !== null) tds.push(stripTags(t[1]));
    if (tds.length < 2) continue;
    const key = tds[0].replace(/[:：]\s*$/, '').trim();
    const val = tds[1].trim();
    if (key && val) out[key] = val;
  }
  return out;
}

async function fetchOne(url) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const fields = parseDetail(html);
      return {
        营业场所: fields['营业场所'] || '',
        所属省: fields['所属省'] || '',
        所属市: fields['所属市'] || '',
        所属区县: fields['所属区（县）'] || fields['所属区(县)'] || fields['所属县'] || '',
        地址: fields['地址'] || '',
        邮政编码: fields['邮政编码'] || fields['邮编'] || '',
        开办业务: fields['开办业务'] || '',
      };
    } catch (e) {
      clearTimeout(timer);
      if (attempt === MAX_RETRY) return { error: String(e && e.message || e) };
      await sleep(600 * attempt);
    }
  }
  return { error: 'unreachable' };
}

async function main() {
  const date = /^\d{8}$/.test(process.argv[2] || '') ? process.argv[2] : '20260929';
  const srcPath = path.join(OUT_DIR, `cross_diff_rows_${date}.json`);
  if (!fs.existsSync(srcPath)) throw new Error(`找不到 ${srcPath}，请先跑 export-cross-diff-rows.js`);

  const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const wanted = data.rows.filter(r =>
    (r.差异类型 === 'suspected' && !r.区县是否相同) ||
    (r.差异类型 === 'cross_district' && r.匹配方式 !== '归一化')
  );

  const links = Array.from(new Set(wanted.map(r => r.备案链接).filter(Boolean)));

  // 自动判读阶段改配过的备案记录，也要补抓详情
  const repairPath = path.join(OUT_DIR, '_repair_links.json');
  if (fs.existsSync(repairPath)) {
    const extra = Object.keys(JSON.parse(fs.readFileSync(repairPath, 'utf8')));
    for (const u of extra) if (!links.includes(u)) links.push(u);
    console.log(`含改配补抓链接: ${extra.length}`);
  }
  console.log(`待复核行: ${wanted.length}，去重后备案链接: ${links.length}`);

  const cachePath = path.join(OUT_DIR, `spb_details_${date}.json`);
  let cache = {};
  if (fs.existsSync(cachePath)) {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log(`已有缓存: ${Object.keys(cache).length} 条`);
  }

  let done = 0;
  let failed = 0;
  const todo = links.filter(url => !(cache[url] && !cache[url].error));
  console.log(`本轮需抓: ${todo.length}（并发 ${CONCURRENCY}）`);

  let cursor = 0;
  let sinceSave = 0;
  const save = () => fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1), 'utf8');

  async function worker() {
    while (cursor < todo.length) {
      const url = todo[cursor++];
      const info = await fetchOne(url);
      cache[url] = info;
      done++;
      sinceSave++;
      if (info.error) failed++;
      if (sinceSave >= 20) {
        sinceSave = 0;
        save();
        console.log(`  进度 ${done}/${todo.length}（失败 ${failed}）`);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  save();

  const ok = Object.values(cache).filter(v => !v.error).length;
  console.log(`完成: 成功 ${ok} / 失败 ${failed}`);
  console.log(`已写出: ${cachePath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
