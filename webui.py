#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
邮政网点爬取结果 图形化检索 Web 界面
====================================
基于 Flask + Bootstrap 5 的单文件 Web 应用。

功能:
  - 启动时从 base/ 文件夹导入爬取结果 (post{缩写}+base.csv / spb{缩写}+base.csv)
    到本地 SQLite，全程不做网络连接。
  - 检索页面: 省 / 市 / 县 三级级联筛选 + 名称模糊搜索，分页浏览。
  - 横向对比: 保留 crawler._cross_match 多阶名称匹配引擎。

用法:
  python webui.py                  # 默认 http://localhost:8092
  python webui.py --port 8080      # 自定义端口
  python webui.py --db other.db    # 自定义数据库路径
  python webui.py --base ./base    # 自定义 base 文件夹路径
"""

import sys
import os
import re
import sqlite3
import threading
import argparse
from datetime import datetime
from urllib.parse import urlencode

# 确保当前目录在 sys.path 中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify, render_template_string
from crawler import (
    PROVINCES, read_post_csv, read_spb_csv, normalize_name, _cross_match,
    _extract_status,
)

app = Flask(__name__)

# ==================== 路径与常量 ====================

_HERE = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.join(_HERE, "base")
DEFAULT_DB_PATH = os.path.join(_HERE, "post_spb_web.db")
DB_PATH = DEFAULT_DB_PATH

# ==================== 省份排序 ====================

# crawler.PROVINCES: (简称, 缩写, 区划代码)，如 ("北京", "bj", "110000")
_PROVINCE_ORDER = {name: code for name, _abbr, code in PROVINCES}

# base CSV 中的省名带行政区后缀（如"北京市"/"广东省"/"广西壮族自治区"），
# 需要先剥掉后缀再匹配简称以得到正确的区划代码排序。
_PROVINCE_SUFFIXES = (
    "维吾尔自治区", "壮族自治区", "回族自治区", "特别行政区",
    "自治区", "省", "市",
)


def _province_sort_key(name):
    name = (name or "").strip()
    for sfx in _PROVINCE_SUFFIXES:
        if name.endswith(sfx):
            core = name[:-len(sfx)]
            if core in _PROVINCE_ORDER:
                return _PROVINCE_ORDER[core]
            break
    return _PROVINCE_ORDER.get(name, "999999")


def sort_provinces(names):
    """按行政区划代码排序省份名列表（华北→东北→华东→中南→西南→西北）"""
    return sorted(set(names), key=_province_sort_key)


# ==================== 数据库辅助 ====================


def get_conn(db_path=None):
    """获取数据库连接（dict 风格行）"""
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


CREATE_POST_TABLE = """
CREATE TABLE IF NOT EXISTS post (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    province  TEXT NOT NULL DEFAULT '',
    city      TEXT DEFAULT '',
    district  TEXT DEFAULT '',
    name      TEXT NOT NULL,
    postcode  TEXT DEFAULT '',
    address   TEXT DEFAULT '',
    nor_name  TEXT DEFAULT ''
);
"""

CREATE_SPB_TABLE = """
CREATE TABLE IF NOT EXISTS spb (
    uuid        INTEGER PRIMARY KEY,
    province    TEXT NOT NULL DEFAULT '',
    city        TEXT DEFAULT '',
    district    TEXT DEFAULT '',
    name        TEXT NOT NULL,
    services    TEXT DEFAULT '',
    detail_link TEXT DEFAULT '',
    nor_name    TEXT DEFAULT ''
);
"""

CREATE_META_TABLE = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_post_province ON post(province);",
    "CREATE INDEX IF NOT EXISTS idx_post_city ON post(city);",
    "CREATE INDEX IF NOT EXISTS idx_post_district ON post(district);",
    "CREATE INDEX IF NOT EXISTS idx_spb_province ON spb(province);",
    "CREATE INDEX IF NOT EXISTS idx_spb_city ON spb(city);",
    "CREATE INDEX IF NOT EXISTS idx_spb_district ON spb(district);",
]


def init_schema(conn):
    conn.execute(CREATE_POST_TABLE)
    conn.execute(CREATE_SPB_TABLE)
    conn.execute(CREATE_META_TABLE)
    for idx in CREATE_INDEXES:
        conn.execute(idx)
    conn.commit()


def _extract_uuid(link):
    """从 SPB 详情链接中提取 uuid，如 ...?uuid=602 → 602"""
    m = re.search(r"uuid=(\d+)", link or "")
    return int(m.group(1)) if m else None


def import_base_to_db(db_path=None, base_dir=None, progress=None):
    """
    从 base 文件夹导入爬取结果 CSV 到 SQLite（全量重建）。
    - post{缩写}+base.csv → post 表
    - spb{缩写}+base.csv  → spb 表
    不做任何网络连接。
    """
    base_dir = base_dir or BASE_DIR
    conn = get_conn(db_path)
    try:
        init_schema(conn)
        # 全量重建
        conn.execute("DELETE FROM post")
        conn.execute("DELETE FROM spb")

        files = os.listdir(base_dir) if os.path.isdir(base_dir) else []
        post_files = sorted(
            f for f in files if f.startswith("post") and f.endswith("+base.csv"))
        spb_files = sorted(
            f for f in files if f.startswith("spb") and f.endswith("+base.csv"))

        post_count = 0
        spb_count = 0

        for i, fn in enumerate(post_files, 1):
            if progress:
                progress(f"导入 POST {fn} ({i}/{len(post_files)})")
            for r in read_post_csv(os.path.join(base_dir, fn)):
                conn.execute(
                    "INSERT INTO post (province, city, district, name, "
                    "postcode, address, nor_name) VALUES (?,?,?,?,?,?,?)",
                    (r["province"], r.get("city", ""), r.get("district", ""),
                     r["name"], r.get("postcode", ""), r.get("address", ""),
                     normalize_name(r["name"]))
                )
                post_count += 1

        fallback_uuid = -1
        for i, fn in enumerate(spb_files, 1):
            if progress:
                progress(f"导入 SPB {fn} ({i}/{len(spb_files)})")
            for r in read_spb_csv(os.path.join(base_dir, fn)):
                uuid = _extract_uuid(r.get("detail_link", ""))
                if uuid is None:
                    uuid = fallback_uuid
                    fallback_uuid -= 1
                conn.execute(
                    "INSERT INTO spb (uuid, province, city, district, name, "
                    "services, detail_link, nor_name) VALUES (?,?,?,?,?,?,?,?)",
                    (uuid, r["province"], r.get("city", ""), r.get("district", ""),
                     r["name"], r.get("services", ""), r.get("detail_link", ""),
                     normalize_name(r["name"]))
                )
                spb_count += 1

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for key, val in (("post_count", post_count), ("spb_count", spb_count),
                         ("last_updated", now)):
            conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)",
                         (key, str(val)))
        conn.commit()

        return {
            "post_count": post_count,
            "spb_count": spb_count,
            "post_files": len(post_files),
            "spb_files": len(spb_files),
            "base_dir": base_dir,
        }
    finally:
        conn.close()


def get_meta(conn, key, default=""):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


# ==================== 后台导入状态 ====================

_import_status = {
    "running": False,
    "started_at": None,
    "progress": "",
    "result": None,
    "error": None,
}

# ==================== 模板 ====================

BASE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>邮政网点爬取结果检索</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
    <style>
        body { padding-top: 56px; background: #f5f7fa; }
        .navbar-brand { font-weight: 700; }
        .table-container { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 0; overflow: hidden; }
        .pagination { margin-bottom: 0; }
        .filter-bar { background: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .stat-number { font-size: 1.5rem; font-weight: 700; }
        .card-stat { border-left: 4px solid; }
        .card-stat.post { border-left-color: #0d6efd; }
        .card-stat.spb { border-left-color: #198754; }
    </style>
</head>
<body>

<nav class="navbar navbar-expand-lg navbar-dark bg-dark fixed-top">
    <div class="container-fluid">
        <a class="navbar-brand" href="/">
            <i class="bi bi-database"></i> 邮政网点检索
        </a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
            <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarNav">
            <ul class="navbar-nav me-auto">
                <li class="nav-item">
                    <a class="nav-link {{ 'active' if active_page == 'search' }}" href="/">
                        <i class="bi bi-search"></i> 检索
                    </a>
                </li>
                <li class="nav-item">
                    <a class="nav-link {{ 'active' if active_page == 'cross' }}" href="/cross-compare">
                        <i class="bi bi-intersect"></i> 横向对比
                    </a>
                </li>
                <li class="nav-item">
                    <a class="nav-link {{ 'active' if active_page == 'random' }}" href="/random">
                        <i class="bi bi-shuffle"></i> 随机抽取
                    </a>
                </li>
            </ul>
            <span class="navbar-text me-2" id="status-badge">
                <span class="badge bg-secondary">就绪</span>
            </span>
            <button class="btn btn-outline-warning btn-sm" onclick="triggerUpdate()" id="btn-update">
                <i class="bi bi-arrow-repeat"></i> 更新数据库
            </button>
        </div>
    </div>
</nav>

<div class="container-fluid px-4 mt-3">
    {{ content | safe }}
</div>

<footer class="text-center text-muted py-3 mt-4">
    <small>邮政网点爬取结果检索 &copy; {{ year }}</small>
</footer>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
let updatePollInterval = null;

function triggerUpdate() {
    const btn = document.getElementById('btn-update');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 启动中...';

    fetch('/api/update', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.status === 'started' || data.status === 'already_running') {
                document.getElementById('status-badge').innerHTML =
                    '<span class="badge bg-warning text-dark">更新中...</span>';
                startPolling();
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 更新数据库';
            }
        })
        .catch(() => {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 更新数据库';
        });
}

function startPolling() {
    if (updatePollInterval) clearInterval(updatePollInterval);
    updatePollInterval = setInterval(() => {
        fetch('/api/update/status')
            .then(r => r.json())
            .then(data => {
                if (!data.running) {
                    clearInterval(updatePollInterval);
                    updatePollInterval = null;
                    const btn = document.getElementById('btn-update');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 更新数据库';
                    document.getElementById('status-badge').innerHTML =
                        '<span class="badge bg-success">完成</span>';
                    location.reload();
                } else {
                    document.getElementById('status-badge').innerHTML =
                        '<span class="badge bg-warning text-dark">更新中: ' + (data.progress || '') + '</span>';
                }
            });
    }, 1000);
}

// 页面加载时检查导入状态
fetch('/api/update/status')
    .then(r => r.json())
    .then(data => {
        if (data.running) {
            document.getElementById('status-badge').innerHTML =
                '<span class="badge bg-warning text-dark">更新中: ' + (data.progress || '') + '</span>';
            const btn = document.getElementById('btn-update');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 运行中';
            startPolling();
        }
    });
</script>
</body>
</html>"""

