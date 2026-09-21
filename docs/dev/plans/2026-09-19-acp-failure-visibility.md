# ACP 失败可见化与恢复重放收敛

> 状态：设计稿（2026-09-19）
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

- [ ] 后端单测：`end_turn` 不写入 system 消息；`refusal` / 未知值写入且只写一条（重复定稿不重复写）。
- [ ] 前端单测：`prompt_done{stop_reason:'refusal'}` 呈现失败提示且 `attention` 走 error（不复用 done）。
- [ ] 前端集成测试：失败发生时 WS 离线 → 重连 hydrate 后失败提示仍可见（覆盖 P0-2）。
- [ ] 手动回归：`docs/reference/user-testing.md` 增补「agent 侧失败可见」用例（用可稳定复现的 `${expr}` Bash 命令构造，见协议参考 §6.8）。
- [ ] 质量门禁：`cargo clippy -D warnings` / `tsc -b` / `pnpm lint` 零新增告警。
- [ ] 正式库核对：新发生的非正常结束在 `chat_messages` 中留下 `role='system'` 行，且不再出现「turn 定稿但无任何提示」。

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 判定口径过宽导致噪音（把 `max_tokens` 之类当成失败） | D1 白名单 + P2 之前不弹窗、只留痕 |
| system 消息与 assistant 行排序错位 | 实现时在 `created_at` 上显式串行并在测试中断言顺序 |
| 未知 stopReason 文案无 i18n key | 沿用 reaper system 消息约定（2026-09-21 起为 `label` 存 i18n key + `detail` 结构化载荷）：未命中 key 原样显示 |

## 文档闭环

- `docs/reference/acp-protocol-reference.md` §6.8：本计划落地后把「宿主现状（静默）」更新为「已留痕」。
- `CHANGELOG.md`：按核心规则 2 在**功能落地**时补条目（本次仅设计稿，不写）。
- `docs/dev/plans/backlog/`：P2 可重试入口若本次不做，落入 backlog 而非留在本文件。
