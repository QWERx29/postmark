/**
 * 无头浏览器测试助手
 * ==================
 * test-image-core.js / test-image-e2e.js 共用的「把页面跑起来并取回结果」逻辑。
 *
 * 为什么值得单独抽出来
 * --------------------
 * 在 Windows 上把浏览器跑起来这件事有三个坑，踩过一次就够了：
 *
 *   1. **不能用管道接浏览器输出**。受限环境下给子进程开命名管道会直接 EPERM；
 *      而 Chrome 的 `--dump-dom` 输出动辄几十 KB，用管道又可能写满缓冲区后卡死。
 *      → 做法：把 stdout 直接重定向到文件描述符，Node 完全不参与搬运。
 *
 *   2. **不能等进程退出**。Chrome 会拉起 crashpad / 更新服务 / GCM 等后台进程，
 *      主进程迟迟不退，`spawnSync` 只能干等到超时（之前就是这么卡住的）。
 *      → 做法：轮询输出文件，拿到结果立刻收工，剩下的进程自己会走。
 *
 *   3. **必须给独立的 user-data-dir**。否则第二次运行会把命令交给已存在的实例，
 *      新进程立刻退出、什么也不产出。
 *
 * 用法
 * ----
 *   const { findBrowser, runPage } = require('./_lib/browser-test.js');
 *   const exe = findBrowser();
 *   const html = await runPage(exe, url, { workDir });
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 常见的 Chrome / Edge 安装位置 */
function browserCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
}

/**
 * 找一个可用的浏览器。
 * @param {string} [explicit] 显式路径（--browser=... 传进来的）
 * @returns {string} 找不到返回 ''
 */
function findBrowser(explicit) {
  if (explicit) return explicit;
  if (process.env.POSTMARK_BROWSER_EXE) return process.env.POSTMARK_BROWSER_EXE;
  for (const exe of browserCandidates()) {
    try { if (fs.existsSync(exe)) return exe; } catch (e) { /* 继续 */ }
  }
  return '';
}

/** 建一个临时工作目录（含独立的浏览器 profile） */
function makeWorkDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'postmark-browser-') + '-'));
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  return dir;
}

/**
 * 用无头浏览器打开页面，返回最终的 DOM 文本。
 *
 * @param {string} exe    浏览器可执行文件
 * @param {string} url    页面地址（需带 withResultMarker() 生成的 ?r=）
 * @param {{workDir?:string, timeoutMs?:number, virtualTimeMs?:number, marker?:string}} [opts]
 *        marker 覆盖从 url 推导出的结果标记（一般不用传）
 * @returns {Promise<string>} DOM 文本
 */
