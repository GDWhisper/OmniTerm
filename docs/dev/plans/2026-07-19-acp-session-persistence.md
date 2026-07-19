# ACP Session 持久化与恢复方案

> 关联：`/home/pax/.qoder-cn/plans/crisp-wilderness-dove.md`（Phase 4 主 plan）
> 参考实现：`/home/pax/coding/research/obsidian-agent-client`（Obsidian Agent Client plugin）
> 状态：**设计定稿**，待实施

---

## 1. 背景与问题陈述

### 1.1 当前行为（2026-07-19 现状）

- 后端 `AcpSupervisor` 是进程内 `HashMap<String, Arc<AcpClient>>`，重启即清空
- `f868d66` 在 `main.rs` 启动期加了 `DELETE FROM sessions WHERE runtime_kind = 'acp'`（purge）
- 前端 localStorage 仍记着旧 `activeSessionId`，启动后往已死的 session 连 → supervisor miss → 报错横幅
- 前端 `chatStore` 是纯内存 Zustand，刷新即丢 — 即便 session 行还在，聊天记录也找不回

### 1.2 为什么 ACP 协议本可以支持持久化

ACP 协议（`agent-client-protocol` crate v1.2.0）原生支持 session 生命周期方法：

| 方法 | 稳定性 | 用途 |
|------|--------|------|
| `session/load` | **Stable** | 加载历史会话，agent 流式回放所有 `session/update` |
| `session/resume` | Unstable | 重连但不回放（客户端自己渲染历史） |
| `session/list` | Unstable | 列举历史会话（分页 + cursor） |
| `session/fork` | Unstable | 从现有会话分支出新的 |

capability 在 `initialize` 时协商（`agentCapabilities.loadSession` / `agentCapabilities.sessionCapabilities.{resume,fork,list}`）。sessionId 在 agent 侧持久稳定（只要 agent 自己有持久化 — 多数真实 agent 都有），**跨 agent 子进程重启仍然有效**。

参考项目（`obsidian-agent-client`）完整实现了这四个方法，验证了协议的可行性（详见 `src/acp/acp-client.ts:858-979`）。

### 1.3 设计目标

1. **重启不丢历史**：后端重启后，侧边栏 ACP 会话条目保留
2. **恢复有内容**：点进历史会话能看到之前的聊天记录（用户 prompt + agent 回复）
3. **可以继续对话**：在历史会话里发新 prompt，spawn 新 agent 子进程 + `session/load` 让 agent 恢复上下文，sessionId 不变
4. **用户可控**：恢复是显式动作（不自动触发），启动不卡

---

## 2. 架构决策

### 2.1 双重所有权（对齐参考项目）

参考项目的核心模式（`obsidian-agent-client/src/hooks/useSessionHistory.ts:542-576`）：

- **agent 侧**：`session/load` 时 agent 回放历史（真相在 agent）
- **客户端侧**：本地存一份（JSON / DB），优先用本地（suppress agent 回放）

本地优先的理由：
- 恢复更快（跳过网络回放）
- 本地可带 UI 元数据（`createdAt`、`streaming`、`updates` 数组）agent 不记录
- agent 若丢了历史（罕见但可能），客户端仍有 fallback

OmniTerm 采用同一模式：后端 `chat_messages` 表存一份，恢复时优先本地，agent 回放作为 fallback（仅当本地为空时采纳）。

### 2.2 存储粒度

**按"完整消息"存，不按"chunk"存**：
- `user` 消息：用户按下 Enter 时写一行
- `assistant` 消息：`prompt_done` 到达时，把累积的完整文本写一行
- `system` 消息（工具活动块 / 模式变更）：**不持久化**，重启后重新生成或丢弃

理由：
- 一次 prompt 可能产生几十到几百个 chunk，按 chunk 存会 IO 风暴
- `prompt_done` 之前后端崩溃 → 当前轮消息丢失 — 可接受（用户重发）
- 工具活动是高频状态流，存了也渲染不出有意义的历史（Phase 5 rich card 出来后工具状态才有独立字段）

### 2.3 恢复触发方式

**用户主动触发，不自动恢复**（对齐参考项目 UX）：
- 启动总是 `session/new`（快速进空态）
- 历史会话进侧边栏「历史」分组 / 弹窗
- 用户点 Restore → 走 `session/load` 流程

