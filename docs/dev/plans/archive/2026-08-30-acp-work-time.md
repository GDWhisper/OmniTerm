# ACP 会话工作时长计时

> 状态：已实施（2026-08-30，Phase 1-4 全部落地；侧栏呈现部分事后按设计决策回退，见 E9；流式实时计时为后续翻盘，见 E12；tps 估算与元信息行对齐切换见 E13；输出速度独立观测与工具耗时见 E14；三项读数缺陷修复见 E15；解码窗口翻盘见 E17；工具归因口径两轮修订见 E18–E19；tps 分母翻盘白名单见 E20；迟到帧收敛与顶替定稿见 E21；流式元信息行固定单行见 E22；**计算整体迁后端、前端只显示（翻盘 E13/E14「仍不入库」）见 E23**；**读数文案去掉「约/估算」前缀、诚实口径收进 hover 见 E24**；**定稿主段改「结束于」见 E25**；**实时读数收敛到最后一条 assistant 气泡底部见 E26**；偏差见文末「勘误」E1–E26）
> 触发条件：修改 `src/acp/turn_accumulator.rs`（turn 记账 / 速率与工具估算 / `WriterCmd`）、`src/acp/client.rs`（权限 pause 三点 + `turn_timing()` / `live_turn_stats()`）、`src/acp/chat_persistence.rs`（`finalize_message` / `list_messages_page`）、`chat_messages` 读数列（migration `20261015_add_turn_estimates.sql`）、`sessions` 时长列（migration `20260830_add_work_time.sql`）、`src/ws/acp.rs`（`prompt_done.duration` / `turn_stats` 推送）、`ChatMessage` 耗时显示、`frontend/src/utils/turnStats.ts`（推送读数缓存）与 `ChatMessage.tsx` 的读数渲染 任一项前**必读**（侧栏时长显示曾实施后回退，见 E9；本地估算模块 `turnClock.ts` 已随 E23 删除）
> 关联：`docs/dev/plans/2026-08-10-acp-session-reliability.md`（turn 门控与防抖 writer 的既有骨架，本计划就地扩展）、`docs/dev/plans/2026-08-18-permission-recycle-notice.md`（审批超时回收行为）、`docs/architecture/backend.md`（ACP 生命周期）、`docs/dev/performance-and-safety.md`（§P1 有界累积 / 写盘策略）
> 背景来源：产品需求——想知道「一个会话实际干了多少活」。现状核查确认主库**无任何时长字段**（`rg duration|elapsed|started_at|finished_at migrations/` 仅命中 auth token 注释），`chat_messages` 只有 `created_at`（实为首次 flush 建行时刻，晚于 turn 起点，见 E12），定稿走 `ON CONFLICT DO UPDATE` 不写结束时刻 → **历史时长不可追溯**，只能上线后起算。

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
- ~~**流式 turn 的前端实时跳动计时**~~ → **已翻盘实施，见 E12**。原否决理由（前端自算墙钟与后端 `work_ms` 口径不一致 = 第二套真相）当时成立，故记录在此：实施后靠「审批挂起冻表 + 同槽位被结算值取代 + 文案标注估算」三条约束把口径偏差压到亚秒级。
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

### E12 — 流式实时计时落地（**翻盘「不纳入范围」第 3 条与 E8 的「定稿后一次性出现」**）

用户追加要求：运行中也在 assistant 气泡底部显示计时器，且不得与乱码特效（`ThinkingIndicator`）干扰重叠。口径边界与实现约束：

- **只渲染、不入库、不参与同步**：本地读数走 `frontend/src/utils/turnClock.ts`（模块级有界表，`MAX_TRACKED_TURNS = 16` 最旧淘汰，守住 AGENTS §P1），后端 `work_ms` 仍是唯一真相源；定稿瞬间同一槽位被结算值取代。文案「工作中」vs「已工作」、色板 `--text-muted` vs `--text-faint`、tooltip 三处标注估算性质，避免读成结算值。
- **跳动不进 React state**：`ChatMessageView` 靠 memo + message 引用稳定跳过重渲染，每秒 setState 会把整列重画一遍。`LiveWorkElapsed` 用 `setInterval(1000)` 直写 `textContent`（与 `ThinkingIndicator` 的 rAF 同手法，但秒级读数不必逐帧）。渲染门控只用 per-turn 布尔 `isLive`，不在渲染期读外部时钟。
- **审批挂起冻表**：镜像后端 `work_ms = wall_ms − wait_ms`，`setPermission` / `removePermission` / `reconcilePermissions` 按「未决队列非空」暂停与恢复（多个并发审批只 resolve 一个仍算挂着，对齐 `wait_depth`，见 E1）。无在建 turn 时 `setTurnWaiting` 自身 no-op。
- **停表路径必须穷举**：`markDone` / `markError` / `markEnded` / `reset` 四类，漏一条就在气泡上留下一个永不落定的数字；`reset`（会话状态整条抹掉）尤其容易忘，`chatStore.test.ts` 的 `turnClock 接线` describe 逐条守住。
- **E11 的行渲染门控扩到 `workText || isLive || visibleActions.length`**：`messageActions.ts` 五个动作的 `visible` 全部硬排 streaming，流式期 `visibleActions` 为空，不加 `isLive` 就没有行容器，计时器无处可放。量宽 effect 同条件，否则流式期正文增长时不跟量。
- **锚点真相修正**：重连/刷新接回一个仍在跑的 turn 时，锚点取末尾 streaming 行的 `createdAt` 与此刻的较早者。注意 `created_at` **不是 turn 起点**，而是后端首次防抖 flush 建行的时刻——所以中途接回的读数偏小，这是可接受的保守偏差（宁可少报不虚报），不要误当成精确对齐。表里也没有 turn 起点可用：WS 断连期间后端的 `wait_depth` 变化前端收不到，跨断连的扣除段本就补不回来。
- **prompt 已发、气泡未生**（agent 首帧之前）：按用户确认只显乱码行、不加计时器——没有气泡就没有「气泡底部」这个位置。

真机实测（dev :9778，`Pi ACP_0830-1527` 会话恢复后连跑两 turn）：首帧前 `.chat-meta-row` 保持 5 条（无新行），气泡出现后第 6 条只含 `工作中 N秒` 且每秒续跳（3→23、9→48 两轮观测）；乱码流同时正常涨档（16→24→36 字符），两者 `getBoundingClientRect` 恒不交叠，消息列 `scrollWidth − clientWidth = 0`（无横向溢出）；定稿当场替换为 `已工作 49秒`（最后一次实时读数 48秒，偏差亚秒级），动作栏回归。测试后已点「释放智能体进程」把会话恢复成 DEAD。

