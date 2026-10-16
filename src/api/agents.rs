use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
};
use serde_json::json;
use std::net::SocketAddr;
use std::time::Duration;
use uuid::Uuid;

use crate::AppState;
use crate::acp::AcpClient;
use crate::models::agent::{Agent, AgentEnvVar, CreateAgent, UpdateAgent};
use tracing;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents", get(list_agents).post(create_agent))
        .route("/agents/test-raw", post(test_agent_raw))
        .route("/agents/{id}", get(get_agent).put(update_agent).delete(delete_agent))
        .route("/agents/{id}/test", post(test_agent))
        .route("/agents/{id}/acp-sessions", get(list_agent_acp_sessions))
        .route("/agents/{id}/acp-sessions/{acp_session_id}", delete(purge_agent_acp_session))
}

/// `GET /agents/{id}/acp-sessions?cwd=<绝对路径>` 的查询参数。
#[derive(Debug, serde::Deserialize)]
struct ListAcpSessionsQuery {
    cwd: String,
}

/// agent 侧一条会话历史在 API 响应里的形态。
#[derive(Debug, serde::Serialize)]
struct AgentAcpSessionView {
    session_id: String,
    cwd: String,
    /// agent 给的标题。**可能缺省**（§8 多实现：opencode 全给、omp 部分缺省、
    /// pi-acp 给用户首条消息原文）——缺省时前端回落显示 session_id 截断，
    /// 不得显示空行或占位符。
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    /// omniterm 侧是否已有会话行绑定了这个 `acp_session_id`（「已纳管」徽标）。
    /// 只读标识，不代用户做任何建行/删行动作。
    managed: bool,
}

/// 枚举 agent 侧的会话历史（ACP `session/list`）——「Agent 历史」面板的数据源。
///
/// 与 agent 侧删除同构：**临时拉起一个短命进程**（spawn / RPC 各 15s 预算），
/// 问完即收尸。差异是走 `AcpClient::spawn_probe` 而非 `spawn_and_connect`——
/// 只读枚举不该在 agent 自己的历史里留一条空会话（否则面板往它正在展示的列表
/// 里掺数据，用户会看到自己刚造出来的那一行）。
///
/// **顺带回填标题**：把命中的 `acp_session_id` 的 `agent_title` 写进 omniterm
/// 自己的会话行（`acp::title::backfill_from_list`）。这是 agent 侧标题的第二条
/// 来源（第一条是 live `session_info_update` 通知，只有部分 agent 会推）。回填
/// 只写 `agent_title`，`name`（用户手写名）不在写入集里。
///
/// **不轮询**：每次调用都起一个进程，面板只在展开时与手动刷新时拉。返回
/// `truncated` 让前端明示「看到的是截断后的列表」。
///
/// 失败语义：agent 配置不存在 404 / cwd 非目录 400（请求错误）；拉起超时 /
/// RPC 失败（含 agent 根本不支持 `session/list`，如实测 codebuddy 回
/// `-32601`）→ 502 + agent 原文错误。**不做能力 gate**：能力位在实测实现里
/// 覆盖不一（omp 声明 `list` 却对部分会话不给 title），gate 会把「不支持」与
/// 「声明了但失败」混成一谈；前端据此显示明确错误而不是空白列表。
async fn list_agent_acp_sessions(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListAcpSessionsQuery>,
) -> impl IntoResponse {
    let Some(agent) = load_agent(&state.db, &id).await else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "agent not found" })));
    };
    let cwd = std::path::PathBuf::from(&query.cwd);
    if !cwd.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("cwd is not an existing directory: {}", query.cwd) })),
        );
    }
    let agent_id = agent.id.clone();

    let client = match tokio::time::timeout(
        crate::api::sessions::EPHEMERAL_AGENT_TIMEOUT,
        AcpClient::spawn_probe(agent, cwd, &state.api_keys),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => {
            tracing::warn!(agent_id, "list_agent_acp_sessions: 临时拉起 agent 失败：{e}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("failed to spawn agent: {}", e) })),
            );
        }
        Err(_) => {
            // 超时即握手未完成：外层 future 被 drop → crate teardown（ChildGuard
            // killpg）回收进程组，与 agents.rs 连接测试同一兜底路径。
            tracing::warn!(
                agent_id,
                "list_agent_acp_sessions: 临时拉起 agent 超时（{}s）",
                crate::api::sessions::EPHEMERAL_AGENT_TIMEOUT.as_secs()
            );
            return (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": "connection timed out" })));
        }
    };

    let listed = match tokio::time::timeout(
        crate::api::sessions::EPHEMERAL_AGENT_TIMEOUT,
        client.list_sessions(Some(&query.cwd)),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            client.disconnect().await;
            // agent 原文透出：codebuddy 的 "Method not found: session/list" 正是
            // 用户需要看到的那句（不支持 vs 失败，错误文案自己说清了）。
            tracing::warn!(agent_id, "list_agent_acp_sessions: session/list 失败：{e}");
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("{}", e) })));
        }
        Err(_) => {
            client.disconnect().await;
            tracing::warn!(
                agent_id,
                "list_agent_acp_sessions: session/list 超时（{}s）",
                crate::api::sessions::EPHEMERAL_AGENT_TIMEOUT.as_secs()
            );
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "error": "session/list timed out" })),
            );
        }
    };
    // 无论成功失败都必须收尸：短命进程不注册 supervisor，没有 reaper 兜底。
    client.disconnect().await;

    let (sessions, truncated) = listed;
    // 「已纳管」徽标与标题回填共用一次全量读（同一函数两个输出）。
    let sync = crate::acp::title::backfill_from_list(&state.db, &sessions).await;
    if sync.written > 0 {
        tracing::debug!(
            agent_id,
            written = sync.written,
            "list_agent_acp_sessions: 回填 agent 侧标题"
        );
    }

    let views: Vec<AgentAcpSessionView> = sessions
        .into_iter()
        .map(|s| {
            let session_id = s.session_id.0.to_string();
            let managed = sync.managed.contains(&session_id);
            AgentAcpSessionView {
                session_id,
                cwd: s.cwd.to_string_lossy().into_owned(),
                title: s.title,
                updated_at: s.updated_at,
                managed,
            }
        })
        .collect();

    (StatusCode::OK, Json(json!({ "sessions": views, "truncated": truncated })))
}

