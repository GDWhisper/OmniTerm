## 1. Agent state data model

- [x] 1.1 Create `src/tmux/agent_state.rs` — `AgentKind` (`claude`/`codex`), `AgentState` (`running`/`waiting`/`idle`), `AttentionReason` (`decision`/`done`/`error`) enums, `AgentSnapshot` struct, `parse_agent_value()` parser, `agent_value()` formatter (with `clean_token()` whitelist: `[^A-Za-z0-9_.-]` → `_`), `AGENT_OPTION` constant (`@omniterm_agent`)
- [x] 1.2 Write unit tests in `src/tmux/agent_state.rs` — cover valid parse, empty/None, malformed, round-trip format+parse, all enum variants
- [x] 1.3 Add `agent_kind`, `agent_state`, `attention_reason`, `agent_event`, `agent_nonce` fields to `TmuxSessionInfo` in `src/tmux/mod.rs`
- [x] 1.4 Add corresponding optional fields to the `Session` model in `src/models/session.rs` (read-only, not persisted — derived from tmux option at query time) and update frontend `Session` interface in `frontend/src/api/client.ts`

## 2. Hook configuration generation

- [x] 2.1 Create `src/tmux/agent_hooks.rs` — `detect_agent_kind(command: &str) -> Option<AgentKind>` (basename extraction, case-insensitive, strip extensions)
- [x] 2.2 Add `claude_hook_settings() -> String` — generates JSON for `--settings` flag covering UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification (permission_prompt + elicitation_dialog), Stop, StopFailure, SessionEnd
- [x] 2.3 Add `codex_hook_args() -> Vec<String>` — generates `-c` flag arguments for Codex covering UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop
- [x] 2.4 Add `augment_agent_command(command: &str) -> Option<String>` — if agent detected, return wrapped command with hook flags; else None
- [x] 2.5 Add `initial_agent_option_value(kind: AgentKind) -> String` — generates `omniterm:running::launch:<ts>` value
- [x] 2.6 Write unit tests — verify JSON structure, verify -c flag format, verify detection edge cases, verify shell escaping: status values with `'`, `"`, `\`, newlines are sanitized by `clean_token()`

## 3. Integrate agent option into session listing

- [x] 3.1 Migrate `list_sessions()` format string from `\t` to `|` separator (unified), add `#{@omniterm_agent}` field between `session_created` and `session_name`; session_name stays last
- [x] 3.2 Update `TmuxSessionInfo` parsing: split by `|`, parse agent option field with `parse_agent_value()`, rejoin session_name from remaining parts with `join("|")`
- [x] 3.3 Add `get_session_agent_option(session_name: &str) -> Result<Option<AgentSnapshot>>` — single-session query via `tmux show-options -t <name> @omniterm_agent`
- [x] 3.4 Wire agent state into `GET /projects/{pid}/sessions` API response JSON (nest under `agent` or as flat fields on each session object)

## 4. Session creation with hook injection

- [x] 4.1 Update `CreateSession` model in `src/models/session.rs` to include optional `command: Option<String>` field
- [x] 4.2 Update `new_session()` / add a `create_agent_session()` in `src/tmux/mod.rs` that: (a) creates tmux session, (b) runs `tmux set-option @omniterm_agent <initial>`, (c) sends augmented agent command via `tmux send-keys` or directly as the session command
- [x] 4.3 Update `create_session` handler in `src/api/sessions.rs` — detect agent from request command, inject hooks, set `hook_enabled` based on detection result
- [x] 4.4 Handle edge case: creating session without command → plain shell, `hook_enabled=false`

## 5. WebSocket real-time agent state push

