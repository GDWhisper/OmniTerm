//! 会话引擎抽象层（见 docs/dev/plans/2026-07-28-pty-engine-implementation.md D9）。
//!
//! 按会话 `runtime_kind` 路由到具体引擎；复用器引擎边界目录已冻结，
//! 引擎之外的代码只经本层的 `SessionEngine` / `EngineRegistry` 访问会话能力。

pub mod pty;
pub mod pty_io;
pub mod tmux; // 注册行：冻结引擎边界

use anyhow::{Result, anyhow};
use pty::PtyEngine; // 注册行
use tmux::TmuxEngine; // 注册行

use crate::agent::state::AgentSnapshot;
use crate::agent::watch::AgentWatcher;
use crate::models::session::RuntimeKind;

/// 引擎中立的会话信息（外部发现/收养列举用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineSessionInfo {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub created: String,
    pub cwd: Option<String>,
    pub agent_kind: Option<String>,
    pub agent_state: Option<String>,
    pub attention_reason: Option<String>,
    pub agent_event: Option<String>,
    pub agent_nonce: Option<String>,
}

/// agent 屏幕检测的枚举目标（引擎中立）。
pub struct WatchTarget {
    pub kind: RuntimeKind,
    pub session: String,
    pub pane_pid: u32,
    pub activity: String,
    pub title: String,
}

/// 会话引擎能力面。Phase 1 按现有冻结引擎行为 1:1 定义；
/// PtyEngine（Phase 2）接入时按需补充 write/resize/subscribe_output。
pub trait SessionEngine: Send + Sync {
    /// 创建会话；返回是否注入了 agent hook。
    async fn create_session(&self, name: &str, cwd: &str, command: Option<&str>) -> Result<bool>;
    async fn kill_session(&self, name: &str) -> Result<()>;
    async fn session_exists(&self, name: &str) -> bool;
    async fn list_sessions(&self) -> Result<Vec<EngineSessionInfo>>;
    async fn current_cwd(&self, name: &str) -> Result<String>;
    async fn capture_screen(&self, name: &str) -> Result<String>;
    async fn agent_snapshot(&self, name: &str) -> Result<Option<AgentSnapshot>>;
    async fn is_active(&self, name: &str) -> bool;

    /// 会话建立后开始活跃度跟踪（失败不致命，由调用方记日志）。
    async fn track_session(&self, name: &str) -> Result<()>;
    /// 会话销毁前停止活跃度跟踪。
    async fn untrack_session(&self, name: &str);

    /// 供 agent 屏幕检测枚举的活动目标。
    async fn watch_targets(&self) -> Vec<WatchTarget>;
}

/// 引擎注册表：按 `runtime_kind` 路由 + 引擎无关的公共读口。
#[derive(Clone)]
pub struct EngineRegistry {
    mux: TmuxEngine,
    pty: PtyEngine,
    watcher: AgentWatcher,
}

impl EngineRegistry {
    /// `listen_port`：后端监听端口，pty 引擎 spawn 时注入 `OMNITERM_HOOK_URL`
    /// （hook 信道，计划 D7）。
    pub fn new(db: sqlx::SqlitePool, listen_port: u16) -> Self {
        Self {
            mux: TmuxEngine::new(),
            pty: PtyEngine::with_db(db, listen_port),
            watcher: AgentWatcher::default(),
        }
    }

    pub fn watcher(&self) -> &AgentWatcher {
        &self.watcher
    }

    /// pty hook 信道状态库（HTTP 上报端点 / WS 推送共用）。
    pub fn pty_agent_events(&self) -> pty::agent_events::AgentEventStore {
        self.pty.agent_events()
    }

    /// pty 会话 attach（WS 层专用）：resolve-or-create + 订阅输出 + 补屏快照。
    pub async fn attach_pty(
        &self,
        key: &str,
        cwd: &str,
        size: portable_pty::PtySize,
    ) -> Result<pty::PtyAttach> {
        self.pty.attach(key, cwd, size)
    }

