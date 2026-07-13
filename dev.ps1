# OmniTerm 启动脚本（Windows PowerShell 原生版）
# 用法: .\dev.ps1 {start|stop|restart|status|logs}
# 与 dev.sh 功能对齐，但使用 Windows 原生进程管理（无 WSL / Git Bash 依赖）。
#
# 前置依赖:
#   - Rust + Cargo (https://rustup.rs)
#   - Node + pnpm (https://pnpm.io)
#   - PowerShell 5.1+ (Windows 10/11 自带) 或 PowerShell 7+

$ErrorActionPreference = 'Stop'

$PROJECT_DIR = $PSScriptRoot
$ENV_FILE = Join-Path $PROJECT_DIR '.env.local'

# ── 读取分支配置（.env.local 为纯 KEY=VALUE，# 开头为注释）──
$BACKEND_PORT      = 9075
$FRONTEND_PORT     = 9076
$DOCKER_PORT       = $BACKEND_PORT
$DOCKER_PORT_MAPPING = "$BACKEND_PORT`:$BACKEND_PORT"
$BRANCH_NAME       = 'main'
$BRANCH_BINARY_NAME = 'omniterm-main'
$DOMAIN            = 'localhost'

if (Test-Path $ENV_FILE) {
    foreach ($line in (Get-Content $ENV_FILE)) {
        $line = $line.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            switch ($key) {
                'BACKEND_PORT'        { $BACKEND_PORT = $val }
                'FRONTEND_PORT'       { $FRONTEND_PORT = $val }
                'DOCKER_PORT'         { $DOCKER_PORT = $val }
                'DOCKER_PORT_MAPPING' { $DOCKER_PORT_MAPPING = $val }
                'BRANCH_NAME'         { $BRANCH_NAME = $val }
                'BRANCH_BINARY_NAME'  { $BRANCH_BINARY_NAME = $val }
                'DOMAIN'              { $DOMAIN = $val }
            }
        }
    }
}

$PID_DIR   = Join-Path $PROJECT_DIR '.dev'
$BACKEND_PID  = Join-Path $PID_DIR 'backend.pid'
$FRONTEND_PID = Join-Path $PID_DIR 'frontend.pid'
$BACKEND_LOG  = Join-Path $PID_DIR 'backend.log'
$FRONTEND_LOG = Join-Path $PID_DIR 'frontend.log'

# ── 颜色输出 ──
function info($msg)    { Write-Host "[INFO]   $msg" -ForegroundColor Cyan }
function ok($msg)      { Write-Host "[OK]     $msg" -ForegroundColor Green }
function warn($msg)    { Write-Host "[WARN]   $msg" -ForegroundColor Yellow }
function err($msg)     { Write-Host "[ERROR]  $msg" -ForegroundColor Red }
function section($msg) { Write-Host "`n── $msg ──" -ForegroundColor White }
function divider()     { Write-Host '──────────────────────────────────────────────────' -ForegroundColor Cyan }

# ── 辅助函数 ──
function Test-PortListening($port) {
    try {
        return ($null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue))
    } catch {
        return $false
    }
}

function Get-PidByPort($port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { return $conn.OwningProcess }
    } catch {}
    return $null
}

