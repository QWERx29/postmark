/**
 * 智能判别对比（intelligent_compare）
 * ==================================
 * 忠实移植 post_spb_crawler/crawler.py 的「智能判别功能」（原文件 2026-08-19 版，
 * 第 1072-1735 行）。crawler.py --compare 在跑完 txt_compare.exe 之后，还会对每一对
 * 同源 CSV 再跑一遍这套语义级判别，另外落盘 intelligent_report_<时间戳>.txt。
 *
 * 对应关系：
 *   _extract_status            → extractStatus
 *   _match_same_source         → matchSameSource
 *   _classify_changes          → classifyChanges
 *   _detect_consecutive_blocks → detectConsecutiveBlocks
 *   _generate_intelligent_report → generateIntelligentReport
 *   intelligent_compare        → intelligentCompare
 *
 * 注意：本模块自带一份 17 个后缀的 normalizeName，**不用** crawler-match.js 里那份
 * 12 个后缀的：真实 crawler.py 的 _NAME_SUFFIXES 比 postmark 里那份 6 月旧拷贝多了
 * 「邮政便民服务点/代办所/邮电支局/邮电所/营业所」五项，而 intelligent_compare 全程
 * 依赖 normalize_name。横向对比的 crossMatch 沿用旧后缀，属于既有的另一处分叉，
 * 不在本模块处理范围内。onlyChinese / findLongestCommonSubstring / isSpecialZone
 * 与后缀无关，直接复用 crawler-match.js。
 */

'use strict';

const Matcher = require('./crawler-match.js');

const { onlyChinese, findLongestCommonSubstring, isSpecialZone } = Matcher;

// ===================== 归一化（17 后缀版，对应 crawler.py:118-140） =====================

/** 网点名称归一化时需要剥离的后缀（长后缀优先匹配） */
const NAME_SUFFIXES = [
  '（假期暂停）', '(假期暂停)',
  '（假期营业）', '(假期营业)',
  '（暂停）', '(暂停)',
  '（装修中）', '(装修中)',
  '（临时停业）', '(临时停业)',
  '邮政营业厅',
  '邮政服务中心',
  '邮政便民服务点',
  '邮政代办所',
  '代办所',
  '邮电支局',
  '邮电所',
  '营业所',
  '邮政支局',
  '邮政所',
  '邮政营业',
  '邮政',
  '支局',       // 无"邮政"前缀的裸"支局"（如"东贸路支局"）
];

/** 匹配括号注释的正则（全角/半角括号） */
const ANNOTATION_RE = /[（(][^）)]*[）)]/g;

/**
 * 剥离括号注释和已知类型后缀，返回核心名称用于归一化匹配。
 * 对应 crawler.py: normalize_name
 */
function normalizeName(name) {
  let normalized = String(name == null ? '' : name).trim();
  // 去除括号内的注释（全角/半角）
  normalized = normalized.replace(ANNOTATION_RE, '').trim();
  // 去除尾部已知后缀（长后缀优先，命中即停）
  for (const suffix of NAME_SUFFIXES) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      normalized = normalized.slice(0, normalized.length - suffix.length).trim();
      break;
    }
  }
  return normalized.replace(/[，, ]+$/, '');
}

/**
 * 剥离后缀后，提取两个名称的公共中文字符子串（>=2个汉字）。
 * 对应 crawler.py: _find_common_cn_substring —— 用本地 17 后缀的 normalizeName。
 */
function findCommonCnSubstring(name1, name2) {
  const cn1 = onlyChinese(normalizeName(name1));
  const cn2 = onlyChinese(normalizeName(name2));
  if (cn1.length < 2 || cn2.length < 2) return '';
  const lcs = findLongestCommonSubstring(cn1, cn2);
  return lcs.length >= 2 ? lcs : '';
}

// ===================== 营业状态标记（对应 crawler.py:1074-1092） =====================

/**
 * 状态标记关键词。顺序与 Python 一致（「暂停」在「假期暂停」之前）——
 * 两者不会互相误伤，但保持原顺序以免将来加词时行为漂移。
 * 带 g 标志是为了复刻 Python re.sub 的「替换全部」语义。
 */
const STATUS_PATTERNS = [
  [/[（(]暂停[）)]/g, '暂停营业'],
  [/[（(]假期暂停[）)]/g, '假期暂停'],
  [/[（(]假期营业[）)]/g, '假期营业'],
  [/[（(]装修中[）)]/g, '装修中'],
  [/[（(]临时停业[）)]/g, '临时停业'],
  [/[（(]撤销[）)]/g, '已撤销'],
];

