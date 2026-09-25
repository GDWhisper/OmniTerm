# ACP 失败可见化与恢复重放收敛

> 状态：实施完成（2026-09-19 设计稿；2026-09-23 Phase 1-4 全部落地并入 dev）
> 触发条件：修改 `src/ws/acp.rs`（`dispatch_prompt` / turn 结束呈现）、`src/acp/turn_accumulator.rs`（定稿状态语义）、`src/acp/chat_persistence.rs`（`sync_messages` 匹配）、`frontend/src/hooks/useAcpChat.ts`（`prompt_done` / `replay_end` 分支）前**必读**
> 关联：`docs/reference/acp-protocol-reference.md` §6.8（stopReason 与实现差异）、`docs/dev/plans/2026-08-18-ghost-message-and-known-issues.md`（幽灵行 P0 方案 A/B，本计划是其在「手动恢复」入口的补漏）、`docs/dev/plans/2026-08-10-acp-session-reliability.md`（turn 落库与 sync 语义）
> 来源：正式库会话 `codebuddy_0919-0946`（`0c7ec3ec-df7b-4ec6-b228-6ceb0e9a0e23`）2026-09-19 排查；证据全部取自 `~/.omniterm/omniterm.db`、`~/.omniterm/omniterm.log`、`~/.codebuddy/logs/2026-09-19/*.log` 与 `~/.codebuddy/projects/home-pax-coding-OmniTerm-dev/01a0b757-ae8b-7b48-959c-867f8950d404.jsonl`

## 背景

该会话 turn 2（01:48:10 → 02:04:39，16m29s）被 agent 侧工具执行异常中止：

- agent 日志 `02:04:38.558`：`[Interruption] Catch block entered, error: Failed to run function tools: Error: Bad substitution: createHmac`；agent 会话文件同一时刻落 `status:"incomplete"` + `providerData.error`。
- ACP 层 `02:04:39.771`：`stopReason: refusal`（`rpcCode=-32603 / category=internal` 只进 agent 自己的日志）。
- OmniTerm 侧同一时刻把该 turn 定稿为 **complete**（`duration_ms=989637`），`blocks` 尾部残留一条 `status:"running"` 的 tool_call，**聊天流里没有任何失败痕迹**。

用户在移动端 + CF 公网下看到的现象是「运行中断」，无错误提示、无重试入口。三个叠加因素：

| # | 问题 | 严重度 | 证据 |
|---|------|--------|------|
| P0-1 | 非正常 stopReason 被当作正常完成，错误不下发、不落库 | 高（用户无法得知失败原因，误判为宿主/网络故障） | `useAcpChat.ts:863`（仅排除 `cancel`）；`src/ws/acp.rs:497-522`（只有 `send_prompt` 返回 `Err` 才走 `TurnEndEvent::Error`）；v0.2.22 同码 |
| P0-2 | 失败期间的 WS 掉线使 `prompt_done`/错误帧无人接收，且 broadcast 无历史、重连不补发 | 高（同一失败在「在线」与「离线」两种时序下表现完全不同） | ACP WS 离线 02:01:34 → 02:36:09（34m35s）；`turn_end_tx` 为 broadcast |
| P1 | 手动恢复（`session/load`）重放历史后全量 `syncToDb`，文本匹配失败 → INSERT 重复 assistant 行（幽灵行家族的手动恢复入口） | 中（数据污染 + 误读为「两条中断记录」） | `useAcpChat.ts:906`（`!isManualRestore.current` 使 `suppressReplay=false` → replay_end 走 `commitReplay + syncToDb`）；03:09:21 新增 `5200e835`（尾部文本 `Interrupted by user`）、`bbd3e319`（136 cooked blocks，原行仅 2 块） |

**根因归纳**：OmniTerm 把「协议返回成功」等同于「turn 成功」，而协议只承诺 stopReason 字段存在（`docs/reference/acp-protocol-reference.md` §6.8），失败语义由实现自定且可以不随消息流下发。

## 范围与优先级

| 优先级 | 目标 | 要点 |
|--------|------|------|
| P0 | 非正常结束必须可见 | 判定口径 + system 消息落库 + 前端呈现 + 离线补发 |
| P1 | 手动恢复不再产生重复行 | 重放消息与 DB 行对齐后按 id 回写，或放弃写回 |
| P2 | 失败可重试 | 失败 system 消息附「重发上一条」入口（依赖 P0 的消息形态） |

### 不纳入范围

