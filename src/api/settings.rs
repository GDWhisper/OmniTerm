use axum::extract::{ConnectInfo, Query, State};
use axum::{Json, Router, http::StatusCode, routing::get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
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
        .route("/settings/proxy", get(get_proxy_settings).put(set_proxy_settings))
}

/// 读取一个 `settings` key。缺失返回 `None`，DB 错误上抛。
///
/// 单一真源：settings 是纯 KV 表，读写 SQL 不得在各 handler / 启动路径各抄一份。
pub(crate) async fn get_setting(
    pool: &sqlx::SqlitePool,
    key: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
}

/// 在一个事务内批量 upsert settings key：全部成功才提交，避免多 key 配置半写入。
pub(crate) async fn upsert_settings(
    pool: &sqlx::SqlitePool,
    pairs: &[(&str, String)],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for (key, value) in pairs {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// 删除一个 `settings` key（不存在时成功返回）。
pub(crate) async fn delete_setting(pool: &sqlx::SqlitePool, key: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM settings WHERE key = ?").bind(key).execute(pool).await?;
    Ok(())
}

/// 从 settings 表加载代理策略（启动与 GET 的宽容解析入口）。
///
/// 缺失/脏值回退安全默认；硬边界（范围/黑名单/自身端口）始终由
/// [`crate::proxy::ProxyPolicy::from_stored`] 再过滤一遍。
pub(crate) async fn load_proxy_policy(
    pool: &sqlx::SqlitePool,
    self_port: u16,
) -> Result<crate::proxy::ProxyPolicy, sqlx::Error> {
    let enabled = get_setting(pool, crate::proxy::KEY_PROXY_ENABLED).await?;
    let mode = get_setting(pool, crate::proxy::KEY_PROXY_MODE).await?;
    let ports = get_setting(pool, crate::proxy::KEY_PROXY_ALLOWED_PORTS).await?;
    Ok(crate::proxy::ProxyPolicy::from_stored(
        enabled.as_deref(),
        mode.as_deref(),
        ports.as_deref(),
        self_port,
    ))
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
    let value = get_setting(&state.db, KEY_ACP_IDLE_RECYCLE_MIN)
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

    upsert_settings(&state.db, &[(KEY_ACP_IDLE_RECYCLE_MIN, req.minutes.to_string())])
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
    let db_error = |_| StatusCode::INTERNAL_SERVER_ERROR;
    let mode_raw = get_setting(&state.db, KEY_ACP_PERM_TIMEOUT_MODE).await.map_err(db_error)?;
    let secs_raw = get_setting(&state.db, KEY_ACP_PERM_TIMEOUT_SECS).await.map_err(db_error)?;
    // 2026-10-01 前的分钟制记录兜底：秒制 key 缺失时才读（见 KEY_…_MIN_LEGACY）。
    let legacy_min_raw =
        get_setting(&state.db, KEY_ACP_PERM_TIMEOUT_MIN_LEGACY).await.map_err(db_error)?;

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

    upsert_settings(
        &state.db,
        &[
            (KEY_ACP_PERM_TIMEOUT_MODE, mode.as_str().to_string()),
            (KEY_ACP_PERM_TIMEOUT_SECS, req.seconds.to_string()),
        ],
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // 清理分钟制旧 key：避免 DB 里留下一个会误导排查的过期记录
    // （GET 的兼容回退只在新 key 缺失时生效，删掉后彻底闭环）。
    delete_setting(&state.db, KEY_ACP_PERM_TIMEOUT_MIN_LEGACY)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.acp_perm_timeout.store(mode, req.seconds);
    // 唤醒 reaper 立即按新配置重新评估未决请求（多跑一轮幂等，见 reaper 注释）。
    state.acp_perm_timeout.notify_perm_request();
    Ok(Json(json!({ "mode": mode.as_str(), "seconds": req.seconds })))
}

#[derive(Deserialize)]
struct SetProxySettingsRequest {
    enabled: bool,
    /// 线格式白名单：default / allowlist（见 [`crate::proxy::ProxyPortMode`]）。
    mode: String,
    /// 严格模式放行清单；任何模式下都做硬边界校验与去重升序。
    allowed_ports: Vec<u16>,
}

#[derive(Debug, Serialize)]
struct ProxySettingsResponse {
    enabled: bool,
    mode: &'static str,
    allowed_ports: Vec<u16>,
}

fn proxy_settings_response(policy: &crate::proxy::ProxyPolicy) -> ProxySettingsResponse {
    ProxySettingsResponse {
        enabled: policy.enabled(),
        mode: policy.mode().as_str(),
        allowed_ports: policy.allowed_ports(),
    }
}

/// 读取代理安全配置（返回内存中的**生效策略**；DB 只在启动与 PUT 时读写）。
async fn get_proxy_settings(State(state): State<AppState>) -> Json<ProxySettingsResponse> {
    let policy = state.proxy.policy.read().unwrap_or_else(|e| e.into_inner());
    Json(proxy_settings_response(&policy))
}

/// 写入代理安全配置：严格校验 → 事务落库 → 替换内存快照 → 审计。
///
/// 与当前策略相同则视为 no-op：不写库、不审计（避免脚本重复 PUT 刷台账）。
async fn set_proxy_settings(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<SetProxySettingsRequest>,
) -> Result<Json<ProxySettingsResponse>, StatusCode> {
    let next = crate::proxy::ProxyPolicy::from_update(
        req.enabled,
        &req.mode,
        &req.allowed_ports,
        state.proxy.self_port,
    )
    .map_err(|_| StatusCode::BAD_REQUEST)?;

    let current = {
        let policy = state.proxy.policy.read().unwrap_or_else(|e| e.into_inner());
        policy.clone()
    };
    if next == current {
        return Ok(Json(proxy_settings_response(&next)));
    }

    let allowed_ports = next.allowed_ports();
    let allowed_ports_json =
        serde_json::to_string(&allowed_ports).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    upsert_settings(
        &state.db,
        &[
            (crate::proxy::KEY_PROXY_ENABLED, if next.enabled() { "1" } else { "0" }.to_string()),
            (crate::proxy::KEY_PROXY_MODE, next.mode().as_str().to_string()),
            (crate::proxy::KEY_PROXY_ALLOWED_PORTS, allowed_ports_json),
        ],
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    *state.proxy.policy.write().unwrap_or_else(|e| e.into_inner()) = next.clone();

    let detail = json!({
        "enabled": next.enabled(),
        "mode": next.mode().as_str(),
        "allowed_ports": allowed_ports,
    })
    .to_string();
    let ctx = crate::api::audit::AuditContext::from_ip(Some(addr.ip()), None);
    crate::api::audit::record(
        &state.db,
        &ctx,
        crate::api::audit::AuditAction::ProxySettingsChanged,
        "proxy",
        Some(&detail),
    )
    .await;

    Ok(Json(proxy_settings_response(&next)))
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

    // ── 代理安全配置（P4） ──

    fn conn() -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::new("127.0.0.1".parse().unwrap(), 50000))
    }

    async fn proxy_setting(db: &sqlx::SqlitePool, key: &str) -> Option<String> {
        get_setting(db, key).await.expect("query proxy setting")
    }

    async fn proxy_audit_count(state: &AppState, action: &str) -> usize {
        crate::api::audit::list_recent(&state.db, 200)
            .await
            .expect("list audit")
            .into_iter()
            .filter(|e| e.action == action)
            .count()
    }

    #[tokio::test]
    async fn proxy_get_returns_defaults() {
        let state = test_state().await;
        let res = get_proxy_settings(State(state)).await;
        assert_eq!(
            serde_json::to_value(res.0).expect("serialize"),
            json!({ "enabled": true, "mode": "default", "allowed_ports": [] })
        );
    }

    #[tokio::test]
    async fn proxy_put_persists_updates_memory_and_audits() {
        let state = test_state().await;
        let res = set_proxy_settings(
            State(state.clone()),
            conn(),
            Json(SetProxySettingsRequest {
                enabled: true,
                mode: "allowlist".into(),
                allowed_ports: vec![5173, 3000, 3000],
            }),
        )
        .await
        .expect("put ok");
        assert_eq!(
            serde_json::to_value(res.0).expect("serialize"),
            json!({ "enabled": true, "mode": "allowlist", "allowed_ports": [3000, 5173] })
        );
        assert_eq!(
            proxy_setting(&state.db, crate::proxy::KEY_PROXY_ENABLED).await.as_deref(),
            Some("1")
        );
        assert_eq!(
            proxy_setting(&state.db, crate::proxy::KEY_PROXY_MODE).await.as_deref(),
            Some("allowlist")
        );
        assert_eq!(
            proxy_setting(&state.db, crate::proxy::KEY_PROXY_ALLOWED_PORTS).await.as_deref(),
            Some("[3000,5173]")
        );

        let policy = state.proxy.policy.read().unwrap().clone();
        assert_eq!(policy.decide(3000, 9777), crate::proxy::ProxyPolicyDecision::Allowed);
        assert_eq!(policy.decide(4000, 9777), crate::proxy::ProxyPolicyDecision::PortDenied);

        let entries = crate::api::audit::list_recent(&state.db, 200).await.expect("audit");
        let changed: Vec<_> =
            entries.iter().filter(|e| e.action == "proxy_settings_changed").collect();
        assert_eq!(changed.len(), 1, "配置变更须留痕一条");
        assert_eq!(changed[0].target, "proxy");
        assert!(
            changed[0]
                .detail_json
                .as_deref()
                .unwrap_or_default()
                .contains("\"mode\":\"allowlist\"")
        );
    }

    #[tokio::test]
    async fn proxy_put_noop_does_not_audit_again() {
        let state = test_state().await;
        let request = || SetProxySettingsRequest {
            enabled: true,
            mode: "allowlist".into(),
            allowed_ports: vec![3000],
        };
        let _ = set_proxy_settings(State(state.clone()), conn(), Json(request()))
            .await
            .expect("first put");
        let _ = set_proxy_settings(State(state.clone()), conn(), Json(request()))
            .await
            .expect("noop put");
        assert_eq!(proxy_audit_count(&state, "proxy_settings_changed").await, 1);
    }

    #[tokio::test]
    async fn proxy_put_validation_keeps_state_unchanged() {
        let state = test_state().await;
        let _ = set_proxy_settings(
            State(state.clone()),
            conn(),
            Json(SetProxySettingsRequest {
                enabled: true,
                mode: "allowlist".into(),
                allowed_ports: vec![3000],
            }),
        )
        .await
        .expect("seed put ok");

        let too_many: Vec<u16> =
            (3000..3000 + crate::proxy::MAX_PROXY_ALLOWED_PORTS as u16 + 1).collect();
        let bad_cases = vec![
            ("strict", vec![]),
            ("default", vec![2999]),
            ("default", vec![3306]),
            ("default", vec![9777]),
            ("default", too_many),
        ];
        for (mode, ports) in bad_cases {
            let err = set_proxy_settings(
                State(state.clone()),
                conn(),
                Json(SetProxySettingsRequest {
                    enabled: false,
                    mode: mode.into(),
                    allowed_ports: ports,
                }),
            )
            .await
            .expect_err("invalid policy must be rejected");
            assert_eq!(err, StatusCode::BAD_REQUEST, "mode={mode}");
        }

        assert_eq!(
            proxy_setting(&state.db, crate::proxy::KEY_PROXY_MODE).await.as_deref(),
            Some("allowlist")
        );
        let policy = state.proxy.policy.read().unwrap().clone();
        assert!(policy.enabled(), "非法 PUT 不得关闭代理");
        assert_eq!(policy.decide(3000, 9777), crate::proxy::ProxyPolicyDecision::Allowed);
        assert_eq!(proxy_audit_count(&state, "proxy_settings_changed").await, 1);
    }

    #[tokio::test]
    async fn load_proxy_policy_reads_stored_values() {
        let state = test_state().await;
        upsert_settings(
            &state.db,
            &[
                (crate::proxy::KEY_PROXY_ENABLED, "0".into()),
                (crate::proxy::KEY_PROXY_MODE, "allowlist".into()),
                (crate::proxy::KEY_PROXY_ALLOWED_PORTS, "[5173,3306]".into()),
            ],
        )
        .await
        .expect("seed settings");

        let policy = load_proxy_policy(&state.db, 9777).await.expect("load policy");
        assert!(!policy.enabled());
        assert_eq!(policy.mode(), crate::proxy::ProxyPortMode::Allowlist);
        assert_eq!(policy.allowed_ports(), vec![5173], "黑名单端口在加载时丢弃");
    }
}
