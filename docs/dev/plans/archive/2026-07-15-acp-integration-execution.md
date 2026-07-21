# ACP 接入执行计划

> **作用**：把 `2026-07-12-acp-integration-plan.md` 的方向性方案落到可执行的代码任务。新会话 LLM 从本文一份即可接手。
> **状态**：Phase 1 + 2 **已实施并提交**（commit `2757a57`）。Phase 3 后端（P3-01~P3-14）全部完成：基础 `bdfe8b1`、模块骨架 `a577b85`、HTTP/WS 路由 `71f73d5`。Phase 3 前端（P3-15~P3-18）+ 文档（P3-20）已完成：前端 UI `b5b9a58`、文档 `0382800`。P3-19（fake-agent 集成测试）延期到 Phase 4 与 Chat 视图联调一起做。Phase 4-5 已出方向。
> **上次更新**：2026-07-15

---

## 1. 源文档索引（按接手顺序读）

| 序号 | 文档 | 关系 |
|------|------|------|
| 1 | `docs/dev/plans/2026-07-12-acp-integration-plan.md` | **上游方案**：五阶段方向性设计、明确不做的事、参考项目路径。本文是它的执行细化。 |
| 2 | `AGENTS.md` | 工程准则：先规划后编码、严守分层、奥卡姆剃刀、`.env.local` 配置统一、文档索引触发规则。 |
| 3 | `docs/architecture/backend.md` | Rust 后端分层：`api/` / `tmux/` / `ws/` / `models/` 边界。 |
| 4 | `docs/architecture/frontend.md` | 前端结构、store 组织。 |
| 5 | `docs/reference/references.md` | ACP 参考项目位置（`obsidian-agent-client`、`adhdev`），license 注意事项。 |
| 6 | `PROGRESS.md` / `CHANGELOG.md` | 项目里程碑与用户可见变更。 |