理由：
- `session/list` + `session/load` 有成本（agent 子进程 spawn + 历史回放）
- 自动恢复 N 个会话会让启动变慢
- 多数用户只想恢复一两个近期会话，全量恢复是浪费

### 2.4 与 purge 的关系

**短期**（Phase 4a 修 bug）保留 purge — 因为没有 session/load 之前，留 DB 行只是误导用户（点进去连不上也看不到历史）。

**长期**（Phase 6 落地后）**去掉 purge** — 此时 DB 行有意义了（有聊天记录、可以 session/load 恢复）。

---

## 3. 分阶段任务

### 3.1 短期：错误码链路（独立 bug 修复，~20 行）

**目标**：让"连到死会话"的体验从"卡住的报错横幅"变成"回到空态"。

| 编号 | 任务 | 文件 |
|------|------|------|
| B1 | 后端 `ws/acp.rs`：supervisor miss 时发 `{ type: "error", code: "session_not_found", message: "..." }` + WebSocket 关闭帧（1008 Policy Violation） | `src/ws/acp.rs` |
| B2 | 前端 `useAcpChat`：识别 `code === 'session_not_found'` → `appStore.setActiveSessionId(null)` + `chatStore.reset(sid)` | `frontend/src/hooks/useAcpChat.ts` |
| B3 | `main.rs` 启动期 purge 的 log 从 `warn!` 降为 `info!`（预期行为不报警） | `src/main.rs` |

验证：
- 重启后端 → 前端从 localStorage 恢复 activeSessionId → WS 连 → 后端拒 → 前端清空 → 用户看到空态（无报错横幅）
- `cargo check` + `npx tsc -b` + `pnpm lint` 全绿

### 3.2 Phase 5：聊天消息持久化 + 前端 hydration

**目标**：聊天记录跨刷新/重启不丢；侧边栏 ACP 条目保留；点进去能看到历史文本（但还不能发新 prompt，因为 session/load 还没实现）。

| 编号 | 任务 | 文件 |
|------|------|------|
| P5-1 | 新建 migration：`chat_messages` 表（`id`, `session_id FK`, `role`, `text`, `created_at`）+ index on `session_id` | `migrations/2026MMDD_chat_messages.sql`（新） |
| P5-2 | 后端 `chat_persistence` 模块：`insert_message` / `list_messages` / `delete_by_session` | `src/acp/chat_persistence.rs`（新） |
| P5-3 | 后端 WS handler（`ws/acp.rs`）：收到 `type: "prompt"` 时写 user 消息；收到 `session_update` 中的 `prompt_done` 时，把累积的 assistant 文本写一行 | `src/ws/acp.rs` |
| P5-4 | 后端 supervisor / AcpClient：维护 per-session 的 `pending_assistant_text: String` 缓冲区，chunk 到达时追加，`prompt_done` 时落盘并清空 | `src/acp/client.rs` / `src/ws/acp.rs` |
| P5-5 | 后端 REST：`GET /api/v1/sessions/:id/messages` 返回历史消息数组 | `src/api/sessions.rs` |
| P5-6 | 前端 `chatStore`：mount 时 fetch messages → hydrate（保留 streaming=false） | `frontend/src/stores/chatStore.ts` |
| P5-7 | 前端 `ChatView`：mount 时调 API 拉历史，写入 chatStore；WS 新消息正常 append | `frontend/src/components/Chat/ChatView.tsx` |
| P5-8 | **去掉启动期 purge** —— 此时 DB 行有意义了 | `src/main.rs` |
| P5-9 | 处理「agent 已死但 DB 行还在」：用户点进去只读历史、输入框禁用，提示"会话已结束，Restore 功能将在 Phase 6 上线" | `frontend/src/components/Chat/ChatView.tsx` |
| P5-10 | i18n `chat.session.ended` / `chat.session.restorePending` 文案 | `frontend/src/locales/{en,zh}/translation.json` |
| P5-11 | 文档：`docs/architecture/frontend.md` 更新 chatStore hydration 流程 | `docs/architecture/frontend.md` |

验证：
- 创建 ACP session → 聊几轮 → 刷新页面 → 看到完整历史（user + assistant 文本）
- 重启后端 → 侧边栏 ACP 条目保留 → 点进去看到历史 → 输入框禁用（不能发新 prompt）
- 删除 session → `chat_messages` 级联清理