### E13 — 追加 tps（token/s）估算与元信息行对齐切换（2026-09-10）

用户在 E12 基础上追加两点，均落在同一 `chat.meta-row` 槽位：

- **tps 显示**：流式期显实时读数、定稿后显最终值。ACP 侧核查确认**无任何原生 output token 字段**——`usage_update` 只有 `used`/`size`/`cost`（上下文配额，见 `docs/reference/acp-protocol-reference.md` §6.7），后端 `src/acp/` 无 token 记账，前端 `setUsage` 也只喂 `ConfigToolbar` 的配额条。故按用户拍板用估算：`tps = 本 turn 输出字符数 / 4 / 工作时长(秒)`。
- **口径复用**：工作时长直接取 `utils/turnClock.ts` 的 `turnElapsedMs`（已扣审批挂起），不另造第二套。新增 `addOutputChars`（在 `useAcpChat.ts` 的 `dispatchFrame` 对 `appendText`/`appendThought` 两条 live 路径累加，历史重放与 seq 去重丢弃的帧不计）、`turnTps`（实时）、`computeTps`（纯函数，边界 0 字符 / 0 时长 → `null`）。
- **最终值保留**：`endTurn` 删条目前先把 tps 快照进有界表 `finalTpsBySession`（同 `MAX_TRACKED_TURNS` 淘汰），`finalTps(sessionId)` 读取。0 输出定稿把快照**清空**（不是保留旧值——快照按会话存，保留会错配到新消息行）。
- **呈现**：界面只出数字（`12.3 t/s`），「估算」只写进 tooltip（`chat.msg.tpsTip`）。定稿值只挂在最后一条 assistant 消息（`isLastAssistant`），避免旧消息重渲染时读到新 turn 的快照。
- **对齐切换**：`CHAT_META_TEXT_STYLE` 移除恒定的 `marginLeft:auto`，拆出 `CHAT_META_RIGHT` 只加在结算值上。流式期动作栏恒空（五动作硬排 streaming）→ 实时读数靠左；定稿后动作栏回归左侧、结算值顶右。左右只在定稿瞬间变一次，流式全程停同侧。
- **仍不入库**：tps 只渲染，刷新即失（历史行无字符数可算），与 E12 的本地估算同性质。**（2026-10-15 翻盘，见 E23：读数改为后端结算并落库，刷新后常驻。）**

### E14 — 输出速度独立观测与工具耗时（2026-09-18）

- 工作时长仍包含工具执行，只扣协议可见审批；后端结算与持久化不变。
- 本地 tps 改为观测字符数 ÷ 4 ÷（观测工作时长 − 可识别纯工具并集）。工具状态只有显式 `in_progress` / `running` 才起表，缺省更新保持状态，`pending` / 未知状态不证明正在执行。并行工具取并集，不逐项相加；在工作时间坐标上测量，审批重叠不会重复扣除。
- 工具并集未闭合时出现正文/思考，整段保守计回生成时间，直至所有活跃工具结束；因此仍非模型纯生成性能指标。工具耗时展示仍包括这类并行生成区间。
- 重连/快照重新开本地观测窗，旧输出不进新分子、离线时间不进新分母；快照卡片缺省 `running` 是显示兜底，不是执行证据，仅恢复明确 `in_progress` 工具。重连前工具累计未知，不虚构整轮耗时。
- 消息底部新增「工具约 N秒」，速度显式「估算 N t/s」，流式/定稿同行呈现；0/未知工具不显示。两项仍不入库，刷新不回补，最终快照只挂最后 assistant 行。新 turn 清空旧快照避免错配。
- 活跃工具限 256 个、每 ID 限 1024 UTF-16 单元；超限清理 ID 并令本窗口估算失效，下一轮/重连重采样。会话/最终快照仍限 16 条。测试覆盖并发、审批、输出重叠、缺省状态、重连与限界。

### E15 — 三项读数缺陷修复：工具时长跨重连保留、tps 工具期封口、元信息行防拆行（2026-09-21）

用户报告同一 `chat.meta-row` 槽位三个现象：① 工具几乎没有统计；② 单位换行不跟随数字；③ 工具调用期间 tok/s 逐渐跌落，要求「工具调用期间暂停时间直到下次流式吐字」。三项均为前端本地估算缺陷，后端结算与持久化零改动。

**根因（按现象）**

| 现象 | 根因 | 位置 |
|---|---|---|
| ① 工具时长≈0 | `beginTurn` 新建条目 + `resumeTurnClock` 把 `toolMs`/`pureToolMs` 归零。移动端关一次浏览器必触发一次重连，整轮已观测工具时长被抹平；工具跨越重连点时，重连前已执行的那段也永久测不到（离线帧只以 cooked 快照形态回来，`completed` 不重放） | `turnClock.ts` `resumeTurnClock` / `chatStore.ts` `beginPrompt` |
| ② 单位换行 | 读数是**单个文本节点**，`CHAT_META_TEXT_STYLE` 为 `whiteSpace:normal` + `overflowWrap:anywhere`。中文无空格 → 浏览器在数字与单位之间断行。实测断点：「5分钟」/「33秒」、「工具约」/「<1秒」、「估算」/「62.1 t/s」 | `ChatMessage.tsx` `CHAT_META_TEXT_STYLE` / `LiveWorkElapsed` |
| ③ tps 跌落 | `generationElapsedMs` 只扣「工具窗口内零输出」的工具段（`turn.toolHasOutput ? 0 : openToolMs`）。工具执行期间一旦流出 thought/text，整段开放并集回到分母，分母随工具执行持续增长 → 观感「模型越跑越慢」 | `turnClock.ts` `generationElapsedMs` |

**修复**

- **跨重连保留工具段**：`resumeTurnClock` 不再清零 `toolMs`/`pureToolMs`，只丢弃仍开放的并集（离线段无法归因给工具还是别的，维持 E14「不虚构」口径）。新增 `pureToolMsAtObs` 基线：`generationElapsedMs = (工作时长 − observationWorkMs) − (pureToolMs − pureToolMsAtObs + 开放并集内可扣段)`，保证「分子分母同窗口」的同时旧工具段不被重复扣、也不会把分母扣成负数。
- **工具期封口（对应用户要求的「暂停到下次流式吐字」）**：工具并集内**首次**出现输出时，把「工具起点 → 该输出到达时刻」封口为纯工具时间（`toolPureOpenMs`），生成计时钟到此暂停；封口之后仍在工具内的区间重新走时（那段确实是模型在产出）。整段零输出的工具窗口仍全额计工具时间。展示口径 `turnToolElapsedMs` 仍是完整并集（含封口后的执行段），封口只影响分母。
- **元信息行拆段**：工作 / 工具 / 速度三个读数各自一个 `white-space:nowrap` span，容器沿用既有 `flex-wrap` 承接段间换行。实时路径拆段是 DOM 结构而非文本，一次建好、每 tick 只改 `textContent`，不新增分配、不引入每秒 setState（E12 约束不变）；定稿路径同步拆段。`CHAT_META_RIGHT` 的 `textAlign` 改 `justifyContent`（拆段后 textAlign 对 flex 子项无效）。

