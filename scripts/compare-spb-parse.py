#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPB 页面解析对照 — Python(BeautifulSoup) 侧
==========================================
抓取若干邮管局备案页面，用 crawler.py 原始的 parse_spb_page (bs4) 解析，
导出 JSON 供 scripts/compare-spb-parse.js 与 JS 正则解析版逐行比对。

用法:
  python scripts/compare-spb-parse.py <输出JSON> [省份代码...]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crawler  # noqa: E402

# 抽样省份：直辖市 + 普通省 + 自治区，覆盖不同的表格内容形态
DEFAULT_CODES = ["110000", "310000", "440000", "650000"]
PAGES_PER_PROVINCE = 3


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "_spb_py.json"
    codes = sys.argv[2:] or DEFAULT_CODES

    session = crawler.create_session()
    out = {"engine": "python", "pages": {}}

    for code in codes:
        for page in range(1, PAGES_PER_PROVINCE + 1):
            url = crawler.SPB_URL_TEMPLATE.format(code, page)
            # 直接取原始 HTML，供 JS 侧复用同一份字节
            resp = session.get(url, headers=crawler.SPB_HEADERS, timeout=(15, 45))
            resp.raise_for_status()
            resp.encoding = resp.apparent_encoding
            html = resp.text

            rows = crawler.parse_spb_page(html, url)
            out["pages"]["{}-{}".format(code, page)] = {
                "url": url,
                "html_file": "spb_{}_{}.html".format(code, page),
                "rows": rows,
            }
            # 同一份 HTML 落盘，JS 侧读它，确保两边输入完全一致
            with open("spb_{}_{}.html".format(code, page), "w", encoding="utf-8") as f:
                f.write(html)

            print("  {} 第{}页: {} 行".format(code, page, len(rows)))

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
    print("Python 基准已导出: {}".format(out_path))

    session.close()


if __name__ == "__main__":
    main()
