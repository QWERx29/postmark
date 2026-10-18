/**
 * 地图模块 — 基于 ECharts 的中国地图着色与下钻
 * ============================================
 * 依赖: ECharts (全局 echarts), PostmarkData (data.js), IdbKV (idb.js)
 *
 * 职责:
 *   1. 加载 GeoJSON (DataV API) 并注册到 ECharts
 *   2. 省级地图着色 (choropleth)
 *   3. 单击省份 → 下钻至市级
 *   4. 返回全国视图
 */

const MapView = (function () {

  // ============================================================
  // 常量
  // ============================================================
  const CHART_DOM = 'map-chart';
  const GEO_API_ROOT = 'geo';
  const ADCODE_NATION = 100000;

  // 已收集数量色阶 (绿色系)
  const COLOR_STOPS = [
    { min: 0,  max: 0,   color: '#f5f5f5', label: '无' },
    { min: 1,  max: 5,   color: '#e8f5e9', label: '1 ~ 5' },
    { min: 5,  max: 20,  color: '#c8e6c9', label: '5 ~ 20' },
    { min: 20, max: 50,  color: '#81c784', label: '20 ~ 50' },
    { min: 50, max: 101, color: '#00991A', label: '≥ 50' },
  ];

  // 未收集数据时的颜色
  const COLOR_NO_DATA = '#f5f5f5';

  // ============================================================
  // 状态
  // ============================================================
  let chart = null;
  let currentLevel = 'province';   // 'province' | 'city'
  let currentProvinceAdcode = null;
  let nationGeoJson = null;        // 已缓存的全国 GeoJSON

  // 回调 (由 app.js 注册)
  let onProvinceClick = null;
  let onCityClick = null;
  let onMapReady = null;

  // ============================================================
  // 颜色工具
  // ============================================================
  function getColorForRate(rate) {
    if (rate === 0 || rate == null) return COLOR_NO_DATA;
    for (const s of COLOR_STOPS) {
      if (rate >= s.min && rate < s.max) return s.color;
    }
    return COLOR_STOPS[COLOR_STOPS.length - 1].color;
  }

  // ============================================================
  // ECharts 通用配置
  // ============================================================
  function makeMapOption(mapName, mapData, levelName) {
    const series = [{
      type: 'map',
      map: mapName,
      roam: true,
      selectedMode: false,
      label: {
        show: false,
        fontSize: levelName === 'city' ? 10 : 11,
        color: '#333'
      },
      itemStyle: {
        borderColor: '#fff',
        borderWidth: 1,
        areaColor: COLOR_NO_DATA,
      },
      emphasis: {
        label: { color: '#00991A', fontWeight: 'bold', fontSize: 13 },
        itemStyle: {
          areaColor: '#b9f6ca',
          shadowBlur: 8,
          shadowColor: 'rgba(0,0,0,0.2)'
        }
      },
      data: mapData.map(d => ({
        name: d.name,
        value: d.value,
        _raw: d   // 挂载原始数据供点击回调使用
      }))
    }];

    // 视觉效果配置 — 已收集数量着色
    return {
      tooltip: {
        trigger: 'item',
        formatter(params) {
          const d = params.data?._raw || {};
          const val = d.value != null ? d.value : 0;
          const color = getColorForRate(val);
          const bar = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:4px"></span>`;
          if (!d.name) return `${params.name}<br/>暂无数据`;
          return `${bar} <b>${d.name}</b><br/>已收集: <b>${val}</b> 枚`;
        }
      },
      visualMap: {
        min: 0,
        max: 50,
        text: ['多', '少'],
        textStyle: { color: '#555', fontSize: 11 },
        inRange: {
          color: ['#f5f5f5', '#e8f5e9', '#c8e6c9', '#81c784', '#00991A']
        },
        calculable: true,
        left: 'left',
        bottom: 20
      },
      series
    };
  }

  // ============================================================
  // GeoJSON 加载（带超时 + IndexedDB 缓存）
  // ============================================================
  /**
   * 缓存落在 IndexedDB（IdbKV）而不是 localStorage：
   * 24 个省份的 GeoJSON 合计约 337 万字符，独占 localStorage
   * 5 MiB 配额的 64%，会把 PO 参考库挤到无地可写（详见 idb.js 说明）。
   */
  async function loadGeoJson(adcode) {
    // 优先从 IndexedDB 缓存加载
    const CACHE_KEY = `geojson_cache_${adcode}`;
    try {
      const cached = await IdbKV.get(CACHE_KEY);
      if (cached && cached.features && cached.features.length > 0) return cached;
    } catch { /* 缓存不可用则忽略，走网络 */ }

    const url = `${GEO_API_ROOT}/${adcode}_full.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 秒超时

    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`GeoJSON 加载失败 (${resp.status})`);
      const geo = await resp.json();
      if (!geo.features || geo.features.length === 0) {
        throw new Error('GeoJSON 数据为空');
      }
      // 写入缓存
      try { await IdbKV.set(CACHE_KEY, geo); } catch { /* 缓存写不进去不影响本次渲染 */ }
      return geo;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 清掉旧版本留在 localStorage 里的 GeoJSON 缓存。
   * 这些副本已经不在读取路径上，却继续占着 5 MiB 配额。
   * @returns {number} 清除的键数
   */
  function purgeLegacyCache() {
    if (typeof localStorage === 'undefined') return 0;
    const doomed = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('geojson_cache_')) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    } catch { /* 忽略 */ }
    if (doomed.length > 0) console.log(`[Map] 已清理 localStorage 里的 ${doomed.length} 个旧 GeoJSON 缓存`);
    return doomed.length;
  }

  // ============================================================
  // 渲染 (清空后重绘)
  // ============================================================
  function renderMap(geoJson, mapData, mapName, levelName) {
    echarts.registerMap(mapName, geoJson);
    const option = makeMapOption(mapName, mapData, levelName);
    chart.clear();
    chart.setOption(option, true);
    chart.resize();
  }

  /** 渲染全国省级地图 */
  async function renderNation() {
    currentLevel = 'province';
    currentProvinceAdcode = null;

    try {
      // 加载 GeoJSON (带缓存)
      if (!nationGeoJson) {
        nationGeoJson = await loadGeoJson(ADCODE_NATION);
      }
      const mapData = PostmarkData.getMapData('province');
      renderMap(nationGeoJson, mapData, 'china', 'province');
      if (onMapReady) onMapReady('nation', null);
    } catch (err) {
      console.error('全国地图渲染失败:', err);
      showChartError('地图加载失败: ' + err.message);
    }
  }

  /** 渲染某省份的市级下钻地图 */
  async function renderProvince(provinceAdcode) {
    currentLevel = 'city';
    currentProvinceAdcode = provinceAdcode;

    try {
      const geoJson = await loadGeoJson(provinceAdcode);
      const mapData = PostmarkData.getMapData('city', provinceAdcode);
      const prov = PostmarkData.getProvince(provinceAdcode);
      const mapName = 'province_' + provinceAdcode;

      renderMap(geoJson, mapData, mapName, 'city');
      if (onMapReady) onMapReady('city', provinceAdcode, prov?.name);
    } catch (err) {
      console.error('省级地图渲染失败:', err);
      showChartError('下钻地图加载失败: ' + err.message);
    }
  }

  /** 显示错误占位 */
  function showChartError(msg) {
    chart.clear();
    chart.setOption({
      graphic: {
        type: 'text',
        left: 'center',
        top: 'center',
        style: {
          text: msg,
          fontSize: 16,
          fill: '#999'
        }
      }
    });
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  function bindEvents() {
    chart.off('click');
    chart.on('click', function (params) {
      const raw = params.data?._raw;
      if (!raw) return;

      if (currentLevel === 'province') {
        // 点击省份 → 下钻
        if (onProvinceClick) onProvinceClick(raw.adcode, raw.name);
      } else if (currentLevel === 'city') {
        // 点击城市
        if (onCityClick) onCityClick(raw.adcode, raw.name, currentProvinceAdcode);
      }
    });
  }

  // ============================================================
  // 公开 API
  // ============================================================
  return {

    /** 初始化地图 */
    async init() {
      const dom = document.getElementById(CHART_DOM);
      if (!dom) throw new Error('找不到地图容器 #' + CHART_DOM);

      // 旧版本把 GeoJSON 缓存在 localStorage，先清掉腾出配额
      purgeLegacyCache();

      chart = echarts.init(dom, null, { renderer: 'canvas' });
      bindEvents();

      // 窗口自适应
      window.addEventListener('resize', () => chart?.resize());

      await renderNation();
    },

    /** 下钻到省份 */
    async drillToProvince(adcode) {
      await renderProvince(adcode);
    },

    /** 返回全国视图 */
    async backToNation() {
      await renderNation();
    },

    /** 获取当前视图层级 */
    getCurrentLevel() {
      return currentLevel;
    },

    /** 获取当前省份 adcode */
    getCurrentProvince() {
      return currentProvinceAdcode;
    },

    /** 注册回调 */
    onProvinceClick(cb) { onProvinceClick = cb; },
    onCityClick(cb) { onCityClick = cb; },
    onMapReady(cb) { onMapReady = cb; },

    /** 调整大小 */
    resize() {
      chart?.resize();
    },

    /** 销毁 */
    dispose() {
      chart?.dispose();
      chart = null;
    }
  };

})();
