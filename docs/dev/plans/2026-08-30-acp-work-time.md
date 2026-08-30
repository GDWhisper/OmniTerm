# ACP 会话工作时长计时

> 状态：已实施（2026-08-30，Phase 1-4 全部落地；侧栏呈现部分事后按设计决策回退，见 E9；偏差见文末「勘误」E1–E11）
> 触发条件：修改 `src/acp/turn_accumulator.rs`（turn 记账 / `WriterCmd`）、`src/acp/client.rs`（权限 pause 三点 + `turn_timing()`）、`src/acp/chat_persistence.rs`（`finalize_message` / `list_messages_page`）、`sessions` 时长列（migration `20260830_add_work_time.sql`）、`src/ws/acp.rs`（`prompt_done.duration`）、`ChatMessage` 耗时显示 任一项前**必读**（侧栏时长显示曾实施后回退，见 E9）
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
mark_prompt_active()  → turn 开始，wait_ms 归零 / wait_depth = 0 / started = now
权限请求进 pending    → wait_depth 0→1：起算一段 wait（wait_since = now）
权限被 resolve        → wait_depth 减到 0：累加该段到 wait_ms，wait_since = None
session cancel        → end_all_waits()：未闭合段截到此刻并归零计数
mark_prompt_idle()    → wall_ms = now - started
                        wait_ms += 未闭合段（若有，clamp 到 now）
                        wait_ms = min(wait_ms, wall_ms)
                        发 EndTurn{ work_ms = wall_ms - wait_ms, wait_ms, row_id }
