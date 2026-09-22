/**
 * Electron 预加载脚本
 * =================
 * 通过 contextBridge 安全地向渲染进程暴露 Node.js 能力。
 * 当前预留扩展点，未来可在此添加：
 *   - 原生文件对话框
 *   - 系统通知
 *   - 自动更新检测
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,
  // 是否在 Electron 环境中
  isElectron: true,
});