/// `DELETE /agents/{id}/acp-sessions/{acp_session_id}` 的查询参数：会话的
/// `workspace_path`（agent 侧按 cwd 组织会话历史，必须与原会话一致）。
#[derive(Debug, serde::Deserialize)]
struct PurgeAcpSessionQuery {
    cwd: String,
}

/// 请求 agent 删除**它自己那份**会话记录（ACP `session/delete`）：临时拉起一个
/// 短命 agent 进程（不注册 supervisor，spawn / RPC 各 15s 预算），现场 gate
/// 能力位后补发，随后立即收尾。
///
/// 「删除会话」两段式的第二段：`DELETE /sessions/{id}?delete_agent_side=true` 在
/// 进程不驻留时立即返回 `agent_side:"pending"`，由客户端带着会话行的
/// `agent_id` / `acp_session_id` / `workspace_path` 补发本请求——用户先拿到
/// 「已删除」，agent 侧结果稍后如实补报；无服务端状态（不做 job 表 / 轮询）。
///
/// best-effort 语义与删会话路径一致：能力未声明 / 拉起失败 / RPC 失败都回
/// `agent_side:"skipped"` + 200（不报错码），由前端如实告知「未能删除」；
/// agent 配置不存在 / cwd 不是目录属请求错误，回 404 / 400。
async fn purge_agent_acp_session(
    State(state): State<AppState>,
    Path((id, acp_session_id)): Path<(String, String)>,
    Query(query): Query<PurgeAcpSessionQuery>,
) -> impl IntoResponse {
    let Some(agent) = load_agent(&state.db, &id).await else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "agent not found" })));
    };
    let cwd = std::path::PathBuf::from(&query.cwd);
    if !cwd.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("cwd is not an existing directory: {}", query.cwd) })),
        );
    }

    let agent_side = crate::api::sessions::delete_agent_side_record_via_ephemeral_spawn(
        &state,
        agent,
        cwd,
        &acp_session_id,
    )
    .await;
    (StatusCode::OK, Json(json!({ "ok": true, "agent_side": agent_side.as_str() })))
}

