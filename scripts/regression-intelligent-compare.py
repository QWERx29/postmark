# -*- coding: utf-8 -*-
"""
智能判别对比 —— Python 基准生成器
==================================
用**真实生产脚本** post_spb_crawler/crawler.py 的智能判别子系统，对一组内联
fixture 跑出结构化结果 + 报告文本，dump 成 _regress_intelligent.json，
供 scripts/regression-intelligent-compare.js 逐字段比对。

真实脚本不在仓库里（postmark 的 crawler.py 是 2026-06-21 的旧拷贝，没有这套
智能判别代码），所以走环境变量指定路径：

    set REAL_CRAWLER=E:\\Git\\Code\\Python\\barcode_scan\\post_spb_crawler
    python scripts/regression-intelligent-compare.py

与 regression-cross-match.py 同一模式。注意：基准会随真实 crawler.py 变化而
过期，报差异前先重跑本脚本（见 memory: regression-baseline-staleness）。
"""

import io
import json
import os
import sys
from datetime import datetime

REAL = os.environ.get("REAL_CRAWLER", r"E:\Git\Code\Python\barcode_scan\post_spb_crawler")
if not os.path.isdir(REAL):
    sys.stderr.write(f"[错误] 找不到真实 crawler.py 所在目录: {REAL}\n")
    sys.stderr.write("       请用环境变量 REAL_CRAWLER 指定 post_spb_crawler 目录\n")
    sys.exit(2)
sys.path.insert(0, REAL)

import crawler  # noqa: E402

OUT_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_regress_intelligent.json")


def post(province, city, district, name, postcode, address):
    return {
        "province": province, "city": city, "district": district,
        "name": name, "postcode": postcode, "address": address,
    }


def spb(province, city, district, name, services, detail_link):
    return {
        "province": province, "city": city, "district": district,
        "name": name, "services": services, "detail_link": detail_link,
    }


TJ = "天津市"

# ============================================================
# 用例 1: POST —— 覆盖全部变化类别
# ============================================================
# 旧版
POST_OLD = [
    # [0] 完全一致（与新版 [0] 逐字段相同）
    post(TJ, TJ, "和平区", "和平路邮政支局", "300020", "和平路1号"),
    # [1] 仅营业状态变化（核心名相同，新版多了「（暂停）」）
    post(TJ, TJ, "和平区", "师范学院邮政所", "300021", "卫津路2号"),
    # [2] 疑似匹配 + 名称变化（同名同区县、改名）
    post(TJ, TJ, "南开区", "南开大学邮政所", "300071", "南开区3号"),
    # [3] 邮编变化（名称/区县/地址都不变）
    post(TJ, TJ, "河西区", "友谊路邮政支局", "300201", "友谊路4号"),
    # [4] 地址变化
    post(TJ, TJ, "河东区", "大直沽邮电所", "300170", "大直沽5号"),
    # [5] 区划变化(市) —— 名称与区县都不变，靠阶1精确匹配
    post(TJ, TJ, "河北区", "中山路邮政所", "300140", "中山路6号"),
    # [6] 区划变化(区县) —— 区县变了，阶1失效，靠阶2公共字串匹配上
    post(TJ, TJ, "红桥区", "西站邮政所", "300130", "西站7号"),
    # [7] 综合变化（>=3 字段）：名称+邮编+地址+市
    post(TJ, TJ, "滨海新区", "塘沽邮政支局", "300450", "塘沽8号"),
    # [8] 阶3 邮编精确匹配的旧记录（名称无>=2字公共中文字串）
    post(TJ, TJ, "东丽区", "么六桥邮电所", "300300", "么六桥9号"),
    # [9] 疑似撤下
    post(TJ, TJ, "津南区", "双港邮政所", "300350", "双港10号"),
    # [10] 疑似撤下（与 [9] 行号相邻，用于连续区块）
    post(TJ, TJ, "津南区", "咸水沽邮政所", "300350", "咸水沽11号"),
]

# 新版
POST_NEW = [
    post(TJ, TJ, "和平区", "和平路邮政支局", "300020", "和平路1号"),               # [0] 一致
    post(TJ, TJ, "和平区", "师范学院邮政所（暂停）", "300021", "卫津路2号"),       # [1] 营业状态变化
    post(TJ, TJ, "南开区", "南开大学邮政支局", "300071", "南开区3号"),             # [2] 名称变化（疑似）
    post(TJ, TJ, "河西区", "友谊路邮政支局", "300202", "友谊路4号"),               # [3] 邮编变化
    post(TJ, TJ, "河东区", "大直沽邮电所", "300170", "大直沽5号旁"),               # [4] 地址变化
    post("北京市", "北京市", "河北区", "中山路邮政所", "300140", "中山路6号"),     # [5] 区划变化(市)
    post(TJ, TJ, "北辰区", "西站邮政所", "300130", "西站7号"),                     # [6] 区划变化(区县)
    post("北京市", "北京市", "滨海新区", "塘沽邮政所（装修中）", "300451", "塘沽8号新"),  # [7] 综合变化
    post(TJ, TJ, "东丽区", "幺六桥邮电所", "300300", "么六桥9号"),                 # [8] 邮编匹配
    post(TJ, TJ, "津南区", "双港邮政支局", "300350", "双港10号"),                  # [9] 疑似更名（区块内）
    post(TJ, TJ, "津南区", "咸水沽邮政所", "300350", "咸水沽11号"),                # [10] 一致
]

