/**
 * 统计面板模块 — 汇总数据、排名表格、分布图
 * =============================================
 * 依赖: PostmarkData (data.js)
 */

const StatsView = (function () {

  // ============================================================
  // 渲染概览卡片 (地图上方的 overview)
  // ============================================================
  function renderOverview() {
    const records = RecordStore.getAll();
    const provinces = new Set();
    const cities = new Set();
    const districts = new Set();
    records.forEach(r => {
      if (r.province) provinces.add(r.province);
      if (r.city) cities.add(r.city);
      if (r.district) districts.add(r.district);
    });
    document.getElementById('ov-stamps').textContent = records.length;
    document.getElementById('ov-provinces').textContent = provinces.size;
    document.getElementById('ov-cities').textContent = cities.size;
    document.getElementById('ov-districts').textContent = districts.size;
  }

  // ============================================================
  // 排名表格
  // ============================================================
  function renderRankingTable() {
    const tbody = document.getElementById('stats-body');
    const rows = PostmarkData.getRanking();

    tbody.innerHTML = rows.map((r, i) => {
      const barWidth = Math.min(r.rate, 100);
      return `<tr>
        <td>${i + 1}</td>
        <td>${r.name}</td>
        <td class="rank-collected">${r.collected}</td>
        <td>${r.total}</td>
        <td class="rank-rate">
          <span class="bar-bg"><span class="bar-fill" style="width:${barWidth}%"></span></span>
          ${r.rate}%
        </td>
      </tr>`;
    }).join('');
  }


  // ============================================================
  // 日期热力图 (GitHub 风格贡献图)
  // ============================================================
  function renderCalendarHeatmap() {
    const container = document.getElementById('stats-heatmap');
    const records = RecordStore.getAll();

    // 按 YYYYMMDD 分组
    const dayCount = {};
    records.forEach(r => {
      const d = (r.cancelDate || '').slice(0, 8);
      if (d.length === 8) dayCount[d] = (dayCount[d] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(dayCount), 1);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 计算过去 16 周的完整周日历（周一起始）
    const weeks = 16;
    const endDay = new Date(today);
    const dow = endDay.getDay();
    endDay.setDate(endDay.getDate() + (dow === 0 ? 0 : 7 - dow)); // 最近周日
    const startDay = new Date(endDay);
    startDay.setDate(startDay.getDate() - weeks * 7 + 1);

    // 构建网格数据: weeksData[w][d]  w=0..15, d=0..6 (周一→周日)
    const weeksData = [];
    let cursor = new Date(startDay);
    for (let w = 0; w < weeks; w++) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const y = cursor.getFullYear();
        const m = String(cursor.getMonth() + 1).padStart(2, '0');
        const day = String(cursor.getDate()).padStart(2, '0');
        const key = `${y}${m}${day}`;
        week.push({
          key, count: dayCount[key] || 0,
          isFuture: cursor > today,
          date: new Date(cursor),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeksData.push(week);
    }

    const colorScale = (count) => {
      if (count === 0) return '#ebedf0';
      const pct = count / maxCount;
      if (pct <= 0.25) return '#c6e48b';
      if (pct <= 0.5) return '#7bc96f';
      if (pct <= 0.75) return '#239a3b';
      return '#196127';
    };

    const DAY_NAMES = ['', '一', '', '三', '', '五', ''];

    // 使用 CSS Grid 单容器布局
    let html = `<div class="hm-grid" style="grid-template-columns:24px repeat(${weeks}, 1fr)">`;

    // 7 行: 周一至周日
    for (let d = 0; d < 7; d++) {
      html += `<div class="hm-dw">${DAY_NAMES[d]}</div>`;
      for (let w = 0; w < weeks; w++) {
        const cell = weeksData[w][d];
        const color = cell.isFuture ? 'transparent' : colorScale(cell.count);
        const title = cell.isFuture ? '' : `${cell.key.slice(0,4)}-${cell.key.slice(4,6)}-${cell.key.slice(6,8)} ${cell.count}条`;
        html += `<div class="hm-cell" style="background:${color}" title="${title}"></div>`;
      }
    }

    html += '</div>';

    // 图例
    html += '<div class="hm-legend">少';
    ['#ebedf0', '#c6e48b', '#7bc96f', '#239a3b', '#196127'].forEach(c => {
      html += `<span class="hm-cell" style="background:${c}"></span>`;
    });
    html += '多</div>';

    container.innerHTML = html;
  }

  // ============================================================
  // 更新 (由 app.js 在钻取时调用，可传递上下文)
  // ============================================================
  function update(level, provinceAdcode) {
    renderOverview();

    // 排名只在省级视图显示
    if (level === 'nation' || level === 'province') {
      renderRankingTable();
    }
    renderCalendarHeatmap();
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return {
    /** 初始化统计面板 */
    init() {
      this.update('nation', null);
    },

    /** 刷新所有统计 */
    update,
  };

})();
