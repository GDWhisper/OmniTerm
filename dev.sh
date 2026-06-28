#!/usr/bin/env bash
# OmniTerm main 分支启动脚本（发布前哨站）
# 用法: ./dev.sh {start|stop|restart|status|logs}

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 本地端口覆盖（.env.local 已在 .gitignore，不会被 merge 覆盖）
[[ -f "$PROJECT_DIR/.env.local" ]] && source "$PROJECT_DIR/.env.local"

BACKEND_PORT=${BACKEND_PORT:-9075}
FRONTEND_PORT=${FRONTEND_PORT:-9076}
export BACKEND_PORT FRONTEND_PORT
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
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

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

wait_port() {
    local port=$1 timeout=${2:-30}
    local elapsed=0
    while ! ss -tlnp 2>/dev/null | grep -q ":${port} "; do
        sleep 0.5
        elapsed=$((elapsed + 1))
        if [[ $elapsed -ge $((timeout * 2)) ]]; then
            return 1
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
        fi
        rm -f "$pid_file"
        ok "$name 已停止"
    else
        rm -f "$pid_file"
    fi

    if [[ -n "$port" ]]; then
        local orphans
        orphans=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
        if [[ -n "$orphans" ]]; then
            warn "端口 $port 仍有残留进程: $orphans"
            for opid in $orphans; do
                kill -9 "$opid" 2>/dev/null && info "已清理残留 PID $opid" || true
            done
            sleep 0.5
        fi
    fi
}

# 解析监听指定端口的进程 PID（用于修正 pid 文件）
pid_by_port() {
    local port=$1
    ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

# 防御性清理：杀掉本项目所有未受 pid 文件 / 端口监听 管理的 vite/cargo 孤儿
# 场景：终端关闭后子 shell 退出、pnpm 进程被 init 收养但 pid 文件失效，
#       下次 start 会再起一个 vite 与旧的累积
cleanup_project_processes() {
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
        warn "清理孤儿进程: ${orphans[*]}"
        for p in "${orphans[@]}"; do
            kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true
        done
        sleep 0.5
        for p in "${orphans[@]}"; do
            kill -9 -- -"$p" 2>/dev/null || kill -9 "$p" 2>/dev/null || true
        done
    fi
}

# ── 命令: start ──
cmd_start() {
    mkdir -p "$PID_DIR"

    # 先清理本项目残留（端口空闲但 vite/pnpm 僵尸还在的情况）
    cleanup_project_processes

    # 检查端口占用
    for port in $BACKEND_PORT $FRONTEND_PORT; do
        if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
            err "端口 $port 已被占用"
            ss -tlnp 2>/dev/null | grep ":${port} "
            exit 1
        fi
    done

    # 启动后端
    info "启动后端 (端口 $BACKEND_PORT) ..."
    (
        cd "$PROJECT_DIR"
        . "$HOME/.cargo/env"
        export BIND_ADDR="127.0.0.1:$BACKEND_PORT"
        cargo run
    ) > "$BACKEND_LOG" 2>&1 &
    echo $! > "$BACKEND_PID"

    # 等待后端就绪
    if wait_port "$BACKEND_PORT" 60; then
        # 用真实监听端口的进程 PID 覆盖子 shell PID（子 shell 退出后 pid 文件会失效）
        pid_by_port "$BACKEND_PORT" > "$BACKEND_PID"
        ok "后端已启动 → http://localhost:$BACKEND_PORT"
    else
        err "后端启动超时，查看日志: $BACKEND_LOG"
        cat "$BACKEND_LOG" | tail -20
        exit 1
    fi

    # 启动前端
    info "启动前端 (端口 $FRONTEND_PORT) ..."
    (
        cd "$PROJECT_DIR/frontend"
        export NODE_ENV=development
        export http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}"
        pnpm dev
    ) > "$FRONTEND_LOG" 2>&1 &
    echo $! > "$FRONTEND_PID"

    if wait_port "$FRONTEND_PORT" 15; then
        pid_by_port "$FRONTEND_PORT" > "$FRONTEND_PID"
        ok "前端已启动 → http://localhost:$FRONTEND_PORT"
    else
        err "前端启动超时，查看日志: $FRONTEND_LOG"
        cat "$FRONTEND_LOG" | tail -20
        exit 1
    fi

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  后端 API:  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
    echo -e "  前端 UI:   ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
    echo -e "  分支:      ${YELLOW}main${NC}（发布前哨站）"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ── 命令: stop ──
cmd_stop() {
    kill_by_pid "$FRONTEND_PID" "前端" "$FRONTEND_PORT"
    kill_by_pid "$BACKEND_PID" "后端" "$BACKEND_PORT"
}

# ── 命令: restart ──
cmd_restart() {
    cmd_stop
    sleep 1
    rm -rf "$PROJECT_DIR/frontend/node_modules/.vite" 2>/dev/null || true
    cmd_start
}

# ── 命令: status ──
cmd_status() {
    echo ""
    echo -e "${CYAN}OmniTerm main 分支状态（发布前哨站）${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if is_running "$BACKEND_PID"; then
        local bpid
        bpid=$(cat "$BACKEND_PID")
        echo -e "后端 (:$BACKEND_PORT): ${GREEN}运行中${NC}  PID=$bpid"
    else
        echo -e "后端 (:$BACKEND_PORT): ${RED}未运行${NC}"
    fi

    if is_running "$FRONTEND_PID"; then
        local fpid
        fpid=$(cat "$FRONTEND_PID")
        echo -e "前端 (:$FRONTEND_PORT): ${GREEN}运行中${NC}  PID=$fpid"
    else
        echo -e "前端 (:$FRONTEND_PORT): ${RED}未运行${NC}"
    fi

    echo ""
    echo "端口占用:"
    for port in $BACKEND_PORT $FRONTEND_PORT; do
        if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
            local proc
            proc=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1)
            echo -e "  :$port ${GREEN}●${NC} $proc"
        else
            echo -e "  :$port ${RED}○${NC} 空闲"
        fi
    done
    echo ""
}

# ── 命令: logs ──
cmd_logs() {
    local target="${1:-both}"
    case "$target" in
        backend|be)
            if [[ -f "$BACKEND_LOG" ]]; then
                tail -f "$BACKEND_LOG"
            else
                err "后端日志不存在"
            fi
            ;;
        frontend|fe)
            if [[ -f "$FRONTEND_LOG" ]]; then
                tail -f "$FRONTEND_LOG"
            else
                err "前端日志不存在"
            fi
            ;;
        both|*)
            if [[ -f "$BACKEND_LOG" || -f "$FRONTEND_LOG" ]]; then
                tail -f "$BACKEND_LOG" "$FRONTEND_LOG" 2>/dev/null
            else
                err "无日志文件"
            fi
            ;;
    esac
}

# ── 主入口 ──
case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs "${2:-both}" ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs [backend|frontend]}"
        echo ""
        echo "  main 分支启动脚本（发布前哨站）"
        echo "  后端 :${BACKEND_PORT} / 前端 :${FRONTEND_PORT}"
        echo ""
        echo "  start    启动后端 + 前端开发服务器"
        echo "  stop     停止所有服务"
        echo "  restart  重启所有服务"
        echo "  status   查看运行状态"
        echo "  logs     实时查看日志 (可选: backend/frontend)"
        exit 1
        ;;
esac
