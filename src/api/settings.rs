use axum::extract::Query;
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::Ordering;

use crate::AppState;
use crate::acp::reaper::{
    DEFAULT_PERM_TIMEOUT_SECS, PermissionTimeoutMode, is_valid_perm_timeout_secs,
    perm_timeout_secs_from_legacy_min, perm_timeout_secs_from_setting,
};

/// settings 表 key：ACP 静默待命回收阈值（分钟）。
const KEY_ACP_IDLE_RECYCLE_MIN: &str = "acp_idle_recycle_min";

/// settings 表 key：权限请求超时行为模式（abort / auto / wait，见
/// [`PermissionTimeoutMode`]）与超时时长（秒）。两者同一面板设置，PUT 整体写入。
const KEY_ACP_PERM_TIMEOUT_MODE: &str = "acp_perm_timeout_mode";
const KEY_ACP_PERM_TIMEOUT_SECS: &str = "acp_perm_timeout_secs";

/// 2026-10-01 之前的分钟制时长 key：秒制 key 写入后即被 PUT 清理，这里仅在新
/// key 缺失时兜底读取（存量用户改过超时时不至于被重置回默认）。
const KEY_ACP_PERM_TIMEOUT_MIN_LEGACY: &str = "acp_perm_timeout_min";

/// 回收阈值允许范围（分钟），与前端 MIN_DISCONNECT_MIN / MAX_DISCONNECT_MIN 一致。
const MIN_ACP_IDLE_RECYCLE_MIN: u64 = 1;
const MAX_ACP_IDLE_RECYCLE_MIN: u64 = 60;

/// DB 无记录时 GET 返回的默认值（分钟），与前端 `DEFAULT_ACP_IDLE_RECYCLE_MIN` 一致。
const DEFAULT_ACP_IDLE_RECYCLE_MIN: u64 = 5;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings/acp-idle-recycle", get(get_acp_idle_recycle).put(set_acp_idle_recycle))
        .route(
            "/settings/permission-timeout",
            get(get_permission_timeout).put(set_permission_timeout),
        )
        .route("/settings/audit-log", get(get_audit_log))
}

#[derive(Deserialize)]
struct SetAcpIdleRecycleRequest {
    minutes: u64,
}

#[derive(Deserialize)]
struct SetPermissionTimeoutRequest {
    /// 线格式白名单：abort / auto / wait（见 [`PermissionTimeoutMode::from_str_opt`]）。
    mode: String,
    /// 超时时长（秒）：0 = 「总是」档，其余为 30 秒倍数且 ≤ 3600
    /// （见 [`is_valid_perm_timeout_secs`]）。
    seconds: u64,
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

/// 读取权限请求超时配置（模式 + 秒）。DB 无记录/非数字/模式非法时逐项回退
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
    let secs_raw: Option<String> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT value FROM settings WHERE key = '{}'",
        KEY_ACP_PERM_TIMEOUT_SECS
    ))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // 2026-10-01 前的分钟制记录兜底：秒制 key 缺失时才读（见 KEY_…_MIN_LEGACY）。
    let legacy_min_raw: Option<String> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT value FROM settings WHERE key = '{}'",
        KEY_ACP_PERM_TIMEOUT_MIN_LEGACY
    ))
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mode =
        mode_raw.as_deref().and_then(PermissionTimeoutMode::from_str_opt).unwrap_or_default();
    let seconds = perm_timeout_secs_from_setting(secs_raw.as_deref())
        .or_else(|| perm_timeout_secs_from_legacy_min(legacy_min_raw.as_deref()))
        .unwrap_or(DEFAULT_PERM_TIMEOUT_SECS);
    Ok(Json(json!({ "mode": mode.as_str(), "seconds": seconds })))
}

