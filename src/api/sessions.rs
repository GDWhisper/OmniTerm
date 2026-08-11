use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post},
};
use serde_json::json;
use tracing::{error, info};
use uuid::Uuid;

use crate::AppState;
use crate::acp::AcpClient;
use crate::acp::config_prefs;
use crate::agent::state::AgentSnapshot;
use crate::api::agents::load_agent;
use crate::models::session::{
    AdoptSession, CreateSession, ExternalSessionResponse, RuntimeKind, Session, UpdateSession,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{pid}/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{id}", patch(update_session).delete(delete_session))
        .route("/sessions/{id}/cwd", get(get_session_cwd))
        .route("/sessions/{id}/release", post(release_session))
        .route("/sessions/{id}/messages", get(list_messages))
        .route("/sessions/{id}/messages/sync", post(sync_messages))
        .route("/sessions/external", get(list_external_sessions))
        .route("/sessions/adopt", post(adopt_session))
}

async fn list_sessions(
    State(state): State<AppState>,
    Path(pid): Path<String>,
) -> impl IntoResponse {
    let mut sessions: Vec<Session> =
        sqlx::query_as("SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC")
            .bind(&pid)
            .fetch_all(&state.db)
            .await
            .unwrap();

    // Batch-fetch agent state from all engine sessions in a single call.
    // We build a map keyed by engine session name so the per-session loop
    // below can look up agent state without spawning additional processes.
    let agent_map: HashMap<String, AgentSnapshot> = state
        .engines
        .list_sessions()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|info| {
            let kind =
                crate::agent::state::AgentKind::from_str(info.agent_kind.as_deref().unwrap_or(""))?;
            let state = crate::agent::state::AgentState::from_str(
                info.agent_state.as_deref().unwrap_or(""),
            )?;
            let reason = info
                .attention_reason
                .as_deref()
                .and_then(crate::agent::state::AttentionReason::from_str);
            Some((
                info.name,
                AgentSnapshot {
                    agent_kind: kind,
                    agent_state: state,
                    attention_reason: reason,
                    agent_event: info.agent_event,
                    agent_nonce: info.agent_nonce,
                },
            ))
        })
        .collect();

    // 一次性取出 supervisor 中所有存活的 ACP session id（O(1) 查询用）。
    // 用于标记 acp_process_alive：进程是否仍在后端驻留（未释放/未被回收）。
    let alive_acp: std::collections::HashSet<String> =
        state.acp_supervisor.snapshot().await.into_iter().map(|(id, _)| id).collect();

    // 屏幕检测快照（agent_watch 后台轮询产出）：作为状态权威覆盖 hook 上报的 state。
    // hook 数据仍保留 attention_reason/event/nonce（屏幕检测不产出这些）。
    let screen_map = state.engines.watcher().snapshot().await;

    // Enrich sessions with activity state and agent state from the engine.
    // Only multiplexer-backed sessions have a pane to poll; ACP sessions get their
    // state via the ACP event stream (Phase 3) and are skipped here.
    // Pty sessions have no multiplexer state; they start inactive until a
    // WS handler attaches and drives the PTY.
    for session in &mut sessions {
        // ACP 会话：标记 agent 子进程是否在后端驻留（未释放/未被回收）。
        // 这与复用器的 is_active 不同，是 supervisor 中真实存在的进程状态。
        if session.runtime_kind == RuntimeKind::Acp {
            session.acp_process_alive = alive_acp.contains(&session.id);
            continue;
        }
        if session.runtime_kind != RuntimeKind::Tmux {
            continue;
        }
        if let Some(ref engine_name) = session.tmux_session_name {
            session.is_active = state.engines.is_active(session.runtime_kind, engine_name).await;

            if let Some(snapshot) = agent_map.get(engine_name) {
                // Hook-injected session: use option data
                session.agent_kind = Some(snapshot.agent_kind.as_str().to_string());
                session.agent_state = Some(snapshot.agent_state.as_str().to_string());
                session.attention_reason =
                    snapshot.attention_reason.map(|r| r.as_str().to_string());
                session.agent_event = snapshot.agent_event.clone();
                session.agent_nonce = snapshot.agent_nonce.clone();
            }
            // 屏幕检测覆盖 kind/state（hook 事件流不完整，屏幕检测为状态权威，
            // 见 docs/reference/herdr-reference.md 仲裁策略）
            if let Some(screen) = screen_map.get(engine_name) {
                session.agent_kind = Some(screen.kind.as_str().to_string());
                session.agent_state = Some(screen.state.as_str().to_string());
                session.agent_detected = Some(screen.kind.as_str().to_string());
            }
        }
    }

    Json(json!(sessions))
}

