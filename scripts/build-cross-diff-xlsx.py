# -*- coding: utf-8 -*-
"""
把 scripts/export-cross-diff-rows.js 产出的差异行 JSON 渲染成 Excel 表格。

表头（按需固定）: 省 | 市 | 邮政官网区（市、县）| 邮政官网名称 | 邮管局区（市、县）| 邮管局名称 | 差异原因

「归一化匹配（仅名称写法差异、非跨区县）」不列入明细，只在「差异统计」页给出总数。

用法: python scripts/build-cross-diff-xlsx.py [YYYYMMDD]
产出: output/横向对比差异清单_<YYYYMMDD>.xlsx
"""

import collections
import json
import os
import re
import sys
from collections import Counter

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "output")

HEADERS = ["省", "市", "邮政官网区（市、县）", "邮政官网名称",
           "邮管局区（市、县）", "邮管局名称", "差异原因"]

# 同一区县内的展示顺序：先“一方缺失”（最需要处理），再跨区县，再疑似，最后纯名称写法差异
TYPE_ORDER = {
    "post_only": 0,
    "spb_only": 1,
    "cross_district": 2,
    "suspected": 3,
    "normalized": 4,
}

COL_WIDTH = {"省": 13, "市": 15, "邮政官网区（市、县）": 19, "邮政官网名称": 32,
             "邮管局区（市、县）": 19, "邮管局名称": 32, "差异原因": 34}