#[derive(sqlx::FromRow)]
struct AgentRow {
    id: String,
    display_name: String,
    command: String,
    args: String,
    env: String,
    npm_package: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AgentRow {
    fn into_agent(self) -> Agent {
        let args: Vec<String> = serde_json::from_str(&self.args).unwrap_or_default();
        let env: Vec<AgentEnvVar> = serde_json::from_str(&self.env).unwrap_or_default();
        Agent {
            id: self.id,
            display_name: self.display_name,
            command: self.command,
            args,
            env,
            npm_package: self.npm_package,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    let rows: Vec<AgentRow> = sqlx::query_as("SELECT * FROM agents ORDER BY created_at DESC")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

    let agents: Vec<Agent> = rows.into_iter().map(AgentRow::into_agent).collect();
    Json(json!(agents))
}

async fn get_agent(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let row: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    match row {
        Some(r) => (StatusCode::OK, Json(json!(r.into_agent()))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
    }
}

async fn create_agent(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<CreateAgent>,
) -> impl IntoResponse {
    let id = req.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let args_json = serde_json::to_string(&req.args).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&req.env).unwrap_or_else(|_| "[]".into());

    let result = sqlx::query(
        "INSERT INTO agents (id, display_name, command, args, env, npm_package, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.display_name)
    .bind(&req.command)
    .bind(&args_json)
    .bind(&env_json)
    .bind(&req.npm_package)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await;

    if let Err(e) = result {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() })));
    }

    // 审计（S5）：agent 配置决定后续每条会话会 spawn 什么进程、注入什么
    // 环境变量（可能含密钥名），改动它是「未来所有会话的行为」变更，必留痕。
    // detail 记命令与 env 的**键名**（不含值——§S3 敏感数据不落库）。
    // 注意边界：command 是自由文本、原样落库，`--token=sk-…` 这类形态会把
    // 凭据写进 detail。单人工具自选自输，不做通用 flag 掩码（过度设计）；
    // 若将来 agent 配置可共享/导入，必须补。
    let ctx = crate::api::audit::AuditContext::from_ip(Some(addr.ip()), Some("agents".into()));
    let detail = json!({
        "command": req.command.clone(),
        "env_keys": req.env.iter().map(|e| e.key.clone()).collect::<Vec<_>>(),
    })
    .to_string();
    crate::api::audit::record(
        &state.db,
        &ctx,
        crate::api::audit::AuditAction::AgentCreate,
        &id,
        Some(&detail),
    )
    .await;

    let agent = Agent {
        id,
        display_name: req.display_name,
        command: req.command,
        args: req.args,
        env: req.env,
        npm_package: req.npm_package,
        created_at: now.clone(),
        updated_at: now,
    };

    (StatusCode::CREATED, Json(json!(agent)))
}

