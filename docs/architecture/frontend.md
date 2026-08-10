# Frontend Architecture

React (Vite + TypeScript) frontend. Source under `frontend/src/`.

## Source Tree

```
src/
├── main.tsx, App.tsx, index.css
├── version.ts           # Single source of truth for version
├── i18n.ts              # i18n configuration
├── api/client.ts        # Typed fetch wrapper for all API endpoints
├── stores/
│   ├── appStore.ts      # Zustand: layout, projects, sessions, font size, mobile detection + 断连/回收超时（分钟，可配置）
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   ├── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
│   ├── agentStore.ts    # Zustand: agent registry (Phase 3 — static catalog, no live state)
│   ├── gitStore.ts      # Zustand: git panel status/branches + mutate 串行化 + refreshHint（设计见 docs/dev/plans/2026-07-26-git-panel.md）
│   └── chatStore.ts     # Zustand: per-session chat state (Phase 4a — state-only; WS in useAcpChat)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size + blur/idle 断连定时器（分钟可配）
│   ├── useMediaQuery.ts # Mobile breakpoint detection + useKeyboardHeight/useIsLandscape
│   ├── useFileWatcher.ts # SSE file watcher for live directory updates
│   ├── useAcpChat.ts    # Phase 4a: ACP WS lifecycle → chatStore actions
│   └── useStickScroll.ts # 流式内容滚动锚定（stick-to-bottom）：默认钉底、上翻解除、滚回恢复（ChatMessage thinking/工具块）
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
├── utils/               # 共享纯函数（path.ts, fonts.ts, agentAggregate.ts 会话组状态聚合 blocked>done>working——tmux agent_state 与 ACP chatStore 派生状态在此归一, imageAttachment.ts 聊天图片附件处理——mime 白名单/canvas 降采样/5MB 硬限, atReference.ts 聊天 @ 文件引用 token 检测/替换——与后端 extract_at_paths 语义对齐, touchScroll.ts 移动端终端触摸滚动桥（纵向 drag→合成 wheel）, swipe.ts 移动端滑动切 tab 手势判定, haptics.ts 触觉反馈, sessionNav.ts 会话循环切换, …）
└── components/
    ├── Layout/  — Layout.tsx, MobileNav.tsx
    ├── Sidebar/ — Sidebar.tsx（列表渲染+状态提升，≤800 行）、ProjectCard.tsx（项目树渲染）、Create{Project,Session,Worktree}Modal.tsx、Rename/Delete{Confirm,Worktree}/ReleaseConfirm/RepairPath 对话框、ExternalSessionsSection.tsx（外部会话轮询+adopt）、DuplicateProjectsDialog.tsx、UpdateBadge.tsx、RowActionButtons.tsx（含 SidebarBottomButton）、sidebarModalStyles.ts、useAgentAttentionPolling.ts
    ├── Terminal/ — Terminal.tsx
    ├── Chat/ — ChatView.tsx, ChatMessage.tsx, ChatInput.tsx (Phase 4a: ACP session rendering), FileLocationLink.tsx（agent 上报的文件路径 → 点开 FM 抽屉；内部走 `getState()`，不动 ChatMessageView props）
    ├── AgentPicker/ — AgentPicker.tsx (Phase 3: <select> for create-session modal)
    ├── FileManager/ — FileManager.tsx, FileDrawer.tsx, FileEditor.tsx, FilePreview.tsx, icons.tsx（纯内容组件，标题栏/折叠归 RightPanel）
    ├── RightPanel/ — RightPanel.tsx（右栏容器：FILES | GIT 标签、统一标题栏、折叠 rail；两 tab 常挂载 display 切换）
    ├── GitPanel/ — GitPanel.tsx（分支/远端操作 + CHANGES|HISTORY + 底部提交框）, GitDrawer.tsx（diff/commit 抽屉）, DiffView.tsx, diffParser.ts（unified diff 解析）
    ├── Settings/ — Settings.tsx, SettingsPopup.tsx, AgentSettings.tsx（SessionsSection 含三个断连/回收滑块，复用 DisconnectSlider 组件）
    ├── TmuxCheatsheet/ — TmuxCheatsheet.tsx (render), TmuxCheatsheetPopup.tsx (popup), data.ts (command list, single source of truth — 增/删/改命令改本文件 + 两个 translation.json；维护指引见 data.ts 顶部 JSDoc)
    ├── Icons/ — GitBranchIcon.tsx, KeyboardIcon.tsx
    ├── Modal/ — Modal.tsx, ConfirmDialog.tsx
    └── Toast/ — Toast.tsx
```

## Key Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Vite proxy: `/api` → backend port (varies by branch `.env.local`)

## React Hooks 约定（强制）

