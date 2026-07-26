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
│   ├── appStore.ts      # Zustand: layout, projects, sessions, font size, mobile detection
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   ├── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
│   ├── agentStore.ts    # Zustand: agent registry (Phase 3 — static catalog, no live state)
│   ├── gitStore.ts      # Zustand: git panel status/branches + mutate 串行化 + refreshHint（设计见 docs/dev/plans/2026-07-26-git-panel.md）
│   └── chatStore.ts     # Zustand: per-session chat state (Phase 4a — state-only; WS in useAcpChat)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size
│   ├── useMediaQuery.ts # Mobile breakpoint detection
│   ├── useFileWatcher.ts # SSE file watcher for live directory updates
│   └── useAcpChat.ts    # Phase 4a: ACP WS lifecycle → chatStore actions
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
├── utils/               # 共享纯函数（path.ts, fonts.ts, agentAggregate.ts 会话组状态聚合 blocked>done>working——tmux agent_state 与 ACP chatStore 派生状态在此归一, …）
└── components/
    ├── Layout/  — Layout.tsx, MobileNav.tsx
    ├── Sidebar/ — Sidebar.tsx
    ├── Terminal/ — Terminal.tsx
    ├── Chat/ — ChatView.tsx, ChatMessage.tsx, ChatInput.tsx (Phase 4a: ACP session rendering)
    ├── AgentPicker/ — AgentPicker.tsx (Phase 3: <select> for create-session modal)
    ├── FileManager/ — FileManager.tsx, FileDrawer.tsx, FileEditor.tsx, FilePreview.tsx, icons.tsx（纯内容组件，标题栏/折叠归 RightPanel）
    ├── RightPanel/ — RightPanel.tsx（右栏容器：FILES | GIT 标签、统一标题栏、折叠 rail；两 tab 常挂载 display 切换）
    ├── GitPanel/ — GitPanel.tsx（分支/远端操作 + CHANGES|HISTORY + 底部提交框）, GitDrawer.tsx（diff/commit 抽屉）, DiffView.tsx, diffParser.ts（unified diff 解析）
    ├── Settings/ — Settings.tsx, SettingsPopup.tsx, AgentSettings.tsx
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
prompt_done → markDone (sending: false) → syncToDb →
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