async fn update_agent(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAgent>,
) -> impl IntoResponse {
    let existing: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    let Some(existing) = existing else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    };
    let mut current = existing.into_agent();

    // 被这次请求实际改动的字段名（None 的字段不动）——审计要答的是
    // 「改了什么」，不是「最终值是什么」，后者可从当前 agents 行反推。
    let mut changed: Vec<&str> = Vec::new();

    if let Some(v) = req.display_name {
        current.display_name = v;
        changed.push("display_name");
    }
    if let Some(v) = req.command {
        current.command = v;
        changed.push("command");
    }
    if let Some(v) = req.args {
        current.args = v;
        changed.push("args");
    }
    if let Some(v) = req.env {
        current.env = v;
        changed.push("env");
    }
    if let Some(v) = req.npm_package {
        current.npm_package = v;
        changed.push("npm_package");
    }
    current.updated_at = chrono::Utc::now().to_rfc3339();

    let args_json = serde_json::to_string(&current.args).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&current.env).unwrap_or_else(|_| "[]".into());

    sqlx::query(
        "UPDATE agents SET display_name = ?, command = ?, args = ?, env = ?, npm_package = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&current.display_name)
    .bind(&current.command)
    .bind(&args_json)
    .bind(&env_json)
    .bind(&current.npm_package)
    .bind(&current.updated_at)
    .bind(&id)
    .execute(&state.db)
    .await
    .unwrap();

    // 审计（S5）：同上，agent 配置变更是「未来所有会话的行为」变更。
    // detail 只记字段名与 env 键名，不记值（§S3）。
    let ctx = crate::api::audit::AuditContext::from_ip(Some(addr.ip()), Some("agents".into()));
    let detail = json!({
        "changed": changed,
        "env_keys": current.env.iter().map(|e| e.key.clone()).collect::<Vec<_>>(),
    })
    .to_string();
    crate::api::audit::record(
        &state.db,
        &ctx,
        crate::api::audit::AuditAction::AgentUpdate,
        &id,
        Some(&detail),
    )
    .await;

    (StatusCode::OK, Json(json!(current)))
}

async fn delete_agent(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Check if any sessions reference this agent
    let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE agent_id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    if session_count > 0 {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": format!("Cannot delete agent: {} session(s) still reference it", session_count) }),
            ),
        );
    }

    let result =
        sqlx::query("DELETE FROM agents WHERE id = ?").bind(&id).execute(&state.db).await.unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    // 清理该 agent 的全局配置偏好行（foreign_keys 级联本会覆盖，这里显式清理兜底）。
    let _ = crate::acp::config_prefs::clear_agent_prefs(&state.db, &id).await;

    // 审计（S5）：删除 agent 配置会让所有引用它的会话失去 spawn 依据。
    // 上面 session_count>0 的 409 守卫挡住了在用时删除，故能走到这里的
    // 都是「已无会话引用」的删除——这条边界本身也值得留痕。
    let ctx = crate::api::audit::AuditContext::from_ip(Some(addr.ip()), Some("agents".into()));
    crate::api::audit::record(
        &state.db,
        &ctx,
        crate::api::audit::AuditAction::AgentDelete,
        &id,
        None,
    )
    .await;

    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// Load an agent for internal use (e.g. spawning).
pub async fn load_agent(db: &sqlx::SqlitePool, id: &str) -> Option<Agent> {
    let row: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    row.map(AgentRow::into_agent)
}

async fn test_agent(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let agent = match load_agent(&state.db, &id).await {
        Some(a) => a,
        None => {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "agent not found" })));
        }
    };

    let cwd = std::env::temp_dir();
    match tokio::time::timeout(
        Duration::from_secs(15),
        AcpClient::spawn_and_connect(agent, cwd, &state.api_keys),
    )
    .await
    {
        Ok(Ok(client)) => {
            client.disconnect().await;
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Ok(Err(e)) => {
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("connection failed: {}", e) })))
        }
        Err(_) => {
            // 超时即握手未完成：外层 spawn future 被 drop → abort_tx 释放 →
            // crash watcher abort 连接任务 → crate 的 ChildGuard::drop killpg
            // 进程组（Phase 1 D4 兜底，P2-3；此时无 AcpClient 句柄，omniterm
            // 侧 killpg 够不着，由 crate teardown 收尾）。pid 自报文件由任务内
            // 的 PidFileCleanup 守卫清理。此处 WARN 留痕便于关联现场。
            tracing::warn!(
                agent_id = %id,
                "agent 连接测试超时（15s）：agent 未完成 ACP 握手，已回收其进程组（crate teardown）"
            );
            (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": "connection timed out (15s)" })))
        }
    }
}