> 背景：曾因 `useCallback` 定义晚于引用它的 `useEffect` 触发 TDZ `ReferenceError`，
> 导致 `FileManager` 组件白屏（见 `FileManager.tsx` 修复记录）。以下规则用于从根上避免此类问题。

1. **`useCallback` / 普通 handler 必须定义在使用它的 `useEffect` 之前。**
   `useEffect` 的依赖数组在 render 阶段就会被求值以构造数组，若其中引用的
   `const` 尚未初始化（定义在其下方），会抛 `Cannot access 'X' before initialization`。
   即使该 handler 当前不在依赖数组里，也要保持"先定义、后引用"的顺序，防止后续为满足
   `exhaustive-deps` 把 handler 加进依赖数组时引爆 TDZ。
2. **依赖数组必须完整**：effect / `useCallback` 内引用的每个响应式值都要列入依赖数组，
   开启 `react-hooks/exhaustive-deps`；确需排除时必须写注释说明原因，禁止静默关闭。
3. **默认不 memoize**：`useMemo` / `useCallback` 只在以下情况使用——
   (a) 值传给 `React.memo` 子组件且 identity 敏感；(b) 值本身是另一个 hook 的依赖；
   (c) 计算经 profiling 确认昂贵。过早 memoize 增加噪音、掩盖 bug。
4. **hook 调用集中在组件顶部、任何条件逻辑之前**；禁止在循环 / 条件 / 嵌套函数 / 提前 return 之后调用。
5. **effect 只用于同步外部系统**（订阅、浏览器 API、第三方库），不用于派生状态、
   数据转换、通知父组件（应在事件处理中调用）。
6. 每个订阅 / 定时器 / 事件监听 / 在途请求都必须在 cleanup 中释放，避免内存泄漏与竞态。

## 提取决策：共享函数 vs 自定义 Hook

当多处出现相同逻辑时，选择正确形式提取：

| 判别条件 | 共享函数 (`utils/`) | 自定义 Hook (`useXxx`) |
|---|---|---|
| 纯计算 / 数据转换 / 格式化 | | |
| 不含 React API（`useState`/`useEffect`/ref） | | |
| 含 `useState` / `useRef` / `useEffect` 任一 | | |
| 含 DOM 事件监听或浏览器 API 订阅 | | |
| 多组件复用且需要封装组件生命周期 | | |

**判断流程**：

1. 这段逻辑需要 React 运行时吗（状态/副作用/ref）？
   - 不需要 → 共享函数
   - 需要 → 进第 2 步
2. 这段逻辑只在一个组件用，还是多处复用？
   - 单组件 → 留在组件内（不违反奥卡姆剃刀）
   - 多处 → 自定义 hook

> 此规则与工程准则"禁 Copy-Paste"（必须提取）和"奥卡姆剃刀"（不过度抽象）协同 ——
> 重复代码必须提取，但形式由以上条件决定；单一组件内的 Hook 级逻辑不必急于抽出。

## 断连 / 空闲回收超时（可配置）

设置 → 会话（`Settings.tsx` 的 `SessionsSection`）三个 range 滑块把三类超时提为可调（值域 1..60 分钟，`WARNING_THRESHOLD_MIN=30`，≥30 时显示内存占用警告）：

| 滑块 | store 字段 | 默认 | 持久化 |
|------|-----------|------|--------|
| ACP 空闲回收 | `acpIdleRecycleMin` | 5 | 后端 settings 表（`PUT /api/v1/settings/acp-idle-recycle`），onChange 调 `api.setAcpIdleRecycle` |
| tmux 失焦断连 | `blurDisconnectMin` | 10 | localStorage `omniterm_blur_disconnect_min` |
| tmux 空闲断连 | `idleDisconnectMin` | 15 | localStorage `omniterm_idle_disconnect_min` |

- **store 层**（`appStore.ts`）：导出 `MIN_DISCONNECT_MIN=1` / `MAX_DISCONNECT_MIN=60`；三个字段各有 setter，`blurDisconnectMin`/`idleDisconnectMin` 从 localStorage 读取并 clamp 到值域（非法回退默认），`acpIdleRecycleMin` 为纯内存（不跨重启）。
- **消费方**（`useTerminal.ts`）：删除 `BLUR_DISCONNECT_DELAY_MS`/`IDLE_DISCONNECT_DELAY_MS` 常量，blur/idle 断连定时器改从 store 读分钟值 ×60_000；acpIdleRecycleMin 仅在前端渲染（后端 reaper 消费秒级阈值，见 backend.md Settings 表）。
- **滑块组件**（`Settings.tsx`）：`DisconnectSlider` 为共享 range 滑块（title/hint/warning 三文案 + value/onChange/onCommit），三个用例复用同一组件；ACP 滑块 onCommit 调 `api.setAcpIdleRecycle(n)` 持久化。
- **API client**（`client.ts`）：`getAcpIdleRecycle()` / `setAcpIdleRecycle(minutes)` 对应后端 `GET/PUT /api/v1/settings/acp-idle-recycle`。

