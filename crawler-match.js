/**
 * 横向对比匹配引擎 — crawler.py 的 JS 移植
 * ==========================================
 * 纯函数模块（不做任何 I/O），便于单独测试与回归比对。
 * 逐行对应 crawler.py 的 normalize_name / _enhanced_normalize_spb /
 * _find_longest_common_substring / _find_common_cn_substring /
 * _is_special_zone / _cross_match。
 *
 * 记录结构:
 *   POST: { province, city, district, name, postcode, address }
 *   SPB : { province, city, district, name, services, detailLink }
 */

'use strict';

// ===================== 常量 =====================

/** 网点名称归一化时需要剥离的后缀（长后缀优先匹配，与原脚本同序） */
const NAME_SUFFIXES = [
  '（假期暂停）', '(假期暂停)',
  '（暂停）', '(暂停)',
  '（装修中）', '(装修中)',
  '（临时停业）', '(临时停业)',
  '邮政营业厅',
  '邮政服务中心',
  '邮政代办所',
  '邮政支局',
  '邮政所',
  '邮政营业',
  '邮政',
  '支局',       // 无"邮政"前缀的裸"支局"（如"东贸路支局"）
];

/** 匹配括号注释的正则（全角/半角括号） */
const ANNOTATION_RE = /[（(][^）)]*[）)]/g;

/** 中国邮政集团有限公司 / 中国邮政集团公司 前缀 */
const COMPANY_PREFIX = '中国邮政集团有限公司';
const GROUP_PREFIX = '中国邮政集团公司';
const POSTAL_BUREAU_SUFFIX = '邮政局';

// ===================== 基础工具 =====================

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

/** 仅保留汉字（U+4E00–U+9FFF），对应 Python 的 "一" <= c <= "鿿" */
function onlyChinese(s) {
  let out = '';
  for (const ch of s) {
    if (ch >= '一' && ch <= '鿿') out += ch;
  }
  return out;
}

/**
 * 两个字符串的最长公共子串（DP）。
 * 对应 crawler.py: _find_longest_common_substring
 */
function findLongestCommonSubstring(s1, s2) {
  if (!s1 || !s2) return '';
  const m = s1.length;
  const n = s2.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  let maxLen = 0;
  let endPos = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) {
          maxLen = curr[j];
          endPos = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return s1.slice(endPos - maxLen, endPos);
}

/**
 * 剥离后缀后，提取两个名称的公共中文字符子串（>=2个汉字）。
 * 对应 crawler.py: _find_common_cn_substring
 */
function findCommonCnSubstring(name1, name2) {
  const cn1 = onlyChinese(normalizeName(name1));
  const cn2 = onlyChinese(normalizeName(name2));
  if (cn1.length < 2 || cn2.length < 2) return '';
  const lcs = findLongestCommonSubstring(cn1, cn2);
  return lcs.length >= 2 ? lcs : '';
}

/**
 * 判断区县名称是否包含特殊园区关键字。
 * 对应 crawler.py: _is_special_zone
 */
function isSpecialZone(district) {
  if (!district) return false;
  // "新城区"是正规行政区划名（如呼和浩特/西安/南宁），非特殊园区，排除
  if (district === '新城区' || district.endsWith('市新城区')) return false;
  const keywords = ['新区', '新城', '开发区', '示范区', '聚集区', '管理区'];
  return keywords.some(kw => district.includes(kw));
}

/**
 * SPB 名称增强归一化：生成多个候选归一化形式用于匹配。
 * 对应 crawler.py: _enhanced_normalize_spb
 * @returns {Set<string>}
 */