/// Test an agent configuration without saving it to the database.
/// Accepts a `CreateAgent` body and attempts to spawn + connect.
async fn test_agent_raw(Json(req): Json<CreateAgent>) -> impl IntoResponse {
    let agent = Agent {
        id: "test-raw".to_string(),
        display_name: req.display_name,
        command: req.command,
        args: req.args,
        env: req.env,
        npm_package: req.npm_package,
        created_at: String::new(),
        updated_at: String::new(),
    };

    let cwd = std::env::temp_dir();
    // 超时 WARN 留痕用：agent 随后被 move 进 spawn_and_connect。
    let agent_label = agent.command.clone();
    match tokio::time::timeout(
        Duration::from_secs(15),
        AcpClient::spawn_and_connect(agent, cwd, &std::collections::HashMap::new()),
    )
    .await
    {
        Ok(Ok(client)) => {
            client.disconnect().await;
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Ok(Err(e)) => {
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("connection failed: {}", e) })))
        }
        Err(_) => {
            // 同 test_agent：握手超时 → abort_tx 释放 → watcher abort → crate
            // ChildGuard::drop killpg 进程组（P2-3）。留痕。
            tracing::warn!(
                agent_command = %agent_label,
                "agent 连接测试（raw）超时（15s）：agent 未完成 ACP 握手，已回收其进程组（crate teardown）"
            );
            (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": "connection timed out (15s)" })))
        }
    }
}

/// `GET /agents/{id}/acp-sessions` 的前置校验（成功路径由
/// `api::agents::list_agent_acp_sessions_tests` 的 fake agent 链路覆盖）。
#[cfg(test)]
mod purge_acp_session_tests {
    use super::*;

    fn cwd_query(path: &str) -> Query<PurgeAcpSessionQuery> {
        Query(PurgeAcpSessionQuery { cwd: path.to_string() })
    }

