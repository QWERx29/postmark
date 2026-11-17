# -*- coding: utf-8 -*-
"""
把《国际退信.xlsx》中「寄出时间」为 10 位数字的条目，转换成应用「国际退信」表的导入数据。

用法:
    python scripts/build-return-import.py

输入:
    E:\\Data\\Philately\\国际退信.xlsx   （航空 / SAL / 水陆路 三张表）
输出:
    output/国际退信-导入.json             （应用「导入」按钮直接吃的数组）
    output/国际退信-导入核对.xlsx         （导入预览 + 国家名校正 + 待核对 + 说明）

口径（与 js/returnstore.js 的记录结构对齐）:
    寄出时间 2026031015  → sendDate  2026-03-10      （应用只存日期，去掉 4 位小时）
    抵达/返回/收回时间同理；非日期的标记（G/X/Z、—、疑似未送达）不写进日期，留进备注
    国家三项按 js/countries.js 校正（代码命中的一律用国家库的中英文名）
    寄出方式取工作表名（航空 / SAL / 水陆路）
    邮路信息 "上海-MU5099-北京-JL20-东京" → route.nodes / route.legs
    邮路里 * 后的编号（内网查询码）移进备注；集装箱号写进第一段运送信息
    返回方式 A/B/C 移进备注
"""
import json
import re
import sys
from datetime import datetime, date
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(r'E:\Data\Philately\国际退信.xlsx')
OUT_JSON = ROOT / 'output' / '国际退信-导入.json'
OUT_XLSX = ROOT / 'output' / '国际退信-导入核对.xlsx'
COUNTRIES_JS = ROOT / 'js' / 'countries.js'

CJK_RE = re.compile(r'[\u3400-\u9fff]')
DATE10_RE = re.compile(r'^\d{10}$')
MAIL_RE = re.compile(r'^[A-Z]{2}\d{9}[A-Z]{2}$')
OFFICE_RE = re.compile(r'^[A-Z]{6}$')

# 工作表 → 列号（0 基）。SAL 表本次没有 10 位日期的条目，列映射一并写上备查。
SHEETS = [
    ('航空', dict(
        method='航空',
        cols=dict(zh=0, en=1, code=2, post=3, send=4, arrive=5, ret=6, rec=7,
                  accept=8, export=9, note=10, mail=11, route=12, back=13),
    )),
    ('水陆路', dict(
        method='水陆路',
        cols=dict(zh=0, en=1, code=2, post=3, send=4, rec=5,
                  accept=6, export=7, addr=8, mail=9, note=10, box=11, back=12),
    )),
    ('SAL', dict(
        method='SAL',
        cols=dict(zh=0, en=1, code=2, post=3, send=4, rec=5,
                  accept=6, export=7, days=8, mail=9, note=10),
    )),
]


# ---------------------------------------------------------------- 国家库
def load_countries():
    """从 js/countries.js 的 RAW 数组里读出 [代码, 中文名, 英文名]"""
    src = COUNTRIES_JS.read_text(encoding='utf-8')
    block = src.split('const RAW = [', 1)[1].split('];', 1)[0]
    pat = re.compile(
        r'\[\s*[\'"]([A-Z]{2})[\'"]\s*,\s*'
        r'(?:\'((?:[^\'\\]|\\.)*)\'|"((?:[^"\\]|\\.)*)")\s*,\s*'
        r'(?:\'((?:[^\'\\]|\\.)*)\'|"((?:[^"\\]|\\.)*)")\s*\]'
    )
    out = {}
    for m in pat.finditer(block):
        code = m.group(1)
        zh = m.group(2) if m.group(2) is not None else m.group(3)
        en = m.group(4) if m.group(4) is not None else m.group(5)
        out[code] = (zh, en)
    return out


# ---------------------------------------------------------------- 取值 / 转换
def cell(row, idx):
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v).strip()


