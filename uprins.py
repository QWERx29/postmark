
import re
import sys
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit, urljoin, unquote

import requests
from bs4 import BeautifulSoup


# ==================== 配置 ====================

SERVER_IP = "119.37.199.25"

SOURCE_DOMAIN = "s.uprins.com"
TARGET_DOMAIN = "card.uprins.com"

TIMEOUT = 15

# 「已扫描到以下内容」下一行的 5 段机戳信息
MACHINE_STAMP_MARKER = "已扫描到以下内容"
MACHINE_STAMP_FIELDS = [
    # (key, 解析结果里的名称, 原始扫描页里的旧名称)
    ("header_no", "邮资机编号", ("邮资机表头号",)),
    ("stamp_no", "邮资机表头", ("邮资戳号码",)),
    ("total_count", "当前总过戳数", ("邮资机过资总件数",)),
    ("verify_code", "验证码", ("验证码",)),
    ("promo_no", "宣传戳编号", ("宣传戳编号",)),
]

MACHINE_STAMP_LABEL_TO_KEY = {
    alias: key
    for key, _label, aliases in MACHINE_STAMP_FIELDS
    for alias in aliases
}

MACHINE_STAMP_LABEL_PATTERN = "|".join(
    re.escape(alias)
    for alias in sorted(
        (
            alias
            for _key, _label, aliases in MACHINE_STAMP_FIELDS
            for alias in aliases
        ),
        key=len,
        reverse=True,
    )
)

# 中间链接里的打印参数，例如：
# 03_XJS010_00201678_003_2026101808_0000080_400_0000198_25595460
MACHINE_STAMP_TOKEN_RE = re.compile(
    r"(?:^|[^0-9A-Za-z])"
    r"(\d{2}_[0-9A-Za-z]+_\d+_\d+_\d{10}_\d+_\d+_\d+_\d+)"
    r"(?![0-9A-Za-z_])"
)

MACHINE_STAMP_DETAIL_FIELDS = [
    ("print_date", "打印日期"),
    ("print_amount", "打印金额"),
    ("pattern_count", "当前图案过戳数"),
]


# ==================== URL 处理 ====================

def replace_host(url, new_host):
    """替换 URL 主机名，保留端口、路径、参数和片段。"""

    parts = urlsplit(url)

    if parts.port:
        netloc = f"{new_host}:{parts.port}"
    else:
        netloc = new_host

    return urlunsplit((
        parts.scheme,
        netloc,
        parts.path,
        parts.query,
        parts.fragment
    ))


def convert_url(original_url, session):
    """
    将扫描得到的 s.uprins.com 链接转换为 IP 访问链接。
    域名判断不区分大小写，不修改 Token。
    返回 (target_url, 打印参数信息或 None)。
    """

    original_url = original_url.strip()
    parts = urlsplit(original_url)

    if (parts.hostname or "").lower() != SOURCE_DOMAIN:
        raise ValueError(
            f"不支持的链接域名：{parts.hostname}"
        )

    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError("仅支持 HTTP 和 HTTPS 链接")

    # 第一步：通过 IP 访问原始入口
    ip_url = urlunsplit((
        parts.scheme.lower(),
        SERVER_IP,
        parts.path,
        parts.query,
        parts.fragment
    ))

    response = session.get(
        ip_url,
        allow_redirects=False,
        timeout=TIMEOUT
    )

    if response.status_code not in (301, 302, 303, 307, 308):
        raise RuntimeError(
            f"原始入口未返回预期跳转，"
            f"HTTP {response.status_code}"
        )

    location = response.headers.get("Location")

    if not location:
        raise RuntimeError("服务器未返回 Location 跳转地址")

    # 第二步：解析服务器返回的跳转地址
    target_url = urljoin(ip_url, location)
    target_parts = urlsplit(target_url)

    # 第三步：替换业务域名为 IP
    if (target_parts.hostname or "").lower() == TARGET_DOMAIN:
        target_url = replace_host(target_url, SERVER_IP)

    token = (
        find_machine_stamp_token(ip_url)
        or find_machine_stamp_token(location)
        or find_machine_stamp_token(target_url)
        or find_machine_stamp_token(response.text)
    )

    return target_url, token


# ==================== HTML 解析 ====================

