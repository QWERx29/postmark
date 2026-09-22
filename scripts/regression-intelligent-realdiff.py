# -*- coding: utf-8 -*-
"""智能判别对比 —— 真实数据规模下的一致性回归（Python 基准生成）
============================================================
对真实省份 CSV 做确定性扰动，造出「新版 vs 旧版」的真实差异，
再跑真实 crawler.py 的智能判别，dump 成可比对的形式。

和 regression-intelligent-compare.py 的分工：那个用手写 fixture 打各类分支；
这个拿真实网点名、真实区县名、几千条量级的数据跑，专门抓 fixture 覆盖不到的地方
（比如某列宽度在真实数据下才会露出来的补齐差异）。

用法:
    python scripts/regression-intelligent-realdiff.py
    node   scripts/regression-intelligent-realdiff.js

依赖真实项目的 base/*.csv；找不到就跳过（退出码 0），不算失败。
"""
import csv, io, json, os, random, sys

REAL = os.environ.get("REAL_CRAWLER", r"E:\Git\Code\Python\barcode_scan\post_spb_crawler")
if not os.path.isdir(os.path.join(REAL, "base")):
    sys.stderr.write(f"[跳过] 找不到真实项目的 base 目录: {os.path.join(REAL, 'base')}\n")
    sys.stderr.write("       设 REAL_CRAWLER 指向 post_spb_crawler 目录后重跑\n")
    sys.exit(0)
sys.path.insert(0, REAL)
import crawler

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp_realdiff")
os.makedirs(TMP, exist_ok=True)

SUFFIX_SWAP = {"邮政支局": "邮政所", "邮政所": "邮政支局", "邮电所": "邮电支局",
               "邮政营业厅": "邮政服务中心", "支局": "邮政所"}
STATUS = ["（暂停）", "（装修中）", "（临时停业）", "（假期暂停）", "（撤销）"]


def mutate(records, src, seed):
    """确定性扰动：造出各类变化 + 新增 + 撤下。返回新版记录。"""
    rnd = random.Random(seed)
    new = []
    n = len(records)

    for i, r in enumerate(records):
        r = dict(r)
        roll = rnd.random()

        # 撤下：整条删掉
        if roll < 0.012:
            continue

        # 名称变化：换后缀 / 插字
        if 0.012 <= roll < 0.075:
            for k, v in SUFFIX_SWAP.items():
                if r["name"].endswith(k):
                    r["name"] = r["name"][: -len(k)] + v
                    break
            else:
                r["name"] = r["name"][:-1] + "北" + r["name"][-1:] if len(r["name"]) > 3 else r["name"]

        # 营业状态变化
        if 0.075 <= roll < 0.105:
            r["name"] = r["name"] + STATUS[rnd.randrange(len(STATUS))]

        if src == "post":
            # 邮编变化
            if 0.105 <= roll < 0.135 and r["postcode"].isdigit():
                r["postcode"] = r["postcode"][:5] + str(rnd.randrange(10))
            # 地址变化
            if 0.135 <= roll < 0.185:
                r["address"] = r["address"] + "东侧"
            # 区划变化(市)
            if 0.185 <= roll < 0.195 and r["city"]:
                r["city"] = r["city"][:-1] + ("市" if not r["city"].endswith("市") else "区")
            # 区划变化(区县)
            if 0.195 <= roll < 0.205 and r["district"]:
                r["district"] = r["district"] + "二区"
        else:
            if 0.105 <= roll < 0.145:
                r["services"] = r["services"] + ",汇兑"
            if 0.145 <= roll < 0.165:
                r["detail_link"] = r["detail_link"] + "&v=2"

        new.append(r)

    # 新增：复制一批记录并改名
    for _ in range(int(n * 0.015)):
        r = dict(records[rnd.randrange(n)])
        r["name"] = r["name"] + "新点"
        if src == "post":
            r["postcode"] = str(rnd.randrange(100000, 999999))
        new.append(r)

    rnd.shuffle(new)
    return new


def write_csv(path, records, src):
    fields = ["省", "市", "区/市/县", "网点名称", "邮编", "地址"] if src == "post" else \
             ["所属省", "所属市", "所属县", "场所名称", "开办业务", "详情链接"]
    keys = ["province", "city", "district", "name", "postcode", "address"] if src == "post" else \
           ["province", "city", "district", "name", "services", "detail_link"]
    with open(path, "w", newline="", encoding="gbk", errors="replace") as f:
        w = csv.writer(f)
        w.writerow(fields)
        for r in records:
            w.writerow([r.get(k, "") for k in keys])


OUT = []
CASES = [
    ("postgd", "post", os.path.join(REAL, "base", "postgd+base.csv"), 11),
    ("spbsc", "spb", os.path.join(REAL, "base", "spbsc+base.csv"), 22),
    ("postbj", "post", os.path.join(REAL, "base", "postbj+base.csv"), 33),
    ("spbxz", "spb", os.path.join(REAL, "base", "spbxz+base.csv"), 44),
]

for prefix, src, base_path, seed in CASES:
    read = crawler.read_post_csv if src == "post" else crawler.read_spb_csv
    old = read(base_path)
    new = mutate(old, src, seed)

    f1 = os.path.join(TMP, f"{prefix}-20260917.csv")
    f2 = os.path.join(TMP, f"{prefix}+base.csv")
    write_csv(f1, new, src)
    write_csv(f2, old, src)

    r1 = read(f1)
    r2 = read(f2)
    m = crawler._match_same_source(r1, r2, src)
    changes = crawler._classify_changes(m["matched_pairs"], src)
    blocks = crawler._detect_consecutive_blocks(changes, m["unmatched1"], m["unmatched2"], r1, r2)
    lines = crawler._generate_intelligent_report(
        changes, m["unmatched1"], m["unmatched2"], r1, r2, src, os.path.basename(f1)
    )
    OUT.append({
        "prefix": prefix, "sourceType": src, "label": os.path.basename(f1),
        "file1": f1, "file2": f2,
        "newCount": len(r1), "oldCount": len(r2),
        "lines": [l for l in lines if not l.startswith("生成时间:")],
        "matchedLevels": sorted(f"{c['idx1']}:{c['idx2']}:{c['match_level']}" for c in changes),
        "categories": sorted(f"{c['idx1']}:{','.join(c['categories'])}" for c in changes),
        "unmatched1": [r["name"] for _, r in m["unmatched1"]],
        "unmatched2": [r["name"] for _, r in m["unmatched2"]],
        "nBlocks": len(blocks),
        "blockJudgments": sorted(b["judgment"] for b in blocks),
        "summary": {
            "new": len(m["unmatched1"]), "removed": len(m["unmatched2"]),
            "blocks": len(blocks),
            "comprehensive": sum(1 for c in changes
                                 if any(x.startswith("⚠") for x in c["categories"])),
        },
    })
    print(f"  {prefix:8s} {len(r1):5d}/{len(r2):5d}  变化 {len(changes):4d}  "
          f"新增 {len(m['unmatched1']):4d}  撤下 {len(m['unmatched2']):4d}  区块 {len(blocks):3d}")

with io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "_realdiff.json"), "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, ensure_ascii=False)
print("done")