HEAD_FILL = PatternFill("solid", fgColor="1F4E79")
HEAD_FONT = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
BODY_FONT = Font(name="微软雅黑", size=10)
MISSING_FONT = Font(name="微软雅黑", size=10, color="9C0006")
MISSING_FILL = PatternFill("solid", fgColor="FFF2CC")
THIN = Side(style="thin", color="D9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def main():
    date = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    src = os.path.join(OUT_DIR, f"cross_diff_rows_{date or 'latest'}.json")
    if not os.path.exists(src):
        raise SystemExit(f"找不到差异行数据: {src}\n请先运行: node scripts/export-cross-diff-rows.js {date or ''}")

    with open(src, encoding="utf-8") as fh:
        data = json.load(fh)
    all_rows = data["rows"]
    total_stats = Counter(r["差异类型"] for r in all_rows)

    # 人工复核结论（键为源 JSON 行号）
    verdict_path = os.path.join(OUT_DIR, "_review_verdicts.json")
    verdicts = json.load(open(verdict_path, encoding="utf-8")) if os.path.exists(verdict_path) else {}
    if not verdicts:
        print("[提示] 没有找到 _review_verdicts.json，跨区县/疑似匹配两组将按原样列出")

    def post_side(v):
        return {"省": v["省"], "市": v["市"], "差异类型": "post_only",
                "邮政官网区县": v["官网区县"], "邮政官网名称": v["官网名称"],
                "邮编": v["官网邮编"], "地址": v["官网地址"],
                "邮管局区县": "", "邮管局名称": "", "备案链接": "",
                "差异原因": "邮管局备案中无此网点"}

    def spb_side(v):
        # 误配拆出来的备案侧，市要按备案记录自己的来（可能和官网那个网点不同市）
        city_s = (v.get("备案所属市") or "").strip()
        if not (city_s and re.search(r"(市|州|盟|地区)$", city_s)):
            city_s = v["市"]
        return {"省": v["省"], "市": city_s, "差异类型": "spb_only",
                "邮政官网区县": "", "邮政官网名称": "", "邮编": "", "地址": "",
                "邮管局区县": v["备案区县"], "邮管局名称": v["备案名称"],
                "备案链接": v["备案链接"], "差异原因": "邮政官网中无此网点"}

    # 归一化匹配（非跨区县）只是同一网点的名称写法差异，不列入明细，只给总数；
    # 跨区县里「名称归一化后一致、仅登记区县不同」的同样处理；
    # 「疑似匹配」里双方所属区县相同的也隐藏；
    # 其余两组按人工复核结论：复核为同一网点的移出明细，误配的拆成两条单边缺失。
    rows = []
    removed_same = 0
    split_pairs = 0
    for idx, r in enumerate(all_rows):
        if r["差异类型"] == "normalized":
            continue
        if r["差异类型"] == "cross_district" and r.get("匹配方式") == "归一化":
            continue
        if r["差异类型"] == "suspected" and r.get("区县是否相同"):
            continue
        if r["差异类型"] in ("cross_district", "suspected"):
            v = verdicts.get(str(idx))
            if v is None:
                rows.append(r)
                continue
            if v["判定"] == "同一网点":
                removed_same += 1
                continue
            rows.append(post_side(v))
            rows.append(spb_side(v))
            split_pairs += 1
            continue
        rows.append(r)

    dropped = {
        "normalized": total_stats.get("normalized", 0),
        "cross_normalized": sum(1 for r in all_rows
                                if r["差异类型"] == "cross_district" and r.get("匹配方式") == "归一化"),
        "suspected_same": sum(1 for r in all_rows
                              if r["差异类型"] == "suspected" and r.get("区县是否相同")),
        "same_by_review": removed_same,
    }
    post_only_count = sum(1 for r in rows if r["差异类型"] == "post_only")
    spb_only_count = sum(1 for r in rows if r["差异类型"] == "spb_only")

    # 个别省份（如东莞）官网把多个镇的网点都简写成同名、区县又只填市名，
    # 个别省份（如东莞）官网把多个镇的网点都简写成同名、区县又只填市名，
    # 合并到同一行后靠地址区分（见 cell_text）。
    dup_key = collections.Counter()
    detail_cache = {}
    cache_path = os.path.join(OUT_DIR, f"spb_details_{date or data['date']}.json")
    if os.path.exists(cache_path):
        detail_cache = json.load(open(cache_path, encoding="utf-8"))

    # 省按报告顺序（JSON 已保持 PROVINCES 顺序），省内按 市 → 区县 → 差异类型 排序
    prov_order = {}
    for i, r in enumerate(all_rows):
        prov_order.setdefault(r["省"], i)

    def sort_key(r):
        district = r["邮政官网区县"] or r["邮管局区县"] or ""
        return (prov_order[r["省"]], r["市"], district, TYPE_ORDER.get(r["差异类型"], 9))

    rows.sort(key=sort_key)

    # ── 按区县分组：同一个区县的缺失项上下对齐 ──
    def group_key(city, dist):
        """东莞/中山这类不设区的市，官网区县填市名、备案填「东莞县」，视作同一个区县"""
        if dist and re.sub(r"[市县]$", "", dist) == re.sub(r"[市县]$", "", city or ""):
            return "CITY"
        return dist

    groups = {}
    order = []
    for r in rows:
        dist = r["邮政官网区县"] or r["邮管局区县"] or ""
        key = (r["省"], r["市"], group_key(r["市"], dist))
        if key not in groups:
            groups[key] = {"post": [], "spb": []}
            order.append(key)
        g = groups[key]
        if r["邮政官网名称"]:
            g["post"].append((r["邮政官网名称"], (r.get("地址") or "").strip(),
                              r["邮政官网区县"]))
        if r["邮管局名称"]:
            spb_addr = ((detail_cache.get(r.get("备案链接") or "", {}) or {}).get("地址") or "").strip()
            g["spb"].append((r["邮管局名称"], spb_addr, r["邮管局区县"]))

    def label(item, dup):
        name, addr, _ = item
        return f"{name}（{addr}）" if name in dup and addr else name

    # 同区县的官网缺失项与备案缺失项上下对齐，一行一个官网网点 + 一个备案网点；
    # 某一边多出来的，单独占行、另一边填 (无)。
    merged = []
    for key in order:
        prov, city, _ = key
        g = groups[key]
        post, spb = g["post"], g["spb"]
        names_p = [n for n, _, _ in post]
        names_s = [n for n, _, _ in spb]
        dup_p = {n for n in names_p if names_p.count(n) > 1}
        dup_s = {n for n in names_s if names_s.count(n) > 1}
        for i in range(max(len(post), len(spb))):
            p = post[i] if i < len(post) else None
            s = spb[i] if i < len(spb) else None
            reasons = []
            if p:
                reasons.append("邮管局备案中无此网点")
            if s:
                reasons.append("邮政官网中无此网点")
            merged.append({
                "省": prov, "市": city,
                "邮政官网区县": p[2] if p else "(无)",
                "邮政官网名称": label(p, dup_p) if p else "(无)",
                "邮管局区县": s[2] if s else "(无)",
                "邮管局名称": label(s, dup_s) if s else "(无)",
                "差异原因": "；".join(reasons),
                "条数": (1 if p else 0) + (1 if s else 0),
            })
    raw_count = sum(len(g["post"]) + len(g["spb"]) for g in groups.values())
    rows = merged

    wb = Workbook()
    ws = wb.active
    ws.title = "差异清单"

    ws.append(HEADERS)
    for c in range(1, len(HEADERS) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[1].height = 30

    for r in rows:
        ws.append([
            r["省"],
            r["市"],
            r["邮政官网区县"] or "(无)",
            r["邮政官网名称"] or "(无)",
            r["邮管局区县"] or "(无)",
            r["邮管局名称"] or "(无)",
            r["差异原因"],
        ])
        row_idx = ws.max_row
        # 两边都缺（既有官网未备案、又有备案未收录）的区县标黄，便于优先处理
        both = r["邮政官网名称"] != "(无)" and r["邮管局名称"] != "(无)"
        for c in range(1, len(HEADERS) + 1):
            cell = ws.cell(row=row_idx, column=c)
            cell.font = MISSING_FONT if both else BODY_FONT
            cell.border = BORDER
            cell.alignment = Alignment(
                vertical="top",
                wrap_text=(c in (3, 4, 5, 6, 7)),
                horizontal="left",
            )
            if both:
                cell.fill = MISSING_FILL

    for idx, name in enumerate(HEADERS, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = COL_WIDTH[name]

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{ws.max_row}"

    # ── 统计页：各差异类型的总数（含未列入明细的归一化匹配） ──
    ws2 = wb.create_sheet("差异统计")
    ws2.append(["横向对比差异统计"])
    ws2["A1"].font = Font(name="微软雅黑", size=13, bold=True)
    if data.get("skipped", {}).get("paused"):
        ws2.append([f"注：官网名称带“（暂停）”标注且归一化匹配的 {data['skipped']['paused']} 条已另行剔除，不计入下表。"])
    ws2.append([])
    ws2.append(["差异类型", "行数", "是否列入明细"])
    head_row = ws2.max_row
    for c in range(1, 4):
        cell = ws2.cell(row=head_row, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER

    stat_rows = [
        ("归一化匹配（仅名称写法差异、非跨区县）", dropped["normalized"], "未列入明细，仅此总数"),
        ("跨区县差异（名称归一化后一致）", dropped["cross_normalized"], "未列入明细，仅此总数"),
        ("疑似匹配（双方所属区县相同）", dropped["suspected_same"], "未列入明细，仅此总数"),
        ("跨区县差异/疑似匹配 经人工复核为同一网点（仅区县登记不同）",
         dropped["same_by_review"], "未列入明细，仅此总数"),
        ("邮管局备案中无此网点", post_only_count, "计入明细（项）"),
        ("邮政官网中无此网点", spb_only_count, "计入明细（项）"),
        ("差异项合计", post_only_count + spb_only_count, ""),
        ("按区县对齐后的行数", len(rows), "明细表实际行数"),
    ]
    for label, n, incl in stat_rows:
        ws2.append([label, n, incl])
        for c in range(1, 4):
            cell = ws2.cell(row=ws2.max_row, column=c)
            cell.font = BODY_FONT
            cell.border = BORDER
            if c == 2:
                cell.alignment = Alignment(horizontal="right")

    ws2.append(["复核前差异行合计", len(all_rows), ""])
    for c in range(1, 4):
        ws2.cell(row=ws2.max_row, column=c).font = Font(name="微软雅黑", size=10, bold=True)
        ws2.cell(row=ws2.max_row, column=c).border = BORDER
    ws2.cell(row=ws2.max_row, column=2).alignment = Alignment(horizontal="right")

    if split_pairs:
        ws2.append([])
        ws2.append([f"注：经复核确认两边实为不同网点的 {split_pairs} 条配对错误，已拆成"
                    f"「邮管局备案中无此网点」+「邮政官网中无此网点」各一条，"
                    f"故明细比复核前多 {split_pairs} 行。"])
        ws2.cell(row=ws2.max_row, column=1).font = BODY_FONT
    ws2.append([f"说明：明细按「省 + 市 + 区县」分组，同区县的官网缺失网点与备案缺失网点上下对齐，"
                f"一行只列一个官网网点和一个备案网点（多出的一边单独占行、另一边填「(无)」）；"
                f"{raw_count} 条差异项共 {len(rows)} 行。同名网点（如东莞的「中心邮政所」）附地址区分。"])
    ws2.cell(row=ws2.max_row, column=1).font = BODY_FONT

    ws2.column_dimensions["A"].width = 42
    ws2.column_dimensions["B"].width = 10
    ws2.column_dimensions["C"].width = 22

    out_path = os.path.join(OUT_DIR, f"横向对比差异清单_{date or data['date']}.xlsx")
    wb.save(out_path)

    print(f"数据源: {src}")
    print(f"差异项: {raw_count} 条 → 按区县合并后 {len(rows)} 行")
    print(f"（未列入明细: 归一化 {dropped['normalized']} + 跨区县归一化 {dropped['cross_normalized']}"
          f" + 区县相同的疑似匹配 {dropped['suspected_same']}"
          f" + 复核为同一网点 {dropped['same_by_review']}）")
    print(f"误配拆分: {split_pairs} 对 → {split_pairs * 2} 行")
    print(f"合并行中两边都缺的: {sum(1 for r in rows if r['邮政官网名称'] != '(无)' and r['邮管局名称'] != '(无)')}")
    print(f"已生成: {out_path}")


if __name__ == "__main__":
    main()