async fn create_session(
    State(state): State<AppState>,
    Path(pid): Path<String>,
    Json(req): Json<CreateSession>,
) -> impl IntoResponse {
    let runtime_kind = req.runtime_kind.unwrap_or_default();

    if runtime_kind == RuntimeKind::Acp {
        let agent_id = match &req.agent_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "agent_id is required for ACP sessions" })),
                );
            }
        };

        let agent = match load_agent(&state.db, &agent_id).await {
            Some(a) => a,
            None => {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "agent not found" })));
            }
        };

        let workspace_path = resolve_workspace_path(&req.workspace_path, &pid, &state).await;

        let cwd = std::path::PathBuf::from(&workspace_path);
        let acp_client = match AcpClient::spawn_and_connect(agent, cwd).await {
            Ok(c) => Arc::new(c),
            Err(e) => {
                error!("ACP spawn failed: {}", e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": format!("failed to spawn agent: {}", e) })),
                );
            }
        };

        let acp_session_id = acp_client.session_id().0.to_string();
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id, agent_id) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, 'acp', ?, ?)",
        )
        .bind(&id)
        .bind(&pid)
        .bind(&workspace_path)
        .bind(&req.name)
        .bind(&now)
        .bind(&acp_session_id)
        .bind(&agent_id)
        .execute(&state.db)
        .await
        .unwrap();

        // 绑定持久化：assistant 回复由累积器实时防抖落库到本会话行，
        // 使流式中刷新/切设备不再丢失进行中的 turn（见 turn_accumulator）。
        acp_client.attach_persistence(state.db.clone(), id.clone());
        // 绑定配置偏好持久化并同步恢复：agent 全局偏好（+ 本会话历史覆盖）在
        // spawn 后立即下发，WS 连接时 initial_config_notification 缓存已是恢复值，
        // 前端新建会话即可看到用户上次的配置。内部带 10s 超时，不阻塞会话注册。
        acp_client.attach_config_prefs(state.db.clone(), id.clone(), agent_id.clone());
        acp_client.restore_config_prefs().await;
        state.acp_supervisor.insert(id.clone(), acp_client).await;
        info!(
            "created ACP session: {} (agent: {}, acp_session_id: {})",
            id, agent_id, acp_session_id
        );

        let session = Session {
            id,
            project_id: pid,
            workspace_path,
            name: req.name,
            tmux_session_name: None,
            hook_enabled: false,
            hook_status: None,
            created_at: now,
            runtime_kind: RuntimeKind::Acp,
            acp_session_id: Some(acp_session_id),
            agent_id: Some(agent_id),
            is_active: true,
            agent_kind: None,
            agent_state: None,
            attention_reason: None,
            agent_event: None,
            agent_nonce: None,
            agent_detected: None,
            acp_process_alive: false,
        };

        return (StatusCode::CREATED, Json(json!(session)));
    }

    if runtime_kind == RuntimeKind::Pty {
        let workspace_path = resolve_workspace_path(&req.workspace_path, &pid, &state).await;
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, 'pty', NULL)",
        )
        .bind(&id)
        .bind(&pid)
        .bind(&workspace_path)
        .bind(&req.name)
        .bind(&now)
        .execute(&state.db)
        .await
        .unwrap();

        info!("created pty session: {} (cwd: {})", id, workspace_path);

        let session = Session {
            id,
            project_id: pid,
            workspace_path,
            name: req.name,
            tmux_session_name: None,
            hook_enabled: false,
            hook_status: None,
            created_at: now,
            runtime_kind: RuntimeKind::Pty,
            acp_session_id: None,
            agent_id: None,
            is_active: false,
            agent_kind: None,
            agent_state: None,
            attention_reason: None,
            agent_event: None,
            agent_nonce: None,
            agent_detected: None,
            acp_process_alive: false,
        };

        return (StatusCode::CREATED, Json(json!(session)));
    }

    // Resolve workspace_path: use provided path, fallback to project path
    let workspace_path = resolve_workspace_path(&req.workspace_path, &pid, &state).await;

    let id = Uuid::new_v4().to_string();
    let engine_name = format!("lt_{}", &id[..8]);
    let now = chrono::Utc::now().to_rfc3339();

    // Create the multiplexer session; detect agent and inject hooks if applicable
    let hook_enabled = match state
        .engines
        .create_session(RuntimeKind::Tmux, &engine_name, &workspace_path, req.command.as_deref())
        .await
    {
        Ok(injected) => {
            info!("created multiplexer session: {} (cwd: {})", engine_name, workspace_path);
            injected && req.command.is_some()
        }
        Err(e) => {
            error!("failed to create multiplexer session: {}", e);
            false
        }
    };

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'tmux', NULL)",
    )
    .bind(&id)
    .bind(&pid)
    .bind(&workspace_path)
    .bind(&req.name)
    .bind(&engine_name)
    .bind(hook_enabled as i32)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    if let Err(e) = state.engines.track_session(RuntimeKind::Tmux, &engine_name).await {
        error!("failed to ensure activity tracking for new session {}: {}", engine_name, e);
    }

    let session = Session {
        id,
        project_id: pid,
        workspace_path,
        name: req.name,
        tmux_session_name: Some(engine_name.clone()),
        hook_enabled,
        hook_status: None,
        created_at: now,
        runtime_kind: RuntimeKind::Tmux,
        acp_session_id: None,
        agent_id: None,
        is_active: false,
        agent_kind: None,
        agent_state: None,
        attention_reason: None,
        agent_event: None,
        agent_nonce: None,
        agent_detected: None,
        acp_process_alive: false,
    };

    (StatusCode::CREATED, Json(json!(session)))
}

