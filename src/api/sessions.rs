use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::json;
use tracing::{error, info};
use uuid::Uuid;

use crate::acp::AcpClient;
use crate::api::agents::load_agent;
use crate::models::session::{AdoptSession, CreateSession, ExternalSessionResponse, RuntimeKind, Session, UpdateSession};
use crate::tmux::{self, agent_state::AgentSnapshot};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{pid}/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/sessions/{id}",
            patch(update_session).delete(delete_session),
        )
        .route("/sessions/{id}/cwd", get(get_session_cwd))
        .route("/sessions/{id}/prompt", post(send_prompt))
        .route("/sessions/{id}/release", post(release_session))
        .route("/sessions/{id}/messages", get(list_messages))
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

    // Batch-fetch agent state from all tmux sessions in a single call.
    // We build a map keyed by tmux session name so the per-session loop
    // below can look up agent state without spawning additional processes.
    let agent_map: HashMap<String, AgentSnapshot> = tmux::list_sessions()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|info| {
            let kind = tmux::agent_state::AgentKind::from_str(
                info.agent_kind.as_deref().unwrap_or(""),
            )?;
            let state = tmux::agent_state::AgentState::from_str(
                info.agent_state.as_deref().unwrap_or(""),
            )?;
            let reason = info
                .attention_reason
                .as_deref()
                .and_then(tmux::agent_state::AttentionReason::from_str);
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
    let alive_acp: std::collections::HashSet<String> = state
        .acp_supervisor
        .snapshot()
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();

    // Enrich sessions with activity state and agent state from tmux.
    // Only tmux-backed sessions have a pane to poll; ACP sessions get their
    // state via the ACP event stream (Phase 3) and are skipped here.
    for session in &mut sessions {
        // ACP 会话：标记 agent 子进程是否在后端驻留（未释放/未被回收）。
        // 这与 tmux 的 is_active 不同，是 supervisor 中真实存在的进程状态。
        if session.runtime_kind == RuntimeKind::Acp {
            session.acp_process_alive = alive_acp.contains(&session.id);
            continue;
        }
        if session.runtime_kind != RuntimeKind::Tmux {
            continue;
        }
        if let Some(ref tmux_name) = session.tmux_session_name {
            session.is_active = state.activity_monitor.is_active(tmux_name).await;

            if let Some(snapshot) = agent_map.get(tmux_name) {
                // Hook-injected session: use option data
                session.agent_kind = Some(snapshot.agent_kind.as_str().to_string());
                session.agent_state = Some(snapshot.agent_state.as_str().to_string());
                session.attention_reason = snapshot.attention_reason.map(|r| r.as_str().to_string());
                session.agent_event = snapshot.agent_event.clone();
                session.agent_nonce = snapshot.agent_nonce.clone();
            }
            // Agent process detection is commented out pending notification scheme decision.
            // See docs/requirements.md "Agent 状态监控与通知".
            // else if !session.hook_enabled {
            //     // No hook injected — scan process tree for agent detection
            //     if let Some(kind) = tmux::detect_agent_in_session(tmux_name).await {
            //         session.agent_detected = Some(kind.as_str().to_string());
            //     }
            // }
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
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "agent not found" })),
                );
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

        state.acp_supervisor.insert(id.clone(), acp_client).await;
        info!("created ACP session: {} (agent: {}, acp_session_id: {})", id, agent_id, acp_session_id);

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

    // Resolve workspace_path: use provided path, fallback to project path
    let workspace_path = resolve_workspace_path(&req.workspace_path, &pid, &state).await;

    let id = Uuid::new_v4().to_string();
    let tmux_name = format!("lt_{}", &id[..8]);
    let now = chrono::Utc::now().to_rfc3339();

    // Create the tmux session; detect agent and inject hooks if applicable
    let hook_enabled = match tmux::new_session(&tmux_name, &workspace_path, req.command.as_deref()).await {
        Ok(injected) => {
            info!("created tmux session: {} (cwd: {})", tmux_name, workspace_path);
            injected && req.command.is_some()
        }
        Err(e) => {
            error!("failed to create tmux session: {}", e);
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
    .bind(&tmux_name)
    .bind(hook_enabled as i32)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    if let Err(e) = state.activity_monitor.ensure_session(&tmux_name).await {
        error!("failed to ensure control mode for new session {}: {}", tmux_name, e);
    }

    let session = Session {
        id,
        project_id: pid,
        workspace_path,
        name: req.name,
        tmux_session_name: Some(tmux_name.clone()),
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

    if let Some((tmux_name, runtime_kind)) = row {
        if runtime_kind == "acp" {
            if let Some(client) = state.acp_supervisor.dispose(&id).await {
                let c = Arc::try_unwrap(client).ok();
                if let Some(c) = c {
                    c.disconnect().await;
                }
            }
        } else if let Some(tmux_name) = tmux_name {
            state.activity_monitor.remove_session(&tmux_name).await;
            if let Err(e) = tmux::kill_session(&tmux_name).await {
                error!("failed to kill tmux session {}: {}", tmux_name, e);
            }
        }
    }

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
                if let Some(c) = Arc::try_unwrap(client).ok() {
                    c.disconnect().await;
                }
            }
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Some(_) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "only acp sessions can be released" })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not found" })),
        ),
    }
}