**测试**

- `turnClock.test.ts`：原 `restores the entire open tool overlap to generation when prose arrives` 把缺陷断言成了期望值（与 E6 的 `<1s` 同型教训），改写为 `pauses the generation clock at the first prose inside a tool union, then resumes`；新增 `keeps tool time observed before a reconnect instead of wiping it` 覆盖跨重连保留与基线不重复扣。
- 新增 `ChatMessage.metarow.test.tsx`：jsdom 不做布局，故不断言真实换行结果，而是断言「每个读数各自一个 nowrap 段、段内 label 与 value 不分离」这一结构不变量（换行只发生在段间的充分条件），流式路径用冻结时钟拿确定值。
- **审批挂起冻表专项**（用户追加提出「等用户回应期间 t/s 也该暂停」）：该行为自 E12 起就已成立——分母全部由 `workElapsedMs` 派生，而它在挂起期间冻结，故 tps 与工具并集跨度一起不动；本次改动（封口逻辑）理论上可能破坏它，补 3 条回归钉住：`turnClock.test.ts` 的「挂起期间读数一动不动 + 解除后从冻结点续走」与「挂起与工具并集同时冻住、挂起段不计入工具也不白送生成时间」，`chatStore.test.ts` 的 store 级 tps 冻表（帧 → setPermission → setTurnWaiting → turnClock 全链路）。

**仍未解决（已知限制，翻盘条件不变）**

- 对**从不发显式 `in_progress`/`running`** 的 agent（实测某实现连发 36 个无 status 的 `tool_call_update` 后跟一个 `completed`），工具时长仍记 0。协议 §8.3 规定 status 缺省为 `pending`，现行保守 rule 有协议依据；若要把这类实现计入，须先确证「无 status 的 content 更新 == 执行中」，再定兜底口径（本次未动）。
- 仍开放的工具并集在重连时丢弃，工具跨越重连点的已执行段不可恢复；要精确计量须让后端给转发的 `session_update` 帧带到达时刻并透出到快照卡片，属协议扩展，本次未做。
- 三项读数仍不入库、刷新即失（E13/E14 口径不变）。

### E16 — `EndTurn` 可靠投递：定稿命令不再与可丢的 `Flush` 信号共用通道（2026-09-21）

来源：用户要求对计时改动做安全/性能复查。复查发现 Phase 1 引入的 `WriterCmd::EndTurn` 与 `Flush` 共用 `WRITER_CHANNEL_CAPACITY=256` 有界通道且统一 `try_send`。`Flush` 可丢有防抖合并语义兜底（`send_cmd` 注释已论证），但 `EndTurn` 是**非幂等的定稿跃迁**：信号通道被高帧率折叠塞满时（writer 卡在一次 `flush_once` 的 SQLite 写内；模块文档自述长 turn「tens of thousands」帧，万级帧率下约 25ms 停滞即可填满 256 深度）`try_send` 静默失败——该 turn 的会话级记账（`turn_count`/`work_ms`/`wait_ms`）与消息行定稿（`finalize_message`，行永久停在 `streaming`）同时丢失且无日志，而 UI 仍显示耗时（`turn_timing` 读发送前就写好的 `last_timing`），DB 与界面静默分叉。`shutdown`/`disconnect`/cancel 兜底/reaper 四条定稿路径全部经此投递，无第二条兜底路径。

修复（`src/acp/turn_accumulator.rs`）：

- `Sink` 增 `end_tx`（`mpsc::unbounded_channel`），`EndTurn` 经 `send_end_turn` 可靠投递；`send` 只在 writer 已消失（sink 被替换 / client 释放）时失败并记 WARN，不再静默。无界符合 §P1：条目速率 = turn 速率（人工发起），writer 存活时积压量 ≈ 停滞时长 ÷ turn 间隔 × 百字节级载荷；writer 死亡则通道关闭。
- writer 侧 `next_cmd` 用 `tokio::select!` + `biased` 优先消费 EndTurn 通道：两条通道 sender 同生命周期（同一个 `Sink`），若非优先，先关闭的 `cmd_rx` 返回 `None` 会抢先 break，把缓冲里的 EndTurn 丢在死通道。
- `EndTurn` 分支顺手 `try_recv` 清空已排队的 `Flush` 信号：它们要的「写一次」由紧随的 `flush_once` 完成（快照取活状态，是其超集），留着只会让定稿后再触发一次内容相同的冗余写。

**测试**：回归 `end_turn_is_delivered_when_the_flush_signal_channel_is_saturated`——容量 2 的信号通道 + 8 帧折叠 + `probe.try_send` 断言饱和前置条件，钉住「信号通道塞满时 EndTurn 仍恰好送达一次」；已在旧行为（`cmd_tx.try_send`）下验证失败（红），修复后通过（绿）。同批 5 个既有计时测试随 `capture_cmds`/`end_turns` 助手迁移到双通道形态，全绿。

### E17 — tps 分母改为解码窗口：从本窗口首个输出起算（2026-09-27）

来源：用户调研 deepseek-harness（`research/deepseek-harness`）的吞吐口径后拍板借鉴。其 `assistantStepReading`（`packages/client/ui-chat/src/client/contract/turn-metrics.ts`）把每个 assistant step 切成 `ttftMs = firstToken − stepStart` 与 `decodeMs = completed − firstToken`，tps 只摊解码段（`StatsPills.tsx` `decodeTokens / (decodeMs/1000)`），分子是 provider 上报的 `usage.outputTokens`。我方 ACP `usage_update` 无输出 token 字段（E13 已确证），分子仍为「本连接观测字符 ÷ 4」；可借的只有分母口径。

**根因**：E14/E15 的分母锚在**观测窗起点**（`observationWorkMs`，begin=0 / resume=当前工作坐标）。首字前的等待零输出却全额计入 → 首字越慢读数越虚低（reasoning 长思考尤甚）；反向在一小段首字紧跟整轮工具的场景里，首字前的窗口被算成生成时间，读数虚高挂住（E15 测试 `keeps 10s of tools…` 的 100 t/s 即此类虚高）。

**修复**（`frontend/src/utils/turnClock.ts`，纯前端、不入库、不参与同步）：

