//! tmux server 健康与自愈 API（计划 P1-1；受保护组 `require_auth_mw`——S4/S5：
//! 新端点必须鉴权，见 `docs/reference/auth-not-enforced.md` 教训）。
//!
//! # HTTP 契约（前端代理并行开发中，**逐字固定，勿改键名/错误码**）
//!
//! - `GET /api/v1/tmux/health` → 200
//!   `{"state":"healthy|no_server|deaf|other","consecutive_deaf":<u32>,
//!   "last_deaf_at":"<RFC3339>"|null,"orphan_count":<u32>,
//!   "orphan_warn_threshold":<u32>,"probe_interval_secs":<u32>}`
//! - `POST /api/v1/tmux/rebuild` → 200
//!   `{"ok":true,"server_pid":<u32>|null,"socket_removed":<bool>,"detail":"<string>"}`;
//!   重探针未确认聋 → 409 `{"error":"not_deaf"}`；单飞占用 → 409
//!   `{"error":"heal_in_progress"}`；其它失败 → 500 `{"error":"<原因>"}`

use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use serde::Serialize;
use tracing::warn;

use crate::AppState;
use crate::health::heal::{self, HealError};
use crate::health::{self, DEAF_PROBE_INTERVAL, HealthSnapshot, ORPHAN_WARN_THRESHOLD};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/tmux/health", get(get_tmux_health))
        .route("/tmux/rebuild", axum::routing::post(rebuild_tmux))
}

/// `GET /api/v1/tmux/health` 响应体（契约逐字固定）。
#[derive(Serialize)]
struct HealthResponse {
    state: &'static str,
    consecutive_deaf: u32,
    last_deaf_at: Option<String>,
    orphan_count: u32,
    orphan_warn_threshold: u32,
    probe_interval_secs: u32,
}

/// `POST /api/v1/tmux/rebuild` 200 响应体（契约逐字固定）。
#[derive(Serialize)]
struct RebuildResponse {
    ok: bool,
    server_pid: Option<u32>,
    socket_removed: bool,
    detail: String,
}

/// 错误响应体（契约：`{"error":"<code 或原因>"}`）。
#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

async fn get_tmux_health() -> Json<HealthResponse> {
    let state = health::global().unwrap_or_else(health::init_global);
    Json(health_response(&state.snapshot()))
}

async fn rebuild_tmux() -> impl IntoResponse {
    let state = health::global().unwrap_or_else(health::init_global);
    match heal::heal(&state).await {
        Ok(outcome) => Json(rebuild_ok_response(outcome)).into_response(),
        Err(err) => {
            if matches!(err, HealError::OwnerUnresolved(_) | HealError::KillFailed { .. }) {
                warn!(error = %err.detail(), "POST /api/v1/tmux/rebuild 失败");
            }
            let (status, body) = rebuild_error(&err);
            (status, Json(body)).into_response()
        }
    }
}

fn health_response(snap: &HealthSnapshot) -> HealthResponse {
    HealthResponse {
        state: snap.state.as_str(),
        consecutive_deaf: snap.consecutive_deaf,
        last_deaf_at: snap.last_deaf_at.map(|t| t.to_rfc3339()),
        orphan_count: snap.orphan_count,
        orphan_warn_threshold: ORPHAN_WARN_THRESHOLD,
        probe_interval_secs: DEAF_PROBE_INTERVAL.as_secs() as u32,
    }
}

fn rebuild_ok_response(outcome: heal::HealOutcome) -> RebuildResponse {
    RebuildResponse {
        ok: true,
        server_pid: outcome.server_pid,
        socket_removed: outcome.socket_removed,
        detail: outcome.detail,
    }
}

/// 错误映射（契约）：`NotDeaf` / `InProgress` → 409 固定错误码；其余 → 500 + 原因。
fn rebuild_error(err: &HealError) -> (StatusCode, ErrorBody) {
    match err {
        HealError::NotDeaf(_) => (StatusCode::CONFLICT, error_body("not_deaf")),
        HealError::InProgress => (StatusCode::CONFLICT, error_body("heal_in_progress")),
        other => (StatusCode::INTERNAL_SERVER_ERROR, error_body(other.detail())),
    }
}

