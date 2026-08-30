# ACP 会话工作时长计时

> 状态：设计稿（2026-08-30）
> 触发条件：修改 `src/acp/turn_accumulator.rs`（turn 记账 / `WriterCmd`）、`src/acp/client.rs`（权限 pause 三点）、`src/acp/chat_persistence.rs`（`finalize_message` / `list_messages_page`）、`sessions` 时长列（migration `20260830_add_work_time.sql`）、`Sidebar` 会话行时长 badge、`ChatMessage` 耗时显示 任一项前**必读**
> 关联：`docs/dev/plans/2026-08-10-acp-session-reliability.md`（turn 门控与防抖 writer 的既有骨架，本计划就地扩展）、`docs/dev/plans/2026-08-18-permission-recycle-notice.md`（审批超时回收行为）、`docs/architecture/backend.md`（ACP 生命周期）、`docs/dev/performance-and-safety.md`（§P1 有界累积 / 写盘策略）
> 背景来源：产品需求——想知道「一个会话实际干了多少活」。现状核查确认主库**无任何时长字段**（`rg duration|elapsed|started_at|finished_at migrations/` 仅命中 auth token 注释），`chat_messages` 只有 `created_at`（= turn 起点），定稿走 `ON CONFLICT DO UPDATE` 不写结束时刻 → **历史时长不可追溯**，只能上线后起算。

## 术语

| 术语 | 含义 |
|---|---|
| turn | 一次用户 prompt 到该 prompt 结束（complete / error / cancel / 卡死兜底）的区间 |
| `wall_ms` | turn 墙钟时长（prompt 起止之差） |
| `wait_ms` | turn 内权限请求挂起（等真人审批）区间之和 |
| `work_ms` | `wall_ms - wait_ms`，即 agent 实际工作时间 |

## 口径（唯一真相源）

```
mark_prompt_active()  → turn 开始，重置 paused 累计与审批集合
权限请求进 pending    → 集合由空变非空：起算一段 wait
权限被 resolve/cancel → 集合清空：累加该段 wait 到 paused_ms
mark_prompt_idle()    → wall_ms = now - start
                        wait_ms  = paused_ms（若仍有未决审批，clamp 到 now）
                        work_ms += wall_ms - wait_ms
```

采集点全部收敛在既有钩子上，无需新增计时线程：

| 事件 | 锚点 |
|---|---|
| turn 起 | `src/ws/acp.rs:474` `mark_prompt_active()` |
| turn 止（正常/出错） | `src/ws/acp.rs:478` / `:488` `mark_prompt_idle()` |
| turn 止（卡死兜底） | `src/acp/reaper.rs:77` `mark_prompt_idle()` |
| 审批挂起起 | `src/acp/client.rs:363-367` `on_receive_request → pm.handle_request` |
| 审批挂起止（用户应答） | `src/acp/client.rs:587` `resolve_permission()` |
| 审批挂起止（取消） | `src/acp/client.rs:703-707` `cancel() → pm.cancel_all()` |

## 范围与优先级

| 级别 | 内容 | 预估 |
|---|---|---|
| **P0** | 会话级 `work_ms`/`wait_ms`/`turn_count`/`last_turn_at` 落库 + 消息级 `duration_ms`/`wait_ms`；Sidebar 会话行累计 badge；assistant 消息耗时 | 后端 0.5d + 前端 2h |
| **P0** | **顺带补缺口**：`shutdown()`/`disconnect()` 路径不 finalize 活跃 turn → 手动释放与后端退出时这段时长白丢。补一次 `mark_prompt_idle()` | 含上 |
| **P1** | 会话行 hover 拆分「工作 / 等待人工」；i18n（zh/en）；单测（pause 深度、exactly-once、空 turn、turn 外审批） | 2h |
| **P2** | 不做（见排除项） | — |

## 不纳入范围

- **人在场时长**（前端可见 / WS 连接区间）：需处理标签页隐藏、断网、多端同开去重，且本质是另一个产品问题。选 agent 口径的红利正是全部在后端连接任务上结算，与浏览器状态解耦。
- **日/周报表、按项目/agent 汇总**：需要按天明细表（`session_work_log`）支撑聚合，当前只有「这个会话跑了多久」的确证需求。见 D3 翻盘条件。
- **流式 turn 的前端实时跳动计时**：前端自算墙钟必然与后端 `work_ms`（含扣除）口径不一致，等于引入第二套真相。耗时数字统一在定稿后一次性出现。
- **tmux / pty 会话计时**：那两类没有 prompt turn 语义（只有 `last_activity` 与屏幕检测），口径不可比，不强行套。
- **历史数据回补**：`chat_messages` 无结束时刻，任何回补都是造假。老行 `duration_ms` NULL → 前端不显示。