- 新增首输出锚点 `firstOutputWorkMs`（工作坐标）与纯工具基线 `pureToolMsAtFirst`，删除 `observationWorkMs` / `pureToolMsAtObs` 与 `generationElapsedMs`，替换为 `decodeElapsedMs` = `workElapsedMs(now) − firstOutputWorkMs − max(0, pureToolMs − pureToolMsAtFirst) − pureOpenToolMs(now)`。
- 锚点在 `addOutputChars` 首次收到输出时落定；基线同刻含「当前开放并集到此为止」的整段（该事件即刻封口的那段——它发生在首字之前，属工具时间），封口段随基线排除、不被扣两次。首字之后新开又闭合的并集照常进 `pureToolMs − 基线`。
- `resumeTurnClock` 随之不再需要 `at` 参数（窗口重开与新锚点解耦）；观测窗重开时输出归零、锚点重置、关闭的工具段跨重连保留三项均不变。`useAcpChat.ts` 调用点同步去参。

**边界（有意接受）**：

- 首字当刻解码窗口长度 0 → 读数 `null`（对应 dsh 的 `durationTooShort`），不摊薄也不虚构；
- 首字之后整个窗口都落在工具并集内且无后续输出（首发一小段即整轮跑工具）→ `null`，工具读数照常显示；
- 首字前的窗口时间含首发那批字符的生产时间，锚点之后只由后续流式输出摊——与 dsh 把首 token 计入解码窗同等乐观，偏差相同方向。

**测试**：`turnClock.test.ts` 全量改算新契约（原有窗口起点口径的期望值逐条重算；新增「首字前的等待不进分母」与「首个输出落在工具并集内：封口段不进分母」两条），三个连带测试文件（`ChatMessage.metarow.test.tsx`、`useAcpChat.midturn.test.tsx`、`chatStore.test.ts`）的 tps 期望随新口径更新，均先在新代码下复现红/绿差异后定值。全量 `pnpm test`（808 例）与 `tsc -b`、`lint` 通过。

### E18 — 工具计时也在封口处停表：翻盘 E14/E15 的「展示含封口后执行段」（2026-09-27）

来源：用户报告「有时 thinking 过程中，工具也在计时」。根因是 E14/E15 的展示口径：`turnToolElapsedMs` 走完整并集（`toolMs` 累计全跨度 + 开放并集当前跨度），而封口只作用于 tps 分母。于是工具并集内模型一流式输出（思考或正文），「工具约 N秒」继续随思考时长上涨——两个读数对同一区间给出相反归因（tps 算生成、工具算执行），观感上工具计时器在 thinking 期间空跑。agent 侧 in_progress 后继续流式解说、或并行工具晚到 completed 时该现象必现。

**修复**（`frontend/src/utils/turnClock.ts`）：`turnToolElapsedMs` 改走封口段口径 `pureToolMs + pureOpenToolMs`——已闭合并集只累计到首字封口点，开放并集只算「尚未出现输出」的那段；模型一吐字，工具计时即停。与 E17 后 tps 分母同一归因口径（同一区间不可既算工具又算生成）。`LiveTurn.toolMs`（全跨度累计）随之删除，`openToolMs` 收缩为封口/基线的计算源，不再进展示。残余边界：封口点取自输出实际到达时刻，[工具起点, 首个输出] 内模型的构思时间无法与执行区分，仍计工具；工具完成后、并集已关闭，之后的 thinking 本来就不计工具（不变）。

**测试**：新增 `stops tool timing at the seal: prose or thought inside a union freezes the clock`（用户报告形态的回归：并集内输出后计时冻结，12s 思考不涨、completed 不补）；`pauses the generation clock…` 与 straddle 用例补工具展示断言（封口段 2s / 3s，非全跨度 7s / 5s）；`ChatMessage.metarow.test.tsx` 两条期望随新口径改算（「工具约 11秒」→3秒、「工具约 2秒」→1秒）。

### E19 — 工具并集的静默段也归工具：翻盘 E15/E18 的「单次封口」（2026-10-04）

来源：用户报告「acp 会话，调用工具期间还是被算进 token 里面了，导致数据偏低」。根因是 E15 的单次封口只封「并集起点 → 并集内**首次**输出」：agent 把过渡文本/思考与 `in_progress` 同批下发（或工具间过渡语晚到）时，首次输出之后工具真正的静默执行段（可达数十秒）全部留在 tps 分母里——工具跑多久读数就摊多薄；E18 把展示也改成同一封口段，两个读数同时偏小。E15 写的「封口之后仍在工具内的区间确实是模型在产出」不成立：输出一次之后模型通常就去等工具了。

**修复**（`frontend/src/utils/turnClock.ts`）：把「输出活动是生成的证据」做彻底——并集内每次输出推进 `lastOutputWorkMs` 锚点，非生成段 = 首段（并集起点 → 并集内首次输出，`toolHeadMs`）+ 尾段（末次输出 → now/并集关闭，`openTailMs`），两读同口径：

- `turnToolElapsedMs` = `pureToolMs + toolHeadMs + openTailMs`：工具并集内只有「输出活动窗口」`[并集内首次输出, 末次输出]` 归生成（2026-09-27 用户报告「thinking 期间工具不该计时」在连续思考流下依旧成立——每个 chunk 前移锚点，尾段≈0）；
- tps 分母的开放并集净扣除 = `max(0, head + tail − openBaselineMs)`，`openBaselineMs` 是首字时刻的并集快照（已计入 `pureToolMsAtFirst`），并集关闭时随固化清零；
- 实时观感：末次输出之后工具表恢复走（模型在等工具，这段是真实执行）、tps 分母冻结不随工具执行下跌；新输出到达时 `[旧末字, 新输出]` 段被认领为生成（中途修正，分母回补一次）。
- 字段变更：新增 `openBaselineMs` / `toolHeadMs` / `toolHasHead` / `lastOutputWorkMs`，移除 `toolPureOpenMs` / `toolHasOutput`；`openToolMs` 收缩为「并集全跨度」计算源。

**边界（有意接受）**：

- 并集内单次输出后即静默（首发一小段即整轮跑工具）→ 窗口内无生成跨度，读数 `null`，工具读数照常——宁可 null 不虚报（同 E17）；
- 分母回补会让读数在新输出到达时跳变一次，这是「无法区分生成慢与等待工具」下取最新证据的策略；
- 仍依赖 agent 下发显式 `in_progress`/`running` 状态（E15 已知边界①不变）；
- 首段取「并集起点 → 并集内首次输出」而非输出生成的第一刻，构思时间无法与执行区分，仍计工具（E18 残余边界不变）。

