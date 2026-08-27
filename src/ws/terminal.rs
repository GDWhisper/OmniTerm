//! 终端 WS 入口：共享协议类型 + 按 `runtime_kind` 分发到各引擎的 attach 实现。
//!
//! 各引擎的 attach 链路在 `src/engine/*/terminal_ws.rs`，本文件不含引擎特定逻辑。

use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ClientControl {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "ping")]
    Ping,
    /// 前端渲染积压丢帧后请求重同步：diff 帧相对上一帧编码基线，丢弃的
    /// 中间帧无法重建，服务端收到后作废 diff 记忆，下一帧发全帧。
    #[serde(rename = "resync")]
    Resync,
    /// 历史视口窗口请求（方案 C Phase 1，仅 pty 引擎消费）：滚轮接管后前端
    /// 请求以 `y`（行，0 = live 屏）为顶的历史窗口帧。负值无意义，处理侧
    /// 钳制；上界由 encode_viewport_frame 钳到实际 history_size。
    #[serde(rename = "viewport_request")]
    ViewportRequest { y: i32 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
#[allow(dead_code)] // 待核：遗留/未接线/仅测试用，见 docs/dev/plans/backlog/dead-code-triage.md
pub enum ServerControl<'a> {
    #[serde(rename = "attached")]
    Attached { session: &'a str },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "error")]
    Error { message: &'a str },
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
    #[serde(rename = "agent_state")]
    AgentState {
        agent_kind: Option<&'a str>,
        state: &'a str,
        attention_reason: Option<&'a str>,
        agent_event: Option<&'a str>,
        agent_nonce: Option<&'a str>,
    },
}

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// WebSocket upgrade handler for terminal connections.
/// Accepts optional `cols` and `rows` query params for initial PTY size.
pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<TerminalQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let runtime_kind: Option<(String,)> =
            sqlx::query_as("SELECT runtime_kind FROM sessions WHERE id = ?")
                .bind(&session_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();

        crate::engine::run_terminal_session(
            runtime_kind.map(|(kind,)| kind),
            socket,
            session_id,
            query,
            state,
        )
        .await
    })
}

/// WebSocket upgrade handler for external (not-yet-adopted) sessions.
/// Connects directly to the multiplexer session by name, without requiring a DB record.
pub async fn ws_external_terminal_handler(
    ws: WebSocketUpgrade,
    Path(session_name): Path<String>,
    Query(query): Query<TerminalQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| {
        crate::engine::run_external_terminal_session(socket, session_name, query, state)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_request_parses() {
        let ctrl: ClientControl =
            serde_json::from_str(r#"{"type":"viewport_request","y":42}"#).unwrap();
        assert_eq!(ctrl, ClientControl::ViewportRequest { y: 42 });
    }

    #[test]
    fn legacy_control_frames_still_parse() {
        let resync: ClientControl = serde_json::from_str(r#"{"type":"resync"}"#).unwrap();
        assert_eq!(resync, ClientControl::Resync);
        let resize: ClientControl =
            serde_json::from_str(r#"{"type":"resize","cols":80,"rows":24}"#).unwrap();
        assert_eq!(resize, ClientControl::Resize { cols: 80, rows: 24 });
    }
}
