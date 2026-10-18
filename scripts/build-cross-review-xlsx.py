# -*- coding: utf-8 -*-
"""
生成人工复核表（带自动判定结果）。

数据来源：
  · output/_review_work.tsv        —— classify-cross-review.py 算出的信号与判定
  · output/cross_diff_rows_*.json  —— 官网侧原始字段
  · output/spb_details_*.json      —— 备案侧详情（地址、邮编）

用法: python scripts/build-cross-review-xlsx.py [YYYYMMDD]
产出: output/人工复核表_<YYYYMMDD>.xlsx
"""

import csv
import json
import os
import sys
from collections import Counter

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "output")

HEADERS = ["序号", "省", "市", "官网区县", "官网名称", "官网邮编", "官网地址",
           "备案区县", "备案名称", "备案邮编", "备案地址",
           "判定", "判定依据", "备注"]

COL_WIDTH = {"序号": 6, "省": 12, "市": 13, "官网区县": 15, "官网名称": 26,
             "官网邮编": 10, "官网地址": 34, "备案区县": 16, "备案名称": 28,
             "备案邮编": 10, "备案地址": 30, "判定": 11, "判定依据": 30, "备注": 30}

HEAD_FILL = PatternFill("solid", fgColor="1F4E79")
HEAD_FONT = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
BODY_FONT = Font(name="微软雅黑", size=10)
OK_FILL = PatternFill("solid", fgColor="C6EFCE")
NO_FILL = PatternFill("solid", fgColor="FFC7CE")
MAYBE_FILL = PatternFill("solid", fgColor="FFEB9C")
THIN = Side(style="thin", color="D9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

SHEETS = [("疑似匹配（区县不同）", "suspected"), ("跨区县差异（子串）", "cross_district")]
ORDER = {"存疑": 0, "不同网点": 1, "同一网点": 2}


def main():
    date = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else "20260929"
    with open(os.path.join(OUT_DIR, "_review_work.tsv"), encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t"))
    cache = json.load(open(os.path.join(OUT_DIR, f"spb_details_{date}.json"), encoding="utf-8"))

    wb = Workbook()
    wb.remove(wb.active)
    progress = []

    for sheet_name, kind in SHEETS:
        data = [r for r in rows if r["类型"] == kind]
        data.sort(key=lambda r: (ORDER.get(r["判定"], 9), r["省"], r["市"], r["官网区县"]))
        ws = wb.create_sheet(sheet_name)

        ws.append(HEADERS)
        for c in range(1, len(HEADERS) + 1):
            cell = ws.cell(row=1, column=c)
            cell.fill = HEAD_FILL
            cell.font = HEAD_FONT
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = BORDER
        ws.row_dimensions[1].height = 28

        for i, r in enumerate(data, start=1):
            note = r.get("配对已修正") or ""
            if r.get("地址出入"):
                note = (note + "；" if note else "") + r["地址出入"]
            ws.append([
                i, r["省"], r["市"],
                r["官网区县"], r["官网名称"], r["官网邮编"], r["官网地址"],
                r["备案区县"], r["备案名称"], r["备案邮编"], r["备案地址"],
                r["判定"], r["依据"], note,
            ])
            for c in range(1, len(HEADERS) + 1):
                cell = ws.cell(row=ws.max_row, column=c)
                cell.font = BODY_FONT
                cell.border = BORDER
                cell.alignment = Alignment(vertical="top", wrap_text=(c in (7, 11, 13, 14)))
            ws.cell(row=ws.max_row, column=1).alignment = Alignment(horizontal="center", vertical="top")
            ws.cell(row=ws.max_row, column=12).alignment = Alignment(horizontal="center", vertical="top")

        for idx, name in enumerate(HEADERS, start=1):
            ws.column_dimensions[get_column_letter(idx)].width = COL_WIDTH[name]

        col = get_column_letter(HEADERS.index("判定") + 1)
        last = ws.max_row
        dv = DataValidation(type="list", formula1='"同一网点,不同网点,存疑"', allow_blank=True,
                            showDropDown=False)
        dv.prompt = "选择：同一网点 / 不同网点 / 存疑"
        ws.add_data_validation(dv)
        dv.add(f"{col}2:{col}{last}")
        rng = f"{col}2:{col}{last}"
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"同一网点"'], fill=OK_FILL))
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"不同网点"'], fill=NO_FILL))
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"存疑"'], fill=MAYBE_FILL))

        ws.freeze_panes = "B2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{last}"
        progress.append((sheet_name, col, last, len(data)))

        cnt = Counter(r["判定"] for r in data)
        print(f"  {sheet_name}: {len(data)} 行 | 同一 {cnt['同一网点']} / 不同 {cnt['不同网点']} / 存疑 {cnt['存疑']}")

    # ── 汇总 ──
    ws = wb.create_sheet("汇总")
    ws.append(["两组差异的人工判读结果"])
    ws["A1"].font = Font(name="微软雅黑", size=13, bold=True)
    ws.append([])
    ws.append(["复核项", "合计", "同一网点", "不同网点", "存疑"])
    for c in range(1, 6):
        cell = ws.cell(row=3, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER

    for sheet_name, col, last, total in progress:
        rng = f"'{sheet_name}'!${col}$2:${col}${last}"
        ws.append([sheet_name, total,
                   f'=COUNTIF({rng},"同一网点")', f'=COUNTIF({rng},"不同网点")',
                   f'=COUNTIF({rng},"存疑")'])
        for c in range(1, 6):
            cell = ws.cell(row=ws.max_row, column=c)
            cell.font = BODY_FONT
            cell.border = BORDER
            if c > 1:
                cell.alignment = Alignment(horizontal="center")

    ws.append(["合计", f"=SUM(B4:B{ws.max_row})", f"=SUM(C4:C{ws.max_row})",
               f"=SUM(D4:D{ws.max_row})", f"=SUM(E4:E{ws.max_row})"])
    for c in range(1, 6):
        cell = ws.cell(row=ws.max_row, column=c)
        cell.font = Font(name="微软雅黑", size=10, bold=True)
        cell.border = BORDER
        if c > 1:
            cell.alignment = Alignment(horizontal="center")

    repaired = [r for r in rows if r.get("配对已修正")]
    ws.append([])
    ws.append([f"其中配对已修正：{len(repaired)} 条（备案库里另有对应网点，已换成正确配对）"])
    ws.cell(row=ws.max_row, column=1).font = BODY_FONT

    # ── 地址出入的情况（判为同一网点但两边地址对不上） ──
    conflict = [r for r in rows if r.get("地址出入")]
    key_rows = [r for r in conflict if r["地址出入"].startswith("重点")]
    ws.append([])
    ws.append([f"判为「同一网点」但两边地址对不上的：{len(conflict)} 条"])
    ws.cell(row=ws.max_row, column=1).font = Font(name="微软雅黑", size=11, bold=True)
    ws.append([f"　其中重点 {len(key_rows)} 条 —— 名称一致、仅地址指向不同地点（已按确认口径计为「同一网点」，建议回头核对地址）："])
    ws.cell(row=ws.max_row, column=1).font = BODY_FONT
    head = ws.max_row + 1
    ws.append(["省", "市", "官网名称", "备案名称"])
    for c in range(1, 5):
        cell = ws.cell(row=head, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER
    for r in sorted(key_rows, key=lambda x: (x["省"], x["市"])):
        ws.append([r["省"], r["市"], r["官网名称"], r["备案名称"]])
        for c in range(1, 5):
            cell = ws.cell(row=ws.max_row, column=c)
            cell.font = BODY_FONT
            cell.border = BORDER
    ws.append([f"　其余 {len(conflict) - len(key_rows)} 条属地址表述/详略不同（多为开发区、管理区的粗地址），"
               f"逐条见「地址不一致明细」表"])
    ws.cell(row=ws.max_row, column=1).font = BODY_FONT

    ws.column_dimensions["A"].width = 30
    for c in "BCDE":
        ws.column_dimensions[c].width = 14
    ws.column_dimensions["D"].width = 30

    # ── 地址不一致明细 ──
    ws3 = wb.create_sheet("地址不一致明细")
    H3 = ["省", "市", "官网名称", "官网地址", "备案名称", "备案地址", "说明"]
    ws3.append(H3)
    for c in range(1, len(H3) + 1):
        cell = ws3.cell(row=1, column=c)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    for r in sorted(conflict, key=lambda x: (not x["地址出入"].startswith("重点"), x["省"], x["市"])):
        ws3.append([r["省"], r["市"], r["官网名称"], r["官网地址"],
                    r["备案名称"], r["备案地址"], r["地址出入"]])
        for c in range(1, len(H3) + 1):
            cell = ws3.cell(row=ws3.max_row, column=c)
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    for idx, w in enumerate([13, 14, 28, 40, 30, 40, 26], start=1):
        ws3.column_dimensions[get_column_letter(idx)].width = w
    ws3.freeze_panes = "A2"
    ws3.auto_filter.ref = f"A1:G{ws3.max_row}"

    out_path = os.path.join(OUT_DIR, f"人工复核表_{date}.xlsx")
    wb.save(out_path)
    print(f"配对修正 {len(repaired)} 条 | 地址对不上 {len(conflict)} 条（重点 {len(key_rows)}）")
    print(f"已生成: {out_path}")


if __name__ == "__main__":
    main()