**测试**：`turnClock.test.ts` 三条旧封口语义用例按新契约重算（`首个输出落在工具并集内` tps 150→null、工具 3s→5s；`stops tool timing at the seal` 拆为「连续思考流冻结」与「末次输出后的静默段归工具」两条；`pauses…` finalTps 50→200、工具 4s→7s），新增用户报告形态回归 `excludes a long silent tool execution from the rate, resuming after the tool ends`；`ChatMessage.metarow.test.tsx` 两条期望随新口径重设。全量 `pnpm test`（886 例）、`tsc -b`、`lint`（0 error）通过。

### E20 — tps 分母翻盘白名单：只认「模型真正在流式输出」的时段（2026-10-06）

来源：用户追问「execute 期间是否也被计入 token 估算」并指定 agent 为 pi。抓 `pi-acp` 真实帧（spawn 走 ACP stdio，3 个连续 `sleep 4` bash 工具 + thought/text，49 帧带时间戳）回放进 `turnClock` 真代码读数，结论分两层：

- **execute 本身已被 E19 正确排除**：三个工具执行窗（各 ~4s）内 tps 读数冻结不动，`updateTurnTool` 对 `tool_execution_update`（status 恒 `in_progress`）早退，并集不破。
- **但工具之间的 agent 循环空档全留在分母里**：pi 在相邻工具之间 1.3–2.6s 不发任何 thought/text（模型处理工具结果、生成下一步），尾 text 前还有 1.6s 首字延迟。实测读数从 thought 流期间的 ~80 t/s 一路摊到定稿 **11.0**，而真实输出活跃时间只有 ~1.4s。

**根因**：E17 的解码窗只锚在「本 turn 首个输出」，工具并集关闭后没有重新锚定；E19 修掉了并集内的静默执行段，却修不掉并集之间的空档——那段没有工具事件可挂，黑名单天然够不着。更结构性的问题：黑名单要证明「某段时间不是生成」，只能靠 agent 下发显式 `in_progress`/`running`，对不发状态的实现（E15 已知限制①）永远漏。

**修复**（`frontend/src/utils/turnClock.ts`，纯前端、不入库、不参与同步）：tps 分母改**白名单**——只累计「输出活跃时段」：相邻输出 chunk 间隔 ≤ `OUTPUT_GAP_MS`（1s）的连续 burst；工具执行、审批等待、模型停顿、agent 循环空档一律不计。已闭合 burst 保留其测得时长，故停顿期间读数冻结在最后测得值而非消失。

- 字段变更：删 `outputChars` / `firstOutputWorkMs` / `pureToolMsAtFirst` / `openBaselineMs` / `decodeElapsedMs`，新增 `burstFirstAt` / `burstLastAt` / `burstChars` / `streamChars` / `streamMs` 与 `streamTotals()`；`addOutputChars` 不再读工具状态，「末次输出锚点 + 并集首段封存」只为「工具约 N秒」展示保留（E18/E19 口径不动）。
- **解耦**：tps 不再依赖任何工具事件——`updateTurnTool` 溢出作废（`estimatesValid`）只废工具读数，tps 照常；E15 已知限制①对 tps 失效，跨 agent 一致。
- 实测同帧回放：定稿读数 11.0 → **~33**（173 字符 ÷ 4 ÷ 1.28s 流式时长）。
- 开放 burst 的窗口含 ≤1s 容差（末 chunk 后不足 1s 的静默仍计入），上限由阈值本身封顶；定稿前孤立的尾 chunk（如一句 "done"）burst 已闭合 → 不带字符，不稀释也不虚构。
- 边界（有意接受）：① 整轮只吐一个 chunk 的 agent（不流式、整段一次性下发）读数 `null` 而非被摊薄的数——同 E17「宁 null 不虚报」；② 若某 agent 把输出攒成大批再 flush，白名单会读出虚高（分母只剩 flush 内的瞬间）；pi/claude/codex 均逐 delta 流式（pi 已实测），不触发。

**测试**：`turnClock.test.ts` tps 用例按新契约重写（旧「首字锚点 / 工具扣除 / 封口」语义断言逐条改为 burst 语义），新增 describe `turnClock tps 白名单（E20）` 三条（工具执行与工具间空档冻结、1s 容差、孤立尾 chunk 不带字符）；`ChatMessage.metarow.test.tsx`、`chatStore.test.ts`（审批挂起冻表改为「冻结在最后测得值」）、`useAcpChat.midturn.test.tsx` 期望随新口径重设。全量 `pnpm test`、`tsc -b`、`lint` 通过。

### E21 — 迟到帧收敛与顶替定稿：孤儿流式气泡的计时永不收尾（2026-10-11）

来源：用户报告 oh-my-pi `/compact` 气泡永久停在「工作中 13秒·估算 89.5 t/s」（截图），同会话下方还有第二个流式 turn。排查排除后端定稿故障（`prompt_done` 已正常下发）：根因是**前端迟到帧竞态**——内容帧与终态帧分属两条无顺序保证的投递链路，turn 只有一帧正文时 `prompt_done` 可能先到；此后迟到的正文帧按流式语义新建 `streaming: true` 气泡，而不会再来的终态帧使它的实时计时**永远不会被 `endTurn` 收尾**。这是本计划「实时估算」在帧序竞态下的最坏失效面：读数没算错，是表永远停不下来；同时暴露 agent 侧确实存在无终态的回合（oh-my-pi `/compact`），宿主需要兜底。

修复（三层，详见 `docs/dev/plans/2026-09-19-acp-failure-visibility.md` 文末同题勘误）：

- **前端 settled 收敛**（`chatStore.applySessionUpdate`）：`sending === false` 时迟到帧按已定稿落地，绝不铸 streaming 气泡；尾部可并入消息排除 DB 权威行（`id === dbId`）。活跃 turn 计时语义不变（`turnElapsedMs` 非 null 的窗口仍与 `sending` 同生命周期，E12 口径不动）。
- **`turn_state{active:true}` 实时广播**（后端 `TurnEvent::Started`）：此前只有连接快照能拿到 active:true，现在所有连接在 turn 开始时实时收到；前端 `beginPrompt + resumeTurnClock` 由此对第二标签页 / 迟到订阅者生效——计时起点与工作锚点不再依赖「本连接发起过 prompt」。
- **顶替定稿（supersede）**：新 prompt 顶掉无终态旧 turn 时后端合成 `Done{Superseded}`，`duration` 取累积器 `TurnTiming` 照常下发——前端 `markDone` 停表并显示结算值；`Superseded` 不 fire attention（用户正在输入）。`finalize_turn` 返回值改为 `Option<TurnTiming>` 承接「谁赢得跃迁」，世代守卫 `mark_prompt_idle_for_generation` 保证旧 turn 的定稿者不能误杀新 turn（否则新 turn 计时与持久化双丢）。