/**
 * 从网点名称中提取营业状态标记。
 * 对应 crawler.py: _extract_status
 * @returns {{clean: string, statuses: string[]}}
 */
function extractStatus(name) {
  const statuses = [];
  let clean = String(name == null ? '' : name);
  for (const [re, label] of STATUS_PATTERNS) {
    re.lastIndex = 0;              // 带 g 的正则 test() 会记住 lastIndex，必须先复位
    if (re.test(clean)) {
      statuses.push(label);
      clean = clean.replace(re, '');
    }
  }
  return { clean: clean.trim(), statuses };
}

// ===================== 同源三级匹配（对应 crawler.py:1095-1217） =====================

/** 组合键：区县 + 归一化名。用  分隔避免与名称内容冲突。 */
function nameKey(rec) {
  return `${rec.district || ''}${normalizeName(rec.name)}`;
}

/** 两个状态数组是否相同（Python 里是 list 直接比较） */
function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 同源数据三级匹配引擎。
 * 对应 crawler.py: _match_same_source
 *
 *   阶1 — 区县+归一化名称精确匹配
 *   阶2 — 区县+公共中文字串 >= 2字 的疑似匹配
 *   阶3 — 邮编精确匹配（仅POST，同区县）
 *
 * @param {object[]} records1 新版记录（output）
 * @param {object[]} records2 旧版记录（base）
 * @param {string} sourceType 'post' | 'spb'
 * @returns {{matchedPairs: Array, unmatched1: Array, unmatched2: Array}}
 *   matchedPairs 元素为 [idx1, rec1, idx2, rec2, level]，level ∈ exact|suspected|postcode
 */
function matchSameSource(records1, records2, sourceType = 'post') {
  const matchedPairs = [];
  const used2 = new Set();

  // ── 阶1: 区县+归一化名称 精确匹配 ──
  const byName = new Map();
  records2.forEach((r, i) => {
    const key = nameKey(r);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(i);
  });

  let unmatched1 = [];
  records1.forEach((r1, i1) => {
    const bucket = byName.get(nameKey(r1));
    if (bucket) {
      let found = false;
      for (const i2 of bucket) {
        if (!used2.has(i2)) {
          matchedPairs.push([i1, r1, i2, records2[i2], 'exact']);
          used2.add(i2);
          found = true;
          break;
        }
      }
      if (!found) unmatched1.push([i1, r1]);
    } else {
      unmatched1.push([i1, r1]);
    }
  });

  // ── 阶2: 区县+公共中文字串 >=2字 疑似匹配 ──
  if (unmatched1.length) {
    let remaining2 = [];
    records2.forEach((r, i) => { if (!used2.has(i)) remaining2.push([i, r]); });

    let stillUnmatched = [];
    for (const [i1, r1] of unmatched1) {
      const d1 = r1.district || '';
      const cn1 = onlyChinese(normalizeName(r1.name));
      if (cn1.length < 2) {
        stillUnmatched.push([i1, r1]);
        continue;
      }

      let best = null;               // [i2, r2, commonLen]
      for (const [i2, r2] of remaining2) {
        const d2 = r2.district || '';
        // 区县必须一致（除非特殊园区）
        if (d1 && d2 && d1 !== d2 && !(isSpecialZone(d1) || isSpecialZone(d2))) continue;
        const common = findCommonCnSubstring(r1.name, r2.name);
        // 严格大于：并列时保留先出现的那条，与 Python 一致
        if (common.length >= 2 && (best === null || common.length > best[2])) {
          best = [i2, r2, common.length];
        }
      }

      if (best && best[2] >= 2) {
        const [i2, r2] = best;
        matchedPairs.push([i1, r1, i2, r2, 'suspected']);
        used2.add(i2);
        remaining2 = remaining2.filter(([i]) => i !== i2);
      } else {
        stillUnmatched.push([i1, r1]);
      }
    }
    unmatched1 = stillUnmatched;
  }

  // ── 阶3: 邮编精确匹配（仅 POST 有邮编字段） ──
  if (sourceType === 'post' && unmatched1.length) {
    const remaining2 = [];
    records2.forEach((r, i) => { if (!used2.has(i)) remaining2.push([i, r]); });

    const pcIndex = new Map();
    for (const [i2, r2] of remaining2) {
      const pc = String(r2.postcode || '').trim();
      if (pc && pc.length === 6) {
        if (!pcIndex.has(pc)) pcIndex.set(pc, []);
        pcIndex.get(pc).push([i2, r2]);
      }
    }

    const stillUnmatched = [];
    for (const [i1, r1] of unmatched1) {
      const pc1 = String(r1.postcode || '').trim();
      const d1 = r1.district || '';
      if (pc1 && pc1.length === 6 && pcIndex.has(pc1)) {
        let found = false;
        for (const [i2, r2] of pcIndex.get(pc1)) {
          if (used2.has(i2)) continue;
          const d2 = r2.district || '';
          if (d1 && d2 && d1 !== d2) continue;
          matchedPairs.push([i1, r1, i2, r2, 'postcode']);
          used2.add(i2);
          found = true;
          break;
        }
        if (!found) stillUnmatched.push([i1, r1]);
      } else {
        stillUnmatched.push([i1, r1]);
      }
    }
    unmatched1 = stillUnmatched;
  }

  // ── 最终未匹配 ──
  const unmatched2 = [];
  records2.forEach((r, i) => { if (!used2.has(i)) unmatched2.push([i, r]); });

  return { matchedPairs, unmatched1, unmatched2 };
}

