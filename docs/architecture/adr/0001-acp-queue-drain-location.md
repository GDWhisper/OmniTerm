# Drain the ACP chat queue inside `useAcpChat`, not `ChatView`

The queued follow-up must auto-send as soon as the current in-flight prompt
finishes. We chose to fire that send from `useAcpChat`'s WebSocket
`onmessage` handler (the `prompt_done` branch, immediately after
`markDone`) instead of from a `useEffect` in `ChatView` watching the
`sending: true → false` transition. The deciding factor is that the drain is
a *one-shot reaction to a WS lifecycle event*, not a derived state — and
React-state-driven detection of "sending just flipped" is fragile
(strict-mode double-fires, missed transitions during effect re-runs) for a
cost that is not justified by the decoupling benefit.

## Considered options

- **`useAcpChat` `onmessage` handler (chosen)** — drain inside the existing
  `case 'prompt_done':` block, after `markDone` and `syncToDb`. Reads
  `useChatStore.getState()` to get the freshest `queuedMessage`, calls
  `addUserMessage` + `ws.send` + `beginPrompt` in the same microtask.
- **`ChatView` `useEffect` watching `sending`** — set up a ref to track the
  previous `sending` value, fire drain when `prev && !current &&
  queuedMessage`. Decouples `useAcpChat` from the queue concept.
- **`useAcpChat` returns an `onPromptDone` callback** — `ChatView` injects
  the drain logic via the hook's return value. Cleanest separation, but
  introduces a callback indirection for one consumer.

## Why we rejected the alternatives

`ChatView` `useEffect` requires a `useRef` to detect the
`true → false` transition. React 18 strict mode double-fires effects in
dev, and any future refactor that touches the ref's update site risks
missing the transition (e.g. if a new state path bypasses the ref). For
a single call site, the ref-based detector is more surface area than the
direct call.

`useAcpChat` `onPromptDone` callback adds an abstraction for one consumer
(YAGNI). If a second consumer ever appears (e.g. a sidebar status
indicator reacting to prompt completion), introducing the callback at
that point costs nothing.

## Consequences

- `useAcpChat` is now aware of `chatStore.queuedMessage` — a small
  coupling increase. The hook already owns the entire ACP WS lifecycle and
  the `markDone`/`markError`/`beginPrompt` actions, so this fits its
  existing role.
- Drain logic is inlined rather than calling the `sendPrompt` `useCallback`
  (which is declared *after* the `useEffect` that contains the handler).
  The inlined version mirrors `sendPrompt`'s body (addUserMessage →
  ws.send → beginPrompt). If `sendPrompt` ever grows new side effects
  (e.g. metrics, toasts), the drain site must be updated in parallel.
  A test in `useAcpChat` covering the drain path would prevent drift.
- The `ws.onclose` branch also reads `queuedMessage` to write the
  undelivered marker. Both sites share the same rationale: WS lifecycle
  events are the only correct trigger for queue transitions, and they
  both live in `useAcpChat`.
