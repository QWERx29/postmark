#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
横向对比回归验证 — Python 基准侧
================================
用 crawler.py 原始的 _cross_match 跑遍 base/ 下所有省份的
(post{abbr}+base.csv, spb{abbr}+base.csv) 组合，把匹配结果导出为结构化 JSON，
供 scripts/regression-cross-match.js（JS 引擎侧）逐字段比对。

用法:
  python scripts/regression-cross-match.py [输出文件]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crawler  # noqa: E402  (需要先设置 sys.path)


def dump_match(result):
    """把 _cross_match 的返回值转成可比对的结构（只保留名称等稳定字段）。"""
    return {
        "matched_exact": [
            [p["name"], s["name"]] for p, s in result["matched_exact"]
        ],
        "matched_normalized": [
            [p["name"], s["name"]] for p, s in result["matched_normalized"]
        ],
        "matched_suspected": [
            [p["name"], s["name"], item[2], (item[3] if len(item) >= 4 else "")]
            for item in result["matched_suspected"]
            for p, s in [(item[0], item[1])]
        ],
        "matched_fuzzy": [
            [p["name"], s["name"], round(r, 6)]
            for p, s, r in result["matched_fuzzy"]
        ],
        "matched_cross_district": [
            [item[0]["name"], item[1]["name"], item[2], (item[3] if len(item) >= 4 else "")]
            for item in result["matched_cross_district"]
        ],
        "post_only": [p["name"] for p in result["post_only"]],
        "spb_only": [s["name"] for s in result["spb_only"]],
    }


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    base_dir = os.path.join(root, "base")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fuzzy = "--fuzzy" in sys.argv
    out_path = args[0] if args else os.path.join(root, "_regress_py.json")

    report = {"engine": "python", "fuzzy": fuzzy, "provinces": {}}
    checked = 0

    for name, abbr, _code in crawler.PROVINCES:
        post_file = os.path.join(base_dir, "post{}".format(abbr) + "+base.csv")
        spb_file = os.path.join(base_dir, "spb{}".format(abbr) + "+base.csv")
        if not (os.path.isfile(post_file) and os.path.isfile(spb_file)):
            continue

        post_records = crawler.read_post_csv(post_file)
        spb_records = crawler.read_spb_csv(spb_file)

        result = crawler._cross_match(post_records, spb_records, enable_fuzzy=fuzzy)
        d = dump_match(result)
        report["provinces"][abbr] = {
            "province": name,
            "post_count": len(post_records),
            "spb_count": len(spb_records),
            "result": d,
            "counts": {k: len(v) for k, v in sorted(d.items())},
        }
        checked += 1

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, sort_keys=True)

    print("Python 基准已导出: {} ({} 个省份{})".format(
        out_path, checked, ", 含模糊匹配" if fuzzy else ""))


if __name__ == "__main__":
    main()
