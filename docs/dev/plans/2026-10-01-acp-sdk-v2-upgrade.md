# ACP SDK 1.3 → 2.x 升级与 ACP 模块补测计划

> 状态：**已实施**（2026-10-01）——依赖升级零源码改动，三项行为差异取证完成，R07/R08 补测落地（fake agent 用例 6 → 16、supervisor 2 例），全量门禁绿。
> 触发条件：修改 `Cargo.toml` 的 `agent-client-protocol` 依赖、`src/acp/client.rs` 的 builder/handler 注册或发送链路、`src/acp/supervisor.rs` / `src/acp/terminal.rs` / `src/acp/permission.rs`，或排查「升级后 ACP 行为差异」前**必读**——2.x 与 1.3 的行为差异已逐项取证（含证据位置），勿重复调研。
> 关联：
> - `docs/dev/plans/archive/2026-09-21-acp-agent-connection-cpu-spin.md` §「ACP SDK 1.3.0 → 2.x 迁移评估」——本轮直接复用其迁移清单与核对方法；该文记录当时的暂缓决策与三层理由
> - `docs/dev/plans/backlog/qa-quality-gates-followups.md` R07 / R08（触发条件均为本升级时点）
> - `docs/reference/acp-protocol-reference.md`（wire 契约）、`docs/architecture/backend.md` §ACP Module、`docs/dev/performance-and-safety.md`（外部输入速率）

## 背景

- **09-22 评估**：omniterm 只用 SDK 的稳定 v1 表面，2.0 明确保持该 wire schema 不变；逐项核对 47 个 v1 类型后预计改动集中在 `src/acp/client.rs`、量级 ≤20 行。当时结论是暂缓（根因已由 futures 0.3.34 修复、2.x 收益与需求不匹配）。
- **2026-10-01 用户决定启动**。上游最新 **2.2.0**（2026-09-18 发布，依赖 schema **1.9.1**）。
- 该时点同时命中 backlog 触发条件：R07「`agent-client-protocol` crate 大版本升级前集中补测」、R08「改动 client.rs 连接/发送/取消路径时补测」，故补测纳入本计划一并推进。

## 范围与优先级

| 优先级 | 项 | 目标 | 状态 |
|--------|-----|------|------|
| P0 | 依赖升级 | `agent-client-protocol = "2"`，lock 升 2.2.0 / schema 1.9.1，编译与全量测试零回归 | ✅ 编译 `--all-targets` 零改动通过；全量测试 668+8+2 全绿 |
| P1 | 行为差异取证 | 09-22 清单的 3 个风险项逐项取证或处置（D3/D4/D5） | ✅ 风险 1 判定不适用、风险 2 判定等价并 e2e pin、风险 3 纯增确认 |
| P2 | R07/R08 补测 | prompt/cancel/disconnect 链路 + `PermissionManager` / `AcpTerminalManager` 端到端 + `AcpSupervisor` | ✅ 已实施（见 Phase 3） |
| P3 | 文档闭环 | backend.md / CHANGELOG / 本计划回写 | ✅ 已实施 |

### 不纳入范围（含理由）

- **wire 协议迁 v2**：`unstable_protocol_v2` feature 仍在 unstable（`Client.v2()` 文档明示）；所有对接 agent 协商 `protocolVersion:1`，迁移无收益且会打断现存实现（工程准则 8：多实现兼容）。
- **采用 2.1 的稳定 session restore builders（`RestoredSession`/`ActiveSession`）**：#347 把会话路由交给 SDK 管理，与 omniterm「自管会话 + 自有 accumulator/seq/replay」架构冲突，属架构级重构，不在依赖升级范围内；仅在「会话路由下沉」成为真实需求时另行立项。
- **新 `SessionUpdate` 变体（`Notice`/`CompactionUpdate`/`CompactionSummaryChunk`）的 UI 呈现**：属新功能；当前无对接 agent 发送（其上游特性晚于本仓协议基线），后端按未知帧透传、前端按 variant 不匹配丢弃（已有兜底），升级只带来「可解析而非报错」的健壮性提升。
- **`persist_config_snapshot` 落库移出通知派发循环**：风险 1 取证结论为「1.3 与 2.2 的通知派发均为串行」（D3），不存在 1.x→2.x 的吞吐模型变化，不构成本轮改动；若未来实测高帧率会话劣化，按 D3 翻盘条件单独立项。

