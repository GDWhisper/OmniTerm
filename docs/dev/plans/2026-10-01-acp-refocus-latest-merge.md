# ACP 聚焦/可见性恢复时的最新消息补拉

> 状态：**已实施**（2026-10-01，实施与设计无偏差，验收清单全绿）
> 触发条件：修改 ACP 会话聚焦/可见性恢复时的历史补拉链路（`chatStore` 的 `needsCatchUp` / `mergeLatestMessages`、`useAcpChat` 断连标记、`ChatView` 补拉 effect）前**必读**
> 关联：`docs/dev/plans/2026-08-18-ghost-message-and-known-issues.md`（RAW 收敛与幽灵行家族）、`docs/dev/plans/2026-09-19-ws-idle-disconnect-heartbeat.md`（ACP WS 125s 断连实测）、`docs/dev/plans/2026-09-19-acp-failure-visibility.md`（P0-2「广播无补发」残余）、`docs/architecture/frontend.md`

## 背景

用户体感：agent 活跃中的 ACP 会话长期失焦后，聚焦回来聊天停留在旧内容，要等手动「恢复会话」（`load_session` 全量重放）或刷新页面才看到最新消息。

取证结论（讨论轮，2026-10-01）：

1. **ACP 链路没有「失焦即停跟踪」的显式开关**。`useAcpChat.ts` 无任何 `document.hidden` / `visibilitychange` 处理。失焦期 `session_update` 动作照常进 `liveBuffer`、seq 水位照常推进、`turnClock` 照常记账，只是 rAF 暂停不渲染；聚焦后 pending rAF 自动补刷——这部分是已成立且自愈的性能优化，**不在本计划范围**。
2. **真正让消息停更的是 WS 断连且无补发**：`2026-09-19-ws-idle-disconnect-heartbeat` Phase 0 实测 ACP WS 寿命稳定 125.2–125.4s（turn 有流量时也出现）、断开形态 `ResetWithoutClosingHandshake`；后端广播走 `tokio::sync::broadcast`（`src/ws/acp.rs` `spawn_notify_task`），**无回放语义**，离线窗口帧全部丢弃，DB 才是持久副本（累积器 250ms 防抖落库）。重连后 `hydrated` 已 true 不重拉（`ChatView.tsx:225` 跳过）、`load_session` 只由手动「恢复会话」触发 → store 永久陈旧，直到手动恢复或刷新。该残余即 `useAcpChat.turnfailure.test.tsx` 固化的「P0-2 既有残余（广播无补发）」的一般形态。
3. `turn_state(active=false)` 只把离线期间开始的半截 streaming 消息 `markDone`，**不补内容**。

## 范围与优先级

**P0（本计划全部）**：聚焦/可见性恢复 + 「本次页面生命周期内该会话发生过断连」两个条件同时满足时，自动 `GET /messages` 取最新一页，按 dbId 合并进 store；合并路径只读（另含 RAW 收敛回写，见 D5）。

**不纳入范围**：

| 排除项 | 理由 |
|---|---|
| focus/visible 时强制立即重连（跳过退避） | 维护者否决：用户在翻看历史时会被「全重连」打扰；且补拉不依赖 socket 状态——累积器独立于 WS 落库，socket 未恢复时 DB 同样最新 |
| 自动 `load_session` 重放 | 重放 agent 侧历史，与累积器行不保证一致（幽灵行家族根因），且全量昂贵；保留为手动「恢复会话」 |
| 服务端 per-session 环形缓冲补发 | 新增服务端状态 + seq 顺序账本（本项目「无校准增量必不自愈」教训同族设计），且与 DB 副本重复 |
| rAF/liveBuffer 隐藏期行为 | 已自愈，无需改动 |
| WS 心跳接入 | 属 `2026-09-19-ws-idle-disconnect-heartbeat` 计划，根因未判定前不写 |

## 设计决策 / ADR

### D1：触发条件 = refocus（visibilitychange→visible / window focus）AND 断连标记

**决策**：`useAcpChat` 的 `ws.onclose`（`!unmounted`，即非切会话/卸载的主动关闭）把该会话的 `chatStore.needsCatchUp` 置 true；`ChatView` 在挂载时与 `visibilitychange→visible` / `window focus` 时检查：`hydrated && !replaying && needsCatchUp` 才发一次 `GET /messages`（最新页，不传 cursor），成功后置回 false。fetch 失败保持 true，下次聚焦重试。

