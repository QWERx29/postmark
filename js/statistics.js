/**
 * 统计页 — 多图表数据看板
 * ==========================
 * 依赖: echarts (index.html 本地加载)
 *       RecordStore / MeterStore / MailStore / ReturnStore / PostmarkData
 *
 * 页面入口: 侧边栏「统计」(#btn-show-statistics)
 * 页面容器: #statistics-page
 * 由 app.js 在进入 / 离开页面时调用 show() / hide()，数据变化时调用 refresh()。
 *
 * 图表使用 ECharts 5，全部按需初始化：只有进入页面后才创建实例，
 * 避免隐藏状态下容器宽高为 0 导致图表尺寸错误。
 * 图表之外，页面下半部分用区县 / 戳号 / 月度 / 网点四张表细化上海市数据。
 */

const StatisticsPage = (function () {
  'use strict';

  const charts = {};
  let visible = false;
  let lastData = null;

  const PALETTE = [
    '#00991A', '#66bb6a', '#26a69a', '#42a5f5',
    '#ffa726', '#ab47bc', '#ef5350', '#8d6e63',
  ];

  const RECORD_STATUS = [
    { key: 'open',      label: '营业',     color: '#00991A' },
    { key: 'themed',    label: '主题邮局', color: '#26a69a' },
    { key: 'temporary', label: '临时邮局', color: '#ffa726' },
    { key: 'closed',    label: '已撤销',   color: '#b0bec5' },
    { key: 'other',     label: '其他',     color: '#8d6e63' },
  ];
  const RECORD_STATUS_KEYS = new Set(RECORD_STATUS.map(s => s.key));

  const MAIL_STATUS = [
    { key: 'pending',   label: '待发', color: '#ffa726' },
    { key: 'transit',   label: '在途', color: '#42a5f5' },
    { key: 'delivered', label: '妥收', color: '#00991A' },
  ];

  /** 国际退信：按已填写的最远节点归入一个阶段，四段互斥 */
  const RETURN_STAGES = [
    { key: 'sent',     label: '发出', color: '#ffa726' },
    { key: 'arrived',  label: '到达', color: '#42a5f5' },
    { key: 'returned', label: '返回', color: '#ab47bc' },
    { key: 'received', label: '收到', color: '#00991A' },
  ];

  // ============================================================
  // 基础工具
  // ============================================================
  function $(id) {
    return document.getElementById(id);
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fmtNum(value) {
    const n = Number(value);
    if (!isFinite(n)) return '0';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function truncate(text, max) {
    const s = clean(text);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + '…';
  }

  /** 图表里用短省名：内蒙古自治区 → 内蒙古，北京市 → 北京 */
  function shortProvince(name) {
    const s = clean(name);
    if (!s || s === '未填写') return s;
    return s
      .replace(/壮族自治区$/, '')
      .replace(/回族自治区$/, '')
      .replace(/维吾尔自治区$/, '')
      .replace(/自治区$/, '')
      .replace(/特别行政区$/, '')
      .replace(/[省市]$/, '');
  }

  /**
   * 解析本应用里出现过的日期写法：
   *   日戳 / 机戳：YYYYMMDDHH、YYYY.MM.DD.HH、YYYY-MM-DD HH
   *   邮件 / 退信：YYYY-MM-DD
   * 无法识别时返回 null，不把脏数据算进时间序列。
   */
  function parseDate(value) {
    const s = clean(value);
    if (!s) return null;

    let y;
    let m;
    let d;
    let h = 0;
    let match = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?$/);

    if (match) {
      y = Number(match[1]);
      m = Number(match[2]);
      d = Number(match[3]);
      h = match[4] ? Number(match[4]) : 0;
    } else {
      match = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[.\- T](\d{1,2}))?/);
      if (!match) return null;
      y = Number(match[1]);
      m = Number(match[2]);
      d = Number(match[3]);
      h = match[4] ? Number(match[4]) : 0;
    }

    if (m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23) return null;

    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      return null;
    }

    return {
      y, m, d, h,
      dateKey: `${y}-${pad2(m)}-${pad2(d)}`,
      monthKey: `${y}-${pad2(m)}`,
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /** 一条记录里的戳号：去空、去重；没有任何有效戳号时返回空数组 */
  function getRecordStamps(record) {
    const raw = record && record.stampNumbers;
    const list = Array.isArray(raw) ? raw : (clean(raw) ? [raw] : []);
    return Array.from(new Set(list.map(clean).filter(Boolean)));
  }

  /** 国际退信当前阶段：取已填写的最远节点 */
  function returnStage(record) {
    if (parseDate(record && record.recoverDate)) return 'received';
    if (parseDate(record && record.returnDate)) return 'returned';
    if (parseDate(record && record.arriveDate)) return 'arrived';
    return 'sent';
  }

  function recordStatusKey(record) {
    return RECORD_STATUS_KEYS.has(record && record.status) ? record.status : 'other';
  }

  function recordStatusLabel(record) {
    const key = recordStatusKey(record);
    const item = RECORD_STATUS.find(s => s.key === key);
    return item ? item.label : '其他';
  }

  /** 日戳日期显示成 YYYY-MM-DD，无法解析时返回空串 */
  function dateOnly(value) {
    const dt = parseDate(value);
    return dt ? dt.dateKey : '';
  }

  function tableEmptyRow(colspan, text) {
    return `<tr><td colspan="${colspan}" class="stat-table-empty">${escapeHtml(text)}</td></tr>`;
  }

  /** 从最早的月份补到最晚的月份；超过 maxMonths 时只保留最近一段 */
  function buildMonthRange(keys, maxMonths) {
    if (!keys.length) return [];
    const sorted = keys.slice().sort();
    const first = sorted[0].split('-').map(Number);
    const last = sorted[sorted.length - 1].split('-').map(Number);

    let y = first[0];
    let m = first[1];
    const endY = last[0];
    const endM = last[1];
    const out = [];

    while (y < endY || (y === endY && m <= endM)) {
      out.push(`${y}-${pad2(m)}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }

    return out.length > maxMonths ? out.slice(out.length - maxMonths) : out;
  }

  function gradient(x1, y1, x2, y2, from, to) {
    if (typeof echarts === 'undefined' || !echarts.graphic) return to;
    return new echarts.graphic.LinearGradient(x1, y1, x2, y2, [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ]);
  }

  function emptyOption(text) {
    return {
      title: {
        text,
        left: 'center',
        top: 'middle',
        textStyle: { color: '#b3b3b3', fontSize: 13, fontWeight: 'normal' },
      },
      xAxis: { show: false },
      yAxis: { show: false },
      series: [],
    };
  }

  // ============================================================
  // 读取各数据表（任一模块不可用时按空表处理）
  // ============================================================
  function getRecords() {
    try { return (typeof RecordStore !== 'undefined') ? RecordStore.getAll() : []; }
    catch (e) { return []; }
  }

  function getMeters() {
    try { return (typeof MeterStore !== 'undefined') ? MeterStore.getAll() : []; }
    catch (e) { return []; }
  }

  function getMails() {
    try { return (typeof MailStore !== 'undefined') ? MailStore.getAll() : []; }
    catch (e) { return []; }
  }

  function getReturns() {
    try { return (typeof ReturnStore !== 'undefined') ? ReturnStore.getAll() : []; }
    catch (e) { return []; }
  }

  function getRanking() {
    try {
      return (typeof PostmarkData !== 'undefined' && typeof PostmarkData.getRanking === 'function')
        ? PostmarkData.getRanking()
        : [];
    } catch (e) {
      return [];
    }
  }

  // ============================================================
  // 汇总数据
  // ============================================================
  function collect() {
    const records = getRecords() || [];
    const meters = getMeters() || [];
    const mails = getMails() || [];
    const returns = getReturns() || [];
    const ranking = getRanking() || [];

    const provinceSet = new Set();
    const citySet = new Set();
    const districtSet = new Set();
    const provinceCount = new Map();
    const statusCount = new Map();
    const materialCount = new Map();
    const stampCount = new Map();
    const hourCount = new Array(24).fill(0);
    const dayCount = new Map();
    const monthRecordCount = new Map();
    const monthMeterCount = new Map();

    const meterProvinces = new Set();
    const meterModelCount = new Map();

    const mailStatusCount = new Map();
    const returnCountries = new Set();
    const returnStageCount = new Map();

    let photoTotal = 0;
    let photoRecords = 0;
    let scenicTotal = 0;
    let scenicRecords = 0;
    let datedRecords = 0;
    let openRecords = 0;

    records.forEach((r) => {
      if (!r || typeof r !== 'object') return;

      const province = shortProvince(r.province) || '未填写';
      const city = clean(r.city);
      const district = clean(r.district);

      if (province !== '未填写') provinceSet.add(province);
      provinceCount.set(province, (provinceCount.get(province) || 0) + 1);
      if (city && province !== '未填写') citySet.add(`${province}|${city}`);
      if (district && province !== '未填写') {
        districtSet.add(city ? `${province}|${city}|${district}` : `${province}||${district}`);
      }

      const statusKey = RECORD_STATUS_KEYS.has(r.status) ? r.status : 'other';
      statusCount.set(statusKey, (statusCount.get(statusKey) || 0) + 1);
      // 与首页排名口径一致：完成率只统计营业中、且填了省份的网点
      if (r.status === 'open' && province !== '未填写') openRecords++;

      const material = clean(r.material) || '未填写';
      materialCount.set(material, (materialCount.get(material) || 0) + 1);

      const stamps = getRecordStamps(r);
      if (stamps.length) {
        stamps.forEach(s => stampCount.set(s, (stampCount.get(s) || 0) + 1));
      } else {
        stampCount.set('无戳号', (stampCount.get('无戳号') || 0) + 1);
      }

      const dt = parseDate(r.cancelDate);
      if (dt) {
        datedRecords++;
        hourCount[dt.h]++;
        dayCount.set(dt.dateKey, (dayCount.get(dt.dateKey) || 0) + 1);
        monthRecordCount.set(dt.monthKey, (monthRecordCount.get(dt.monthKey) || 0) + 1);
      }

      const photos = Array.isArray(r.photos) ? r.photos.filter(Boolean) : [];
      photoTotal += photos.length;
      if (photos.length) photoRecords++;

      const scenic = Array.isArray(r.scenicNames) ? r.scenicNames.filter(Boolean) : [];
      scenicTotal += scenic.length;
      if (scenic.length) scenicRecords++;
    });

    meters.forEach((m) => {
      if (!m || typeof m !== 'object') return;

      const province = clean(m.province);
      if (province) meterProvinces.add(province);

      const model = clean(m.meterModel) || '未填写';
      meterModelCount.set(model, (meterModelCount.get(model) || 0) + 1);

      const dt = parseDate(m.printDate);
      if (dt) {
        monthMeterCount.set(dt.monthKey, (monthMeterCount.get(dt.monthKey) || 0) + 1);
      }
    });

    mails.forEach((m) => {
      if (!m || typeof m !== 'object') return;
      const status = ['pending', 'transit', 'delivered'].includes(m.status) ? m.status : 'pending';
      mailStatusCount.set(status, (mailStatusCount.get(status) || 0) + 1);
    });

    returns.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const country = clean(r.countryZh) || clean(r.countryEn) || clean(r.countryCode) || '未填写';
      if (country !== '未填写') returnCountries.add(country);
      const stage = returnStage(r);
      returnStageCount.set(stage, (returnStageCount.get(stage) || 0) + 1);
    });

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    const monthAddedRecords = monthRecordCount.get(thisMonth) || 0;
    const monthAddedMeters = monthMeterCount.get(thisMonth) || 0;

    let totalPostal = 0;
    ranking.forEach((r) => {
      totalPostal += Number(r && r.total) || 0;
    });
    const coveragePct = totalPostal > 0
      ? Math.min(100, Math.round(openRecords / totalPostal * 1000) / 10)
      : 0;

    return {
      records, meters, mails, returns, ranking,
      provinceSet, citySet, districtSet,
      provinceCount, statusCount, materialCount, stampCount,
      hourCount, dayCount, monthRecordCount, monthMeterCount,
      meterProvinces, meterModelCount,
      mailStatusCount, returnCountries, returnStageCount,
      photoTotal, photoRecords, scenicTotal, scenicRecords,
      datedRecords,
      monthAddedRecords, monthAddedMeters,
      collectedOpen: openRecords, totalPostal, coveragePct,
    };
  }

  // ============================================================
  // 概览卡片
  // ============================================================
  function renderKpi(data) {
    setText('stat-kpi-records', fmtNum(data.records.length));
    setText('stat-kpi-records-sub',
      `本月盖销 +${fmtNum(data.monthAddedRecords)} · 有日期 ${fmtNum(data.datedRecords)} 条`);

    setText('stat-kpi-provinces', fmtNum(data.provinceSet.size));
    setText('stat-kpi-coverage-sub',
      `市 ${fmtNum(data.citySet.size)} · 县 ${fmtNum(data.districtSet.size)}`);

    setText('stat-kpi-rate', `${data.coveragePct}%`);
    setText('stat-kpi-rate-sub', data.totalPostal > 0
      ? `营业中 ${fmtNum(data.collectedOpen)} / 网点 ${fmtNum(data.totalPostal)}`
      : '参考库尚未导入');

    setText('stat-kpi-meters', fmtNum(data.meters.length));
    setText('stat-kpi-meters-sub',
      `覆盖 ${fmtNum(data.meterProvinces.size)} 省 · 本月打印 +${fmtNum(data.monthAddedMeters)}`);

    setText('stat-kpi-photos', fmtNum(data.photoTotal));
    setText('stat-kpi-photos-sub', `来自 ${fmtNum(data.photoRecords)} 条记录`);

    const pending = data.mailStatusCount.get('pending') || 0;
    const transit = data.mailStatusCount.get('transit') || 0;
    const delivered = data.mailStatusCount.get('delivered') || 0;
    setText('stat-kpi-mails', fmtNum(data.mails.length));
    setText('stat-kpi-mails-sub',
      `待发 ${fmtNum(pending)} · 在途 ${fmtNum(transit)} · 妥收 ${fmtNum(delivered)}`);

    const receivedReturns = data.returnStageCount.get('received') || 0;
    setText('stat-kpi-returns', fmtNum(data.returns.length));
    setText('stat-kpi-returns-sub',
      `收到 ${fmtNum(receivedReturns)} 件 · 涉及 ${fmtNum(data.returnCountries.size)} 个国家/地区`);

    setText('stat-kpi-scenic', fmtNum(data.scenicTotal));
    setText('stat-kpi-scenic-sub', `来自 ${fmtNum(data.scenicRecords)} 条记录`);
  }

  // ============================================================
  // 省份收集排行（横向柱状图）
  // ============================================================
  function renderProvince(data) {
    // 记录里可能混用「北京市 / 北京」，先按短省名合并再排行
    const aggregated = new Map();
    data.provinceCount.forEach((count, name) => {
      const short = shortProvince(name);
      if (!short) return;
      aggregated.set(short, (aggregated.get(short) || 0) + count);
    });

    const entries = Array.from(aggregated.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    setText('stat-province-note', entries.length
      ? `Top ${entries.length} · 共 ${fmtNum(data.records.length)} 条（全部状态）`
      : '');

    if (!entries.length) {
      setChart('province', emptyOption('暂无日戳记录'));
      return;
    }

    const names = entries.map(e => e[0]).reverse();
    const values = entries.map(e => e[1]).reverse();
    const max = Math.max(...values, 1);

    setChart('province', {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        confine: true,
      },
      grid: { left: 96, right: 56, top: 10, bottom: 18 },
      xAxis: {
        type: 'value',
        min: 0,
        max: Math.max(1, Math.ceil(max * 1.18)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f2f2f2' } },
      },
      yAxis: {
        type: 'category',
        data: names,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#555',
          fontSize: 12,
          formatter: (v) => truncate(v, 8),
        },
      },
      series: [{
        name: '收集数量',
        type: 'bar',
        data: values,
        barMaxWidth: 16,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: gradient(0, 0, 1, 0, '#66bb6a', '#00991A'),
        },
        label: {
          show: true,
          position: 'right',
          color: '#666',
          fontSize: 11,
        },
      }],
    });
  }

  // ============================================================
  // 采集趋势（折线 / 面积图）
  // ============================================================
  function renderTrend(data) {
    const keys = Array.from(new Set([
      ...data.monthRecordCount.keys(),
      ...data.monthMeterCount.keys(),
    ])).sort();

    if (!keys.length) {
      setText('stat-trend-note', '');
      setChart('trend', emptyOption('暂无可用的日期数据'));
      return;
    }

    const range = buildMonthRange(keys, 36);
    setText('stat-trend-note', `按盖销 / 打印月份 · ${range.length} 个月`);

    const labels = range.map(k => k.slice(2).replace('-', '/'));
    const recordSeries = range.map(k => data.monthRecordCount.get(k) || 0);
    const meterSeries = range.map(k => data.monthMeterCount.get(k) || 0);

    setChart('trend', {
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
      legend: {
        data: ['日戳', '邮资机戳'],
        right: 4,
        top: 0,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: '#666', fontSize: 11 },
      },
      grid: { left: 42, right: 18, top: 34, bottom: range.length > 18 ? 48 : 30 },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLine: { lineStyle: { color: '#e8e8e8' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#999',
          fontSize: 10,
          rotate: range.length > 18 ? 35 : 0,
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f2f2f2' } },
      },
      series: [
        {
          name: '日戳',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          data: recordSeries,
          lineStyle: { width: 2, color: '#00991A' },
          itemStyle: { color: '#00991A' },
          areaStyle: {
            color: gradient(0, 0, 0, 1, 'rgba(0,153,26,.20)', 'rgba(0,153,26,0)'),
          },
        },
        {
          name: '邮资机戳',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          data: meterSeries,
          lineStyle: { width: 2, color: '#42a5f5' },
          itemStyle: { color: '#42a5f5' },
          areaStyle: {
            color: gradient(0, 0, 0, 1, 'rgba(66,165,245,.18)', 'rgba(66,165,245,0)'),
          },
        },
      ],
    });
  }

  // ============================================================
  // 采集日历（日历热力图）
  // ============================================================
  function renderCalendar(data) {
    const select = $('stat-calendar-year');
    const years = Array.from(new Set(
      Array.from(data.dayCount.keys()).map(key => Number(key.slice(0, 4)))
    )).sort((a, b) => b - a);
    if (!years.length) years.push(new Date().getFullYear());

    const previous = select ? Number(select.value) : 0;
    const year = years.includes(previous) ? previous : years[0];

    if (select) {
      select.innerHTML = years.map(y => `<option value="${y}">${y} 年</option>`).join('');
      select.value = String(year);
    }

    setText('stat-calendar-note', `按盖销日期 · ${fmtNum(data.datedRecords)} 条`);

    const points = [];
    data.dayCount.forEach((count, key) => {
      if (key.slice(0, 4) === String(year)) points.push([key, count]);
    });
    points.sort((a, b) => a[0].localeCompare(b[0]));

    if (!points.length) {
      setChart('calendar', emptyOption(`${year} 年暂无采集记录`));
      return;
    }

    const max = Math.max(...points.map(p => p[1]), 1);

    setChart('calendar', {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: (p) => `${p.value[0]} 采集 ${p.value[1]} 条`,
      },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        text: ['多', '少'],
        textStyle: { color: '#999', fontSize: 10 },
        inRange: { color: ['#eef7ee', '#c8e6c9', '#81c784', '#4caf50', '#1b5e20'] },
      },
      calendar: {
        top: 42,
        left: 44,
        right: 18,
        bottom: 42,
        range: String(year),
        cellSize: ['auto', 13],
        orient: 'horizontal',
        dayLabel: { firstDay: 1, nameMap: 'ZH', color: '#999', fontSize: 10 },
        monthLabel: { nameMap: 'ZH', color: '#666', fontSize: 11 },
        yearLabel: { show: false },
        itemStyle: { color: '#fafafa', borderWidth: 0 },
        splitLine: { show: false },
      },
      series: [{
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: points,
        itemStyle: { borderRadius: 2 },
        emphasis: {
          itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,.25)' },
        },
      }],
    });
  }

  // ============================================================
  // 邮局状态构成（环形图）
  // ============================================================
  function renderStatus(data) {
    const items = RECORD_STATUS
      .map(s => ({
        name: s.label,
        value: data.statusCount.get(s.key) || 0,
        itemStyle: { color: s.color },
      }))
      .filter(d => d.value > 0);

    setText('stat-status-note', `共 ${fmtNum(data.records.length)} 条`);

    if (!items.length) {
      setChart('status', emptyOption('暂无日戳记录'));
      return;
    }

    const total = items.reduce((sum, d) => sum + d.value, 0);

    setChart('status', {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: '{b}: {c} 条 ({d}%)',
      },
      title: {
        text: fmtNum(total),
        subtext: '条记录',
        left: 'center',
        top: '34%',
        textAlign: 'center',
        textStyle: { fontSize: 22, color: '#333', fontWeight: 700 },
        subtextStyle: { fontSize: 11, color: '#999' },
      },
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#666', fontSize: 11 },
      },
      series: [{
        type: 'pie',
        radius: ['44%', '66%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { color: '#666', fontSize: 11, formatter: '{b}\n{c}' },
        labelLine: { length: 8, length2: 8, lineStyle: { color: '#ddd' } },
        data: items,
      }],
    });
  }

  // ============================================================
  // 材质分布（玫瑰图）
  // ============================================================
  function renderMaterial(data) {
    const entries = Array.from(data.materialCount.entries())
      .sort((a, b) => b[1] - a[1]);

    setText('stat-material-note', entries.length ? `${entries.length} 类` : '');

    if (!entries.length) {
      setChart('material', emptyOption('暂无材质数据'));
      return;
    }

    const items = entries.map(([name, value], index) => ({
      name,
      value,
      itemStyle: { color: PALETTE[index % PALETTE.length] },
    }));

    setChart('material', {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: '{b}: {c} 条 ({d}%)',
      },
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#666', fontSize: 11 },
      },
      series: [{
        type: 'pie',
        radius: ['20%', '64%'],
        center: ['50%', '44%'],
        roseType: 'radius',
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          label: { show: true, color: '#333', fontSize: 12, fontWeight: 600, formatter: '{b}\n{c}' },
        },
        data: items,
      }],
    });
  }

  // ============================================================
  // 戳号使用频次（横向柱状图）
  // ============================================================
  function renderStamp(data) {
    const entries = Array.from(data.stampCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    setText('stat-stamp-note', entries.length
      ? `Top ${entries.length} · 空白计为「无戳号」`
      : '');

    if (!entries.length) {
      setChart('stamp', emptyOption('暂无日戳记录'));
      return;
    }

    const names = entries.map(e => e[0]).reverse();
    const values = entries.map(e => e[1]).reverse();
    const max = Math.max(...values, 1);

    setChart('stamp', {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        confine: true,
      },
      grid: { left: 96, right: 56, top: 10, bottom: 18 },
      xAxis: {
        type: 'value',
        min: 0,
        max: Math.max(1, Math.ceil(max * 1.18)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f2f2f2' } },
      },
      yAxis: {
        type: 'category',
        data: names,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#555',
          fontSize: 12,
          formatter: (v) => truncate(v, 10),
        },
      },
      series: [{
        name: '记录数',
        type: 'bar',
        data: values,
        barMaxWidth: 14,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: gradient(0, 0, 1, 0, '#b39ddb', '#6a1b9a'),
        },
        label: { show: true, position: 'right', color: '#666', fontSize: 11 },
      }],
    });
  }

  // ============================================================
  // 采集时段分布（柱状图）
  // ============================================================
  function renderHour(data) {
    setText('stat-hour-note', `按盖销小时 · ${fmtNum(data.datedRecords)} 条`);

    if (!data.datedRecords) {
      setChart('hour', emptyOption('暂无带盖销日期的记录'));
      return;
    }

    setChart('hour', {
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        confine: true,
        formatter: (params) => {
          const p = params && params[0];
          if (!p) return '';
          return `${String(p.axisValue).padStart(2, '0')}:00 采集 ${p.value} 条`;
        },
      },
      grid: { left: 38, right: 16, top: 16, bottom: 26 },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, i) => String(i)),
        axisLine: { lineStyle: { color: '#e8e8e8' } },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 10, interval: 2 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f2f2f2' } },
      },
      series: [{
        name: '采集数量',
        type: 'bar',
        data: data.hourCount,
        barMaxWidth: 18,
        itemStyle: {
          borderRadius: [3, 3, 0, 0],
          color: gradient(0, 0, 0, 1, '#26a69a', '#00991A'),
        },
      }],
    });
  }

  // ============================================================
  // 全国网点覆盖率（仪表盘）
  // ============================================================
  function renderGauge(data) {
    setText('stat-gauge-note', data.totalPostal > 0
      ? `营业中 ${fmtNum(data.collectedOpen)} / ${fmtNum(data.totalPostal)}`
      : '参考库尚未导入');

    setChart('gauge', {
      series: [{
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        progress: {
          show: true,
          width: 14,
          itemStyle: { color: '#00991A' },
        },
        axisLine: {
          lineStyle: { width: 14, color: [[1, '#eef2ee']] },
        },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: {
          show: true,
          offsetCenter: [0, '42%'],
          fontSize: 12,
          color: '#999',
        },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '6%'],
          fontSize: 30,
          fontWeight: 700,
          color: '#007A15',
          formatter: (value) => `${value}%`,
        },
        data: [{ value: data.coveragePct, name: '全国网点覆盖率' }],
      }],
    });
  }

  // ============================================================
  // 邮件状态（环形图）
  // ============================================================
  function renderMail(data) {
    const total = data.mails.length;
    setText('stat-mail-note', `共 ${fmtNum(total)} 件`);

    const items = MAIL_STATUS
      .map(s => ({
        name: s.label,
        value: data.mailStatusCount.get(s.key) || 0,
        itemStyle: { color: s.color },
      }))
      .filter(d => d.value > 0);

    if (!items.length) {
      setChart('mail', emptyOption('暂无邮件记录'));
      return;
    }

    setChart('mail', {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: '{b}: {c} 件 ({d}%)',
      },
      title: {
        text: fmtNum(total),
        subtext: '件邮件',
        left: 'center',
        top: '34%',
        textAlign: 'center',
        textStyle: { fontSize: 22, color: '#333', fontWeight: 700 },
        subtextStyle: { fontSize: 11, color: '#999' },
      },
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#666', fontSize: 11 },
      },
      series: [{
        type: 'pie',
        radius: ['44%', '66%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { color: '#666', fontSize: 11, formatter: '{b}\n{c}' },
        labelLine: { length: 8, length2: 8, lineStyle: { color: '#ddd' } },
        data: items,
      }],
    });
  }

  // ============================================================
  // 国际退信进度（环形图：发出 / 到达 / 返回 / 收到）
  // ============================================================
  function renderReturn(data) {
    const total = data.returns.length;
    setText('stat-return-note', total
      ? `按最远已填节点 · 共 ${fmtNum(total)} 件`
      : '');

    const items = RETURN_STAGES
      .map(s => ({
        name: s.label,
        value: data.returnStageCount.get(s.key) || 0,
        itemStyle: { color: s.color },
      }))
      .filter(d => d.value > 0);
    const stagedTotal = items.reduce((sum, d) => sum + d.value, 0);

    if (!stagedTotal) {
      setChart('return', emptyOption('暂无国际退信记录'));
      return;
    }

    setChart('return', {
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: '{b}: {c} 件 ({d}%)',
      },
      title: {
        text: fmtNum(stagedTotal),
        subtext: '件退信',
        left: 'center',
        top: '34%',
        textAlign: 'center',
        textStyle: { fontSize: 22, color: '#333', fontWeight: 700 },
        subtextStyle: { fontSize: 11, color: '#999' },
      },
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        data: RETURN_STAGES.map(s => s.label),
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#666', fontSize: 11 },
      },
      series: [{
        type: 'pie',
        radius: ['44%', '66%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { color: '#666', fontSize: 11, formatter: '{b}\n{c}' },
        labelLine: { length: 8, length2: 8, lineStyle: { color: '#ddd' } },
        data: items,
      }],
    });
  }

  // ============================================================
  // 邮资机型号 Top 10（横向柱状图）
  // ============================================================
  function renderMeter(data) {
    const entries = Array.from(data.meterModelCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    setText('stat-meter-note', `共 ${fmtNum(data.meters.length)} 条`);

    if (!entries.length) {
      setChart('meter', emptyOption('暂无邮资机戳记录'));
      return;
    }

    const names = entries.map(e => e[0]).reverse();
    const values = entries.map(e => e[1]).reverse();
    const max = Math.max(...values, 1);

    setChart('meter', {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        confine: true,
      },
      grid: { left: 124, right: 46, top: 10, bottom: 18 },
      xAxis: {
        type: 'value',
        min: 0,
        max: Math.max(1, Math.ceil(max * 1.18)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#999', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f2f2f2' } },
      },
      yAxis: {
        type: 'category',
        data: names,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#555',
          fontSize: 12,
          formatter: (v) => truncate(v, 10),
        },
      },
      series: [{
        name: '机戳数量',
        type: 'bar',
        data: values,
        barMaxWidth: 14,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: gradient(0, 0, 1, 0, '#64b5f6', '#1976d2'),
        },
        label: { show: true, position: 'right', color: '#666', fontSize: 11 },
      }],
    });
  }

  // ============================================================
  // 上海市细化（区县 / 戳号 / 月度 / 网点）
  // ============================================================
  function renderShanghai(data) {
    const shRecords = (data.records || []).filter(r => r && shortProvince(r.province) === '上海');
    const shMeters = (data.meters || []).filter(m => m && shortProvince(m.province) === '上海');
    const hasShanghai = shRecords.length > 0 || shMeters.length > 0;

    let officialDistricts = [];
    try {
      if (typeof PostmarkData !== 'undefined' && typeof PostmarkData.getDistricts === 'function') {
        officialDistricts = (PostmarkData.getDistricts('上海市') || []).map(clean).filter(Boolean);
      }
    } catch (e) { /* 参考数据不可用时退回记录里出现过的区县 */ }
    if (!officialDistricts.length) {
      officialDistricts = Array.from(new Set(
        shRecords.map(r => clean(r.district)).filter(Boolean)
      ));
    }
    const districtTotal = officialDistricts.length || 16;

    const districtMap = new Map();
    function ensureDistrict(name) {
      const key = name || '未填写';
      if (!districtMap.has(key)) {
        districtMap.set(key, {
          name: key,
          records: 0,
          open: 0,
          themedTemp: 0,
          closed: 0,
          misc: 0,
          meters: 0,
          photos: 0,
          offices: new Set(),
          stamps: new Set(),
          latest: '',
        });
      }
      return districtMap.get(key);
    }
    officialDistricts.forEach(ensureDistrict);

    const stampMap = new Map();
    const monthMap = new Map();
    const officeMap = new Map();

    function ensureMonth(key) {
      if (!monthMap.has(key)) {
        monthMap.set(key, { key, records: 0, meters: 0, photos: 0, offices: new Set() });
      }
      return monthMap.get(key);
    }

    shRecords.forEach((r) => {
      const districtName = clean(r.district) || '未填写';
      const district = ensureDistrict(districtName);
      const photos = Array.isArray(r.photos) ? r.photos.filter(Boolean) : [];
      const stamps = getRecordStamps(r);
      const date = dateOnly(r.cancelDate);
      const officeKey = clean(r.institutionCode) || clean(r.postOffice) || '未填写';
      const status = recordStatusKey(r);

      district.records++;
      if (status === 'open') district.open++;
      else if (status === 'closed') district.closed++;
      else if (status === 'themed' || status === 'temporary') district.themedTemp++;
      else district.misc++;
      district.photos += photos.length;
      district.offices.add(officeKey);
      stamps.forEach(s => district.stamps.add(s));
      if (date && date > district.latest) district.latest = date;

      const stampKeys = stamps.length ? stamps : ['无戳号'];
      stampKeys.forEach((key) => {
        let item = stampMap.get(key);
        if (!item) {
          item = { name: key, records: 0, offices: new Set(), districts: new Set(), latest: '' };
          stampMap.set(key, item);
        }
        item.records++;
        item.offices.add(officeKey);
        item.districts.add(districtName);
        if (date && date > item.latest) item.latest = date;
      });

      const dt = parseDate(r.cancelDate);
      if (dt) {
        const month = ensureMonth(dt.monthKey);
        month.records++;
        month.photos += photos.length;
        month.offices.add(officeKey);
      }

      if (!officeMap.has(officeKey)) {
        officeMap.set(officeKey, {
          key: officeKey,
          name: clean(r.postOffice) || '未填写',
          district: districtName,
          postalCode: clean(r.postalCode),
          instCode: clean(r.institutionCode),
          status: recordStatusLabel(r),
          stamps: new Set(),
          latest: '',
          photos: 0,
          records: 0,
        });
      }
      const office = officeMap.get(officeKey);
      office.records++;
      office.photos += photos.length;
      stamps.forEach(s => office.stamps.add(s));
      if (date && date >= office.latest) {
        office.latest = date;
        office.status = recordStatusLabel(r);
        office.name = clean(r.postOffice) || office.name;
        office.district = districtName;
        office.postalCode = clean(r.postalCode) || office.postalCode;
        office.instCode = clean(r.institutionCode) || office.instCode;
      }
    });

    shMeters.forEach((m) => {
      const districtName = clean(m.district) || '未填写';
      ensureDistrict(districtName).meters++;
      const dt = parseDate(m.printDate);
      if (dt) ensureMonth(dt.monthKey).meters++;
    });

    let coveredDistricts = 0;
    if (officialDistricts.length) {
      coveredDistricts = officialDistricts.filter((name) => {
        const d = districtMap.get(name);
        return d && (d.records > 0 || d.meters > 0);
      }).length;
    } else {
      coveredDistricts = Array.from(districtMap.values())
        .filter(d => d.name !== '未填写' && (d.records > 0 || d.meters > 0)).length;
    }

    const shPhotos = shRecords.reduce((sum, r) => {
      return sum + (Array.isArray(r.photos) ? r.photos.filter(Boolean).length : 0);
    }, 0);
    const totalPostal = (() => {
      const hit = (data.ranking || []).find(r => shortProvince(r.name) === '上海');
      return hit ? Number(hit.total) || 0 : 0;
    })();

    setText('stat-sh-records', fmtNum(shRecords.length));
    setText('stat-sh-districts', `${fmtNum(coveredDistricts)} / ${fmtNum(districtTotal)}`);
    setText('stat-sh-meters', fmtNum(shMeters.length));
    setText('stat-sh-photos', fmtNum(shPhotos));
    setText('stat-shanghai-note', hasShanghai
      ? `共 ${fmtNum(shRecords.length)} 条日戳 · ${fmtNum(shMeters.length)} 条邮资机${totalPostal ? ` · 全区网点 ${fmtNum(totalPostal)} 个` : ''}`
      : '暂无上海数据');

    // ---- 区县收集情况 ----
    const districtRows = Array.from(districtMap.values()).sort((a, b) => {
      const ia = officialDistricts.indexOf(a.name);
      const ib = officialDistricts.indexOf(b.name);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return b.records - a.records || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    const districtBody = $('stat-sh-district-body');
    if (districtBody) {
      districtBody.innerHTML = !hasShanghai
        ? tableEmptyRow(11, '暂无上海数据')
        : districtRows.map(d => `
          <tr>
            <td>${escapeHtml(d.name)}</td>
            <td>${fmtNum(d.records)}</td>
            <td>${fmtNum(d.offices.size)}</td>
            <td>${fmtNum(d.stamps.size)}</td>
            <td>${fmtNum(d.open)}</td>
            <td>${fmtNum(d.themedTemp)}</td>
            <td>${fmtNum(d.closed)}</td>
            <td>${fmtNum(d.misc)}</td>
            <td>${fmtNum(d.meters)}</td>
            <td>${fmtNum(d.photos)}</td>
            <td>${escapeHtml(d.latest || '—')}</td>
          </tr>`).join('');
    }
    setText('stat-sh-district-note', hasShanghai
      ? `${fmtNum(coveredDistricts)} / ${fmtNum(districtTotal)} 个区县有数据`
      : '');

    // ---- 戳号分布 ----
    const stampRows = Array.from(stampMap.values())
      .sort((a, b) => b.records - a.records
        || b.offices.size - a.offices.size
        || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 15);
    const stampBody = $('stat-sh-stamp-body');
    if (stampBody) {
      stampBody.innerHTML = !stampRows.length
        ? tableEmptyRow(5, '暂无上海日戳记录')
        : stampRows.map(s => `
          <tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${fmtNum(s.records)}</td>
            <td>${fmtNum(s.offices.size)}</td>
            <td>${fmtNum(s.districts.size)}</td>
            <td>${escapeHtml(s.latest || '—')}</td>
          </tr>`).join('');
    }
    setText('stat-sh-stamp-note', stampRows.length
      ? `Top ${stampRows.length} · 空白计为「无戳号」`
      : '');

    // ---- 月度采集 ----
    const monthKeys = Array.from(monthMap.keys()).sort();
    const monthRange = buildMonthRange(monthKeys, 12).reverse();
    const monthBody = $('stat-sh-month-body');
    if (monthBody) {
      monthBody.innerHTML = !monthRange.length
        ? tableEmptyRow(5, '暂无带日期的上海记录')
        : monthRange.map((key) => {
          const m = monthMap.get(key) || { records: 0, meters: 0, photos: 0, offices: new Set() };
          return `
            <tr>
              <td>${escapeHtml(key.replace('-', '/'))}</td>
              <td>${fmtNum(m.records)}</td>
              <td>${fmtNum(m.meters)}</td>
              <td>${fmtNum(m.photos)}</td>
              <td>${fmtNum(m.offices.size)}</td>
            </tr>`;
        }).join('');
    }
    setText('stat-sh-month-note', monthRange.length ? `最近 ${monthRange.length} 个月` : '');

    // ---- 网点明细 ----
    const officeRows = Array.from(officeMap.values())
      .sort((a, b) => {
        if (a.latest !== b.latest) {
          if (!a.latest) return 1;
          if (!b.latest) return -1;
          return b.latest.localeCompare(a.latest);
        }
        return b.records - a.records
          || a.name.localeCompare(b.name, 'zh-Hans-CN');
      })
      .slice(0, 30);
    const officeBody = $('stat-sh-office-body');
    if (officeBody) {
      officeBody.innerHTML = !officeRows.length
        ? tableEmptyRow(9, '暂无上海日戳记录')
        : officeRows.map((o) => {
          const stampsText = Array.from(o.stamps).join(', ') || '无戳号';
          return `
            <tr>
              <td>${escapeHtml(o.name)}</td>
              <td>${escapeHtml(o.district)}</td>
              <td>${escapeHtml(o.postalCode || '—')}</td>
              <td>${escapeHtml(o.instCode || '—')}</td>
              <td>${escapeHtml(o.status)}</td>
              <td>${fmtNum(o.records)}</td>
              <td title="${escapeHtml(stampsText)}">${escapeHtml(truncate(stampsText, 18))}</td>
              <td>${escapeHtml(o.latest || '—')}</td>
              <td>${fmtNum(o.photos)}</td>
            </tr>`;
        }).join('');
    }
    setText('stat-sh-office-note', officeRows.length
      ? `按最近盖销排序 · 前 ${officeRows.length} 个`
      : '');
  }

  // ============================================================
  // ECharts 实例管理
  // ============================================================
  function ensureChart(key) {
    const el = $('stat-chart-' + key);
    if (!el) return null;

    if (typeof echarts === 'undefined') {
      el.textContent = '图表库未加载';
      return null;
    }

    let chart = charts[key];
    if (!chart || chart.isDisposed()) {
      chart = echarts.init(el);
      charts[key] = chart;
    }
    return chart;
  }

  function setChart(key, option) {
    const chart = ensureChart(key);
    if (!chart) return;
    chart.setOption(option, true);
  }

  function resize() {
    if (!visible) return;
    Object.keys(charts).forEach((key) => {
      const chart = charts[key];
      if (chart && !chart.isDisposed()) chart.resize();
    });
  }

  // ============================================================
  // 渲染入口
  // ============================================================
  function renderAll() {
    const data = collect();
    lastData = data;

    renderKpi(data);
    renderProvince(data);
    renderTrend(data);
    renderCalendar(data);
    renderStatus(data);
    renderMaterial(data);
    renderStamp(data);
    renderHour(data);
    renderGauge(data);
    renderMail(data);
    renderReturn(data);
    renderMeter(data);
    renderShanghai(data);
  }

  function bindEvents() {
    const select = $('stat-calendar-year');
    if (select && !select.dataset.bound) {
      select.dataset.bound = '1';
      select.addEventListener('change', () => {
        if (!lastData) return;
        renderCalendar(lastData);
      });
    }
  }

  // 浏览器窗口尺寸变化时按新宽度重算（页面隐藏时跳过，进入页面会统一 resize）
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      if (visible) resize();
    });
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return {
    /** 进入页面：绑定事件、首次渲染，并在下一帧校正图表尺寸 */
    show() {
      visible = true;
      bindEvents();
      renderAll();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resize());
      } else {
        resize();
      }
    },

    /** 离开页面：停止响应尺寸变化（实例保留，下次进入直接复用） */
    hide() {
      visible = false;
    },

    /** 数据变化 / 手动刷新：只在页面可见时重绘 */
    refresh() {
      if (!visible) return;
      renderAll();
    },

    /** 侧边栏折叠等容器尺寸变化后调用 */
    resize,

    /** 供 app.js 判断统计页是否处于可见状态 */
    isVisible() {
      return visible;
    },
  };
})();