function enhancedNormalizeSpb(name, city = '', district = '', province = '') {
  const results = new Set();
  name = String(name == null ? '' : name).trim();

  // 策略1: 标准归一化（始终包含）
  const std = normalizeName(name);
  if (std) results.add(std);

  const addNorm = (candidate) => {
    const norm = normalizeName(candidate);
    if (norm) results.add(norm);
  };

  // 策略2: 剥离"中国邮政集团有限公司"及其后续层级前缀
  if (name.startsWith(COMPANY_PREFIX)) {
    const working = name.slice(COMPANY_PREFIX.length);
    const candidates = [];

    if (province) {
      // 2a: 剥离 "{省名}分公司" / "{省名}省分公司"
      for (const branchSuffix of ['分公司', '省分公司']) {
        const branchPrefix = province + branchSuffix;
        if (working.startsWith(branchPrefix)) {
          candidates.push(working.slice(branchPrefix.length));
          break;  // 匹配到最长的一个即可
        }
      }
      // 2b: 剥离省名后继续尝试剥离地市/区县名
      if (working.startsWith(province)) {
        let afterProvince = working.slice(province.length);
        for (const loc of [city, district]) {
          if (loc && afterProvince.startsWith(loc)) afterProvince = afterProvince.slice(loc.length);
        }
        if (afterProvince.length >= 2) candidates.push(afterProvince);
      }
    }

    // 2c: 剥离地市名
    for (const loc of [city, district]) {
      if (loc && working.startsWith(loc)) {
        let afterLoc = working.slice(loc.length);
        for (const loc2 of [district, city]) {
          if (loc2 && loc2 !== loc && afterLoc.startsWith(loc2)) {
            afterLoc = afterLoc.slice(loc2.length);
            break;
          }
        }
        if (afterLoc.length >= 2) candidates.push(afterLoc);
      }
    }

    // 如果上述都没有命中，直接使用 working 作为候选
    if (candidates.length === 0 && working.length >= 2) candidates.push(working);
    candidates.forEach(addNorm);
  }

  // 策略3: 剥离开头的地市名
  if (city && name.startsWith(city)) {
    const candidate = name.slice(city.length);
    if (candidate.length >= 2) addNorm(candidate);
  }

  // 策略4: 剥离开头的区县名
  if (district && name.startsWith(district)) {
    const candidate = name.slice(district.length);
    if (candidate.length >= 2) addNorm(candidate);
  }

  // 策略5: 剥离"{地市}邮政局"前缀（如"沈阳市邮政局马官桥邮政支局"）
  if (city) {
    const bureauPrefix = city + POSTAL_BUREAU_SUFFIX;
    if (name.startsWith(bureauPrefix)) {
      const candidate = name.slice(bureauPrefix.length);
      if (candidate.length >= 2) addNorm(candidate);
    }
  }

  // 策略6: 剥离"{区县}邮政局"前缀（如"康平县邮政局四家子邮政支局"）
  if (district) {
    const bureauPrefix = district + POSTAL_BUREAU_SUFFIX;
    if (name.startsWith(bureauPrefix)) {
      const candidate = name.slice(bureauPrefix.length);
      if (candidate.length >= 2) addNorm(candidate);
    }
  }

  // 策略7: 剥离"中国邮政集团公司"及其后续地市/区县前缀
  if (name.startsWith(GROUP_PREFIX)) {
    const working = name.slice(GROUP_PREFIX.length);
    const candidates = [];
    for (const loc of [city, district]) {
      if (loc && working.startsWith(loc)) {
        let afterLoc = working.slice(loc.length);
        for (const loc2 of [district, city]) {
          if (loc2 && loc2 !== loc && afterLoc.startsWith(loc2)) {
            afterLoc = afterLoc.slice(loc2.length);
            break;
          }
        }
        if (afterLoc.length >= 2) candidates.push(afterLoc);
      }
    }
    if (candidates.length === 0 && working.length >= 2) candidates.push(working);
    candidates.forEach(addNorm);
  }

  return results;
}

// ===================== 多阶匹配引擎 =====================

/** 区县一致性判定：普通区县必须相同；任一方为特殊园区则放宽 */
function districtCompatible(postDistrict, spbDistrict) {
  if (!postDistrict || !spbDistrict || postDistrict === spbDistrict) {
    return { ok: true, note: '' };
  }
  if (isSpecialZone(postDistrict) || isSpecialZone(spbDistrict)) {
    return { ok: true, note: `【${postDistrict}↔${spbDistrict}】` };
  }
  return { ok: false, note: '' };
}

/**
 * 多阶名称匹配引擎。
 * 对应 crawler.py: _cross_match
 *
 * 阶1 精确匹配 → 阶2 标准/增强归一化 → 阶3 公共子串 →
 * 阶4 模糊匹配（可选）→ 阶5 跨区县末次匹配
 */