fn error_body(error: impl Into<String>) -> ErrorBody {
    ErrorBody { error: error.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::classify::ServerHealth;
    use crate::health::heal::HealOutcome;
    use std::collections::HashSet;

    /// `GET /tmux/health` 键集与取值逐字对契约（键名经 HashSet 比较——serde_json
    /// Map 为 BTreeMap，键序不构成契约）。
    #[test]
    fn health_response_contract_is_verbatim() {
        let snap = HealthSnapshot {
            state: ServerHealth::Deaf,
            consecutive_deaf: 3,
            last_deaf_at: Some(chrono::Utc::now()),
            orphan_count: 2,
        };
        let v = serde_json::to_value(health_response(&snap)).expect("serialize");
        let obj = v.as_object().expect("object");
        let keys: HashSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            HashSet::from([
                "state",
                "consecutive_deaf",
                "last_deaf_at",
                "orphan_count",
                "orphan_warn_threshold",
                "probe_interval_secs",
            ])
        );
        assert_eq!(obj["state"], "deaf");
        assert_eq!(obj["consecutive_deaf"], 3);
        assert_eq!(obj["orphan_count"], 2);
        assert_eq!(obj["orphan_warn_threshold"], ORPHAN_WARN_THRESHOLD);
        assert_eq!(obj["probe_interval_secs"], DEAF_PROBE_INTERVAL.as_secs() as u32);
        assert!(
            obj["last_deaf_at"].as_str().is_some_and(|s| s.contains('T')),
            "last_deaf_at 必须是 RFC3339 字符串"
        );

        // 从未判聋 ⇒ null；state 词逐字（含 no_server 下划线形态）。
        for (state, word) in [
            (ServerHealth::Healthy, "healthy"),
            (ServerHealth::NoServer, "no_server"),
            (ServerHealth::Other, "other"),
        ] {
            let snap =
                HealthSnapshot { state, consecutive_deaf: 0, last_deaf_at: None, orphan_count: 0 };
            let v = serde_json::to_value(health_response(&snap)).expect("serialize");
            assert_eq!(v["state"], word);
            assert!(v["last_deaf_at"].is_null());
        }
    }

    /// `POST /tmux/rebuild` 200 键集（契约逐字）。
    #[test]
    fn rebuild_ok_response_contract_is_verbatim() {
        let v = serde_json::to_value(rebuild_ok_response(HealOutcome {
            server_pid: Some(42),
            socket_removed: true,
            detail: "killed".into(),
        }))
        .expect("serialize");
        let obj = v.as_object().expect("object");
        let keys: HashSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(keys, HashSet::from(["ok", "server_pid", "socket_removed", "detail"]));
        assert_eq!(obj["ok"], true);
        assert_eq!(obj["server_pid"], 42);
        assert_eq!(obj["socket_removed"], true);
        assert_eq!(obj["detail"], "killed");

        let v = serde_json::to_value(rebuild_ok_response(HealOutcome {
            server_pid: None,
            socket_removed: false,
            detail: "d".into(),
        }))
        .expect("serialize");
        assert!(v["server_pid"].is_null(), "server_pid 可空（契约 <u32>|null）");
        assert_eq!(v["socket_removed"], false);
    }

    /// 错误码契约：409 `not_deaf` / `heal_in_progress`；其它 500 + 原因。
    #[test]
    fn rebuild_error_codes_match_contract() {
        let (status, body) = rebuild_error(&HealError::NotDeaf(ServerHealth::Healthy));
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            serde_json::to_value(body).expect("serialize"),
            serde_json::json!({"error": "not_deaf"})
        );

        let (status, body) = rebuild_error(&HealError::InProgress);
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            serde_json::to_value(body).expect("serialize"),
            serde_json::json!({"error": "heal_in_progress"})
        );

        let (status, body) = rebuild_error(&HealError::OwnerUnresolved("owner gone".into()));
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let v = serde_json::to_value(body).expect("serialize");
        assert!(v["error"].as_str().is_some_and(|s| s.contains("owner gone")));
    }
}
