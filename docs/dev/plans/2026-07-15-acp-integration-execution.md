# ACP 接入执行计划（Phase 1 + Phase 2 合并 change）

> **作用**：把 `2026-07-12-acp-integration-plan.md` 的方向性方案落到可执行的代码任务。新会话 LLM 从本文一份即可接手。
> **状态**：Phase 1 + 2 已细化并合并为一个 change，尚未实施。Phase 3-5 已出方向，未细化。
> **上次更新**：2026-07-15

---

## 1. 源文档索引（按接手顺序读）

| 序号 | 文档 | 关系 |
|------|------|------|
| 1 | `docs/dev/plans/2026-07-12-acp-integration-plan.md` | **上游方案**：五阶段方向性设计、明确不做的事、参考项目路径。本文是它的执行细化。 |
| 2 | `AGENTS.md` | 工程准则：先规划后编码、严守分层、奥卡姆剃刀、`.env.local` 配置统一、文档索引触发规则。 |
| 3 | `docs/architecture/backend.md` | Rust 后端分层：`api/` / `tmux/` / `ws/` / `models/` 边界。 |
| 4 | `docs/architecture/frontend.md` | 前端结构、store 组织。 |
| 5 | `docs/reference/references.md` | ACP 参考项目位置（`/home/pax/coding/research/obsidian-agent-client`、`typescript-sdk`），license 注意事项。 |
| 6 | `PROGRESS.md` / `CHANGELOG.md` | 项目里程碑与用户可见变更。 |

**参考项目**（License 只读、不复用代码）：
- `/home/pax/coding/research/obsidian-agent-client`（AGPL，ACP client 参考实现）
- `/home/pax/coding/research/obsidian-agent-client/documentation/app-server-schemas/typescript/v2/`（ACP 协议 schema）
- `/home/pax/coding/research/typescript-sdk`（ACP TypeScript SDK）

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

## 5. Phase 1 + 2 合并 change 实施任务

**Change 命名建议**：`acp-runtime-scaffolding`（OpenSpec proposal 名）

### 5.1 任务列表

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

### 5.6 Commit 计划（顺序）

1. `feat(backend): tmux 缺失时降级为 warning`（T1）
2. `feat(backend): sessions 表加 runtime_kind/acp_session_id，为 ACP 预留`（T2-T9, T11）
3. `feat(frontend): Session 类型加 runtime_kind`（T10）
4. `docs: 更新 backend schema 与 CHANGELOG`（T12）

或合并为一个 commit——按项目 CHANGELOG 只写实质性改动的原则，2+3+4 合并更清晰。

### 5.7 预估工作量

**3-4 天**（对比上游方案 Phase 1+2 累计 2-4 周）。

---

## 6. Phase 3-5 展望（供本 change 完成后新会话接手）

### 6.1 Phase 3：ACP Runtime 接入（次序：紧接 Phase 1+2 完成后启动）

**目标**：`runtime_kind='acp'` 分支从 501 变为可用。

**待细化的关键决策**（尚未拍板，接手前必须先讨论）：
1. **ACP adapter 部署形态**（上游方案表格建议"独立 Node 进程 + HTTP/WS"，但 ACP 协议原生是 stdio ndJSON）
   - 候选 a：Rust 直接 spawn adapter 二进制，管 stdin/stdout —— 贴协议原生
   - 候选 b：单独 sidecar Node 服务，Rust 走 HTTP —— 多一层
   - **建议先看 `research/obsidian-agent-client` 的做法再决定**
2. **权限请求前端交互**：ACP 的 `request_permission` 语义映射到前端弹窗
3. **进程生命周期**：per-session spawn / 池化 / 空闲回收（原方案挪到 Phase 5，本方案建议 Phase 3 先 per-session 简单实现）

**需要新增的模块（草案）**：
- `src/acp/` 新模块：`adapter.rs`（进程管理）、`protocol.rs`（ndJSON 编解码）、`permission.rs`（权限队列）
- `src/ws/agent.rs` 新增 `/ws/agent/{session_id}` handler
- `src/api/mod.rs` 挂载新路由

**Phase 3 完成信号**：
- ACP session 能从 UI 创建、收到 `session/update`、收到 tool call、能发 prompt
- 权限请求触达前端（Phase 4 才做弹窗，Phase 3 只做协议链路 + console 输出）

### 6.2 Phase 4：前端 Chat 视图

**Phase 4 才把 `RuntimeKind::default()` 从 `Tmux` 改成 `Acp`**——新用户默认 Chat 视图。

关键点：Chat mode / Tmux mode 是**按 session 的 `runtime_kind` 二选一**渲染，不做同 session 双视图切换。切换 session 时切换视图。

### 6.3 Phase 5：统一与打磨

- ACP 与 tmux 的 agent_state 前端 badge 归一
- adapter 进程池化
- 老 tmux 用户迁移到 ACP 的引导文档

### 6.4 Phase 3-5 之后

上游方案 §"后续可选增强"列出的会话导入/导出、远程 agent 等——一律**先不排期**，等 Phase 5 稳定 1 个版本后重新评估。

---

## 7. 新会话 LLM 接手 checklist

新会话打开本项目后，若被要求"继续 ACP 接入"：

1. **读本文档**（`docs/dev/plans/2026-07-15-acp-integration-execution.md`）
2. **读上游方案**（`docs/dev/plans/2026-07-12-acp-integration-plan.md`）——理解方向
3. **读 AGENTS.md** §"工程准则" 和 §"文档索引"
4. 检查当前进度：
   - 查 `PROGRESS.md` 与 `CHANGELOG.md` 最近条目
   - 查 `migrations/` 是否已有 `20260715_add_runtime_kind.sql` → 判断 Phase 1+2 是否已实施
   - 查 `src/api/sessions.rs` 是否已有 `RuntimeKind` 分支
5. 根据进度决定入口：
   - Phase 1+2 未做 → 按本文 §5 实施
   - Phase 1+2 已做 → 按本文 §6.1 先做 Phase 3 决策讨论，再细化
6. **不要跳过决策讨论**：Phase 3 的 adapter 形态是全局架构决策，不可默认选择
7. **不要触碰上游方案 §"明确不做的事"**——尤其是会话桥接

---

## 8. 变更历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-07-15 | 初版：合并 Phase 1+2，锁定决策 A/B/C，Phase 3-5 出方向 | Qoder |