## 设计决策（ADR）

### D1：只升级 SDK 版本，不启用 v2 wire 协议

- **决策**：`Client.builder()` 稳定路径 + 显式 `InitializeRequest::new(ProtocolVersion::V1)` 保持不变；不引入 `unstable_protocol_v2`，不调 `Client.v2()` / `protocol_connector()`。
- **理由**：2.0 release notes 明文「keeps the stable ACP v1 wire schema unchanged while making coordinated breaking changes to the Rust SDK APIs」；对接 agent（codebuddy/ccb/opencode/omp/pi 等）均协商 v1。
- **否决项**：v2 wire（unstable feature、无 agent 支持）；协议连接器自动协商（无收益，增加行为面）。
- **翻盘条件**：出现只支持 v2 wire 的目标 agent；或 `unstable_protocol_v2` 转稳定且 v2 带来真实能力需求。

### D2：不采用 `ActiveSession`/`RestoredSession` 稳定 builders

- **决策**：保留自管会话架构（`session/new` 与复用 `acp_session_id` 两条路径经 `spawn_with_session`；`load_session` 手工发 `LoadSessionRequest`）。
- **理由**：restore builders 的价值是「先装路由再发请求」的载荷管理，而 omniterm 的会话真相源在自身（accumulator/seq/replay/落库），接入 SDK 路由会与既有 `restore_acp_session` 重放链路形成双真相源。
- **否决项**：2.1 的 #347 builders（架构冲突，非本次升级必须）。
- **翻盘条件**：自管重放链路持续成为缺陷来源且 SDK builders 能完整覆盖其语义时，另立「会话路由下沉」计划评估。

### D3：「响应回调强制有序派发」风险判定 —— 不适用（已取证）

- **09-22 清单原风险**：2.0 强制 ordered dispatch，而我们的通知 handler 在派发循环内 `await` 一次 SQLite 写（`config_prefs::persist_config_snapshot`），高帧率会话吞吐可能变化。
- **取证（2026-10-01，源码级）**：
  1. 2.0 变更原文（crate CHANGELOG v2.0.0 Breaking changes）：*「Response callbacks that select ordered consumption … now finish before later inbound messages are dispatched」*——**作用域是 ordered response callbacks**（配合动态 handler 注册的屏障），不是通知派发。
  2. 通知派发在 1.3 与 2.2 均为入站循环内 **inline await**（1.3 `src/jsonrpc/incoming_actor.rs:184-206`；2.2 同文件 `:177-201`），即**通知串行语义两版一致**，1.x 就已在 await handler 后才读下一条消息。
  3. omniterm 全部请求消费走 `send_request(...).block_task().await`（`client.rs`），未注册任何 response callback，不触及该屏障。
- **决策**：判定不适用，不做 handler 重构。`persist_config_snapshot` 的 await 与 1.3 行为完全一致。
- **翻盘条件**：升级后实测高帧率会话出现延迟/掉帧且可归因于该 await → 把落库移出派发循环（spawn + 通道）。
- **证据留档**：上述行号为 crate 源码（`~/.cargo/registry/src/.../agent-client-protocol-{1.3.0,2.2.0}/`），升级后续版本时应重新核对。

### D4：env 重复键语义 —— 后端到端等价（已取证）

- **09-22 清单原风险**：1.3 `from_args` 收集 env 为 `Vec<EnvVariable>`，2.0 改 `BTreeMap`（同名后键覆盖）。
- **取证**：
  - 1.3：Vec 逐条 `std_cmd.env(&name, &value)`（`acp_agent.rs:200-201`）→ 同名后写覆盖前写（`Command::env` 语义）。
  - 2.2：`from_args` 用 `BTreeMap::insert` 逐条插入（同名覆盖）后 `std_cmd.envs(&map)`（`acp_agent.rs:855`、`:267`）。
  - **最终子进程可见环境两版相同**（同名键均为最后一条胜出；无关键的顺序对进程环境无语义差异）。