## 设计决策

### D1 — 口径取「agent 工作时长（turn 累计）」
- **理由**：`mark_prompt_active`/`mark_prompt_idle` 已是 turn 边界的唯一收敛点（正常完成、出错、取消、reaper 兜底四条路径全覆盖，见上表），零新钩子；后端结算，进程回收/WS 断连/多端都不影响正确性。
- **否决项**：① 在场时长——复杂度高一档且需求未确证；② 两者都记——1.8 倍工作量，且第二口径的展示位置尚未确定。
- **翻盘条件**：若真实诉求变成「我在这个会话上花了几小时」（人因统计），则须并记在场时长，届时另立计划。

### D2 — 记账点放进 `TurnAccumulator`，不新建计时器模块
- **理由**：accumulator 已持有 turn 门控（`st.active`）与 `db` + `db_session_id`（`attach_persistence`）。时长与「哪些帧属于本 turn」是同一份状态，放同一处天然获得 **exactly-once**：`finalize_turn()` 在锁内做 `active→false` 的 CAS，只有赢得这次跃迁才发记账命令。
- **否决项**：① 独立 `TurnTimer` struct——与 accumulator 抢同一份 turn 生命周期，多一处必须保持同步的状态；② 前端计时——见 D1；③ reaper 扫描推算——30s tick 精度太粗且会把挂机算成工作。
- **翻盘条件**：若将来要计非 prompt 型活动（如 agent 自主后台任务），门控模型不再成立，需把计时器抽成独立实体。

### D3 — 会话级用写时增量列，不做读时聚合、不建明细表
- **理由**：会话列表是**轮询**接口。`SELECT SUM(duration_ms) GROUP BY session_id` 会随消息量增长退化为全表扫，且每次轮询都付一遍。写时增量读 O(1)，且增量点唯一（writer 循环），无重复计数路径。
- **否决项**：① 读时聚合（无冗余，但轮询成本不可接受）；② `session_work_log` 明细表（能支持报表，但当前无报表需求——见排除项）。
- **翻盘条件**：一旦要做日/周聚合，D3 的增量列不足以支撑（无日期维度），届时**必须**新增按天明细表，并把 `sessions` 列降级为缓存 + 提供重算脚本。

### D4 — 审批等待扣除，用「未决集合非空」而非布尔标志
- **理由**：agent 可并发发出多个 `session/request_permission`；布尔标志会被第一个 resolve 提前清零，把后续等待算成工作。用 `HashSet<String>` 记未决 id：集合非空即处于 wait，空→非空起算、非空→空累加。天然幂等（重复 insert/remove 无害），且 WS 重连重放 `pending_events()` 不会重复起算。
- **实现约束**：`PermissionManager` **零改动**——三个调用点全在 `client.rs`（见锚点表），审批语义不外溢。
- **否决项**：在 `PendingEntry` 里存 `since: Instant` 再由 `pending_events()` 反算——要改 PermissionManager 的数据结构并为计时目的扩接口，收益不成立。

### D5 — 定稿时仍有未决审批：把该段 wait 截到定稿时刻
- **场景**：用户点取消 / reaper 卡死兜底时，权限请求可能仍挂着 → `wall_ms` 含未累加的等待。若不处理，这段会被算成 `work_ms`（正是 D4 想消除的失真）。
- **做法**：`finalize` 时若集合非空，`wait_ms += now - 该段起算时刻`（结果恒 ≤ `wall_ms`，故 `work_ms` 不会为负）。
- **备选（否决）**：拒绝在无未决审批时定稿——会破坏 `mark_prompt_idle` 的幂等契约（现有注释明确「racing callers 都安全」）。

### D6 — 卡死兜底 turn 全额计入，不截断、不剔除
- **理由**：`PROMPT_STALE_SECS`（10 分钟无通知）定稿的 turn，其 `wall_ms` 确实混入了 agent 静默期。但截断阈值（「超过 X 分钟只算 X」）是任意的第二套口径，会让跨会话数字不可比。
- **缓解**：消息级保留 `stop_reason='InactivityTimeout'` 语义（`src/acp/reaper.rs:79` 已有），前端在该条耗时后标注异常态，把判断留给读者。
- **翻盘条件**：若实践中发现极少数卡死 turn 严重污染会话累计（例如占比 >30%），再考虑单 turn 上限 + 单列「异常静默」。