function crossMatch(postRecords, spbRecords, options = {}) {
  const enableFuzzy = !!options.enableFuzzy;
  const fuzzyThreshold = options.fuzzyThreshold == null ? 0.8 : options.fuzzyThreshold;

  // ── 阶1: 精确匹配 ──
  const spbByName = new Map();
  spbRecords.forEach((r, idx) => {
    if (!spbByName.has(r.name)) spbByName.set(r.name, []);
    spbByName.get(r.name).push([idx, r]);
  });

  const usedSpb = new Set();
  const matchedExact = [];
  let postUnmatched = [];

  for (const post of postRecords) {
    const pname = post.name;
    const postDistrict = post.district || '';
    const bucket = spbByName.get(pname);
    let found = false;
    if (bucket) {
      for (const [si, spbRec] of bucket) {
        if (usedSpb.has(si)) continue;
        // 区县名必须一致，防止跨区县误匹配
        const spbDistrict = spbRec.district || '';
        if (postDistrict && spbDistrict && postDistrict !== spbDistrict) continue;
        matchedExact.push([post, spbRec]);
        usedSpb.add(si);
        found = true;
        break;
      }
    }
    if (!found) postUnmatched.push(post);
  }

  // ── 阶2: 归一化匹配（Pass1 标准归一化） ──
  const spbByNormalized = new Map();
  spbRecords.forEach((r, idx) => {
    if (usedSpb.has(idx)) return;
    const norm = normalizeName(r.name);
    if (!norm) return;
    if (!spbByNormalized.has(norm)) spbByNormalized.set(norm, []);
    spbByNormalized.get(norm).push([idx, r]);
  });

  const matchedNormalized = [];
  let stillUnmatched = [];
  for (const post of postUnmatched) {
    const pnorm = normalizeName(post.name);
    const postDistrict = post.district || '';
    const bucket = pnorm ? spbByNormalized.get(pnorm) : null;
    if (bucket) {
      let found = false;
      for (const [si, spbRec] of bucket) {
        if (usedSpb.has(si)) continue;
        const spbDistrict = spbRec.district || '';
        if (postDistrict && spbDistrict && postDistrict !== spbDistrict) continue;
        matchedNormalized.push([post, spbRec]);
        usedSpb.add(si);
        found = true;
        break;
      }
      if (!found) stillUnmatched.push(post);
    } else {
      stillUnmatched.push(post);
    }
  }

  // ── 阶2 Pass2: 增强归一化（SPB 侧使用多种策略剥离前缀） ──
  if (stillUnmatched.length > 0 && usedSpb.size < spbRecords.length) {
    const spbEnhanced = new Map();
    spbRecords.forEach((r, idx) => {
      if (usedSpb.has(idx)) return;
      const forms = enhancedNormalizeSpb(
        r.name, r.city || '', r.district || '', r.province || ''
      );
      for (const form of forms) {
        if (!spbEnhanced.has(form)) spbEnhanced.set(form, []);
        spbEnhanced.get(form).push([idx, r]);
      }
    });

    const stillUnmatched2 = [];
    for (const post of stillUnmatched) {
      const pnorm = normalizeName(post.name);
      const postDistrict = post.district || '';
      const bucket = pnorm ? spbEnhanced.get(pnorm) : null;
      if (bucket) {
        let found = false;
        for (const [si, spbRec] of bucket) {
          if (usedSpb.has(si)) continue;
          const spbDistrict = spbRec.district || '';
          if (postDistrict && spbDistrict && postDistrict !== spbDistrict) continue;
          matchedNormalized.push([post, spbRec]);
          usedSpb.add(si);
          found = true;
          break;
        }
        if (!found) stillUnmatched2.push(post);
      } else {
        stillUnmatched2.push(post);
      }
    }
    stillUnmatched = stillUnmatched2;
  }

  // ── 阶3: 疑似匹配（公共中文字符子串 >= 2字） ──
  const matchedSuspected = [];
  if (stillUnmatched.length > 0) {
    let remainingSpbForSuspect = [];
    spbRecords.forEach((r, idx) => {
      if (!usedSpb.has(idx)) remainingSpbForSuspect.push([idx, r]);
    });

    const postCores = stillUnmatched.map(post => onlyChinese(normalizeName(post.name)));
    const stillUnmatched3 = [];

    for (let pi = 0; pi < stillUnmatched.length; pi++) {
      const post = stillUnmatched[pi];
      const postCn = postCores[pi];
      if (postCn.length < 2) {
        stillUnmatched3.push(post);
        continue;
      }
      const postDistrict = post.district || '';
      const postIsSpecial = isSpecialZone(postDistrict);
      let bestMatch = null;   // [si, spbRec, commonStr, note]
      let bestLen = 0;

      for (const [si, spbRec] of remainingSpbForSuspect) {
        const spbDistrict = spbRec.district || '';
        let districtNote = '';
        if (postDistrict && spbDistrict && postDistrict !== spbDistrict) {
          const spbIsSpecial = isSpecialZone(spbDistrict);
          if (postIsSpecial || spbIsSpecial) {
            // 特殊园区：允许跨区县匹配，但在备注中标注
            districtNote = `【${postDistrict}↔${spbDistrict}】`;
          } else {
            continue;  // 普通区县不同，跳过
          }
        }
        const common = findCommonCnSubstring(post.name, spbRec.name);
        if (common.length > bestLen) {
          bestLen = common.length;
          bestMatch = [si, spbRec, common, districtNote];
        }
      }

      if (bestMatch && bestLen >= 2) {
        const [si, spbRec, commonStr, note] = bestMatch;
        matchedSuspected.push([post, spbRec, commonStr, note]);
        usedSpb.add(si);
        remainingSpbForSuspect = remainingSpbForSuspect.filter(([idx]) => idx !== si);
      } else {
        stillUnmatched3.push(post);
      }
    }
    stillUnmatched = stillUnmatched3;
  }

  // ── 阶4: 模糊匹配（可选） ──
  const matchedFuzzy = [];
  let finalPostOnly = [];

  if (enableFuzzy && stillUnmatched.length > 0) {
    const remainingSpb = [];
    spbRecords.forEach((r, idx) => {
      if (!usedSpb.has(idx)) remainingSpb.push([idx, r]);
    });

    const spbCoreMap = new Map();   // norm → [idx, rec]
    const spbCoreList = [];
    for (const [idx, r] of remainingSpb) {
      // 取最简形式（最短非空结果）
      const forms = Array.from(enhancedNormalizeSpb(
        r.name, r.city || '', r.district || '', r.province || ''
      )).filter(Boolean);
      forms.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
      for (const norm of forms) {
        if (!spbCoreMap.has(norm)) {
          spbCoreMap.set(norm, [idx, r]);
          spbCoreList.push(norm);
        }
      }
    }

    for (const post of stillUnmatched) {
      const pnorm = normalizeName(post.name);
      const postDistrict = post.district || '';
      if (!pnorm || spbCoreList.length === 0) {
        finalPostOnly.push(post);
        continue;
      }
      const matches = getCloseMatches(pnorm, spbCoreList, 1, fuzzyThreshold);
      if (matches.length > 0) {
        const matchedNorm = matches[0];
        const [si, spbRec] = spbCoreMap.get(matchedNorm);
        const spbDistrict = spbRec.district || '';
        if (postDistrict && spbDistrict && postDistrict !== spbDistrict) {
          finalPostOnly.push(post);
          continue;
        }
        const ratio = sequenceRatio(pnorm, matchedNorm);
        matchedFuzzy.push([post, spbRec, ratio]);
        usedSpb.add(si);
        spbCoreList.splice(spbCoreList.indexOf(matchedNorm), 1);
        spbCoreMap.delete(matchedNorm);
      } else {
        finalPostOnly.push(post);
      }
    }
  } else {
    finalPostOnly = stillUnmatched;
  }

  // ── 阶5: 跨区县末次匹配（不限制区县，对剩余记录做归一化+子串匹配） ──
  const matchedCrossDistrict = [];
  if (finalPostOnly.length > 0) {
    let remainingSpbFinal = [];
    spbRecords.forEach((r, idx) => {
      if (!usedSpb.has(idx)) remainingSpbFinal.push([idx, r]);
    });

    if (remainingSpbFinal.length > 0) {
      const spbCrossMap = new Map();
      for (const [idx, r] of remainingSpbFinal) {
        const forms = enhancedNormalizeSpb(
          r.name, r.city || '', r.district || '', r.province || ''
        );
        for (const form of forms) {
          if (!spbCrossMap.has(form)) spbCrossMap.set(form, [idx, r]);
        }
      }

      const stillFinal = [];
      for (const post of finalPostOnly) {
        const pnorm = normalizeName(post.name);
        if (pnorm && spbCrossMap.has(pnorm)) {
          const [si, spbRec] = spbCrossMap.get(pnorm);
          let districtNote = '';
          const pd = post.district || '';
          const sd = spbRec.district || '';
          if (pd && sd && pd !== sd) districtNote = `【${pd}↔${sd}】`;
          matchedCrossDistrict.push([post, spbRec, '归一化', districtNote]);
          usedSpb.add(si);
        } else if (pnorm && pnorm.length >= 2) {
          // 尝试公共子串匹配
          let bestStr = '';
          let bestSi = null;
          let bestSr = null;
          for (const [si, spbRec] of remainingSpbFinal) {
            const common = findCommonCnSubstring(post.name, spbRec.name);
            if (common.length > bestStr.length) {
              bestStr = common;
              bestSi = si;
              bestSr = spbRec;
            }
          }
          if (bestStr && bestStr.length >= 2) {
            let districtNote = '';
            const pd = post.district || '';
            const sd = bestSr.district || '';
            if (pd && sd && pd !== sd) districtNote = `【${pd}↔${sd}】`;
            matchedCrossDistrict.push([post, bestSr, `子串:${bestStr}`, districtNote]);
            usedSpb.add(bestSi);
            remainingSpbFinal = remainingSpbFinal.filter(([i]) => i !== bestSi);
          } else {
            stillFinal.push(post);
          }
        } else {
          stillFinal.push(post);
        }
      }
      finalPostOnly = stillFinal;
    }
  }

  // ── 剩余 SPB 记录 ──
  const finalSpbOnly = spbRecords.filter((_, idx) => !usedSpb.has(idx));

  return {
    matchedExact,
    matchedNormalized,
    matchedSuspected,
    matchedFuzzy,
    matchedCrossDistrict,
    postOnly: finalPostOnly,
    spbOnly: finalSpbOnly,
  };
}

