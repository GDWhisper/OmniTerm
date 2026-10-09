use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post},
};
use serde_json::json;
use tracing::{error, info, warn};
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
        .route("/sessions/{id}/archive", post(archive_session))
        .route("/sessions/{id}/unarchive", post(unarchive_session))
        .route("/sessions/{id}/messages", get(list_messages))
        .route("/sessions/{id}/messages/sync", post(sync_messages))
        .route("/sessions/external", get(list_external_sessions))
        .route("/sessions/archived", get(list_archived_sessions))
        .route("/sessions/adopt", post(adopt_session))
}

async fn list_sessions(
    State(state): State<AppState>,
    Path(pid): Path<String>,
) -> impl IntoResponse {
    let mut sessions: Vec<Session> =
        sqlx::query_as("SELECT * FROM sessions WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC")
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
    // ACP sessions get their state via the ACP event stream and are skipped;
    // tmux/pty 会话经引擎注册表取 is_active（control mode 2s 窗口 /
    // pty 读循环时间戳，口径见计划 §4）与屏幕检测结果。
    for session in &mut sessions {
        // ACP 会话：标记 agent 子进程是否在后端驻留（未释放/未被回收）。
        // 这与复用器的 is_active 不同，是 supervisor 中真实存在的进程状态。
        if session.runtime_kind == RuntimeKind::Acp {
            session.acp_process_alive = alive_acp.contains(&session.id);
            continue;
        }
        if let Some(ref engine_name) = session.tmux_session_name {
            session.is_active = state.engines.is_active(session.runtime_kind, engine_name).await;

            // hook 信道数据：tmux 从 agent_map（`@omniterm_agent` option 枚举）；
            // pty 从 HTTP hook 信道 KV（agent_snapshot 仅在存活窗口内返回，
            // 即 HookAuthority 的「hook 存活」判据，D7）。
            let hook_snapshot: Option<AgentSnapshot> = if session.runtime_kind == RuntimeKind::Pty {
                state.engines.agent_snapshot(RuntimeKind::Pty, engine_name).await.ok().flatten()
            } else {
                agent_map.get(engine_name).cloned()
            };

            if let Some(ref snapshot) = hook_snapshot {
                // Hook-injected session: use hook channel data
                session.agent_kind = Some(snapshot.agent_kind.as_str().to_string());
                session.agent_state = Some(snapshot.agent_state.as_str().to_string());
                session.attention_reason =
                    snapshot.attention_reason.map(|r| r.as_str().to_string());
                session.agent_event = snapshot.agent_event.clone();
                session.agent_nonce = snapshot.agent_nonce.clone();
            }
            // 屏幕检测覆盖 kind/state（tmux：hook 事件流不完整，屏幕检测恒为
            // 状态权威，冻结行为；pty：hook 存活时为权威、屏幕检测降级
            // fallback，见计划 D7 HookAuthority）
            let hook_authoritative =
                session.runtime_kind == RuntimeKind::Pty && hook_snapshot.is_some();
            if let Some(screen) = screen_map.get(engine_name) {
                if !hook_authoritative {
                    session.agent_kind = Some(screen.kind.as_str().to_string());
                    session.agent_state = Some(screen.state.as_str().to_string());
                }
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
        let acp_client = match AcpClient::spawn_and_connect(agent, cwd, &state.api_keys).await {
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
        // 绑定权限超时配置：权限请求到达时唤醒 reaper 立即评估（「总是」档
        // 到达即应答，不等定时 tick）。
        acp_client.attach_perm_timeout(state.acp_perm_timeout.clone());
        // 绑定配置偏好持久化并同步恢复：agent 全局偏好（+ 本会话历史覆盖）在
        // spawn 后立即下发，WS 连接时 initial_config_notification 缓存已是恢复值，
        // 前端新建会话即可看到用户上次的配置。内部带 10s 超时，不阻塞会话注册。
        acp_client.attach_config_prefs(state.db.clone(), id.clone(), agent_id.clone()).await;
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
            last_cwd: None,
            archived_at: None,
            work_ms: 0,
            wait_ms: 0,
            turn_count: 0,
            last_turn_at: None,
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

        // 引擎会话键 = session id，存入冻结列 tmux_session_name（过渡期两引擎
        // 共用，D10）。无命令时惰性 spawn（首次 WS attach / files 解析时由
        // PtyEngine resolve-or-create）；携带 agent 命令时立即 spawn 并注入
        // hook（curl 上报信道，D7），与复用器路径语义对齐。
        let hook_enabled = match req.command.as_deref() {
            Some(cmd) => {
                match state
                    .engines
                    .create_session(RuntimeKind::Pty, &id, &workspace_path, Some(cmd))
                    .await
                {
                    Ok(injected) => injected,
                    Err(e) => {
                        error!("failed to create pty session with command: {}", e);
                        false
                    }
                }
            }
            None => false,
        };

        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at, runtime_kind, acp_session_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pty', NULL)",
        )
        .bind(&id)
        .bind(&pid)
        .bind(&workspace_path)
        .bind(&req.name)
        .bind(&id)
        .bind(hook_enabled as i32)
        .bind(&now)
        .execute(&state.db)
        .await
        .unwrap();

        info!("created pty session: {} (cwd: {})", id, workspace_path);

        let engine_key = id.clone();
        let session = Session {
            id,
            project_id: pid,
            workspace_path,
            name: req.name,
            tmux_session_name: Some(engine_key),
            hook_enabled,
            hook_status: None,
            created_at: now,
            runtime_kind: RuntimeKind::Pty,
            acp_session_id: None,
            agent_id: None,
            last_cwd: None,
            archived_at: None,
            work_ms: 0,
            wait_ms: 0,
            turn_count: 0,
            last_turn_at: None,
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
        last_cwd: None,
        archived_at: None,
        work_ms: 0,
        wait_ms: 0,
        turn_count: 0,
        last_turn_at: None,
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

/// agent 侧记录清理的结果语义（`DELETE /sessions/{id}` 响应的 `agent_side` 字段，
/// **协议稳定值**，改名等于改前端契约）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSide {
    /// 未请求（未勾选 / 非 ACP 会话）。
    NotRequested,
    /// `session/delete` 已由 agent 确认（RPC 成功；软删还是硬删由实现决定）。
    Deleted,
    /// 请求了但未能删除：agent 未声明能力 / 临时拉起失败 / RPC 失败。
    Skipped,
}

impl AgentSide {
    fn as_str(self) -> &'static str {
        match self {
            AgentSide::NotRequested => "not_requested",
            AgentSide::Deleted => "deleted",
            AgentSide::Skipped => "skipped",
        }
    }
}

/// 删除会话时对 agent 侧记录的动作请求（`?delete_agent_side=true`）。
///
/// 仅 acp 分支消费；字段全部由调用方从会话行读出——**不能**用
/// `client.session_id()` 代替：会话行才是「用户以为自己在删哪条记录」的真源，
/// 两者理论上一致，但行数据是删除动作的依据。`agent_id` / `workspace_path`
/// 供无活连接时的临时拉起兜底重建 spawn 现场（见
/// [`delete_agent_side_record_via_ephemeral_spawn`]）。
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentSideDelete<'a> {
    pub requested: bool,
    pub acp_session_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
}

/// 按 `runtime_kind` 清理会话的运行时资源：acp → 释放 supervisor 持有的 agent
/// 子进程；复用器会话 → 关闭活跃度跟踪并 `kill-session` 杀会话进程。
///
/// 只负责进程/运行时清理，**不删除 DB 记录**——由调用方（`delete_session` /
/// `delete_project`）负责删库。两处共用，避免清理逻辑漂移。
///
/// `agent_side` 仅在 acp 分支生效：请求删除 agent 侧记录时，优先在**仍活着**的
/// 子进程上先发 `session/delete` 再 shutdown（省一次 spawn）；进程不驻留
/// （已释放 / 被回收 / 后端重启 / 连接已死）则临时拉起一个 agent 进程补发，
/// 不让用户「先恢复会话再删」地多跑一趟（见
/// [`delete_agent_side_record_via_ephemeral_spawn`]）。best-effort：任何失败只
/// WARN、不阻断删除（omniterm 侧记录照删，返回值告知前端）。
pub async fn cleanup_session_runtime(
    state: &AppState,
    session_id: &str,
    engine_name: Option<&str>,
    runtime_kind: &str,
    agent_side: AgentSideDelete<'_>,
) -> AgentSide {
    match runtime_kind {
        "acp" => {
            if let Some(client) = state.acp_supervisor.dispose(session_id).await {
                // 连接还活着就原地发（省一次 spawn）；连接已死（agent 崩溃 / poll
                // 卡死）则收尸后落回临时拉起——用户要的是删除结果，而不是「注册表
                // 里恰好有个死句柄」。
                if client.is_alive() {
                    let outcome = delete_agent_side_record(&client, agent_side).await;
                    // shutdown 走 shared reference 主动 teardown，不依赖 Arc 引用归零：
                    // WS handler 持 `Arc<AcpClient>` 时 try_unwrap 永远失败，旧写法会
                    // 留下孤儿进程（删了 DB 行/释放了注册，进程却还在跑）。
                    // teardown 内含 killpg 杀 agent 进程组（D2，2026-09-21 CPU 尖峰
                    // 修复）：连接 poll 卡死时 crate 内部 ChildGuard 的 killpg 永远
                    // 走不到，须由 omniterm 侧直接击杀。详见 acp::agent_proc。
                    client.shutdown().await;
                    return outcome;
                }
                client.shutdown().await;
            }
            // 无活连接（已释放 / 被 reaper 回收 / 后端重启后从未恢复 / 连接已死）：
            // 临时拉起一个 agent 进程补发 `session/delete`——勾选就是「把这条痕迹
            // 删掉」的承诺，不该因为 omniterm 侧进程恰好不在就退回给用户手动做。
            if agent_side.requested {
                return delete_agent_side_record_via_ephemeral_spawn(state, agent_side).await;
            }
            AgentSide::NotRequested
        }
        "pty" => {
            // 常驻会话由 PtyEngine 持有：显式 kill（三级信号升级），
            // WS 断开不触发此路径（detach 语义）。
            if let Some(name) = engine_name
                && let Err(e) = state.engines.kill_session(RuntimeKind::Pty, name).await
            {
                error!("failed to kill pty session {}: {}", name, e);
            }
            AgentSide::NotRequested
        }
        _ => {
            if let Some(name) = engine_name {
                state.engines.untrack_session(RuntimeKind::Tmux, name).await;
                if let Err(e) = state.engines.kill_session(RuntimeKind::Tmux, name).await {
                    error!("failed to kill multiplexer session {}: {}", name, e);
                }
            }
            AgentSide::NotRequested
        }
    }
}

/// agent 侧删除的**前置判据**：给定请求与「该 agent 是否声明了 delete 能力」，
/// 决定是否发 `session/delete`。抽成纯函数是为了让三条「不发送」分支（未勾选 /
/// 会话行无 `acp_session_id` / agent 不支持）**不依赖活连接即可单测**——它们
/// 恰恰是「用户勾了却没删」时最需要区分的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentSidePlan<'a> {
    /// 未请求（用户没勾选）。
    NotRequested,
    /// 请求了但发不了，附跳过原因（进日志与响应）。
    Skip(&'static str),
    /// 应发 `session/delete`，携带要删的 agent 侧 session id。
    Send(&'a str),
}

fn plan_agent_side_delete<'a>(
    agent_side: AgentSideDelete<'a>,
    supports_delete_session: bool,
) -> AgentSidePlan<'a> {
    if !agent_side.requested {
        return AgentSidePlan::NotRequested;
    }
    let Some(acp_session_id) = agent_side.acp_session_id.filter(|s| !s.is_empty()) else {
        return AgentSidePlan::Skip("会话行无 acp_session_id");
    };
    // §8 多实现兼容：未声明能力的 agent（实测 codebuddy）不盲发——`method not
    // found` 与真失败混在一起就无法对用户如实交代。
    if !supports_delete_session {
        return AgentSidePlan::Skip("agent 未声明 sessionCapabilities.delete");
    }
    AgentSidePlan::Send(acp_session_id)
}

/// 在**活连接**上执行 agent 侧记录删除（`session/delete`），best-effort。
///
/// 三种「不做」各有独立日志，便于事后区分「用户没勾」「agent 不支持」「发失败」。
async fn delete_agent_side_record(
    client: &crate::acp::AcpClient,
    agent_side: AgentSideDelete<'_>,
) -> AgentSide {
    match plan_agent_side_delete(agent_side, client.supports_delete_session()) {
        AgentSidePlan::NotRequested => AgentSide::NotRequested,
        AgentSidePlan::Skip(reason) => {
            info!("delete_session: 跳过 agent 侧删除（{}）", reason);
            AgentSide::Skipped
        }
        AgentSidePlan::Send(acp_session_id) => match client.delete_session(acp_session_id).await {
            Ok(()) => {
                info!("delete_session: agent 侧记录已删除（{}）", acp_session_id);
                AgentSide::Deleted
            }
            Err(e) => {
                // 删除是对用户承诺的「痕迹消失」，失败必须留痕（不要吞成 Ok）。
                warn!(
                    "delete_session: session/delete 失败（{}），omniterm 侧记录照删：{}",
                    acp_session_id, e
                );
                AgentSide::Skipped
            }
        },
    }
}

/// 临时拉起兜底的单阶段预算（spawn 握手 / `session/delete` RPC 各一份）：
/// 与 `agents.rs` 的连接测试同量级（15s）——npx 冷启动类 agent 可能秒级，
/// 超时按 best-effort 失败处理（`skipped`），绝不无限等。
const EPHEMERAL_AGENT_TIMEOUT: Duration = Duration::from_secs(15);

/// 无活连接时的兜底：临时拉起 agent 子进程（**不注册 supervisor**，与
/// `agents.rs` 的连接测试同形态），现场 gate 能力位后补发 `session/delete`，
/// 随后立刻收尾。
///
/// 为什么值得为一次删除起进程：用户勾选的是「把这条痕迹删掉」，进程不在
/// （reaper 回收 / 手动 release / 后端重启 / 连接已死）只是 omniterm 侧的状态，
/// 不该让用户「先恢复会话 → 再删」地多跑一趟。`session/delete` 按 id 生效、
/// 不要求是创建该会话的那个进程（opencode / pi-acp 实测，见协议参考 §17.3）。
///
/// 失败语义与活连接路径一致：spawn 失败 / 超时、会话行缺 `acp_session_id`、
/// agent 配置或工作目录不存在、能力未声明、RPC 失败——一律 best-effort 跳过
/// （`skipped`）并留痕，绝不谎报已删，也不阻断 omniterm 侧删除。
async fn delete_agent_side_record_via_ephemeral_spawn(
    state: &AppState,
    agent_side: AgentSideDelete<'_>,
) -> AgentSide {
    if agent_side.acp_session_id.is_none_or(str::is_empty) {
        info!("delete_session: 跳过 agent 侧删除（会话行无 acp_session_id）");
        return AgentSide::Skipped;
    }
    let Some(agent_id) = agent_side.agent_id.filter(|s| !s.is_empty()) else {
        info!("delete_session: 跳过 agent 侧删除（会话行无 agent_id）");
        return AgentSide::Skipped;
    };
    let Some(agent) = load_agent(&state.db, agent_id).await else {
        info!(agent_id, "delete_session: 跳过 agent 侧删除（agent 配置不存在）");
        return AgentSide::Skipped;
    };
    // cwd 与 restore 同源（`workspace_path`）：agent 侧按 cwd 组织会话历史，
    // 换一个目录拉起可能定位不到目标记录。
    let cwd = PathBuf::from(agent_side.workspace_path.unwrap_or_default());
    if !cwd.is_dir() {
        info!(cwd = %cwd.display(), "delete_session: 跳过 agent 侧删除（工作目录不存在）");
        return AgentSide::Skipped;
    }

    let client = match tokio::time::timeout(
        EPHEMERAL_AGENT_TIMEOUT,
        AcpClient::spawn_and_connect(agent, cwd, &state.api_keys),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => {
            warn!(agent_id, "delete_session: 临时拉起 agent 失败，agent 侧记录未删除：{e}");
            return AgentSide::Skipped;
        }
        Err(_) => {
            // 超时即握手未完成：外层 future 被 drop → crate teardown（ChildGuard
            // killpg）回收进程组，与 agents.rs 连接测试同一兜底路径。
            warn!(
                agent_id,
                "delete_session: 临时拉起 agent 超时（{}s），agent 侧记录未删除",
                EPHEMERAL_AGENT_TIMEOUT.as_secs()
            );
            return AgentSide::Skipped;
        }
    };
    // RPC 单独限时：spawn 与 delete 各有一份预算，慢 agent 不会把 HTTP 请求
    // 无限期挂住；超时后照常走 disconnect 收尸（killpg 进程组）。
    let outcome = match tokio::time::timeout(
        EPHEMERAL_AGENT_TIMEOUT,
        delete_agent_side_record(&client, agent_side),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => {
            warn!(
                agent_id,
                "delete_session: session/delete 超时（{}s），agent 侧记录未删除",
                EPHEMERAL_AGENT_TIMEOUT.as_secs()
            );
            AgentSide::Skipped
        }
    };
    client.disconnect().await;
    outcome
}

/// `DELETE /sessions/{id}` 删行前读取的现场数据：`runtime_kind` 决定清理分支，
/// agent 侧删除的三元数据（`acp_session_id` / `agent_id` / `workspace_path`）
/// 供活连接与临时拉起两条路径使用（见 `AgentSideDelete` 文档）。
#[derive(sqlx::FromRow)]
struct DeleteSessionRow {
    tmux_session_name: Option<String>,
    runtime_kind: String,
    acp_session_id: Option<String>,
    agent_id: Option<String>,
    workspace_path: Option<String>,
}

/// `DELETE /sessions/{id}` 的查询参数。`delete_agent_side=true` 时顺带删除
/// agent 侧会话记录（仅 acp 会话 + agent 声明了 `sessionCapabilities.delete` 时生效）。
#[derive(Debug, serde::Deserialize)]
struct DeleteSessionQuery {
    #[serde(default)]
    delete_agent_side: bool,
}

async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DeleteSessionQuery>,
) -> impl IntoResponse {
    // agent 侧删除的现场数据必须在删行前读出（行没了就取不到 `acp_session_id`
    // 这条「删哪条」的依据与临时拉起的 spawn 现场）。
    let row: Option<DeleteSessionRow> = sqlx::query_as(
        "SELECT tmux_session_name, runtime_kind, acp_session_id, agent_id, workspace_path \
         FROM sessions WHERE id = ?",
    )
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

    let mut agent_side = AgentSide::NotRequested;
    if let Some(row) = row {
        // agent 侧删除必须在进程还活着时发，故这一段在 cleanup 内完成（删除的
        // dispose → session/delete → shutdown 顺序不可调换；进程不在则由
        // cleanup 内的临时拉起兜底补发）。
        agent_side = cleanup_session_runtime(
            &state,
            &id,
            row.tmux_session_name.as_deref(),
            &row.runtime_kind,
            AgentSideDelete {
                requested: query.delete_agent_side,
                acp_session_id: row.acp_session_id.as_deref(),
                agent_id: row.agent_id.as_deref(),
                workspace_path: row.workspace_path.as_deref(),
            },
        )
        .await;
    }

    // 清理会话级配置偏好行（foreign_keys 级联本会覆盖，这里显式清理兜底）。
    let _ = config_prefs::clear_session_configs(&state.db, &id).await;

    (StatusCode::OK, Json(json!({ "ok": true, "agent_side": agent_side.as_str() })))
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
                // 同上：shutdown 的 teardown 含 killpg 杀 agent 进程组（D2），
                // 否则聚焦该会话时 WS handler 持有的 Arc 引用会让进程残留，
                // Sidebar 却显示已释放（与实际进程存活脱节）。
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

/// 归档 ACP 会话：释放 agent 子进程（与 release 同一清理路径）+ 打归档标记。
/// 归档会话从默认列表消失、聊天记录保留，经 GET /sessions/archived 单独列出，
/// 点击后只读查看历史（前端复用已释放会话的渲染路径）。非 acp 会话返回 400
/// ——终端会话没有值得冷藏的历史，不需要的直接删除即可。
async fn archive_session(
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
        Some("acp") => {}
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "only acp sessions can be archived" })),
            );
        }
        None => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
    }

    // 归档即释放：dispose + shutdown supervisor 中驻留的 agent 子进程。
    // 归档**不**删 agent 侧记录：聊天记录要保留供只读查看，抹掉 agent 侧历史
    // 与归档语义相悖（要抹掉应走删除会话 + 勾选）。
    cleanup_session_runtime(&state, &id, None, "acp", AgentSideDelete::default()).await;

    let now = chrono::Utc::now().to_rfc3339();
    match mark_archived(&state.db, &id, Some(&now)).await {
        Ok(1) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            error!("failed to archive session {}: {}", id, e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "archive failed" })))
        }
    }
}

