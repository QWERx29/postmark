#!/usr/bin/env pwsh
<#
  Tauri 构建脚本（Windows）
  =========================
  为什么需要它而不是直接 cargo build
  ----------------------------------
  本机受限会话下 schannel 拿不到凭证句柄（SEC_E_NO_CREDENTIALS），
  cargo 无法完成任何 HTTPS 请求。因此构建前必须先起一个**明文 HTTP 的本地
  registry**（由 Node 代做 TLS），并给 cargo 指好工具链路径。

  在**正常网络环境**（schannel 可用）下不需要这些绕行：
  删掉 src-tauri/.cargo/config.toml 里的 [source] 替换，直接
  `cargo build --release` 即可，本脚本的 registry 部分会被自动跳过。

  用法:
    pwsh -File scripts/dev-build-tauri.ps1              # 构建 release exe
    pwsh -File scripts/dev-build-tauri.ps1 -Bundle      # 另外打 NSIS 安装包
    pwsh -File scripts/dev-build-tauri.ps1 -SkipStage   # 不重新暂存资源
#>
param(
  [switch]$Bundle,
  [switch]$SkipStage
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$SrcTauri = Join-Path $Root 'src-tauri'
$RustDir = Join-Path $Root '.rust'
$RegistryPort = 19780

# ---- 工具链固定放在项目内，不依赖用户级安装 ----
$env:CARGO_HOME = Join-Path $RustDir 'cargo'
$env:RUSTUP_HOME = Join-Path $RustDir 'rustup'
$env:CARGO_TARGET_DIR = Join-Path $RustDir 'target'
$env:TMP = Join-Path $RustDir 'tmp'
$env:TEMP = $env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"

$cargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
if (-not (Test-Path $cargo)) {
  Write-Error "找不到 cargo: $cargo`n请先安装 Rust 工具链到 $RustDir（见 README 的 Tauri 一节）。"
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' 构建 Tauri 外壳' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan

# ---- 1. 暂存资源（node.exe + 应用本体）----
if (-not $SkipStage) {
  Write-Host "`n[1/3] 暂存资源..." -ForegroundColor Yellow
  & node (Join-Path $PSScriptRoot 'stage-tauri-resources.js')
  if ($LASTEXITCODE -ne 0) { Write-Error '资源暂存失败' }
} else {
  Write-Host "`n[1/3] 跳过资源暂存（-SkipStage）" -ForegroundColor DarkGray
}

# ---- 2. 确保本地 registry 在跑（schannel 不可用时的唯一出路）----
Write-Host "`n[2/3] 检查本地 registry..." -ForegroundColor Yellow
$registryProc = $null
$alreadyUp = $false
try {
  $probe = Invoke-WebRequest "http://127.0.0.1:$RegistryPort/config.json" -UseBasicParsing -TimeoutSec 3
  $alreadyUp = $probe.StatusCode -eq 200
} catch { $alreadyUp = $false }

if ($alreadyUp) {
  Write-Host "      已有 registry 在 $RegistryPort 监听，复用。" -ForegroundColor Green
} else {
  Write-Host "      启动 registry（Node 代做 TLS，绕过 schannel）..." -ForegroundColor Green
  $registryProc = Start-Process -FilePath 'node' `
    -ArgumentList (Join-Path $PSScriptRoot 'dev-local-registry.js'), "--port=$RegistryPort" `
    -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ($registryProc.HasExited) {
    Write-Error "registry 启动失败，退出码 $($registryProc.ExitCode)"
  }
}

try {
  # ---- 3. 构建 ----
  Write-Host "`n[3/3] cargo build --release..." -ForegroundColor Yellow
  Push-Location $SrcTauri
  try {
    if ($Bundle) {
      # 需要 tauri-cli：cargo install tauri-cli 或使用 npx @tauri-apps/cli
      & $cargo tauri build 2>&1 | Write-Host
    } else {
      & $cargo build --release 2>&1 | Write-Host
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "构建失败，退出码 $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $exe = Join-Path $env:CARGO_TARGET_DIR 'release\postmark.exe'
  if (Test-Path $exe) {
    $mb = [math]::Round((Get-Item $exe).Length / 1MB, 2)
    Write-Host "`n构建成功: $exe ($mb MB)" -ForegroundColor Green
    Write-Host "直接运行前，请把 resources\ 放到 exe 同级："
    Write-Host "  copy-item '$SrcTauri\resources' '$env:CARGO_TARGET_DIR\release\resources' -Recurse -Force"
  }
} finally {
  if ($registryProc -and -not $registryProc.HasExited) {
    Write-Host "`n停止 registry (PID $($registryProc.Id))..." -ForegroundColor DarkGray
    Stop-Process -Id $registryProc.Id -Force -ErrorAction SilentlyContinue
  }
}