### 3.3 Phase 6：完整 session resume（spawn + session/load + UI）

**目标**：用户可以在历史会话里点 Restore，spawn 新 agent 子进程 + `session/load`，agent 回放历史 + 可以继续对话。

| 编号 | 任务 | 文件 |
|------|------|------|
| P6-1 | 后端 `AcpClient` 加 `load_session(session_id)` 方法：发 `session/load` JSON-RPC，处理回放帧转发到 WS | `src/acp/client.rs` |
| P6-2 | capability 协商：`initialize` 响应解析 `agentCapabilities.loadSession` / `sessionCapabilities.{resume,list,fork}`，存到 `AcpClient` 字段 | `src/acp/client.rs` |
| P6-3 | supervisor `load(session_id, agent_id)` 入口：spawn 新 agent 子进程 + init + session/load；**关键**：spawn 后立刻把 AcpClient 插进 HashMap，**再**调 `session/load`（参考项目的 `currentSessionId` before await） | `src/acp/supervisor.rs`（新，从 `AcpSupervisor` 拆出） |
| P6-4 | WS 协议扩展：新增 client→server `type: "load_session"` 帧，server 调 supervisor.load 并把回放帧转发回 client | `src/ws/acp.rs` |
| P6-5 | WS 协议扩展：server→client 新增 `type: "replay_start"` / `type: "replay_end"`，前端据此 toggle `ignoreUpdates` 或切换到 replay 模式 | `src/ws/acp.rs` + `frontend/src/hooks/useAcpChat.ts` |
| P6-6 | 前端 `chatStore`：replay 期间 suppress chunk 写入（本地已有历史）或采纳（本地为空） — 参考 obsidian-agent-client `ignoreUpdatesRef` 模式 | `frontend/src/stores/chatStore.ts` |
| P6-7 | 前端 sidebar：历史分组（或 History 弹窗）→ 列出 agent 侧 `session/list` + 本地 chat_messages 合并的条目 | `frontend/src/components/Sidebar/Sidebar.tsx` 或 `frontend/src/components/Chat/SessionHistoryModal.tsx`（新） |
| P6-8 | 前端 Restore 按钮：调 `load_session` WS 帧 → 等待 `replay_end` → 解锁输入框 | `frontend/src/components/Chat/SessionHistoryModal.tsx` |
| P6-9 | capability fallback：agent 不支持 `session/load` 时，UI 显示"此 agent 不支持会话恢复"+ 仅读历史 | `frontend/src/components/Chat/ChatView.tsx` |
| P6-10 | 本地历史优先逻辑：fetch 本地 → 若存在，replay 时 suppress 写入（`ignoreUpdates=true`）；否则采纳 | `frontend/src/hooks/useAcpChat.ts` |
| P6-11 | 错误处理：`session/load` 失败（agent 丢了历史 / 不存在）→ toast + 回落到仅读本地历史 | `frontend/src/components/Chat/SessionHistoryModal.tsx` |
| P6-12 | i18n `chat.session.restore` / `restoreFailed` / `historyTitle` 文案 | `frontend/src/locales/{en,zh}/translation.json` |
| P6-13 | 文档：`docs/architecture/backend.md` ACP 模块追加 session lifecycle 章节；`docs/architecture/frontend.md` 追加 Restore 流程 | `docs/architecture/{backend,frontend}.md` |

验证：
- 创建 ACP session → 聊几轮 → 重启后端 → 侧边栏条目保留 → 点 Restore → agent spawn + session/load → 历史回放 → 可继续对话（sessionId 不变）
- agent 不支持 session/load → 仅读历史，Restore 按钮禁用
- agent 侧历史丢了（罕见）→ 本地历史仍显示，toast 提示
- `cargo check` + `npx tsc -b` + `pnpm lint` + `vitest` 全绿

---

## 4. 关键技术要点（实施时易错）

### 4.1 `currentSessionId` 必须在 await 之前赋值

参考项目踩过（`obsidian-agent-client/src/acp/acp-client.ts:895-896`）：

```typescript
// Set sessionId before await so replay updates pass the sessionId filter
this.currentSessionId = sessionId;
```