async fn update_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateSession>,
) -> impl IntoResponse {
    let result = sqlx::query("UPDATE sessions SET name = COALESCE(?, name) WHERE id = ?")
        .bind(req.name)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    let session: Session = sqlx::query_as("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap();

    (StatusCode::OK, Json(json!(session)))
}

/// 按 `runtime_kind` 清理会话的运行时资源：acp → 释放 supervisor 持有的 agent
/// 子进程；复用器会话 → 关闭活跃度跟踪并 `kill-session` 杀会话进程。
///
/// 只负责进程/运行时清理，**不删除 DB 记录**——由调用方（`delete_session` /
/// `delete_project`）负责删库。两处共用，避免清理逻辑漂移。
pub async fn cleanup_session_runtime(
    state: &AppState,
    session_id: &str,
    engine_name: Option<&str>,
    runtime_kind: &str,
) {
    match runtime_kind {
        "acp" => {
            if let Some(client) = state.acp_supervisor.dispose(session_id).await {
                // shutdown 走 shared reference 立即杀子进程，不依赖 Arc 引用归零：
                // WS handler 持 `Arc<AcpClient>` 时 try_unwrap 永远失败，旧写法会
                // 留下孤儿进程（删了 DB 行/释放了注册，进程却还在跑）。
                client.shutdown().await;
            }
        }
        "pty" => {
            // PtyEngine sessions are owned by the WS handler; nothing to dispose here.
        }
        _ => {
            if let Some(name) = engine_name {
                state.engines.untrack_session(RuntimeKind::Tmux, name).await;
                if let Err(e) = state.engines.kill_session(RuntimeKind::Tmux, name).await {
                    error!("failed to kill multiplexer session {}: {}", name, e);
                }
            }
        }
    }
}

async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT tmux_session_name, runtime_kind FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    if let Some((engine_name, runtime_kind)) = row {
        cleanup_session_runtime(&state, &id, engine_name.as_deref(), &runtime_kind).await;
    }

    // 清理会话级配置偏好行（foreign_keys 级联本会覆盖，这里显式清理兜底）。
    let _ = config_prefs::clear_session_configs(&state.db, &id).await;

    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// 手动释放 ACP 会话的后端子进程（codebuddy --acp 等），**不删除会话记录**。
///
/// 与 `delete_session`（杀进程 + 删库）不同，release 仅 `supervisor.dispose` +
/// `disconnect` 杀掉 supervisor 中驻留的 agent 子进程，保留 DB 会话行。
/// 之后用户仍可通过"恢复会话"重新 spawn 进程，与空闲自动回收（reaper）
/// 的语义一致。对非 acp 会话返回 400（无 supervisor 子进程可释放）。
async fn release_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime_kind: Option<String> =
        sqlx::query_scalar("SELECT runtime_kind FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    match runtime_kind.as_deref() {
        Some("acp") => {
            if let Some(client) = state.acp_supervisor.dispose(&id).await {
                // 同上：shutdown 强制杀进程，否则聚焦该会话时 WS handler 持有的
                // Arc 引用会让进程残留，Sidebar 却显示已释放（与实际进程存活脱节）。
                client.shutdown().await;
            }
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Some(_) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": "only acp sessions can be released" })))
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
    }
}

async fn get_session_cwd(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Look up session base info
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT runtime_kind, tmux_session_name, workspace_path FROM sessions WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((runtime_kind, engine_name, workspace_path_opt)) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "session not found" })));
    };

    let workspace_path = workspace_path_opt
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    // Pty / ACP sessions do not have a live multiplexer pane; use workspace_path.
    if runtime_kind != "tmux" || engine_name.is_empty() {
        return (StatusCode::OK, Json(json!({ "cwd": workspace_path })));
    }

    // Resolve CWD from the live multiplexer pane (fall back to workspace_path)
    let cwd = match state.engines.current_cwd(RuntimeKind::Tmux, &engine_name).await {
        Ok(cwd) => cwd,
        Err(e) => {
            error!("pane_cwd failed for {}: {}", engine_name, e);
            workspace_path
        }
    };

    (StatusCode::OK, Json(json!({ "cwd": crate::fs::display_path_str(&cwd) })))
}