SEARCH_HTML = """
<div class="row mb-3">
    <div class="col">
        <h4><i class="bi bi-search"></i> 网点检索</h4>
        <small class="text-muted">数据来源: base 文件夹爬取结果（本地导入，无网络连接）</small>
    </div>
</div>

<!-- 统计卡片 -->
<div class="row g-3 mb-3">
    <div class="col-md-2 col-6">
        <div class="card card-stat post h-100"><div class="card-body">
            <div class="stat-number text-primary">{{ post_count }}</div>
            <small class="text-muted">POST 记录</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card card-stat spb h-100"><div class="card-body">
            <div class="stat-number text-success">{{ spb_count }}</div>
            <small class="text-muted">SPB 记录</small>
        </div></div>
    </div>
    <div class="col-md-8">
        <div class="card h-100"><div class="card-body d-flex align-items-center">
            <small class="text-muted">
                <i class="bi bi-clock-history"></i> 最后更新: {{ last_updated or '—' }}
                &nbsp;|&nbsp; base 目录: <code>{{ base_dir }}</code>
            </small>
        </div></div>
    </div>
</div>

<!-- 来源 Tabs -->
<ul class="nav nav-pills mb-3">
    <li class="nav-item">
        <a class="nav-link {{ 'active' if src == 'post' }}" href="/?source=post">
            <i class="bi bi-building"></i> 中国邮政 (POST)
        </a>
    </li>
    <li class="nav-item">
        <a class="nav-link {{ 'active' if src == 'spb' }}" href="/?source=spb">
            <i class="bi bi-check-circle"></i> 国家邮政局备案 (SPB)
        </a>
    </li>
</ul>

<!-- 三级筛选 -->
<div class="filter-bar">
    <form method="GET" class="row g-2 align-items-end">
        <input type="hidden" name="source" value="{{ src }}">
        <div class="col-md-2">
            <label class="form-label small">省</label>
            <select name="province" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部省份</option>
                {% for p in provinces %}
                <option value="{{ p }}" {{ 'selected' if p == province }}>{{ p }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-2">
            <label class="form-label small">市</label>
            <select name="city" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部城市</option>
                {% for c in cities %}
                <option value="{{ c }}" {{ 'selected' if c == city }}>{{ c or '(空)' }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-2">
            <label class="form-label small">区/县</label>
            <select name="district" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部区县</option>
                {% for d in districts %}
                <option value="{{ d }}" {{ 'selected' if d == district }}>{{ d or '(空)' }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-3">
            <label class="form-label small">名称搜索</label>
            <input type="text" name="search" class="form-control form-control-sm"
                   value="{{ search }}" placeholder="网点名称模糊搜索...">
        </div>
        <div class="col-md-1">
            <button type="submit" class="btn btn-primary btn-sm w-100">
                <i class="bi bi-search"></i> 搜索
            </button>
        </div>
        <div class="col-md-1">
            <a href="/?source={{ src }}" class="btn btn-outline-secondary btn-sm w-100">
                <i class="bi bi-x-circle"></i> 清除
            </a>
        </div>
    </form>
</div>

<!-- 表格 -->
<div class="table-container">
    <div class="p-3 border-bottom">
        <small class="text-muted">
            当前筛选: 省「{{ province or '全部' }}」 / 市「{{ city or '全部' }}」 /
            区县「{{ district or '全部' }}」 / 名称「{{ search or '—' }}」
            &nbsp;|&nbsp; 共 <strong>{{ data.total }}</strong> 条
        </small>
    </div>
    <div class="table-responsive">
        <table class="table table-striped table-hover mb-0">
            <thead class="table-dark">
                <tr>
                    <th>省</th>
                    <th>市</th>
                    <th>区/县</th>
                    {% if src == 'post' %}
                    <th>网点名称</th>
                    <th>邮编</th>
                    <th>地址</th>
                    {% else %}
                    <th>场所名称</th>
                    <th>开办业务</th>
                    <th>详情链接</th>
                    {% endif %}
                </tr>
            </thead>
            <tbody>
                {% for r in data.rows %}
                <tr>
                    <td>{{ r.province }}</td>
                    <td>{{ r.city }}</td>
                    <td>{{ r.district }}</td>
                    {% if src == 'post' %}
                    <td><strong>{{ r.name }}</strong></td>
                    <td><code>{{ r.postcode }}</code></td>
                    <td class="small text-muted">{{ r.address }}</td>
                    {% else %}
                    <td><strong>{{ r.name }}</strong></td>
                    <td class="small">{{ r.services }}</td>
                    <td>
                        {% if r.detail_link %}
                        <a href="{{ r.detail_link }}" target="_blank" class="small">
                            查看 <i class="bi bi-box-arrow-up-right"></i>
                        </a>
                        {% else %}
                        <span class="text-muted">—</span>
                        {% endif %}
                    </td>
                    {% endif %}
                </tr>
                {% endfor %}
                {% if not data.rows %}
                <tr><td colspan="6" class="text-center text-muted py-4">无匹配记录</td></tr>
                {% endif %}
            </tbody>
        </table>
    </div>

    <!-- 分页 -->
    <div class="d-flex justify-content-between align-items-center p-2 bg-light border-top">
        <small class="text-muted">共 {{ data.total }} 条，第 {{ data.page }}/{{ data.total_pages }} 页</small>
        <nav>
            <ul class="pagination pagination-sm mb-0">
                <li class="page-item {{ 'disabled' if data.page <= 1 }}">
                    <a class="page-link" href="{{ build_url(page=1) }}">首页</a>
                </li>
                <li class="page-item {{ 'disabled' if data.page <= 1 }}">
                    <a class="page-link" href="{{ build_url(page=data.page-1) }}">上一页</a>
                </li>
                {% for p in range([1, data.page-2]|max, [data.total_pages, data.page+2]|min + 1) %}
                <li class="page-item {{ 'active' if p == data.page }}">
                    <a class="page-link" href="{{ build_url(page=p) }}">{{ p }}</a>
                </li>
                {% endfor %}
                <li class="page-item {{ 'disabled' if data.page >= data.total_pages }}">
                    <a class="page-link" href="{{ build_url(page=data.page+1) }}">下一页</a>
                </li>
                <li class="page-item {{ 'disabled' if data.page >= data.total_pages }}">
                    <a class="page-link" href="{{ build_url(page=data.total_pages) }}">末页</a>
                </li>
            </ul>
        </nav>
    </div>
</div>
"""