- **修 codebuddy 的 `Bad substitution` 缺陷**：上游问题（`shell-quote` 解析 `${expr}`），本项目只能兜底与上报；上报与否由维护者决定。
- **WS 心跳/空闲断连**：属传输层，另立 `2026-09-19-ws-idle-disconnect-heartbeat.md`。
- **存量重复行清理**：用户可删会话；如需批量清理另立（沿用 08-18 计划的排除理由）。

## 设计决策（ADR）

### D1：判定口径 —— 白名单「正常值」，其余（含未知）按非正常处理

- **决策**：正常结束 = `end_turn` / `max_tokens` / `max_turn_requests`；`refusal`、`cancelled`、`_` 前缀自定义值、以及**无法识别的值**一律按「非正常结束」留痕（`cancelled` 单独文案，不算错误）。
- **理由**：AGENTS.md §8 要求可选/未知字段必须显式回退兜底。把未知值当正常 = 静默失败（即本次事故）；把未知值当异常 = 多一条提示，但可发现、可修。
- **否决项**：只把 `refusal` 列入异常（漏掉 `_` 前缀自定义值与未来新增值，等于把同一个坑留给下一个实现）。
- **翻盘条件**：若某实现把大量正常结束也标成 `_` 前缀值，导致误报成灾 → 改为「仅 `refusal` + 未知值且 turn 无 assistant 文本」的窄口径。

### D2：呈现载体 —— 复用既有 system 消息通道，不污染 assistant 行状态

- **决策**：失败原因作为 `role='system'` 消息落库 + 广播（`chat_persistence::insert_message` + `notify_system_message`），前端沿用 `system_message` 帧呈现；assistant 行的 `status` 维持 `complete`。
- **理由**：assistant 行的语义是「agent 说了什么」（由累积器从消息流落库），失败原因是**宿主对终态的判定**，两者混在一行会让 hydrate/replay 的匹配与体积收敛更难；且系统通知通道已有先例（`src/acp/reaper.rs:94-113` 权限超时告知）与现成前端分支（`useAcpChat.ts:875`），零新增协议帧。
- **否决项**：把 turn 行 `status` 改成 `error`（需改 `turn_accumulator` 定稿与 hydrate 语义、污染历史行状态、且离线后仍不可见）。
- **翻盘条件**：若产品要求「失败气泡可折叠进对应 assistant 行」，则改为在 assistant 行 `blocks` 追加一个 system block（需同时处理 `sync_messages` 的 text 匹配）。

### D3：执行位置 —— `dispatch_prompt` 下沉 db 句柄，判定与写入同处

- **决策**：`dispatch_prompt`（`src/ws/acp.rs:486`）现无 db 参数；把 `db` 传入该函数，在 `Ok(resp)` 分支按 D1 判定、按 D2 写库并广播。
- **理由**：判定所需的一切（`resp.stop_reason`）都在此；移到调用方会复制两条路径的判断（「连接存活即时发送」与「自动恢复后延迟发送」复用同一实现，见该函数文档注释）。
- **注意**：`c.mark_prompt_idle()` 已先行定稿累积器，写入 system 消息必须在其后（顺序影响 hydrate 的 created_at 排序），需在实现时确认前端渲染顺序不出现「失败提示在正文之前」。

### D4（P1）：手动恢复重放的收敛策略

- **决策（倾向 b）**：手动恢复保留完整重放（`suppressReplay=false` 的既有理由成立：DB 快照可能只有累积器文本、缺 thought/tool 块），但 `replay_end` 不再走无 id 的全量 `syncToDb`；改为把重放消息按**位置 + 角色**与 DB 既有行对齐，命中则按 id UPDATE（复用 `storedRawRowToSyncPayload` 同构路径），只在数量超出时才 INSERT。
- **否决项**：a) 手动恢复不再写库（丢重放带来的 blocks 补全，且刷新即丢）；c) 先删该会话 assistant 行再重建（破坏性、且离线期新 turn 有被误删风险）。
- **翻盘条件**：若各实现的 `session/load` 重放长度/顺序与累积器行无法稳定对齐（多实现差异），退化为 a 并在 UI 明示「本次恢复仅在内存展示」。

#### D4 实施记录（2026-09-23 落地）

**为什么 b 方案需要先取基线快照才能工作**：`commitReplay` 是从空白重建 store 的，hydrate 行的
`dbId` 在这一步全部丢失——所以在 `replay_end` 里「按 id 写回」需要一个**早于**那次重建的
快照。快照点取 `replay_start`：它早于任何重放内容帧，且与 `replay_end` 同在
`HYDRATE_GATED_FRAMES` 中，hydrate 必已落定，此刻 store 里就是带 `dbId` 的权威历史。
`abortReplay`（load 失败 / 重放中 WS 断开）一并清空，失败的恢复不得把陈旧基线泄漏给
下一次成功的恢复。

