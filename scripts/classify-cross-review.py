# -*- coding: utf-8 -*-
"""
对两组待复核差异行做证据计算 + 自动判定。

口径（按用户确认）：
  · 名称/邮编/街道级地址能对上 → 同一网点
  · 「名称一致 + 邮编一致但地址不同」的，若两边同属一个乡镇/街道 → 同一网点，
    明显指向不同地点 → 存疑，留给人工
  · 配对明显配错的（官网网点在备案库里另有同名记录）→ 直接换成正确配对

用法: python scripts/classify-cross-review.py [YYYYMMDD]
产出: output/_review_work.tsv、output/_repair_links.json（需要补抓详情的链接）
"""

import csv
import difflib
import json
import os
import re
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "output")
DATE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else "20260929"

PROVINCES = ["bj", "tj", "he", "sx", "nm", "ln", "jl", "hl", "sh", "js", "zj", "ah",
             "fj", "jx", "sd", "ha", "hb", "hn", "gd", "gx", "hi", "cq", "sc", "gz",
             "yn", "xz", "sn", "gs", "qh", "nx", "xj"]

ANN_RE = re.compile(r"[（(][^）)]*[）)]")
SUFFIXES = ["邮政营业厅", "邮政服务中心", "邮政代办所", "邮电支局", "邮电所",
            "邮政支局", "邮政所", "邮政营业", "邮政", "支局", "代办所"]
GENERIC = {"中心", "大道", "大街", "车站", "花园", "小区", "新城", "新区", "开发区",
           "邮政", "广场", "人民", "建设", "新华", "解放", "光明", "新村", "公园",
           "学校", "学院", "医院", "市场", "商城", "大厦", "大楼", "一路", "南路",
           "西街", "东街", "南街", "北街", "文化", "振兴", "长安"}
TOWN_RE = re.compile(r"([\u4e00-\u9fa5]{2,6}?(?:镇|乡|街道))")


def clean_addr(s):
    return re.sub(r"[\s，,。、号\-()（）]", "", s or "")


def strip_tokens(s, tokens):
    a = clean_addr(s)
    for t in sorted({t for t in tokens if t and len(t) >= 2}, key=len, reverse=True):
        a = a.replace(t, "")
    return a


def lcs_len(a, b):
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def addr_ratio(a, b):
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def addr_rel(a, b):
    if not a or not b:
        return "unknown"
    if a == b:
        return "same"
    if (a in b or b in a) and min(len(a), len(b)) >= 4:
        return "contains"
    if lcs_len(a, b) >= 5:
        return "lcs"
    r = addr_ratio(a, b)
    if r >= 0.6:
        return "high"
    if r >= 0.35:
        return "mid"
    return "low"


def towns_of(addr):
    return {m for m in TOWN_RE.findall(addr or "")}


def town_core(t):
    return re.sub(r"(镇|乡|街道)$", "", t)


CITY_LIKE = re.compile(r"(市|州|盟|地区)$")


def core_name(name, tokens):
    n = ANN_RE.sub("", name or "").strip()
    n = n.replace("中国邮政集团有限公司", "").replace("中国邮政集团公司", "").replace("中国邮政", "")
    for t in tokens:
        if t and len(t) >= 2:
            n = n.replace(t, "")
    changed = True
    while changed:
        changed = False
        for suf in SUFFIXES:
            if n.endswith(suf) and len(n) > len(suf):
                n = n[: -len(suf)]
                changed = True
    return n.strip()


def load_spb_pool():
    pool = {}
    for abbr in PROVINCES:
        path = os.path.join(OUT_DIR, f"spb{abbr}-{DATE}.csv")
        if not os.path.exists(path):
            continue
        with open(path, encoding="gbk", newline="") as fh:
            for row in list(csv.reader(fh))[1:]:
                if len(row) < 6:
                    continue
                pool.setdefault(row[0].strip(), []).append({
                    "城市": row[1].strip(), "区县": row[2].strip(),
                    "名称": row[3].strip(), "链接": row[5].strip(),
                })
    return pool


