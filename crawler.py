#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全国邮政网点信息爬取程序
========================
数据来源:
  1. 中国邮政官网 (iframe.chinapost.com.cn)  — 邮政营业网点
  2. 国家邮政局政务服务 (zwfw.spb.gov.cn)     — 普遍服务营业场所备案

覆盖范围: 31个省级行政区（不含港澳台）
输出格式: post{缩写}-{日期}.csv / spb{缩写}-{日期}.csv (GBK编码)

用法:
  python crawler.py                    # 爬取全部31个省
  python crawler.py --source post      # 仅爬取邮政官网
  python crawler.py --source spb       # 仅爬取邮管局
  python crawler.py --province 上海     # 仅爬取指定省份（可多次使用）
  python crawler.py --province 上海 北京 广东
  python crawler.py --delay 2.0        # 自定义请求间隔（秒）
  python crawler.py --help             # 查看帮助
"""

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from datetime import datetime
import csv
import os
import sys
import time
import argparse
import subprocess
import shutil
import re
import difflib

# ==================== Windows 控制台编码处理 ====================
if sys.platform == "win32":
    # 尝试设置控制台为 UTF-8 模式，避免 GBK 编码错误
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ===================== 31个省级行政区配置 =====================
# 格式: (中文名, 缩写, 行政区划代码六位)
PROVINCES = [
    ("北京",   "bj", "110000"),
    ("天津",   "tj", "120000"),
    ("河北",   "he", "130000"),
    ("山西",   "sx", "140000"),
    ("内蒙古", "nm", "150000"),
    ("辽宁",   "ln", "210000"),
    ("吉林",   "jl", "220000"),
    ("黑龙江", "hl", "230000"),
    ("上海",   "sh", "310000"),
    ("江苏",   "js", "320000"),
    ("浙江",   "zj", "330000"),
    ("安徽",   "ah", "340000"),
    ("福建",   "fj", "350000"),
    ("江西",   "jx", "360000"),
    ("山东",   "sd", "370000"),
    ("河南",   "ha", "410000"),
    ("湖北",   "hb", "420000"),
    ("湖南",   "hn", "430000"),
    ("广东",   "gd", "440000"),
    ("广西",   "gx", "450000"),
    ("海南",   "hi", "460000"),
    ("重庆",   "cq", "500000"),
    ("四川",   "sc", "510000"),
    ("贵州",   "gz", "520000"),
    ("云南",   "yn", "530000"),
    ("西藏",   "xz", "540000"),
    ("陕西",   "sn", "610000"),
    ("甘肃",   "gs", "620000"),
    ("青海",   "qh", "630000"),
    ("宁夏",   "nx", "640000"),
    ("新疆",   "xj", "650000"),
]

# ===================== 常量 =====================
OUTPUT_DIR = "output"
BASE_DIR = "base"
COMPARE_EXE = "txt_compare.exe"

# 横向对比用：网点名称归一化时需要剥离的后缀（长后缀优先匹配）
_NAME_SUFFIXES = [
    "（假期暂停）", "(假期暂停)",
    "（暂停）", "(暂停)",
    "（装修中）", "(装修中)",
    "（临时停业）", "(临时停业)",
    "邮政营业厅",
    "邮政服务中心",
    "邮政代办所",
    "邮政支局",
    "邮政所",
    "邮政营业",
    "邮政",
    "支局",       # 无"邮政"前缀的裸"支局"（如"东贸路支局"）
]
# 匹配括号注释的正则（全角/半角括号）
_ANNOTATION_RE = re.compile(r'[（(][^）)]*[）)]')

# 通用请求头（不含 Referer，适用于邮政 API）
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 邮管局专用请求头（含 Referer）
SPB_HEADERS = {
    **HEADERS,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://zwfw.spb.gov.cn/",
}

# 邮政官网 API
POST_API_URL = "https://iframe.chinapost.com.cn/api/institutionalsite/findlist.do"
POST_IFRAME_URL = "https://iframe.chinapost.com.cn/jsp/type/institutionalsite/SiteSearchJTApi.jsp"

# 邮管局备案页面
SPB_URL_TEMPLATE = "https://zwfw.spb.gov.cn/sj/{}/pfyycsml?currentPage={}"
SPB_ROOT = "https://zwfw.spb.gov.cn"

VERIFY_SSL = True


# ===================== HTTP 会话工厂 =====================

def create_session():
    """创建带有重试机制的 requests Session"""
    session = requests.Session()
    retries = Retry(
        total=5,
        backoff_factor=2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    adapter = HTTPAdapter(
        max_retries=retries, pool_connections=10, pool_maxsize=10
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


# ==================== 工具函数 ====================

def safe_print(*args, **kwargs):
    """带 flush 的打印，确保控制台实时输出"""
    print(*args, **kwargs)
    sys.stdout.flush()


# ==================== 横向对比辅助函数 ====================

def normalize_name(name):
    """剥离括号注释和已知类型后缀，返回核心名称用于归一化匹配"""
    normalized = name.strip()
    # 去除括号内的注释（全角/半角）
    normalized = _ANNOTATION_RE.sub("", normalized).strip()
    # 去除尾部已知后缀（长后缀优先）
    for suffix in _NAME_SUFFIXES:
        if normalized.endswith(suffix) and len(normalized) > len(suffix):
            normalized = normalized[:-len(suffix)].strip()
            break
    return normalized.rstrip("，, ")


def _enhanced_normalize_spb(name, city="", district="", province=""):
    """SPB 名称增强归一化：生成多个候选归一化形式用于匹配。

    返回 set，包含以下策略产生的归一化结果：
      1. 标准归一化
      2. 剥离"中国邮政集团有限公司"+省/地市/区县/分公司前缀 后归一化
      3. 剥离地市前缀 后归一化
      4. 剥离区县前缀 后归一化
      5. 剥离"{地市}邮政局"前缀 后归一化
      6. 剥离"{区县}邮政局"前缀 后归一化
      7. 剥离"中国邮政集团公司"+地市/区县前缀 后归一化
    """
    results = set()
    name = name.strip()

    # 策略1: 标准归一化（始终包含）
    std = normalize_name(name)
    if std:
        results.add(std)

    # 策略2: 剥离"中国邮政集团有限公司"及其后续层级前缀
    COMPANY_PREFIX = "中国邮政集团有限公司"
    if name.startswith(COMPANY_PREFIX):
        working = name[len(COMPANY_PREFIX):]
        # 尝试剥离多种后续前缀组合（均尝试，产生不同的候选）
        candidates = []

        # 2a: 剥离 "{省名}分公司" 模式（如"广东省分公司"、"上海市分公司"）
        if province:
            # 尝试多种省/市分公司变体
            for branch_suffix in ("分公司", "省分公司"):
                branch_prefix = f"{province}{branch_suffix}"
                if working.startswith(branch_prefix):
                    candidates.append(working[len(branch_prefix):])
                    break  # 匹配到最长的一个即可
            # 2b: 剥离省名后继续尝试剥离地市/区县名
            if working.startswith(province):
                after_province = working[len(province):]
                # 再尝试剥离地市、区县
                for loc in (city, district):
                    if loc and after_province.startswith(loc):
                        after_province = after_province[len(loc):]
                if len(after_province) >= 2:
                    candidates.append(after_province)

        # 2c: 剥离地市名
        for loc in (city, district):
            if loc and working.startswith(loc):
                after_loc = working[len(loc):]
                # 继续剥离下一级
                for loc2 in (district, city):
                    if loc2 and loc2 != loc and after_loc.startswith(loc2):
                        after_loc = after_loc[len(loc2):]
                        break
                if len(after_loc) >= 2:
                    candidates.append(after_loc)

        # 如果上述都没有命中，直接使用 working 作为候选
        if not candidates and len(working) >= 2:
            candidates.append(working)

        for c in candidates:
            norm = normalize_name(c)
            if norm:
                results.add(norm)

    # 策略3: 剥离开头的地市名
    if city and name.startswith(city):
        candidate = name[len(city):]
        if len(candidate) >= 2:
            norm = normalize_name(candidate)
            if norm:
                results.add(norm)

    # 策略4: 剥离开头的区县名
    if district and name.startswith(district):
        candidate = name[len(district):]
        if len(candidate) >= 2:
            norm = normalize_name(candidate)
            if norm:
                results.add(norm)

    # 策略5: 剥离"{地市}邮政局"前缀（如"沈阳市邮政局马官桥邮政支局"）
    POSTAL_BUREAU_SUFFIX = "邮政局"
    if city:
        bureau_prefix = f"{city}{POSTAL_BUREAU_SUFFIX}"
        if name.startswith(bureau_prefix):
            candidate = name[len(bureau_prefix):]
            if len(candidate) >= 2:
                norm = normalize_name(candidate)
                if norm:
                    results.add(norm)

    # 策略6: 剥离"{区县}邮政局"前缀（如"康平县邮政局四家子邮政支局"）
    if district:
        bureau_prefix = f"{district}{POSTAL_BUREAU_SUFFIX}"
        if name.startswith(bureau_prefix):
            candidate = name[len(bureau_prefix):]
            if len(candidate) >= 2:
                norm = normalize_name(candidate)
                if norm:
                    results.add(norm)

    # 策略7: 剥离"中国邮政集团公司"及其后续地市/区县前缀
    #         （如"中国邮政集团公司沈阳市东贸路支局"）
    GROUP_PREFIX = "中国邮政集团公司"
    if name.startswith(GROUP_PREFIX):
        working = name[len(GROUP_PREFIX):]
        candidates = []
        # 7a: 剥离紧随的地市名/区县名
        for loc in (city, district):
            if loc and working.startswith(loc):
                after_loc = working[len(loc):]
                # 尝试继续剥离下一级
                for loc2 in (district, city):
                    if loc2 and loc2 != loc and after_loc.startswith(loc2):
                        after_loc = after_loc[len(loc2):]
                        break
                if len(after_loc) >= 2:
                    candidates.append(after_loc)
        # 7b: 如果都没命中，直接保留
        if not candidates and len(working) >= 2:
            candidates.append(working)
        for c in candidates:
            norm = normalize_name(c)
            if norm:
                results.add(norm)

    return results


def _find_longest_common_substring(s1, s2):
    """返回两个字符串的最长公共子串（DP算法）"""
    if not s1 or not s2:
        return ""
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    max_len, end_pos = 0, 0
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if s1[i - 1] == s2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
                if dp[i][j] > max_len:
                    max_len = dp[i][j]
                    end_pos = i
    return s1[end_pos - max_len:end_pos]


def _find_common_cn_substring(name1, name2):
    """剥离后缀后，提取两个名称的公共中文字符子串（>=2个汉字）。
       返回公共子串，长度不足2则返回空字符串。"""
    core1 = normalize_name(name1)
    core2 = normalize_name(name2)
    # 仅保留中文字符用于比较
    cn1 = "".join(c for c in core1 if "一" <= c <= "鿿")
    cn2 = "".join(c for c in core2 if "一" <= c <= "鿿")
    if len(cn1) < 2 or len(cn2) < 2:
        return ""
    lcs = _find_longest_common_substring(cn1, cn2)
    return lcs if len(lcs) >= 2 else ""


def _is_special_zone(district):
    """判断区县名称是否包含特殊园区关键字（新区/新城/开发区/示范区/聚集区/管理区等）"""
    if not district:
        return False
    # "新城区"是正规行政区划名（如呼和浩特/西安/南宁），非特殊园区，排除
    if district == "新城区" or district.endswith("市新城区"):
        return False
    keywords = ["新区", "新城", "开发区", "示范区", "聚集区", "管理区"]
    return any(kw in district for kw in keywords)


def read_post_csv(filepath):
    """读取 POST CSV 文件（GBK 编码），返回记录列表。
       每条记录: {province, city, district, name, postcode, address}"""
    records = []
    try:
        with open(filepath, "r", encoding="gbk", errors="replace") as f:
            for i, row in enumerate(csv.reader(f)):
                if i == 0:  # 跳过表头
                    continue
                if len(row) >= 6:
                    records.append({
                        "province": row[0].strip(),
                        "city": row[1].strip(),
                        "district": row[2].strip(),
                        "name": row[3].strip(),
                        "postcode": row[4].strip(),
                        "address": row[5].strip(),
                    })
    except Exception as e:
        safe_print(f"    [错误] 读取 POST 文件失败: {filepath} - {e}")
        return []
    return records


def read_spb_csv(filepath):
    """读取 SPB CSV 文件（GBK 编码），返回记录列表。
       每条记录: {province, city, district, name, services, detail_link}"""
    records = []
    try:
        with open(filepath, "r", encoding="gbk", errors="replace") as f:
            for i, row in enumerate(csv.reader(f)):
                if i == 0:  # 跳过表头
                    continue
                if len(row) >= 6:
                    records.append({
                        "province": row[0].strip(),
                        "city": row[1].strip(),
                        "district": row[2].strip(),
                        "name": row[3].strip(),
                        "services": row[4].strip(),
                        "detail_link": row[5].strip(),
                    })
    except Exception as e:
        safe_print(f"    [错误] 读取 SPB 文件失败: {filepath} - {e}")
        return []
    return records


def find_latest_file(data_dir, prefix):
    """在 data_dir 中查找以 prefix 开头的最新 CSV 文件。返回完整路径或 None。"""
    if not os.path.isdir(data_dir):
        return None
    candidates = []
    for f in os.listdir(data_dir):
        if f.startswith(prefix) and f.endswith(".csv"):
            # 日期部分: prefix-YYYYMMDD.csv，长度 prefix+1+8+4
            date_part = f[len(prefix) + 1:-4]
            try:
                dt = datetime.strptime(date_part, "%Y%m%d")
                candidates.append((dt, os.path.join(data_dir, f)))
            except ValueError:
                continue
    return max(candidates, key=lambda x: x[0])[1] if candidates else None


# ==================== 中国邮政官网爬取 ====================

def fetch_post_page(session, page, province_name, size=100):
    """调用邮政官网 JSON API 获取一页数据"""
    params = {
        "act": "list",
        "page": page,
        "size": size,
        "community": "ChinaPostJT",
        "province": province_name,
    }
    resp = session.post(POST_API_URL, data=params, headers=HEADERS, timeout=30)
    resp.encoding = "utf-8"
    return resp.json()


def parse_post_page(data, province_name=""):
    """解析邮政官网 JSON 响应，提取有效字段（省/市/区/网点名称/邮编/地址）"""
    records = data.get("list", [])
    result = []
    # 直辖市（城市名 = 省名 + "市"）
    DIRECT_MUNICIPALITIES = {"北京", "天津", "上海", "重庆"}

    for item in records:
        postcode = (item.get("zipcode") or "").strip()
        # 仅保留6位数字邮编
        if not postcode.isdigit() or len(postcode) != 6:
            continue

        name = (item.get("sitename") or "").strip()
        suffix = (item.get("sitenameSuffix") or "").strip()
        if suffix:
            name += suffix

        county = (item.get("county") or "").strip()
        address = (item.get("address") or "").strip()

        # 1. 省：优先从 JSON 提取，否则使用传入的省份名
        province = (
            (item.get("province") or "").strip() or
            (item.get("provinceName") or "").strip() or
            (item.get("PROVINCE") or "").strip()
        )
        if not province and province_name:
            province = province_name

        # 2. 市：优先从 JSON 提取，否则从地址/county 中推断
        city = (
            (item.get("city") or "").strip() or
            (item.get("cityName") or "").strip() or
            (item.get("CITY") or "").strip()
        )
        if not city:
            if province_name in DIRECT_MUNICIPALITIES:
                # 直辖市：城市名 = 省名 + "市"
                city = province_name + "市"
            elif county and county.endswith("市"):
                # county 字段本身就是市名（如 "东莞市"）
                city = county
            elif address:
                # 从地址中提取城市名：找到第一个 "市"，向前回溯到省/区边界
                pos = address.find("市")
                if pos >= 0:
                    start = pos - 1
                    while start >= 0:
                        ch = address[start]
                        if ch in ("省", "区") or not ("一" <= ch <= "鿿"):
                            start += 1  # 边界字符之后开始
                            break
                        start -= 1
                    else:
                        # 没有找到边界，取"市"前最多4个汉字
                        start = max(0, pos - 4)
                    city = address[start:pos + 1]

        result.append({
            "省":       province,
            "市":       city,
            "区/市/县": county,
            "网点名称": name,
            "邮编":     postcode,
            "地址":     address,
        })
    return result


def crawl_post_province(session, province_name):
    """爬取指定省份邮政官网所有网点数据"""
    # 先访问 iframe 页面获取 cookies
    try:
        session.get(
            POST_IFRAME_URL,
            params={"community": "ChinaPostJT", "prov": province_name},
            headers=HEADERS,
            timeout=30,
        )
    except Exception as e:
        safe_print(f"    [警告] 获取cookies失败: {e}")

    all_data = []
    page = 1
    total = None

    while True:
        try:
            data = fetch_post_page(session, page, province_name)
        except Exception as e:
            safe_print(f"    [错误] 第{page}页请求失败: {e}")
            break

        if not data.get("success"):
            break

        page_data = parse_post_page(data, province_name)
        if not page_data:
            break

        all_data.extend(page_data)

        if total is None:
            total = data.get("total", 0)
            safe_print(f"    邮政官网: 共 {total} 条记录")
            if total == 0:
                break

        # 判断是否已抓完
        if page * 100 >= total:
            break

        page += 1

    return all_data


# ==================== 邮管局备案爬取 ====================

def safe_get(session, url, max_attempts=3):
    """带异常处理和退避重试的 GET 请求"""
    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = session.get(
                url, headers=SPB_HEADERS, timeout=(15, 45), verify=VERIFY_SSL
            )
            resp.raise_for_status()
            resp.encoding = resp.apparent_encoding
            return resp.text
        except requests.exceptions.RequestException as e:
            last_error = e
            safe_print(f"    [重试 {attempt}/{max_attempts}] {e}")
            if attempt < max_attempts:
                time.sleep(2 ** attempt)
        except Exception as e:
            last_error = e
            safe_print(f"    [未知错误] {e}")
            if attempt < max_attempts:
                time.sleep(2)
    safe_print(f"    [放弃] 多次重试后仍失败: {url}")
    return None


def parse_spb_page(html, page_url):
    """解析邮管局备案公示页面，提取表格数据"""
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("table tr")
    if not rows:
        safe_print(f"    [警告] 未找到表格数据: {page_url}")
        return []

    page_data = []
    for tr in rows[1:]:          # 跳过表头
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue

        # 前五列通常包含 <a> 标签
        a_tags = [td.find("a") for td in tds[:5]]
        if any(a is None for a in a_tags):
            continue

        province   = a_tags[0].get_text(strip=True)
        city       = a_tags[1].get_text(strip=True)
        district   = a_tags[2].get_text(strip=True)
        place_name = a_tags[3].get_text(strip=True)
        services   = a_tags[4].get_text(strip=True)
        detail_link = urljoin(SPB_ROOT, a_tags[0].get("href", ""))

        page_data.append([
            province, city, district, place_name, services, detail_link
        ])

    return page_data


def crawl_spb_province(session, area_code):
    """爬取指定省份邮管局备案所有页面数据"""
    all_data = []
    page = 1
    consecutive_empty = 0
    max_empty = 3          # 连续空页数达到此值则停止

    while True:
        url = SPB_URL_TEMPLATE.format(area_code, page)
        safe_print(f"    邮管局: 正在抓取第{page}页...", end=" ")

        html = safe_get(session, url)
        if not html:
            consecutive_empty += 1
            safe_print("")
            if consecutive_empty >= max_empty:
                safe_print(f"    邮管局: 连续{max_empty}页失败，停止抓取")
                break
            page += 1
            continue

        page_data = parse_spb_page(html, url)
        if not page_data:
            safe_print("无数据")
            consecutive_empty += 1
            if consecutive_empty >= max_empty:
                safe_print(f"    邮管局: 连续{max_empty}页无数据，停止抓取")
                break
        else:
            safe_print(f"获取 {len(page_data)} 条")
            all_data.extend(page_data)
            consecutive_empty = 0

        page += 1
        time.sleep(0.3)          # 礼貌性延迟

    safe_print(f"    邮管局: 共获取 {len(all_data)} 条记录")
    return all_data


# ==================== 文件保存 ====================

def save_post_csv(data, abbr, date_str, output_dir):
    """保存邮政官网数据为 CSV (GBK 编码, 不可编码字符用?替换)"""
    os.makedirs(output_dir, exist_ok=True)
    filename = f"post{abbr}-{date_str}.csv"
    filepath = os.path.join(output_dir, filename)

    with open(filepath, "w", newline="", encoding="gbk", errors="replace") as f:
        writer = csv.DictWriter(f, fieldnames=["省", "市", "区/市/县", "网点名称", "邮编", "地址"])
        writer.writeheader()
        writer.writerows(data)

    safe_print(f"    已保存: {filepath} ({len(data)} 条)")
    return filepath


def save_spb_csv(data, abbr, date_str, output_dir):
    """保存邮管局数据为 CSV (GBK 编码, 不可编码字符用?替换)"""
    os.makedirs(output_dir, exist_ok=True)
    filename = f"spb{abbr}-{date_str}.csv"
    filepath = os.path.join(output_dir, filename)

    with open(filepath, "w", newline="", encoding="gbk", errors="replace") as f:
        writer = csv.writer(f)
        writer.writerow([
            "所属省", "所属市", "所属县", "场所名称", "开办业务", "详情链接"
        ])
        writer.writerows(data)

    safe_print(f"    已保存: {filepath} ({len(data)} 条)")
    return filepath


# ==================== 单省爬取 ====================

def crawl_one_province(province_name, abbr, area_code, date_str,
                       output_dir, do_post=True, do_spb=True, delay=1.0):
    """爬取单个省份的邮政官网和邮管局数据"""
    session = create_session()

    post_count = 0
    spb_count = 0

    if do_post:
        safe_print(f"  >> 抓取邮政官网数据...")
        try:
            post_data = crawl_post_province(session, province_name)
            if post_data:
                save_post_csv(post_data, abbr, date_str, output_dir)
                post_count = len(post_data)
            else:
                safe_print(f"    [提示] 邮政官网无数据")
        except Exception as e:
            safe_print(f"    [错误] 邮政官网爬取异常: {e}")

        time.sleep(delay)

    if do_spb:
        safe_print(f"  >> 抓取邮管局备案数据...")
        try:
            spb_data = crawl_spb_province(session, area_code)
            if spb_data:
                save_spb_csv(spb_data, abbr, date_str, output_dir)
                spb_count = len(spb_data)
            else:
                safe_print(f"    [提示] 邮管局无数据")
        except Exception as e:
            safe_print(f"    [错误] 邮管局爬取异常: {e}")

    session.close()
    return post_count, spb_count


# ==================== 对比功能 ====================


def get_file_prefix(filename):
    """从文件名中提取前缀，如 postbj, spbsh"""
    match = re.match(r'(post|spb)([a-z]+)', filename)
    if match:
        return match.group(0)
    return None


def compare_and_update(output_dir=OUTPUT_DIR, base_dir=BASE_DIR):
    """
    对比 output 和 base 文件夹中的 CSV 文件，导出对比报告，
    然后将 output 中的文件重命名为 ***+base 格式并替换 base 文件夹内容。
    """
    # 确保目录存在
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(base_dir, exist_ok=True)

    # 定位 txt_compare.exe
    script_dir = os.path.dirname(os.path.abspath(__file__))
    compare_exe_path = os.path.join(script_dir, COMPARE_EXE)

    if not os.path.isfile(compare_exe_path):
        safe_print(f"[错误] 未找到对比工具: {compare_exe_path}")
        safe_print("请确保 txt_compare.exe 与本脚本位于同一目录")
        return

    # 扫描两个目录的 CSV 文件
    output_files = (
        [f for f in os.listdir(output_dir) if f.endswith(".csv")]
        if os.path.isdir(output_dir) else []
    )
    base_files = (
        [f for f in os.listdir(base_dir) if f.endswith(".csv")]
        if os.path.isdir(base_dir) else []
    )

    # 按前缀建立映射: prefix -> filename
    output_map = {}
    for f in output_files:
        prefix = get_file_prefix(f)
        if prefix:
            output_map[prefix] = f

    base_map = {}
    for f in base_files:
        prefix = get_file_prefix(f)
        if prefix:
            base_map[prefix] = f

    if not output_map and not base_map:
        safe_print("[提示] output 和 base 文件夹中均无 CSV 文件，无需对比。")
        return

    # ── 生成对比报告 ──
    report_lines = []
    report_lines.append(
        f"对比报告 — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
    )
    report_lines.append("=" * 60)
    report_lines.append(
        f"output 目录: {os.path.abspath(output_dir)}  ({len(output_map)} 个文件)"
    )
    report_lines.append(
        f"base   目录: {os.path.abspath(base_dir)}  ({len(base_map)} 个文件)"
    )
    report_lines.append("=" * 60)

    all_prefixes = sorted(set(list(output_map.keys()) + list(base_map.keys())))

    compare_count = 0
    new_count = 0
    missing_count = 0

    safe_print("")
    safe_print("  正在执行文件对比...")
    safe_print("  " + "-" * 50)

    for prefix in all_prefixes:
        out_file = output_map.get(prefix)
        base_file = base_map.get(prefix)

        if out_file and base_file:
            # ── 两者都存在，调用 txt_compare.exe 对比 ──
            out_path = os.path.join(output_dir, out_file)
            base_path = os.path.join(base_dir, base_file)

            safe_print(f"    对比: {prefix} ...", end=" ")

            cmd = [
                compare_exe_path,
                "--file1", out_path,
                "--file2", base_path,
                "--display", "detailed",
            ]
            try:
                # Windows 下隐藏控制台窗口
                creationflags = (
                    subprocess.CREATE_NO_WINDOW
                    if sys.platform == "win32"
                    else 0
                )
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    creationflags=creationflags,
                )
                report_lines.append(f"\n--- {prefix} ---")
                report_lines.append(f"  Output : {out_file}")
                report_lines.append(f"  Base   : {base_file}")
                if result.stdout:
                    report_lines.append(result.stdout.rstrip())
                if result.stderr:
                    report_lines.append(f"  [stderr]: {result.stderr.rstrip()}")
                safe_print("完成")
                compare_count += 1
            except subprocess.TimeoutExpired:
                report_lines.append(f"\n--- {prefix} ---")
                report_lines.append(f"  [错误] 对比超时 (>120s)")
                safe_print("超时")
            except FileNotFoundError:
                report_lines.append(f"\n--- {prefix} ---")
                report_lines.append(
                    f"  [错误] 找不到 txt_compare.exe: {compare_exe_path}"
                )
                safe_print("错误: 找不到对比工具")
                # 后续文件也无法处理，直接跳出
                break
            except Exception as e:
                report_lines.append(f"\n--- {prefix} ---")
                report_lines.append(f"  [错误] 对比失败: {e}")
                safe_print(f"失败: {e}")

        elif out_file:
            report_lines.append(f"\n--- {prefix} ---")
            report_lines.append(f"  Output : {out_file}")
            report_lines.append(f"  Base   : (无对应文件，视为新增)")
            new_count += 1
        elif base_file:
            report_lines.append(f"\n--- {prefix} ---")
            report_lines.append(f"  Output : (无对应文件)")
            report_lines.append(f"  Base   : {base_file} (output 中缺失)")
            missing_count += 1

    # ── 保存对比报告 ──
    report_date = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_filename = f"compare_report_{report_date}.txt"
    report_path = os.path.join(output_dir, report_filename)

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))

    safe_print("  " + "-" * 50)
    safe_print(f"  对比报告已保存: {report_path}")
    safe_print(
        f"  对比 {compare_count} 对 | 新增 {new_count} | 缺失 {missing_count}"
    )

    # ── 确认是否更新 base ──
    if not output_map:
        safe_print("\n  output 中无文件，无需更新 base。")
        return

    safe_print("")
    while True:
        try:
            confirm = input("是否将 output 内容更新到 base 文件夹? (Y/n): ").strip().lower()
            if confirm in ("y", "yes", ""):
                break
            elif confirm in ("n", "no"):
                safe_print("  已取消更新。")
                return
            else:
                safe_print("  请输入 Y 或 N")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  已取消更新。")
            return

    # ── 将 output 文件复制到 base，重命名为 ***+base.csv ──
    safe_print("\n  正在更新 base 文件夹...")
    updated = 0
    for prefix, out_file in output_map.items():
        out_path = os.path.join(output_dir, out_file)
        new_name = f"{prefix}+base.csv"
        new_base_path = os.path.join(base_dir, new_name)

        # 删除 base 中同前缀的旧格式文件（非 +base 格式）
        old_base_file = base_map.get(prefix)
        if old_base_file and old_base_file != new_name:
            old_path = os.path.join(base_dir, old_base_file)
            if os.path.isfile(old_path):
                os.remove(old_path)
                safe_print(f"    删除旧文件: {old_base_file}")

        shutil.copy2(out_path, new_base_path)
        safe_print(f"    {out_file}  →  {new_name}")
        updated += 1

    safe_print(f"\n  base 文件夹已更新，共处理 {updated} 个文件。")


# ==================== 横向对比功能 ====================


def _cross_match(post_records, spb_records, enable_fuzzy=False, fuzzy_threshold=0.8):
    """多阶名称匹配引擎。

    阶1 — 精确匹配  : 原始名称完全相同
    阶2 — 归一化匹配: 去括号注释 + 剥离类型后缀/前缀后相同
    阶3 — 疑似匹配  : 剥离后缀后存在 >=2 个汉字的公共子串
    阶4 — 模糊匹配  : difflib.get_close_matches (可选)

    返回:
      {matched_exact, matched_normalized, matched_suspected, matched_fuzzy,
       post_only, spb_only}
    """
    # ── 阶1: 精确匹配 ──
    spb_by_name = {}
    for idx, r in enumerate(spb_records):
        spb_by_name.setdefault(r["name"], []).append((idx, r))

    used_spb = set()
    matched_exact = []
    post_unmatched = []

    for post in post_records:
        pname = post["name"]
        post_district = post.get("district", "")
        if pname in spb_by_name:
            found = False
            for si, spb_rec in spb_by_name[pname]:
                if si not in used_spb:
                    # 区县名必须一致，防止跨区县误匹配
                    spb_district = spb_rec.get("district", "")
                    if post_district and spb_district and post_district != spb_district:
                        continue
                    matched_exact.append((post, spb_rec))
                    used_spb.add(si)
                    found = True
                    break
            if not found:
                post_unmatched.append(post)
        else:
            post_unmatched.append(post)

    # ── 阶2: 归一化匹配（标准归一化 + 增强归一化） ──
    # Pass 1: 标准归一化（双方均用 normalize_name）
    spb_by_normalized = {}
    for idx, r in enumerate(spb_records):
        if idx not in used_spb:
            norm = normalize_name(r["name"])
            if norm:
                spb_by_normalized.setdefault(norm, []).append((idx, r))

    matched_normalized = []
    still_unmatched = []
    for post in post_unmatched:
        pnorm = normalize_name(post["name"])
        post_district = post.get("district", "")
        if pnorm and pnorm in spb_by_normalized:
            found = False
            for si, spb_rec in spb_by_normalized[pnorm]:
                if si not in used_spb:
                    spb_district = spb_rec.get("district", "")
                    if post_district and spb_district and post_district != spb_district:
                        continue
                    matched_normalized.append((post, spb_rec))
                    used_spb.add(si)
                    found = True
                    break
            if not found:
                still_unmatched.append(post)
            if pnorm in spb_by_normalized and not spb_by_normalized[pnorm]:
                del spb_by_normalized[pnorm]
        else:
            still_unmatched.append(post)

    # Swallow any remaining spb_by_normalized entries (they just weren't matched)
    # Reset: reindex remaining SPB records for enhanced pass
    remaining_spb_idx = {}
    for idx, r in enumerate(spb_records):
        if idx not in used_spb:
            remaining_spb_idx[idx] = r

    # Pass 2: 增强归一化（SPB 侧使用多种策略剥离前缀）
    if still_unmatched and remaining_spb_idx:
        # 为每个剩余 SPB 记录生成增强归一化候选，建立 lookup: norm_form -> [(idx, rec)]
        spb_enhanced = {}
        for idx, r in remaining_spb_idx.items():
            city = r.get("city", "")
            district = r.get("district", "")
            for form in _enhanced_normalize_spb(
                r["name"], city, district, r.get("province", "")
            ):
                if form not in spb_enhanced:
                    spb_enhanced[form] = []
                spb_enhanced[form].append((idx, r))

        still_unmatched_2 = []
        for post in still_unmatched:
            pnorm = normalize_name(post["name"])
            post_district = post.get("district", "")
            if pnorm and pnorm in spb_enhanced:
                found = False
                for si, spb_rec in spb_enhanced[pnorm]:
                    if si not in used_spb:
                        spb_district = spb_rec.get("district", "")
                        if post_district and spb_district and post_district != spb_district:
                            continue
                        matched_normalized.append((post, spb_rec))
                        used_spb.add(si)
                        found = True
                        break
                if not found:
                    still_unmatched_2.append(post)
                if pnorm in spb_enhanced and not spb_enhanced[pnorm]:
                    del spb_enhanced[pnorm]
            else:
                still_unmatched_2.append(post)
        still_unmatched = still_unmatched_2

    # ── 阶3: 疑似匹配（公共中文字符子串 >= 2字） ──
    matched_suspected = []
    if still_unmatched:
        remaining_spb_for_suspect = [
            (idx, r) for idx, r in enumerate(spb_records) if idx not in used_spb
        ]
        still_unmatched_3 = []
        # 预计算 POST 核心名
        post_cores = []
        for post in still_unmatched:
            cn = "".join(c for c in normalize_name(post["name"]) if "一" <= c <= "鿿")
            post_cores.append(cn)

        for pi, post in enumerate(still_unmatched):
            post_cn = post_cores[pi]
            if len(post_cn) < 2:
                still_unmatched_3.append(post)
                continue
            post_district = post.get("district", "")
            post_is_special = _is_special_zone(post_district)
            best_match = None  # (spb_idx, spb_rec, common_str, note)
            best_len = 0
            for si, spb_rec in remaining_spb_for_suspect:
                spb_district = spb_rec.get("district", "")
                # 县（区/市）名必须相同；但若任一方为特殊园区则放宽限制
                district_ok = True
                district_note = ""
                if post_district and spb_district and post_district != spb_district:
                    spb_is_special = _is_special_zone(spb_district)
                    if post_is_special or spb_is_special:
                        # 特殊园区：允许跨区县匹配，但在备注中标注
                        district_note = f"【{post_district}↔{spb_district}】"
                    else:
                        continue  # 普通区县不同，跳过
                common = _find_common_cn_substring(post["name"], spb_rec["name"])
                if len(common) > best_len:
                    best_len = len(common)
                    best_match = (si, spb_rec, common, district_note)
            if best_match and best_len >= 2:
                si, spb_rec, common_str, note = best_match
                matched_suspected.append((post, spb_rec, common_str, note))
                used_spb.add(si)
                # 从剩余列表中移除已匹配的 SPB 记录
                remaining_spb_for_suspect = [
                    (idx, r) for idx, r in remaining_spb_for_suspect if idx != si
                ]
            else:
                still_unmatched_3.append(post)
        still_unmatched = still_unmatched_3

    # ── 阶4: 模糊匹配 (可选) ──
    matched_fuzzy = []
    final_post_only = []

    if enable_fuzzy and still_unmatched:
        remaining_spb = [
            (idx, r) for idx, r in enumerate(spb_records) if idx not in used_spb
        ]
        spb_core_map = {}
        spb_core_list = []
        for idx, r in remaining_spb:
            # 模糊匹配也使用增强归一化，取最简形式（最短非空结果）
            forms = _enhanced_normalize_spb(
                r["name"], r.get("city", ""), r.get("district", ""),
                r.get("province", "")
            )
            for norm in sorted(forms, key=len):
                if norm and norm not in spb_core_map:
                    spb_core_map[norm] = (idx, r)
                    spb_core_list.append(norm)

        for post in still_unmatched:
            pnorm = normalize_name(post["name"])
            post_district = post.get("district", "")
            if not pnorm or not spb_core_list:
                final_post_only.append(post)
                continue
            matches = difflib.get_close_matches(
                pnorm, spb_core_list, n=1, cutoff=fuzzy_threshold
            )
            if matches:
                matched_norm = matches[0]
                si, spb_rec = spb_core_map[matched_norm]
                # 区县名必须一致
                spb_district = spb_rec.get("district", "")
                if post_district and spb_district and post_district != spb_district:
                    final_post_only.append(post)
                    continue
                ratio = difflib.SequenceMatcher(None, pnorm, matched_norm).ratio()
                matched_fuzzy.append((post, spb_rec, ratio))
                used_spb.add(si)
                spb_core_list.remove(matched_norm)
                del spb_core_map[matched_norm]
            else:
                final_post_only.append(post)
    else:
        final_post_only = still_unmatched

    # ── 阶5: 跨区县末次匹配（不限制区县，对剩余记录做归一化+子串匹配） ──
    matched_cross_district = []
    if final_post_only:
        remaining_spb_final = [
            (idx, r) for idx, r in enumerate(spb_records) if idx not in used_spb
        ]
        if remaining_spb_final:
            # 为剩余 SPB 生成增强归一化候选
            spb_cross_map = {}
            for idx, r in remaining_spb_final:
                city = r.get("city", "")
                district = r.get("district", "")
                for form in _enhanced_normalize_spb(
                    r["name"], city, district, r.get("province", "")
                ):
                    if form not in spb_cross_map:
                        spb_cross_map[form] = (idx, r)

            still_final = []
            for post in final_post_only:
                pnorm = normalize_name(post["name"])
                # 尝试归一化匹配
                if pnorm and pnorm in spb_cross_map:
                    si, spb_rec = spb_cross_map[pnorm]
                    district_note = ""
                    pd = post.get("district", "")
                    sd = spb_rec.get("district", "")
                    if pd and sd and pd != sd:
                        district_note = f"【{pd}↔{sd}】"
                    matched_cross_district.append((post, spb_rec, "归一化", district_note))
                    used_spb.add(si)
                elif pnorm and len(pnorm) >= 2:
                    # 尝试公共子串匹配
                    best_str = ""
                    best_si = None
                    best_sr = None
                    for si, spb_rec in remaining_spb_final:
                        common = _find_common_cn_substring(post["name"], spb_rec["name"])
                        if len(common) > len(best_str):
                            best_str = common
                            best_si, best_sr = si, spb_rec
                    if best_str and len(best_str) >= 2:
                        district_note = ""
                        pd = post.get("district", "")
                        sd = best_sr.get("district", "")
                        if pd and sd and pd != sd:
                            district_note = f"【{pd}↔{sd}】"
                        matched_cross_district.append(
                            (post, best_sr, f"子串:{best_str}", district_note)
                        )
                        used_spb.add(best_si)
                        # 移除已匹配的 SPB
                        remaining_spb_final = [
                            (i, r) for i, r in remaining_spb_final if i != best_si
                        ]
                    else:
                        still_final.append(post)
                else:
                    still_final.append(post)
            final_post_only = still_final

    # ── 剩余 SPB 记录 ──
    final_spb_only = [r for idx, r in enumerate(spb_records) if idx not in used_spb]

    return {
        "matched_exact": matched_exact,
        "matched_normalized": matched_normalized,
        "matched_suspected": matched_suspected,
        "matched_fuzzy": matched_fuzzy,
        "matched_cross_district": matched_cross_district,
        "post_only": final_post_only,
        "spb_only": final_spb_only,
    }


def cross_compare(data_dir=OUTPUT_DIR, use_base=False, target_provinces=None,
                  enable_fuzzy=False, fuzzy_threshold=0.8):
    """横向对比: 按省份交叉比对邮政官网(POST)与邮管局(SPB)的网点名称。

    参数:
      data_dir         — 数据目录 (output/ 或 base/)
      use_base         — True 使用 {prefix}+base.csv, False 使用 {prefix}-{date}.csv
      target_provinces — None=自动检测, 或 [(name, abbr, code), ...] 列表
      enable_fuzzy     — 是否启用阶3模糊匹配
      fuzzy_threshold  — 模糊匹配阈值 (0.0~1.0)
    """
    os.makedirs(data_dir, exist_ok=True)

    # ── 确定目标省份 ──
    if target_provinces is None:
        target_provinces = list(PROVINCES)

    # ── 收集可用省份对 ──
    province_pairs = []
    for province, abbr, area_code in target_provinces:
        if use_base:
            post_file = os.path.join(data_dir, f"post{abbr}+base.csv")
            spb_file = os.path.join(data_dir, f"spb{abbr}+base.csv")
            post_found = os.path.isfile(post_file)
            spb_found = os.path.isfile(spb_file)
        else:
            post_file = find_latest_file(data_dir, f"post{abbr}")
            spb_file = find_latest_file(data_dir, f"spb{abbr}")
            post_found = post_file is not None
            spb_found = spb_file is not None

        if post_found and spb_found:
            province_pairs.append((province, abbr, post_file, spb_file))
        else:
            missing = []
            if not post_found:
                missing.append("POST")
            if not spb_found:
                missing.append("SPB")
            safe_print(f"  [跳过] {province}({abbr}): 缺少 {'/'.join(missing)} 数据")

    if not province_pairs:
        safe_print("\n[提示] 没有找到同时具备 POST 和 SPB 数据的省份，无法进行横向对比。")
        safe_print(f"  数据目录: {os.path.abspath(data_dir)}")
        safe_print("  请先爬取两个数据源的数据。")
        return

    safe_print(f"\n  找到 {len(province_pairs)} 个可横向对比的省份")
    safe_print("  " + "-" * 50)

    # ── 逐省对比并收集结果 ──
    all_results = []
    report_lines = []
    report_lines.append("=" * 70)
    report_lines.append("横向对比报告 — 邮政(中国邮政官网) vs 邮管局(国家邮政局备案)")
    report_lines.append(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    report_lines.append(f"数据目录: {os.path.abspath(data_dir)}")
    report_lines.append(f"匹配模式: 精确 + 归一化" +
                        (" + 模糊" if enable_fuzzy else ""))
    report_lines.append("=" * 70)

    grand_post_total = 0
    grand_spb_total = 0
    grand_exact = 0
    grand_normalized = 0
    grand_suspected = 0
    grand_fuzzy = 0
    grand_cross = 0

    for prov_idx, (province, abbr, post_file, spb_file) in enumerate(province_pairs, 1):
        safe_print(f"  [{prov_idx}/{len(province_pairs)}] {province} ({abbr}) ...", end=" ")

        post_records = read_post_csv(post_file)
        spb_records = read_spb_csv(spb_file)

        if not post_records and not spb_records:
            safe_print("双方均无数据，跳过")
            continue

        result = _cross_match(
            post_records, spb_records,
            enable_fuzzy=enable_fuzzy,
            fuzzy_threshold=fuzzy_threshold,
        )
        all_results.append((province, abbr, post_file, spb_file, result))

        n_post = len(post_records)
        n_spb = len(spb_records)
        n_exact = len(result["matched_exact"])
        n_norm = len(result["matched_normalized"])
        n_suspected = len(result["matched_suspected"])
        n_fuzzy = len(result["matched_fuzzy"])
        n_cross = len(result["matched_cross_district"])
        n_match = n_exact + n_norm + n_suspected + n_fuzzy + n_cross
        n_post_only = len(result["post_only"])
        n_spb_only = len(result["spb_only"])

        grand_post_total += n_post
        grand_spb_total += n_spb
        grand_exact += n_exact
        grand_normalized += n_norm
        grand_suspected += n_suspected
        grand_fuzzy += n_fuzzy
        grand_cross += n_cross

        post_pct = n_match / n_post * 100 if n_post else 0
        spb_pct = n_match / n_spb * 100 if n_spb else 0

        safe_print(
            f"POST {n_post}条 / SPB {n_spb}条 → "
            f"匹配 {n_match} (邮政视角 {post_pct:.1f}%)"
        )

        # ── 省份详细报告 ──
        post_name = os.path.basename(post_file)
        spb_name = os.path.basename(spb_file)

        report_lines.append("")
        report_lines.append(f"省份: {province} ({abbr})")
        report_lines.append("-" * 50)
        report_lines.append(f"文件: {post_name} ({n_post}条) vs {spb_name} ({n_spb}条)")
        report_lines.append("")
        report_lines.append("=== 汇总 ===")
        report_lines.append(f"  邮政官网记录数           : {n_post}")
        report_lines.append(f"  邮管局备案记录数          : {n_spb}")
        report_lines.append(f"  精确匹配                 : {n_exact}"
                           + (f" ({n_exact / n_post * 100:.1f}%)" if n_post else ""))
        if n_norm:
            report_lines.append(f"  归一化匹配               : {n_norm}"
                               + (f" ({n_norm / n_post * 100:.1f}%)" if n_post else ""))
        if n_suspected:
            report_lines.append(f"  疑似匹配                 : {n_suspected}"
                               + (f" ({n_suspected / n_post * 100:.1f}%)" if n_post else ""))
        if n_fuzzy:
            report_lines.append(f"  模糊匹配                 : {n_fuzzy}"
                               + (f" ({n_fuzzy / n_post * 100:.1f}%)" if n_post else ""))
        if n_cross:
            report_lines.append(f"  跨区县末次匹配           : {n_cross}"
                               + (f" ({n_cross / n_post * 100:.1f}%)" if n_post else ""))
        report_lines.append(f"  ─────────────────────────────────")
        report_lines.append(f"  匹配总计 (邮政视角)      : {n_match}"
                           + (f" ({post_pct:.1f}%)" if n_post else ""))
        report_lines.append(f"  邮政有但邮管无           : {n_post_only}"
                           + (f" ({n_post_only / n_post * 100:.1f}%)" if n_post else ""))
        report_lines.append(f"  邮管有但邮政无           : {n_spb_only}"
                           + (f" ({n_spb_only / n_spb * 100:.1f}%)" if n_spb else ""))

        # ── 详细列表 ──
        if result["post_only"] or result["spb_only"]:
            # 按区县对齐：将邮政和邮管的不匹配记录归并到同一区县下，左右对照展示
            post_by_district = {}
            for r in result["post_only"]:
                key = r.get("district", "") or r.get("city", "")
                post_by_district.setdefault(key, []).append(r)

            spb_by_district = {}
            for r in result["spb_only"]:
                key = r.get("district", "") or r.get("city", "")
                spb_by_district.setdefault(key, []).append(r)

            all_districts = sorted(
                set(list(post_by_district.keys()) + list(spb_by_district.keys()))
            )

            report_lines.append("")
            report_lines.append(
                f"=== 按区县对齐的不匹配条目（邮政 {n_post_only}条 / 邮管 {n_spb_only}条） ==="
            )
            report_lines.append(
                f"  {'区县':<16s} {'邮政网点':<30s} {'邮管网点':<30s} {'邮政邮编':<8s}"
            )
            report_lines.append(
                f"  {'-' * 16} {'-' * 30} {'-' * 30} {'-' * 8}"
            )

            # 先收集所有行，再按"双方都有→仅邮政→仅邮管"排序输出
            paired_rows = []   # 双方都有
            post_only_rows = []# 仅邮政有
            spb_only_rows = [] # 仅邮管有

            for dist in all_districts:
                post_list = post_by_district.get(dist, [])
                spb_list = spb_by_district.get(dist, [])
                max_len = max(len(post_list), len(spb_list))
                for i in range(max_len):
                    post_r = post_list[i] if i < len(post_list) else None
                    spb_r = spb_list[i] if i < len(spb_list) else None
                    post_name = post_r["name"] if post_r else "(无)"
                    spb_name = spb_r["name"] if spb_r else "(无)"
                    post_pc = post_r.get("postcode", "") if post_r else ""
                    line = f"  {dist:<14s} {post_name:<30s} {spb_name:<30s} {post_pc:<8s}"
                    if post_r and spb_r:
                        paired_rows.append(line)
                    elif post_r and not spb_r:
                        post_only_rows.append(line)
                    else:
                        spb_only_rows.append(line)

            for line in paired_rows:
                report_lines.append(line)
            for line in post_only_rows:
                report_lines.append(line)
            for line in spb_only_rows:
                report_lines.append(line)

        if result["matched_cross_district"]:
            report_lines.append("")
            report_lines.append(
                f"=== 跨区县末次匹配 — 不限制区县的归一化/子串匹配 ({n_cross}对) ==="
            )
            report_lines.append(
                f"  {'方法':<8s} {'邮政名称':<28s} → {'邮管名称':<28s}   {'邮政区县':<14s} {'邮管区县':<14s} {'邮编':<8s}"
            )
            report_lines.append(f"  {'-' * 8} {'-' * 28}   {'-' * 28}   {'-' * 14} {'-' * 14} {'-' * 8}")
            for item in result["matched_cross_district"]:
                post_r, spb_r, method, note = item
                post_loc = post_r.get("district", "")
                spb_loc = spb_r.get("district", "")
                report_lines.append(
                    f"  {method:<8s} {post_r['name']:<28s} → {spb_r['name']:<28s}   {post_loc:<14s} {spb_loc:<14s} {post_r.get('postcode', ''):<8s}"
                )

        if result["matched_normalized"]:
            report_lines.append("")
            report_lines.append(
                f"=== 归一化匹配 — 含注释剥离/前缀剥离/后缀统一 ({n_norm}对) ==="
            )
            report_lines.append(
                f"  {'邮政名称':<30s} → {'邮管名称':<30s}   {'所属区县':<16s} {'邮编':<8s}"
            )
            report_lines.append(f"  {'-' * 30}   {'-' * 30}   {'-' * 16} {'-' * 8}")
            for post_r, spb_r in result["matched_normalized"]:
                loc = f"{post_r['city']}/{post_r['district']}" if post_r.get("district") else post_r.get("city", "")
                report_lines.append(
                    f"  {post_r['name']:<30s} → {spb_r['name']:<30s}   {loc:<16s} {post_r.get('postcode', ''):<8s}"
                )

        if result["matched_suspected"]:
            report_lines.append("")
            report_lines.append(
                f"=== 疑似匹配 — 存在公共中文字串需人工确认 ({n_suspected}对) ==="
            )
            report_lines.append(
                f"  {'公共字串':<10s} {'邮政名称':<26s} → {'邮管名称':<26s}   {'所属区县':<14s} {'邮编':<8s} {'备注'}"
            )
            report_lines.append(f"  {'-' * 10} {'-' * 26}   {'-' * 26}   {'-' * 14} {'-' * 8} {'-' * 20}")
            for item in result["matched_suspected"]:
                post_r, spb_r, common_str = item[0], item[1], item[2]
                note = item[3] if len(item) >= 4 else ""
                loc = f"{post_r['city']}/{post_r['district']}" if post_r.get("district") else post_r.get("city", "")
                report_lines.append(
                    f"  {common_str:<10s} {post_r['name']:<26s} → {spb_r['name']:<26s}   {loc:<14s} {post_r.get('postcode', ''):<8s} {note}"
                )

        if result["matched_fuzzy"]:
            report_lines.append("")
            report_lines.append(
                f"=== 模糊匹配 — 需人工确认 ({n_fuzzy}对) ==="
            )
            report_lines.append(
                f"  {'相似度':<8s} {'邮政名称':<30s} → {'邮管名称':<30s}"
            )
            report_lines.append(f"  {'-' * 8} {'-' * 30}   {'-' * 30}")
            for post_r, spb_r, ratio in result["matched_fuzzy"]:
                report_lines.append(
                    f"  {ratio:.3f}   {post_r['name']:<30s} → {spb_r['name']:<30s}"
                )

    # ── 多省汇总 ──
    if len(province_pairs) > 1:
        grand_match = grand_exact + grand_normalized + grand_suspected + grand_fuzzy + grand_cross
        report_lines.append("")
        report_lines.append("=" * 70)
        report_lines.append("多省汇总")
        report_lines.append("=" * 70)
        report_lines.append(
            f"{'省份':<10s} {'邮政':>6s} {'邮管':>6s} "
            f"{'匹配':>6s} {'匹配率':>8s} {'邮政独有':>8s} {'邮管独有':>8s}"
        )
        report_lines.append(f"{'─' * 10} {'─' * 6} {'─' * 6} {'─' * 6} {'─' * 8} {'─' * 8} {'─' * 8}")
        for province, abbr, _, _, result in all_results:
            n_post = (
                len(result["post_only"]) +
                len(result["matched_exact"]) +
                len(result["matched_normalized"]) +
                len(result["matched_suspected"]) +
                len(result["matched_fuzzy"]) +
                len(result["matched_cross_district"])
            )
            n_spb = (
                len(result["spb_only"]) +
                len(result["matched_exact"]) +
                len(result["matched_normalized"]) +
                len(result["matched_suspected"]) +
                len(result["matched_fuzzy"]) +
                len(result["matched_cross_district"])
            )
            n_match = (
                len(result["matched_exact"]) +
                len(result["matched_normalized"]) +
                len(result["matched_suspected"]) +
                len(result["matched_fuzzy"]) +
                len(result["matched_cross_district"])
            )
            pct = f"{n_match / n_post * 100:.1f}%" if n_post else "N/A"
            report_lines.append(
                f"{province + '(' + abbr + ')':<10s} "
                f"{n_post:>6d} {n_spb:>6d} "
                f"{n_match:>6d} {pct:>8s} "
                f"{len(result['post_only']):>8d} {len(result['spb_only']):>8d}"
            )

        report_lines.append(f"{'─' * 10} {'─' * 6} {'─' * 6} {'─' * 6} {'─' * 8} {'─' * 8} {'─' * 8}")
        report_lines.append(
            f"{'合计':<10s} "
            f"{grand_post_total:>6d} {grand_spb_total:>6d} "
            f"{grand_match:>6d} "
            f"{grand_match / grand_post_total * 100:>7.1f}%"
            f"{(grand_post_total - grand_match):>8d} "
            f"{(grand_spb_total - grand_match):>8d}"
            if grand_post_total else ""
        )

    # ── 保存报告 ──
    report_date = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_filename = f"cross_compare_{report_date}.txt"
    report_path = os.path.join(data_dir, report_filename)

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))

    safe_print("  " + "-" * 50)
    safe_print(f"  横向对比报告已保存: {report_path}")
    safe_print(f"  共对比 {len(province_pairs)} 个省份")
    if grand_post_total:
        grand_match = grand_exact + grand_normalized + grand_suspected + grand_fuzzy + grand_cross
        safe_print(
            f"  邮政总计 {grand_post_total}条 / 匹配 {grand_match}条"
            + (f" ({grand_match / grand_post_total * 100:.1f}%)" if grand_post_total else "")
        )


# ==================== 交互式菜单 ====================

def print_province_table():
    """打印省份编号表格（3列）"""
    safe_print("  [0] 全部31个省份")
    safe_print("  " + "-" * 55)
    for i, (name, abbr, _) in enumerate(PROVINCES, 1):
        end_char = "\n" if i % 3 == 0 else ""
        safe_print(f"  {i:>2}. {name} ({abbr})".ljust(22), end="" if i % 3 != 0 else "\n")
    if len(PROVINCES) % 3 != 0:
        safe_print("")
    safe_print("  " + "-" * 55)


def parse_province_selection(user_input):
    """
    解析用户输入的省份选择。

    支持格式:
      - "0" 或 "all" → 全选
      - "1" → 单选
      - "1 3 5" → 多个用空格分隔
      - "1-5" → 范围
      - "1 3 5-8 10" → 混合

    返回 selected 列表 [(name, abbr, code), ...]
    """
    user_input = user_input.strip().lower()
    if user_input in ("0", "all", ""):
        return list(PROVINCES)

    selected = set()
    parts = user_input.split()

    for part in parts:
        if "-" in part:
            try:
                start_s, end_s = part.split("-", 1)
                start, end = int(start_s), int(end_s)
                if 1 <= start <= end <= len(PROVINCES):
                    selected.update(range(start, end + 1))
            except ValueError:
                safe_print(f"    [警告] 无效的范围: {part}，已跳过")
        else:
            try:
                num = int(part)
                if 1 <= num <= len(PROVINCES):
                    selected.add(num)
                else:
                    safe_print(f"    [警告] 无效的编号: {part}，已跳过")
            except ValueError:
                safe_print(f"    [警告] 无法识别的输入: {part}，已跳过")

    if not selected:
        return []

    return [PROVINCES[i - 1] for i in sorted(selected)]


def interactive_select():
    """
    交互式选择数据来源和省份。

    返回: (do_post, do_spb, target_provinces, delay, inter_province_delay)
    """
    safe_print("")
    safe_print("=" * 60)
    safe_print("  全国邮政网点信息爬取程序")
    safe_print("=" * 60)
    safe_print("")

    # --- 选择数据来源 ---
    safe_print("请选择数据来源:")
    safe_print("  [1] 中国邮政官网 (post)")
    safe_print("  [2] 国家邮政局备案 (spb)")
    safe_print("  [3] 两者都抓取 (both)")
    safe_print("")
    while True:
        try:
            choice = input("请输入选项 (1-3, 默认3): ").strip()
            if choice == "":
                choice = "3"
            choice = int(choice)
            if choice == 1:
                do_post, do_spb = True, False
                break
            elif choice == 2:
                do_post, do_spb = False, True
                break
            elif choice == 3:
                do_post, do_spb = True, True
                break
            else:
                safe_print("  请输入 1、2 或 3")
        except ValueError:
            safe_print("  请输入有效数字")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  程序退出")
            sys.exit(0)

    safe_print("")

    # --- 选择目标省份 ---
    safe_print("请选择目标省份:")
    print_province_table()
    safe_print("")
    safe_print("支持格式: 0=全部, 单个编号(1), 范围(1-5), 混合(1 3 5-8 10)")
    safe_print("")

    while True:
        try:
            user_input = input("请输入省份编号 (默认0=全部): ").strip()
            target = parse_province_selection(user_input)
            if target:
                break
            safe_print("  未选中任何有效省份，请重新输入")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  程序退出")
            sys.exit(0)

    safe_print("")

    # --- 请求间隔 ---
    safe_print("请设置请求间隔（避免被服务器限流）:")
    while True:
        try:
            delay_input = input("  数据源之间的间隔秒数 (默认1.0): ").strip()
            delay = float(delay_input) if delay_input else 1.0
            if delay < 0:
                safe_print("  请输入非负数")
                continue
            break
        except ValueError:
            safe_print("  请输入有效数字")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  程序退出")
            sys.exit(0)

    while True:
        try:
            inter_input = input("  省份之间的间隔秒数 (默认1.0): ").strip()
            inter_delay = float(inter_input) if inter_input else 1.0
            if inter_delay < 0:
                safe_print("  请输入非负数")
                continue
            break
        except ValueError:
            safe_print("  请输入有效数字")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  程序退出")
            sys.exit(0)

    safe_print("")

    # --- 确认选择 ---
    source_names = []
    if do_post:
        source_names.append("中国邮政官网")
    if do_spb:
        source_names.append("国家邮政局备案")

    safe_print("-" * 50)
    safe_print(f"  数据来源 : {' + '.join(source_names)}")
    safe_print(f"  目标省份 : {len(target)} 个")
    safe_print(f"  省份列表 : {', '.join(p[0] for p in target)}")
    safe_print(f"  请求间隔 : {delay}s (源间) / {inter_delay}s (省间)")
    safe_print("-" * 50)
    safe_print("")

    while True:
        try:
            confirm = input("确认开始爬取? (Y/n): ").strip().lower()
            if confirm in ("y", "yes", ""):
                break
            elif confirm in ("n", "no"):
                safe_print("  已取消，程序退出")
                sys.exit(0)
            else:
                safe_print("  请输入 Y 或 N")
        except (EOFError, KeyboardInterrupt):
            safe_print("\n  程序退出")
            sys.exit(0)

    return do_post, do_spb, target, delay, inter_delay


# ==================== 主流程 ====================

def main():
    parser = argparse.ArgumentParser(
        description="全国邮政网点信息爬取程序 — 数据来源: 中国邮政官网 + 国家邮政局备案",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python crawler.py                         # 交互式选择
  python crawler.py --province 上海 北京     # 命令行指定省份（跳过交互）
  python crawler.py --source post           # 仅爬取邮政官网
  python crawler.py --all --source spb      # 全部省份，邮管局
  python crawler.py --delay 2.0             # 自定义请求间隔(秒)
  python crawler.py --compare               # 对比 output 与 base 文件夹
  python crawler.py --compare --output my_output --base my_base
        """,
    )
    parser.add_argument(
        "--source", choices=["post", "spb", "both"], default=None,
        help="数据来源: post(邮政官网), spb(邮管局), both(两者)。不指定则在交互中选择"
    )
    parser.add_argument(
        "--province", nargs="+", default=None,
        help="指定要爬取的省份（中文名，可多个）。指定后跳过交互式选择"
    )
    parser.add_argument(
        "--all", action="store_true", default=False,
        help="爬取全部31省（与 --source 配合使用，跳过省份选择）"
    )
    parser.add_argument(
        "--delay", type=float, default=None,
        help="两个数据源之间的请求间隔秒数（不指定则在交互中设置）"
    )
    parser.add_argument(
        "--inter-province-delay", type=float, default=None,
        help="省份之间的请求间隔秒数（不指定则在交互中设置）"
    )
    parser.add_argument(
        "--output", default=OUTPUT_DIR,
        help=f"输出目录（默认: {OUTPUT_DIR}）"
    )
    parser.add_argument(
        "--compare", action="store_true", default=False,
        help="对比 output 与 base 文件夹中的 CSV 文件，导出报告并更新 base"
    )
    parser.add_argument(
        "--base", default=BASE_DIR,
        help=f"对比模式下的基准目录（默认: {BASE_DIR}）"
    )
    parser.add_argument(
        "--cross-compare", action="store_true", default=False,
        help="横向对比: 比较同一省份的邮政官网与邮管局网点数据"
    )
    parser.add_argument(
        "--fuzzy", action="store_true", default=False,
        help="在横向对比中启用模糊匹配（默认仅使用精确+归一化匹配）"
    )
    parser.add_argument(
        "--match-threshold", type=float, default=0.8,
        help="模糊匹配的相似度阈值 (0.0-1.0, 默认0.8)"
    )

    args = parser.parse_args()

    output_dir = args.output

    # ── 横向对比模式 ──
    if args.cross_compare:
        # 解析目标省份
        if args.all:
            target = list(PROVINCES)
        elif args.province:
            name_map = {p[0]: p for p in PROVINCES}
            target = []
            for name in args.province:
                if name in name_map:
                    target.append(name_map[name])
                else:
                    safe_print(f"[警告] 未知省份: {name}，已跳过")
            if not target:
                safe_print("[错误] 没有有效的省份，程序退出")
                sys.exit(1)
        else:
            target = None  # 自动检测所有有数据的省份

        cross_compare(
            data_dir=output_dir,
            use_base=False,
            target_provinces=target,
            enable_fuzzy=args.fuzzy,
            fuzzy_threshold=args.match_threshold,
        )
        return

    # ── 对比模式 ──
    if args.compare:
        compare_and_update(output_dir=output_dir, base_dir=args.base)
        return

    date_str = datetime.now().strftime("%Y%m%d")

    # --- 判断使用哪种模式 ---
    # 如果指定了 --province 或 --all，使用命令行模式；否则进入交互模式
    use_cli_mode = args.province is not None or args.all

    if use_cli_mode:
        # === 命令行模式 ===
        if args.source is None:
            args_source = "both"
        else:
            args_source = args.source
        do_post = args_source in ("post", "both")
        do_spb  = args_source in ("spb", "both")

        delay = args.delay if args.delay is not None else 1.0
        inter_delay = args.inter_province_delay if args.inter_province_delay is not None else 1.0

        # 确定省份列表
        if args.all:
            target_provinces = list(PROVINCES)
        elif args.province:
            target_provinces = []
            name_map = {p[0]: p for p in PROVINCES}
            for name in args.province:
                if name in name_map:
                    target_provinces.append(name_map[name])
                else:
                    safe_print(f"[警告] 未知省份: {name}，已跳过")
            if not target_provinces:
                safe_print("[错误] 没有有效的省份，程序退出")
                sys.exit(1)
        else:
            target_provinces = list(PROVINCES)
    else:
        # === 交互模式：先显示主菜单 ===
        while True:
            safe_print("")
            safe_print("=" * 60)
            safe_print("  全国邮政网点信息爬取程序")
            safe_print("=" * 60)
            safe_print("")
            safe_print("请选择操作:")
            safe_print("  [1] 爬取数据")
            safe_print("  [2] 对比数据 (output vs base)")
            safe_print("  [3] 横向对比 (邮政 vs 邮管局)")
            safe_print("  [4] 退出")
            safe_print("")

            try:
                menu_choice = input("请输入选项 (1-4): ").strip()
            except (EOFError, KeyboardInterrupt):
                safe_print("\n  程序退出")
                sys.exit(0)

            if menu_choice == "1":
                # ── 爬取数据 ──
                try:
                    do_post, do_spb, target_provinces, delay, inter_delay = (
                        interactive_select()
                    )
                except SystemExit:
                    # 用户在爬取设置中取消，返回主菜单
                    continue

                if args.source is not None:
                    do_post = args.source in ("post", "both")
                    do_spb = args.source in ("spb", "both")
                if args.delay is not None:
                    delay = args.delay
                if args.inter_province_delay is not None:
                    inter_delay = args.inter_province_delay
                break  # 退出主菜单，进入爬取流程

            elif menu_choice == "2":
                # ── 对比数据 ──
                compare_and_update(output_dir=output_dir, base_dir=args.base)
                # 对比完成后回到主菜单

            elif menu_choice == "3":
                # ── 横向对比 ──
                safe_print("")
                safe_print("请选择数据来源:")
                safe_print("  [1] 使用 output/ (最新数据)")
                safe_print("  [2] 使用 base/ (基准数据)")
                safe_print("")
                try:
                    src_choice = input("请输入选项 (1-2, 默认1): ").strip()
                    use_base = (src_choice == "2")
                except (EOFError, KeyboardInterrupt):
                    safe_print("\n  已取消，返回主菜单")
                    continue

                safe_print("")
                safe_print("请选择省份 (0=全部有数据的省份, 或输入省份编号):")
                print_province_table()
                safe_print("")
                try:
                    prov_input = input("请输入省份编号 (默认0): ").strip()
                    if prov_input in ("", "0", "all"):
                        target = None
                    else:
                        target = parse_province_selection(prov_input)
                        if not target:
                            safe_print("  未选中任何有效省份，返回主菜单")
                            continue
                except (EOFError, KeyboardInterrupt):
                    safe_print("\n  已取消，返回主菜单")
                    continue

                safe_print("")
                cross_compare(
                    data_dir=output_dir if not use_base else args.base,
                    use_base=use_base,
                    target_provinces=target,
                )
                # 对比完成后回到主菜单

            elif menu_choice == "4":
                safe_print("  程序退出")
                sys.exit(0)
            else:
                safe_print("  请输入 1、2、3 或 4")

    # ===== 打印任务概览 =====
    safe_print("=" * 60)
    safe_print("  全国邮政网点信息爬取程序")
    safe_print("=" * 60)
    safe_print(f"  爬取日期   : {date_str}")
    safe_print(f"  目标省份   : {len(target_provinces)} 个")
    safe_print(f"  数据来源   : ", end="")
    sources = []
    if do_post:
        sources.append("中国邮政官网")
    if do_spb:
        sources.append("国家邮政局备案")
    safe_print(" + ".join(sources))
    safe_print(f"  输出目录   : {os.path.abspath(output_dir)}")
    safe_print(f"  请求间隔   : {delay}s (源间) / {inter_delay}s (省间)")
    safe_print("=" * 60)
    safe_print("")

    # 确保输出目录存在
    os.makedirs(output_dir, exist_ok=True)

    # ===== 逐省爬取 =====
    grand_post = 0
    grand_spb = 0
    post_empty = []       # 邮政官网无数据的省份
    spb_empty = []        # 邮管局无数据的省份
    start_time = time.time()

    for idx, (province, abbr, area_code) in enumerate(target_provinces, 1):
        safe_print(f"{'-' * 50}")
        safe_print(f"[{idx}/{len(target_provinces)}] {province} ({abbr}) - 区划代码 {area_code}")
        safe_print(f"{'-' * 50}")

        try:
            post_cnt, spb_cnt = crawl_one_province(
                province, abbr, area_code, date_str,
                output_dir=output_dir,
                do_post=do_post, do_spb=do_spb, delay=delay
            )
        except Exception as e:
            safe_print(f"  [严重错误] 省份 {province} 爬取过程中出现未处理异常: {e}")
            post_cnt, spb_cnt = 0, 0

        if do_post:
            if post_cnt == 0:
                post_empty.append(province)
            grand_post += post_cnt

        if do_spb:
            if spb_cnt == 0:
                spb_empty.append(province)
            grand_spb += spb_cnt

        # 省份间延迟（最后一个不延迟）
        if idx < len(target_provinces):
            safe_print(f"    等待 {inter_delay}s...")
            time.sleep(inter_delay)

    elapsed = time.time() - start_time

    # ===== 汇总报告 =====
    safe_print("")
    safe_print("=" * 60)
    safe_print("  爬取完成 — 汇总报告")
    safe_print("=" * 60)
    if do_post:
        safe_print(f"  邮政官网 — 总计 {grand_post:>6} 条记录")
        if post_empty:
            safe_print(f"    无数据省份: {', '.join(post_empty)}")
    if do_spb:
        safe_print(f"  邮管局   — 总计 {grand_spb:>6} 条记录")
        if spb_empty:
            safe_print(f"    无数据省份: {', '.join(spb_empty)}")
    safe_print(f"  耗时     : {elapsed:.0f} 秒")
    safe_print(f"  输出目录 : {os.path.abspath(output_dir)}")
    safe_print("=" * 60)


if __name__ == "__main__":
    main()