CROSS_COMPARE_HTML = """
<style>
.match-section { margin-bottom: 1.5rem; }
.match-header { cursor: pointer; padding: 0.75rem 1rem; background: #f8f9fa; border-radius: 6px; }
.match-header:hover { background: #e9ecef; }
.match-table { font-size: 0.875rem; }
.match-table td { vertical-align: middle; }
.cross-badge-matched { background: #28a745; }
.cross-badge-norm { background: #6f42c1; }
.cross-badge-suspect { background: #fd7e14; }
.cross-badge-fuzzy { background: #dc3545; }
.cross-badge-post { background: #0d6efd; }
.cross-badge-spb { background: #198754; }
.cross-badge-cross { background: #6c757d; }
.cross-badge-special { background: #e83e8c; }
.cross-badge-suspend { background: #ffc107; color: #333; }
</style>

<div class="row mb-3">
    <div class="col">
        <h4><i class="bi bi-intersect"></i> 横向对比 — POST vs SPB 多阶名称匹配</h4>
        <small class="text-muted">基于 crawler.py 的 _cross_match 引擎：精确 → 归一化 → 疑似 → 跨区县</small>
    </div>
</div>

<!-- 省份选择 -->
<div class="filter-bar">
    <form method="GET" class="row g-2 align-items-end">
        <div class="col-md-3">
            <label class="form-label small">选择省份</label>
            <select name="province" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">— 请选择 —</option>
                {% for p in available %}
                <option value="{{ p }}" {{ 'selected' if p == current_province }}>{{ p }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-2">
            <div class="form-check form-switch mt-4">
                <input class="form-check-input" type="checkbox" name="fuzzy" value="1"
                       {{ 'checked' if fuzzy }} onchange="this.form.submit()">
                <label class="form-check-label small">模糊匹配</label>
            </div>
        </div>
        {% if fuzzy %}
        <div class="col-md-2">
            <label class="form-label small">阈值</label>
            <input type="number" name="threshold" class="form-control form-control-sm"
                   value="{{ threshold }}" step="0.05" min="0" max="1" onchange="this.form.submit()">
        </div>
        {% endif %}
    </form>
</div>

{% if not current_province %}
<div class="text-center text-muted py-5">
    <i class="bi bi-arrow-up" style="font-size:3rem;"></i>
    <p class="mt-3">请先从上方下拉菜单选择一个省份开始横向对比</p>
    <p class="small">（需 base 文件夹中同时存在该省的 POST 和 SPB 数据）</p>
</div>
{% elif not result %}
<div class="text-center text-muted py-5">
    <p>该省份无数据或匹配失败</p>
</div>
{% else %}
{% set n_post = result.matched_exact|length + result.matched_normalized|length + result.matched_suspected|length + result.matched_fuzzy|length + suspended_rows|length + result.post_only|length %}
{% set n_spb = result.matched_exact|length + result.matched_normalized|length + result.matched_suspected|length + result.matched_fuzzy|length + suspended_rows|length + result.spb_only|length %}
{% set n_match = result.matched_exact|length + result.matched_normalized|length + result.matched_suspected|length + result.matched_fuzzy|length + suspended_rows|length %}

<!-- 汇总卡片 -->
<div class="row g-3 mb-4">
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number text-primary">{{ n_post }}</div>
            <small class="text-muted">POST 记录</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number text-success">{{ n_spb }}</div>
            <small class="text-muted">SPB 记录</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number" style="color:#28a745;">{{ n_match }}</div>
            <small class="text-muted">匹配总计</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number" style="color:#28a745;">{{ (n_match / n_post * 100)|round(1) if n_post else 0 }}%</div>
            <small class="text-muted">匹配率</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number text-warning">{{ result.post_only|length }}</div>
            <small class="text-muted">仅 POST</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number text-info">{{ result.spb_only|length }}</div>
            <small class="text-muted">仅 SPB</small>
        </div></div>
    </div>
    <div class="col-md-2 col-6">
        <div class="card text-center h-100"><div class="card-body">
            <div class="stat-number" style="color:#e8590c;">{{ suspended_rows|length }}</div>
            <small class="text-muted">暂停/停业</small>
        </div></div>
    </div>
</div>

{% if result.matched_exact %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-matched">精确匹配</span>
        <strong>{{ result.matched_exact|length }} 对</strong>
        <small class="text-muted ms-2">双方原始名称完全一致</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive d-none mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>POST 名称</th><th>SPB 名称</th><th>区县</th><th>邮编</th></tr></thead>
            <tbody>
            {% for post, spb in result.matched_exact[:100] %}
            <tr><td>{{ post.name }}</td><td>{{ spb.name }}</td><td>{{ post.district }}</td><td><code>{{ post.postcode }}</code></td></tr>
            {% endfor %}
            {% if result.matched_exact|length > 100 %}
            <tr><td colspan="4" class="text-muted text-center">... 还有 {{ result.matched_exact|length - 100 }} 对，已折叠</td></tr>
            {% endif %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if result.matched_normalized %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-norm">归一化匹配</span>
        <strong>{{ result.matched_normalized|length }} 对</strong>
        <small class="text-muted ms-2">剥离前缀后缀后名称一致</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>POST 名称</th><th>→</th><th>SPB 名称</th><th>区县</th><th>邮编</th></tr></thead>
            <tbody>
            {% for post, spb in result.matched_normalized[:200] %}
            <tr>
                <td class="text-primary small">{{ post.name }}</td>
                <td class="text-muted">→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td>
                <td><code>{{ post.postcode }}</code></td>
            </tr>
            {% endfor %}
            {% if result.matched_normalized|length > 200 %}
            <tr><td colspan="5" class="text-muted text-center">... 还有 {{ result.matched_normalized|length - 200 }} 对，已折叠</td></tr>
            {% endif %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if suspended_rows %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-suspend">暂停/停业</span>
        <strong>{{ suspended_rows|length }} 对</strong>
        <small class="text-muted ms-2">名称可匹配，但网点名称含暂停/停业/装修等状态标记，单独展示</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>状态</th><th>POST 名称</th><th>→</th><th>SPB 名称</th><th>区县</th><th>邮编</th></tr></thead>
            <tbody>
            {% for post, spb, status in suspended_rows %}
            <tr>
                <td><span class="badge cross-badge-suspend">{{ status }}</span></td>
                <td class="text-primary small">{{ post.name }}</td>
                <td class="text-muted">→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td>
                <td><code>{{ post.postcode }}</code></td>
            </tr>
            {% endfor %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if result.matched_suspected %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-suspect">疑似匹配</span>
        <strong>{{ result.matched_suspected|length }} 对</strong>
        <small class="text-muted ms-2">存在公共中文字串需人工确认</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>公共字串</th><th>POST 名称</th><th>→</th><th>SPB 名称</th><th>区县</th><th>邮编</th></tr></thead>
            <tbody>
            {% for item in result.matched_suspected %}
            {% set post = item[0] %}{% set spb = item[1] %}
            <tr>
                <td><code>{{ item[2] }}</code></td>
                <td class="text-primary small">{{ post.name }}</td>
                <td class="text-muted">→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td>
                <td><code>{{ post.postcode }}</code></td>
            </tr>
            {% endfor %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if result.cross_district_notes %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-cross">跨区县匹配</span>
        <strong>{{ result.cross_district_notes|length }} 对</strong>
        <small class="text-muted ms-2">归一化匹配但区县不同，不计入匹配仅供参考</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>POST 名称</th><th>→</th><th>SPB 名称</th><th>备注</th><th>邮编</th></tr></thead>
            <tbody>
            {% for post, spb, note in result.cross_district_notes %}
            <tr>
                <td class="text-primary small">{{ post.name }}</td>
                <td class="text-muted">→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td class="small text-muted">{{ note }}</td>
                <td><code>{{ post.postcode }}</code></td>
            </tr>
            {% endfor %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if result.post_only or result.spb_only %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-post">仅 POST</span> {{ result.post_only|length }} 条 &nbsp;
        <span class="badge cross-badge-spb">仅 SPB</span> {{ result.spb_only|length }} 条
        <small class="text-muted ms-2">按区县对齐，左右对照</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>区县</th><th>POST 名称</th><th>SPB 名称</th><th>POST邮编</th></tr></thead>
            <tbody>
            {% for row in unmatched_rows %}
                <tr>
                    <td>{{ row.district }}</td>
                    <td class="text-primary small">{{ row.post_name or '(无)' }}</td>
                    <td class="text-success small">{{ row.spb_name or '(无)' }}</td>
                    <td><code>{{ row.postcode }}</code></td>
                </tr>
            {% endfor %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}

{% if result.special_zone %}
{% set sz = result.special_zone %}
{% set sz_total = sz.normalized|length + sz.suspected|length + sz.fuzzy|length + sz.cross_district|length %}
{% if sz_total > 0 %}
<div class="match-section">
    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('d-none')">
        <span class="badge cross-badge-special">特殊区划</span>
        <strong>{{ sz_total }} 条</strong>
        <small class="text-muted ms-2">新区/开发区/管理区 — 需人工确认</small>
        <i class="bi bi-chevron-down float-end"></i>
    </div>
    <div class="table-responsive mt-2">
        <table class="table table-sm match-table">
            <thead><tr><th>类型</th><th>POST 名称</th><th>→</th><th>SPB 名称</th><th>POST区县</th><th>SPB区县</th><th>邮编</th></tr></thead>
            <tbody>
            {% for post, spb in sz.normalized %}
            <tr><td><span class="badge cross-badge-norm">归一化</span></td>
                <td class="text-primary small">{{ post.name }}</td>
                <td>→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td><td>{{ spb.district }}</td><td><code>{{ post.postcode }}</code></td></tr>
            {% endfor %}
            {% for item in sz.suspected %}
            {% set post = item[0] %}{% set spb = item[1] %}
            <tr><td><span class="badge cross-badge-suspect">疑似</span></td>
                <td class="text-primary small">{{ post.name }}</td>
                <td>→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td><td>{{ spb.district }}</td><td><code>{{ post.postcode }}</code></td></tr>
            {% endfor %}
            {% for post, spb, note in sz.cross_district %}
            <tr><td><span class="badge cross-badge-cross">跨区县</span></td>
                <td class="text-primary small">{{ post.name }}</td>
                <td>→</td>
                <td class="text-success small">{{ spb.name }}</td>
                <td>{{ post.district }}</td><td>{{ spb.district }}</td><td><code>{{ post.postcode }}</code></td></tr>
            {% endfor %}
            </tbody>
        </table>
    </div>
</div>
{% endif %}
{% endif %}

{% endif %}
"""

