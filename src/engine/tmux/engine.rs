//! 冻结复用器引擎：`SessionEngine` 的 tmux/psmux 实现（纯包装既有门面，行为零变化）。

use anyhow::Result;

use crate::agent::state::AgentSnapshot;
use crate::engine::tmux::{self, control_mode, watch_source};
use crate::engine::{EngineSessionInfo, SessionEngine, WatchTarget};
use crate::models::session::RuntimeKind;

#[derive(Clone)]
pub struct TmuxEngine {
    activity_monitor: control_mode::SessionActivityMonitor,
}

impl TmuxEngine {
    pub fn new() -> Self {
        Self {
            activity_monitor: control_mode::SessionActivityMonitor::new(
                control_mode::DEFAULT_ACTIVITY_TIMEOUT,
            ),
        }
    }

    pub fn multiplexer_name(&self) -> &'static str {
        tmux::MULTIPLEXER_NAME
    }

    pub fn multiplexer_install_hints(&self) -> &'static [&'static str] {
        tmux::MULTIPLEXER_INSTALL_HINTS
    }

    pub fn check_available(&self) -> Result<()> {
        tmux::check_multiplexer()
    }

    pub async fn mouse_enabled(&self) -> Result<bool> {
        tmux::get_mouse_option().await
    }

    pub async fn set_mouse_enabled(&self, enabled: bool) -> Result<()> {
        tmux::set_mouse_option(enabled).await
    }
}

impl SessionEngine for TmuxEngine {
    async fn create_session(&self, name: &str, cwd: &str, command: Option<&str>) -> Result<bool> {
        tmux::new_session(name, cwd, command).await
    }

    async fn kill_session(&self, name: &str) -> Result<()> {
        tmux::kill_session(name).await
    }

    async fn session_exists(&self, name: &str) -> bool {
        tmux::session_exists(name).await
    }

    async fn list_sessions(&self) -> Result<Vec<EngineSessionInfo>> {
        tmux::list_sessions().await
    }

    async fn current_cwd(&self, name: &str) -> Result<String> {
        tmux::pane_cwd(name).await
    }

    async fn capture_screen(&self, name: &str) -> Result<String> {
        tmux::capture_screen(name).await
    }

    async fn agent_snapshot(&self, name: &str) -> Result<Option<AgentSnapshot>> {
        tmux::get_session_agent_option(name).await
    }

    async fn is_active(&self, name: &str) -> bool {
        self.activity_monitor.is_active(name).await
    }

    async fn track_session(&self, name: &str) -> Result<()> {
        self.activity_monitor.ensure_session(name).await
    }

    async fn untrack_session(&self, name: &str) {
        self.activity_monitor.remove_session(name).await
    }

    async fn watch_targets(&self) -> Vec<WatchTarget> {
        watch_source::list_active_panes()
            .await
            .into_iter()
            .map(|p| WatchTarget {
                kind: RuntimeKind::Tmux,
                session: p.session,
                pane_pid: p.pane_pid,
                activity: p.activity,
                title: p.title,
            })
            .collect()
    }
}
