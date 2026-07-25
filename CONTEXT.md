# ACP Chat

Per-session state for the Agent Client Protocol (ACP) chat pane. The pane
spawns an agent subprocess over stdio ndJSON, multiplexes streamed `session_update`
frames into a structured message list, and lets the user steer the agent via
prompts. The current document scopes only the **queued follow-up** feature
introduced alongside this file — broader chat-pane glossary lives in
`docs/architecture/frontend.md` and the ACP wire format in
`docs/architecture/backend.md`.

## Language

**Queued follow-up**:
A user-typed message that has been submitted (Enter) while the agent is busy
and is held in a single-slot buffer until the current in-flight prompt
finishes. Drained automatically; never crosses the WS on its own.
_Avoid_: "draft", "pending message" (the user-facing draft is the textarea
content; the queue is post-submit, pre-send).

**Queue slot**:
The N=1 storage cell that holds a queued follow-up. Always a single string
or `null`. Identified by `sessionId` in the store; mirrored to
`sessionStorage` under `omniterm_chat_queue:{sessionId}`.
_Avoid_: "outbox", "staging" (overloaded terms from other systems).

**Drain**:
The act of sending the queued follow-up to the agent. Triggered by
`useAcpChat` inside the `prompt_done` branch of the WebSocket `onmessage`
handler, immediately after `markDone`. Drained in the same microtask, so
the UI never shows a "busy + empty queue" intermediate state.
_Avoid_: "flush", "pop" (the buffer is single-element, not a list).

**Chip**:
The UI element above the ChatInput textarea that previews the queued
follow-up (40-char preview + ✕ withdraw button). Rendered only when the
queue slot is non-null. Distinct from the message stream — the chip is
**uncommitted UI state**, not a history entry.
_Avoid_: "toast", "notification" (chip is persistent until cleared/drained).

**Undelivered marker**:
A `ChatMessage` with `undelivered: true`, written to the in-memory message
list when the WebSocket closes while a queued follow-up is still pending.
Surfaces the lost text to the user so they can decide whether to retype.
Lives only in the chatStore (not persisted to DB) and disappears on session
remount.
_Avoid_: "ghost message", "failed message" (the message wasn't attempted —
it was queued, never sent).

**In-flight**:
A prompt that the user has submitted, the agent has accepted, and for which
no `prompt_done` or `prompt_error` has arrived yet. Modeled as the boolean
`ChatSessionState.sending`. The in-flight is mutually exclusive with the
queue: while one is busy, the other is the place the next prompt goes.
_Avoid_: "running", "thinking" (the agent may be idle-but-recovering;
"sending" is the precise state).
