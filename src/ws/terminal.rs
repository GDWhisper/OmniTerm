//! 终端 WS 入口：共享协议类型 + 按 `runtime_kind` 分发到各引擎的 attach 实现。
//!
//! 各引擎的 attach 链路在 `src/engine/*/terminal_ws.rs`，本文件不含引擎特定逻辑。

use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Debug, Deserialize)]
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
