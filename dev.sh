#!/usr/bin/env bash
# OmniTerm 启动脚本（所有分支通用）
# 用法: ./dev.sh {start|stop|restart|status|logs}

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 本地分支配置（.env.local 已在 .gitignore，不会被 merge 覆盖）
# 这是分支专属变量的唯一来源（端口/域名/版本/binary 名等）
[[ -f "$PROJECT_DIR/.env.local" ]] && source "$PROJECT_DIR/.env.local"

# 端口 fallback（仅在 .env.local 缺失时生效，正常 worktree 不会有此情况）
BACKEND_PORT=${BACKEND_PORT:-9075}
FRONTEND_PORT=${FRONTEND_PORT:-9076}
DOCKER_PORT=${DOCKER_PORT:-$BACKEND_PORT}
DOCKER_PORT_MAPPING=${DOCKER_PORT_MAPPING:-${DOCKER_PORT}:${DOCKER_PORT}}
BRANCH_NAME=${BRANCH_NAME:-main}
BRANCH_BINARY_NAME=${BRANCH_BINARY_NAME:-omniterm-main}
BRANCH_VERSION=${BRANCH_VERSION:-0.0.0}
DOMAIN=${DOMAIN:-localhost}
export BACKEND_PORT FRONTEND_PORT DOCKER_PORT DOCKER_PORT_MAPPING
export BRANCH_NAME BRANCH_BINARY_NAME BRANCH_VERSION DOMAIN
PID_DIR="$PROJECT_DIR/.dev"
BACKEND_PID="$PID_DIR/backend.pid"
FRONTEND_PID="$PID_DIR/frontend.pid"
BACKEND_LOG="$PID_DIR/backend.log"
FRONTEND_LOG="$PID_DIR/frontend.log"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}    $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}      $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}    $*"; }
err()     { echo -e "${RED}[ERROR]${NC}   $*"; }
section() { echo -e "\n${BOLD}── $* ──${NC}\n"; }
divider() { echo -e "${CYAN}──────────────────────────────────────────────────${NC}"; }

# ── 辅助函数 ──
is_running() {
    local pid_file="$1"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$pid_file"
    fi
    return 1
}

port_listening() {
    local port=$1
    ss -tlnp 2>/dev/null | grep -q ":${port} "
}

port_info() {
    local port=$1
    ss -tlnp 2>/dev/null | grep ":${port} " | head -3 || echo "  (无法获取详细信息)"
}

wait_port() {
    local port=$1 timeout=${2:-30}
    local elapsed=0
    info "等待端口 :$port 就绪 ..."
    while ! port_listening "$port"; do
        sleep 0.5
        elapsed=$((elapsed + 1))
        if [[ $elapsed -ge $((timeout * 2)) ]]; then
            err "端口 :$port 在 ${timeout}s 内未就绪"
            return 1
        fi
        # 每 5 秒显示一次进度
        if [[ $((elapsed % 10)) -eq 0 ]]; then
            info "  仍在等待 :$port ... ($(( elapsed / 2 ))s)"
        fi
    done
    return 0
}