function Test-IsRunning($pidFile) {
    if (Test-Path $pidFile) {
        $pid = (Get-Content $pidFile -Raw).Trim()
        if ($pid -match '^\d+$') {
            try {
                $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
                if ($p) { return $true }
            } catch {}
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    return $false
}

# 递归收集一个进程及其所有子孙进程的 PID
function Get-ProcessTree($rootPid) {
    $all = @()
    $map = @{}
    try {
        foreach ($p in Get-CimInstance Win32_Process) {
            if ($p.ParentProcessId) {
                if (-not $map.ContainsKey($p.ParentProcessId)) { $map[$p.ParentProcessId] = @() }
                $map[$p.ParentProcessId] += $p.ProcessId
            }
        }
    } catch {}

    $stack = @([int]$rootPid)
    while ($stack.Count -gt 0) {
        $cur = $stack[0]
        $stack = $stack[1..($stack.Count - 1)]
        if ($all -contains $cur) { continue }
        $all += $cur
        if ($map.ContainsKey($cur)) {
            foreach ($child in $map[$cur]) { $stack += $child }
        }
    }
    return $all
}

function Stop-ByPid($pidFile, $name) {
    if (Test-IsRunning $pidFile) {
        $pid = [int](Get-Content $pidFile -Raw).Trim()
        info "停止 $name (PID $pid) ..."
        foreach ($p in (Get-ProcessTree $pid)) {
            try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        ok "$name 已停止 (PID $pid)"
        return $true
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    return $false
}

function Stop-PortOrphans($port, $name) {
    $pid = Get-PidByPort $port
    if ($pid) {
        warn "$name 端口 :$port 仍有残留进程 PID $pid"
        foreach ($p in (Get-ProcessTree $pid)) {
            try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; info "  已清理残留 PID $p" } catch {}
        }
        Start-Sleep -Milliseconds 500
        return $true
    }
    return $false
}

# 清理本目录下的孤儿 cargo / vite 进程（匹配命令行 + 工作目录）
function Clear-Orphans {
    $protected = @()
    foreach ($f in @($BACKEND_PID, $FRONTEND_PID)) {
        if (Test-Path $f) {
            $pid = (Get-Content $f -Raw).Trim()
            if ($pid -match '^\d+$') { $protected += [int]$pid }
        }
    }
    foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT)) {
        $pid = Get-PidByPort $port
        if ($pid) { $protected += [int]$pid }
    }

    $orphans = @()
    try {
        foreach ($p in Get-CimInstance Win32_Process) {
            $cmd = $p.CommandLine
            if (-not $cmd) { continue }
            if ($cmd -notmatch 'vite[\\/]bin[\\/]vite.js' -and $cmd -notmatch 'target[\\/]debug[\\/]omniterm') { continue }
            try { $cwd = $p.WorkingDirectory } catch { $cwd = '' }
            if ($cwd -ne $PROJECT_DIR -and $cwd -ne (Join-Path $PROJECT_DIR 'frontend')) { continue }
            $pid = [int]$p.ProcessId
            if ($protected -contains $pid) { continue }
            $orphans += $pid
        }
    } catch {}

    if ($orphans.Count -gt 0) {
        warn "发现孤儿进程: $($orphans -join ', ')"
        foreach ($p in $orphans) {
            foreach ($t in (Get-ProcessTree $p)) {
                try { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
        Start-Sleep -Milliseconds 500
        ok "孤儿进程已清理"
    }
}

# ── 前置检查 ──
function Test-Prerequisites {
    $missing = @()
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += 'cargo (Rust)' }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue))  { $missing += 'pnpm' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue))  { $missing += 'node' }

    if ($missing.Count -gt 0) {
        err "缺少依赖: $($missing -join ', ')"
        Write-Host ""
        Write-Host "  安装提示:"
        Write-Host "    Rust + Cargo:  https://rustup.rs"
        Write-Host "    Node + pnpm:   https://pnpm.io (或 npm i -g pnpm)"
        return $false
    }
    return $true
}

# 等待端口就绪
function Wait-Port($port, $timeoutSec = 30) {
    $elapsed = 0
    info "等待端口 :$port 就绪 ..."
    while (-not (Test-PortListening $port)) {
        Start-Sleep -Seconds 1
        $elapsed++
        if ($elapsed -ge $timeoutSec) {
            err "端口 :$port 在 ${timeoutSec}s 内未就绪"
            return $false
        }
        if ($elapsed % 5 -eq 0) { info "  仍在等待 :$port ... (${elapsed}s)" }
    }
    return $true
}

