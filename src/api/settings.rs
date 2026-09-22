use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::Ordering;

use crate::AppState;
use crate::acp::reaper::{PermissionTimeoutMode, REQUIRES_ACTION_RECYCLE_SECS};

/// settings 表 key：ACP 静默待命回收阈值（分钟）。
const KEY_ACP_IDLE_RECYCLE_MIN: &str = "acp_idle_recycle_min";

/// settings 表 key：权限请求超时行为模式（abort / auto / wait，见
/// [`PermissionTimeoutMode`]）与超时时长（分钟）。两者同一面板设置，PUT 整体写入。
const KEY_ACP_PERM_TIMEOUT_MODE: &str = "acp_perm_timeout_mode";
const KEY_ACP_PERM_TIMEOUT_MIN: &str = "acp_perm_timeout_min";

/// 回收阈值允许范围（分钟），与前端 MIN_DISCONNECT_MIN / MAX_DISCONNECT_MIN 一致。
const MIN_ACP_IDLE_RECYCLE_MIN: u64 = 1;
const MAX_ACP_IDLE_RECYCLE_MIN: u64 = 60;

/// 权限超时时长允许范围（分钟）：与回收滑块同域（1..=60），wait 模式不使用该值。
const MIN_ACP_PERM_TIMEOUT_MIN: u64 = 1;
const MAX_ACP_PERM_TIMEOUT_MIN: u64 = 60;

/// DB 无记录时 GET 返回的默认值（分钟），与前端 `DEFAULT_ACP_IDLE_RECYCLE_MIN` 一致。
const DEFAULT_ACP_IDLE_RECYCLE_MIN: u64 = 5;

/// DB 无记录时 GET 返回的权限超时默认分钟数：30（与
/// [`PermissionTimeoutConfig::default`] 一致，即 2026-08-18 起的行为）。
const DEFAULT_ACP_PERM_TIMEOUT_MIN: u64 = REQUIRES_ACTION_RECYCLE_SECS / 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings/acp-idle-recycle", get(get_acp_idle_recycle).put(set_acp_idle_recycle))
        .route(
            "/settings/permission-timeout",
            get(get_permission_timeout).put(set_permission_timeout),
        )
}

#[derive(Deserialize)]
struct SetAcpIdleRecycleRequest {
    minutes: u64,
}

#[derive(Deserialize)]
struct SetPermissionTimeoutRequest {
    /// 线格式白名单：abort / auto / wait（见 [`PermissionTimeoutMode::from_str_opt`]）。
    mode: String,
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

/// 读取权限请求超时配置（模式 + 分钟）。DB 无记录/非数字/模式非法时逐项回退
/// 默认（abort + 30 分钟），保证 DB 无该 key 时行为与硬编码时代完全一致。
async fn get_permission_timeout(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mode_raw: Option<String> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT value FROM settings WHERE key = '{}'",
        KEY_ACP_PERM_TIMEOUT_MODE
    ))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let min_raw: Option<String> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT value FROM settings WHERE key = '{}'",
        KEY_ACP_PERM_TIMEOUT_MIN
    ))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mode =
        mode_raw.as_deref().and_then(PermissionTimeoutMode::from_str_opt).unwrap_or_default();
    let minutes = min_raw
        .as_deref()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_ACP_PERM_TIMEOUT_MIN);
    Ok(Json(json!({ "mode": mode.as_str(), "minutes": minutes })))
}

