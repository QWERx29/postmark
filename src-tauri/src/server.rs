//! Node 本地服务器的生命周期管理
//! ================================
//! Tauri 外壳自身不实现任何业务逻辑：静态文件、/api/crawl/* 都还在原来的
//! Node 服务器里（server.js），这里只负责把它拉起来、等它就绪、退出时收掉。
//!
//! 端口策略与 launch.js 完全一致：**固定 19876，绝不随机降级**。
//! Local Storage 按 origin 隔离，端口一变就等于换了一份数据 ——
//! 因此发现端口被占用时，先判断"是不是本应用已经在跑"，而不是换端口。

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// 与 server.js / launch.js / scripts/start.js 保持一致
pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 19876;

/// 服务器最长启动等待时间。首次启动要建 output/ 目录、读 base/ 列表，
/// 但这些都是毫秒级；给足 15 秒仍无响应视为失败。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("端口 {0} 已被其它程序占用（不是本应用的实例）")]
    PortBusyByOther(u16),
    #[error("无法启动 Node 服务器: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("Node 服务器在 {0:?} 内没有就绪")]
    NotReady(Duration),
    #[error("服务器进程提前退出，退出码 {0:?}")]
    ExitedEarly(Option<i32>),
    #[error("找不到 Node 运行时: {0}")]
    NodeMissing(String),
    #[error("找不到 server.js: {0}")]
    ServerScriptMissing(String),
}

/// 尝试连接端口，判断是否有进程在监听
fn port_in_use() -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), PORT);
    TcpStream::connect_timeout(&SocketAddr::from(addr), Duration::from_millis(500)).is_ok()
}

/// 端口上是否已经有**本应用**在响应。
/// 只判端口不够：别的程序也可能占着 19876，那样应该报错而不是把窗口指过去。
fn existing_instance_serves_app() -> bool {
    use std::io::{Read, Write};

    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), PORT);
    let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::from(addr), Duration::from_millis(800))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET /api/crawl/provinces HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    if stream.read_to_string(&mut buf).is_err() {
        return false;
    }
    // provinces 接口返回省份名数组；用它当"这是本应用"的指纹
    buf.contains("200") && buf.contains("北京")
}

/// 去掉 Windows 扩展长度路径前缀 `\\?\`（UNC 则为 `\\?\UNC\`）。
///
/// 为什么必须做：`tauri::Manager::path().resource_dir()` 在 Windows 上会返回
/// `\\?\E:\...` 形式的路径。Rust 自己的 is_file()/join() 能正常处理，但把它
/// 交给 Node 当参数时，Node 的 realpathSync 会把 `E:` 当成目录而抛
///   Error: EISDIR: illegal operation on a directory, lstat 'E:'
/// 于是服务器根本起不来。这个坑只在真机运行时才会显现。
fn strip_extended_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 规范化资源目录：去掉 Windows 扩展长度前缀。
/// 供 main.rs 在拿到 resource_dir() 后立刻调用。
pub fn normalize_resource_dir(dir: &Path) -> PathBuf {
    strip_extended_prefix(dir)
}

/// 解析 node 可执行文件的位置。
///
/// 优先用随包分发的 node（resources/node/node.exe），这样最终用户不需要
/// 自己装 Node；找不到才退回 PATH 里的 node，方便开发期调试。
fn resolve_node(resource_dir: &Path) -> Result<PathBuf, ServerError> {
    // 与 server.js 同理：打包后 resource_dir() 已经是 \resources，
    // 开发运行时则是 exe 目录、资源在其下的 resources\ 里。两个位置都查。
    let candidates = [
        resource_dir.join("node").join("node.exe"),
        resource_dir.join("resources").join("node").join("node.exe"),
    ];
    for bundled in candidates.iter() {
        if bundled.is_file() {
            return Ok(bundled.clone());
        }
    }

    // 开发期兜底：PATH 里的 node
    if Command::new("node").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok() {
        return Ok(PathBuf::from("node"));
    }

    Err(ServerError::NodeMissing(
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" 或 "),
    ))
}

/// 已接管的服务器进程。Drop 时自动结束子进程，避免退出后残留 node.exe。
pub struct ServerHandle {
    /// 本进程启动的服务器；复用已有实例时为 None（不能去杀别人的进程）
    child: Option<Child>,
}

impl ServerHandle {
    /// 本次是否复用了已在运行的实例（而非自己启动）
    pub fn reused(&self) -> bool {
        self.child.is_none()
    }

    /// 交给 WebView2 加载的地址
    pub fn url(&self) -> String {
        format!("http://{HOST}:{PORT}")
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            // kill() 只结束这一个进程；Node 侧没有 fork 子进程，足够了。
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 拉起服务器（或复用已有实例），返回时就绪可访问。
///
/// * `resource_dir` —— 打包后的资源根目录（含 node/、app/）
/// * `output_dir`   —— 爬虫产出目录。打包后 app 目录是只读的，
///                     必须指向可写位置，否则爬取作业会静默失败。
pub fn start(resource_dir: &Path, output_dir: &Path) -> Result<ServerHandle, ServerError> {
    // ---- 已有实例？ ----
    if port_in_use() {
        if existing_instance_serves_app() {
            // 本应用已经在跑：不再起第二个服务器，只把窗口指过去。
            return Ok(ServerHandle { child: None });
        }
        return Err(ServerError::PortBusyByOther(PORT));
    }

    // ---- 定位 node 与 server.js ----
    let node = resolve_node(resource_dir)?;

    // 资源根目录在"开发运行"和"打包安装"两种情况下不是同一个位置：
    //   - 打包后：resource_dir() = <安装目录>\resources，资源直接在其下
    //   - 开发运行（cargo build 后直接跑 exe）：resource_dir() = <exe目录>，
    //     而 Tauri 约定的资源位于 <exe目录>\resources
    // 因此两个候选都要认，否则会出现"打包能用、直接跑 exe 却找不到 server.js"。
    let candidates = [
        resource_dir.join("resources").join("app").join("server.js"),
        resource_dir.join("app").join("server.js"),
    ];
    let script = candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| ServerError::ServerScriptMissing(
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" 或 "),
        ))?;

    // ---- 启动 ----
    // cwd 设成 app 目录：server.js 以 __dirname 为 root 解析静态文件与 base/，
    // 同时 node_modules（iconv-lite）也在那里。
    let app_dir = script.parent().unwrap_or(resource_dir);
    let mut child = Command::new(&node)
        .arg(&script)
        .arg(format!("--port={PORT}"))
        .arg(format!("--host={HOST}"))
        .current_dir(app_dir)
        .env("POSTMARK_OUTPUT_DIR", output_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(ServerError::Spawn)?;

    // ---- 等就绪 ----
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if existing_instance_serves_app() {
            return Ok(ServerHandle { child: Some(child) });
        }
        // 子进程已经死了就别再等
        if let Ok(Some(status)) = child.try_wait() {
            return Err(ServerError::ExitedEarly(status.code()));
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    Err(ServerError::NotReady(STARTUP_TIMEOUT))
}