def parse_normal_page(soup):
    """解析普通扫描结果页面。"""

    title = soup.select_one("p.title")
    links = soup.select("div.link")

    if title is None or not links:
        return None

    title_text = title.get_text(" ", strip=True)
    link_texts = []

    for link in links:
        value = link.get_text(" ", strip=True)
        if value:
            link_texts.append(value)

    return f"{title_text}\n" + "\n".join(link_texts)


def parse_stamp_page(soup):
    """解析宣传戳信息页面，忽略图片及图片相关内容。"""

    selectors = [
        "p.a_a",
        "p.a_b",
        "p.a_c"
    ]

    results = []

    for selector in selectors:
        elements = soup.select(selector)

        for element in elements:
            value = element.get_text(" ", strip=True)

            if value:
                results.append(value)

    if not results:
        return None

    return "\n".join(results)


def parse_html(html):
    """自动识别页面类型并提取文字。"""

    soup = BeautifulSoup(html, "html.parser")

    # 优先识别普通扫描结果
    result = parse_normal_page(soup)

    if result is not None:
        return result

    # 再识别宣传戳信息页面
    result = parse_stamp_page(soup)

    if result is not None:
        return result

    raise RuntimeError("未识别到支持的页面结构")


def normalize_machine_stamp_value(key, value):
    """解析结果里的数值归一化：当前总过戳数去掉前导零，其余字段保持原样。"""

    text = str(value or "").strip()

    if key == "total_count":
        text = re.sub(r"^0+(?=\d)", "", text)

    return text


def parse_labeled_machine_stamp(text):
    """
    解析「标签：值」格式的机戳信息。

    支持：
        邮资机表头号：TFJ004
        邮资戳号码：闽 AA39
        邮资机过资总件数：00000095
        验证码：24840156
        宣传戳编号：闽 2026-1-(1-1)

    「宣传戳编号」可以为空；前 4 项标签缺失或为空时返回 None。
    输出字段名统一为 MACHINE_STAMP_FIELDS 里的 label，原始扫描文字不修改。
    """

    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    values = {}
    pattern = re.compile("(" + MACHINE_STAMP_LABEL_PATTERN + r")\s*[：:]")

    # 有「已扫描到以下内容」标记时只看标记之后，避免把页面上的字段说明当成结果
    marker_index = normalized.find(MACHINE_STAMP_MARKER)
    scoped = normalized[marker_index:] if marker_index >= 0 else normalized

    for line in scoped.split("\n"):
        matches = list(pattern.finditer(line))

        for index, match in enumerate(matches):
            label = match.group(1)
            field_key = MACHINE_STAMP_LABEL_TO_KEY.get(label)
            if not field_key:
                continue

            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
            value = normalize_machine_stamp_value(
                field_key,
                line[start:end].strip().rstrip("，,；;").strip(),
            )

            # 同一字段优先保留第一个非空值
            if field_key not in values or not values[field_key]:
                values[field_key] = value

    required_keys = [
        key
        for key, _label, _aliases in MACHINE_STAMP_FIELDS[:4]
    ]

    if not all(key in values and values[key] for key in required_keys):
        return None

    return [
        {
            "key": key,
            "label": label,
            "value": values.get(key, ""),
        }
        for key, label, _aliases in MACHINE_STAMP_FIELDS
    ]


def parse_slash_machine_stamp(text):
    """
    解析斜杠分隔格式的机戳信息。

    目标格式：
        已扫描到以下内容
        TFJ003/闽 CA17/00326155/25095532/闽 2026-1-(1-1)

    第 5 段「宣传戳编号」可以为空，也可以整段省略：
        TFJ003/闽 CA17/00326155/25095532

    输出字段名统一为 MACHINE_STAMP_FIELDS 里的 label，原始扫描文字不修改。
    """

    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]

    candidates = []
    marker_index = normalized.find(MACHINE_STAMP_MARKER)

    if marker_index >= 0:
        after_marker = normalized[marker_index + len(MACHINE_STAMP_MARKER):]
        candidates.extend(after_marker.split("\n"))

    candidates.extend(lines)

    # 至少要有 3 个斜杠（4 段）；第 5 段可省略
    for line in candidates:
        target = line.strip()
        if not target or target.count("/") + target.count("／") < 3:
            continue

        # 兼容「已扫描到以下内容：TFJ...」这种标记与数据同行的写法
        candidate = target.replace(MACHINE_STAMP_MARKER, "")
        candidate = re.sub(r"^[：:]\s*", "", candidate).strip()
        candidate = candidate.replace("／", "/")

        match = re.match(
            r"^([^/]+)/([^/]+)/([^/]+)/([^/]+)(?:/(.*))?$",
            candidate,
        )

        if not match:
            continue

        values = [
            value.strip() if value is not None else ""
            for value in match.groups()
        ]

        return [
            {
                "key": key,
                "label": label,
                "value": normalize_machine_stamp_value(key, values[index] or ""),
            }
            for index, (key, label, _aliases) in enumerate(MACHINE_STAMP_FIELDS)
        ]

    return None