// ===================== 变化分类（对应 crawler.py:1220-1314） =====================

/** 匹配方式的中文名 */
const LEVEL_CN = { exact: '精确', suspected: '疑似', postcode: '邮编' };

/** ≥3 个字段同时变化时的告警类别（原文以 ⚠ 开头，汇总时不计数） */
const COMPREHENSIVE = '⚠综合变化(疑似不同网点被错误匹配)';

/**
 * 对匹配记录逐字段对比，分类变化类型。
 * 对应 crawler.py: _classify_changes
 *
 * @returns {Array} changes，元素：
 *   {idx1, idx2, rec1, rec2, matchLevel, categories: string[], details: object}
 *   rec1 = 新版(output)，rec2 = 旧版(base)
 */
function classifyChanges(matchedPairs, sourceType = 'post') {
  const changes = [];

  for (const [idx1, r1, idx2, r2, level] of matchedPairs) {
    const cats = [];
    const details = {};

    // 比较名称（剥离状态标记后比较核心名称）
    const n1 = r1.name || '';
    const n2 = r2.name || '';
    const st1 = extractStatus(n1);
    const st2 = extractStatus(n2);
    if (st1.clean !== st2.clean) {
      cats.push('名称变化');
      details.name_old = n2;
      details.name_new = n1;
    }

    // 比较邮编（仅POST）
    if (sourceType === 'post') {
      const pc1 = r1.postcode || '';
      const pc2 = r2.postcode || '';
      if (pc1 !== pc2) {
        cats.push('邮编变化');
        details.postcode_old = pc2;
        details.postcode_new = pc1;
      }
    }

    // 比较地址（仅POST）
    if (sourceType === 'post') {
      const a1 = r1.address || '';
      const a2 = r2.address || '';
      if (a1 !== a2) {
        cats.push('地址变化');
        details.address_old = a2;
        details.address_new = a1;
      }
    }

    // 比较市
    const c1 = r1.city || '';
    const c2 = r2.city || '';
    if (c1 !== c2) {
      cats.push('区划变化(市)');
      details.city_old = c2;
      details.city_new = c1;
    }

    // 比较区县
    const d1 = r1.district || '';
    const d2 = r2.district || '';
    if (d1 !== d2) {
      cats.push('区划变化(区县)');
      details.district_old = d2;
      details.district_new = d1;
    }

    // 比较营业状态
    if (!sameList(st1.statuses, st2.statuses)) {
      cats.push('营业状态变化');
      details.status_old = st2.statuses.length ? st2.statuses.join(', ') : '正常';
      details.status_new = st1.statuses.length ? st1.statuses.join(', ') : '正常';
    }

    // 比较开办业务（仅SPB）
    if (sourceType === 'spb') {
      const s1 = r1.services || '';
      const s2 = r2.services || '';
      if (s1 !== s2) {
        cats.push('开办业务变化');
        details.services_old = s2;
        details.services_new = s1;
      }
    }

    // 比较详情链接（仅SPB）
    if (sourceType === 'spb') {
      const l1 = r1.detail_link || '';
      const l2 = r2.detail_link || '';
      if (l1 !== l2) {
        cats.push('详情链接变化');
        details.link_old = l2;
        details.link_new = l1;
      }
    }

    if (cats.length) {
      // 综合变化标记：3个及以上字段同时变化
      if (cats.length >= 3) cats.push(COMPREHENSIVE);

      changes.push({ idx1, idx2, rec1: r1, rec2: r2, matchLevel: level, categories: cats, details });
    }
  }

  return changes;
}