**理由**：维护者选定「发生过断连才刷（更省）」；纯聚焦不刷。断连标记只看本页面生命周期（chatStore 无 persist，刷新即清零，而刷新本身会重新 hydrate，语义自洽）。

**否决项**：无条件聚焦即刷——每次聚焦一次 2MiB 级请求，浪费；只看 `connectionState`——恢复中的退避窗口内 state 仍是 disconnected，无法区分「已恢复」与「从未断」。

**翻盘条件**：若将来接入心跳后断连几乎不再发生，本机制退化为纯兜底，可保留（成本已由标记门控）。

### D2：合并载体 = DB 最新页，不是协议重放

**决策**：`GET /api/v1/sessions/:id/messages`（不传 `before`）。后端按 500 行 / 2MiB 双预算切页 newest-first（`sessions.rs:653-658`），累积器 ≤1s 延迟落库，与 hydrate 首屏同一条路径、同一解码器（`toChatMessages`）。

**ACP 协议角度**：`session/update` 是纯直播通知，协议内没有「从 seq N 补发」；唯一 sanctioned 重放是 `session/load`，它重放 agent 侧历史，与累积器落库行不保证逐行一致（幽灵行根因），且全量昂贵——故 catch-up 不用它。

**翻盘条件**：若 ACP schema 未来引入服务端通知补发语义，可改为协议级 catch-up；届时 DB 合并可退化为兜底。

### D3：合并规则（五条，`chatStore.mergeLatestMessages`，全部有单测固化）

对 incoming 行（ oldest→newest ）逐条：

1. **`status === 'streaming'` 的行跳过**——进行中 turn 归 live 路径（`turn_snapshot` / live 帧）所有；DB 那份是防抖中的原始帧，覆盖它会丢 live cooked 结构并与后续帧打架。
2. **`dbId` 命中 store 已有行 → 原位替换**（DB 权威，含 blocks/text/durationMs）。
3. **user 行按「尾部无 dbId 的 optimistic echo」去重**：store 尾部消息 `role='user'`、无 dbId、非 `undelivered`、text 全等 → 视为同一条，用 DB 行替换（顺手补上 dbId / 图片 blocks），不新增气泡。
4. **assistant 行按「精确前缀」对账被中断的 turn**：store 尾部消息 `role='assistant'`、无 dbId、text 非空且是 DB 行 text 的**精确前缀** → 用 DB 行替换（该消息即断连前那半截）。前缀失配 → 按 createdAt 顺序插入为新消息（宁添不缺：丢内容比多一个气泡更糟；与 `prependEvictedProse` 的「失配宁缺勿错」同族——那条丢的是已渲染前缀，这条丢的是整轮正文，取舍不同故方向相反，**记录在此以免后人误统一**）。
   - 其余行一律按 `createdAt` 顺序插入（不区角色）。
5. **永不触发 sync 写回**（本路径读-only 于消息列表； RAW 收敛是唯一例外，见 D5）。

**为什么 rule 2 能覆盖绝大多数情况**：`prompt_done` 现在把 `row_id` 经 `markDone` 落到 store 消息的 `dbId`（本次改动），健康连接上结束的 turn 其 store 消息都带 dbId，合并即精确替换。无 dbId 的 assistant 只剩「turn 在断连期间结束」一种，恰是 rule 4 的目标场景。

**匹配键为什么不能用 text 泛化**：同 text assistant 行可合法多条（`2026-08-10` Phase 0 污染 bug：14 行 "OK"），text 相等不是身份。user echo 用 text 全等是安全的——用户 echo 只可能在「发送成功」后产生，与后端插入行一一对应；assistant 的前缀守卫是「store 无 dbId 尾部 + 前缀」双条件，不构成一般性 text 匹配。

**翻盘条件**：若观测到 rule 4 失配路径实际产生重复气泡（应留 warn？——否，先观测），再引入「DB 行 last_seq vs store 尾部」的 seq 级对账。

### D4：不碰滚动语义