RANDOM_HTML = """
<style>
@keyframes drawPop {
    0% { opacity: 0; transform: translateY(10px) scale(0.97); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
}
.draw-pop { animation: drawPop 0.35s ease-out; }
.draw-result .card-title { font-weight: 700; }
</style>

<div class="row mb-3">
    <div class="col">
        <h4><i class="bi bi-shuffle"></i> 随机抽取</h4>
        <small class="text-muted">从选定省 / 市 / 县范围内随机抽取一个网点</small>
    </div>
</div>

<!-- 来源 Tabs -->
<ul class="nav nav-pills mb-3">
    <li class="nav-item">
        <a class="nav-link {{ 'active' if src == 'post' }}" href="/random?source=post">
            <i class="bi bi-building"></i> 中国邮政 (POST)
        </a>
    </li>
    <li class="nav-item">
        <a class="nav-link {{ 'active' if src == 'spb' }}" href="/random?source=spb">
            <i class="bi bi-check-circle"></i> 国家邮政局备案 (SPB)
        </a>
    </li>
</ul>

<!-- 筛选 + 抽取 -->
<div class="filter-bar">
    <form method="GET" action="/random" id="random-form" class="row g-2 align-items-end">
        <input type="hidden" name="source" value="{{ src }}">
        <div class="col-md-3">
            <label class="form-label small">省</label>
            <select name="province" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部省份</option>
                {% for p in provinces %}
                <option value="{{ p }}" {{ 'selected' if p == province }}>{{ p }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-3">
            <label class="form-label small">市</label>
            <select name="city" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部城市</option>
                {% for c in cities %}
                <option value="{{ c }}" {{ 'selected' if c == city }}>{{ c or '(空)' }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-3">
            <label class="form-label small">区/县</label>
            <select name="district" class="form-select form-select-sm" onchange="this.form.submit()">
                <option value="">全部区县</option>
                {% for d in districts %}
                <option value="{{ d }}" {{ 'selected' if d == district }}>{{ d or '(空)' }}</option>
                {% endfor %}
            </select>
        </div>
        <div class="col-md-3">
            <button type="button" id="btn-draw" class="btn btn-primary w-100" onclick="draw()">
                <i class="bi bi-shuffle"></i> 抽取
            </button>
        </div>
    </form>
    <div class="mt-2 small text-muted">
        当前范围: 省「{{ province or '全部' }}」 / 市「{{ city or '全部' }}」 /
        区县「{{ district or '全部' }}」
        &nbsp;|&nbsp; 共 <strong id="range-count">{{ total }}</strong> 条
    </div>
</div>

<!-- 结果 -->
<div id="result-area" class="draw-result">
    <div class="text-center text-muted py-5">
        <i class="bi bi-shuffle" style="font-size:3rem;"></i>
        <p class="mt-3">设置筛选条件后，点击「抽取」按钮随机抽取一个网点</p>
    </div>
</div>

<script>
function draw() {
    const btn = document.getElementById('btn-draw');
    const form = document.getElementById('random-form');
    const resultArea = document.getElementById('result-area');
    const countEl = document.getElementById('range-count');

    const fd = new FormData(form);
    const qs = new URLSearchParams(fd).toString();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 抽取中...';
    resultArea.innerHTML = '';

    fetch('/api/random?' + qs)
        .then(r => r.json())
        .then(data => {
            if (countEl) countEl.textContent = data.total;
            resultArea.innerHTML = data.html;
        })
        .catch(err => {
            resultArea.innerHTML =
                '<div class="alert alert-danger">抽取失败: ' + err + '</div>';
        })
        .finally(() => {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-shuffle"></i> 抽取';
        });
}
</script>
"""