- **决策**：判定等价；以 fake agent 端到端测试 pin 住「重复键最后一条胜出」（`FAKE_DUP` 写文件断言），防未来解析路径回归。
- **翻盘条件**：若出现「首条胜出」或去重顺序可观测的行为差异，重新核对并在 `agent_proc`/`client` 侧显式去重。

### D5：补测形态 —— fake agent 端到端 + 抽公共 test_support

- **决策**：
  1. `PermissionManager`（`handle_request`/`resolve`/`cancel_all`/`pending_events`）与 `AcpTerminalManager`（`handle_*`）的测试**经真实连接由 fake agent 驱动**——crate 的 `Responder::new` 为私有（`jsonrpc.rs:4540`），测试无法直构 Responder，单元测试不可行；端到端同时验证 handler 注册接线，价值更高。
  2. `AcpSupervisor` 用真实（fake agent 构造的）client 做 in-process 断言。
  3. 把 fake agent 脚本与 helpers 从 `fake_agent_tests.rs` 抽到 `src/acp/test_support.rs`（`#[cfg(all(test, unix))]`）供多测试模块复用（工程准则 6：禁 copy-paste）。
- **否决项**：① 为可测性给 `PermissionManager`/`AcpTerminalManager` 注入 trait 抽象——为测试引入生产抽象，过度设计；② 向 crate 提 issue 要求公开 Responder 构造——上游无此义务。
- **翻盘条件**：crate 未来公开 Responder 测试构造或提供测试工具 → 可下沉为单元测试。

## 实施分期

