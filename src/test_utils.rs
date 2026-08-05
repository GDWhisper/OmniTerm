//! 共享测试工具（仅 `#[cfg(test)]` 编译）。
//!
//! 各 API 模块的 handler 测试复用同一个「内存 sqlite + 全部迁移」的
//! `AppState` 构造，避免逐模块复制 17 行初始化代码（settings.rs 的
//! `tests::test_state` 与之同构，可后续迁移过来）。

use crate::AppState;
use crate::acp::AcpSupervisor;
use crate::auth::LoginGuard;
use crate::tmux::agent_watch::AgentWatcher;
use crate::tmux::control_mode::{DEFAULT_ACTIVITY_TIMEOUT, SessionActivityMonitor};
use sqlx::sqlite::SqlitePoolOptions;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};

/// 构造内存 sqlite + 跑完全部迁移的 `AppState`。
pub async fn test_state() -> AppState {
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite pool");
    sqlx::migrate!("./migrations").run(&db).await.expect("run migrations");
    AppState {
        db,
        jwt_secret: "test-secret".into(),
        auth_enabled: Arc::new(AtomicBool::new(false)),
        acp_idle_recycle_secs: Arc::new(AtomicU64::new(300)),
        login_guard: LoginGuard::new(),
        activity_monitor: SessionActivityMonitor::new(DEFAULT_ACTIVITY_TIMEOUT),
        acp_supervisor: AcpSupervisor::default(),
        agent_watcher: AgentWatcher::default(),
    }
}