/// Default page size for `GET /messages`. Sized so an ordinary session loads in one
/// request (no visible paging) while a session that ran for weeks cannot make the first
/// paint wait on its whole history.
const MESSAGES_PAGE_DEFAULT_LIMIT: usize = 100;

/// Hard ceiling for a client-supplied `limit` — the client picks its page size, it does
/// not get to ask for an unbounded response (performance-and-safety.md §P4).
const MESSAGES_PAGE_MAX_LIMIT: usize = 500;

/// Payload budget per page. Row count alone does not bound the response: a single
/// `blocks` column can be megabytes (see `turn_accumulator`), so bytes are the axis that
/// keeps first paint fast. Applied newest-first, always yielding at least one row.
const MESSAGES_PAGE_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct ListMessagesQuery {
    /// Opaque cursor from a previous response's `nextCursor`; absent = newest page.
    before: Option<String>,
    /// Page size, clamped to [`MESSAGES_PAGE_MAX_LIMIT`].
    limit: Option<usize>,
}

/// Newest page of a session's chat history, or the page before `?before=<cursor>`.
/// Messages are oldest-first; `nextCursor` is non-null when older messages remain
/// (the frontend requests them when the user scrolls to the top).
async fn list_messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ListMessagesQuery>,
) -> impl IntoResponse {
    let before = match q.before.as_deref() {
        Some(raw) => match crate::acp::chat_persistence::MessageCursor::parse(raw) {
            Some(c) => Some(c),
            // Reject rather than silently serving the newest page: a client that keeps
            // getting page 1 back would paginate forever.
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "malformed before cursor" })),
                );
            }
        },
        None => None,
    };
    let limit = q.limit.unwrap_or(MESSAGES_PAGE_DEFAULT_LIMIT).min(MESSAGES_PAGE_MAX_LIMIT);

    match crate::acp::chat_persistence::list_messages_page(
        &state.db,
        &id,
        before.as_ref(),
        limit,
        MESSAGES_PAGE_MAX_BYTES,
    )
    .await
    {
        Ok(page) => {
            let messages: Vec<serde_json::Value> = page
                .rows
                .into_iter()
                .map(|(role, text, created_at, msg_id, blocks, status, last_seq)| {
                    json!({
                        "id": msg_id,
                        "role": role,
                        "text": text,
                        "createdAt": created_at,
                        "blocks": blocks,
                        "status": status,
                        "lastSeq": last_seq,
                    })
                })
                .collect();
            let next_cursor = page.next_cursor.map(|c| c.encode());
            (
                StatusCode::OK,
                Json(json!({
                    "messages": messages,
                    "hasMore": next_cursor.is_some(),
                    "nextCursor": next_cursor,
                })),
            )
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))),
    }
}

