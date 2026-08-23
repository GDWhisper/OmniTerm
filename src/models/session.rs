use serde::{Deserialize, Serialize};

fn is_false(v: &bool) -> bool {
    !*v
}

/// Which runtime backs a session.
///
/// - `Tmux`: session driven by a tmux pane; identified by `tmux_session_name`.
/// - `Acp`: session driven by an ACP adapter subprocess; identified by `acp_session_id`.
/// - `Pty`: session driven by a self-managed PTY engine; no multiplexer.
///
/// Default flipped from `Tmux` (Phase 2) to `Acp` in Phase 4 once the frontend
/// Chat view landed. Callers that still want a multiplexer session must pass
/// `runtime_kind = 'tmux'` explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum RuntimeKind {
    Tmux,
    #[default]
    Acp,
    Pty,
}

/// Request DTO for adopting an external multiplexer session into a project.
#[derive(Debug, Deserialize)]
pub struct AdoptSession {
    /// 外部会话名。wire 字段名为冻结前端契约（serde rename 保留原名），仅 Rust 侧中性化。
    #[serde(rename = "tmux_name")]
    pub external_name: String,
    pub project_id: String,
}

/// Response type for GET /sessions/external — a multiplexer session not yet in the DB,
/// enriched with CWD.
#[derive(Debug, Serialize)]
pub struct ExternalSessionResponse {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_nonce: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub workspace_path: String,
    pub name: Option<String>,
    pub tmux_session_name: Option<String>,
    pub hook_enabled: bool,
    pub hook_status: Option<String>,
    pub created_at: String,
    /// Which runtime drives this session. Persisted, defaults to 'tmux' in DB (migration default).
    #[sqlx(default)]
    pub runtime_kind: RuntimeKind,
    /// ACP adapter session id when `runtime_kind = 'acp'`. NULL for non-ACP sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub acp_session_id: Option<String>,
    /// Which agent registry row this session was spawned from. Required for
    /// `runtime_kind = 'acp'`, NULL for non-ACP sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_id: Option<String>,
    /// pty 会话前台进程 cwd 的最近采样（D5：后端重启重建用最后 cwd）。
    /// tmux/acp 会话为 NULL。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub last_cwd: Option<String>,
    /// 归档时间戳（RFC3339；NULL = 未归档）。仅 ACP 会话可归档：归档 =
    /// 释放 agent 子进程 + 从默认列表隐藏，聊天记录保留。经
    /// GET /sessions/archived 单独列出。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub archived_at: Option<String>,
    // Runtime activity indicator (multiplexer activity tracking, not persisted)
    #[serde(skip_serializing_if = "is_false")]
    #[sqlx(default)]
    pub is_active: bool,
    // Agent state fields (read-only, derived from the agent option channel at query time, not persisted)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub attention_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_nonce: Option<String>,
    // Agent process detection (runtime, not persisted)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_detected: Option<String>,
    // ACP agent subprocess currently resident in the supervisor (runtime, not persisted).
    // `true` = process alive and reachable; `false` = released/reaped, session can be restored.
    // 恒序列化（不 skip false）：前端轮询整体替换 sessions 时若缺省该字段会把「已释放」
    // 态覆盖成 undefined，导致恢复按钮/DEAD 指示闪断（见 ws/acp.rs 发送即自动恢复）。
    #[sqlx(default)]
    pub acp_process_alive: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    pub name: Option<String>,
    pub workspace_path: String,
    /// Optional command to run in the session (e.g. "claude" for Claude Code).
    /// If absent, a plain shell is started.
    #[serde(default)]
    pub command: Option<String>,
    /// Which runtime to use. Absent/null → server default (`RuntimeKind::default()`).
    #[serde(default)]
    pub runtime_kind: Option<RuntimeKind>,
    /// Which agent to use when `runtime_kind = 'acp'`. Required in that branch.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSession {
    pub name: Option<String>,
}