**匹配规则**（`chatStore.ts` 的 `alignReplaySyncPayload`，纯函数）：对每条重放消息，从
`cursor` 起**只读**扫描基线，候选行须角色相同且通过**前缀守卫**（基线 text 是重放 text 的
前缀，含相等；基线 text 为空时要求重放 text 也为空，否则空串是一切串的前缀、等于没有守卫）。
**只有在命中时才推进 cursor**，由此得到两条不变式：① 已配对基线下标严格递增 ⇒ 更晚的重放
消息不可能被配到更早的行（这是「误 UPDATE 不可能」的机制保证，而非数据巧合）；② 一行只被
消费一次 ⇒ 同一个 DB 行不会被两条载荷 UPDATE 两次。

**失配一律降级为无 id**，即回落到后端既有 `(session, role, text)` 文本匹配 / INSERT 路径，
与改动前完全一致。降级粒度是**单条消息**而非整份载荷；`alignedSync.length > 0` 的调用点
分支还保证空对齐回退 `syncToDb()` 而不是 POST 空数组。

**为什么前缀守卫而不是纯位置对齐**：重放是权威完整历史，DB 基线行则可能因后端帧窗口从头部
驱逐而只剩后缀、或被 `MAX_TEXT_BYTES` 头尾折叠。纯位置对齐在错位时会把 cooked blocks
UPDATE 到**错误的行**上——静默且不可恢复；而今天的无 id 行为 worst case 只是 INSERT 一条
重复行（可发现、可删会话）。宁要可恢复的污染，不要不可恢复的损坏。

**性能边界**（红线 §P1 三问）：扫描形状为 O(replay × baseline)，最坏情况（全量漂移、用户上拉
过多页）在主线程上是可感知的同步开销，故设显式候选预算 `ALIGN_SCAN_BUDGET`：超出即把该条
消息降级为无 id，不中断整场对齐、不抛异常。取值 = 后端**默认**每页行数
（`MESSAGES_PAGE_DEFAULT_LIMIT`=100；前端拉 `/messages` 不传 limit，故基线通常就是约一页）——
与 `MESSAGES_PAGE_MAX_LIMIT`(500) 无直接关系。`examined` 每条消息重新计数且命中即 break，
故 1:1 形态下计数器恒为 1，与页数无关（实测 300 条完全对齐多页重放全部命中）。它是病态
漂移情形的保险，不是正确性机制。基线 ref 自身不设独立 cap：它与 `store.messages` 同源
（后端分页预算），且写入点只有整份覆盖/整份清空，非 push 型累积。

**实施期间抓到的两个真问题（值得留档）**：
1. 第一版 cursor 在**失配时**推进，导致单条文本漂移污染其后所有消息，且「重放是基线的后缀」
   这一常见形态（后端从头部驱逐帧）下整场降级——即修复完全无效。改为「只在命中时推进」
   才同时修复两者。**教训：位置对齐的指针推进条件必须与「命中」绑定，不能与「失败」绑定。**
2. 第一版集成测试直接注入 `replay_start` 帧，而 `isManualRestore` 只由 hook 的 `restore()`
   设置（无任何帧携带该语义）⇒ 对齐分支从未执行、测试空转却全绿。改为驱动真实入口后才
   暴露问题。**教训：门控 flag 由用户操作设置的路径，测试必须走该操作。**

## 多实现差异与降级（AGENTS.md §8）

| 实现 | 重放行为 | 本计划姿态 |
|------|---------|-----------|
| codebuddy | `session/load` 重放含 thought/tool 块的完整历史；失败只留自己的日志（不下发） | 失败兜底不能依赖消息流文本，只能靠 stopReason |
| 其他 ACP agent | 可能不重放历史、或不支持 `session/load` | P1 的对齐必须在「重放为空」时保持现状（既有分支已处理，`useAcpChat.ts:927-943`） |

## 实施分期

| Phase | 产出 | 改动文件 | 依赖 |
|-------|------|---------|------|
| 1（P0 后端） | stopReason 判定 + system 消息落库/广播 | `src/ws/acp.rs`、可能的 `src/acp/chat_persistence.rs` helper | D1/D2/D3 |
| 2（P0 前端） | `prompt_done` 非正常分支呈现 + attention 用 error 语义 | `frontend/src/hooks/useAcpChat.ts`、`frontend/src/locales/{zh,en}/translation.json` | Phase 1 的消息文案 i18n key 约定 |
| 3（P0 验证） | 离线失败 + 重连后 hydrate 仍可见 | 前端集成测试（mock 帧序） | Phase 1-2 |
| 4（P1） | 手动恢复按 id 收敛 | `frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts` | D4 定稿 |

