## ADDED Requirements

### Requirement: Agent CLI detection on session creation

The system SHALL detect supported agent CLIs (Claude Code, Codex) when creating a new tmux session, by examining the base executable name of the command to be run in the session.

#### Scenario: Claude Code detected
- **WHEN** a session is created with a command whose base executable name is `claude`
- **THEN** the system identifies the agent kind as `claude`

#### Scenario: Codex detected
- **WHEN** a session is created with a command whose base executable name is `codex`
- **THEN** the system identifies the agent kind as `codex`

#### Scenario: Non-agent command
- **WHEN** a session is created with a command that does not match any known agent CLI
- **THEN** the system does not inject hook configuration and leaves `hook_enabled` as false

#### Scenario: Case-insensitive and extension-stripped matching
- **WHEN** the command is `Claude.EXE` or `claude-code`
- **THEN** the system correctly identifies it as a Claude Code agent by stripping extensions (`.exe`, `.cmd`, `.bat`) and lowercasing

### Requirement: Hook configuration injection for Claude Code

The system SHALL inject lifecycle hook configuration into Claude Code CLI invocations using the `--settings` flag with a JSON configuration that maps each lifecycle event to a `tmux set-option` command writing the agent state to `@omniterm_agent`.

#### Scenario: Claude Code hooks injected
- **WHEN** a Claude Code session is created
- **THEN** the launched command includes `--settings` with hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification` (permission_prompt and elicitation_dialog), `Stop`, `StopFailure`, and `SessionEnd`
- **AND** each hook fires `tmux set-option -q @omniterm_agent claude:<state>:<reason>:<event>:$(date +%s).$$`

#### Scenario: Initial state set before agent launch
- **WHEN** a tmux session is created for an agent
- **THEN** `tmux set-option -q @omniterm_agent omniterm:running::launch:<ts>` is executed before the agent command, ensuring the option exists and has a baseline value

### Requirement: Hook configuration injection for Codex

The system SHALL inject lifecycle hook configuration into Codex CLI invocations using `-c` flags with TOML-like hook configuration entries.

#### Scenario: Codex hooks injected
- **WHEN** a Codex session is created
- **THEN** the launched command includes `-c` flags for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`
- **AND** each hook fires `tmux set-option -q @omniterm_agent codex:<state>:<reason>:<event>:$(date +%s).$$`

### Requirement: Agent state value format

The system SHALL use a colon-separated value format in the `@omniterm_agent` tmux session option: `<agent_kind>:<state>:<reason>:<event>:<nonce>`.

#### Scenario: Valid agent state value
- **WHEN** `@omniterm_agent` is set to `claude:waiting:decision:PermissionRequest:1719000000.12345`
- **THEN** the system parses `agent_kind=claude`, `state=waiting`, `reason=decision`, `event=PermissionRequest`, `nonce=1719000000.12345`

#### Scenario: Empty or unset option
- **WHEN** `@omniterm_agent` is empty or not set
- **THEN** the system reports no agent activity (`agent_kind=None`, `state=Idle`)

#### Scenario: Malformed value
- **WHEN** `@omniterm_agent` contains an unrecognized value
- **THEN** the system reports `state=Idle` and logs a warning without crashing

### Requirement: Agent state in session listing

The system SHALL include agent state in the session listing response by adding `#{@omniterm_agent}` to the `tmux list-sessions -F` format string and parsing it into structured fields.

#### Scenario: Agent state included in session listing
- **WHEN** `tmux list-sessions -F` is called with the agent option field
- **THEN** each session's output includes the `@omniterm_agent` value (or empty string if not set)
- **AND** the API response JSON includes `agent_kind`, `agent_state`, `attention_reason`, `agent_event`, and `agent_nonce` fields for each session

#### Scenario: Session without agent
- **WHEN** a tmux session has no `@omniterm_agent` option set
- **THEN** the agent state fields in the API response are `null`

### Requirement: Real-time agent state push via WebSocket

The system SHALL push agent state changes to the frontend through the existing terminal WebSocket connection for the actively viewed session, with a maximum polling interval of 1 second on the backend.

#### Scenario: Agent state pushed via WebSocket
- **WHEN** the `@omniterm_agent` option changes for the session attached via WebSocket
- **THEN** the backend sends a JSON control frame `{ "type": "agent_state", "state": "...", "agent_kind": "...", ... }` to the frontend within 1 second of the change