**测试**：`useAcpChat.lateframe.test.tsx` 四条（终态先到 → 迟到正文落已定稿；正文→终态→再迟到帧全并一条且 dbId 保留；活跃 turn 内仍 streaming；Superseded 停表不提醒 + 随后 `turn_state` 重开计时）；`chatStore.test.ts` settled 判定；`ws::acp` supersede / 世代守卫 / `turn_state` 线格式三组；`turn_accumulator` 重复定稿语义强化。全量 `pnpm test`、`tsc -b`、`lint`、`cargo test`、`clippy -D warnings` 通过。

### E22 — 流式期元信息行固定单行：`min-width:max-content` 托底（2026-10-14）

来源：用户报告（截图）「acp 会话流式输出时，计时和 tps 会堆叠成三行，预期应该固定一行，避免画面抖动」。截图中工具卡（Read）下方三个读数「工作中 46秒」/「· 工具约 8秒」/「· 估算 97.0 t/s」各占一行。三项读数本身无缺陷，是纯布局问题。

**根因**：元信息行的行宽被钉在最后一个 `[data-chat-body]` 正文块的实测宽度（E10 机制，用于右缘对齐气泡）。流式期正文块常是窄元素——刚起的短文本泡、或最后落定的是窄工具卡（实测 130px）。E15 起三个读数各自是 `white-space:nowrap` 段，容器靠 `flex-wrap` 承接段间换行：「放不下才换行」在窄行上退化为**每段各占一行 = 三行**。更糟的是行宽随流式正文增长而增长，三段在 3→2→1 行之间反复重排——即使用户看到的静止瞬间是三行，实际是持续抖动的重排过程，直接命中用户「避免画面抖动」的诉求。

**修复**（`frontend/src/components/Chat/ChatMessage.tsx`）：流式期给行加 `min-width: max-content`——CSS 规范下 `min-width` 优先于 `max-width`，行宽被托到「三段单行排布」的内在宽度；正文后续变宽时行宽自然跟随（`max-width` 上限不变），读数左对齐不位移（流式态无动作栏，E13 口径不动）。渲染处与 `LiveWorkElapsed` 的显示门控收敛为同一条件 `liveSessionId = isLive && !workText ? sessionId : undefined`——若两者各写一份，会出现「托了宽却没读数」或反之的错位。定稿行不加托底，仍按 E11「放不下才换行」（结算场合行里还有动作栏，不能一味撑宽）。

**验证**（真机 Chromium 加载真实组件 + `turnClock` 驱动，修复前后对照）：

| 项 | 修前 | 修后 |
|---|---|---|
| 行宽（窄工具卡正文） | 130px（= 正文块宽） | 325px（单行内容宽） |
| 三段 top | 122 / 140 / 159（三行） | 122 / 122 / 122（一行） |
| 横向溢出 | — | `messageRowScrollX: 0`（无） |

结算态回归：宽正文 → 1 行且右缘贴气泡（`rightEdgeDelta 0`）、无内联 `minWidth`；窄正文（45px）→ 仍按 E11 换行（右对齐、贴边），行为不变。

**边界（有意接受）**：极端窄视口 / 窄气泡下，流式行允许横向超出气泡宽度（以用户要求的「固定一行」优先）；结算态窄气泡仍换行（E11 口径，静态呈现不抖动）。

**测试**：`ChatMessage.metarow.test.tsx` 断言流式行 `style.minWidth === 'max-content'`、结算行 `style.minWidth === ''`（jsdom 不做布局，只钉结构不变量与门控一致性）；全量 `pnpm test`（1157 例）、`tsc -b`、`lint` 通过。

### E23 — 计算整体迁后端、前端只显示：tps / 工具耗时落库常驻（**翻盘 E13/E14 的「仍不入库」与 E14/E15 的「重连重开观测窗」**）（2026-10-15）

来源：用户报告「前几次提交把 tps 统计弄丢了」。诊断结论：并非那几次提交改坏（未触碰计时/估算链路，回归全绿），而是 E13 起「仍不入库：tps 只渲染、刷新即失」的既有设计在**刷新页面后**表现为「功能消失」——内存快照（`finalBySession`）随 JS 上下文清空，历史行从来就没有读数。用户拍板方向：**把前端计算逻辑迁到后端作为唯一真相源，前端只显示、不再计算**；「工具约 N秒」与 tps 同属本地快照、一并落库。

**决策与实现**

- **算法整体移植到 `src/acp/turn_accumulator.rs`**（不新造口径，E13–E20 的数值语义逐条保留）：
  - 分子 = 正文/思考文本块的 **UTF-16 单元**数（与旧前端 `action.text.length` 同口径，读数校准逐字延续），`÷ CHARS_PER_TOKEN(4)`；
  - 分母 = 白名单 burst：相邻输出 chunk 间隔 ≤ `OUTPUT_GAP_MS(1s)` 的连续段（E20），零长度 burst 不带字符/时长（孤立尾 chunk 不稀释，E17/E20 取舍不变）；
  - 工具耗时 = 执行并集（仅显式 `in_progress` 起表；`completed`/`failed`/`pending`/未知状态一律释放——与旧前端对任意非 start 状态的 delete 语义逐条对齐）按「首段封存 + 末次输出后尾段归工具」测量（E18/E19），工作坐标上度量、审批重叠只扣一次（E15）；
  - 边界不变：活跃工具 ≤ 256、单 ID ≤ 1024 UTF-16 单元、越界令**工具**估算整体失效（tps 不受影响，E20 解耦）；审批挂起经既有 `begin_wait`/`end_wait`/`end_all_waits`（wait_depth 深度语义，E1）冻表。
  - 实现手法与测试：全部统计方法显式接收 `now: Instant`（生产传 `Instant::now()`、测试注入合成时间线），`finalize_turn_at` 供定稿向量逐毫秒对齐；回归向量自 `turnClock.test.ts` 逐条搬迁到累积器测试模块（≈18 条：burst 白名单/间隙容差/孤立尾 chunk/审批冻结/工具封口与恢复/并行并集/显式状态与 pending 释放/越界失效/ID 超长/顺序工具/空 turn 三态），另加 `fold` 端到端接线与 UTF-16 计数两条。