def build(s):
    """给定一条待复核行 + 备案详情，算出所有信号与判定"""
    cp, cs = s["官网核心"], s["备案核心"]
    same_name = bool(cp) and cp == cs
    cont = bool(cp and cs) and min(len(cp), len(cs)) >= 2 and \
        (cp in cs or cs in cp) and (min(len(cp), len(cs)) >= 3 or (cp not in GENERIC and cs not in GENERIC))
    rel = s["地址关系"]

    town_p = towns_of(s["官网地址核"])
    town_s = towns_of(s["备案地址核"])
    town_same = bool(town_p & town_s)
    town_diff = bool(town_p and town_s and not (town_p & town_s))
    short_core = cp if len(cp) <= len(cs) else cs
    core_in_both = bool(short_core) and len(short_core) >= 2 and \
        short_core in s["官网地址核"] and short_core in s["备案地址核"]
    contain2 = bool(s["官网地址核"] and s["备案地址核"]) and (
        s["官网地址核"] in s["备案地址核"] or s["备案地址核"] in s["官网地址核"])
    # 只有一边写了乡镇/街道时，看该乡镇名是否同时出现在两边的网点名里
    one_town = (town_p or town_s) and not (town_p and town_s)
    town_in_names = False
    if one_town and (same_name or cont):
        for t in (town_p | town_s):
            c = town_core(t)
            if len(c) >= 2 and c in s["官网名称"] and c in s["备案名称"]:
                town_in_names = True
                break
    # 两边备案城市明显不是同一个市（排除开发区那类写法）
    city_s = (s.get("备案所属市") or "").strip()
    city_mismatch = bool(city_s and CITY_LIKE.search(city_s) and city_s != s["市"]
                         and city_s not in s["市"] and s["市"] not in city_s)

    s.update({
        "同名": same_name, "名称包含": cont, "乡镇同": town_same, "乡镇异": town_diff,
        "乡镇_官网": "/".join(sorted(town_p)), "乡镇_备案": "/".join(sorted(town_s)),
        "核心在两边地址": core_in_both, "地址互含": contain2,
        "乡镇名在两边网点名": town_in_names, "备案市不同": city_mismatch,
    })

    # ── 判定 ──
    if s["官网名称"] == s["备案名称"]:
        return "同一网点", "名称完全相同"
    if rel in ("same", "contains"):
        return "同一网点", "地址一致"
    if core_in_both:
        return "同一网点", "网点名出现在两边地址"
    if (same_name or cont) and rel in ("lcs", "high", "mid"):
        return "同一网点", "名称一致 + 地址相近"
    if town_same and (same_name or cont):
        return "同一网点", "名称一致 + 同乡镇/街道"
    if town_in_names:
        return "同一网点", "名称一致 + 乡镇名两边都在用"
    if (same_name or cont) and (not s["官网地址核"] or not s["备案地址核"]):
        return "同一网点", "名称一致 + 一方地址只有行政区、无街道信息"
    if (same_name or cont) and contain2:
        return "同一网点", "名称一致 + 地址互相包含"
    if city_mismatch and rel in ("low", "unknown") and not same_name:
        return "不同网点", "备案网点在别的市 + 名称地址均不同"
    if town_diff and not s["邮编一致"] and not same_name:
        return "不同网点", "不同乡镇 + 邮编不同 + 名称不同"
    if rel in ("low", "mid", "unknown") and not same_name and not cont:
        return "不同网点", "名称不同 + 地址不同"
    if town_diff and not same_name:
        return "不同网点", "不同乡镇 + 名称不同"
    # 地址对不上，但按确认口径一律算同一网点，出入情况记到「地址出入」里
    if (same_name or cont) and s["邮编一致"]:
        return "同一网点", "名称一致 + 邮编一致（地址指向不同地点）"
    if same_name or cont:
        return "同一网点", "名称一致（地址、邮编均不同）"
    return "同一网点", "名称相近、地址邮编均不同，按确认口径计入"