function runPage(exe, url, opts) {
  const o = opts || {};
  const workDir = o.workDir || makeWorkDir('postmark-browser');
  const outFile = path.join(workDir, 'dom.html');
  const errFile = path.join(workDir, 'browser-stderr.log');
  const profileDir = path.join(workDir, 'profile');
  // 没显式给标记就从 ?r= 取（withResultMarker 生成的），保证每次运行都不同
  const marker = o.marker || (() => {
    const m = /[?&]r=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : '';
  })();
  if (!marker) throw new Error('runPage 需要一个结果标记：请用 withResultMarker() 拼 url');
  // 必须等**结束**标记：--dump-dom 是边写边出的，只等开始标记会拿到半截 JSON
  const doneMarker = `@@R:${marker}:END`;
  const timeoutMs = o.timeoutMs || 240000;

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-crash-reporter',
    // 把页面的 console 错误也带到 stderr：页面脚本没跑完时，
    // 这是唯一能直接看到原因的地方（--dump-dom 只会给出一份静态 HTML）
    '--enable-logging=stderr',
    '--v=0',
    '--user-data-dir=' + profileDir,
    // 虚拟时间预算给得很大：它一旦用尽 Chrome 就直接退出，页面哪怕还在算也会被砍掉。
    // 图片测试里有大量 canvas 像素运算（锐化是逐像素卷积），耗的是真时间。
    '--virtual-time-budget=' + (o.virtualTimeMs || 600000),
    '--dump-dom',
    url,
  ];

  // 关键：stdout 直接落到文件描述符，既不走管道也不经过 Node
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  let child;
  try {
    child = spawn(exe, args, {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      detached: false,
    });
  } finally {
    // 子进程已经拿到句柄，父进程这边可以关掉了
    try { fs.closeSync(outFd); } catch (e) { /* ignore */ }
    try { fs.closeSync(errFd); } catch (e) { /* ignore */ }
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    /**
     * 收拾现场：结果一旦到手就收工。
     *
     * 先 stop() 再用 setTimeout 杀进程，是因为 --dump-dom 的写入和
     * 浏览器退出是并发的：拿到标记后立刻 kill，Chrome 可能把文件又改回
     * 半截状态。所以标记一出现就**把内容读进内存**，后面文件怎么写都不影响。
     */
    const cleanup = () => {
      setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 3000);
      const stderr = (() => {
        try { return fs.readFileSync(errFile, 'utf8'); } catch (e) { return ''; }
      })();
      // 只留下真正有用的报错，Chrome 的 libpng / 网络噪音太吵
      return stderr
        .split(/\r?\n/)
        .filter((l) => l && !/libpng|registration_request|XNNPACK|update_service_dialer|DEPRECATED|GroupMarkerNotSet|gpu_|voice_transcription|Fontconfig/i.test(l))
        // 页面自己的 console 输出优先
        .sort((a, b) => (/CONSOLE|Uncaught|SyntaxError|ReferenceError|TypeError/.test(b) ? 1 : 0)
                      - (/CONSOLE|Uncaught|SyntaxError|ReferenceError|TypeError/.test(a) ? 1 : 0))
        .slice(0, 10)
        .join('\n');
    };

    const finish = (fn, ok, payload) => {
      if (settled) return;
      settled = true;
      const noise = cleanup();
      if (ok) {
        fn(payload);
        return;
      }
      const tail = payload.length > 4000 ? payload.slice(-4000) : payload;
      fn(new Error(`${payload}\n--- 浏览器输出尾部 ---\n${tail}\n--- 浏览器报错 ---\n${noise}`));
    };

    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (settled) return;
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (e) { text = ''; }
      const mark = text.indexOf(doneMarker);
      if (mark >= 0) {
        // 立刻把快照读进内存并落一份副本，之后文件被改也不影响
        const snapshot = text.slice(0, mark + doneMarker.length);
        try { fs.writeFileSync(path.join(workDir, 'dom-snapshot.html'), snapshot, 'utf8'); } catch (e) { /* ignore */ }
        finish(resolve, true, snapshot);
        return;
      }
      if (Date.now() > deadline) {
        finish(reject, false, `等待浏览器产出结果超时（${Math.round(timeoutMs / 1000)}s）`);
        return;
      }
      setTimeout(tick, 250);
    };

    child.once('error', (e) => finish(reject, false, `无法启动浏览器: ${e.message}`));
    tick();
  });
}

/**
 * 从 DOM 文本里取出页面写进 #result 的 JSON。
 *
 * 约定：页面把结果包在 `@@R:<标记>` … `@@R:<标记>:END` 之间
 * （标记由 withResultMarker() 生成并经 ?r= 传入）。两侧拼接规则必须一致，
 * 所以前缀常量在这里和页面里都写成同一个字面量。
 */
function extractJson(dom, marker) {
  if (!marker) return null;
  const wrapper = `@@R:${marker}`;
  const start = dom.indexOf(wrapper);
  if (start < 0) return null;
  const end = dom.indexOf(`${wrapper}:END`, start + wrapper.length);
  if (end < 0) return null;
  try {
    return JSON.parse(dom.slice(start + wrapper.length, end));
  } catch (e) {
    return null;
  }
}

/** 打印一组 {name, ok, detail} 结果，返回失败数 */
function report(results) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  [ok]   ${r.name}${r.detail ? `  → ${r.detail}` : ''}`);
    } else {
      failed++;
      console.log(`  [FAIL] ${r.name}\n         ${r.detail}`);
    }
  }
  return failed;
}

/**
 * 生成一个每次运行都不同的结果标记，并拼到 url 上。
 *
 * 为什么不能用固定字符串
 * ----------------------
 * 页面脚本里必然写着那个标记字面量，而 `--dump-dom` 的输出是**边生成边写**的：
 * 轮询到文件里出现该字符串时，可能只是脚本源码已经写出来了、结果还没追加 ——
 * 于是拿到一份「结果仍是 RUNNING」的半成品，而且时好时坏。
 * 把标记做成运行时随机串，它就只能来自页面真正写完的那一刻。
 *
 * @param {string} url
 * @returns {{url:string, marker:string}}
 */
function withResultMarker(url) {
  // 只用字母数字：避免页面与 Node 两侧在拼接前缀时出现 @@ / 转义之类的不一致
  const marker = `RESULT${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const sep = url.includes('?') ? '&' : '?';
  return { url: `${url}${sep}r=${marker}`, marker };
}

module.exports = {
  browserCandidates,
  findBrowser,
  makeWorkDir,
  withResultMarker,
  runPage,
  extractJson,
  report,
};