/// 取消归档：清除标记，会话回到原项目/worktree 的默认列表。运行时进程不随之
/// 恢复——ACP 会话与已释放会话一样经「恢复会话」路径按需重新 spawn。
async fn unarchive_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match mark_archived(&state.db, &id, None).await {
        Ok(1) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            error!("failed to unarchive session {}: {}", id, e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "unarchive failed" })))
        }
    }
}

/// 归档标记唯一写入口：`Some(ts)` 归档 / `None` 取消归档，返回受影响行数
/// （0 = 会话不存在）。抽成独立函数使 DB 级测试可直接驱动同一 SQL 语义。
async fn mark_archived(
    db: &sqlx::SqlitePool,
    id: &str,
    archived_at: Option<&str>,
) -> sqlx::Result<u64> {
    let result = sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ?")
        .bind(archived_at)
        .bind(id)
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

/// 全局列出所有归档会话（跨项目，Session.project_id 供前端标注来源项目）。
/// 归档会话的 agent 进程必然已释放，无需引擎状态富化——纯 DB 读，零引擎调用。
async fn list_archived_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let sessions: Vec<Session> = sqlx::query_as(
        "SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    Json(json!(sessions))
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
                .map(|row| {
                    json!({
                        "id": row.id,
                        "role": row.role,
                        "text": row.text,
                        "createdAt": row.created_at,
                        "blocks": row.blocks,
                        "status": row.status,
                        "lastSeq": row.last_seq,
                        // 该 turn 的工作时长 / 等真人审批时长（ms）。null = 无记录
                        // （迁移前的历史行，或一帧未发的空 turn），前端据此不渲染，
                        // 区别于 0。
                        "durationMs": row.duration_ms,
                        "waitMs": row.wait_ms,
                    })
                })
                .collect();
            let next_cursor = page.next_cursor.map(|c| c.encode());
            // 最后一次已知的配置选项快照 + 会话是否仍有活 agent：前端据此在已结束
            // 会话里置灰只读展示配置栏（活会话的配置栏照常由 WS 配置帧驱动）。
            let config_options =
                crate::acp::config_prefs::load_config_snapshot(&state.db, &id).await;
            // 上下文用量同快照模式：usage_update 不随 session/load 重放、广播无补发，
            // 前端刷新 / 换设备后靠这里恢复「最后已知」徽章；实时值由 WS 通知覆盖。
            let usage = crate::acp::usage::load_usage_snapshot(&state.db, &id).await;
            let agent_live = state.acp_supervisor.get(&id).await.is_some();
            (
                StatusCode::OK,
                Json(json!({
                    "messages": messages,
                    "hasMore": next_cursor.is_some(),
                    "nextCursor": next_cursor,
                    "configOptions": config_options,
                    "usage": usage,
                    "agentLive": agent_live,
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
        last_cwd: None,
        archived_at: None,
        work_ms: 0,
        wait_ms: 0,
        turn_count: 0,
        last_turn_at: None,
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

#[cfg(test)]
mod archive_tests {
    use super::mark_archived;
    use sqlx::{Row, sqlite::SqlitePoolOptions};

    /// 与 `runtime_kind_migration.rs` 同一模式：内存 sqlite + migrations，
    /// 无 HTTP / 无进程。验证归档标记的 SQL 语义与两条列表谓词的不变式。
    async fn fresh_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations").run(&pool).await.expect("run migrations");
        pool
    }

    /// 种一个项目 + 一条会话。kind: "acp" | "tmux"。
    async fn seed_session(pool: &sqlx::SqlitePool, id: &str, kind: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES ('p1', 'proj', '/tmp', '2026-08-23')",
        )
        .execute(pool)
        .await
        .unwrap();

        let acp_session_id = if kind == "acp" { Some("acp-uuid-1") } else { None };
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, created_at, runtime_kind, acp_session_id) \
             VALUES (?, 'p1', '/tmp', ?, NULL, 0, '2026-08-23', ?, ?)"
        )
        .bind(id)
        .bind(id)
        .bind(kind)
        .bind(acp_session_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// 复制 handler 的两条列表谓词——谓词被改动而测试未同步时此处失败提醒。
    const DEFAULT_LIST_SQL: &str = "SELECT id FROM sessions WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC";
    const ARCHIVED_LIST_SQL: &str =
        "SELECT id FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC";

    #[tokio::test]
    async fn archived_at_defaults_to_null_and_fromrow_is_compatible() {
        let pool = fresh_pool().await;
        seed_session(&pool, "s1", "acp").await;

        // legacy INSERT 未带 archived_at → NULL；Session 经 #[sqlx(default)] 可反序列化。
        let row = sqlx::query("SELECT archived_at FROM sessions WHERE id = 's1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let archived_at: Option<String> = row.get(0);
        assert!(archived_at.is_none(), "未归档会话的 archived_at 必须为 NULL");

        let session: Option<crate::models::session::Session> =
            sqlx::query_as("SELECT * FROM sessions WHERE id = 's1'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(session.is_some(), "Session FromRow 应兼容无 archived_at 值的行");
        assert_eq!(session.unwrap().archived_at, None);
    }

    #[tokio::test]
    async fn archive_moves_session_between_default_and_archived_lists() {
        let pool = fresh_pool().await;
        seed_session(&pool, "acp1", "acp").await;
        seed_session(&pool, "tmux1", "tmux").await;

        let affected = mark_archived(&pool, "acp1", Some("2026-08-23T00:00:00Z")).await.unwrap();
        assert_eq!(affected, 1);

        let default_ids: Vec<String> =
            sqlx::query_scalar(DEFAULT_LIST_SQL).bind("p1").fetch_all(&pool).await.unwrap();
        let archived_ids: Vec<String> =
            sqlx::query_scalar(ARCHIVED_LIST_SQL).fetch_all(&pool).await.unwrap();
        assert_eq!(default_ids, vec!["tmux1".to_string()], "归档会话必须从默认列表消失");
        assert_eq!(archived_ids, vec!["acp1".to_string()], "归档列表只含已归档会话");

        // 取消归档 → 回到默认列表、归档列表消失
        let affected = mark_archived(&pool, "acp1", None).await.unwrap();
        assert_eq!(affected, 1);
        let default_ids: Vec<String> =
            sqlx::query_scalar(DEFAULT_LIST_SQL).bind("p1").fetch_all(&pool).await.unwrap();
        let archived_ids: Vec<String> =
            sqlx::query_scalar(ARCHIVED_LIST_SQL).fetch_all(&pool).await.unwrap();
        assert!(
            default_ids.contains(&"acp1".to_string()) && archived_ids.is_empty(),
            "取消归档后会话应回到默认列表且归档列表清空"
        );

        // 清除后必须严格为 NULL（而非空串），保证 IS NULL 谓词恒可靠
        let row = sqlx::query("SELECT archived_at FROM sessions WHERE id = 'acp1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let archived_at: Option<String> = row.get(0);
        assert_eq!(archived_at, None);
    }

    #[tokio::test]
    async fn mark_archived_reports_zero_rows_for_missing_session() {
        let pool = fresh_pool().await;
        let affected = mark_archived(&pool, "nope", Some("2026-08-23T00:00:00Z")).await.unwrap();
        assert_eq!(affected, 0, "不存在的会话必须返回 0 行（handler 据此返 404）");
    }
}

/// agent 侧删除的判据与响应语义（`DELETE /sessions/{id}?delete_agent_side=`）。
/// 纯函数 + 枚举映射，无 HTTP / 无进程 / 无活连接。
#[cfg(test)]
mod agent_side_delete_tests {
    use super::{AgentSide, AgentSideDelete, AgentSidePlan, plan_agent_side_delete};

    fn req<'a>(requested: bool, acp_session_id: Option<&'a str>) -> AgentSideDelete<'a> {
        AgentSideDelete { requested, acp_session_id, ..Default::default() }
    }

    #[test]
    fn not_requested_when_flag_off() {
        // 未勾选：即便 agent 支持也不发（默认不删 agent 侧记录，安全默认）。
        assert_eq!(
            plan_agent_side_delete(req(false, Some("sess-1")), true),
            AgentSidePlan::NotRequested
        );
        assert_eq!(plan_agent_side_delete(req(false, None), false), AgentSidePlan::NotRequested);
    }

    #[test]
    fn sends_acp_session_id_when_supported() {
        // 删的必须是会话行里的 acp_session_id（用户以为在删的那条记录）。
        assert_eq!(
            plan_agent_side_delete(req(true, Some("sess-42")), true),
            AgentSidePlan::Send("sess-42")
        );
    }

    #[test]
    fn skips_when_agent_lacks_capability() {
        // §8：codebuddy 一类未声明能力的 agent 不盲发。
        match plan_agent_side_delete(req(true, Some("sess-42")), false) {
            AgentSidePlan::Skip(reason) => assert!(reason.contains("sessionCapabilities.delete")),
            other => panic!("应跳过，实际: {other:?}"),
        }
    }

    #[test]
    fn skips_when_session_row_has_no_acp_session_id() {
        for missing in [None, Some("")] {
            match plan_agent_side_delete(req(true, missing), true) {
                AgentSidePlan::Skip(reason) => assert!(reason.contains("acp_session_id")),
                other => panic!("应跳过（{missing:?}），实际: {other:?}"),
            }
        }
    }

    #[test]
    fn response_values_are_stable_protocol_strings() {
        // 前端按这三个字面量分流文案，改名等于改协议。
        assert_eq!(AgentSide::NotRequested.as_str(), "not_requested");
        assert_eq!(AgentSide::Deleted.as_str(), "deleted");
        assert_eq!(AgentSide::Skipped.as_str(), "skipped");
    }

    #[test]
    fn default_request_is_not_requested() {
        assert!(!AgentSideDelete::default().requested, "缺省必须是「不删 agent 侧」");
    }
}

/// 无活连接时的临时拉起兜底（fake agent 真实链路；Linux-only —— 脚本走
/// `/bin/sh`，进程探针走 `/proc`）。
///
/// 用户指令（2026-10-09）：勾选了 agent 侧删除就该由 omniterm 跑一趟，而不是
/// 给「请先恢复会话」的提示让用户自己操作。本模块钉住三条：拉起→删除→收尾的
/// 成功链路、能力缺失不盲发、上下文缺失不 spawn。
#[cfg(all(test, target_os = "linux"))]
mod ephemeral_agent_delete_tests {
    use super::*;
    use crate::acp::agent_proc::spawn_test_lock_async;
    use crate::acp::test_support::{
        agent_for, read_events, unique_dir, wait_for_event, write_fake_agent,
    };

    /// 内存库 + fake agent 配置行（`agents` 表）+ 一条已释放的 ACP 会话行
    /// （`agent_id` / `acp_session_id` / `workspace_path` 齐备，无 supervisor 注册
    /// ——正是「进程已释放后删除」的现场）。
    async fn fixture(mode: &str) -> (AppState, PathBuf, PathBuf) {
        let state = crate::test_utils::test_state().await;
        let dir = unique_dir(&format!("ephemeral-delete-{mode}"));
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let script = write_fake_agent(&dir);
        let agent = agent_for(&script, mode, &dir);
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&agent.id)
        .bind(&agent.display_name)
        .bind(&agent.command)
        .bind(serde_json::to_string(&agent.args).unwrap())
        .bind(serde_json::to_string(&agent.env).unwrap())
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("agent row");
        sqlx::query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p1', ?, ?)")
            .bind(workspace.to_string_lossy().to_string())
            .bind(&now)
            .execute(&state.db)
            .await
            .expect("project row");
        sqlx::query(
            "INSERT INTO sessions \
             (id, project_id, workspace_path, created_at, runtime_kind, acp_session_id, agent_id) \
             VALUES ('s1', 'p1', ?, ?, 'acp', 'sess-ephemeral', ?)",
        )
        .bind(workspace.to_string_lossy().to_string())
        .bind(&now)
        .bind(&agent.id)
        .execute(&state.db)
        .await
        .expect("session row");
        (state, dir, workspace)
    }

    async fn delete_with(state: &AppState, agent_id: &str, workspace_path: &str) -> AgentSide {
        cleanup_session_runtime(
            state,
            "s1",
            None, // acp 分支不用引擎键
            "acp",
            AgentSideDelete {
                requested: true,
                acp_session_id: Some("sess-ephemeral"),
                agent_id: Some(agent_id),
                workspace_path: Some(workspace_path),
            },
        )
        .await
    }

    #[tokio::test]
    async fn ephemeral_spawn_deletes_when_no_live_client() {
        let _guard = spawn_test_lock_async().await;
        let (state, dir, workspace) = fixture("delete").await;

        let outcome = delete_with(&state, "fake-agent", &workspace.to_string_lossy()).await;

        assert_eq!(outcome, AgentSide::Deleted, "临时拉起的 agent 应完成 session/delete");
        assert!(
            wait_for_event(&dir, "delete sess-ephemeral", Duration::from_secs(2)).await,
            "agent 应收到 session/delete 且 sessionId 原样，实际事件日志: {:?}",
            read_events(&dir)
        );
        // 兜底路径不注册 supervisor：删除完成即收尾，不留活连接。
        assert!(
            state.acp_supervisor.dispose("s1").await.is_none(),
            "临时拉起的 agent 不得注册 supervisor（与 E1 面板的短命进程同形态）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ephemeral_spawn_skips_when_capability_absent() {
        let _guard = spawn_test_lock_async().await;
        let (state, dir, workspace) = fixture("live").await;

        let outcome = delete_with(&state, "fake-agent", &workspace.to_string_lossy()).await;

        assert_eq!(outcome, AgentSide::Skipped, "未声明能力的 agent 必须 skipped（不谎报已删）");
        assert!(
            !read_events(&dir).contains("delete "),
            "未声明 sessionCapabilities.delete 时不得盲发 session/delete，实际: {:?}",
            read_events(&dir)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn skips_without_spawn_when_context_missing() {
        let _guard = spawn_test_lock_async().await;
        let (state, dir, workspace) = fixture("delete").await;
        let missing_dir = dir.join("does-not-exist");

        let no_agent = delete_with(&state, "no-such-agent", &workspace.to_string_lossy()).await;
        assert_eq!(no_agent, AgentSide::Skipped, "agent 配置不存在时应跳过");
        let no_workspace = delete_with(&state, "fake-agent", &missing_dir.to_string_lossy()).await;
        assert_eq!(no_workspace, AgentSide::Skipped, "工作目录不存在时应跳过");

        assert!(
            !read_events(&dir).contains("delete "),
            "上下文缺失时不得 spawn / 不得发 RPC，实际: {:?}",
            read_events(&dir)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