- **实时读数改 WS 推送**：新增服务端帧 `turn_stats{work_ms, tool_ms?, tps?}`，由 `spawn_turn_event_task` 在 turn 激活期按秒推送（`TurnEvent::Started` 后立刻补一帧，连接时首个 tick 立即就绪——重连/新标签页不必等满一秒）；无活跃 turn 时空查不发帧。数值来自 `TurnAccumulator::live_stats()`，与定稿结算同一套计算、同一把锁。
- **定稿读数落库**：migration `20261015_add_turn_estimates.sql` 给 `chat_messages` 加 `tool_ms INTEGER` / `tps REAL`（NULL = 不可追溯/失效，与 `duration_ms` 同一三态语义）；`finalize_message` 与 `duration_ms`/`wait_ms` 同一条 UPDATE 落库；`TurnTiming` 扩展 `tool_ms/tps` 随 `prompt_done.duration` 下发（前端当场显示、不必等刷新）；`GET /messages` 下发 `toolMs`/`tps`。
- **前端退化为纯显示**：删除 `frontend/src/utils/turnClock.ts` 及其全部接线（`chatStore` 的起表/停表/冻表、`useAcpChat` 的字符计数与工具状态喂表、快照恢复观测窗）；新增 `frontend/src/utils/turnStats.ts`（推送读数缓存 + 订阅回调，消费方直写 DOM、不进 React state——旧「定时器直写 DOM」手法保留，驱动源换成 WS 帧后隐藏标签页不再受定时器节流影响）；`ChatMessage` 的流式读数（元信息行/收纳行）与定稿读数（`message.toolMs`/`message.tps`）分别为订阅渲染与逐消息字段渲染。
- **旧「只挂最后一条 assistant」门控取消**：那是内存快照按会话存的规避手段（防旧消息重渲染读到新 turn 快照）；落库后读数**按消息**存在，历史行各自显示自己那一轮的值、刷新后常驻（E13 的呈现口径就此作废）。
- **重连/多标签页语义变化（有意翻盘 E14/E15）**：后端从 turn 起点连续观测，不再有「重连重开观测窗、离线段不补」；中途刷新接回显示该轮真实累计（不再取建行时刻做锚点、偏小属预期的旧行为作废）；同一会话多个标签页读数完全一致。**无客户端在线的 turn 同样有读数**（后端一直在记账，与「fold 与 WS 存活无关」同构）。
- **多实现行为差异备注（AGENTS §8）**：SDK 把无法识别的工具状态串归一为 `pending`（`DefaultOnError`），且状态缺省在序列化时省略——旧前端对 `'running'` 的接受在实际数据流上从未生效（帧经 SDK 归一后下发），迁移后行为不变；对从不发显式执行状态的实现，工具耗时仍记 0（E15 已知限制①，口径有协议依据，未动）。

**已知取舍**：迁移前的历史行无读数（NULL 不渲染，同 `duration_ms` 的「不可追溯」）；`tool_ms` 的 0（有效观测没记到工具）与 NULL（失效）在库中语义不同、渲染端同样不显示。

**测试**：后端 `cargo test`（累积器新向量 + 持久化读写回、NULL 保持 NULL、迁移后列读取）+ `ws::acp` 帧线格式（`turn_stats` 缺省字段省略 / `prompt_done.duration` 扩字段）全绿；前端 `pnpm test`（111 文件 / 1144 例：metarow 重写为「消息字段 + 推送注入」两组、lateframe 的实时读数断言改 `turn_stats` 驱动、chatStore 接线块重写为 `markDone` 落定四读数）、`tsc -b`、`lint` 通过。

**验证缺口（未做）**：真机联合验证（真实 agent 跑 turn 对照流式推送与刷新后的常驻读数、双标签页一致性）留给用户手动回归——测试覆盖的是注入帧与落库链路，真实 agent 的 chunk 节奏（burst 间隙）与前端口径的等价性有 Rust 向量把关，但端到端观感未实测。

### E24 — 读数文案去掉「约 / 估算」前缀，诚实口径收进 hover tooltip（2026-10-15）

来源：用户要求把气泡底部元信息行从「工具约 1分钟24秒 · 估算 63.5 t/s」改成「工具 1分钟24秒 · 63.5 tok/s」，并「hover 时诚实简单地告诉用户 ACP 侧不返回真实 TPS、数据由 omniterm 计算」。

**决策与实现**（只改呈现与解释，**计算口径 / 落库 / 推送一律不动**——E13–E20 磨出的数值语义与 E23 的后端移植原样保留）：

- **界面只出事实**：`chat.msg.toolTime` 去掉「约」（en 去掉 `est.`），`chat.msg.tps` 单位由 `t/s` 改 `tok/s` 并去掉「估算」/`est.` 前缀。工作时长（`已工作` / `工作中`）本来就不是估算（墙钟 − 审批等待），措辞不动。
- **性质说明全部收进 hover**（两条 tooltip 重写，「ACP 不上报 → omniterm 自己算」写在最前）：
  - `chat.msg.tpsTip`：ACP 不返回真实 token 速率，读数由 omniterm 估算（观测到的正文与思考字符 ÷ 4 ÷ 模型真正在流式输出的时段）；
  - `chat.msg.toolTimeTip`：同样标明「ACP 不上报该数据」，工具并集封口等口径沿用 E14–E19；
  - `chat.msg.workingTip`：不变（真实测量，非估算）。
- **tooltip 只解释画出来的读数**（`ChatMessage.tsx` 的 `visibleReadings` + `liveTip`）：工具耗时与 tps 各有「暫无」态（尚无输出 burst / 工具跟踪失效），整段撤掉后仍挂一段「这个读数怎么算的」只会让人去找屏幕上不存在的数字。原实现把三条 tip 无条件 join 进静态 `title`，现改为随推送帧重算并直写 DOM（仍不进 React state）；「这一帧有哪些读数可见」由 `visibleReadings` **算一次**同时喂给三个数字段与 tooltip（单一真源，避免两边判据漂移出「段显隐与 tooltip 不同步」的中间态）。结算行的 `durationTip` 本就是条件拼接，无需改。
- **title 的唯一写入方是 draw()**（不写 JSX prop）：tooltip 与三个读数段同属直写 DOM 域，deps `[sessionId, t, i18n]` 已覆盖挂载 / 切会话 / 切语言。JSX 里再按 `getLiveTurnStats` 求一份就是第二个写入方——那张缓存是有界表（`utils/turnStats`，淘汰不通知订阅者），本会话项被淘汰后一次父组件重渲染就会把 tooltip 抹成空串而三段读数还在（评审实测复现，≥17 个会话在推 `turn_stats` 时可达）。

**测试**：`ChatMessage.metarow.test.tsx` 期望值改新文案（` · 工具 3秒` / ` · 400.0 tok/s`），新增 7 条 tooltip/文案回归（结算行含「ACP 不返回真实 token 速率」、缺省读数不进 tooltip、流式 tooltip 随推送帧同步、语言切换后 tooltip 与三段读数一起换文案、turn 作废后 tooltip 清空、双 locale 的诚实措辞与去前缀 label 各一条）；全量前端 1155 例通过、`tsc -b`、`lint` 0 error。文档同步：ui-style-guide §7.5、user-testing §15.7、backend.md 结算呈现位、frontend.md 小节标题、CLAUDE.md 文档索引（E12–E24）。