/// 写入权限请求超时配置：模式走白名单校验、分钟值校验 1..=60，合法则 upsert
/// 两个 settings key 并热更新内存配置（reaper 每个 tick 动态读取）。
async fn set_permission_timeout(
    State(state): State<AppState>,
    Json(req): Json<SetPermissionTimeoutRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let Some(mode) = PermissionTimeoutMode::from_str_opt(&req.mode) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if !(MIN_ACP_PERM_TIMEOUT_MIN..=MAX_ACP_PERM_TIMEOUT_MIN).contains(&req.minutes) {
        return Err(StatusCode::BAD_REQUEST);
    }

    for (key, value) in [
        (KEY_ACP_PERM_TIMEOUT_MODE, mode.as_str().to_string()),
        (KEY_ACP_PERM_TIMEOUT_MIN, req.minutes.to_string()),
    ] {
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            key
        ))
        .bind(value)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    state.acp_perm_timeout.store(mode, req.minutes * 60);
    Ok(Json(json!({ "mode": mode.as_str(), "minutes": req.minutes })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpSupervisor;
    use crate::acp::reaper::{PermissionTimeoutConfig, PermissionTimeoutMode};
    use crate::auth::LoginGuard;
    use crate::engine::EngineRegistry;
    use crate::proxy::ProxyState;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::collections::HashMap;
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
            jwt_secret: "test-secret".into(),
            token_cookie: crate::TOKEN_COOKIE_BASE.to_string(),
            api_keys: HashMap::new(),
            auth_enabled: Arc::new(AtomicBool::new(false)),
            acp_idle_recycle_secs: Arc::new(AtomicU64::new(300)),
            acp_perm_timeout: Arc::new(PermissionTimeoutConfig::default()),
            login_guard: LoginGuard::new(),
            engines: EngineRegistry::new(db.clone(), 9777),
            acp_supervisor: AcpSupervisor::default(),
            proxy: ProxyState {
                client: reqwest::Client::new(),
                self_port: 9777,
                base_host: None,
                max_request_body: crate::proxy::MAX_REQUEST_BODY,
            },
            max_upload_body: crate::api::files::MAX_UPLOAD_BODY_DEFAULT,
            db,
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

    async fn perm_timeout_db_values(db: &sqlx::SqlitePool) -> (Option<String>, Option<String>) {
        let mode = sqlx::query_scalar::<_, String>(&format!(
            "SELECT value FROM settings WHERE key = '{}'",
            KEY_ACP_PERM_TIMEOUT_MODE
        ))
        .fetch_optional(db)
        .await
        .expect("query mode");
        let min = sqlx::query_scalar::<_, String>(&format!(
            "SELECT value FROM settings WHERE key = '{}'",
            KEY_ACP_PERM_TIMEOUT_MIN
        ))
        .fetch_optional(db)
        .await
        .expect("query min");
        (mode, min)
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

    // ── 权限请求超时配置 ──

    #[tokio::test]
    async fn perm_timeout_get_without_record_returns_default_abort_30() {
        let state = test_state().await;
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "minutes": 30 }));
    }

    #[tokio::test]
    async fn perm_timeout_get_with_unparseable_record_returns_default() {
        let state = test_state().await;
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', 'teleport'), ('{}', 'abc')",
            KEY_ACP_PERM_TIMEOUT_MODE, KEY_ACP_PERM_TIMEOUT_MIN
        ))
        .execute(&state.db)
        .await
        .expect("seed");
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "minutes": 30 }));
    }

    #[tokio::test]
    async fn perm_timeout_put_valid_persists_and_updates_memory() {
        let state = test_state().await;
        let res = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "auto".into(), minutes: 10 }),
        )
        .await
        .expect("put ok");
        assert_eq!(res.0, json!({ "mode": "auto", "minutes": 10 }));
        assert_eq!(
            perm_timeout_db_values(&state.db).await,
            (Some("auto".to_string()), Some("10".to_string()))
        );
        assert_eq!(state.acp_perm_timeout.snapshot(), (PermissionTimeoutMode::Auto, 600));
    }

    #[tokio::test]
    async fn perm_timeout_put_out_of_range_rejects_and_keeps_db_unchanged() {
        let state = test_state().await;
        let _ = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "wait".into(), minutes: 15 }),
        )
        .await
        .expect("seed put ok");

        // 模式白名单外 / 分钟越界一律 400，且不破坏现状。
        for (mode, minutes) in [("teleport", 15), ("AUTO", 15), ("auto", 0), ("auto", 61)] {
            let err = set_permission_timeout(
                State(state.clone()),
                Json(SetPermissionTimeoutRequest { mode: mode.into(), minutes }),
            )
            .await
            .expect_err("should reject");
            assert_eq!(err, StatusCode::BAD_REQUEST, "mode={mode} minutes={minutes}");
        }

        assert_eq!(
            perm_timeout_db_values(&state.db).await,
            (Some("wait".to_string()), Some("15".to_string()))
        );
        assert_eq!(state.acp_perm_timeout.snapshot(), (PermissionTimeoutMode::Wait, 900));
    }

    #[tokio::test]
    async fn perm_timeout_put_then_get_returns_updated_value() {
        let state = test_state().await;
        let _ = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "wait".into(), minutes: 45 }),
        )
        .await
        .expect("put ok");
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "wait", "minutes": 45 }));
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