def digit_str(v):
    """10 位（或 8~12 位）数字串；不是数字返回 None"""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, int):
        s = str(v)
    elif isinstance(v, float):
        if v != int(v):
            return None
        s = str(int(v))
    else:
        s = str(v).strip()
    return s if re.fullmatch(r'\d{8,12}', s) else None


def to_date(v, label, adjust):
    """
    转 YYYY-MM-DD。
    返回 (日期或 '', 非日期标记或 '')；adjust 收集需要说明的调整。
    """
    if v is None:
        return '', ''
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d'), ''
    s = text(v)
    if s in ('', '—', '-', '/'):
        return '', ''
    d = digit_str(v)
    if d:
        ymd = d[:8]
        try:
            y, m, dd = int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8])
            date(y, m, dd)
        except ValueError:
            return '', s
        if len(d) == 10:
            adjust.append((label, s, f'{y:04d}-{m:02d}-{dd:02d}', '去掉 4 位小时'))
        elif len(d) > 10:
            adjust.append((label, s, f'{y:04d}-{m:02d}-{dd:02d}', '只取前 8 位作日期'))
        return f'{y:04d}-{m:02d}-{dd:02d}', ''
    return '', s  # 非日期标记（G / X / Z / 疑似未送达 …）


# ---------------------------------------------------------------- 邮路
def parse_route(raw):
    """
    "上海-MU5099-北京-JL20-东京-巴黎(罗斯)-安道尔*S123*A456"
      → nodes [上海, 北京, 东京, 巴黎(罗斯), 安道尔]
        legs  [MU5099, JL20, '', '']
        codes [S123, A456]
    规则：以 - 与 * 切分；带星号的词是编号（内网查询码）；
          含汉字的词是途经点；其余（航班 / 车次 / 集装箱）填到上一段运送信息里。
    """
    parts = re.split(r'([-*])', raw)
    nodes, legs, codes = [], [], []
    pending = ''
    sep = ''
    for piece in parts:
        if piece in ('-', '*'):
            sep = piece
            continue
        tok = piece.strip()
        if not tok:
            sep = ''
            continue
        starred = sep == '*'
        sep = ''
        # 航班号偶尔写成 (CA1531)
        if tok.startswith('(') and tok.endswith(')'):
            tok = tok[1:-1].strip()
        if not tok:
            continue
        if CJK_RE.search(tok):
            if nodes:
                legs.append(pending)
            pending = ''
            nodes.append(tok)
        else:
            if starred or not nodes or pending:
                codes.append(tok)
            else:
                pending = tok
    return nodes, legs, codes


def is_route_text(s):
    """水陆路的「备注/邮路信息」一列混着放，只有像邮路（带 - 且无空格）的才当邮路"""
    return bool(s) and '-' in s and not re.search(r'\s', s)