RANDOM_RESULT_HTML = """
<div class="card shadow-sm draw-pop">
    <div class="card-header d-flex justify-content-between align-items-center">
        <span><i class="bi bi-shuffle"></i> 抽取结果</span>
        <span class="badge {{ 'bg-primary' if src == 'post' else 'bg-success' }}">
            {{ '中国邮政 POST' if src == 'post' else '国家邮政局 SPB' }}
        </span>
    </div>
    <div class="card-body">
        <h5 class="card-title">{{ r.name }}</h5>
        <p class="text-muted mb-2">
            <i class="bi bi-geo-alt"></i>
            {{ r.province }} {{ r.city }} {{ r.district }}
        </p>
        {% if src == 'post' %}
        <p class="mb-1"><span class="text-muted small">邮编：</span><code>{{ r.postcode or '—' }}</code></p>
        <p class="mb-0"><span class="text-muted small">地址：</span>{{ r.address or '—' }}</p>
        {% else %}
        <p class="mb-1"><span class="text-muted small">开办业务：</span>{{ r.services or '—' }}</p>
        {% if r.detail_link %}
        <p class="mb-0">
            <a href="{{ r.detail_link }}" target="_blank" rel="noopener">
                查看详情 <i class="bi bi-box-arrow-up-right"></i>
            </a>
        </p>
        {% endif %}
        {% endif %}
    </div>
</div>
"""