// ===================== difflib 等价实现 =====================

/**
 * difflib.SequenceMatcher(None, a, b).ratio() 的等价实现。
 * ratio = 2 * M / (len(a) + len(b))，M 为匹配字符总数（ratcliff-obershelp，
 * 含 junk 处理与 autojunk：b 长度 >= 200 时出现次数超过 1% 的字符视为 popular）。
 */
function sequenceRatio(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  let matches = 0;
  for (const m of getMatchingBlocks(a, b)) matches += m.size;
  return (2 * matches) / (la + lb);
}

/** 等价 difflib.get_close_matches(word, possibilities, n, cutoff) */
function getCloseMatches(word, possibilities, n = 3, cutoff = 0.6) {
  if (n <= 0) return [];
  const result = [];
  for (const p of possibilities) {
    const ratio = sequenceRatio(word, p);
    if (ratio >= cutoff) result.push([ratio, p]);
  }
  // 按相似度降序；同分保持原有相对顺序（与 difflib 的排序稳定性一致）
  result.sort((x, y) => y[0] - x[0]);
  return result.slice(0, n).map(x => x[1]);
}

/**
 * difflib 的匹配块算法（find_longest_match + 递归），返回 [{a, b, size}]。
 * 用于计算 ratio，实现与原脚本一致的相似度。
 */