/// 恢复会话重放完成后 / 一个 turn 结束时，前端把重建或 cooked 的消息（含结构化 blocks）
/// 写回 DB。后端按行 id 优先、文本退回匹配，不删除已有记录，使刷新浏览器后仍可从
/// `list_messages_page` 还原完整历史（含工具卡片 / 思考 / 计划），且保留实时 prompt
/// 已落库的 user 消息。匹配语义见 `chat_persistence::sync_messages`。
async fn sync_messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SyncMessagesRequest>,
) -> impl IntoResponse {
    let rows: Vec<crate::acp::chat_persistence::SyncMessageInput> = body
        .messages
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| crate::acp::chat_persistence::SyncMessageInput {
            id: m.id,
            role: m.role,
            text: m.text,
            blocks: m.blocks,
        })
        .collect();
    match crate::acp::chat_persistence::sync_messages(&state.db, &id, &rows).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))),
    }
}

#[derive(serde::Deserialize)]
struct SyncMessagesRequest {
    messages: Vec<SyncMessage>,
}

#[derive(serde::Deserialize)]
struct SyncMessage {
    /// DB row id, present only when the frontend knows the real one (hydrated rows / the
    /// in-progress turn's `row_id`). Absent → text matching, see
    /// `chat_persistence::SyncMessageInput`.
    #[serde(default)]
    id: Option<String>,
    role: String,
    text: String,
    #[serde(default)]
    blocks: Option<String>,
}

async fn resolve_workspace_path(req_path: &str, project_id: &str, state: &AppState) -> String {
    let raw = if req_path.is_empty() {
        let project_path: Option<(String,)> =
            sqlx::query_as("SELECT path FROM projects WHERE id = ?")
                .bind(project_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        project_path
            .map(|(p,)| p)
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
    } else {
        req_path.to_string()
    };

    let expanded = if raw == "~" || raw.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        raw.replacen('~', &home, 1)
    } else {
        raw
    };

    if std::path::Path::new(&expanded).exists() {
        expanded
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
    }
}