# ── 命令: start ──
function Start-Services {
    Write-Host ""
    info "OmniTerm 启动中 ..."
    divider

    if (-not (Test-Prerequisites)) { exit 1 }

    if (-not (Test-Path $PID_DIR)) { New-Item -ItemType Directory -Path $PID_DIR | Out-Null }
    Clear-Orphans

    # 端口冲突检查
    $conflict = $false
    foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT)) {
        if (Test-PortListening $port) {
            err "端口 $port 已被占用:"
            $pid = Get-PidByPort $port
            if ($pid) { err "  PID $pid ($( (Get-Process -Id $pid -ErrorAction SilentlyContinue).Name ))" }
            $conflict = $true
        }
    }
    if ($conflict) {
        Write-Host ""
        err "请先释放端口: .\dev.ps1 stop  或手动结束进程"
        exit 1
    }

    # ── 后端 ──
    section "启动后端"
    info "编译并启动 (端口 $BACKEND_PORT) ..."
    # Start-Process -Environment 会完全替换子进程环境，故需继承当前会话
    # 的环境变量（尤其 PATH / HOME / USERPROFILE / TMP），再叠加自定义变量。
    $backendEnv = @{}
    foreach ($k in (Get-ChildItem Env:).Name) { $backendEnv[$k] = [string](Get-Item Env:$k).Value }
    $backendEnv['BIND_ADDR'] = "127.0.0.1:$BACKEND_PORT"
    $backendEnv['RUST_LOG']  = if ($env:RUST_LOG) { $env:RUST_LOG } else { 'omniterm_main=info,omniterm_server=info' }
    $proc = Start-Process -FilePath 'cargo' -ArgumentList 'run' `
        -WorkingDirectory $PROJECT_DIR -Environment $backendEnv `
        -RedirectStandardOutput $BACKEND_LOG -RedirectStandardError $BACKEND_LOG `
        -PassThru -WindowStyle Hidden
    $proc.Id | Out-File -FilePath $BACKEND_PID -NoNewline

    if (Wait-Port $BACKEND_PORT 120) {
        $bpid = Get-PidByPort $BACKEND_PORT
        if ($bpid) { $bpid | Out-File -FilePath $BACKEND_PID -NoNewline }
        ok "后端已就绪  PID=$bpid  ->  http://localhost:$BACKEND_PORT"
    } else {
        err "后端启动失败，最后 20 行日志:"
        Write-Host ""
        if (Test-Path $BACKEND_LOG) { Get-Content $BACKEND_LOG -Tail 20 } else { Write-Host "  (无日志输出)" }
        Write-Host ""
        err "完整日志: $BACKEND_LOG"
        exit 1
    }

    # ── 前端 ──
    section "启动前端"
    info "安装依赖并启动 Vite (端口 $FRONTEND_PORT) ..."
    $feDir = Join-Path $PROJECT_DIR 'frontend'
    $frontendEnv = @{}
    foreach ($k in (Get-ChildItem Env:).Name) { $frontendEnv[$k] = [string](Get-Item Env:$k).Value }
    $frontendEnv['NODE_ENV'] = 'development'
    if ($env:http_proxy)  { $frontendEnv['http_proxy']  = $env:http_proxy }
    if ($env:https_proxy) { $frontendEnv['https_proxy'] = $env:https_proxy }

    # 首次或依赖缺失时自动安装
    if (-not (Test-Path (Join-Path $feDir 'node_modules'))) {
        Write-Host "[dev.ps1] node_modules 不存在，执行 pnpm install ..."
        $install = Start-Process -FilePath 'pnpm' -ArgumentList 'install' `
            -WorkingDirectory $feDir -Wait -PassThru -WindowStyle Hidden -Environment $frontendEnv
        if ($install.ExitCode -ne 0) {
            err "pnpm install 失败 (退出码 $($install.ExitCode))"
            exit 1
        }
    }

    $fproc = Start-Process -FilePath 'pnpm' -ArgumentList 'dev' `
        -WorkingDirectory $feDir -Environment $frontendEnv `
        -RedirectStandardOutput $FRONTEND_LOG -RedirectStandardError $FRONTEND_LOG `
        -PassThru -WindowStyle Hidden
    $fproc.Id | Out-File -FilePath $FRONTEND_PID -NoNewline

    if (Wait-Port $FRONTEND_PORT 120) {
        $fpid = Get-PidByPort $FRONTEND_PORT
        if ($fpid) { $fpid | Out-File -FilePath $FRONTEND_PID -NoNewline }
        ok "前端已就绪  PID=$fpid  ->  http://localhost:$FRONTEND_PORT"
    } else {
        err "前端启动失败，最后 20 行日志:"
        Write-Host ""
        if (Test-Path $FRONTEND_LOG) { Get-Content $FRONTEND_LOG -Tail 20 } else { Write-Host "  (无日志输出)" }
        Write-Host ""
        err "完整日志: $FRONTEND_LOG"
        exit 1
    }

    # ── 汇总 ──
    Write-Host ""
    divider
    Write-Host "  ● 后端 API  http://localhost:$BACKEND_PORT" -ForegroundColor Green
    Write-Host "  ● 前端 UI   http://localhost:$FRONTEND_PORT" -ForegroundColor Green
    Write-Host "  ● 分支      $BRANCH_NAME" -ForegroundColor Yellow
    divider
    Write-Host ""
}

# ── 命令: stop ──
function Stop-Services {
    Write-Host ""
    info "正在停止 OmniTerm 服务 ..."

    $stopped = 0
    if (Stop-ByPid $FRONTEND_PID '前端') { $stopped++ }
    if (Stop-PortOrphans $FRONTEND_PORT '前端') { $stopped++ }
    if (Stop-ByPid $BACKEND_PID '后端') { $stopped++ }
    if (Stop-PortOrphans $BACKEND_PORT '后端') { $stopped++ }

    if ($stopped -gt 0) {
        ok "已停止 $stopped 个服务"
    } else {
        $still = 0
        foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT)) {
            if (Test-PortListening $port) { $still++ }
        }
        if ($still -eq 0) {
            ok "无需停止，服务未运行"
        } else {
            warn "仍有 $still 个端口被占用，尝试强制清理 ..."
            foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT)) {
                $pid = Get-PidByPort $port
                if ($pid) {
                    foreach ($t in (Get-ProcessTree $pid)) {
                        try { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue; info "  已释放端口 :$port (PID $t)" } catch {}
                    }
                }
            }
        }
    }
    Write-Host ""
}

# ── 命令: restart ──
function Restart-Services {
    Write-Host ""
    info "OmniTerm 重启中 ..."
    info "第 1 步: 停止现有服务"
    Stop-Services
    Start-Sleep -Seconds 1

    $viteCache = Join-Path $PROJECT_DIR 'frontend' 'node_modules' '.vite'
    if (Test-Path $viteCache) {
        info "清理 Vite 缓存 ..."
        Remove-Item -Path $viteCache -Recurse -Force -ErrorAction SilentlyContinue
    }

    info "第 2 步: 启动服务"
    Start-Services
}

# ── 命令: status ──
function Show-Status {
    Write-Host ""
    Write-Host "OmniTerm 服务状态  ($BRANCH_NAME)" -ForegroundColor White
    divider

    if (Test-IsRunning $BACKEND_PID) {
        $bpid = (Get-Content $BACKEND_PID -Raw).Trim()
        Write-Host "  后端 :$BACKEND_PORT  ● 运行中  PID=$bpid" -ForegroundColor Green
    } elseif (Test-PortListening $BACKEND_PORT) {
        $bpid = Get-PidByPort $BACKEND_PORT
        Write-Host "  后端 :$BACKEND_PORT  ● 运行中  PID=$bpid  (pid 文件缺失)" -ForegroundColor Yellow
    } else {
        Write-Host "  后端 :$BACKEND_PORT  ○ 未运行" -ForegroundColor Red
    }

    if (Test-IsRunning $FRONTEND_PID) {
        $fpid = (Get-Content $FRONTEND_PID -Raw).Trim()
        Write-Host "  前端 :$FRONTEND_PORT  ● 运行中  PID=$fpid" -ForegroundColor Green
    } elseif (Test-PortListening $FRONTEND_PORT) {
        $fpid = Get-PidByPort $FRONTEND_PORT
        Write-Host "  前端 :$FRONTEND_PORT  ● 运行中  PID=$fpid  (pid 文件缺失)" -ForegroundColor Yellow
    } else {
        Write-Host "  前端 :$FRONTEND_PORT  ○ 未运行" -ForegroundColor Red
    }

    Write-Host ""
    if (Test-Path $BACKEND_LOG)  { Write-Host "  后端日志: $BACKEND_LOG  ($( (Get-Item $BACKEND_LOG).Length ) bytes)" }
    if (Test-Path $FRONTEND_LOG) { Write-Host "  前端日志: $FRONTEND_LOG  ($( (Get-Item $FRONTEND_LOG).Length ) bytes)" }
    divider
    Write-Host ""
}

# ── 命令: logs ──
function Show-Logs($target = 'both') {
    switch ($target) {
        'backend' { if (Test-Path $BACKEND_LOG) { info "实时查看后端日志 (Ctrl-C 退出) ..."; Get-Content -Path $BACKEND_LOG -Wait } else { err "后端日志不存在: $BACKEND_LOG" } }
        'frontend' { if (Test-Path $FRONTEND_LOG) { info "实时查看前端日志 (Ctrl-C 退出) ..."; Get-Content -Path $FRONTEND_LOG -Wait } else { err "前端日志不存在: $FRONTEND_LOG" } }
        default {
            if (Test-Path $BACKEND_LOG -or Test-Path $FRONTEND_LOG) {
                info "实时查看全部日志 (Ctrl-C 退出) ..."
                $jobs = @()
                if (Test-Path $BACKEND_LOG)  { $jobs += Start-Job -ScriptBlock { Get-Content -Path $using:BACKEND_LOG -Wait } }
                if (Test-Path $FRONTEND_LOG) { $jobs += Start-Job -ScriptBlock { Get-Content -Path $using:FRONTEND_LOG -Wait } }
                try {
                    while ($true) {
                        foreach ($job in $jobs) {
                            # 不带 -Keep：只取自上次 Receive 以来的新行，避免重复刷屏
                            $line = Receive-Job -Job $job -ErrorAction SilentlyContinue
                            if ($line) { $line | Write-Host }
                        }
                        Start-Sleep -Milliseconds 200
                    }
                } finally {
                    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
                }
            } else {
                err "无日志文件"
            }
        }
    }
}

# ── 主入口 ──
switch ($args[0]) {
    'start'   { Start-Services }
    'stop'    { Stop-Services }
    'restart' { Restart-Services }
    'status'  { Show-Status }
    'logs'    { Show-Logs $args[1] }
    { $_ -in '-h','--help','help' } {
        Write-Host ""
        Write-Host "OmniTerm 启动脚本（Windows PowerShell 原生版）"
        Write-Host ""
        Write-Host "用法: .\dev.ps1 <命令> [参数]"
        Write-Host ""
        Write-Host "命令:"
        Write-Host "  start     启动后端 + 前端开发服务器"
        Write-Host "  stop      停止所有服务"
        Write-Host "  restart   重启所有服务（含 Vite 缓存清理）"
        Write-Host "  status    查看运行状态"
        Write-Host "  logs      实时查看日志 (可选: backend | frontend)"
        Write-Host ""
        Write-Host "端口:  后端 :$BACKEND_PORT / 前端 :$FRONTEND_PORT"
        Write-Host "配置:  在 .env.local 中覆盖 BACKEND_PORT / FRONTEND_PORT"
        Write-Host ""
    }
    default {
        err "未知命令: $($args[0])"
        Write-Host "  用法: .\dev.ps1 {start|stop|restart|status|logs}"
        Write-Host "  帮助: .\dev.ps1 --help"
        exit 1
    }
}