- [x] 5.1 In `src/ws/terminal.rs`, spawn a `tokio::spawn` agent poll task with `tokio::time::interval(Duration::from_secs(1))` and `MissedTickBehavior::Skip` (only if `hook_enabled=true`); use `tokio::sync::oneshot` for explicit shutdown signal
- [x] 5.2 Track the last seen `nonce` in the poll task; when it changes, send a JSON control frame `{ "type": "agent_state", "agent_kind": ..., "state": ..., ... }` to the frontend via a cloned `ws_tx` or a dedicated mpsc channel merged into the PTY→WS forward loop
- [x] 5.3 Wrap each `tmux show-options` call in `tokio::time::timeout(Duration::from_secs(2), ...)`; on timeout, log warning; on 3 consecutive timeouts, stop polling and push `state: "unknown"`
- [x] 5.4 In `handle_terminal`, after the main `tokio::select!` returns, send shutdown signal via oneshot and `await` the agent handle to ensure clean task exit (no leak)
- [x] 5.5 Add `agent_state` message type handling in the frontend `useTerminal` hook — fire the Attention API on state transitions
- [x] 5.6 Write unit/integration test: drop WS connection, wait 2s, verify no more `tmux show-options` subprocesses are spawned

## 6. Hook status API refactor

- [x] 6.1 Refactor `hook_status` handler in `src/api/hooks.rs` to first call `get_session_agent_option()`, return parsed state if present; only fall back to `capture_pane` + `scan_agent_state` if option is empty and `hook_enabled=true`
- [x] 6.2 Update `hook_enable` handler: set `hook_enabled=true` in DB, then detect agent CLI in session and inject hooks if possible
- [x] 6.3 Simplify `hook_disable` handler — set `hook_enabled=false`, no other action needed
- [x] 6.4 Verify all three endpoints return backward-compatible JSON shapes

## 7. Frontend: Attention notification system

- [x] 7.1 Create `frontend/src/components/Attention/AttentionProvider.tsx` — React Context providing `fire(targetId, session, reason)`, `clearAlert(...)`, `setActive(...)`, `reasonFor(...)`. Alert state: `Map<sessionKey, AttentionReason>`. Tab title flash logic when `document.hidden`.
- [x] 7.2 Add `useAttention` hook in `frontend/src/hooks/useAttention.ts`
- [x] 7.3 Implement sound notification using Web Audio API — short sine wave ping (880Hz, 300ms decay), with `resume()` for autoplay policy
- [x] 7.4 Write unit tests for AttentionProvider — verify alerts fire, clear, active session suppression

## 8. Frontend: Smart diff and decision debounce

- [x] 8.1 In `Sidebar` (or `TargetGroup` equivalent), store `lastAgentEvent: Map<string, string>` per session — key = `kind:state:reason:event:nonce`
- [x] 8.2 On each poll response, for each session: compute `eventKey`, compare with last seen. Detect transitions:
  - new `waiting+decision` → add to `decisionCandidates`, wait next cycle; if still same key → `fire('decision')`
  - new `done`/`error` → `fire()` immediately
  - `running` → `clearAlert()`
- [x] 8.3 Clear alerts for sessions that disappeared from the list

## 9. Frontend: Sidebar badge integration

- [x] 9.1 Add `reason` badge display to session rows — styled label showing decision/error/done indicator (icons: ⏳/⚠️/✓ or similar)
- [x] 9.2 On session row click, call `attention.setActive()` to clear badge for that session
- [x] 9.3 Apply subtle animation/styling to badge for visual attention grab (pulse or border glow, per UI style guide)

## 10. Testing and validation

- [x] 10.1 Unit tests: agent state parser, hook config generation, command detection, AttentionProvider
- [x] 10.2 Integration test: create session with mock Claude Code command, verify `@omniterm_agent` initialized, hook-status returns correct state
- [x] 10.3 Integration test: create session without agent, verify `hook_enabled=false`, hook-status falls back to heuristic
- [x] 10.4 Manual end-to-end: debug branch (port 19777/19778), create real Claude Code session, trigger hooks via real agent usage, verify badge + sound + tab flash
- [x] 10.5 Resource safety tests: (a) WS disconnect → agent poll task exits within 2s, (b) tmux timeout → 3 consecutive failures → polling stops, (c) shell-escaped agent values with special chars don't break hook config
- [x] 10.6 Frontend compatibility: existing UI works unchanged, new attention features degrade gracefully when agent state is absent (verified via TypeScript compilation + no existing test regressions)

## 11. Documentation and cleanup

- [x] 11.1 Add `CHANGELOG.md` entry summarizing the change (user-facing)
- [x] 11.2 Update `docs/debug-log.md` with any implementation issues encountered
- [x] 11.3 Add code comments marking old `scan_agent_state()` as `#[deprecated]` with migration note