## 验收标准

- [x] 后端单测：`end_turn` 不写入 system 消息；`refusal` / 未知值写入且只写一条（重复定稿不重复写）——`ws::acp::notice_tests::{normal_stop_reasons_write_no_system_row, refusal_writes_exactly_one_row_even_when_repeated_for_same_turn, next_generation_gets_its_own_notice}`。
- [x] 前端单测：`prompt_done{stop_reason:'refusal'}` 呈现失败提示且 `attention` 走 error（不复用 done）——`useAcpChat.turnfailure.test.tsx`（提示由后端 `system_message` 帧承载，前端不自行合成）。
- [x] 前端集成测试：失败发生时 WS 离线 → 重连 hydrate 后失败提示仍可见（覆盖 P0-2）——已覆盖「离线 + 刷新」与「在线」两种可达时序；「仅重连不刷新」的残余见文末勘误。
- [x] 手动回归：`docs/reference/user-testing.md` §12.7 / T39（用可稳定复现的 `${expr}` heredoc 命令构造，见协议参考 §6.8）。
- [x] 质量门禁：`cargo clippy -D warnings`（0 警告）/ `tsc -b`（干净）/ `pnpm lint`（18 个改动前既有告警，0 新增）。
- [ ] 正式库核对：新发生的非正常结束在 `chat_messages` 中留下 `role='system'` 行，且不再出现「turn 定稿但无任何提示」。**需在真实环境跑一次 §12.7 后回填。**
- [x] P1 验收：手动恢复不再产生重复行 —— `useAcpChat.alignreplay.test.tsx` 断言对齐载荷带既有行 id；「后端确实不再 INSERT」需真实库手动回归回填。

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 判定口径过宽导致噪音（把 `max_tokens` 之类当成失败） | D1 白名单 + P2 之前不弹窗、只留痕 |
| system 消息与 assistant 行排序错位 | 实现时在 `created_at` 上显式串行并在测试中断言顺序 |
| 未知 stopReason 文案无 i18n key | 沿用 reaper system 消息约定（2026-09-21 起为 `label` 存 i18n key + `detail` 结构化载荷）：未命中 key 原样显示 |

### 勘误（2026-09-23 Phase 1-3 实施后）

**P0-2 仅完成「落库」半，前端补发半未实现——离线期间若不刷新页面，失败提示在当前标签页不可见。**

- 现象：WS 离线期间发生的非正常结束，后端已把 `role='system'` 行写进 `chat_messages`（D2），
  但 `system_notice_tx` / `turn_end_tx` 都是普通 broadcast（无历史、无补发），前台 frontend
  在重连后**不会**重新 hydrate，因此看不到这条提示，直到用户整页刷新。
- 根因是两条既有机制叠加（均非本计划引入）：① `ChatView.tsx:210` 的 `if (states[sid]?.hydrated) return`
  守卫使 `GET /messages` 每会话只跑一次，而 `chatStore` 无持久化 ⇒ 重连（无 remount）时
  `hydrated` 仍为 true；② `useAcpChat` 的 `hydratedRef.current` 只在 effect 里写 true、无任何
  一处写 false（`setHydrated(false)` 在 `src/` 下零调用）。
- **同一缺口影响已上线的权限超时告知**（`src/acp/reaper.rs:230` insert_message + `:239`
  notify_system_message，DB 与广播同源）。即「离线期间错过的 system 通知」是通道级问题，
  不限 turn 失败这一类。
- 补法需在后端（超出本计划 Phase 1-3 的前端边界）：给 system notice 加游标/补发机制
  （如连接时下发「上次未见的最新 N 条 system 行」），前端接 `connect()` 复位 `hydratedRef`
  或单独拉一次增量。**建议单独立项**，勿塞进本计划收尾。
- 已由 `frontend/src/hooks/useAcpChat.turnfailure.test.tsx` 固化为两个可达形态
  （在线失败只见 live frame / 离线+刷新只见 hydrate 行）与一条残余说明（重连不重 hydrate）。

## 文档闭环

- `docs/reference/acp-protocol-reference.md` §6.8：本计划落地后把「宿主现状（静默）」更新为「已留痕」。
- `CHANGELOG.md`：按核心规则 2 在**功能落地**时补条目（本次仅设计稿，不写）。
- `docs/dev/plans/backlog/`：P2 可重试入口若本次不做，落入 backlog 而非留在本文件。