### D7 — 进程回收后恢复会话：累计不重置
- **理由**：`work_ms` 落在 `sessions` 行上，与 `AcpClient` 实例生命周期无关。idle 回收（5 分钟）→ restore 生成新 client → 新 turn 继续 `+=`。这是选「落库增量」的直接红利。

## 多实现行为差异（AGENTS §8）

| 差异 | 影响 | 兜底 |
|---|---|---|
| 各家 agent 的 `stop_reason` 取值/命名不一 | 记账不读 `stop_reason`，只依赖 `mark_prompt_idle` 收敛点 | 结构上免疫 |
| 部分实现 turn 结束不发 `PromptResponse`（已知：`reaper.rs:26-29` 注释） | 该 turn 靠 `PROMPT_STALE_SECS` 兜底定稿 | 计入，并按 D6 标注异常 |
| agent 在无 prompt 时发 `request_permission` | 无活跃 turn，pause 无处归属 | `begin_turn` 门控外直接 no-op（与 `fold()` 同样的门控），不产生负值 |
| `load_session` 历史重放不产生 prompt 起点 | 重放若计时会把 restore 一次算成几小时工作 | 重放从不调 `mark_prompt_active`（`client.rs:749-751` 注释），结构性排除 |
| 能力探针（probe）会话 | 探针不应写业务表 | 探针不 `attach_persistence` → sink 为空，记账命令发不出去即丢弃 |
| cancel 世代竞态（`prompt_generation`，`client.rs:85-87`） | 旧 turn 的兜底可能误定稿新 turn | 沿用现有 generation 守卫，记账随 `finalize_turn` 的 CAS 一起受保护 |

## 数据模型

`migrations/20260830_add_work_time.sql`：

```sql
ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER;   -- 该 turn 的 work_ms
ALTER TABLE chat_messages ADD COLUMN wait_ms INTEGER;       -- 该 turn 的 wait_ms
ALTER TABLE sessions ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN wait_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_turn_at TEXT;          -- RFC3339，NULL = 从无 turn
```

- 老行 `duration_ms`/`wait_ms` 为 NULL → 语义是「未知」，区别于 0（「确实 0 时长」）。前端 NULL 不渲染。
- **`sessions` 的 5 处 INSERT 语句无需改**（`api/sessions.rs:185/266/333/886/959`、`api/files.rs:1020/1241`）：新列有默认值。
- 会话删除时 `chat_messages` 级联删除，`sessions` 上的累计列随行消失，无残留。

## API 契约变更（纯新增，非破坏）

| 端点 | 新字段 |
|---|---|
| `GET /projects/{pid}/sessions`、`GET /sessions/archived` | `work_ms`、`wait_ms`、`turn_count`、`last_turn_at` |
| `GET /sessions/{id}/messages` | 每条 assistant 行 `durationMs`、`waitMs`（NULL 时缺省） |

`ChatMessageRow` 元组从 7 元扩到 9 元 —— 该别名在 `chat_persistence.rs:106/152` 与 `api/sessions.rs:687` 三处解构，**必须同步改**，否则编译期即报 arity 错误（好事，漏改不会静默）。

## 实施分期

| Phase | 产出 | 改动文件 | 依赖 |
|---|---|---|---|
| **1 后端记账** | migration；`TurnState` 加 `started: Instant` / `wait_paused_ms` / `wait_since` / `pending_perm: HashSet`；`begin_turn` 初始化；`begin_wait`/`end_wait`；`finalize_turn` 锁内算 `wall_ms`/`wait_ms` 并发 `WriterCmd::EndTurn { wall_ms, wait_ms, row_id }`（**取代现 `Finalize`**，空 turn 也要记账）；writer 循环做 `UPDATE sessions SET work_ms = work_ms + ? , wait_ms = wait_ms + ?, turn_count = turn_count + 1, last_turn_at = ?` + 有 row_id 才 flush/finalize | `migrations/`、`src/acp/turn_accumulator.rs`、`src/acp/chat_persistence.rs`（`finalize_message` 带 duration/wait） | — |
| **2 审批扣除 + 缺口** | `client.rs` 三处接 `begin_wait`/`end_wait`（D4 表）；`shutdown()`/`disconnect()` 补 `mark_prompt_idle()`（P0 缺口） | `src/acp/client.rs` | Phase 1 |
| **3 读路径** | `Session` 模型加 4 字段；`list_sessions`/`list_archived` 返回；`list_messages_page` SELECT + 元组 + JSON | `src/models/session.rs`、`src/api/sessions.rs`、`src/acp/chat_persistence.rs` | Phase 1 |
| **4 前端呈现** | 时长格式化函数（见下）；Sidebar 会话行 badge + hover 拆分；assistant 消息耗时 + 异常标注；i18n zh/en | `frontend/src/utils/formatTime.ts`、`components/Sidebar/ProjectCard.tsx`、`components/Chat/ChatMessage.tsx`、`locales/{zh,en}` | Phase 3 |