## ACP Chat View (Phase 4a)

Session pane splits on `Session.runtime_kind`:

| runtime_kind | Component | Transport |
|--------------|-----------|-----------|
| `tmux` | `components/Terminal/Terminal.tsx` | xterm.js + `/api/v1/ws/terminal/{id}` |
| `acp` | `components/Chat/ChatView.tsx` | React DOM + `/api/v1/ws/acp/{id}` |

The dispatcher lives in `components/Layout/Layout.tsx::SessionView` — it
reads `activeSession.runtime_kind` and renders the matching view. Both
desktop and `MobileContent` use it, so the same session opens the same
view regardless of viewport. The wrapper `key={activeSessionId}` forces
a full remount on session switch, giving each view a clean WebSocket
lifecycle without any explicit teardown logic.

### State / connection split

`chatStore.ts` is **state-only**: a `Record<sessionId, ChatSessionState>`
holding messages, `sending`, `error`, `mode`, and the queued follow-up
slot (`queuedMessage`). It has no WebSocket or HTTP dependencies —
actions (`appendChunk`, `pushSystemEvent`, `beginPrompt`, `markDone`,
`markError`, `enqueueMessage`, `clearQueuedMessage`,
`addUndeliveredMessage`) are called by `useAcpChat.ts`, which owns the
socket lifecycle and translates `ServerFrame` into store actions.

This split serves three purposes:
1. Testability — the store is trivially unit-testable in isolation.
2. Multiple views (desktop + mobile) can share one slice without
   duplicating sockets.
3. Phase 4b's `PermissionModal` can plug into the same store without
   rewriting connection code.

### Queued follow-up (N=1 single slot)

While the agent is busy (`sending: true`), the input box stays editable.
The user can type a follow-up message and press Enter; instead of
interrupting the current prompt, the message is held in
`chatStore.states[sid].queuedMessage` (a single-slot buffer). When the
in-flight prompt completes (`prompt_done` from the WS), `useAcpChat`
drains the queue in the same microtask:

```text
prompt_done → flushLiveBuffer → markDone (sending: false) → inProgressSeq=null →
  if (queuedMessage) {
    clearQueuedMessage → addUserMessage → ws.send('prompt') → beginPrompt
  }
```

User affordances (N=1 + auto-drain semantics):

- **Chip above input** — `Next: <preview 40 chars> ✕`. Always visible
  while the queue is non-empty. ✕ calls `clearQueuedMessage`.
- **Dual buttons during busy** — `Cancel` (red, kills in-flight) +
  `Queue` (accent, submits to queue). Queue is disabled when the slot is
  full (N=1) or when the textarea is empty.
- **Auto-drain on `prompt_done`** — no grace window, no edit-in-queue.
  Once queued, the message is committed to the next slot.
- **F5-friendly** — the queue is mirrored to `sessionStorage` under
  `omniterm_chat_queue:{sid}` and rehydrated on `ChatInput` mount. Per
  Q6, sessionStorage is per-tab; multi-tab same-session views each
  maintain their own queue.
- **Disconnect leaves a trail** — if the WebSocket closes while the queue
  is non-empty, `useAcpChat` writes an `undelivered: true` user message
  to the in-memory message list (not persisted to DB) and clears the
  queue. The user sees a dashed-border "not delivered — connection lost"
  card in the stream and can decide whether to retype.

The drain location rationale is recorded in
`docs/adr/0001-acp-queue-drain-location.md`. Domain glossary lives in
`CONTEXT.md`.

### Session update parsing

The ACP crate's `SessionNotification` wire format isn't pinned in
Phase 4 — `useAcpChat.extractTextChunk` handles two plausible serde
shapes for `AgentMessageChunk`:
```
{ "AgentMessageChunk": { "content": { "Text": { "text": "..." } } } }
{ "AgentMessageChunk": { "text": "..." } }
```
Other variants are pushed as generic `system` messages labelled by the
top-level key (`ToolCall`, `Plan`, `CurrentModeUpdate`, …). Phase 5
will tighten the types once fixture captures from a real agent exist,
and render rich cards instead of the current text-only fallback.

### Backend-authoritative persistence & reconnect

消息真相源在后端（见 backend.md turn accumulator）。前端只 hydrate + 无缝续接，不再在 `prompt_done` 回写 assistant turn。

