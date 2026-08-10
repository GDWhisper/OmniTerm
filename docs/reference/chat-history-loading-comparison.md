# 聊天历史加载：参考实现对比

调研日期 2026-08-10。对象与版本：`claudecodeui` @ `015e892`（**AGPL-3.0-or-later，只看设计不抄代码**）、`openchamber` @ `83acecde`（MIT）。

背景：OmniTerm 的 `GET /sessions/{id}/messages` 已改为游标分页（见 `docs/architecture/backend.md`）。本文记录两个同类项目的做法、**它们与我们的处境差异**，以及待借鉴项。

## 最重要的结论：正文限界这件事没有先例可抄

**两个项目都没有对消息正文做存储层截断**，但原因不是他们找到了更优雅的办法，而是**他们没有这个问题**：

| | 谁拥有聊天历史的写入端 | 于是「单条消息能多大」由谁决定 |
|---|---|---|
| claudecodeui | 不拥有 —— 只读 Claude Code 写的 `~/.claude/projects/**/*.jsonl` | Claude Code |
| openchamber | 不拥有 —— 由上游 opencode server 托管，客户端经 SDK 取 | opencode server |
| **OmniTerm** | **拥有** —— `turn_accumulator` 自己累积并写 SQLite | **我们自己** |

所以 `turn_accumulator` 的 `text` 列无界累积（`st.text.push_str()`）是我们独有的责任，抄不到答案，阈值和截断策略只能自己定。同理 `MESSAGES_PAGE_MAX_BYTES`（每页字节预算）在两者中都不存在——**因为它们都只是客户端，只能传 `limit` 条数，无法按字节切页**。拥有服务端是我们的优势，不是多余的复杂度。

## 分页策略对比

| 维度 | claudecodeui | openchamber | OmniTerm |
|---|---|---|---|
| 分页方式 | `offset` + `limit` 数组切片（`claude-sessions.provider.ts:188-190`） | `limit` + `before` 游标，游标从响应头 `x-next-cursor` 取（`session-message-loader.ts:588,610`） | `limit` + `before` 复合游标 `(created_at, id)` |
| 首屏页大小 | 20（`useChatSessionState.ts:13`） | 50，受限运行时（VSCode / mobile）30（`session-message-loader.ts:21-22`） | 100 |
| 往前翻页 | 20/页 | 100/页（`session-message-loader.ts:23`） | 100/页 |
| 字节预算 | 无 | 无 | 2 MiB/页 |
| 触顶阈值 | `scrollTop < 100`px（`useChatSessionState.ts:386`） | **1.5 个视口高度**（`MessageList.tsx:85,991`） | 200px |

**claudecodeui 的 offset 分页是反面教材**：`ln()` 先把整个 jsonl 读进内存并排序，再 `slice(total-offset-limit, total-offset)`（`claude-sessions.provider.ts:180-190`）。分页只减少了传给前端的量，没减少读取+解析的量；且 offset 从最新端计数，新消息到来后同一 offset 指向不同消息。我们选游标而非 offset 正是为避开这两点。

## 值得借鉴的三个机制

1. **触顶滞后锁（hysteresis）** — claudecodeui 用 `topLoadLockRef`，且要求 `scrollTop > 20` 才解锁（`useChatSessionState.ts:407`）。我们目前只有 `loadingHistory` 防重入：请求落定后若用户仍停在顶部，下一个滚动事件会立刻触发下一页，**连续翻页可能失控**。
2. **阈值用视口比例而非固定像素** — openchamber 的 `HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5`（`MessageList.tsx:85`）。固定 200px 在大屏/小字号下相当于很短的距离，在手机上又偏长。
3. **加载窗口与渲染窗口分离** — claudecodeui 的 `INITIAL_VISIBLE_MESSAGES = 100` 独立于每页 20 条，`visibleMessageCount` 控制渲染多少条（`useChatSessionState.ts:14,118`）。我们目前加载多少就渲染多少。

## openchamber 的两个精细设计（移动端相关）

- **首屏页扩张至包含一条 user 消息**：先取 50 条，若该页既未取完历史又不含任何 user 消息，则依次扩张到 100、150（`INITIAL_PAGE_EXPANSION_LIMITS`，`session-message-loader.ts:24,531-551`），**且在找到边界前不 commit**（`deferFirstCommit`）。理由：首屏若只有 assistant 回答而看不到对应提问，上下文是断裂的，用户看不懂。纯条数/字节预算切页会产生这种断头页。
- **惯性滚动期间推迟前插落地**：触摸手势活跃且不在近顶部时，前插的新内容先 hold，等滚动静止 `HISTORY_PREPEND_QUIET_MS = 160` 后再落地，最多推迟 `HISTORY_PREPEND_MAX_HOLD_MS = 1500`，用 90ms 轮询检测静止窗口（触摸惯性没有完成事件可 await）（`MessageList.tsx:83-86,996-1028`）。这是移动端专属问题：惯性滑动中途改变内容高度会跳飞。

## 分页架构的必然代价：搜索需要全集

claudecodeui 在「跳转到搜索命中的历史消息」时不得不 `limit: null` 全量加载并 `setVisibleMessageCount(Infinity)`，还硬编码 `setTimeout(300)` 等渲染完成（`useChatSessionState.ts:636-650`）。我们将来做历史搜索会撞上同一个问题——**搜索要么在服务端做（返回命中位置的游标，然后定向翻页），要么被迫全量加载**。前者是正确方向，记在这里以免届时重新踩。