// ===================== 连续变化区块（对应 crawler.py:1317-1418） =====================

/**
 * 检测连续变化区块。
 * 对应 crawler.py: _detect_consecutive_blocks
 *
 * 把变化记录和未匹配记录的行号合并排序，找出间隔<=2行的连续差异段；
 * 每个区块内对未匹配记录做二次模糊匹配，给出区块判断。
 *
 * @returns {Array} blocks
 */
function detectConsecutiveBlocks(changes, unmatched1, unmatched2, records1, records2) {
  // 收集所有差异行号（两个文件的行号合并成一个集合，与 Python 一致）
  const diffLines = new Set();
  for (const [idx] of unmatched1) diffLines.add(idx);
  for (const [idx] of unmatched2) diffLines.add(idx);
  for (const c of changes) { diffLines.add(c.idx1); diffLines.add(c.idx2); }

  if (diffLines.size === 0) return [];

  const sortedLines = Array.from(diffLines).sort((a, b) => a - b);
  const spans = [];
  let blockStart = sortedLines[0];
  let prev = sortedLines[0];
  for (const line of sortedLines.slice(1)) {
    if (line - prev > 2) {            // 间隔超过2行，区块断开
      spans.push([blockStart, prev]);
      blockStart = line;
    }
    prev = line;
  }
  spans.push([blockStart, prev]);

  const result = [];
  for (const [start, end] of spans) {
    const blockChanges = changes.filter(
      c => (c.idx1 >= start && c.idx1 <= end) || (c.idx2 >= start && c.idx2 <= end)
    );
    const blockOnly1 = unmatched1.filter(([i]) => i >= start && i <= end);
    const blockOnly2 = unmatched2.filter(([i]) => i >= start && i <= end);

    // 确定区块所属区县
    const districts = new Set();
    for (const c of blockChanges) {
      if (c.rec1.district) districts.add(c.rec1.district);
      if (c.rec2.district) districts.add(c.rec2.district);
    }
    for (const [, r] of blockOnly1) if (r.district) districts.add(r.district);
    for (const [, r] of blockOnly2) if (r.district) districts.add(r.district);
    // Python 侧是 `", ".join(d for d in districts if d)` —— 遍历 set，而 str 哈希按
    // PYTHONHASHSEED 逐进程随机，同一份数据每次跑出来的顺序都不同（实测 seed 1/2/3
    // 三个结果互不相同）。这里取 Set 的插入顺序：集合内容一致，只是顺序确定下来了，
    // 反而比原版可复现。回归脚本比较时会把两侧都排序再比。
    const districtStr = Array.from(districts).join(', ');

    // 在区块内做二次模糊匹配（仅对未匹配记录）
    const fuzzyInBlock = [];
    if (blockOnly1.length && blockOnly2.length) {
      const usedIn2 = new Set();
      for (const [i1, r1] of blockOnly1) {
        const cn1 = onlyChinese(normalizeName(r1.name));
        if (cn1.length < 2) continue;
        let best = null;             // [i2, r2, commonLen, commonStr]
        for (const [i2, r2] of blockOnly2) {
          if (usedIn2.has(i2)) continue;
          const common = findCommonCnSubstring(r1.name, r2.name);
          if (common.length >= 2 && (best === null || common.length > best[2])) {
            best = [i2, r2, common.length, common];
          }
        }
        if (best) {
          fuzzyInBlock.push([r1, best[1], best[3]]);
          usedIn2.add(best[0]);
        }
      }
    }

    // 区块判断
    const nOnly1 = blockOnly1.length;
    const nOnly2 = blockOnly2.length;
    const nChanges = blockChanges.length;
    const nFuzzy = fuzzyInBlock.length;

    const judgmentParts = [];
    if (nChanges > 0) judgmentParts.push(`${nChanges}个网点信息发生变化`);
    if (nFuzzy > 0) judgmentParts.push(`${nFuzzy}对疑似同一网点更名`);
    if (nOnly1 > nFuzzy) judgmentParts.push(`疑似${nOnly1 - nFuzzy}个网点新增`);
    if (nOnly2 > nFuzzy) judgmentParts.push(`疑似${nOnly2 - nFuzzy}个网点撤下`);

    // 只有 >=2 个差异行 或 含未匹配记录时才视为有效区块
    const totalDiff = nChanges + nOnly1 + nOnly2;
    if (totalDiff >= 2) {
      result.push({
        startLine: start,
        endLine: end,
        district: districtStr,
        changesInBlock: blockChanges,
        onlyIn1: blockOnly1,
        onlyIn2: blockOnly2,
        fuzzyMatchesInBlock: fuzzyInBlock,
        judgment: judgmentParts.length ? judgmentParts.join('；') : '该区间存在连续差异',
      });
    }
  }

  return result;
}