/// GET /sessions/external — list multiplexer sessions not yet recorded in the DB.
async fn list_external_sessions(State(state): State<AppState>) -> impl IntoResponse {
    // Get all multiplexer sessions (returns empty vec if no server running or error)
    let mux_sessions = match state.engines.list_sessions().await {
        Ok(s) => s,
        Err(e) => {
            error!("list_external_sessions: multiplexer error: {}", e);
            return (StatusCode::OK, Json(json!({ "sessions": [] })));
        }
    };

    // Get all recorded engine session names from DB
    let recorded: Vec<(String,)> = sqlx::query_as(
        "SELECT tmux_session_name FROM sessions WHERE tmux_session_name IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let recorded_names: HashSet<String> = recorded.into_iter().map(|(n,)| n).collect();

    // Filter to external (unadopted) sessions only
    let external: Vec<_> =
        mux_sessions.into_iter().filter(|s| !recorded_names.contains(&s.name)).collect();

    // Build result from external sessions. CWD is already available from the
    // batch `list_sessions()` call above — no per-session `current_cwd` needed.
    // 屏幕检测覆盖 kind/state（与 list_sessions 同一仲裁策略）。
    let screen_map = state.engines.watcher().snapshot().await;
    let mut result = Vec::with_capacity(external.len());
    for s in external {
        let screen = screen_map.get(&s.name);
        result.push(ExternalSessionResponse {
            agent_kind: screen.map(|sc| sc.kind.as_str().to_string()).or(s.agent_kind),
            agent_state: screen.map(|sc| sc.state.as_str().to_string()).or(s.agent_state),
            name: s.name,
            attached: s.attached,
            windows: s.windows,
            created: s.created,
            cwd: s.cwd.map(|c| crate::fs::display_path_str(&c)),
            attention_reason: s.attention_reason,
            agent_event: s.agent_event,
            agent_nonce: s.agent_nonce,
        });
    }

    (StatusCode::OK, Json(json!({ "sessions": result })))
}

/// POST /sessions/adopt — adopt an external multiplexer session into a project.
async fn adopt_session(
    State(state): State<AppState>,
    Json(req): Json<AdoptSession>,
) -> impl IntoResponse {
    // Verify the multiplexer session still exists
    if !state.engines.session_exists(RuntimeKind::Tmux, &req.external_name).await {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "multiplexer session not found" })));
    }

    // Verify the project exists
    let project_exists: bool = sqlx::query_scalar("SELECT COUNT(*) > 0 FROM projects WHERE id = ?")
        .bind(&req.project_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

    if !project_exists {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "project not found" })));
    }

    // Check for race: session may have been adopted between the GET and this POST
    let already_adopted: bool =
        sqlx::query_scalar("SELECT COUNT(*) > 0 FROM sessions WHERE tmux_session_name = ?")
            .bind(&req.external_name)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if already_adopted {
        return (StatusCode::CONFLICT, Json(json!({ "error": "session already adopted" })));
    }

    // Resolve CWD; fall back to HOME if pane_cwd fails.
    // display_path_str: Windows 下 pane_cwd 返回反斜杠路径，统一成正斜杠再入库，
    // 否则与 worktree 路径（git 输出，正斜杠）永不匹配，会变成孤儿会话
    let engine_name = req.external_name.clone();
    let workspace_path = state
        .engines
        .current_cwd(RuntimeKind::Tmux, &engine_name)
        .await
        .map(|c| crate::fs::display_path_str(&c))
        .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'tmux', NULL)",
    )
    .bind(&id)
    .bind(&req.project_id)
    .bind(&workspace_path)
    .bind(&engine_name)
    .bind(&engine_name)
    .bind(false as i32)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    // Start activity tracking for the adopted session
    if let Err(e) = state.engines.track_session(RuntimeKind::Tmux, &engine_name).await {
        error!("failed to ensure activity tracking for adopted session {}: {}", engine_name, e);
    }

    let session = Session {
        id,
        project_id: req.project_id,
        workspace_path,
        name: Some(engine_name.clone()),
        tmux_session_name: Some(engine_name),
        hook_enabled: false,
        hook_status: None,
        created_at: now,
        runtime_kind: RuntimeKind::Tmux,
        acp_session_id: None,
        agent_id: None,
        is_active: false,
        agent_kind: None,
        agent_state: None,
        attention_reason: None,
        agent_event: None,
        agent_nonce: None,
        agent_detected: None,
        acp_process_alive: false,
    };

    (StatusCode::CREATED, Json(json!(session)))
}