kill_by_pid() {
    local pid_file="$1" name="$2" port="${3:-}"
    if is_running "$pid_file"; then
        local pid
        pid=$(cat "$pid_file")
        info "停止 $name (PID $pid) ..."
        kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 10 ]]; do
            sleep 0.5
            waited=$((waited + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "$name 未响应，发送 SIGKILL ..."
            kill -9 "$pid" 2>/dev/null || true
            sleep 0.5
        fi
        rm -f "$pid_file"
        ok "$name 已停止 (PID $pid)"
        return 0
    else
        rm -f "$pid_file"
        return 1
    fi
}

kill_port_orphans() {
    local port=$1 name="$2"
    local orphans
    orphans=$(ss -tlnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u || true)
    if [[ -n "$orphans" ]]; then
        warn "$name 端口 :$port 仍有残留进程: $orphans"
        for opid in $orphans; do
            kill -9 "$opid" 2>/dev/null && info "  已清理残留 PID $opid" || true
        done
        sleep 0.5
        return 0
    fi
    return 1
}

pid_by_port() {
    local port=$1
    ss -tlnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true
}

cleanup_orphans() {
    local protected_pids=()
    local p
    for p in $(cat "$BACKEND_PID" 2>/dev/null) $(cat "$FRONTEND_PID" 2>/dev/null); do
        [[ -n "$p" ]] && protected_pids+=("$p")
    done
    for port in $BACKEND_PORT $FRONTEND_PORT; do
        p=$(pid_by_port "$port")
        [[ -n "$p" ]] && protected_pids+=("$p")
    done

    local orphans=()
    for cmdline_file in /proc/[0-9]*/cmdline; do
        [[ -f "$cmdline_file" ]] || continue
        local p
        p=$(basename "$(dirname "$cmdline_file")")
        local cmdline
        cmdline=$(cat "/proc/$p/cmdline" 2>/dev/null | tr '\0' ' ')
        if [[ "$cmdline" != *vite/bin/vite.js* && "$cmdline" != *target/debug/omniterm* ]]; then
            continue
        fi
        local cwd
        cwd=$(readlink "/proc/$p/cwd" 2>/dev/null)
        case "$cwd" in
            "$PROJECT_DIR"|"$PROJECT_DIR"/frontend) ;;
            *) continue ;;
        esac
        local is_protected=false
        for prot in "${protected_pids[@]}"; do
            [[ "$p" == "$prot" ]] && is_protected=true && break
        done
        $is_protected || orphans+=("$p")
    done

    if [[ ${#orphans[@]} -gt 0 ]]; then
        warn "发现孤儿进程: ${orphans[*]}"
        for p in "${orphans[@]}"; do
            kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true
        done
        sleep 0.5
        for p in "${orphans[@]}"; do
            kill -9 -- -"$p" 2>/dev/null || kill -9 "$p" 2>/dev/null || true
        done
        ok "孤儿进程已清理"
    fi
}

# ── 前置检查 ──
check_prerequisites() {
    local missing=()

    if ! command -v cargo &>/dev/null; then
        missing+=("cargo (Rust)")
    fi

    if ! command -v pnpm &>/dev/null; then
        missing+=("pnpm")
    elif ! command -v node &>/dev/null; then
        missing+=("node")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        err "缺少依赖: ${missing[*]}"
        echo ""
        echo "  安装提示:"
        echo "    Rust + Cargo:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        echo "    Node + pnpm:   curl -fsSL https://get.pnpm.io/install.sh | sh -"
        return 1
    fi

    # 检查 rust 环境是否已加载
    if ! cargo --version &>/dev/null; then
        warn "cargo 未就绪，尝试加载 Rust 环境 ..."
        if [[ -f "$HOME/.cargo/env" ]]; then
            . "$HOME/.cargo/env"
        fi
        if ! cargo --version &>/dev/null; then
            err "cargo 加载失败，请手动执行: source \$HOME/.cargo/env"
            return 1
        fi
    fi

    return 0
}

# ── 命令: start ──
cmd_start() {
    echo ""
    info "OmniTerm 启动中 ..."
    divider

    # 前置检查
    if ! check_prerequisites; then
        exit 1
    fi

    mkdir -p "$PID_DIR"
    cleanup_orphans

    # 检查端口占用
    local port_conflict=false
    for port in $BACKEND_PORT $FRONTEND_PORT; do
        if port_listening "$port"; then
            err "端口 $port 已被占用:"
            port_info "$port"
            port_conflict=true
        fi
    done
    if $port_conflict; then
        echo ""
        err "请先释放端口: ./dev.sh stop  或手动 kill"
        exit 1
    fi

    # ── 后端 ──
    section "启动后端"
    info "编译并启动 (端口 $BACKEND_PORT) ..."
    (
        cd "$PROJECT_DIR"
        # 忽略 SIGHUP：dev.sh 主流程退出时不会通过 shell 杀 cargo run
        trap '' HUP
        . "$HOME/.cargo/env"
        export BIND_ADDR="127.0.0.1:$BACKEND_PORT"
        # 启用 info 级别，输出 starting omniterm branch=X version=Y 启动横幅
        # 显式列 main/dev/debug 三个 binary 的 target（通配符 omniterm* 也行但更精确）
        export RUST_LOG="${RUST_LOG:-omniterm_main=info,omniterm_dev=info,omniterm_debug=info,omniterm_server=info}"
        stdbuf -oL -eL cargo run
    ) > "$BACKEND_LOG" 2>&1 &
    echo $! > "$BACKEND_PID"

    if wait_port "$BACKEND_PORT" 60; then
        pid_by_port "$BACKEND_PORT" > "$BACKEND_PID"
        local bpid
        bpid=$(cat "$BACKEND_PID")
        ok "后端已就绪  PID=$bpid  →  http://localhost:$BACKEND_PORT"
    else
        err "后端启动失败，最后 20 行日志:"
        echo ""
        tail -20 "$BACKEND_LOG" 2>/dev/null || echo "  (无日志输出)"
        echo ""
        err "完整日志: $BACKEND_LOG"
        exit 1
    fi

    # ── 前端 ──
    section "启动前端"
    info "安装依赖并启动 Vite (端口 $FRONTEND_PORT) ..."
    (
        cd "$PROJECT_DIR/frontend"
        # 忽略 SIGHUP：dev.sh 主流程退出时不会通过 shell 杀 pnpm/vite
        # 这是修复前端"一拉起就挂"的关键：之前 pnpm fork 的 vite 收到 SIGHUP 死亡
        trap '' HUP
        export NODE_ENV=development
        export http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}"
        # 首次启动或依赖缺失时自动安装
        if [[ ! -d node_modules ]]; then
            echo "[dev.sh] node_modules 不存在，执行 pnpm install ..."
            pnpm install
        fi
        stdbuf -oL -eL pnpm dev
    ) > "$FRONTEND_LOG" 2>&1 &
    echo $! > "$FRONTEND_PID"

    if wait_port "$FRONTEND_PORT" 60; then
        pid_by_port "$FRONTEND_PORT" > "$FRONTEND_PID"
        local fpid
        fpid=$(cat "$FRONTEND_PID")
        ok "前端已就绪  PID=$fpid  →  http://localhost:$FRONTEND_PORT"
    else
        err "前端启动失败，最后 20 行日志:"
        echo ""
        tail -20 "$FRONTEND_LOG" 2>/dev/null || echo "  (无日志输出)"
        echo ""
        err "完整日志: $FRONTEND_LOG"
        exit 1
    fi

    # ── 汇总 ──
    echo ""
    divider
    echo -e "  ${GREEN}● 后端 API${NC}  http://localhost:$BACKEND_PORT"
    echo -e "  ${GREEN}● 前端 UI${NC}   http://localhost:$FRONTEND_PORT"
    echo -e "  ${YELLOW}● 分支${NC}      ${BRANCH_NAME}"
    divider
    echo ""
}

# ── 命令: stop ──
cmd_stop() {
    echo ""
    info "正在停止 OmniTerm 服务 ..."

    local stopped=0

    # 停止前端
    if kill_by_pid "$FRONTEND_PID" "前端"; then
        stopped=$((stopped + 1))
    fi
    kill_port_orphans "$FRONTEND_PORT" "前端" && stopped=$((stopped + 1)) || true

    # 停止后端
    if kill_by_pid "$BACKEND_PID" "后端"; then
        stopped=$((stopped + 1))
    fi
    kill_port_orphans "$BACKEND_PORT" "后端" && stopped=$((stopped + 1)) || true

    # 汇总
    if [[ $stopped -gt 0 ]]; then
        ok "已停止 $stopped 个服务"
    else
        # 双重确认：检查端口是否真的空闲
        local still=0
        for port in $BACKEND_PORT $FRONTEND_PORT; do
            port_listening "$port" && still=$((still + 1))
        done
        if [[ $still -eq 0 ]]; then
            ok "无需停止，服务未运行"
        else
            warn "仍有 $still 个端口被占用，尝试强制清理 ..."
            for port in $BACKEND_PORT $FRONTEND_PORT; do
                fuser -k "$port/tcp" 2>/dev/null && info "  已释放端口 :$port" || true
            done
        fi
    fi
    echo ""
}

# ── 命令: restart ──
cmd_restart() {
    echo ""
    info "OmniTerm 重启中 ..."

    # 停止阶段
    info "第 1 步: 停止现有服务"
    cmd_stop

    sleep 1

    # 清理 vite 缓存（避免旧模块导致前端异常）
    if [[ -d "$PROJECT_DIR/frontend/node_modules/.vite" ]]; then
        info "清理 Vite 缓存 ..."
        rm -rf "$PROJECT_DIR/frontend/node_modules/.vite"
    fi

    # 启动阶段
    info "第 2 步: 启动服务"
    cmd_start
}

# ── 命令: status ──
cmd_status() {
    echo ""
    echo -e "${BOLD}OmniTerm 服务状态${NC}  ${CYAN}(${BRANCH_NAME})${NC}"
    divider

    # 后端
    if is_running "$BACKEND_PID"; then
        local bpid
        bpid=$(cat "$BACKEND_PID")
        echo -e "  后端 :$BACKEND_PORT  ${GREEN}● 运行中${NC}  PID=$bpid"
    elif port_listening "$BACKEND_PORT"; then
        local bpid
        bpid=$(pid_by_port "$BACKEND_PORT")
        echo -e "  后端 :$BACKEND_PORT  ${YELLOW}● 运行中${NC}  PID=$bpid  ${YELLOW}(pid 文件缺失)${NC}"
    else
        echo -e "  后端 :$BACKEND_PORT  ${RED}○ 未运行${NC}"
    fi

    # 前端
    if is_running "$FRONTEND_PID"; then
        local fpid
        fpid=$(cat "$FRONTEND_PID")
        echo -e "  前端 :$FRONTEND_PORT  ${GREEN}● 运行中${NC}  PID=$fpid"
    elif port_listening "$FRONTEND_PORT"; then
        local fpid
        fpid=$(pid_by_port "$FRONTEND_PORT")
        echo -e "  前端 :$FRONTEND_PORT  ${YELLOW}● 运行中${NC}  PID=$fpid  ${YELLOW}(pid 文件缺失)${NC}"
    else
        echo -e "  前端 :$FRONTEND_PORT  ${RED}○ 未运行${NC}"
    fi

    echo ""

    # 日志文件大小
    if [[ -f "$BACKEND_LOG" ]]; then
        echo -e "  后端日志: $BACKEND_LOG  ($(du -h "$BACKEND_LOG" | cut -f1))"
    fi
    if [[ -f "$FRONTEND_LOG" ]]; then
        echo -e "  前端日志: $FRONTEND_LOG  ($(du -h "$FRONTEND_LOG" | cut -f1))"
    fi

    divider
    echo ""
}

# ── 命令: logs ──
cmd_logs() {
    local target="${1:-both}"
    case "$target" in
        backend|be)
            if [[ -f "$BACKEND_LOG" ]]; then
                info "实时查看后端日志 (Ctrl-C 退出) ..."
                tail -f "$BACKEND_LOG"
            else
                err "后端日志不存在: $BACKEND_LOG"
            fi
            ;;
        frontend|fe)
            if [[ -f "$FRONTEND_LOG" ]]; then
                info "实时查看前端日志 (Ctrl-C 退出) ..."
                tail -f "$FRONTEND_LOG"
            else
                err "前端日志不存在: $FRONTEND_LOG"
            fi
            ;;
        both|*)
            if [[ -f "$BACKEND_LOG" || -f "$FRONTEND_LOG" ]]; then
                info "实时查看全部日志 (Ctrl-C 退出) ..."
                tail -f "$BACKEND_LOG" "$FRONTEND_LOG" 2>/dev/null
            else
                err "无日志文件"
            fi
            ;;
    esac
}

# ── 主入口 ──
case "${1:-}" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs "${2:-both}"
        ;;
    -h|--help|help)
        echo ""
        echo "OmniTerm 启动脚本（所有分支通用）"
        echo ""
        echo "用法: ./dev.sh <命令> [参数]"
        echo ""
        echo "命令:"
        echo "  start     启动后端 + 前端开发服务器"
        echo "  stop      停止所有服务"
        echo "  restart   重启所有服务（含 Vite 缓存清理）"
        echo "  status    查看运行状态"
        echo "  logs      实时查看日志 (可选: backend | frontend)"
        echo ""
        echo "端口:  后端 :$BACKEND_PORT / 前端 :$FRONTEND_PORT"
        echo "配置:  在 .env.local 中覆盖 BACKEND_PORT / FRONTEND_PORT"
        echo ""
        ;;
    *)
        err "未知命令: ${1:-}"
        echo "  用法: ./dev.sh {start|stop|restart|status|logs}"
        echo "  帮助: ./dev.sh --help"
        exit 1
        ;;
esac
