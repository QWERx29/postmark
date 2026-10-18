//! Tauri 构建脚本
//!
//! tauri::generate_context!() 需要 build script 提供 OUT_DIR 并校验
//! tauri.conf.json（图标、资源清单等）。缺了本文件会在编译期直接报
//! "OUT_DIR env var is not set, do you have a build script?"。

fn main() {
    tauri_build::build()
}