```

采集点全部收敛在既有钩子上，无需新增计时线程：

| 事件 | 锚点 |
|---|---|
| turn 起 | `src/ws/acp.rs:481` `mark_prompt_active()` |
| turn 止（正常/出错） | `src/ws/acp.rs:485` / `:497` `mark_prompt_idle()` |
| turn 止（卡死兜底） | `src/acp/reaper.rs:77` `mark_prompt_idle()` |
| turn 止（进程释放/断连） | `src/acp/client.rs:1270` / `:1281`（`shutdown()` / `disconnect()`，见 P0 缺口） |
| 审批挂起起 | `src/acp/client.rs:375` / `:1094` `accumulator.begin_wait()`（两处：权限请求经两条分支到达累积器，`begin_wait` 自带 turn 门控，无活跃 turn 即 no-op） |
| 审批挂起止（用户应答） | `src/acp/client.rs:605-607` `resolve_permission()` → `end_wait()`（仅 `pm.resolve()` 返回 true 时） |
| 审批挂起止（取消） | `src/acp/client.rs:731` `cancel() → end_all_waits()`（批量出清，见 E2） |

## 范围与优先级

| 级别 | 内容 | 预估 |
|---|---|---|
| **P0** | 会话级 `work_ms`/`wait_ms`/`turn_count`/`last_turn_at` 落库 + 消息级 `duration_ms`/`wait_ms`；~~Sidebar 会话行累计 badge~~（已回退，见 E9）；assistant 消息耗时 | 后端 0.5d + 前端 2h |
| **P0** | **顺带补缺口**：`shutdown()`/`disconnect()` 路径不 finalize 活跃 turn → 手动释放与后端退出时这段时长白丢。补一次 `mark_prompt_idle()` | 含上 |
| **P1** | 会话行 hover 拆分「工作 / 等待人工」（改为挂消息耗时行 tooltip，见 E8）；i18n（zh/en）；单测（pause 深度、exactly-once、空 turn、turn 外审批） | 2h |
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
- **实施偏差**：`HashSet` 换成了 `wait_depth` 计数（E1）；收尾多一个 `end_all_waits()` 批量出清点（E2）。

### D5 — 定稿时仍有未决审批：把该段 wait 截到定稿时刻
- **场景**：用户点取消 / reaper 卡死兜底时，权限请求可能仍挂着 → `wall_ms` 含未累加的等待。若不处理，这段会被算成 `work_ms`（正是 D4 想消除的失真）。
- **做法**：`finalize` 时若集合非空，`wait_ms += now - 该段起算时刻`（结果恒 ≤ `wall_ms`，故 `work_ms` 不会为负）。
- **备选（否决）**：拒绝在无未决审批时定稿——会破坏 `mark_prompt_idle` 的幂等契约（现有注释明确「racing callers 都安全」）。

### D6 — 卡死兜底 turn 全额计入，不截断、不剔除
- **理由**：`PROMPT_STALE_SECS`（10 分钟无通知）定稿的 turn，其 `wall_ms` 确实混入了 agent 静默期。但截断阈值（「超过 X 分钟只算 X」）是任意的第二套口径，会让跨会话数字不可比。
- **缓解**：消息级保留 `stop_reason='InactivityTimeout'` 语义（`src/acp/reaper.rs:79` 已有），前端在该条耗时后标注异常态，把判断留给读者。
  - **未实施**：`stop_reason` 从不入库，刷新即丢，故异常态无从标注（见 E4）。
- **翻盘条件**：若实践中发现极少数卡死 turn 严重污染会话累计（例如占比 >30%），再考虑单 turn 上限 + 单列「异常静默」。

### D7 — 进程回收后恢复会话：累计不重置
- **理由**：`work_ms` 落在 `sessions` 行上，与 `AcpClient` 实例生命周期无关。idle 回收（5 分钟）→ restore 生成新 client → 新 turn 继续 `+=`。这是选「落库增量」的直接红利。

## 多实现行为差异（AGENTS §8）

| 差异 | 影响 | 兜底 |
|---|---|---|
| 各家 agent 的 `stop_reason` 取值/命名不一 | 记账不读 `stop_reason`，只依赖 `mark_prompt_idle` 收敛点 | 结构上免疫 |
| 部分实现 turn 结束不发 `PromptResponse`（已知：`reaper.rs:25-28` 注释） | 该 turn 靠 `PROMPT_STALE_SECS` 兜底定稿 | 全额计入（D6）；**异常态无法标注**，`stop_reason` 不入库（E4） |
| agent 内部的确认门不发 `session/request_permission`（实测 omp propose 4ms 本地返回 "Plan approved"，见 `docs/architecture/backend.md` §Multi-implementation） | 这类"等真人"发生在 agent 侧，后端看不见 → 人的思考时间算进 `work_ms` | 无兜底：口径明确为「**协议可见的**审批等待」，跨 agent 比较时须知道这条边界 |
| agent 在无 prompt 时发 `request_permission` | 无活跃 turn，pause 无处归属 | `begin_turn` 门控外直接 no-op（与 `fold()` 同样的门控），不产生负值 |
| `load_session` 历史重放不产生 prompt 起点 | 重放若计时会把 restore 一次算成几小时工作 | 重放从不调 `mark_prompt_active`（`client.rs:773-774` 注释），结构性排除 |
| 能力探针（probe）会话 | 探针不应写业务表 | 探针不 `attach_persistence` → sink 为空，记账命令发不出去即丢弃 |
| cancel 世代竞态（`prompt_generation`，`client.rs:91`） | 旧 turn 的兜底可能误定稿新 turn | 沿用现有 generation 守卫，记账随 `finalize_turn` 的 CAS 一起受保护 |

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
- **`sessions` 的 7 处生产 INSERT 站点无需改**（`api/sessions.rs:185/270/341/903/980`、`api/files.rs:1020/1241`，另有测试 seed）：新列有默认值。
- 会话删除时 `chat_messages` 级联删除（`session_id ... ON DELETE CASCADE`，声明于建表文件 `20260719_chat_messages.sql:7` 与实际生效的重建表 `20260818_chat_message_role_system.sql:7`，两处都有），`sessions` 上的累计列随行消失，无残留。

## API 契约变更（纯新增，非破坏）

| 端点 | 新字段 |
|---|---|
| `GET /projects/{pid}/sessions`、`GET /sessions/archived` | `work_ms`、`wait_ms`、`turn_count`、`last_turn_at` |
| `GET /sessions/{id}/messages` | 每条 assistant 行 `durationMs`、`waitMs`（未知时下发 `null`，非缺省键，见 E3） |
| WS `prompt_done` | `duration{work_ms, wait_ms}`（本 turn 未经累积器定稿时缺省，见 E5） |

`ChatMessageRow` 从 7 元组扩到 9 字段 —— 原计划按元组解构，三处调用点（`chat_persistence.rs:106/152`、`api/sessions.rs:687`）漏改即编译期报 arity 错误。**实际落地改成命名字段 + `sqlx::FromRow`**：`last_seq`/`duration_ms`/`wait_ms` 同型（都是 `Option<i64>`），元组里写颠倒编译器抓不住，只能靠人眼；命名字段把这个风险消掉，代价是新增字段不再有 arity 守卫。

## 实施分期

| Phase | 产出 | 改动文件 | 依赖 |
|---|---|---|---|
| **1 后端记账** | migration；`TurnState` 加 `started: Instant` / `wait_paused_ms` / `wait_since` / `pending_perm: HashSet`；`begin_turn` 初始化；`begin_wait`/`end_wait`；`finalize_turn` 锁内算 `wall_ms`/`wait_ms` 并发 `WriterCmd::EndTurn { wall_ms, wait_ms, row_id }`（**取代现 `Finalize`**，空 turn 也要记账）；writer 循环做 `UPDATE sessions SET work_ms = work_ms + ? , wait_ms = wait_ms + ?, turn_count = turn_count + 1, last_turn_at = ?` + 有 row_id 才 flush/finalize | `migrations/`、`src/acp/turn_accumulator.rs`、`src/acp/chat_persistence.rs`（`finalize_message` 带 duration/wait） | — |
| **2 审批扣除 + 缺口** | `client.rs` 三处接 `begin_wait`/`end_wait`（D4 表）；`shutdown()`/`disconnect()` 补 `mark_prompt_idle()`（P0 缺口） | `src/acp/client.rs` | Phase 1 |
| **3 读路径** | `Session` 模型加 4 字段；`list_sessions`/`list_archived` 返回；`list_messages_page` SELECT + 元组 + JSON | `src/models/session.rs`、`src/api/sessions.rs`、`src/acp/chat_persistence.rs` | Phase 1 |
| **4 前端呈现** | 时长格式化函数（见下）；~~Sidebar 会话行 badge + hover 拆分~~；assistant 消息耗时 + 异常标注；i18n zh/en **→ 实际形态见 E8，格式化函数见 E6，侧栏部分已回退见 E9，右缘对齐见 E10** | `frontend/src/utils/formatTime.ts`、~~`components/Sidebar/ProjectCard.tsx`~~（已撤出）、`components/Chat/ChatMessage.tsx`、`locales/{zh,en}` | Phase 3 |

**格式化函数落点**：`frontend/src/utils/formatTime.ts` 现有两个函数都是**钟点**格式化（`formatHoverTime`），无 elapsed 时长格式化 → 新增 `formatElapsed(ms)`：`<60s → "42s"`、`<1h → "42m"`、`≥1h → "2h42m"`；NULL/undefined → `null`（调用方不渲染）。落此文件而非新文件（同族聚合，已有 `formatTime.test.ts`）。（实际导出与档位见 E6。）

> 顺手记一笔技术债（**本计划不动**，避免扩范围）：`utils/messageMarkdown.ts:50 formatTurnTime` 与 `utils/formatTime.ts:6 formatHoverTime` 是重复实现（同为钟点缩写，仅缺跨年分支）。

## 验收清单

后端
- [x] `cargo test`：`finalize_turn` 恰好发一次 `EndTurn`（并发调用 `mark_prompt_idle` 两次 → `turn_count` 只 +1）— `repeated_finalize_turn_emits_exactly_one_end_turn`
- [x] `cargo test`：pause 深度——两个并发 pending 审批，只 resolve 第一个时 wait 不累加，全清才累加 — `concurrent_permits_hold_one_wait_segment_until_all_resolve`
- [x] `cargo test`：定稿时仍有未决审批 → 该段截到定稿时刻（D5），`work_ms ≥ 0` — `finalize_clips_an_open_wait_segment`
- [x] `cargo test`：一帧未发的空 turn 仍 `turn_count += 1` — `empty_turn_is_still_accounted`
- [x] `cargo test`：`begin_wait` 在无活跃 turn 时 no-op（不产生负值 / 不跨 turn 泄漏）— `wait_outside_an_active_turn_is_dropped`；另有 `end_all_waits_closes_an_open_segment_immediately` 覆盖 cancel 路径
- [x] `cargo test`：跨 restore 累计——同 session 两个 client 实例分别记一个 turn → `turn_count = 2` — `accumulate_turn_increments_across_clients`（落在 `chat_persistence.rs`，直接验增量 SQL）
- [x] `cargo clippy --all-targets` / `cargo fmt --check` 零新增告警

前端
- [x] `tsc -b`（**非** `tsc --noEmit`——根 tsconfig 是 references 空壳，裸 `--noEmit` 不检查任何文件）零新增错误；`pnpm vitest run` 全过（新增 `formatWorkDuration` 边界测：999ms / 42s / 162s / 180s / 1h / null + en 字形 + 四舍五入）
- [x] ~~Sidebar 会话行显示累计时长~~（**已随 E9 回退**，代码不在此功能上）— 回退前的真机证据（headless 浏览器 + dev :9778）：有 turn 的行出 badge `1S` + tooltip「工作 1s · 等待人工 0s · 共 1 轮」，同列三条 `work_ms=0` 的老会话无 badge 无占位
- [x] 刷新后消息耗时仍在（读 DB，非内存）— 该会话处于 released 态（「此会话已结束」+ 恢复按钮），全新页面加载仍显示「已工作 1秒」，值只可能来自 `GET /sessions/{id}/messages`
- [x] 真机回归抓出 E6 的 0/亚秒合档缺陷（`wait_ms=0` 被报成「等待人工 <1s」），已修并补测

边界与真机
- [x] 发一个短 prompt → 消息行耗时 ≈ 实际等待秒数，`turn_count` +1 — dev 库一条真实 turn：`sessions.work_ms=1414 / turn_count=1`、`chat_messages.duration_ms=1414`（问候回复，秒级吻合）
- [ ] 触发权限请求后放置 2 分钟再批准 → 会话 `wait_ms ≈ 120s`，`work_ms` 不含这段（**未跑**：需真发一次 prompt 并挂起审批）
- [ ] 权限请求**不批准**直到 reaper 30 分钟回收 → 该段算 wait 不算 work（且 system 告知消息照旧，见关联计划）（**未跑**：同上，且需 30 分钟窗口）
- [ ] 会话进程被 idle 回收后再打开继续对话 → 累计不清零（**未跑**：需活跃 agent 会话；增量 SQL 本身有 `accumulate_turn_increments_across_clients` 覆盖）
- [ ] 后端重启（`./dev.sh restart`）后进行中的 turn 不报错，累计保留（**未跑**：重启会连带杀掉开发环境里在跑的终端会话）
- [x] 老会话（迁移前）打开：无耗时标注、累计从 0 起，不出现 `NaN`/`0s` 误导显示 — `durationMs=null` 的行整行不渲染（API 实测该键下发 `null`，见 E3）；回退前另测得 `work_ms=0` 的会话侧栏无 badge

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 写盘频率：每 turn 多一次 `UPDATE sessions` | turn 是低频事件（人工发起粒度），且已在防抖 writer 循环内串行；不新增写热点 |
| 记账与消息定稿耦合：`EndTurn` 丢一次 → 时长和行都错 | 单一命令携带两者（同一 CAS 门控），不存在只成功一半的路径；`row_id` 为 `Option` 兼容空 turn |
| 时钟源：`Instant` 不跨进程 | 只用 `Instant` 算差值（单调），落库的是**差值**与 RFC3339 时刻，不做跨重启推算 |
| 前端轮询把 `work_ms` 当实时值期待 | 明确语义：`work_ms` 只在 turn 结束刷新，进行中的 turn 不体现在会话累计（避免和流式口径打架，见排除项） |
| 多端同开同一会话（桌面 + 移动） | 记账全在后端单点，天然一致 |

## 文档闭环

- [x] `CHANGELOG.md`：实施完成后加 `feat:`（会话/消息工作时长）
- [x] `docs/architecture/backend.md`：ACP 生命周期补「turn 记账与 `sessions` 累计列」小节 + 多实现差异表（D4/D6/§8 表）
- [x] `docs/reference/requirements.md`：登记该需求为已实现
- [x] 本文件：Phase 推进后改状态；有偏差就地加「勘误」块

## 勘误（实施后）

### E1 — D4 的未决集合改为深度计数 `wait_depth: u32`（`turn_accumulator.rs:169`）

计划要求用 `HashSet<String>` 记未决审批 id。**实现做不到**：`client.rs` 拿得到审批 id 的唯一时机在 `on_receive_request` 的响应构造阶段，而该阶段的 `Responder` 受 `IntoHandled` 约束——要取出 id 就得改 `PermissionManager` 的对外签名，正是 D4「`PermissionManager` 零改动」的实现约束要排除的。深度计数达成同一语义：`0→>0` 起算、`>0→0` 累加（`turn_accumulator.rs:422/439-440`），幂等性与 HashSet 等价。**代价**：`end_wait` 依赖调用方不错配——`resolve_permission` 只在 `pm.resolve()` 返回 true 时才 `end_wait`（`client.rs:605-607`），否则其他连接已应答过的重复回包会让计数向下漂移。不变式 `wait_since.is_some() == wait_depth > 0` 由 `saturating_sub` 与 `finalize`/`end_all_waits` 的归零共同守住。

### E2 — 未决审批全部收尾多一个调用点：`cancel()` → `end_all_waits()`（`client.rs:731`）

D4 表只列了「审批挂起止（取消）」= `pm.cancel_all()`，按计划接 `end_wait` 即可；但 `cancel_all()` 是批量出清，逐个 `end_wait` 要 N 次且中途失败会留悬段。改成单个 `end_all_waits()` 一次性把未闭合的等待段截到当前时刻并归零计数。新增测 `end_all_waits_closes_an_open_segment_immediately` 覆盖。

### E3 — API 契约：`durationMs`/`waitMs` **恒下发**，未知时为 `null`，不是「缺省」

`api/sessions.rs:713-714` 直接 `json!` 两键，无 `skip_serializing_if`。前端 `formatWorkDuration` 接受 `null | undefined` 两者，行为等价（都不渲染），但**写契约时别说「缺省」**——`'durationMs' in msg` 这类判断会失效。

### E4 — D6 的异常标注未实施：`stop_reason` 根本不入库

D6 的缓解手段是「消息级保留 `stop_reason='InactivityTimeout'` 语义，前端标注异常态」。核查后：`stop_reason` 只随 `prompt_done` 帧广播，`chat_messages` 无对应列（只有 `status='complete'`），刷新后信息即丢失。**本次未加该列**——为一条极低频的展示加分支扩 `ChatMessageRow` 元组 + 新增 migration，收益不成立。后果：卡死兜底 turn 的耗时无法与正常 turn 区分，前端无标注。翻盘条件照旧（占比 >30% 时另立计划），届时须同时补 `stop_reason` 落库。

### E5 — 新增 `prompt_done.duration{work_ms, wait_ms}`，超出 Phase 4 文件清单

计划把消息耗时完全挂在「hydrate 读 DB」上，实测会退化成「刷新后才出现」。沿用 2026-08-10 计划 `prompt_done.row_id` 的先例：定稿时结算的 `TurnTiming` 经 `AcpClient::turn_timing()`（`client.rs:577`，轻量访问器，不走 `turn_snapshot()`）随帧下发，前端立刻标注。值存活到下一次 `begin_turn`，故定稿后仍可读。跨通道只传**已结算**的 `work_ms`/`wait_ms`（clamp 在 `finalize_turn` 锁内做完），接收方无需再减、不存在下溢路径。

### E6 — 格式化函数不是一个而是三个，且多两档 `0s` / `<1s`

Phase 4 只写了 `formatElapsed`。落地拆成三个，因两个展示位的物理约束不同：
- `formatElapsed(ms)`（**已随 E9 回退删除**）：侧栏像素 badge 用的紧凑记号，**四档**（计划只写三档）→ `0s`/`<1s`/`42s`/`42m`/`2h42m`。`<1s` 档是补的（亚秒显示 `0s` 会把「干了一小会儿」说成「瞬时干完」），但补的时候把 0 一起吞进了 `<1s` —— 真机回归才发现侧栏 tooltip 对 `wait_ms = 0` 的会话报「等待人工 <1s」，凭空造出一段从没发生过的等待。**0 = 该活动没发生，亚秒 = 发生了但不足一秒，两档必须分开**；`formatWorkDuration` 同规则。之所以单测没拦住：那条用例直接断言了 `formatElapsed(0) === '<1s'`，把 bug 写成了期望值。
- `formatWorkDuration(ms, locale)`：消息正文用的口语记号（**唯一存活者**），单位字形由 `Intl.NumberFormat(locale, {style:'unit', unitDisplay:'narrow'})` 出（zh → `2分钟42秒`，en → `2m42s`），**不在 i18n 文案里硬编码「分/秒」**（见 AGENTS 禁硬编码）。
- `formatSessionWork(ms)`（**已随 E9 回退删除**）：侧栏薄封装（`ms ? … : null`），`work_ms` 为 0/未定义时整格不渲染。

### E7 — 归档会话行也曾展示累计时长（**已随 E9 回退**）

计划只写「Sidebar 会话行 badge」。`ArchivedSessionsSection.tsx` 当时同样接了 `formatSessionWork`——理由是归档视图正是「这个会话干了多少活」最常被回看的地方，缺它会让归档行的信息密度明显低于活动行。这条推断没成立：两处一起被 E9 回退。

### E8 — 消息级呈现形态按设计确认改版（推翻 Phase 4 的「顶部耗时 + 异常标注」）

设计师确认后的最终形态，与 §实施分期 Phase 4 那行的描述不同：

| 项 | 计划 | 实际 |
|---|---|---|
| 位置 | 标签行 chip（正文上方） | **hover 动作栏同一行的右端**（先落地为动作栏下方独立行，再按 E11 并入同行），右缘贴合气泡（做法见 E10） |
| 文案 | 紧凑记号 | 口语整句「已工作 2分钟42秒」/ "Worked 2m42s" |
| 等待人工 | 与工时并列展示 | **退到 tooltip**（进正文会让元信息占两行）；移动端无 hover → 按设计确认**放弃**该信息于移动端呈现 |
| 流式进行中 | 未明确 | **无占位、不计时**——只呈现最终值。前端自算墙钟必与后端 `work_ms`（含扣除）口径不一致，等于第二套真相（同排除项理由） |

位置稳定性依据：`.chat-msg-actions` 只切 `opacity`（常驻占位），故无论 hover 与否，该行的宽度与耗时文字的位置都不变。视觉档位沿用 ui-style-guide 元信息规格（`0.769em` / `--text-faint` / `READER_FONT` / `tabular-nums`）。

### E9 — 侧栏累计时长整体回退（Phase 4 的前端一半白做）

会话行 badge + 归档行拼接 + i18n `sidebar.workTimeTooltip` + 两个 formatter（`formatElapsed` / `formatSessionWork`）全部撤除，侧栏字节级回到功能上线前（`git show <原提交> -- <两文件> | git apply -R --3way`，再删孤儿 formatter 与文案键，不留死代码）。

回退理由（设计判断，非缺陷）：① 列表行的信息位属于**状态与名称**，时长挤进去是噪声；② `work_ms` 只在 turn 定稿时增长，列表 3s 轮询里它长时间不动，读起来像「坏掉的假数字」——用户期待的是实时进度，而该列的语义根本不是进度。

**保留不动的部分**：`sessions` 的 4 个累计列与 migration 不回退（撤 migration 属破坏性操作，`list_sessions` 契约也已下发这些键），消息级耗时不依赖它们；`frontend/src/api/client.ts` 的 `Session` 类型字段同理保留（API 契约镜像）。结论：这批列**当前无 UI 消费者**，作写时账目留存，将来接展示零成本。

教训：「数据算得出来」不等于「该占一个展示位」。呈现位的取舍属设计判断，前端应先拿到确认再落笔——本可省掉 3 个文件的返工。

### E10 — 耗时行右缘只能实测，CSS 表达不了「贴气泡右缘」

气泡是内容宽度（`align-self:flex-start` + `max-width:85%`），耗时行是它的**兄弟节点**——`flex-end` / `stretch` 对齐的是父容器（消息列）右缘，不是气泡右缘，实测 `footRight 795.3` vs `bubbleRight 721.2`，甩出 74px。做法：`useLayoutEffect` 量最后一个 `[data-chat-body]` 的 `offsetWidth`，用 `ResizeObserver` 跟随正文重排（图片/表格延后撑宽、响应式换行），行 `width` 设成实测值、`maxWidth` 复用与气泡同一个 `BUBBLE_MAX_WIDTH` 常量（两处百分比各写各的必然错开）。修完 `footRight 721.0` vs `bubbleRight 721.2`，亚像素。

两个坑：
- `ResizeObserver` 每次 `observe()` 先报一轮 → `setMetaWidth` 必须「同值不 setState」，否则 setState→渲染→observer 回绕成无限循环。
- 改完布局 effect 后 Fast Refresh **不会**重新挂载带新 hook 的组件，headless 浏览器里量到的仍是旧布局；必须 `location.reload()` 再量（这次差点把「已修好」报成没修好）。

翻盘条件：若气泡改成占满可用宽度、或耗时行挪进气泡内部成为子节点，这段测量即可删除（届时纯 CSS `text-align:right` 就够）。

### E11 — 耗时并入动作栏同一行，放不下才换行

设计追加要求：不独占一行，而是与 hover 动作栏同行（动作栏靠左、耗时靠右），行宽不够时才另起一行。做法是把两者装进同一个 `flex-wrap` 行容器（`.chat-meta-row`），耗时 `margin-left:auto` 顶到行右缘——**同一套实测宽度下，同行与换行的右缘都是气泡右缘**，E10 的约束自动继承，不需要为换行态另写逻辑。

两个必须显式处理的点：
- 动作栏 `flex-shrink: 0`：按钮是 inline-block，被压缩时会自己堆成多行（比耗时换行更糟），所以「放不下」必须永远落在耗时这一侧。
- 行容器按 `workText || visibleActions.length` 条件渲染：`MessageActionBar` 无动作时返回 `null`，无条件渲染会留一个空 div，被列 `gap: 6` 撑成凭空多出的 6px。

真机实测（dev :9778，三条真实消息）：气泡宽 445/478/519px 时耗时与动作栏同行（两者 top 相差 1.2–1.4px），行右缘 721.0/754.0/795.0 vs 气泡右缘 721.2/754.4/795.3；把行宽压到 110px 触发换行，耗时落到第二行且右缘仍等行右缘（386 = 386）。