# ---------------------------------------------------------------- 主流程
def build():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    canon = load_countries()

    records = []
    country_fix = []      # 国家名按国家库校正
    issues = []           # 待核对
    adj_counts = {}       # 调整类型计数

    def bump(k, n=1):
        adj_counts[k] = adj_counts.get(k, 0) + n

    for sheet_name, cfg in SHEETS:
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        cols = cfg['cols']
        for rn, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            send_raw = cell(row, cols.get('send'))
            send_digits = digit_str(send_raw)
            # 只收「寄出时间为 10 位数字」的条目
            if not send_digits or len(send_digits) != 10:
                continue

            adjust = []
            send_date, send_mark = to_date(send_raw, '寄出时间', adjust)
            if not send_date:
                # 10 位数字但不是合法日期，说明源数据有问题，跳过并记录
                issues.append(dict(sheet=sheet_name, row=rn, country=text(cell(row, cols['zh'])),
                                   mail=text(cell(row, cols['mail'])), kind='寄出时间不是合法日期',
                                   detail=text(send_raw)))
                continue

            # ---- 国家三项
            code = text(cell(row, cols['code'])).upper()
            zh = text(cell(row, cols['zh']))
            en = text(cell(row, cols['en']))
            if code in canon:
                czh, cen = canon[code]
                if zh != czh or en != cen:
                    country_fix.append(dict(sheet=sheet_name, row=rn, code=code,
                                            old_zh=zh, new_zh=czh, old_en=en, new_en=cen))
                    bump('国家名按国家库校正')
                zh, en = czh, cen
            else:
                issues.append(dict(sheet=sheet_name, row=rn, country=zh, mail=text(cell(row, cols['mail'])),
                                   kind='国家代码不在国家库', detail=f'{code} / {en}（保留原写法）'))

            # ---- 邮件号码
            mail_raw = text(cell(row, cols['mail']))
            mail_extra = []
            if '/' in mail_raw:
                parts = [p.strip() for p in mail_raw.split('/') if p.strip()]
                mail_raw = parts[0]
                mail_extra = parts[1:]
                bump('一格多个邮件号码，取第一个')
            mail_no = re.sub(r'\s+', '', mail_raw).upper()
            if mail_no in ('—', '-', ''):
                mail_no = ''
            if mail_no and not MAIL_RE.match(mail_no):
                issues.append(dict(sheet=sheet_name, row=rn, country=zh, mail=mail_no,
                                   kind='邮件号码不合 13 位规则', detail=mail_no))

            # ---- 互换局
            office = {}
            for key in ('accept', 'export'):
                v = re.sub(r'\s+', '', text(cell(row, cols.get(key)))).upper()
                if v in ('—', '-', '**', '*'):
                    if v == '**':
                        bump('互换局占位符 ** 置空')
                    v = ''
                elif v and not OFFICE_RE.match(v):
                    issues.append(dict(sheet=sheet_name, row=rn, country=zh, mail=mail_no,
                                       kind='互换局不是六位字母', detail=f'{key}={v}（已置空）'))
                    bump('互换局非法值置空')
                    v = ''
                office[key] = v

            # ---- 其余三个时间
            marks = []
            dates = {}
            for key, label, col in (('arriveDate', '寄达时间', 'arrive'),
                                    ('returnDate', '返回时间', 'ret'),
                                    ('recoverDate', '收回时间', 'rec')):
                d, mark = to_date(cell(row, cols.get(col)), label, adjust)
                dates[key] = d
                if mark:
                    marks.append(f'{label}标记：{mark}')
            for label, old, new, why in adjust:
                bump(f'{label}{why}')

            # ---- 邮路
            route_raw = text(cell(row, cols.get('route')))
            note_raw = text(cell(row, cols.get('note')))
            if sheet_name == '水陆路':
                # 这一列是「备注/邮路信息」合体
                route_text, note_text = (note_raw, '') if is_route_text(note_raw) else ('', note_raw)
            else:
                route_text, note_text = route_raw, note_raw

            nodes, legs, codes = ([], [], [])
            if route_text and route_text not in ('—', '-'):
                nodes, legs, codes = parse_route(route_text)
                if len(nodes) < 2:
                    issues.append(dict(sheet=sheet_name, row=rn, country=zh, mail=mail_no,
                                       kind='邮路解析不出途经点', detail=route_text))
                    note_text = '\n'.join(x for x in [note_text, f'邮路：{route_text}'] if x)
                    nodes, legs, codes = [], [], []
                if codes:
                    bump('邮路 * 后的内网查询码移入备注')
            if note_text in ('—', '-'):
                note_text = ''

            # 集装箱号：算邮路详情，写进第一段运送信息
            box = text(cell(row, cols.get('box')))
            if box and box not in ('—', '-') and len(nodes) >= 2:
                tag = f'集装箱 {box}'
                legs[0] = f'{legs[0]} {tag}'.strip() if legs[0] else tag
                bump('集装箱号写进邮路第一段')

            # ---- 备注拼装
            back = text(cell(row, cols.get('back')))
            if back in ('—', '-'):
                back = ''
            lines = []
            if note_text:
                lines.append(note_text)
            if back:
                lines.append(f'返回方式：{back}')
                bump('返回方式移入备注')
            if codes:
                lines.append('内网查询码：' + '；'.join(codes))
            if mail_extra:
                lines.append('另一邮件号码：' + '；'.join(mail_extra))
                bump('另一邮件号码移入备注')
            if marks:
                lines.extend(marks)
                bump('非日期标记移入备注')
            notes = '\n'.join(lines)

            # ---- 组装
            slug = 'air' if sheet_name == '航空' else ('sea' if sheet_name == '水陆路' else 'sal')
            records.append({
                'id': f'ret-{slug}-{rn}',
                'countryZh': zh,
                'countryEn': en,
                'countryCode': code,
                'sendMethod': cfg['method'],
                'mailNo': mail_no,
                'sendDate': send_date,
                'arriveDate': dates['arriveDate'],
                'returnDate': dates['returnDate'],
                'recoverDate': dates['recoverDate'],
                'acceptOffice': office['accept'],
                'exportOffice': office['export'],
                'route': {'nodes': nodes, 'legs': legs},
                'notes': notes,
                'createdAt': NOW,
                'updatedAt': NOW,
                '_src': f'{sheet_name}!{rn}',
            })

    # ---- 数据自检（只报告，不改数据）
    mail_seen = {}
    for r in records:
        if r['mailNo']:
            mail_seen.setdefault(r['mailNo'], []).append(r)
    for no, rs in mail_seen.items():
        if len(rs) > 1:
            issues.append(dict(sheet=' / '.join(x['_src'].split('!')[0] for x in rs),
                               row=' / '.join(x['_src'].split('!')[1] for x in rs),
                               country=' / '.join(x['countryZh'] for x in rs), mail=no,
                               kind='邮件号码重复', detail='两条记录用了同一个号码，请核对'))

    timeline = [('sendDate', '寄出时间'), ('arriveDate', '寄达时间'),
                ('returnDate', '返回时间'), ('recoverDate', '收回时间')]
    for r in records:
        filled = [(k, l, r[k]) for k, l in timeline if r[k]]
        for i in range(1, len(filled)):
            if filled[i][2] < filled[i - 1][2]:
                issues.append(dict(sheet=r['_src'].split('!')[0], row=r['_src'].split('!')[1],
                                   country=r['countryZh'], mail=r['mailNo'],
                                   kind='时间先后倒挂',
                                   detail=f"{filled[i-1][1]} {filled[i-1][2]} → {filled[i][1]} {filled[i][2]}"))
    for r in records:
        if not r['route']['nodes']:
            adj_counts['邮路为空（原表未填，未导入邮路）'] = adj_counts.get('邮路为空（原表未填，未导入邮路）', 0) + 1

    return records, country_fix, issues, adj_counts