- **hydrate 还原**：`ChatView` mount 时 `GET /messages` 取**最近一页**（后端按条数 + 字节双预算切页，见 backend.md）；`decodeStoredBlocks`（导出自 `useAcpChat`）识别 blocks 列——数组=cooked `ContentBlock[]` 直用，`{"v":1,"frames":[...]}`=原始帧则复用 live 分类器 `classifySessionUpdate(normalizeSessionUpdate(frame))` + `buildReplayMessages` 还原成结构化 blocks（streaming 与 complete 行同源，杜绝 TS/Rust 双份分类）。`status==='streaming'` 映射为 `ChatMessage.streaming`。落定后 `setHydrated(sid, true)`。DB 行→`ChatMessage` 的转换集中在 `toChatMessages`，首屏与上拉分页共用。
- **上拉加载更早历史**：`historyCursor`（后端 `nextCursor`，`null` = 已到开头，**唯一信号源，不另存 hasMore**）+ `loadingHistory`（防重入）。滚到距顶 `TOP_LOAD_THRESHOLD_PX` 内且容器真的可滚动时拉下一页 → `prependMessages`（按 id 去重，单次 `set()` 提交消息+游标+清 in-flight）。**前插必须补偿滚动位置**：前插前记 `scrollHeight`，`useLayoutEffect` 里把差值加回 `scrollTop`（绘制前改，否则闪一帧跳动）。只在可滚动时触发是必要的：内容不足一屏时 `scrollTop` 恒为 0，会在 `autoStick` 仍为 true 时自动拉取并被贴底逻辑拽回底部。`commitReplay`（手动 restore）重建的是 agent 侧完整历史，故显式置 `historyCursor: null`。
- **每会话只 hydrate 一次**：`hydrated` 为 true 则直接跳过 `GET /messages`。该接口全量下发 blocks 列（单 turn 可达百 KB 级，存量旧行更大），而 `hydrate` 本身有「messages 非空即 bail」守卫——重复拉取的结果会被整份丢弃，白付一次传输 + `JSON.parse` + 逐条 `decodeStoredBlocks`（实测曾使切会话阻塞 ~0.5s）。跳过安全的依据：切会话不拆 WS（`AcpConnectionManager` 持久 slot），live 帧持续进 store；`commitReplay` 重建条目时刻意保留 `hydrated`；`chatStore` 无 persist，刷新页面 `states` 清空→`hydrated` 回 false 自然重拉。
- **hydrated 门控**：`GET /messages` 落定前，会改动消息列表的帧（`session_update`/`turn_snapshot`/`turn_state`/`prompt_*`，见 `HYDRATE_GATED_FRAMES`）先入 `preHydrateBuffer`，避免抢在 hydrate 前建消息导致 hydrate 因 `messages` 非空而 bail（丢历史）；落定后经 `frameHandlerRef` 按序回放。重连（无 remount）时 `hydratedRef` 已 true，帧即时派发。
- **turn_snapshot / turn_state**：连接时后端先发 `turn_state{active}` 再（active 时）发 `turn_snapshot{row_id, text, blocks, seq}`。`applyTurnSnapshot` 按 `row_id` 替换/收编在建 streaming 消息，并把 `inProgressSeq` 水位置为快照 seq。`turn_state{active:false}` 定稿残留 streaming 消息。
- **seq 去重**：live `session_update` 帧带 `seq`；`inProgressSeq != null && frame.seq <= inProgressSeq` 时丢弃（subscribe-before-snapshot 的重叠重复帧已体现在快照里），否则应用并推高水位。`prompt_done` 清空水位，下一 turn 从零开始。
- **自动重连**（`useAcpChat`，仿 `useFileWatcher`）：WS 连接逻辑封装进 `connect()`，`onclose` 非主动拆除（`unmounted` 区分 session 切换/卸载 vs 网络断）时按指数退避 `min(1000 * 2**retry, 30000)`（1→2→4→8→cap 30s）`setTimeout(connect)`，`onopen` 成功归零 `retry`。陈旧 socket（`wsRef.current !== ws`）的迟到 `onclose` 早返避免重复调度。重连**不重发** `load_session`（保持手动 `restore()` 语义，`suppressReplay`/`isManualRestore` 不受影响），进行中 turn 由 `turn_snapshot`/`turn_state` 续接；cleanup 清 timer + 关 socket。保留原有断连时 `sending→error` 与 `queuedMessage→undelivered` 留痕。
- **syncToDb 现仅用于 `load_session` 重放路径**（进程死亡恢复 `restore()`）——累积器不持久化重放帧，故重放重建的历史仍经 `messagesToSyncPayload` 非破坏性写回 DB。`prompt_done` 不再调用它。