OmniTerm 等价位置：`supervisor.load` 必须在调 `AcpClient::load_session` **之前**把新 AcpClient 插入 HashMap，否则 `session/load` 处理期间到达的回放帧在 supervisor 里查不到 session → 被丢弃或被错误路由。

### 4.2 回放帧与实时帧共享同一套 SessionNotification 协议

不需要新增协议类型。`session/load` 触发的 `session/update` 通知和 `prompt` 触发的 `session/update` 是同一个类型。前端 `onmessage` 的 `extractTextChunk` / `classifySessionUpdate` 天然能处理。

唯一需要区分的是**回放期间是否写入 chatStore** — 通过 `replay_start` / `replay_end` 包裹来 toggle。

### 4.3 错误无重试

参考项目的设计选择：`session/load` 失败直接冒泡到 UI，toast 提示。OmniTerm 跟进这一模式，不加自动重试（重试可能让 agent 反复 spawn/kill，体验更差）。

### 4.4 本地历史优先

`chat_messages` 表有内容时，replay 期间 suppress 写入（避免重复）。`chat_messages` 为空时（比如 Phase 5 上线之前的历史会话），采纳 agent 回放写入。

判定条件：`replay_start` 到达时查 `chatStore.messages.length`，0 则采纳，否则 suppress。

### 4.5 `session/list` 与本地历史的合并

- agent 侧 `session/list` 返回 `{ sessionId, title, updatedAt }`
- 本地 `sessions` 表返回 `{ id, title, created_at }` + `chat_messages` 行数

合并策略：以 agent 侧 sessionId 为主键，本地 title 优先（"some agents return poor quality titles" — 参考项目 `useSessionHistory.ts:230`），本地 updatedAt 用 `MAX(chat_messages.created_at)` 补充。

缓存 5 分钟（参考项目 `CACHE_EXPIRY_MS = 5 * 60 * 1000`）。

---

## 5. 风险与未决

| 风险 | 影响 | 缓解 |
|------|------|------|
| agent 自身不持久化 session（少数 agent） | `session/load` 失败，无法恢复 | P6-9 capability fallback：仅读本地历史 |
| 大量 chunk 的 assistant 消息在 `prompt_done` 前崩溃 | 当前轮消息丢失 | 可接受 — 用户重发；或 Phase 5 之后考虑"定期 flush 部分文本"（复杂度高，先不做） |
| 用户 Restore N 个会话并发 | 后端 spawn N 个 agent 子进程 | supervisor 加并发上限（如同时 3 个 load），超出排队 |
| 本地历史与 agent 回放不一致 | 双重渲染 / 内容冲突 | 本地优先 + suppress agent 回放，永远只用一份 |
| `session/list` 返回大量条目 | UI 卡 / 网络开销 | 分页（cursor）+ 懒加载 + 5 分钟缓存 |

---

## 6. 时间预算估算

| 阶段 | 工作量 | 前置 |
|------|--------|------|
| 短期 bug 修（§3.1） | 1-2 小时 | 无，可立刻做 |
| Phase 5（§3.2） | 半天 | 短期 bug 修 |
| Phase 6（§3.3） | 1 天 | Phase 5 |

Phase 5 + 6 是连续依赖，建议同个工作块完成；短期 bug 修可以独立先做（让当前重启体验先干净下来）。

---

## 7. 参考项目关键文件索引

| 主题 | 文件 : 行 |
|------|----------|
| session/list 调用 | `src/acp/acp-client.ts:858-875` |
| session/load 调用 | `src/acp/acp-client.ts:901-917` |
| session/resume 调用 | `src/acp/acp-client.ts:941-957` |
| session/fork 调用 | `src/acp/acp-client.ts:975-991` |
| `currentSessionId` before await 关键点 | `src/acp/acp-client.ts:895-896`, `935-936` |
| sessionId 过滤器（回放帧必经） | `src/acp/acp-handler.ts:53-57` |
| 本地历史优先逻辑 | `src/hooks/useSessionHistory.ts:542-594` |
| 客户端本地消息存储格式 | `src/services/session-storage.ts:25-36` |
| Restore UI 入口 | `src/ui/SessionHistoryModal.tsx:367-372` |
| capability 字段定义 | `src/types/session.ts:611-626` |
| Restore 触发时序 | `src/hooks/useHistoryModal.ts:37-58` |