追加/插入发生在消息尾部；用户上翻读历史时 `autoStick=false`，`pinToBottom` layout effect 不前移 `scrollTop`，视口不动；贴底时照常钉底。无新增代码。

### D5：合并行的 RAW 收敛（08-18 方案 B 的同源复用）

turn 在断连期间结束 ⇒ `prompt_done` 无人接收 ⇒ 该行停在原始帧包裹态（比 cooked 大两个数量级）。合并进来的完整行若 `rawStored`，落定后与 hydrate 路径同一处理：`storedRawRowToSyncPayload` 生成带 dbId 的 payload，POST `/messages/sync`（id 路径只 UPDATE 那一行 blocks，不 INSERT——幽灵行家族已固化）。只对本次合并涉及的行收敛，不全 store 扫描。

POST 封装从 `useAcpChat.postSync` 提取为共享 helper（`frontend/src/utils/syncMessages.ts`），两处调用点复用，禁复制粘贴（AGENTS §7①）。

## 实施分期

单 Phase（前后端一体，后端零改动）：

| 改动 | 文件 |
|---|---|
| `needsCatchUp` 状态 + `setNeedsCatchUp` + `mergeLatestMessages` 合并动作 | `frontend/src/stores/chatStore.ts` |
| `markDone` 增选参 `rowId`，定稿时落 dbId | `frontend/src/stores/chatStore.ts` + `frontend/src/hooks/useAcpChat.ts`（prompt_done 传 `frame.row_id`） |
| `ws.onclose`（!unmounted）置断连标记 | `frontend/src/hooks/useAcpChat.ts` |
| 挂载 + visibilitychange/focus 补拉 effect、RAW 收敛 | `frontend/src/components/Chat/ChatView.tsx` |
| 共享 sync POST helper | `frontend/src/utils/syncMessages.ts`（新） + `useAcpChat.postSync` 改为委托 |

## 验收标准

- [ ] store 单测：五条合并规则（替换/streaming 跳过/user echo 去重/前缀对账/失配插入）+ 空页 no-op + 幂等（合并两次终态一致）+ `createdAt` 排序插入
- [ ] store 单测：`markDone(sid, timing, rowId)` 落 dbId；不传 rowId 不清已有 dbId
- [ ] hook 集成测试：onclose（非 unmount）→ `needsCatchUp=true`；unmount 拆除不置位
- [ ] ChatView 集成测试：标记 + visible → 发一次 `/messages` 并合并、清标记；无标记 → 不发；fetch 失败 → 标记保留；`replaying` 中 → 不发
- [ ] `pnpm exec tsc -b` / `pnpm lint` / `pnpm test` 零新增问题
- [ ] 手动回归：`docs/reference/user-testing.md` 新增用例（§21）

## 风险与降级

| 风险 | 缓解 |
|---|---|
| 合并与 live 帧竞态（合并在飞时 turn_snapshot / live 帧到达） | rule 1 跳过 streaming 行；已完成行无 live 帧；终态由「最后落地者」决定，两条路径写同一 dbId 行，最终一致 |
| rule 4 失配 → 重复气泡 | 已论证取舍（宁添不缺）+ 记录翻盘条件；用户刷新即收敛 |
| 多 slot（`AcpConnectionManager` 给每个激活会话保 WS）同时补拉 = N×2MiB | 只对**当前展示会话**（ChatView 挂载者）补拉；其余会话只置标记不拉，切过去时 ChatView 重挂载 + 标记仍在 → 挂载时补拉一次 |
| RAW 收敛 POST 失败 | 与 08-18 方案 B 同容错（`.catch(() => {})`），下次 hydrate 仍会收敛 |
| hydrate 未落定就补拉 | effect 守卫 `hydrated`，且不抢跑 `preHydrateBuffer`（标记由断连产生，断连必在 hydrate 之后） |

## 文档闭环

| 文档 | 更新 |
|---|---|
| `docs/architecture/frontend.md` | 补拉机制、五条合并规则摘要、断连标记 |
| `AGENTS.md` 文档索引 | 本文件登记行 |
| `CHANGELOG.md` | feat 条目 |
| `docs/reference/user-testing.md` | §21 手动回归用例 |
| 本文件 | 实施偏差就地加「勘误」块 |
