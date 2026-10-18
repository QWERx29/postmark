// 发布版不弹控制台窗口；调试版保留，方便看 Node 服务器的日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 新一代日戳管理系统 — Tauri 2 外壳
//! ====================================
//! 职责刻意压到最小：拉起已存在的 Node 服务器，然后把窗口指向它。
//! 之所以能这么薄，是因为服务器逻辑早已从 Electron 的 main.js 抽到 server.js，
//! 与外壳完全解耦 —— 换外壳不需要碰任何业务代码。
//!
//! 窗口加载的是 **http://127.0.0.1:19876**，而不是 Tauri 的自定义协议。
//! 这一点是刚需：Local Storage 按 origin 隔离，只有让页面跑在真正的
//! http://127.0.0.1:19876 上，既有记录才是可见的；用 tauri:// 之类的
//! 自定义协议会得到另一个 origin，数据会"变成空的"。

mod server;

use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() -> Result<()> {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();

            // ---- 路径解析 ----
            // 必须在创建窗口之前取 app_local_data_dir()：
            // Tauri 会用它（而非我们自己拼的路径）设置 WebView2 的
            // user data 目录，所以我们算出来的必须和它将要用的保持一致。
            let local_data = handle
                .path()
                .app_local_data_dir()
                .context("无法确定应用数据目录")?;

            // WebView2 的 profile 根目录就在 app_local_data_dir() 下，
            // 显式设置一遍，避免将来 Tauri 改变默认值导致数据"搬家"。
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &local_data);

            let resource_dir = server::normalize_resource_dir(
                &handle.path().resource_dir().context("无法确定资源目录")?,
            );

            // 产出目录：随包分发的 app 目录是只读的，所以必须指到可写位置。
            // 这里只把"打算用哪个目录"告诉 Node，**不自己强行创建**：
            //   - server.js 的 resolveOutputDir() 本就有多级回退（不可写就换下一个），
            //     强行 mkdir 失败反而会让整个应用起不来 —— 一个非必需目录
            //     不该有这样的杀伤力；
            //   - 由 Node 统一决定，两边的判断逻辑不会分叉。
            let output_dir: PathBuf = local_data.join("output");
            if let Err(e) = std::fs::create_dir_all(&output_dir) {
                // 仅提示：Node 侧还会再试，失败也有回退
                eprintln!(
                    "[tauri] 提示: 无法创建产出目录 {}（{}），交由 Node 侧回退处理",
                    output_dir.display(),
                    e
                );
            }

            println!("[tauri] 数据目录   : {}", local_data.display());
            println!("[tauri] 资源目录   : {}", resource_dir.display());
            println!("[tauri] 产出目录   : {}", output_dir.display());

            // ---- 拉起服务器 ----
            let server = server::start(&resource_dir, &output_dir)?;
            println!(
                "[tauri] 服务器{}: {}",
                if server.reused() { "（复用已有实例）" } else { "" },
                server.url()
            );

            // ---- 建窗口 ----
            let url = server.url();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("新一代日戳管理系统")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .center()
                .build()
                .context("创建主窗口失败")?;

            // 交给 Tauri 托管：应用退出时 ServerHandle::drop 会结束 node 进程。
            app.manage(server);

            Ok(())
        })
        .run(tauri::generate_context!())
        .context("Tauri 应用启动失败")?;

    Ok(())
}