function getMatchingBlocks(a, b) {
  const b2j = new Map();
  const popular = new Set();

  // autojunk: b 长度 >= 200 时，出现频率 > 1% 的字符视为 popular（不予匹配）
  const autojunk = b.length >= 200;
  const ntest = Math.floor(b.length / 100) + 1;

  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    if (b2j.has(ch)) b2j.get(ch).push(i);
    else b2j.set(ch, [i]);
  }
  if (autojunk) {
    for (const [ch, idxs] of b2j) {
      if (idxs.length > ntest) {
        popular.add(ch);
      }
    }
    for (const ch of popular) b2j.delete(ch);
  }

  const queue = [[0, a.length, 0, b.length]];
  const matchingBlocks = [];

  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (m.size > 0) {
      matchingBlocks.push(m);
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
  }

  matchingBlocks.sort((x, y) => (x.a - y.a) || (x.b - y.b));
  return matchingBlocks;
}

/** difflib.SequenceMatcher.find_longest_match 的等价实现 */
function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const idxs = b2j.get(a[i]);
    if (idxs) {
      for (const j of idxs) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }

  // 向两侧扩展 junk 边界（本实现无 junk 元素，仅保留边界收敛逻辑）
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (
    besti + bestsize < ahi && bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }

  return { a: besti, b: bestj, size: bestsize };
}

module.exports = {
  NAME_SUFFIXES,
  normalizeName,
  onlyChinese,
  findLongestCommonSubstring,
  findCommonCnSubstring,
  isSpecialZone,
  enhancedNormalizeSpb,
  crossMatch,
  sequenceRatio,
  getCloseMatches,
};