# ============================================================
# 用例 2: SPB —— 开办业务变化 / 详情链接变化
# ============================================================
LINK = "https://zwfw.spb.gov.cn/sj/tj/pfyycsml"
SPB_OLD = [
    spb(TJ, TJ, "和平区", "和平路邮政支局", "信件,包裹", LINK + "?id=1"),
    spb(TJ, TJ, "南开区", "南开大学邮政所", "信件", LINK + "?id=2"),
    spb(TJ, TJ, "河西区", "友谊路邮政支局", "信件,汇兑", LINK + "?id=3"),
]
SPB_NEW = [
    spb(TJ, TJ, "和平区", "和平路邮政支局", "信件,包裹,汇兑", LINK + "?id=1"),
    spb(TJ, TJ, "南开区", "南开大学邮政所", "信件", LINK + "?id=2&v=2"),
    spb(TJ, TJ, "河西区", "友谊路邮政支局", "信件,汇兑", LINK + "?id=3"),
]

# ============================================================
# 用例 3: 空 / 单边
# ============================================================
EDGE_CASES = [
    ("空对空", "postk", [], []),
    ("旧版为空", "postk", POST_NEW[:3], []),
    ("新版为空", "postk", [], POST_OLD[:3]),
]

FIXTURES = [
    {"name": "POST 全类别", "sourceType": "post", "label": "posttj-20260917.csv",
     "records1": POST_NEW, "records2": POST_OLD},
    {"name": "SPB 全类别", "sourceType": "spb", "label": "spbtj-20260917.csv",
     "records1": SPB_NEW, "records2": SPB_OLD},
]
for name, label, r1, r2 in EDGE_CASES:
    FIXTURES.append({"name": name, "sourceType": "post", "label": label,
                     "records1": r1, "records2": r2})


def norm_blocks(blocks):
    """区块内 district 在 Python 里是 set 迭代序（进程间不稳定），统一排序后再比"""
    out = []
    for b in blocks:
        out.append({
            "startLine": b["start_line"],
            "endLine": b["end_line"],
            "district": ", ".join(sorted(d for d in b["district"].split(", ") if d)),
            "judgment": b["judgment"],
            "onlyIn1": [r["name"] for _, r in b["only_in_1"]],
            "onlyIn2": [r["name"] for _, r in b["only_in_2"]],
            "fuzzy": [[r1["name"], r2["name"], c] for r1, r2, c in b["fuzzy_matches_in_block"]],
            "changesInBlock": [
                {"rec2": c["rec2"]["name"], "rec1": c["rec1"]["name"],
                 "categories": c["categories"]}
                for c in b["changes_in_block"]
            ],
        })
    return out


def norm_changes(changes):
    out = []
    for c in changes:
        out.append({
            "idx1": c["idx1"], "idx2": c["idx2"],
            "matchLevel": c["match_level"],
            "rec1": c["rec1"], "rec2": c["rec2"],
            "categories": c["categories"],
            "details": c["details"],
        })
    return out


def run_fixture(fx):
    r1, r2, st = fx["records1"], fx["records2"], fx["sourceType"]

    if not r1 and not r2:
        return {
            "empty": True,
            # 与 crawler.intelligent_compare 对「两份都空」的短路返回一致
            "lines": [f"=== 智能判别分析: {fx['label']} ===",
                      "两份文件均为空，无法对比。"],
            "changes": [], "unmatched1": [], "unmatched2": [], "blocks": [],
            "summary": {"byCategory": {}, "new": 0, "removed": 0, "blocks": 0,
                        "comprehensive": 0},
        }

    m = crawler._match_same_source(r1, r2, st)
    changes = crawler._classify_changes(m["matched_pairs"], st)
    blocks = crawler._detect_consecutive_blocks(changes, m["unmatched1"], m["unmatched2"], r1, r2)
    now = datetime.now()
    lines = crawler._generate_intelligent_report(
        changes, m["unmatched1"], m["unmatched2"], r1, r2, st, fx["label"]
    )

    by_cat = {}
    for c in changes:
        for cat in c["categories"]:
            if not cat.startswith("⚠"):
                by_cat[cat] = by_cat.get(cat, 0) + 1

    return {
        "empty": False,
        "nowStr": now.strftime("%Y-%m-%d %H:%M:%S"),
        "lines": lines,
        "changes": norm_changes(changes),
        "unmatched1": [r["name"] for _, r in m["unmatched1"]],
        "unmatched2": [r["name"] for _, r in m["unmatched2"]],
        "blocks": norm_blocks(blocks),
        "summary": {
            "byCategory": by_cat,
            "new": len(m["unmatched1"]),
            "removed": len(m["unmatched2"]),
            "blocks": len(blocks),
            "comprehensive": sum(
                1 for c in changes if any(x.startswith("⚠") for x in c["categories"])
            ),
        },
    }


def main():
    data = {
        "source": os.path.join(REAL, "crawler.py"),
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "fixtures": [],
    }
    for fx in FIXTURES:
        got = run_fixture(fx)
        data["fixtures"].append({
            "name": fx["name"], "sourceType": fx["sourceType"], "label": fx["label"],
            "records1": fx["records1"], "records2": fx["records2"],
            "expected": got,
        })
        print(f"  {fx['name']}: 变化 {len(got['changes'])} | "
              f"新增 {got['summary']['new']} | 撤下 {got['summary']['removed']} | "
              f"区块 {got['summary']['blocks']}")

    with io.open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"\n基准已写入: {OUT_JSON}")


if __name__ == "__main__":
    main()