def flag_addr(s):
    """标记「判为同一网点、但两边地址对不上」的情况，供总结使用"""
    s["地址出入"] = ""
    if s["判定"] != "同一网点":
        return
    reason = s["依据"]
    if ("地址指向不同地点" in reason or "地址、邮编均不同" in reason
            or "地址邮编均不同" in reason):
        s["地址出入"] = "重点：名称一致，但地址指向不同地点"
    elif s["地址关系"] in ("low", "mid", "unknown"):
        s["地址出入"] = "地址表述/详略不同"


def main():
    rows = json.load(open(os.path.join(OUT_DIR, f"cross_diff_rows_{DATE}.json"), encoding="utf-8"))["rows"]
    cache = json.load(open(os.path.join(OUT_DIR, f"spb_details_{DATE}.json"), encoding="utf-8"))
    pool = load_spb_pool()

    targets = [(i, r) for i, r in enumerate(rows)
               if (r["差异类型"] == "suspected" and not r.get("区县是否相同"))
               or (r["差异类型"] == "cross_district" and r.get("匹配方式") != "归一化")]

    out = []
    repair_links = {}
    repaired = 0

    for src_idx, r in targets:
        prov, city = r["省"], r["市"]
        pd, sd = r.get("邮政官网区县") or "", r.get("邮管局区县") or ""
        paired_link = r.get("备案链接") or ""
        d = cache.get(paired_link, {}) or {}

        s = {
            "源序号": src_idx,
            "类型": r["差异类型"], "省": prov, "市": city,
            "官网区县": pd, "备案区县": sd,
            "官网名称": r["邮政官网名称"], "备案名称": r["邮管局名称"],
            "官网核心": core_name(r["邮政官网名称"], [prov, city, pd]),
            "备案核心": core_name(r["邮管局名称"], [prov, city, sd, d.get("所属市", ""), d.get("所属区县", "")]),
            "公共字串": r.get("公共字串") or "",
            "相似度": round(r.get("名称相似度") or 0, 3),
            "官网邮编": r.get("邮编") or "", "备案邮编": d.get("邮政编码") or "",
            "官网地址": r.get("地址") or "", "备案地址": d.get("地址") or "",
            "备案链接": paired_link, "配对已修正": "", "备案所属市": d.get("所属市", ""),
        }
        toks_all = [prov, city, pd, sd, d.get("所属市", ""), d.get("所属区县", "")]
        s["官网地址核"] = strip_tokens(s["官网地址"], toks_all)
        s["备案地址核"] = strip_tokens(s["备案地址"], toks_all)
        s["邮编一致"] = bool(s["官网邮编"] and s["备案邮编"] and s["官网邮编"] == s["备案邮编"])
        s["地址关系"] = addr_rel(s["官网地址核"], s["备案地址核"])
        s["地址相似度"] = round(addr_ratio(s["官网地址核"], s["备案地址核"]), 3)
        s["判定"], s["依据"] = build(s)
        flag_addr(s)

        # 配对修正：官网网点在备案库里另有更贴切的同名记录（限同市、且同市仅此一条）
        if s["判定"] != "同一网点":
            core_p = core_name(r["邮政官网名称"], [prov, city, pd])
            cands = []
            for rec in pool.get(prov, []):
                if core_name(rec["名称"], [prov, city, pd, rec["城市"], rec["区县"]]) != core_p:
                    continue
                # 备案「所属市」不可靠（开发区/县会被写进市），同市判定放宽到
                # 市级名相同，或该记录的市/区县与官网的市/区县有交集
                same_city = (rec["城市"] == city or rec["城市"] in (pd, sd)
                             or rec["区县"] in (pd, sd) or not rec["城市"])
                if same_city:
                    cands.append(rec)
            pick = cands[0] if len(cands) == 1 else None
            if pick and pick["链接"] and pick["链接"] != paired_link:
                old_name = s["备案名称"]
                s["配对已修正"] = f"原配《{old_name}》→ 改配《{pick['名称']}》({pick['区县']})"
                s["备案链接"] = pick["链接"]
                s["备案名称"] = pick["名称"]
                s["备案区县"] = pick["区县"]
                s["备案所属市"] = pick["城市"]
                nd = cache.get(pick["链接"])
                if nd is None:
                    repair_links[pick["链接"]] = pick["名称"]
                    nd = {}
                s["备案邮编"] = nd.get("邮政编码", "")
                s["备案地址"] = nd.get("地址", "")
                s["备案核心"] = core_name(pick["名称"], [prov, city, pd, pick["城市"], pick["区县"]])
                s["官网地址核"] = strip_tokens(s["官网地址"], toks_all)
                s["备案地址核"] = strip_tokens(s["备案地址"], toks_all)
                s["邮编一致"] = bool(s["官网邮编"] and s["备案邮编"] and s["官网邮编"] == s["备案邮编"])
                s["地址关系"] = addr_rel(s["官网地址核"], s["备案地址核"])
                s["地址相似度"] = round(addr_ratio(s["官网地址核"], s["备案地址核"]), 3)
                s["判定"], s["依据"] = build(s)
                flag_addr(s)
                repaired += 1

        out.append(s)

    keys = list(out[0].keys())
    with open(os.path.join(OUT_DIR, "_review_work.tsv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys, delimiter="\t")
        w.writeheader()
        w.writerows(out)
    with open(os.path.join(OUT_DIR, "_repair_links.json"), "w", encoding="utf-8") as fh:
        json.dump(repair_links, fh, ensure_ascii=False, indent=1)
    # 供差异清单使用的复核结论（按源 JSON 的行号索引）
    verdicts = {}
    for o in out:
        verdicts[str(o["源序号"])] = {
            "判定": o["判定"], "依据": o["依据"], "地址出入": o["地址出入"],
            "配对已修正": o["配对已修正"],
            "省": o["省"], "市": o["市"],
            "官网区县": o["官网区县"], "官网名称": o["官网名称"],
            "官网邮编": o["官网邮编"], "官网地址": o["官网地址"],
            "备案区县": o["备案区县"], "备案名称": o["备案名称"],
            "备案邮编": o["备案邮编"], "备案地址": o["备案地址"],
            "备案所属市": o.get("备案所属市", ""),
            "备案链接": o["备案链接"],
        }
    with open(os.path.join(OUT_DIR, "_review_verdicts.json"), "w", encoding="utf-8") as fh:
        json.dump(verdicts, fh, ensure_ascii=False, indent=1)

    print(f"待判行: {len(out)}")
    print("判定:", Counter(o["判定"] for o in out))
    print("依据:", Counter(o["依据"] for o in out if o["依据"]).most_common())
    print(f"配对修正: {repaired} 条（其中 {len(repair_links)} 条需补抓备案详情）")
    for o in out:
        if o["配对已修正"]:
            print(f"   [{o['省']}{o['市']}] 官网《{o['官网名称']}》 原配《{o['备案名称']}》 → {o['配对已修正']}")
    print()
    addrs = [x for x in out if x["地址出入"]]
    key = [x for x in addrs if x["地址出入"].startswith("重点")]
    print(f"判为同一网点但地址对不上: {len(addrs)} 条（其中重点 {len(key)} 条）")
    for o in key:
        print(f"   [{o['省']}{o['市']}] 《{o['官网名称']}》{o['官网区县']} {o['官网地址核']}"
              f"  ||  《{o['备案名称']}》{o['备案区县']} {o['备案地址核']}"
              f"  | {o['地址关系']} 邮编同={o['邮编一致']}")


if __name__ == "__main__":
    main()