async fn get_session_cwd(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Look up tmux session name
    let tmux_name: Option<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let Some((tmux_name,)) = tmux_name else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "session not found" })),
        );
    };

    match tmux::pane_cwd(&tmux_name).await {
        Ok(cwd) => (StatusCode::OK, Json(json!({ "cwd": cwd }))),
        Err(e) => {
            error!("pane_cwd failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct PromptRequest {
    text: String,
}

async fn send_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PromptRequest>,
) -> impl IntoResponse {
    let client = match state.acp_supervisor.get(&id).await {
        Some(c) => c,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "ACP session not found" })),
            );
        }
    };

    match client.send_prompt(&req.text).await {
        Ok(resp) => (
            StatusCode::OK,
            Json(json!({ "stop_reason": format!("{:?}", resp.stop_reason) })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("{}", e) })),
        ),
    }
}

async fn list_messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::acp::chat_persistence::list_messages(&state.db, &id).await {
        Ok(rows) => {
            let messages: Vec<serde_json::Value> = rows
                .into_iter()
                .map(|(role, text, created_at, msg_id)| {
                    json!({ "id": msg_id, "role": role, "text": text, "createdAt": created_at })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "messages": messages })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

async fn resolve_workspace_path(
    req_path: &str,
    project_id: &str,
    state: &AppState,
) -> String {
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
            .unwrap_or_else(|| {
                std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
            })
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

/// GET /sessions/external — list tmux sessions not yet recorded in the DB.
async fn list_external_sessions(
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Get all tmux sessions (returns empty vec if no server running or error)
    let tmux_sessions = match tmux::list_sessions().await {
        Ok(s) => s,
        Err(e) => {
            error!("list_external_sessions: tmux error: {}", e);
            return (
                StatusCode::OK,
                Json(json!({ "sessions": [] })),
            );
        }
    };

    // Get all recorded tmux session names from DB
    let recorded: Vec<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE tmux_session_name IS NOT NULL")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

    let recorded_names: HashSet<String> = recorded.into_iter().map(|(n,)| n).collect();

    // Filter to external (unadopted) sessions only
    let external: Vec<_> = tmux_sessions
        .into_iter()
        .filter(|s| !recorded_names.contains(&s.name))
        .collect();

    // Build result from external sessions. CWD is already available from the
    // batch `tmux::list_sessions()` call above — no per-session `pane_cwd` needed.
    let mut result = Vec::with_capacity(external.len());
    for s in external {
        result.push(ExternalSessionResponse {
            name: s.name,
            attached: s.attached,
            windows: s.windows,
            created: s.created,
            cwd: s.cwd,
            agent_kind: s.agent_kind,
            agent_state: s.agent_state,
            attention_reason: s.attention_reason,
            agent_event: s.agent_event,
            agent_nonce: s.agent_nonce,
        });
    }

    (StatusCode::OK, Json(json!({ "sessions": result })))
}

/// POST /sessions/adopt — adopt an external tmux session into a project.
async fn adopt_session(
    State(state): State<AppState>,
    Json(req): Json<AdoptSession>,
) -> impl IntoResponse {
    // Verify the tmux session still exists
    if !tmux::session_exists(&req.tmux_name).await {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "tmux session not found" })),
        );
    }

    // Verify the project exists
    let project_exists: bool =
        sqlx::query_scalar("SELECT COUNT(*) > 0 FROM projects WHERE id = ?")
            .bind(&req.project_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if !project_exists {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "project not found" })),
        );
    }

    // Check for race: session may have been adopted between the GET and this POST
    let already_adopted: bool =
        sqlx::query_scalar("SELECT COUNT(*) > 0 FROM sessions WHERE tmux_session_name = ?")
            .bind(&req.tmux_name)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if already_adopted {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "session already adopted" })),
        );
    }

    // Resolve CWD; fall back to HOME if pane_cwd fails
    let tmux_name = req.tmux_name.clone();
    let workspace_path = tmux::pane_cwd(&tmux_name)
        .await
        .unwrap_or_else(|_| {
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
        });

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'tmux', NULL)",
    )
    .bind(&id)
    .bind(&req.project_id)
    .bind(&workspace_path)
    .bind(&tmux_name)
    .bind(&tmux_name)
    .bind(false as i32)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    // Start the activity monitor for the adopted session
    if let Err(e) = state.activity_monitor.ensure_session(&req.tmux_name).await {
        error!(
            "failed to ensure control mode for adopted session {}: {}",
            req.tmux_name, e
        );
    }

    let session = Session {
        id,
        project_id: req.project_id,
        workspace_path,
        name: Some(tmux_name.clone()),
        tmux_session_name: Some(tmux_name),
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
