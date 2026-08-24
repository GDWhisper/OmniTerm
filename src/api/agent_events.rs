//! pty hook 信道 HTTP 上报端点（计划 D7 / Phase 3）。
//!
//! `POST /api/v1/internal/agent-event?token=<会话专属 token>`：
//! agent 生命周期 hook（`engine::pty::agent_hooks` 生成的 curl 命令）把
//! `kind:state:reason:event:nonce` 五段状态 POST 到此。
//!
//! **鉴权模型**：不走 JWT（hook 是会话内 shell 命令，无登录态），安全边界 =
//! 回环校验（`ConnectInfo` 源 IP 必须 loopback）+ 会话专属 token（spawn 时
//! 随机生成，经 `OMNITERM_HOOK_URL` env 注入）。端点挂在公开路由组但由上述
//! 双重校验保护（S4/S5：鉴权机制显式挂在链路上）。
//!
//! 落地：`engine::pty::agent_events::AgentEventStore`（token→会话键映射 +
//! 上报 KV + 按 nonce 幂等去重 + watch 门铃）；读口与仲裁（HookAuthority）
//! 见 `PtyEngine::agent_snapshot` 与 `api::sessions::list_sessions` 合并处。

use std::net::SocketAddr;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::agent::state::parse_agent_value;
use crate::engine::pty::agent_events::MAX_HOOK_BODY_BYTES;

#[derive(Deserialize)]
pub struct HookQuery {
    token: String,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/internal/agent-event", post(post_agent_event))
}

async fn post_agent_event(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(query): Query<HookQuery>,
    body: Bytes,
) -> impl IntoResponse {
    // 回环边界：hook 只可能来自本机派生的会话进程
    if !addr.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "loopback only" })));
    }
    // 入口防线（P4）：五段状态远小于上限，超限直接拒绝
    if body.len() > MAX_HOOK_BODY_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "body too large" })));
    }

    let store = state.engines.pty_agent_events();
    let Some(session_key) = store.key_for_token(&query.token) else {
        // token 未知：会话从未注册或已注销（kill/退出后旧 hook 迟到的上报）
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unknown token" })));
    };

    let text = String::from_utf8_lossy(&body);
    let Some(snapshot) = parse_agent_value(text.trim()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "malformed agent value" })));
    };

    // 按 source 记 nonce 幂等去重（herdr 三件套之二）
    let accepted = store.record(&session_key, snapshot);
    (StatusCode::OK, Json(json!({ "ok": true, "accepted": accepted })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::pty::agent_events::AgentEventStore;

    #[test]
    fn parse_hook_body_round_trip() {
        // hook 命令生成的 payload 形态（五段，nonce = 秒.PID）
        let snap = parse_agent_value("claude:waiting:decision:PermissionRequest:1719000000.12345")
            .expect("payload must parse");
        assert_eq!(snap.agent_state.as_str(), "waiting");
        assert!(parse_agent_value("").is_none());
        assert!(parse_agent_value("nonsense").is_none());
    }

    #[tokio::test]
    async fn store_rejects_unknown_token_and_accepts_known() {
        let store = AgentEventStore::new();
        assert!(store.key_for_token("bogus").is_none());
        let token = store.register("s1");
        assert_eq!(store.key_for_token(&token).as_deref(), Some("s1"));
    }
}