// ===================== 报告文本生成（对应 crawler.py:1421-1679） =====================

/** 左对齐补空格，对应 Python 的 f"{s:<n s}" */
function L(s, w) { return String(s == null ? '' : s).padEnd(w); }
/** 右对齐补空格，对应 Python 的 f"{n:>n d}" */
function R(s, w) { return String(s == null ? '' : s).padStart(w); }
/** 连续 n 个横线 */
function dashes(n) { return '-'.repeat(n); }

/** 取记录的邮编；SPB 没有邮编字段，回退到详情链接（对应 Python 的 r.get 链） */
function postcodeOrLink(r) {
  if (r.postcode !== undefined) return r.postcode;
  if (r.detail_link !== undefined) return r.detail_link;
  return '';
}

/** 按区县分组（区县为空则回退到市，再回退「未知」），返回按键排序的 [key, recs[]] */
function groupByDistrict(records) {
  const groups = new Map();
  for (const [, r] of records) {
    const key = r.district || r.city || '未知';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return Array.from(groups.keys()).sort().map(k => [k, groups.get(k)]);
}

/**
 * 生成结构化智能判别报告文本。
 * 对应 crawler.py: _generate_intelligent_report
 *
 * @param {Array} changes
 * @param {Array} unmatched1
 * @param {Array} unmatched2
 * @param {object[]} records1
 * @param {object[]} records2
 * @param {string} sourceType
 * @param {string} prefixLabel
 * @param {Array} blocks 已算好的区块（Python 在函数内算，这里由调用方传入同一份结果）
 * @param {string} nowStr 生成时间字符串 YYYY-MM-DD HH:MM:SS
 * @returns {string[]}
 */
function generateIntelligentReport(changes, unmatched1, unmatched2,
                                   records1, records2,
                                   sourceType, prefixLabel, blocks, nowStr) {
  const lines = [];
  lines.push(`=== 智能判别分析: ${prefixLabel} ===`);
  lines.push(`生成时间: ${nowStr}`);
  lines.push(`数据来源: ${sourceType === 'post' ? '邮政官网(POST)' : '邮管局备案(SPB)'}`);
  lines.push(`新版数据: ${records1.length} 条  |  旧版数据: ${records2.length} 条`);
  lines.push('');

  if (!changes.length && !unmatched1.length && !unmatched2.length) {
    lines.push('  ✓ 两份数据完全一致，无任何差异。');
    return lines;
  }

  // ── 变化汇总 ──
  const catCounts = {};
  for (const c of changes) {
    for (const cat of c.categories) {
      if (cat.startsWith('⚠')) continue;      // 综合变化不算入计数
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
  }

  lines.push('--- 变化汇总 ---');
  const catKeys = Object.keys(catCounts).sort();
  if (catKeys.length) {
    for (const cat of catKeys) lines.push(`  ${L(cat, 18)}: ${R(catCounts[cat], 4)} 条`);
  } else {
    lines.push('  (无字段级变化)');
  }

  const nNew = unmatched1.length;
  const nRemoved = unmatched2.length;
  if (nNew) lines.push(`  ${L('新增网点', 18)}: ${R(nNew, 4)} 条`);
  if (nRemoved) lines.push(`  ${L('撤下网点', 18)}: ${R(nRemoved, 4)} 条`);
  if (blocks.length) lines.push(`  ${L('连续变化区块', 18)}: ${R(blocks.length, 4)} 个`);

  const comprehensive = changes.filter(c => c.categories.some(cat => cat.startsWith('⚠')));
  if (comprehensive.length) {
    lines.push(`  ${L('⚠综合变化(需确认)', 18)}: ${R(comprehensive.length, 4)} 条`);
  }
  lines.push('');

  // ── 名称变化详情 ──
  const nameChanges = changes.filter(c => c.categories.includes('名称变化'));
  if (nameChanges.length) {
    lines.push(`--- 名称变化详情 (${nameChanges.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('旧名称', 28)} ${L('新名称', 28)} ${L('邮编', 8)} ${L('匹配方式', 8)}`);
    lines.push(`  ${dashes(14)} ${dashes(28)} ${dashes(28)} ${dashes(8)} ${dashes(8)}`);
    for (const c of nameChanges) {
      const d = c.rec1.district || '';
      const nOld = c.details.name_old || '';
      const nNew = c.details.name_new || '';
      const pc = c.rec1.postcode || '';
      const levelCn = LEVEL_CN[c.matchLevel] || c.matchLevel;
      lines.push(`  ${L(d, 14)} ${L(nOld, 28)} ${L(nNew, 28)} ${L(pc, 8)} ${L(levelCn, 8)}`);
    }
    lines.push('');
  }

  // ── 邮编变化详情 ──
  const pcChanges = changes.filter(c => c.categories.includes('邮编变化'));
  if (pcChanges.length) {
    lines.push(`--- 邮编变化详情 (${pcChanges.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('网点名称', 28)} ${L('旧邮编', 8)} ${L('新邮编', 8)}`);
    lines.push(`  ${dashes(14)} ${dashes(28)} ${dashes(8)} ${dashes(8)}`);
    for (const c of pcChanges) {
      lines.push(`  ${L(c.rec1.district || '', 14)} ${L(c.rec1.name || '', 28)} ` +
                 `${L(c.details.postcode_old || '', 8)} ${L(c.details.postcode_new || '', 8)}`);
    }
    lines.push('');
  }

  // ── 地址变化详情 ──
  const addrChanges = changes.filter(c => c.categories.includes('地址变化'));
  if (addrChanges.length) {
    lines.push(`--- 地址变化详情 (${addrChanges.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('网点名称', 28)} ${L('旧地址', 40)}`);
    lines.push(`  ${L('', 14)} ${L('', 28)} ${L('新地址', 40)}`);
    lines.push(`  ${dashes(14)} ${dashes(28)} ${dashes(40)}`);
    for (const c of addrChanges) {
      const d = c.rec1.district || '';
      const n = c.rec1.name || '';
      lines.push(`  ${L(d, 14)} ${L(n, 28)} ${L(c.details.address_old || '', 40)}`);
      lines.push(`  ${L('', 14)} ${L('', 28)} → ${L(c.details.address_new || '', 40)}`);
    }
    lines.push('');
  }

  // ── 区划变化详情 ──
  const districtChanges = changes.filter(
    c => c.categories.includes('区划变化(市)') || c.categories.includes('区划变化(区县)')
  );
  if (districtChanges.length) {
    lines.push(`--- 区划变化详情 (${districtChanges.length}条) ---`);
    lines.push(`  ${L('网点名称', 28)} ${L('旧区划', 24)} ${L('新区划', 24)} ${L('类型', 12)}`);
    lines.push(`  ${dashes(28)} ${dashes(24)} ${dashes(24)} ${dashes(12)}`);
    for (const c of districtChanges) {
      const n = c.rec1.name || '';
      let oldLoc; let newLoc; let ctype;
      if (c.categories.includes('区划变化(区县)')) {
        oldLoc = c.details.district_old || '';
        newLoc = c.details.district_new || '';
        ctype = '区县变化';
      } else {
        oldLoc = c.details.city_old || '';
        newLoc = c.details.city_new || '';
        ctype = '地市变化';
      }
      lines.push(`  ${L(n, 28)} ${L(oldLoc, 24)} ${L(newLoc, 24)} ${L(ctype, 12)}`);
    }
    lines.push('');
  }

  // ── 营业状态变化详情 ──
  const statusChanges = changes.filter(c => c.categories.includes('营业状态变化'));
  if (statusChanges.length) {
    lines.push(`--- 营业状态变化详情 (${statusChanges.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('网点名称', 28)} ${L('旧状态', 12)} ${L('新状态', 12)} ${L('邮编', 8)}`);
    lines.push(`  ${dashes(14)} ${dashes(28)} ${dashes(12)} ${dashes(12)} ${dashes(8)}`);
    for (const c of statusChanges) {
      lines.push(`  ${L(c.rec1.district || '', 14)} ${L(c.rec1.name || '', 28)} ` +
                 `${L(c.details.status_old || '', 12)} ${L(c.details.status_new || '', 12)} ` +
                 `${L(c.rec1.postcode || '', 8)}`);
    }
    lines.push('');
  }

  // ── SPB 特有: 开办业务变化 ──
  if (sourceType === 'spb') {
    const svcChanges = changes.filter(c => c.categories.includes('开办业务变化'));
    if (svcChanges.length) {
      lines.push(`--- 开办业务变化详情 (${svcChanges.length}条) ---`);
      lines.push(`  ${L('区县', 14)} ${L('网点名称', 28)} ${L('旧业务', 30)}`);
      lines.push(`  ${L('', 14)} ${L('', 28)} ${L('新业务', 30)}`);
      lines.push(`  ${dashes(14)} ${dashes(28)} ${dashes(30)}`);
      for (const c of svcChanges) {
        const d = c.rec1.district || '';
        const n = c.rec1.name || '';
        lines.push(`  ${L(d, 14)} ${L(n, 28)} ${L(c.details.services_old || '', 30)}`);
        lines.push(`  ${L('', 14)} ${L('', 28)} → ${L(c.details.services_new || '', 30)}`);
      }
      lines.push('');
    }
  }

  // ── 新增网点 ──
  if (unmatched1.length) {
    lines.push(`--- 疑似新增网点 (${unmatched1.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('网点名称', 30)} ${L('邮编', 8)}`);
    lines.push(`  ${dashes(14)} ${dashes(30)} ${dashes(8)}`);
    for (const [dist, recs] of groupByDistrict(unmatched1)) {
      for (const r of recs) {
        lines.push(`  ${L(dist, 14)} ${L(r.name || '', 30)} ${L(postcodeOrLink(r), 8)}`);
      }
    }
    lines.push('');
  }

  // ── 撤下网点 ──
  if (unmatched2.length) {
    lines.push(`--- 疑似撤下网点 (${unmatched2.length}条) ---`);
    lines.push(`  ${L('区县', 14)} ${L('网点名称', 30)} ${L('邮编', 8)}`);
    lines.push(`  ${dashes(14)} ${dashes(30)} ${dashes(8)}`);
    for (const [dist, recs] of groupByDistrict(unmatched2)) {
      for (const r of recs) {
        lines.push(`  ${L(dist, 14)} ${L(r.name || '', 30)} ${L(postcodeOrLink(r), 8)}`);
      }
    }
    lines.push('');
  }

  // ── 连续变化区块 ──
  blocks.forEach((block, bi) => {
    lines.push(
      `--- 连续变化区块 #${bi + 1} ` +
      `(行${block.startLine + 2}-${block.endLine + 2}, ${block.district}) ---`
    );
    lines.push(`  判断: ${block.judgment}`);

    if (block.onlyIn1.length) {
      lines.push(`  区块内新版独有 (${block.onlyIn1.length}条):`);
      for (const [, r] of block.onlyIn1) {
        lines.push(`    + ${L(r.name || '', 30)} ${L(r.postcode || '', 8)}`);
      }
    }

    if (block.onlyIn2.length) {
      lines.push(`  区块内旧版独有 (${block.onlyIn2.length}条):`);
      for (const [, r] of block.onlyIn2) {
        lines.push(`    - ${L(r.name || '', 30)} ${L(r.postcode || '', 8)}`);
      }
    }

    if (block.fuzzyMatchesInBlock.length) {
      lines.push(`  区块内疑似对应 (${block.fuzzyMatchesInBlock.length}对):`);
      for (const [r1, r2, cstr] of block.fuzzyMatchesInBlock) {
        lines.push(
          `    ${r2.name} → ${r1.name}` +
          `  (公共字串: ${cstr}, 旧邮编:${r2.postcode || ''}, 新邮编:${r1.postcode || ''})`
        );
      }
    }

    if (block.changesInBlock.length) {
      lines.push(`  区块内已匹配变化 (${block.changesInBlock.length}条):`);
      for (const c of block.changesInBlock) {
        lines.push(
          `    ${c.rec2.name} → ${c.rec1.name}` +
          `  [${c.categories.join(', ')}]`
        );
      }
    }
    lines.push('');
  });

  // ── 综合变化警告 ──
  if (comprehensive.length) {
    lines.push(`--- ⚠ 综合变化需人工确认 (${comprehensive.length}条) ---`);
    lines.push('  以下记录有3个及以上字段同时变化，可能是不同网点被错误匹配：');
    // 注意：末列在 Python 里是 {'变化类型'}，没有格式说明符 → 不补空格（下面的分隔线却是 40 个横线）
    lines.push(`  ${L('旧名称', 30)} ${L('新名称', 30)} 变化类型`);
    lines.push(`  ${dashes(30)} ${dashes(30)} ${dashes(40)}`);
    for (const c of comprehensive) {
      // 末列同样不补空格（见上面的表头）
      lines.push(`  ${L(c.rec2.name || '', 30)} ${L(c.rec1.name || '', 30)} ${c.categories.join(', ')}`);
    }
    lines.push('');
  }

  return lines;
}

// ===================== 单文件对入口（对应 crawler.py:1682-1735） =====================

/** 来自文件名判断数据源 */
function sourceTypeFromPrefix(prefix) {
  if (prefix && prefix.startsWith('post')) return 'post';
  if (prefix && prefix.startsWith('spb')) return 'spb';
  return null;
}

/** 结构化明细列表的裁剪上限（完整内容在报告文本里） */
const DETAIL_CAP = 200;

function capList(list, cap = DETAIL_CAP) {
  return list.length > cap ? list.slice(0, cap) : list;
}

/**
 * 对两个同源 CSV 记录集进行智能判别对比。
 * 对应 crawler.py: intelligent_compare（这里直接吃已解析的记录数组）
 *
 * @param {object[]} records1 新版记录（output）
 * @param {object[]} records2 旧版记录（base）
 * @param {string} [sourceType] 'post' | 'spb'，缺省按 prefixLabel 判断，再缺省按 post
 * @param {string} [prefixLabel] 报告标题里显示的文件名
 * @param {object} [opts] { now: Date, cap: number }
 * @returns {object} {
 *   lines, sourceType, newCount, oldCount,
 *   summary: { byCategory, new, removed, blocks, comprehensive },
 *   changes, unmatched1, unmatched2, blocks      // 已按 cap 裁剪
 * }
 */
function intelligentCompare(records1, records2, sourceType, prefixLabel, opts) {
  const o = opts || {};
  const cap = o.cap === undefined ? DETAIL_CAP : o.cap;
  const src = sourceType || sourceTypeFromPrefix(prefixLabel) || 'post';
  const label = prefixLabel || '';

  const now = o.now || new Date();
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
                 `${String(now.getDate()).padStart(2, '0')} ` +
                 `${String(now.getHours()).padStart(2, '0')}:` +
                 `${String(now.getMinutes()).padStart(2, '0')}:` +
                 `${String(now.getSeconds()).padStart(2, '0')}`;

  const empty = !records1.length && !records2.length;
  if (empty) {
    return {
      lines: [`=== 智能判别分析: ${label} ===`, '两份文件均为空，无法对比。'],
      sourceType: src, newCount: 0, oldCount: 0,
      summary: { byCategory: {}, new: 0, removed: 0, blocks: 0, comprehensive: 0 },
      changes: [], unmatched1: [], unmatched2: [], blocks: [],
    };
  }

  const { matchedPairs, unmatched1, unmatched2 } = matchSameSource(records1, records2, src);
  const changes = classifyChanges(matchedPairs, src);
  const blocks = detectConsecutiveBlocks(changes, unmatched1, unmatched2, records1, records2);

  const lines = generateIntelligentReport(
    changes, unmatched1, unmatched2, records1, records2, src, label, blocks, nowStr
  );

  // 汇总（用于弹窗卡片）：分类计数与报告正文同源
  const byCategory = {};
  for (const c of changes) {
    for (const cat of c.categories) {
      if (cat.startsWith('⚠')) continue;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
  }

  return {
    lines,
    sourceType: src,
    newCount: records1.length,
    oldCount: records2.length,
    summary: {
      byCategory,
      new: unmatched1.length,
      removed: unmatched2.length,
      blocks: blocks.length,
      comprehensive: changes.filter(c => c.categories.some(cat => cat.startsWith('⚠'))).length,
    },
    // 明细裁剪后返回；完整内容在 lines（报告文本）里
    changes: capList(changes, cap),
    unmatched1: capList(unmatched1, cap),
    unmatched2: capList(unmatched2, cap),
    blocks: capList(blocks, cap),
  };
}

module.exports = {
  NAME_SUFFIXES,
  normalizeName,
  findCommonCnSubstring,
  STATUS_PATTERNS,
  COMPREHENSIVE,
  LEVEL_CN,
  extractStatus,
  matchSameSource,
  classifyChanges,
  detectConsecutiveBlocks,
  generateIntelligentReport,
  intelligentCompare,
  DETAIL_CAP,
};