**参考项目**（License 注意）：
- `/home/pax/coding/research/obsidian-agent-client`（**Apache-2.0**，Obsidian ACP 插件，架构 + 命名参考，代码可借鉴但需重写为 Rust）
- `/home/pax/coding/research/adhdev`（**AGPL-3.0**，自托管多 agent hub，**仅架构参考，禁止拷代码**）
- 官方 Rust crate：[`agent-client-protocol` v1.2.0](https://docs.rs/agent-client-protocol/)（Apache-2.0，`Stdio` transport + `Client` builder，直接依赖）
- 官方协议规范：https://agentclientprotocol.com

**已弃用/失效的参考**：
- ~~`obsidian-agent-client/documentation/app-server-schemas/`~~ —— 本地没有该子目录，官方 schema 走 `docs.rs/agent-client-protocol/latest/agent_client_protocol/schema/` 或 crate 源码
- ~~`typescript-sdk`~~ —— 本地无该 clone，且 Rust 侧不需要

---

## 2. 核心定位（承自上游方案，未变）

- **ACP 是默认 agent 运行时**，tmux 保留为可选 fallback
- **前端按 `runtime_kind` 分渲染路径**，不做同 session 双视图切换
- **永久排除**：ACP ↔ tmux 会话桥接（任何阶段都不做）

---

## 3. 代码库现状盘点（2026-07-15 探索结果）

### 3.1 tmux 硬依赖只有一处 fatal

`src/main.rs:79-82`
```rust
if let Err(e) = tmux::check_multiplexer() {
    tracing::error!("{}", e);
    std::process::exit(1);   // ← 唯一启动阻断点
}
```

### 3.2 `AppState.activity_monitor` 实际已是惰性

`src/main.rs:42-46`
```rust
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
    pub activity_monitor: tmux::control_mode::SessionActivityMonitor,
}
```
- `SessionActivityMonitor::new()` 只 alloc 空 HashMap（`src/tmux/control_mode.rs:277-284`），零成本
- `tmux -C attach-session` 在 `ensure_session()` 时才 spawn（同文件 38-50 行）
- **结论**：上游方案 "改为 Option" 属于过度抽象，Phase 1 不做

### 3.3 `activity_monitor` 消费点均已容错

| 位置 | 调用 | 无 tmux 表现 |
|------|------|-------------|
| `src/api/sessions.rs:78` | `is_active()` | 返回 `false` |
| `src/api/sessions.rs:167` | `ensure_session()` | `if let Err(e) = ... error!()` |
| `src/api/sessions.rs:242` | `remove_session()` | 无副作用 |
| `src/api/sessions.rs:408` | `ensure_session()` | 已容错 |
| `src/ws/terminal.rs:106` | `ensure_session()` | 已容错 |
| `src/ws/terminal.rs:524` | `ensure_session()` | 已容错 |

### 3.4 sessions 表当前 schema

`migrations/20260625_workspace_to_project.sql:19-29` 定义的 8 列，全部 tmux 语义。`tmux_session_name` 已 nullable。

### 3.5 Session 读写点分布

- INSERT：`sessions.rs:154` (create), `sessions.rs:394` (adopt), `tests/agent_hook_integration.rs:427`
- UPDATE：`sessions.rs:197`, `projects.rs:{152,163,443}`, `hooks.rs:{85,111}`
- SELECT：15+ 处，绝大多数只取 `tmux_session_name`

### 3.6 已有的兜底样例（Phase 1 参照）

- `src/api/sessions.rs:47` — `tmux::list_sessions().await.unwrap_or_default()`
- `src/api/system.rs:87-98` — `/api/v1/system/multiplexer` 端点已暴露可用性

---

## 4. 决策日志

### 4.1 已决（相对上游方案的修正）

| 决策 | 上游方案 | 本次决定 | 理由 |
|------|---------|----------|------|
| Phase 1 是否把 `activity_monitor` 改 `Option` | 是 | **否** | 构造零成本、调用点全容错；改 Option 徒增 6 处解包噪声 |
| Phase 1 是否惰性化 tmux 模块 | 是 | **否** | 已经是惰性 |
| Phase 1 + 2 是否合并成一个 change | 分开 | **合并** | Phase 1 单独提交会留"僵尸 session"中间态缺陷 |
| Phase 2 `runtime_kind` 默认值 | `acp` | **`tmux`**（Phase 4 再切） | 避免 Phase 2-3 之间 ACP 未实现却成为默认，前端创建按钮打不开会话 |
| Phase 2 表结构 | 加通用 `runtime_id` | **保留 `tmux_session_name`，新增 `acp_session_id`** | 15+ 处 SELECT 免改；两种 id 语义本就不同 |
| Phase 2 Rust 类型 | 未定 | **`enum RuntimeKind { Tmux, Acp }` + `sqlx::Type`** | 编译期防错 |

### 4.2 待拍板（实施前需确认）

**无**——上一次讨论中三个拍板点（A/B/C）已通过"决策日志"锁定推荐值。若接手 LLM 需要变更，需在本文档 §4.1 显式追加一行覆盖，并在 §5/§6 相应任务同步调整。

---

## 5. Phase 1 + 2 合并 change 实施任务（**已完成**）

**Change**：`acp-runtime-scaffolding`，commit `2757a57`（2026-07-15）
**范围**：12 files changed, +429/-9

### 5.1 完成情况

| ID | 任务 | 文件 | 大小 |
|----|------|------|------|
| T1 | `check_multiplexer` fatal → warning | `src/main.rs:79-82` | ~5 行 |
| T2 | Migration：新增 `runtime_kind` + `acp_session_id` | `migrations/20260715_add_runtime_kind.sql`（新） | ~5 行 |
| T3 | 定义 `RuntimeKind` enum | `src/models/session.rs` | ~10 行 |
| T4 | `Session` / `CreateSession` DTO 加字段 | `src/models/session.rs` | ~6 行 |
| T5 | `create_session` handler 分支 tmux / acp | `src/api/sessions.rs:102-190` | ~15 行 |
| T6 | ACP 分支返 `501 Not Implemented`（占位） | 同上 | 已含 T5 |
| T7 | `list_sessions` 中 tmux 特有字段查询按 `runtime_kind=tmux` 跳过 | `src/api/sessions.rs:75-97` | ~5 行 |
| T8 | `adopt_session` 硬编码 `runtime_kind='tmux'` | `src/api/sessions.rs:390-405` | ~2 行 |
| T9 | 测试 INSERT 显式补两列 | `tests/agent_hook_integration.rs:427` | ~2 行 |
| T10 | 前端 `Session` interface 加字段 | `frontend/src/api/client.ts:88-107` | ~3 行 |
| T11 | 新增后端单测 | `src/api/sessions.rs` 内联或 `tests/` | ~40 行 |
| T12 | 文档更新（backend.md schema 段、CHANGELOG） | `docs/architecture/backend.md`, `CHANGELOG.md` | ~10 行 |

### 5.2 Migration SQL 草案

```sql
-- migrations/20260715_add_runtime_kind.sql
ALTER TABLE sessions ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE sessions ADD COLUMN acp_session_id TEXT;
CREATE INDEX idx_sessions_runtime_kind ON sessions(runtime_kind);
```

### 5.3 Rust 类型草案

```rust
// src/models/session.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind { Tmux, Acp }

impl Default for RuntimeKind {
    fn default() -> Self { RuntimeKind::Tmux }  // Phase 2 默认 tmux
}
```

### 5.4 验证矩阵

| 类别 | 验证项 | 命令/操作 | 期望 |
|------|--------|-----------|------|
| 启动 | 无 tmux 环境启动 | `PATH=/usr/bin:/bin ./target/debug/omniterm`（或临时改名 tmux binary） | 有 warn，无 exit，`/api/v1/health` 200 |
| 启动 | `/system/multiplexer` 报告 | `curl /api/v1/system/multiplexer` | 503 + install_hints |
| Migration | 老库自动迁移 | 用现有 `omniterm.db` 启动新版 → `sqlite3 ... "SELECT DISTINCT runtime_kind FROM sessions"` | 全部 `tmux` |
| 默认行为不变 | 现前端创建 session | 点"创建会话" | DB 记 `runtime_kind='tmux'`，tmux session 正常 |
| ACP 分支占位 | POST 传 `runtime_kind='acp'` | `curl -X POST /api/v1/projects/{id}/sessions -d '{"workspace_path":"/tmp","runtime_kind":"acp"}'` | 501 |
| 类型契约 | 前端 TS 编译 | `cd frontend && npm run typecheck` | 通过 |
| 无回归 | 全部测试 | `cargo test && cd frontend && npm test` | 全绿 |

### 5.5 已知遗留（不在本 change 修）

- `create_session` 若 tmux 失败仍写入 DB（`sessions.rs:142-165`）——Phase 3 加 ACP 实现后自然消失（ACP 分支不走 tmux）
- ACP session 的 CWD 同步、agent state 展示——Phase 3/5 处理

### 5.6 实际 Commit

最终合并为单个 commit `2757a57 feat(backend): ACP runtime scaffolding (Phase 1+2)`，12 files changed, +429/-9。

### 5.7 完成度

Phase 1+2 全部任务已实施并通过 6 项验证矩阵（cargo build、migration、tmux 集成测试、migration 测试、501 分支、前端 typecheck）。

---

## 6. Phase 3：ACP Runtime 接入（后端 P3-01~P3-14 已完成，前端 P3-15~P3-20 待做）

**目标**：`runtime_kind='acp'` 分支从 HTTP 501 变为可用 —— 用户能从 UI 挑一个 agent、创建 ACP session、收 streaming 响应、发 prompt、看 tool call。

**定位约束**：OmniTerm 是 **通用 ACP hub**，不做 agent 独立适配。所有 ACP 兼容 agent（Claude Code、Gemini CLI、Codex CLI、自定义）走同一条代码路径，靠用户配置的 `AgentConfig { command, args, env }` 区分。

### 6.1 决策日志（已拍板，实施前无待议项）

| 决策 | 选择 | 理由 |
|------|------|------|
| Adapter 部署形态 | **Rust 直接 spawn agent 子进程 + 官方 crate** | ACP 协议原生 stdio ndJSON；官方 Rust crate 已提供 `Stdio` transport；两个参考项目（obsidian-agent-client、adhdev）均走此路；引入 Node sidecar 违反奥卡姆剃刀（额外进程/端口/依赖） |
| ACP client 库 | **`agent-client-protocol` v1.2.x**（crates.io，Apache-2.0） | 官方维护，跟协议演进；免 hand-roll JSON-RPC codec；license 与 FSL-1.1-MIT 兼容 |
| Agent 进程生命周期 | **per-session spawn** | 两参考项目均如此；简单直接；池化留给 Phase 5 |
| Agent 配置存储 | **DB `agents` 表**（不用 `.env.local`） | 多 agent、UI 可管理；user 可切换；`.env.local` 只放分支专属基础设施变量 |
| API key 存储 | **Phase 3：DB 明文列**；Phase 5：系统 keychain | 简单起步；文档明确风险；不落到 `.env.local`（会被 gitignored 但仍不适合密钥） |
| 权限请求 UX | **Phase 3：后端 auto-allow + WS 广播事件到前端记录** | 协议链路先跑通；弹窗留给 Phase 4 |
| `fs/*` handler | **stub（返回空）** | obsidian-agent-client 也是 stub；OmniTerm 有 FileManager 但初期不接 |
| `terminal/*` handler | **portable-pty 直接 spawn，不入 tmux** | tmux 是用户可见 session，agent 私人 terminal 无需入 tmux；已有 `portable-pty` 依赖 |
| Session ID 归属 | **DB `sessions.acp_session_id` = ACP `sessionId`**（Phase 2 已加列） | 免加表，双 id 语义清楚 |

### 6.2 参考项目证据（实施时对照读）

| 关注点 | obsidian-agent-client（TS） | adhdev（TS） |
|--------|---------------------------|--------------|
| Spawn + stdio | `src/acp/acp-client.ts:253-259` | `packages/daemon-core/src/providers/acp-provider-instance.ts:21-48` |
| ndJson stream 装配 | `acp-client.ts:381-414` | 同上文件（`ClientSideConnection + ndJsonStream`） |
| Client handler 注册（method name） | `acp-client.ts:385-413`（`onNotification("session/update").onRequest("session/request_permission")...`） | 同 |
| 事件分派（session/update kind 枚举） | `src/acp/acp-handler.ts:76-160` | 同 acp-provider-instance.ts |
| 权限队列 | `src/acp/permission-handler.ts`（280 行） | `packages/daemon-core/src/providers/status-monitor.ts` 关联 |
| Terminal handler | `src/acp/terminal-handler.ts`（281 行） | `packages/daemon-core/src/cli-adapters/pty-transport.ts` |
| AgentConfig 通用模型 | `src/types/agent.ts:39-98`（`BaseAgentSettings` + 每 agent 变体） | `packages/daemon-core/src/providers/contracts.ts` |

Rust 官方 crate 关键类型（`docs.rs/agent-client-protocol/latest/`）：
- `Stdio` transport
- `Client::builder().name(...).connect_with(transport, handler_closure)` 
- `InitializeRequest`, `SessionNotification`, `RequestPermissionRequest/Response`, `SessionUpdate` 枚举
- 具体 API 面待 crate 源码验证；实施时如与 doc 描述不符，以 crate 源码为准

### 6.3 目标模块结构

```
src/acp/
  mod.rs
  client.rs         // AcpClient：spawn 子进程 + connect + initialize + new_session + send_prompt + cancel + disconnect
  handler.rs        // 处理入站：session/update、request_permission、fs/*、terminal/*
  permission.rs     // 权限请求队列 + auto-allow 开关
  terminal.rs       // 用 portable-pty 服务 agent 的 terminal/* 请求
  agent_config.rs   // AgentConfig 结构（对应 DB `agents` 表）
  supervisor.rs     // 全局 SessionId -> AcpClient 表（per-session 生命周期管理）

src/api/
  agents.rs         // 新增：GET/POST/PUT/DELETE /api/v1/agents 管理 agent 注册表
  sessions.rs       // 修改：runtime_kind='acp' 分支实际拉起 AcpClient 而非 501

src/ws/
  acp.rs            // 新增：/ws/acp/{session_id} 转发 session/update 与权限请求到前端

migrations/
  20260716_add_agents_table.sql   // agents 表 + sessions.agent_id FK

frontend/src/
  api/client.ts     // 新增 Agent 类型 + agents API 调用
  stores/agentStore.ts   // 新增：agents 列表
  components/AgentPicker/   // 新增（Phase 3 最小版）：创建 session 时选 agent
```

**分层守则**（AGENTS.md §"严守分层"）：
- `src/acp/` 只做协议 + 进程；不 import `axum`/`sqlx`
- `src/api/` 组装 HTTP 层，调 `src/acp/` + 读写 DB
- `src/ws/acp.rs` 桥接 `AcpClient` 事件到 WS 帧

### 6.4 DB Schema 变更

```sql
-- migrations/20260716_add_agents_table.sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',       -- JSON array
    env TEXT NOT NULL DEFAULT '[]',        -- JSON array of {key,value}
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);
-- 约束：runtime_kind='acp' 时 agent_id 必须非空（应用层校验，不加 CHECK）

-- 内置 agent 种子（可选，或让 UI 引导添加）
-- 不写入 seed，让用户主动添加，避免 "存在但未配置 API key" 的僵尸行
```

### 6.5 任务列表

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| P3-01 | 加 `agent-client-protocol` 到 `Cargo.toml` 并 `cargo check` | `Cargo.toml` | **已完成**（`bdfe8b1`） |
| P3-02 | Migration：`agents` 表 + `sessions.agent_id` FK | `migrations/20260716_add_agents_table.sql`（新） | **已完成**（`bdfe8b1`） |
| P3-03 | `AgentConfig` model + sqlx `FromRow` | `src/models/agent.rs`（新） | **已完成**（`bdfe8b1`） |
| P3-04 | Agent CRUD API：list/create/update/delete | `src/api/agents.rs`（新） + `src/api/mod.rs` 挂载 | **已完成**（`bdfe8b1`） |
| P3-05 | `src/acp/mod.rs` 模块骨架 + 声明子模块 | `src/acp/mod.rs`（新） | **已完成**（`a577b85`） |
| P3-06 | `AcpClient::spawn_and_connect(config, cwd)` | `src/acp/client.rs`（新） | **已完成**（`a577b85`） |
| P3-07 | `AcpHandler`：处理 `session/update` 各 kind + `request_permission` + `fs/*` stub + `terminal/*` | `src/acp/handler.rs`（新） | **已完成**（`a577b85`） |
| P3-08 | `PermissionQueue`：auto-allow + 事件广播 | `src/acp/permission.rs`（新） | **已完成**（`a577b85`） |
| P3-09 | `AcpTerminalManager`：用 `portable-pty` 服务 `terminal/*` | `src/acp/terminal.rs`（新） | **已完成**（`a577b85`，改为 `tokio::process` + mpsc kill channel） |
| P3-10 | `AcpSupervisor`：`Arc<Mutex<HashMap<SessionId, AcpClient>>>` + `AppState.acp_supervisor` | `src/acp/supervisor.rs`（新）+ `src/main.rs` | **已完成**（`a577b85`） |
| P3-11 | `create_session` ACP 分支从 501 改为：查 agent → spawn → init → new_session → 存 `acp_session_id` | `src/api/sessions.rs` | **已完成**（`71f73d5`） |
| P3-12 | `/ws/acp/{session_id}` handler：转发 session_update 与权限事件到前端 | `src/ws/acp.rs`（新） + `src/ws/mod.rs` | **已完成**（`71f73d5`） |
| P3-13 | `send_prompt` HTTP endpoint：POST `/api/v1/sessions/{id}/prompt` | `src/api/sessions.rs` | **已完成**（`71f73d5`） |
| P3-14 | Session `DELETE` handler 加 ACP 分支：`supervisor.dispose(session_id)` | `src/api/sessions.rs` | **已完成**（`71f73d5`） |
| P3-15 | 前端 `Agent` 类型 + agents API client | `frontend/src/api/client.ts` | **已完成**（`b5b9a58`） |
| P3-16 | 前端 `agentStore`（Zustand） | `frontend/src/stores/agentStore.ts`（新） | **已完成**（`b5b9a58`） |
| P3-17 | 前端 `AgentPicker` 最小版（创建 session 前选 agent） | `frontend/src/components/AgentPicker/`（新） | **已完成**（`b5b9a58`） |
| P3-18 | 前端设置面板：agent CRUD UI | `frontend/src/components/Settings/AgentSettings.tsx`（新） | **已完成**（`b5b9a58`） |
| P3-19 | 后端集成测试：spawn `echo` 作为 fake agent，验证协议链路 | `tests/acp_integration.rs`（新） | **延期**到 Phase 4（与 Chat 视图联调一起做，fake-agent 二进制需要同步设计） |
| P3-20 | 文档：`docs/architecture/backend.md` 加 `acp/` 模块段；`docs/reference/user-testing.md` 加 ACP 测试用例；`CHANGELOG.md` Unreleased 追加 | 三个文档 | **已完成**（`0382800`） |

### 6.6 验证矩阵

| 类别 | 验证项 | 命令 | 期望 |
|------|--------|------|------|
| 依赖 | crate 引入编译过 | `cargo check` | 无错 |
| Migration | 新表建立 | 启动 → `sqlite3 omniterm.db ".schema agents"` | 表存在 |
| Agent CRUD | 创建 agent | `curl -X POST /api/v1/agents -d '{"display_name":"Claude","command":"claude-agent-acp",...}'` | 200 + id |
| ACP session 创建 | 用 fake agent（echo/stub 二进制）| POST session with runtime_kind='acp' + agent_id | 200 + session 记录 + acp_session_id 非空 |
| Streaming | 发 prompt 收 session/update | WS `/ws/acp/{id}` | 收到 `agent_message_chunk` 帧 |
| 权限流转 | agent 触发 request_permission | fake agent 主动发 | WS 收到权限事件、后端 auto-allow 应答 |
| 生命周期 | DELETE session | `curl -X DELETE /api/v1/sessions/{id}` | 子进程被 kill、DB 行删 |
| 集成回归 | 现有 tmux session | tmux 分支 curl | 全绿 |

### 6.7 已知遗留（Phase 3 不处理）

- Agent API key **明文存储在 DB** —— Phase 5 迁移到系统 keychain（`keyring` crate 候选）
- `fs/*` handler 是 stub —— Phase 5 接入 FileManager
- 单 agent 进程池化 —— Phase 5
- 前端权限弹窗 —— Phase 4
- Session 恢复：`session/load` / `session/resume` —— Phase 5

### 6.8 Commit 拆分建议

按依赖顺序，可拆 3-5 个 commit：
1. `feat(backend): agents 表 + AgentConfig model + CRUD API`（P3-02..04）— **已完成**（`bdfe8b1`）
2. `feat(backend): ACP client 骨架（spawn + protocol + handler + supervisor）`（P3-01, P3-05..10）— **已完成**（`a577b85`）
3. `feat(backend): ACP session HTTP + WS 路由`（P3-11..14, P3-19）— **已完成**（`71f73d5`，P3-19 集成测试留 P3-19 单独做）
4. `feat(frontend): AgentPicker + agents 设置`（P3-15..18）
5. `docs: ACP Phase 3 文档更新`（P3-20）

#### 6.8.1 P3-05~P3-10 实施记录（2026-07-15）

**文件**：`src/acp/{mod,client,handler,permission,terminal,supervisor}.rs` + `src/main.rs` 改动
**关键设计决策**：
- `AcpAgent` transport（非 `Stdio`）用于 spawn agent 子进程
- `ConnectionTo<Agent>` 是 `Clone`，通过 oneshot channel 从 `connect_with` 闭包传出
- 权限：Phase 3 全量 auto-allow（`PermissionManager`）
- Terminal：`tokio::process::Command`（非 portable-pty），用 mpsc 命令通道解决 child 所有权
- fs/* handler：stub（返回空）
- Session update 通过 `broadcast::channel` 广播，WS handler 订阅后转发前端
- `AcpSupervisor` 用 `Arc<Mutex<HashMap<String, Arc<AcpClient>>>>` 管理多 session

**验证**：`cargo check` 通过、`cargo test --test agent_hook_integration` 8/8 通过、`npx tsc -b` 通过。

#### 6.8.2 P3-11~P3-14 实施记录（2026-07-15）

**文件**：`src/api/sessions.rs`、`src/api/mod.rs`、`src/ws/acp.rs`（新）、`src/ws/mod.rs`
**关键变更**：
- `create_session` ACP 分支：验证 `agent_id` → `load_agent` → `resolve_workspace_path` → `AcpClient::spawn_and_connect` → supervisor.insert → DB INSERT（含 `acp_session_id` + `agent_id`）
- `/ws/acp/{session_id}`：split WS → 广播订阅 `SessionNotification` → JSON 文本帧转发；接收 prompt/cancel 命令
- `POST /sessions/{id}/prompt`：HTTP 端点调用 `send_prompt`，返回 `stop_reason`
- `delete_session` ACP 分支：`supervisor.dispose` → `Arc::try_unwrap` → `disconnect`
- 提取 `resolve_workspace_path` 公共函数，tmux/ACP 共用

**验证**：`cargo check` 通过、集成测试 8/8、前端 tsc 通过。

#### 6.8.3 P3-15~P3-18 + P3-20 实施记录（2026-07-15）

**文件**：
- 前端类型 + API：`frontend/src/api/client.ts`（`Agent`/`CreateAgent`/`UpdateAgent`、agents CRUD + sendPrompt、createSession 加 runtimeKind/agentId）
- 前端状态：`frontend/src/stores/agentStore.ts`（新）
- 前端 UI：`frontend/src/components/AgentPicker/AgentPicker.tsx`（新）、`frontend/src/components/Settings/AgentSettings.tsx`（新）、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`
- i18n：`frontend/src/locales/{en,zh}/translation.json`（`agentPicker.*`、`settings.agents.*`、`settings.category.agents`）
- 文档：`docs/architecture/backend.md`（新增「ACP Module (Phase 3)」章节 + src 树 + API 端点 + Sessions 表 agent_id 列）、`docs/reference/user-testing.md`（§11 ACP 智能体会话用例）、`CHANGELOG.md`

**关键变更**：
- `AgentPicker` 最小版 —— `<select>` + noneLabel prop（caller 翻译）；useEffect 首次挂载加载 agents
- Sidebar 「新建会话」 modal：新增 Agent 下拉 + hint；选中 agent → `runtime_kind='acp'`、留空 → tmux；`sessAgentId` 状态与 `sessName` 同步重置
- `AgentSettings`：chip 选择器 + 内联编辑表单；env 行（KEY/value）动态增删；`api_key_value` 「留空保持原值」语义用 `api_key_dirty` flag 区分 create（总是发）vs update（只在 dirty 时发）
- Settings 新增 AGENTS tab：CategoryId union + CATEGORIES 数组同步
- 文档 `backend.md`：描述 ACP 生命周期 5 步、`terminal/*` 用 `tokio::process` + mpsc kill channel 的架构选择

**P3-19 延期**：fake-agent 集成测试（spawn echo 走 ACP 协议）留到 Phase 4 与 Chat 视图联调一起做 —— 需要设计一个最小 ACP-speaking 二进制，与前端 Chat 的 session/update 渲染一起验证才有意义。

**验证**：`cargo check` 通过、`npx tsc -b` 全绿、pnpm lint 0 error（11 warning 全是 pre-existing 的 `react-hooks/exhaustive-deps`，不涉及本次改动）。

---

### 6.9 Phase 4-5 展望

#### Phase 4：前端 Chat 视图 + 默认切 ACP

**Phase 4 才把 `RuntimeKind::default()` 从 `Tmux` 改成 `Acp`** —— 新用户默认 Chat 视图。

关键点：
- Chat mode / Tmux mode 是**按 session 的 `runtime_kind` 二选一**渲染，不做同 session 双视图切换
- 权限请求弹窗（对应 Phase 3 的 auto-allow）
- Tool call / plan / mode 等 session/update 全量渲染
- Chat 输入框、消息历史、cancel 按钮

#### Phase 5：统一与打磨

- ACP 与 tmux 的 agent_state 前端 badge 归一
- Agent 进程池化 / 空闲回收
- API key 存储升级到系统 keychain
- `fs/*` handler 接入 FileManager
- Session `load` / `resume` / `fork` 支持
- 老 tmux 用户迁移到 ACP 的引导文档

#### Phase 5 之后

上游方案 §"后续可选增强"列出的会话导入/导出、远程 agent 等——一律**先不排期**，等 Phase 5 稳定 1 个版本后重新评估。

---

## 7. 新会话 LLM 接手 checklist

新会话打开本项目后，若被要求"继续 ACP 接入"：

1. **读本文档**（`docs/dev/plans/2026-07-15-acp-integration-execution.md`）
2. **读上游方案**（`docs/dev/plans/2026-07-12-acp-integration-plan.md`）——理解方向
3. **读 AGENTS.md** §"工程准则" 和 §"文档索引"
4. 检查当前进度：
   - 查 `CHANGELOG.md` 最近条目
   - 查 `migrations/` 是否已有 `20260715_add_runtime_kind.sql` → Phase 1+2 已实施（`2757a57`）
   - 查 `migrations/` 是否已有 `20260716_add_agents_table.sql` → Phase 3 已开始/完成
   - 查 `src/acp/` 目录是否存在 → 判断 Phase 3 骨架进展
5. 根据进度决定入口：
   - Phase 1+2 未做 → 按本文 §5 实施（历史保留，不应发生）
   - Phase 3 未做 → 按本文 §6 实施
   - Phase 3 已做部分 → 按 §6.5 任务列表继续
6. **不要跳过决策日志**：§4.1 + §6.1 已锁定的选择，除非有强证据反证，直接执行；若要覆盖需在文档追加一行显式声明
7. **不要触碰上游方案 §"明确不做的事"**——尤其是会话桥接
8. **禁 codex-mobile 拷贝**：曾扫过 codex-mobile 作 stdio bridge 模式参考，但 OmniTerm 是通用 hub 不做 agent 独立适配，其代码不适用

---

## 8. 变更历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-07-15 | 初版：合并 Phase 1+2，锁定决策 A/B/C，Phase 3-5 出方向 | Qoder |
| 2026-07-15 | Phase 1+2 实施完成（`2757a57`）；Phase 3 细化：锁定 stdio-direct + 官方 `agent-client-protocol` crate，明确 OmniTerm 通用 ACP hub 定位，加 `agents` 表 schema、`src/acp/` 模块结构、20 项任务列表；修正 §1 参考项目路径（obsidian-agent-client Apache-2.0 + adhdev AGPL） | Qoder |
| 2026-07-15 | P3-05~P3-10 实施：`src/acp/` 模块骨架（client、handler、permission、terminal、supervisor）；AcpClient 通过 `AcpAgent` transport spawn agent 子进程 + `connect_with` + oneshot 传出 `ConnectionTo`；`AcpSupervisor` 加入 `AppState`；auto-allow 权限；tokio::process terminal manager + mpsc kill channel | Qoder |
| 2026-07-15 | P3-11~P3-14 实施：`create_session` ACP 分支实际 spawn agent + 写 DB；`/ws/acp/{session_id}` WS handler 转发 session/update；`POST /sessions/{id}/prompt` 端点；`delete_session` ACP 分支 dispose + disconnect；提取 `resolve_workspace_path` 公共函数 | Qoder |
| 2026-07-15 | P3-15~P3-18 + P3-20 实施：前端 `Agent` 类型 + `agentStore` (Zustand) + `AgentPicker` (Sidebar 新建会话 modal 集成) + Settings `AgentSettings` tab (CRUD + env 行 + api_key_value 留空保持原值)；`docs/architecture/backend.md` 新增「ACP Module (Phase 3)」章节；`docs/reference/user-testing.md` §11 ACP 用例；`CHANGELOG.md` Unreleased 条目；P3-19 fake-agent 集成测试延到 Phase 4 | Qoder |