| Phase | 产出 | 主要改动 | 依赖 |
|-------|------|---------|------|
| 1（P0） | 依赖升级 + 零回归 | `Cargo.toml`（`"1.3"`→`"2"`）、`Cargo.lock`；`cargo check --workspace --all-targets`；`./dev.sh test` | 无（已完成） |
| 2（P1） | 三项风险取证与处置 | 本计划 D3/D4 + 证据；`test_support` 的 `FAKE_DUP` 端到端 pin | Phase 1 |
| 3（P2） | R08 协议链路测试 | `fake_agent_tests.rs`：prompt 正常链路（流式通知 + `end_turn`）、cancel 链路（agent 收到 `session/cancel`）、权限请求 resolve/cancel_all 往返、shutdown 后 `is_alive=false` + 发送失败 | Phase 2 |
| 3（P2） | R07 模块补测 | `fake_agent_tests.rs`：terminal/* 往返（create→wait→output→release）；`supervisor.rs`：insert/get/dispose/snapshot/shutdown_all/进程事件 | Phase 2 |
| 4（P3） | 文档闭环 | `backend.md`（如行为描述需订正）、`CHANGELOG.md`、本计划状态回写、AGENTS.md 索引 | Phase 3 |

## 验收标准

- [x] `cargo check --workspace --all-targets` 零错误、零源码改动（升级即编译通过）
- [x] `./dev.sh test` 全量绿：bin **679** + `agent_hook_integration` 8 + `runtime_kind_migration` 2，0 failed（升级前基线 668+8+2；bin 新增 11 = fake agent 9 + supervisor 2，预存在 ignored 不增）
- [x] `Cargo.lock` 锁定 `agent-client-protocol 2.2.0` + `agent-client-protocol-schema 1.9.1`
- [x] 新增测试覆盖（见 Phase 3 清单），且全量测试保持绿
- [x] `cargo fmt --all --check` 与 `cargo clippy --workspace --all-targets -- -D warnings` 零告警
- [x] fake agent 既有 6 用例在 2.2.0 下保持绿（crate 行为 pin 未被破坏——尤其 `is_alive` 误报存活、agent 死亡不结束连接任务两条既有行为）
- [x] 文档闭环完成（CHANGELOG / backend.md 核对 / AGENTS.md 索引 / 本计划状态）

## Phase 3 实施记录（2026-10-01）

**零源码改动落地**：`Cargo.toml` 改 `agent-client-protocol = "2"` 后 `cargo fetch`/`check --all-targets` 一次通过，`src/acp/client.rs` 的 builder/handler 链、`terminal.rs`/`permission.rs`/`handler.rs` 的 schema 类型用法均无需修改——与 09-22 评估「改动集中在 client.rs、量级 ≤20 行」一致且更优（0 行）。

**测试产出**：
- 抽公共设施 `src/acp/test_support.rs`（fake agent 脚本 + spawn + 进程探针 + 事件日志），`fake_agent_tests.rs` 与 `supervisor.rs` 共用；脚本新增 `prompt_ok` / `cancel` / `perm` / `term` / `termkill` 模式与 `FAKE_DUP`/`FAKE_EVENTS_FILE` 注入。
- `fake_agent_tests.rs` 6 → 16 例（新增 9 + 保留 7）；`supervisor.rs` 0 → 2 例。
- 两处实测 wire/行为细节已写进测试注释：① 被杀终端的 `wait_for_exit` 响应为 `result:{}`（空 `TerminalExitStatus` 序列化后 `exitStatus` 整体省略）；② `perm` 模式下 `cancel` 与审批应答竞速时 agent 可能对同一 prompt 发两次应答，客户端对第二条按未知 id 忽略（无害）。

**文档闭环**：`src/ws/acp.rs` 两处「截至 schema 1.4.0」注释更新为 1.9.1 并复核结论仍成立（`StopReason` 在 1.9.1 仍是 5 个单位变体的闭枚举，`_` 兜底臂仍不可达，`unknown_variant_is_unreachable_today_documented` 无需改）；`backend.md` 引用的 crate 行为（`process_group(0)` / `kill_process_group`）在 2.2 仍成立（`acp_agent.rs:278/328`），无需改；`qa-quality-gates-followups.md` R08 销项、R07 部分销项（边角用例留待后续）。

## 风险与文档闭环

| 风险 | 缓解 |
|------|------|
| 2.2 行为与 1.3 存在清单外的隐藏差异 | fake agent 既有 6 用例 + 新增协议链路用例覆盖 prompt/cancel/permission/terminal/teardown；`is_alive` 与「agent 死亡不结束连接任务」两条既有 pin 若翻转会立刻转红 |
| 新 schema 变体（Notice/compaction）改变前端行为 | 前端按 variant 名匹配、未知变体丢弃（无穷尽匹配）；不新增 UI，行为与「帧被忽略」等价 |
| 2.x 后续小版本再引入行为变化 | `Cargo.toml` 写 `"2"`（接受 2.x 补丁/小版本）；本计划证据行号在升级时应复核 |
| R07/R08 补测误锁脆弱实现细节 | 只断言协议/行为契约（响应内容、事件、进程生死），不断言内部结构 |

**文档闭环**：
- `CHANGELOG.md`：`[backend]` 条目——SDK 1.3→2.2 升级（wire 不变、源码零改动）、三项差异取证结论、测试补强（R07/R08 部分）。
- `docs/architecture/backend.md`：核对 ACP 节内引用的 crate 行为描述（killpg/`is_alive`/进程组）在 2.2 下是否仍成立（已抽查：`process_group(0)` 与 `kill_process_group` 仍在 `acp_agent.rs:278/328`）。
- `docs/reference/acp-protocol-reference.md`：wire 契约未变，预期无需改；如核对发现 1.9.1 schema 有新增必填字段再补。
- `AGENTS.md` 文档索引：新增本文件行。
- `qa-quality-gates-followups.md`：R07/R08 状态更新（补测完成部分勾销/改写）。

## 勘误

1. **实际改动量优于评估**：09-22 清单预计 `src/acp/client.rs` 需 0-20 行（`Builder` 泛型参数 3→5 的编译迭代），实际 **0 行**——2.2 的泛型默认值由类型推断完全消化，稳定 v1 表面确如 release notes 所承诺无变化。
2. **测试形态微调**：计划 D5 原设「`PermissionManager` 经 e2e 驱动」，实施中确认 `cancel_all` 与 `resolve` 可共用同一 `perm` fake agent 模式（无需两套脚本），并额外复用了它做 `terminal/*` 的请求-响应往返；事件旁路统一走 `FAKE_EVENTS_FILE` 而非每功能一个文件。
3. **`terminal/kill` 的 wire 细节**：空 `TerminalExitStatus` 在响应里不是 `exitStatus:{}` 而是 `exitStatus` 整体省略（`result:{}`），测试断言按实测形态写（首版按猜测写曾转红一次）。