#### Scenario: No agent state for non-hook session
- **WHEN** a terminal WebSocket connection is established for a session with `hook_enabled=false`
- **THEN** the backend does NOT poll the agent option on this connection

### Requirement: Attention notification on agent state transitions

The frontend SHALL detect agent state transitions by comparing the current and previous `nonce` values, and trigger user notifications (sound, badge, tab title flash) when the agent enters a state requiring user attention.

#### Scenario: Decision required notification
- **WHEN** the agent state changes to `waiting` with `reason=decision`, and the same state persists across two consecutive poll cycles
- **THEN** the frontend fires an attention notification: plays a short ping sound, shows a badge on the session row, and flashes the browser tab title when the tab is hidden

#### Scenario: Done notification
- **WHEN** the agent state changes to `idle` with `reason=done` (new nonce detected)
- **THEN** the frontend fires an attention notification immediately

#### Scenario: Error notification
- **WHEN** the agent state changes to `idle` with `reason=error` (new nonce detected)
- **THEN** the frontend fires an attention notification immediately

#### Scenario: Running clears alert
- **WHEN** the agent state changes to `running`
- **THEN** the frontend clears any existing attention alert for that session

#### Scenario: Active session suppresses notification
- **WHEN** the user is currently viewing the session that has a state transition
- **THEN** the frontend does NOT fire a sound notification or tab flash (badge may still appear in sidebar)

### Requirement: Attention badge in sidebar

The frontend SHALL display an attention badge on session rows in the sidebar when an attention notification is active for that session.

#### Scenario: Decision badge
- **WHEN** a session has an active `decision` alert
- **THEN** the sidebar displays a badge (e.g., "⏳" or styled label) next to the session name

#### Scenario: Badge cleared on selection
- **WHEN** the user selects the session
- **THEN** the badge is cleared

### Requirement: Tab title flash for background attention

The frontend SHALL flash the browser tab title when an attention notification is active and the browser tab is hidden.

#### Scenario: Tab flash when hidden
- **WHEN** there are active attention alerts and the browser tab is hidden
- **THEN** the tab title alternates between a notification indicator (e.g., "🔔 OmniTerm") and the normal title ("OmniTerm") every second

#### Scenario: Tab flash stops when visible
- **WHEN** the browser tab becomes visible
- **THEN** the tab title returns to normal immediately

### Requirement: Hook status API uses session option first, heuristic fallback

The `GET /sessions/{id}/hook-status` endpoint SHALL first attempt to read agent state from the `@omniterm_agent` session option. If the option is empty or not present, it SHALL fall back to the existing heuristic pane content scanner.

#### Scenario: Hook status from session option
- **WHEN** hook-status is called for a session with `hook_enabled=true` and `@omniterm_agent` set to a valid value
- **THEN** the response includes the parsed agent state from the session option, without calling `capture-pane`

#### Scenario: Hook status fallback to heuristic
- **WHEN** hook-status is called for a session with `hook_enabled=true` but `@omniterm_agent` is empty or unset
- **THEN** the system falls back to `capture_pane` + `scan_agent_state` heuristic scanner

### Requirement: Manual hook injection via hook-enable endpoint

The `POST /sessions/{id}/hook-enable` endpoint SHALL set `hook_enabled=true` and inject hook configuration into the session if an agent CLI process is detected.

#### Scenario: Hook enable for session with running agent
- **WHEN** hook-enable is called for a session where a Claude Code or Codex process is detected
- **THEN** the system sets `hook_enabled=true` and injects the appropriate hook configuration into the agent process

#### Scenario: Hook enable for session without agent
- **WHEN** hook-enable is called for a session with no detectable agent CLI
- **THEN** the system sets `hook_enabled=true` but does not inject hooks; the hook-status endpoint will fall back to heuristic scanning

### Requirement: Backward compatibility of API responses

The hook-status, hook-enable, and hook-disable endpoints SHALL maintain backward-compatible JSON response shapes.

#### Scenario: Hook status response shape
- **WHEN** hook-status returns a response
- **THEN** the JSON includes `enabled: boolean`, `state: string`, and optionally `agent_kind`, `detail`

#### Scenario: Hook enable response shape
- **WHEN** hook-enable succeeds
- **THEN** the JSON includes `ok: true` and `hook_enabled: true`
