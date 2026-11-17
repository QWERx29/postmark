/**
 * 导出工具 — CSV / Excel / JSON 下载
 * ====================================
 * 依赖: XLSX（SheetJS，index.html 已本地引入；只有导出 Excel 时才用到）
 *
 * 为什么单独一个模块
 * ------------------
 * 日戳记录、邮件、国际退信、Excel 模板都要「把二维表变成文件」。
 * 各处自己拼 Blob / CSV 转义 / 列宽，迟早出现「有的导出带 BOM、有的不带」。
 * 这里统一三件事：
 *   1. CSV 转义与 BOM（Excel 打开中文不乱码）；
 *   2. Excel 的列宽估算（避免每次打开都要手动拉宽）；
 *   3. 文件名时间戳（同一天多次导出不覆盖）。
 *
 * 对外接口: window.ExportUtils
 */
(function () {

  /** CSV 单元格：含分隔符 / 引号 / 换行时加引号，内部引号翻倍 */
  function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** 二维数组 → CSV 文本（带 UTF-8 BOM，CRLF 换行） */
  function toCsv(headers, rows) {
    const lines = [];
    if (Array.isArray(headers)) lines.push(headers.map(csvCell).join(','));
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      lines.push((Array.isArray(row) ? row : [row]).map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 在部分浏览器上会让下载中断，交给下一轮事件循环
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText(filename, text, mime) {
    downloadBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), filename);
  }

  /** 下载 CSV；headers 可省略（rows 已含表头时） */
  function downloadCsv(filename, headers, rows) {
    downloadText(filename, toCsv(headers, rows), 'text/csv;charset=utf-8');
  }

  /** 下载 JSON（数组 / 对象） */
  function downloadJson(filename, data) {
    downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  }

  /** 估算列宽：取表头与内容的最大字符数，限制在 8~48 之间 */
  function columnWidths(headers, rows) {
    return headers.map((h, i) => {
      let max = String(h == null ? '' : h).length;
      rows.forEach((row) => {
        const text = row && row[i] != null ? String(row[i]) : '';
        // 中文按 2 个字符宽度估算
        const width = text.replace(/[\u4e00-\u9fa5]/g, 'xx').length;
        if (width > max) max = width;
      });
      return { wch: Math.max(8, Math.min(48, max + 2)) };
    });
  }

  /**
   * 下载 Excel。
   * @param {string} filename 例如 日戳记录-20261116.xlsx
   * @param {string} sheetName 工作表名
   * @param {string[]} headers
   * @param {Array<Array>} rows
   * @param {{extraSheets?: Array<{name:string, aoa:Array<Array>}>}} [opts]
   */
  function downloadXlsx(filename, sheetName, headers, rows, opts) {
    if (typeof XLSX === 'undefined') {
      throw new Error('Excel 组件未加载（XLSX 不可用）');
    }
    const aoa = [];
    if (Array.isArray(headers)) aoa.push(headers);
    (Array.isArray(rows) ? rows : []).forEach((row) => aoa.push(row));

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (Array.isArray(headers)) ws['!cols'] = columnWidths(headers, rows || []);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || 'Sheet1').slice(0, 31));

    const extra = opts && Array.isArray(opts.extraSheets) ? opts.extraSheets : [];
    extra.forEach((sheet) => {
      if (!sheet || !Array.isArray(sheet.aoa)) return;
      const ws2 = XLSX.utils.aoa_to_sheet(sheet.aoa);
      XLSX.utils.book_append_sheet(wb, ws2, String(sheet.name || '说明').slice(0, 31));
    });

    // 不用 XLSX.writeFile：它内部的保存逻辑与其它导出不一致，
    // 这里统一走 downloadBlob（<a download>），浏览器 / Electron / Tauri 行为一致。
    const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(
      new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      filename
    );
  }

  /** 文件名时间戳：YYYYMMDD */
  function fileDate(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  window.ExportUtils = {
    csvCell,
    toCsv,
    downloadBlob,
    downloadText,
    downloadCsv,
    downloadJson,
    downloadXlsx,
    fileDate,
  };

})();