def parse_machine_stamp(text):
    """自动识别「标签：值」或斜杠分隔两种机戳格式。"""

    return parse_labeled_machine_stamp(text) or parse_slash_machine_stamp(text)


def parse_machine_stamp_token(token):
    """
    解析中间链接里的打印参数。

    例：
        03_XJS010_00201678_003_2026101808_0000080_400_0000198_25595460

    第 5 段 2026101808 → 打印日期 2026年10月18日08时
    第 6 段 0000080    → 打印金额 80分
    第 8 段 0000198    → 当前图案过戳数 198件
    """

    parts = str(token or "").split("_")
    if len(parts) != 9:
        return None

    date_text = parts[4]
    amount_text = parts[5]
    count_text = parts[7]

    if (
        not re.fullmatch(r"\d{10}", date_text)
        or not re.fullmatch(r"\d+", amount_text)
        or not re.fullmatch(r"\d+", count_text)
    ):
        return None

    year = int(date_text[0:4])
    month = int(date_text[4:6])
    day = int(date_text[6:8])
    hour = int(date_text[8:10])

    if year < 2000 or year > 2100 or hour > 23:
        return None

    try:
        datetime(year, month, day, hour)
    except ValueError:
        return None

    values = {
        "print_date": f"{year}年{month}月{day}日{hour:02d}时",
        "print_amount": f"{int(amount_text)}分",
        "pattern_count": f"{int(count_text)}件",
    }

    return {
        "token": str(token),
        "fields": [
            {
                "key": key,
                "label": label,
                "value": values[key],
            }
            for key, label in MACHINE_STAMP_DETAIL_FIELDS
        ],
    }


def find_machine_stamp_token(value):
    """从 URL / Location / 页面文字里找出第一组合法的打印参数。"""

    text = unquote(str(value or ""))
    text = re.sub(r"%5f", "_", text, flags=re.IGNORECASE)

    for match in MACHINE_STAMP_TOKEN_RE.finditer(text):
        parsed = parse_machine_stamp_token(match.group(1))
        if parsed:
            return parsed

    return None


# ==================== 完整处理流程 ====================

def convert_and_parse(original_url):
    """执行链接转换、页面访问和内容解析，返回 (text, 打印参数信息或 None)。"""

    session = requests.Session()

    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/156.0.0.0 Safari/537.36"
        ),
        "Accept": (
            "text/html,application/xhtml+xml,"
            "application/xml;q=0.9,*/*;q=0.8"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9"
    })

    try:
        # 转换二维码链接
        final_url, token = convert_url(original_url, session)

        # 访问业务页面
        response = session.get(
            final_url,
            timeout=TIMEOUT
        )

        response.raise_for_status()

        # 自动识别页面编码
        response.encoding = response.apparent_encoding

        # 解析 HTML
        text = parse_html(response.text)

        # 中间链接可能出现在最终 URL、跳转历史或页面内容里
        token = token or find_machine_stamp_token(response.url)

        for item in response.history:
            token = token or find_machine_stamp_token(item.url)
            token = token or find_machine_stamp_token(
                item.headers.get("Location", "")
            )

        token = token or find_machine_stamp_token(response.text)

        return text, token

    finally:
        session.close()


# ==================== 主程序 ====================

def main():

    if len(sys.argv) > 1:
        original_url = sys.argv[1]
    else:
        original_url = input("请输入扫描得到的链接：").strip()

    if not original_url:
        print("错误：链接不能为空")
        return

    try:
        result, token = convert_and_parse(original_url)
        fields = list(parse_machine_stamp(result) or [])

        if token:
            fields.extend(token["fields"])

        if fields:
            for field in fields:
                print(f"{field['label']}：{field['value']}")
        else:
            # 未识别为机戳格式时，只输出解析后的纯文本
            print(result)

    except requests.RequestException as error:
        print(f"网络请求失败：{error}")

    except Exception as error:
        print(f"解析失败：{error}")


if __name__ == "__main__":
    main()