    async fn insert_agent(state: &AppState, id: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES (?, 'Test', '/bin/true', '[]', '[]', ?, ?)",
        )
        .bind(id)
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("agent row");
    }

    #[tokio::test]
    async fn missing_agent_is_404() {
        let state = crate::test_utils::test_state().await;
        let resp = purge_agent_acp_session(
            State(state),
            Path(("no-such-agent".to_string(), "sess-1".to_string())),
            cwd_query(&std::env::temp_dir().to_string_lossy()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cwd_that_is_not_a_directory_is_400() {
        let state = crate::test_utils::test_state().await;
        insert_agent(&state, "a1").await;
        let missing = std::env::temp_dir().join("omniterm-purge-nonexistent-cwd");
        let resp = purge_agent_acp_session(
            State(state),
            Path(("a1".to_string(), "sess-1".to_string())),
            cwd_query(&missing.to_string_lossy()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}

/// `GET /agents/{id}/acp-sessions` 的前置校验 + 标题回填逻辑（成功路径的 fake
/// agent 链路在 `api::sessions::ephemeral_agent_delete_tests` 的同类模式下覆盖）。
#[cfg(test)]
mod list_agent_acp_sessions_tests {
    use super::*;

    fn list_query(path: &str) -> Query<ListAcpSessionsQuery> {
        Query(ListAcpSessionsQuery { cwd: path.to_string() })
    }

    async fn insert_agent(state: &AppState, id: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES (?, 'Test', '/bin/true', '[]', '[]', ?, ?)",
        )
        .bind(id)
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("agent row");
    }

    #[tokio::test]
    async fn missing_agent_is_404() {
        let state = crate::test_utils::test_state().await;
        let resp = list_agent_acp_sessions(
            State(state),
            Path("no-such-agent".to_string()),
            list_query(&std::env::temp_dir().to_string_lossy()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cwd_that_is_not_a_directory_is_400() {
        let state = crate::test_utils::test_state().await;
        insert_agent(&state, "a1").await;
        let missing = std::env::temp_dir().join("omniterm-list-nonexistent-cwd");
        let resp = list_agent_acp_sessions(
            State(state),
            Path("a1".to_string()),
            list_query(&missing.to_string_lossy()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// 全链路：临时拉起 fake agent → `session/list`（两页）→ 标题回填 → 收尸。
    /// 这是「发现 agent 侧历史」面板的真实路径，钉住三件事：分页被拼齐、
    /// `session/new` 未被发出（探针模式不在 agent 历史里留痕）、进程被收走。
    #[tokio::test]
    async fn lists_agent_history_and_backfills_titles_end_to_end() {
        use crate::acp::agent_proc::spawn_test_lock_async;
        use crate::acp::test_support::{agent_for, read_events, unique_dir, write_fake_agent};
        use crate::models::agent::Agent;

        let _guard = spawn_test_lock_async().await;
        let state = crate::test_utils::test_state().await;
        let dir = unique_dir("list-ephemeral");
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let script = write_fake_agent(&dir);
        // agent_for 的 id 是 "fake-agent"——直接把它写进 agents 表，handler 的
        // load_agent 才拿得到（fixture 用真实行而非 mock，覆盖读库路径）。
        let agent: Agent = agent_for(&script, "list", &dir);
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
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, path, created_at) \
             VALUES ('p1', 'p1', '/tmp', ?)",
        )
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("project row");
        // 纳管 sess-2：列表里它没有 title，回填必须跳过（缺省 ≠ 清除）。
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, created_at, runtime_kind, \
             acp_session_id, agent_title) VALUES ('s-mng', 'p1', '/tmp', ?, 'acp', 'sess-2', 'live 通知写的标题')",
        )
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("session row");

        let resp = list_agent_acp_sessions(
            State(state.clone()),
            Path(agent.id.clone()),
            list_query(&workspace.to_string_lossy()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        let listed = payload["sessions"].as_array().expect("sessions array");
        assert_eq!(listed.len(), 3, "两页应被拼齐: {payload}");
        assert_eq!(listed[0]["title"], "fake session title");
        assert!(listed[0]["updated_at"].is_string(), "updatedAt 应透出: {payload}");
        assert_eq!(listed[0]["managed"], false, "sess-1 未纳管");
        assert_eq!(listed[1]["managed"], true, "sess-2 已纳管");
        assert_eq!(listed[2]["managed"], false, "sess-3 未纳管");
        assert_eq!(payload["truncated"], false);

        // live 通知写的标题不得被「列表里没有 title」擦掉（缺省 ≠ 清除）。
        let kept: Option<String> =
            sqlx::query_scalar("SELECT agent_title FROM sessions WHERE id = 's-mng'")
                .fetch_one(&state.db)
                .await
                .expect("session row");
        assert_eq!(kept.as_deref(), Some("live 通知写的标题"));

        let events = read_events(&dir);
        assert!(!events.contains("new-session"), "探针模式不得发 session/new: {events:?}");
        // 短命进程必须被收走：不注册 supervisor，没有 reaper 兜底。
        assert!(
            state.acp_supervisor.snapshot().await.is_empty(),
            "临时拉起的 agent 不得留在 supervisor"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// `acp::title::backfill_from_list` 的库侧契约：按 `acp_session_id` 匹配回填、
/// 未纳管不建行、只写 `agent_title` 不动 `name`。
#[cfg(test)]
mod agent_title_backfill_tests {
    use agent_client_protocol::schema::v1::SessionInfo;

    use super::*;

    fn info(session_id: &str, title: Option<&str>) -> SessionInfo {
        // SessionInfo::new 收 impl Into<Arc<str>>，借用的 &str 活不过函数体——
        // 必须转 owning（SessionId 内部是 Arc<str>）。
        let mut i = SessionInfo::new(session_id.to_string(), "/tmp");
        if let Some(t) = title {
            i = i.title(t);
        }
        i
    }

    async fn seed(state: &AppState, id: &str, acp_session_id: &str, name: Option<&str>) {
        let now = chrono::Utc::now().to_rfc3339();
        // test_state() 只建 schema 不建前置行，sessions → projects 的 FK 要自己满足。
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, path, created_at) \
             VALUES ('p1', 'p1', '/tmp', ?)",
        )
        .bind(&now)
        .execute(&state.db)
        .await
        .expect("project row");
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, created_at, runtime_kind, \
             acp_session_id, name) VALUES (?, 'p1', '/tmp', ?, 'acp', ?, ?)",
        )
        .bind(id)
        .bind(&now)
        .bind(acp_session_id)
        .bind(name)
        .execute(&state.db)
        .await
        .expect("session row");
    }

    #[tokio::test]
    async fn matched_rows_get_their_title_backfilled() {
        let state = crate::test_utils::test_state().await;
        seed(&state, "s1", "sess-1", None).await;
        seed(&state, "s2", "sess-2", None).await;

        let sync =
            crate::acp::title::backfill_from_list(&state.db, &[info("sess-1", Some("标题一"))])
                .await;
        assert_eq!(sync.written, 1);
        assert!(sync.managed.contains("sess-1"));
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT agent_title FROM sessions WHERE id = 's1'"
            )
            .fetch_one(&state.db)
            .await
            .unwrap()
            .as_deref(),
            Some("标题一")
        );
        // 未出现在列表里的会话行不受影响。
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT agent_title FROM sessions WHERE id = 's2'"
            )
            .fetch_one(&state.db)
            .await
            .unwrap(),
            None
        );
    }

    /// 未纳管的 agent 侧会话：只报告「未纳管」，**绝不代为建行**——「发现」与
    /// 「纳管」是两个用户动作，一次列表拉取不该产生不可预期的库变更。
    #[tokio::test]
    async fn unmanaged_agent_sessions_never_create_rows() {
        let state = crate::test_utils::test_state().await;
        let sync =
            crate::acp::title::backfill_from_list(&state.db, &[info("sess-ghost", Some("野标题"))])
                .await;
        assert_eq!(sync.written, 0);
        assert!(!sync.managed.contains("sess-ghost"));
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(&state.db).await.unwrap();
        assert_eq!(count, 0, "不得按列表创建会话行");
    }

    /// title 缺省（§8：可选字段）不得把已有标题清掉——缺省是「这次没说」，
    /// 不是「清除」。
    #[tokio::test]
    async fn missing_title_keeps_the_previous_snapshot() {
        let state = crate::test_utils::test_state().await;
        seed(&state, "s1", "sess-1", None).await;
        crate::acp::title::persist_title(&state.db, "s1", Some("旧标题")).await;

        let sync = crate::acp::title::backfill_from_list(&state.db, &[info("sess-1", None)]).await;
        assert_eq!(sync.written, 0, "title 缺省不是清除语义");
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT agent_title FROM sessions WHERE id = 's1'"
            )
            .fetch_one(&state.db)
            .await
            .unwrap()
            .as_deref(),
            Some("旧标题")
        );
    }

    /// 同值不写（写放大防线）：第二次拉同一列表应是 0 次写入。
    #[tokio::test]
    async fn identical_title_is_not_rewritten() {
        let state = crate::test_utils::test_state().await;
        seed(&state, "s1", "sess-1", None).await;
        let list = [info("sess-1", Some("同一个标题"))];
        assert_eq!(crate::acp::title::backfill_from_list(&state.db, &list).await.written, 1);
        assert_eq!(
            crate::acp::title::backfill_from_list(&state.db, &list).await.written,
            0,
            "第二次拉同一列表不得产生写入"
        );
    }

    /// 用户手写名的会话照样回填 `agent_title`（数据保持新鲜），但 `name` 分毫
    /// 不动——展示层 `name ?? agent_title ?? 默认名` 才是「不覆盖」的执行点。
    #[tokio::test]
    async fn backfill_never_touches_a_user_supplied_name() {
        let state = crate::test_utils::test_state().await;
        seed(&state, "s1", "sess-1", Some("用户手写的名字")).await;
        crate::acp::title::backfill_from_list(&state.db, &[info("sess-1", Some("agent 标题"))])
            .await;
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>("SELECT name FROM sessions WHERE id = 's1'")
                .fetch_one(&state.db)
                .await
                .unwrap()
                .as_deref(),
            Some("用户手写的名字")
        );
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT agent_title FROM sessions WHERE id = 's1'"
            )
            .fetch_one(&state.db)
            .await
            .unwrap()
            .as_deref(),
            Some("agent 标题")
        );
    }
}