    pub async fn create_session(
        &self,
        kind: RuntimeKind,
        name: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> Result<bool> {
        match kind {
            RuntimeKind::Tmux => self.mux.create_session(name, cwd, command).await,
            RuntimeKind::Pty => self.pty.create_session(name, cwd, command).await,
            _ => Err(anyhow!("no session engine registered for runtime kind")),
        }
    }

    pub async fn kill_session(&self, kind: RuntimeKind, name: &str) -> Result<()> {
        match kind {
            RuntimeKind::Tmux => self.mux.kill_session(name).await,
            RuntimeKind::Pty => self.pty.kill_session(name).await,
            _ => Err(anyhow!("no session engine registered for runtime kind")),
        }
    }

    pub async fn session_exists(&self, kind: RuntimeKind, name: &str) -> bool {
        match kind {
            RuntimeKind::Tmux => self.mux.session_exists(name).await,
            RuntimeKind::Pty => self.pty.session_exists(name).await,
            _ => false,
        }
    }

    pub async fn list_sessions(&self) -> Result<Vec<EngineSessionInfo>> {
        self.mux.list_sessions().await
    }

    pub async fn current_cwd(&self, kind: RuntimeKind, name: &str) -> Result<String> {
        match kind {
            RuntimeKind::Tmux => self.mux.current_cwd(name).await,
            RuntimeKind::Pty => self.pty.current_cwd(name).await,
            _ => Err(anyhow!("no session engine registered for runtime kind")),
        }
    }

    pub async fn capture_screen(&self, kind: RuntimeKind, name: &str) -> Result<String> {
        match kind {
            RuntimeKind::Tmux => self.mux.capture_screen(name).await,
            RuntimeKind::Pty => self.pty.capture_screen(name).await,
            _ => Err(anyhow!("no session engine registered for runtime kind")),
        }
    }

    pub async fn agent_snapshot(
        &self,
        kind: RuntimeKind,
        name: &str,
    ) -> Result<Option<AgentSnapshot>> {
        match kind {
            RuntimeKind::Tmux => self.mux.agent_snapshot(name).await,
            RuntimeKind::Pty => self.pty.agent_snapshot(name).await,
            _ => Ok(None),
        }
    }

    pub async fn is_active(&self, kind: RuntimeKind, name: &str) -> bool {
        match kind {
            RuntimeKind::Tmux => self.mux.is_active(name).await,
            RuntimeKind::Pty => self.pty.is_active(name).await,
            _ => false,
        }
    }

    pub async fn track_session(&self, kind: RuntimeKind, name: &str) -> Result<()> {
        match kind {
            RuntimeKind::Tmux => self.mux.track_session(name).await,
            RuntimeKind::Pty => self.pty.track_session(name).await,
            _ => Ok(()),
        }
    }

    pub async fn untrack_session(&self, kind: RuntimeKind, name: &str) {
        match kind {
            RuntimeKind::Tmux => self.mux.untrack_session(name).await,
            RuntimeKind::Pty => self.pty.untrack_session(name).await,
            _ => {}
        }
    }

    pub async fn watch_targets(&self) -> Vec<WatchTarget> {
        let mut targets = self.mux.watch_targets().await;
        targets.extend(self.pty.watch_targets().await);
        targets
    }

    // 复用器可用性/元数据（冻结能力面，供 /system/* 与启动自检）

    pub fn multiplexer_name(&self) -> &'static str {
        self.mux.multiplexer_name()
    }

    pub fn multiplexer_install_hints(&self) -> &'static [&'static str] {
        self.mux.multiplexer_install_hints()
    }

    pub fn check_multiplexer(&self) -> Result<()> {
        self.mux.check_available()
    }

    pub async fn mouse_enabled(&self) -> Result<bool> {
        self.mux.mouse_enabled().await
    }

    pub async fn set_mouse_enabled(&self, enabled: bool) -> Result<()> {
        self.mux.set_mouse_enabled(enabled).await
    }
}

/// Windows (psmux) escape-time 一次性 workaround（失败静默，详见复用器引擎 WS 模块）。
#[cfg(windows)]
pub async fn apply_multiplexer_escape_time_workaround() {
    tmux::terminal_ws::apply_escape_time_workaround().await
}

/// 终端 WS attach 分发：按 runtime_kind 路由到各引擎的 attach 实现。
/// 未识别的 kind（含无 DB 记录）走复用器引擎链路，由其回报 session not found。
pub async fn run_terminal_session(
    kind: Option<String>,
    ws: axum::extract::ws::WebSocket,
    session_id: String,
    query: crate::ws::terminal::TerminalQuery,
    state: crate::AppState,
) {
    match kind.as_deref() {
        Some("pty") => pty::terminal_ws::handle_pty_terminal(ws, session_id, query, state).await,
        _ => tmux::terminal_ws::handle_terminal(ws, session_id, query, state).await,
    }
}

/// 外部（未收养）会话的 attach：复用器引擎专属能力（冻结，见 D6）。
pub async fn run_external_terminal_session(
    ws: axum::extract::ws::WebSocket,
    session_name: String,
    query: crate::ws::terminal::TerminalQuery,
    state: crate::AppState,
) {
    tmux::terminal_ws::handle_external_terminal(ws, session_name, query, state).await
}