**格式化函数落点**：`frontend/src/utils/formatTime.ts` 现有两个函数都是**钟点**格式化（`formatHoverTime`），无 elapsed 时长格式化 → 新增 `formatElapsed(ms)`：`<60s → "42s"`、`<1h → "42m"`、`≥1h → "2h42m"`；NULL/undefined → `null`（调用方不渲染）。落此文件而非新文件（同族聚合，已有 `formatTime.test.ts`）。

> 顺手记一笔技术债（**本计划不动**，避免扩范围）：`utils/messageMarkdown.ts:50 formatTurnTime` 与 `utils/formatTime.ts:6 formatHoverTime` 是重复实现（同为钟点缩写，仅缺跨年分支）。

## 验收清单

后端
- [ ] `cargo test`：`finalize_turn` 恰好发一次 `EndTurn`（并发调用 `mark_prompt_idle` 两次 → `turn_count` 只 +1）
- [ ] `cargo test`：pause 深度——两个并发 pending 审批，只 resolve 第一个时 wait 不累加，全清才累加
- [ ] `cargo test`：定稿时仍有未决审批 → 该段截到定稿时刻（D5），`work_ms ≥ 0`
- [ ] `cargo test`：一帧未发的空 turn 仍 `turn_count += 1`
- [ ] `cargo test`：`begin_wait` 在无活跃 turn 时 no-op（不产生负值 / 不跨 turn 泄漏）
- [ ] `cargo test`：跨 restore 累计——同 session 两个 client 实例分别记一个 turn → `turn_count = 2`
- [ ] `cargo clippy --all-targets` / `cargo fmt --check` 零新增告警

前端
- [ ] `tsc --noEmit` 零新增错误；`pnpm vitest run` 全过（新增 `formatElapsed` 边界测：0 / 59s / 60s / 3599s / 3600s / null）
- [ ] Sidebar 会话行显示累计时长；`work_ms = 0` 的历史会话不显示占位
- [ ] 刷新后消息耗时仍在（读 DB，非内存）

边界与真机
- [ ] 发一个短 prompt → 消息行耗时 ≈ 实际等待秒数，`turn_count` +1
- [ ] 触发权限请求后放置 2 分钟再批准 → 会话 `wait_ms ≈ 120s`，`work_ms` 不含这段
- [ ] 权限请求**不批准**直到 reaper 30 分钟回收 → 该段算 wait 不算 work（且 system 告知消息照旧，见关联计划）
- [ ] 会话进程被 idle 回收后再打开继续对话 → 累计不清零
- [ ] 后端重启（`./dev.sh restart`）后进行中的 turn 不报错，累计保留
- [ ] 老会话（迁移前）打开：无耗时标注、累计从 0 起，不出现 `NaN`/`0s` 误导显示

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 写盘频率：每 turn 多一次 `UPDATE sessions` | turn 是低频事件（人工发起粒度），且已在防抖 writer 循环内串行；不新增写热点 |
| 记账与消息定稿耦合：`EndTurn` 丢一次 → 时长和行都错 | 单一命令携带两者（同一 CAS 门控），不存在只成功一半的路径；`row_id` 为 `Option` 兼容空 turn |
| 时钟源：`Instant` 不跨进程 | 只用 `Instant` 算差值（单调），落库的是**差值**与 RFC3339 时刻，不做跨重启推算 |
| 前端轮询把 `work_ms` 当实时值期待 | 明确语义：`work_ms` 只在 turn 结束刷新，进行中的 turn 不体现在会话累计（避免和流式口径打架，见排除项） |
| 多端同开同一会话（桌面 + 移动） | 记账全在后端单点，天然一致 |

## 文档闭环

- `CHANGELOG.md`：实施完成后加 `feat:`（会话/消息工作时长）
- `docs/architecture/backend.md`：ACP 生命周期补「turn 记账与 `sessions` 累计列」小节 + 多实现差异表（D4/D6/§8 表）
- `docs/reference/requirements.md`：登记该需求为已实现
- 本文件：Phase 推进后改状态；有偏差就地加「勘误」块