/// 写入权限请求超时配置：模式走白名单校验、秒值走档位校验（0 或 30 秒倍数且
/// ≤ 1 小时），合法则 upsert 两个 settings key、清理分钟制旧 key 并热更新内存配置
/// （reaper 每个 tick 动态读取），随后唤醒 reaper 立即重新评估——已有未决审批时
/// 切换到「总是」档不必等下一个 tick 才生效。
async fn set_permission_timeout(
    State(state): State<AppState>,
    Json(req): Json<SetPermissionTimeoutRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let Some(mode) = PermissionTimeoutMode::from_str_opt(&req.mode) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    if !is_valid_perm_timeout_secs(req.seconds) {
        return Err(StatusCode::BAD_REQUEST);
    }

    for (key, value) in [
        (KEY_ACP_PERM_TIMEOUT_MODE, mode.as_str().to_string()),
        (KEY_ACP_PERM_TIMEOUT_SECS, req.seconds.to_string()),
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
    // 清理分钟制旧 key：避免 DB 里留下一个会误导排查的过期记录
    // （GET 的兼容回退只在新 key 缺失时生效，删掉后彻底闭环）。
    sqlx::query(&format!("DELETE FROM settings WHERE key = '{}'", KEY_ACP_PERM_TIMEOUT_MIN_LEGACY))
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.acp_perm_timeout.store(mode, req.seconds);
    // 唤醒 reaper 立即按新配置重新评估未决请求（多跑一轮幂等，见 reaper 注释）。
    state.acp_perm_timeout.notify_perm_request();
    Ok(Json(json!({ "mode": mode.as_str(), "seconds": req.seconds })))
}

/// 读取安全审计日志（只读最近 N 条，新→旧）。
///
/// 只读、无写入口：清理只由 `audit_log` 表的滚动删除负责（`api::audit`）。
/// 传 `?limit=N` 可调整条数，但**收敛**到硬顶而非拒绝（读口无副作用，
/// 超限请求不该报错，见 `audit::effective_read_limit` 的纯函数单测）。
async fn get_audit_log(
    State(state): State<AppState>,
    Query(q): Query<crate::api::audit::AuditLogQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let limit = crate::api::audit::effective_read_limit(q.limit);
    let entries = crate::api::audit::list_recent(&state.db, limit)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "entries": entries })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::reaper::PermissionTimeoutMode;

    /// 内存 sqlite + 全部迁移的 `AppState`。直接复用
    /// `crate::test_utils::test_state`（两者原为逐字重复的 17 行样板，
    /// AppState 新增字段时只改那一处）。
    async fn test_state() -> AppState {
        crate::test_utils::test_state().await
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
        let secs = sqlx::query_scalar::<_, String>(&format!(
            "SELECT value FROM settings WHERE key = '{}'",
            KEY_ACP_PERM_TIMEOUT_SECS
        ))
        .fetch_optional(db)
        .await
        .expect("query secs");
        (mode, secs)
    }

    async fn seed_legacy_perm_timeout_min(db: &sqlx::SqlitePool, value: &str) {
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            KEY_ACP_PERM_TIMEOUT_MIN_LEGACY
        ))
        .bind(value)
        .execute(db)
        .await
        .expect("seed legacy min");
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
    async fn perm_timeout_get_without_record_returns_default_abort_30min() {
        let state = test_state().await;
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "seconds": 1800 }));
    }

    #[tokio::test]
    async fn perm_timeout_get_with_unparseable_record_returns_default() {
        let state = test_state().await;
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', 'teleport'), ('{}', 'abc')",
            KEY_ACP_PERM_TIMEOUT_MODE, KEY_ACP_PERM_TIMEOUT_SECS
        ))
        .execute(&state.db)
        .await
        .expect("seed");
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "seconds": 1800 }));
    }

    #[tokio::test]
    async fn perm_timeout_get_falls_back_to_legacy_minutes_key() {
        // 2026-10-01 前的分钟制记录：秒制 key 缺失时换算，不把存量用户重置回 30 分钟。
        let state = test_state().await;
        seed_legacy_perm_timeout_min(&state.db, "45").await;
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "seconds": 2700 }));
    }

    #[tokio::test]
    async fn perm_timeout_get_prefers_secs_key_over_legacy_minutes() {
        let state = test_state().await;
        seed_legacy_perm_timeout_min(&state.db, "45").await;
        sqlx::query(&format!(
            "INSERT INTO settings (key, value) VALUES ('{}', '30')",
            KEY_ACP_PERM_TIMEOUT_SECS
        ))
        .execute(&state.db)
        .await
        .expect("seed secs");
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "abort", "seconds": 30 }));
    }

    #[tokio::test]
    async fn perm_timeout_put_valid_persists_and_updates_memory() {
        let state = test_state().await;
        let res = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "auto".into(), seconds: 600 }),
        )
        .await
        .expect("put ok");
        assert_eq!(res.0, json!({ "mode": "auto", "seconds": 600 }));
        assert_eq!(
            perm_timeout_db_values(&state.db).await,
            (Some("auto".to_string()), Some("600".to_string()))
        );
        assert_eq!(state.acp_perm_timeout.snapshot(), (PermissionTimeoutMode::Auto, 600));
    }

    #[tokio::test]
    async fn perm_timeout_put_accepts_never_notch_and_clears_legacy_minutes() {
        let state = test_state().await;
        seed_legacy_perm_timeout_min(&state.db, "45").await;
        let res = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "auto".into(), seconds: 0 }),
        )
        .await
        .expect("put ok");
        assert_eq!(res.0, json!({ "mode": "auto", "seconds": 0 }));
        assert_eq!(
            perm_timeout_db_values(&state.db).await,
            (Some("auto".to_string()), Some("0".to_string()))
        );
        assert_eq!(state.acp_perm_timeout.snapshot(), (PermissionTimeoutMode::Auto, 0));
        let legacy_left: Option<String> = sqlx::query_scalar::<_, String>(&format!(
            "SELECT value FROM settings WHERE key = '{}'",
            KEY_ACP_PERM_TIMEOUT_MIN_LEGACY
        ))
        .fetch_optional(&state.db)
        .await
        .expect("query legacy");
        assert_eq!(legacy_left, None, "legacy minutes key should be cleaned up");
    }

    #[tokio::test]
    async fn perm_timeout_put_out_of_range_rejects_and_keeps_db_unchanged() {
        let state = test_state().await;
        let _ = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "wait".into(), seconds: 900 }),
        )
        .await
        .expect("seed put ok");

        // 模式白名单外 / 时长非档位（45 秒、负值经 u64 无法表达，故取非 30 倍数）
        // / 越上限一律 400，且不破坏现状。
        for (mode, seconds) in [("teleport", 900), ("AUTO", 900), ("auto", 45), ("auto", 3630)] {
            let err = set_permission_timeout(
                State(state.clone()),
                Json(SetPermissionTimeoutRequest { mode: mode.into(), seconds }),
            )
            .await
            .expect_err("should reject");
            assert_eq!(err, StatusCode::BAD_REQUEST, "mode={mode} seconds={seconds}");
        }

        assert_eq!(
            perm_timeout_db_values(&state.db).await,
            (Some("wait".to_string()), Some("900".to_string()))
        );
        assert_eq!(state.acp_perm_timeout.snapshot(), (PermissionTimeoutMode::Wait, 900));
    }

    #[tokio::test]
    async fn perm_timeout_put_then_get_returns_updated_value() {
        let state = test_state().await;
        let _ = set_permission_timeout(
            State(state.clone()),
            Json(SetPermissionTimeoutRequest { mode: "wait".into(), seconds: 2700 }),
        )
        .await
        .expect("put ok");
        let res = get_permission_timeout(State(state)).await.expect("get ok");
        assert_eq!(res.0, json!({ "mode": "wait", "seconds": 2700 }));
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