NOW = datetime.now().astimezone().replace(microsecond=0).isoformat()


def write_json(records):
    payload = [{k: v for k, v in r.items() if not k.startswith('_')} for r in records]
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return payload


def write_review(records, country_fix, issues, adj_counts):
    wb = openpyxl.Workbook()
    head_font = Font(bold=True, color='FFFFFF')
    head_fill = PatternFill('solid', fgColor='4A6FA5')
    wrap = Alignment(wrap_text=True, vertical='top')

    def style_sheet(ws, widths, freeze='A2'):
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        for c in ws[1]:
            c.font = head_font
            c.fill = head_fill
            c.alignment = Alignment(horizontal='center', vertical='center')
        ws.freeze_panes = freeze
        ws.auto_filter.ref = ws.dimensions

    # 1. 导入预览
    ws = wb.active
    ws.title = '导入预览'
    ws.append(['序号', '中文国名/地区名', '英文国名/地区名', '代码', '寄出方式', '邮件号码',
               '寄出时间', '寄达时间', '返回时间', '收回时间', '境外接收互换局', '境外出口互换局',
               '邮路信息', '备注', '来源'])
    for i, r in enumerate(records, start=1):
        route = ''
        for j, n in enumerate(r['route']['nodes']):
            if j:
                leg = r['route']['legs'][j - 1] if j - 1 < len(r['route']['legs']) else ''
                route += (f' →({leg}) ' if leg else ' → ')
            route += n
        ws.append([i, r['countryZh'], r['countryEn'], r['countryCode'], r['sendMethod'], r['mailNo'],
                   r['sendDate'], r['arriveDate'], r['returnDate'], r['recoverDate'],
                   r['acceptOffice'], r['exportOffice'], route, r['notes'], r['_src']])
    for row in ws.iter_rows(min_row=2):
        row[13].alignment = wrap
    style_sheet(ws, [6, 16, 26, 6, 9, 16, 11, 11, 11, 11, 12, 12, 52, 42, 12])

    # 2. 国家名校正
    ws = wb.create_sheet('国家名校正')
    ws.append(['来源', '代码', '原中文名', '新中文名', '原英文名', '新英文名'])
    for f in country_fix:
        ws.append([f"{f['sheet']}!{f['row']}", f['code'], f['old_zh'], f['new_zh'], f['old_en'], f['new_en']])
    style_sheet(ws, [12, 6, 20, 20, 40, 32])

    # 3. 待核对
    ws = wb.create_sheet('待核对')
    ws.append(['序号', '来源', '国家（地区）', '邮件号码', '问题', '说明'])
    for i, it in enumerate(issues, start=1):
        ws.append([i, f"{it['sheet']}!{it['row']}", it['country'], it['mail'], it['kind'], it['detail']])
    for row in ws.iter_rows(min_row=2):
        row[5].alignment = wrap
    style_sheet(ws, [6, 12, 20, 16, 22, 56])

    # 4. 调整说明
    ws = wb.create_sheet('调整说明')
    ws.append(['调整项', '条数'])
    for k, v in sorted(adj_counts.items(), key=lambda kv: -kv[1]):
        ws.append([k, v])
    ws.append([])
    ws.append(['说明', ''])
    notes = [
        '只导入「寄出时间」为 10 位数字的条目；航空 169 条 + 水陆路 33 条 = 202 条。',
        '10 位数字形如 2026031015（年月日 + 小时），应用只存日期，统一取前 8 位写成 2026-03-10。',
        '国家三项按 js/countries.js 校正：英文名去空格、香港/澳门/台湾加「中国」前缀等；国家库里没有的代码（AQ/AX/BL/SJ/XZ）保留原写法。',
        '邮路「上海-MU5099-北京-JL20-东京」拆成途经点与运送信息；* 后的编号（内网查询码）移入备注。',
        '集装箱号写进邮路第一段运送信息；返回方式移入备注；寄达地址、盲读邮资按你的要求不导入。',
        '日期栏里的非日期标记（G / X / Z / — / 疑似未送达）不写进日期，留进备注。',
        '时间先后倒挂的记录按原样导入，不擅自改年份，已在「待核对」列出。',
    ]
    for n in notes:
        ws.append([n])
    style_sheet(ws, [100, 8], freeze='A2')
    for row in ws.iter_rows(min_row=2):
        row[0].alignment = wrap

    wb.save(OUT_XLSX)


def main():
    if not SRC.exists():
        print(f'找不到源文件: {SRC}')
        return 1
    records, country_fix, issues, adj_counts = build()
    payload = write_json(records)
    write_review(records, country_fix, issues, adj_counts)

    print(f'导入记录: {len(payload)} 条')
    for k, v in sorted(adj_counts.items(), key=lambda kv: -kv[1]):
        print(f'  {k}: {v}')
    print(f'国家名校正: {len(country_fix)} 条')
    print(f'待核对: {len(issues)} 条')
    for it in issues:
        print(f"  - {it['sheet']}!{it['row']} {it['country']} {it['mail']} | {it['kind']} | {it['detail']}")
    print(f'写出: {OUT_JSON}')
    print(f'写出: {OUT_XLSX}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