# ==================== 路由 ====================


@app.route("/")
def search_page():
    """检索页面：省 / 市 / 县 三级筛选 + 名称搜索"""
    source = request.args.get("source", "post")
    if source not in ("post", "spb"):
        source = "post"
    table = source

    province = request.args.get("province", "")
    city = request.args.get("city", "")
    district = request.args.get("district", "")
    search = request.args.get("search", "")
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 50, type=int)

    conn = get_conn()
    try:
        # 三级选项列表（级联）
        provinces = sort_provinces(
            [r["province"] for r in conn.execute(
                f"SELECT DISTINCT province FROM {table}")])

        cities = [r["city"] for r in conn.execute(
            f"SELECT DISTINCT city FROM {table} "
            f"{'WHERE province=?' if province else ''} ORDER BY city",
            [province] if province else [])]

        _d_where, _d_params = [], []
        if province:
            _d_where.append("province=?")
            _d_params.append(province)
        if city:
            _d_where.append("city=?")
            _d_params.append(city)
        districts = [r["district"] for r in conn.execute(
            f"SELECT DISTINCT district FROM {table} "
            f"{'WHERE ' + ' AND '.join(_d_where) if _d_where else ''} ORDER BY district",
            _d_params)]

        # 结果查询
        where_parts, params = [], []
        if province:
            where_parts.append("province=?")
            params.append(province)
        if city:
            where_parts.append("city=?")
            params.append(city)
        if district:
            where_parts.append("district=?")
            params.append(district)
        if search:
            where_parts.append("name LIKE ?")
            params.append(f"%{search}%")
        where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

        total = conn.execute(
            f"SELECT COUNT(*) c FROM {table}{where_clause}", params).fetchone()["c"]
        offset = (page - 1) * per_page
        rows = [dict(r) for r in conn.execute(
            f"SELECT * FROM {table}{where_clause} "
            f"ORDER BY province, city, district, name LIMIT ? OFFSET ?",
            params + [per_page, offset])]
        total_pages = max(1, (total + per_page - 1) // per_page)

        post_count = conn.execute("SELECT COUNT(*) c FROM post").fetchone()["c"]
        spb_count = conn.execute("SELECT COUNT(*) c FROM spb").fetchone()["c"]
        last_updated = get_meta(conn, "last_updated")
    finally:
        conn.close()

    data = {"rows": rows, "total": total, "page": page,
            "per_page": per_page, "total_pages": total_pages}

    content = render_template_string(
        SEARCH_HTML,
        src=source, province=province, city=city, district=district,
        search=search, provinces=provinces, cities=cities, districts=districts,
        data=data, post_count=post_count, spb_count=spb_count,
        last_updated=last_updated, base_dir=BASE_DIR,
        build_url=lambda **kw: request.path + "?" + urlencode(
            {k: v for k, v in {**request.args, **kw}.items() if v}))
    return render_template_string(BASE_HTML,
        active_page="search", content=content, year=datetime.now().year)


@app.route("/cross-compare")
def cross_compare_page():
    """横向对比: 同省 POST vs SPB 多阶名称匹配"""
    conn = get_conn()
    try:
        province = request.args.get("province", "")
        enable_fuzzy = request.args.get("fuzzy", "0") == "1"
        fuzzy_threshold = request.args.get("threshold", 0.8, type=float)

        # 同时存在 POST 与 SPB 数据的省份
        cur = conn.execute("""
            SELECT DISTINCT p.province FROM post p
            INTERSECT
            SELECT DISTINCT s.province FROM spb s
        """)
        available = sort_provinces([r["province"] for r in cur.fetchall()])

        result = None
        unmatched_rows = []
        suspended_rows = []
        if province and province in available:
            cur = conn.execute(
                "SELECT id, province, city, district, name, postcode, address "
                "FROM post WHERE province=?",
                (province,))
            post_records = [dict(r) for r in cur.fetchall()]

            cur = conn.execute(
                "SELECT uuid, province, city, district, name, services "
                "FROM spb WHERE province=?",
                (province,))
            spb_records = [dict(r) for r in cur.fetchall()]
            for r in spb_records:
                r["detail_link"] = (
                    "https://zwfw.spb.gov.cn/gjj/pfyycsml/pfyycsmlDetail"
                    f"?uuid={r.get('uuid', '')}")

            result = _cross_match(
                post_records, spb_records,
                enable_fuzzy=enable_fuzzy, fuzzy_threshold=fuzzy_threshold)

            # 参考 crawler 智能对比模块：将名称含"暂停/停业/装修"等状态标记的
            # 匹配对从"归一化匹配"中单独抽出展示（这类网点虽名称匹配但已暂停营业）。
            normal_normalized = []
            for post, spb in result["matched_normalized"]:
                _, pstat = _extract_status(post["name"])
                _, sstat = _extract_status(spb["name"])
                statuses = pstat + sstat
                if statuses:
                    suspended_rows.append((post, spb, "、".join(statuses)))
                else:
                    normal_normalized.append((post, spb))
            result["matched_normalized"] = normal_normalized

            # 预计算"按区县对齐"的不匹配条目（避免 Jinja2 模板中的 setdefault 不可靠问题）
            unmatched_rows = []
            post_by_dist = {}
            for r in result["post_only"]:
                key = r.get("district", "") or r.get("city", "")
                post_by_dist.setdefault(key, []).append(r)
            spb_by_dist = {}
            for r in result["spb_only"]:
                key = r.get("district", "") or r.get("city", "")
                spb_by_dist.setdefault(key, []).append(r)
            all_dists = sorted(set(list(post_by_dist.keys()) + list(spb_by_dist.keys())))
            for dist in all_dists:
                plist = post_by_dist.get(dist, [])
                slist = spb_by_dist.get(dist, [])
                for i in range(max(len(plist), len(slist))):
                    unmatched_rows.append({
                        "district": dist,
                        "post_name": plist[i]["name"] if i < len(plist) else "",
                        "spb_name": slist[i]["name"] if i < len(slist) else "",
                        "postcode": plist[i].get("postcode", "") if i < len(plist) else "",
                    })
    finally:
        conn.close()

    content = render_template_string(
        CROSS_COMPARE_HTML,
        available=available, current_province=province,
        fuzzy=enable_fuzzy, threshold=fuzzy_threshold,
        result=result, unmatched_rows=unmatched_rows,
        suspended_rows=suspended_rows,
        build_url=lambda **kw: request.path + "?" + urlencode(
            {k: v for k, v in {**request.args, **kw}.items() if v}))
    return render_template_string(BASE_HTML,
        active_page="cross", content=content, year=datetime.now().year)


@app.route("/random")
def random_page():
    """随机抽取页面：省 / 市 / 县 三级筛选 + 一键抽取"""
    source = request.args.get("source", "post")
    if source not in ("post", "spb"):
        source = "post"
    table = source

    province = request.args.get("province", "")
    city = request.args.get("city", "")
    district = request.args.get("district", "")

    conn = get_conn()
    try:
        # 三级选项列表（级联）
        provinces = sort_provinces(
            [r["province"] for r in conn.execute(
                f"SELECT DISTINCT province FROM {table}")])

        cities = [r["city"] for r in conn.execute(
            f"SELECT DISTINCT city FROM {table} "
            f"{'WHERE province=?' if province else ''} ORDER BY city",
            [province] if province else [])]

        _d_where, _d_params = [], []
        if province:
            _d_where.append("province=?")
            _d_params.append(province)
        if city:
            _d_where.append("city=?")
            _d_params.append(city)
        districts = [r["district"] for r in conn.execute(
            f"SELECT DISTINCT district FROM {table} "
            f"{'WHERE ' + ' AND '.join(_d_where) if _d_where else ''} ORDER BY district",
            _d_params)]

        # 当前筛选范围总数
        where_parts, params = [], []
        if province:
            where_parts.append("province=?")
            params.append(province)
        if city:
            where_parts.append("city=?")
            params.append(city)
        if district:
            where_parts.append("district=?")
            params.append(district)
        where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
        total = conn.execute(
            f"SELECT COUNT(*) c FROM {table}{where_clause}", params).fetchone()["c"]
    finally:
        conn.close()

    content = render_template_string(
        RANDOM_HTML,
        src=source, province=province, city=city, district=district,
        provinces=provinces, cities=cities, districts=districts, total=total)
    return render_template_string(BASE_HTML,
        active_page="random", content=content, year=datetime.now().year)


@app.route("/api/random")
def api_random():
    """在选定范围内随机抽取一条记录（返回预渲染 HTML）"""
    source = request.args.get("source", "post")
    if source not in ("post", "spb"):
        source = "post"
    table = source

    province = request.args.get("province", "")
    city = request.args.get("city", "")
    district = request.args.get("district", "")

    where_parts, params = [], []
    if province:
        where_parts.append("province=?")
        params.append(province)
    if city:
        where_parts.append("city=?")
        params.append(city)
    if district:
        where_parts.append("district=?")
        params.append(district)
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    conn = get_conn()
    try:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM {table}{where_clause}", params).fetchone()["c"]
        row = conn.execute(
            f"SELECT * FROM {table}{where_clause} ORDER BY RANDOM() LIMIT 1",
            params).fetchone()
    finally:
        conn.close()

    if row is None:
        return jsonify({"ok": False, "total": total,
                        "html": "<div class='alert alert-warning'>范围内无记录，请调整筛选条件</div>"})

    rec = dict(row)
    html = render_template_string(RANDOM_RESULT_HTML, r=rec, src=source)
    return jsonify({"ok": True, "total": total, "html": html})


# ==================== API 路由 ====================


@app.route("/api/update", methods=["POST"])
def api_update():
    """触发从 base 文件夹重新导入数据库"""
    global _import_status
    if _import_status["running"]:
        return jsonify({"status": "already_running",
                        "started_at": _import_status["started_at"]})

    def run_import():
        global _import_status
        try:
            _import_status["progress"] = "正在从 base 文件夹导入..."
            result = import_base_to_db(
                DB_PATH, BASE_DIR,
                progress=lambda msg: _import_status.update(progress=msg))
            _import_status["result"] = result
            _import_status["progress"] = (
                f"完成: POST {result['post_count']} 条 / SPB {result['spb_count']} 条")
        except Exception as e:
            _import_status["error"] = str(e)
            _import_status["progress"] = f"错误: {e}"
        finally:
            _import_status["running"] = False

    _import_status = {
        "running": True,
        "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "progress": "启动中...",
        "result": None,
        "error": None,
    }
    threading.Thread(target=run_import, daemon=True).start()
    return jsonify({"status": "started",
                    "started_at": _import_status["started_at"]})


@app.route("/api/update/status")
def api_update_status():
    """查询导入任务状态"""
    return jsonify(_import_status)


# ==================== 主入口 ====================


def main():
    global DB_PATH, BASE_DIR

    parser = argparse.ArgumentParser(description="邮政网点爬取结果检索 Web 界面")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址 (默认 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8092, help="监听端口 (默认 8092)")
    parser.add_argument("--base", default=BASE_DIR, help=f"base 文件夹路径 (默认: {BASE_DIR})")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help=f"数据库路径 (默认: {DEFAULT_DB_PATH})")
    parser.add_argument("--debug", action="store_true", help="开启 Flask 调试模式")

    args = parser.parse_args()

    DB_PATH = args.db
    BASE_DIR = args.base

    print("=" * 55)
    print("  邮政网点爬取结果 检索 Web 界面")
    print("=" * 55)
    print(f"  base 文件夹: {BASE_DIR}")
    print(f"  数据库: {DB_PATH}")

    # 启动时从 base 文件夹导入（本地，无网络连接）
    print("  正在从 base 文件夹导入数据库...")
    try:
        result = import_base_to_db(DB_PATH, BASE_DIR)
        print(f"  导入完成: POST {result['post_count']} 条 "
              f"({result['post_files']} 文件) / "
              f"SPB {result['spb_count']} 条 ({result['spb_files']} 文件)")
    except Exception as e:
        print(f"  [警告] 导入失败: {e}")

    print(f"  访问地址: http://{args.host}:{args.port}")
    print(f"  调试模式: {'开启' if args.debug else '关闭'}")
    print("=" * 55)
    print()

    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