### E25 — 气泡底部定稿主段改「结束于 HH:mm」：turn 定稿时刻落库（2026-10-16）

来源：用户要求——「ACP 会话时间统计现在有两个地方显示已工作 x分x秒，把底部的那个结束后改成『结束于 [时间]』，流式输出时不变」。两处指收纳行标题（E12 起）与气泡底部元信息行（E23 结算段），定稿后文案重复；底部改为**结束时刻**（信息不重复，且多出时间轴视角）。三个拍板点（用户确认）：**替换**（非并存；纯文字回复没有收纳行时，时长只剩 hover tooltip 一处）；**区分今天与跨天**（复用 `formatHoverTime` 智能缩写）；**历史数据不处理**（不回填、不回退）。

**决策与实现**：

- **替换**：定稿后底部主段为「结束于 14:32 · 工具 3秒 · 55.5 tok/s」，工具/速率段与 hover tooltip 不动；「已工作 x分x秒」仍保留在 tooltip 第一段（`durationTip`）与收纳行标题（`ProcessBlocks` 的 `durLabel`）——时长的呈现位从「两处正文 + 一处 tooltip」收为「一处正文 + 一处 tooltip」。
- **定稿时刻落库常驻**：新列 `chat_messages.finished_at`（TEXT/RFC3339，migration `20261017_add_turn_finished_at.sql`）。E23 的教训直接适用（读数只在内存里 = 刷新即失），故时刻在 `finalize_turn` **生成一次**（`TurnTiming.finished_at`），writer 落库与 `prompt_done.duration.finished_at` 下发**共用同一值**（刷新前后显示一致）；`GET /messages` 下发 `finishedAt`。不采用「前端收到 prompt_done 时记本地时刻」——那会让刷新前后显示不同的时间。
- **格式**：复用 `formatHoverTime`（今天 → `HH:mm`，当年跨天 → `MM-DD HH:mm`，跨年 → `YYYY-MM-DD HH:mm`），与气泡 hover 时间小字同一格式。`chat.msg.endedAt` = `结束于 {{time}}` / `Ended at {{time}}`（占位符是 `{{time}}` 不是 `{{dur}}`——它接的是格式化后的时刻串）。
- **历史行不兜底**（用户拍板）：「无 `finished_at`（迁移前的行）→ 结算段整段不渲染，不回退『已工作』」。注意这是**存量行工具/速率段随之消失**的有意取舍（旧行照旧条件里由 `workText` 门控整段；改由 `endText` 门控后同一条规则自然延续）。
- **流式期不变**：底部仍是 `LiveWorkElapsed` 的「工作中 x分x秒 · …」实时跳动（`turn_stats` 推送）；收纳行流式/定稿两种形态均不动。三段渲染逻辑（nowrap 段、`CHAT_META_RIGHT`、`min-width:max-content` 托底门控、量宽 effect 门控）原样沿用——只把门控与主段文本从 `workText` 换到 `endText`。

**测试**：后端 `finalize_message` 参数扩展（`finished_at`）+ 回读断言 + legacy NULL 断言、`prompt_done.duration` 线格式（finished_at 参与精确 json 断言，TurnTiming 字面量构造点 3 处同步）；前端 metarow 结算段断言重写（「结束于」主段两例 + 无 finishedAt 整段撤 + 双 locale `endedAt` 占位符）+ chatStore markDone 五读数与 null 不覆盖。真机 Chromium（dev 前端 + store 注入）6 项全过：新行「结束于 14:32 · 工具 3秒 · 55.5 tok/s」/ 跨天「结束于 10-15 09:05」/ 老行无结算段 / tooltip 保留「已工作 2分钟5秒」/ 流式读数与收纳行未变。后端 807 例 / 前端 1183 例通过。

**实现偏差**：无。

**边界（有意接受）**：结算段主段不再显示「工作了多久」——时长信息的正文出口只剩收纳行（纯文字回复消息时长仅 hover 可见）；`finished_at` 为 NULL 的存量行底部结算段整段消失（用户拍板的「不处理」）。

### E26 — 实时读数收敛到最后一条 assistant 气泡底部（2026-10-18）

来源：用户报告（截图）——同一个进行中 turn 的消息流里出现三行完全相同的
「工作中 12分钟10秒 · 工具 2分钟6秒 · 224.5 tok/s」，要求时间 / tok/s 统计只在
**最新一条消息底部**显示一处。

**根因**：`turn_stats` 是**会话级**读数（`utils/turnStats` 按 sessionId 缓存），而
`LiveWorkElapsed` 的渲染门控是 `message.streaming`。ACP 的 system 通知（如权限
超时告知）会插在 assistant 消息尾部，`appendProseToMessages` 只在尾部仍是
streaming assistant 时续写，于是**同一 turn 被切成多条 streaming 消息**；每条都
满足 `message.streaming`，各自渲染同一份读数。收纳行 `ProcessWorkElapsed` 也订阅
同一份会话级读数，进一步放大重复。另有一条同源路径：`markDone` 把同一组结算
读数写到**所有** streaming 消息上，定稿后同样会在多条气泡底部重复。

**修复**：

- `ChatMessage.tsx`：`liveSessionId` 增加 `isLastAssistant` 门控；元信息行的渲染
  条件与量宽 effect 由 `isLive` 改为 `liveSessionId`，非最后一条 streaming 消息
  不再留下空的量宽行。删除 `ProcessWorkElapsed` 与 `.process-shimmer`——收纳行
  流式期只显示计数，结算后才显示 `message.durationMs`（时长正文出口仍按 E25）。
- `chatStore.markDone`：同一 turn 的多条 streaming 消息全部停表，但结算读数
  （`durationMs` / `waitMs` / `toolMs` / `tps` / `finishedAt`）只落到最后一条
  （它们共同对应后端同一行，`turnToSyncPayload` 已按 turn 合并回写）。
- 定稿读数仍按消息显示：历史行各自属于不同 turn，不受影响（E23 不变）。

**覆盖关系**：本条覆盖 E25 中「流式期收纳行不动」的表述——收纳行流式期不再显示
实时时长；E25 的定稿主段「结束于」与 hover tooltip 时长保留不变。

**测试**：`ChatMessage.metarow.test.tsx` 新增「两条 streaming 消息只渲染一行实时
读数」；`ChatMessage.process.test.tsx` 的流式用例改为断言收纳行不再出现实时时长；
`chatStore.test.ts` 新增「同一 turn 多条 streaming 消息读数只落最后一条」。前端全量
115 文件 / 1198 例、`tsc -b`、`lint`（0 error，18 条既有 warning）通过。
