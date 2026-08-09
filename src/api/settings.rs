use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::Ordering;

use crate::AppState;

/// settings 表 key：ACP 静默待命回收阈值（分钟）。
const KEY_ACP_IDLE_RECYCLE_MIN: &str = "acp_idle_recycle_min";

/// 回收阈值允许范围（分钟），与前端 MIN_DISCONNECT_MIN / MAX_DISCONNECT_MIN 一致。
const MIN_ACP_IDLE_RECYCLE_MIN: u64 = 1;
const MAX_ACP_IDLE_RECYCLE_MIN: u64 = 60;

/// DB 无记录时 GET 返回的默认值（分钟），与前端 `DEFAULT_ACP_IDLE_RECYCLE_MIN` 一致。
const DEFAULT_ACP_IDLE_RECYCLE_MIN: u64 = 5;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings/acp-idle-recycle", get(get_acp_idle_recycle).put(set_acp_idle_recycle))
}

#[derive(Deserialize)]
struct SetAcpIdleRecycleRequest {
    minutes: u64,
}

/// 读取 ACP 静默待命回收阈值（分钟）。DB 无记录或记录非数字时回退到默认 5 分钟。
async fn get_acp_idle_recycle(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let value: Option<String> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT value FROM settings WHERE key = '{}'",
        KEY_ACP_IDLE_RECYCLE_MIN
    ))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let minutes = value
        .as_deref()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_ACP_IDLE_RECYCLE_MIN);
    Ok(Json(json!({ "minutes": minutes })))
}

/// 写入 ACP 静默待命回收阈值（分钟）：校验 1..=60，合法则 upsert 到 settings 表
/// 并热更新内存中的秒级阈值（reaper 每个 tick 动态读取）。
async fn set_acp_idle_recycle(
    State(state): State<AppState>,
    Json(req): Json<SetAcpIdleRecycleRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !(MIN_ACP_IDLE_RECYCLE_MIN..=MAX_ACP_IDLE_RECYCLE_MIN).contains(&req.minutes) {
        return Err(StatusCode::BAD_REQUEST);
    }

    sqlx::query(&format!(
        "INSERT INTO settings (key, value) VALUES ('{}', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        KEY_ACP_IDLE_RECYCLE_MIN
    ))
    .bind(req.minutes.to_string())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.acp_idle_recycle_secs.store(req.minutes * 60, Ordering::Relaxed);
    Ok(Json(json!({ "minutes": req.minutes })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpSupervisor;
    use crate::auth::LoginGuard;
    use crate::engine::tmux::agent_watch::AgentWatcher;
    use crate::engine::tmux::control_mode::{DEFAULT_ACTIVITY_TIMEOUT, SessionActivityMonitor};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64};

    async fn test_state() -> AppState {
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

    async fn db_value(db: &sqlx::SqlitePool) -> Option<String> {
        sqlx::query_scalar::<_, String>(&format!(
            "SELECT value FROM settings WHERE key = '{}'",
            KEY_ACP_IDLE_RECYCLE_MIN
        ))
        .fetch_optional(db)
        .await
        .expect("query settings")
    }

    #[tokio::test]
    async fn get_without_record_returns_default_5() {
        let state = test_state().await;
        let res = get_acp_idle_recycle(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "minutes": 5 }));
    }

    #[tokio::test]
    async fn get_with_unparseable_record_returns_default_5() {
        let state = test_state().await;
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', 'abc')",
            KEY_ACP_IDLE_RECYCLE_MIN
        ))
        .execute(&state.db)
        .await
        .expect("seed");
        let res = get_acp_idle_recycle(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "minutes": 5 }));
    }

    #[tokio::test]
    async fn put_valid_value_persists_and_updates_memory() {
        let state = test_state().await;
        let res = set_acp_idle_recycle(
            State(state.clone()),
            Json(SetAcpIdleRecycleRequest { minutes: 10 }),
        )
        .await
        .expect("put ok");
        assert_eq!(res.0, json!({ "minutes": 10 }));
        assert_eq!(db_value(&state.db).await.as_deref(), Some("10"));
        assert_eq!(state.acp_idle_recycle_secs.load(Ordering::Relaxed), 600);
    }

    #[tokio::test]
    async fn put_out_of_range_rejects_and_keeps_db_unchanged() {
        let state = test_state().await;
        // 先写入一个合法值，再验证越界值不会破坏现状。
        let _ = set_acp_idle_recycle(
            State(state.clone()),
            Json(SetAcpIdleRecycleRequest { minutes: 10 }),
        )
        .await
        .expect("put ok");

        for bad in [0, 61] {
            let err = set_acp_idle_recycle(
                State(state.clone()),
                Json(SetAcpIdleRecycleRequest { minutes: bad }),
            )
            .await
            .expect_err("should reject");
            assert_eq!(err, StatusCode::BAD_REQUEST);
        }

        assert_eq!(db_value(&state.db).await.as_deref(), Some("10"));
        assert_eq!(state.acp_idle_recycle_secs.load(Ordering::Relaxed), 600);
    }

    #[tokio::test]
    async fn put_then_get_returns_updated_value() {
        let state = test_state().await;
        let _ = set_acp_idle_recycle(
            State(state.clone()),
            Json(SetAcpIdleRecycleRequest { minutes: 20 }),
        )
        .await
        .expect("put ok");
        let res = get_acp_idle_recycle(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "minutes": 20 }));
    }

    #[tokio::test]
    async fn put_overwrites_existing_value() {
        let state = test_state().await;
        let _ = set_acp_idle_recycle(
            State(state.clone()),
            Json(SetAcpIdleRecycleRequest { minutes: 10 }),
        )
        .await
        .expect("put ok");
        let _ = set_acp_idle_recycle(
            State(state.clone()),
            Json(SetAcpIdleRecycleRequest { minutes: 30 }),
        )
        .await
        .expect("put ok");
        assert_eq!(db_value(&state.db).await.as_deref(), Some("30"));
        assert_eq!(state.acp_idle_recycle_secs.load(Ordering::Relaxed), 1800);
    }
}
