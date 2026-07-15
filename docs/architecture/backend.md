# Backend Architecture

Rust (Axum) backend. Source under `src/`.

## Source Tree

```
src/
├── main.rs              # Entry: Axum + clap CLI args, SQLite pool, migrations, embedded static serving
├── embedded.rs           # rust-embed: frontend dist/ compiled into binary
├── acp/
│   ├── mod.rs            # Re-export AcpClient, AcpSupervisor
│   ├── client.rs         # AcpClient: spawn agent subprocess, ACP handshake, session, prompt, cancel, disconnect
│   ├── handler.rs        # Session-update broadcast helper (fed by ACP SessionNotification)
│   ├── permission.rs     # Auto-allow permission resolver (Phase 3; Phase 4 will add user-prompted flow)
│   ├── supervisor.rs     # AcpSupervisor: HashMap<omniterm_session_id, Arc<AcpClient>> registry
│   └── terminal.rs       # AcpTerminalManager: serve agent terminal/* requests via tokio::process
├── api/
│   ├── mod.rs            # Route registration, state wiring
│   ├── health.rs         # GET /api/v1/health
│   ├── auth.rs           # POST /api/v1/auth/setup|login|logout, GET /auth/check
│   ├── targets.rs        # CRUD /api/v1/targets
│   ├── projects.rs       # CRUD /api/v1/projects
│   ├── agents.rs         # CRUD /api/v1/agents (ACP-capable agent process configs)
│   ├── sessions.rs       # CRUD /api/v1/sessions — dispatches on runtime_kind: 'tmux' (tmux pane) | 'acp' (spawns AcpClient via supervisor)
│   ├── hooks.rs          # GET /sessions/{id}/hook-status, POST hook-enable|hook-disable
│   ├── files.rs          # /api/v1/files — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
│   └── files_watch.rs    # File watcher: SSE endpoint for live directory updates
├── auth/mod.rs           # JWT token creation/verification, RequireAuth extractor
├── models/               # SQLx-derived structs: User, Project, Session, Agent
├── tmux/
│   ├── mod.rs            # tmux command wrappers, multiplexer detection: new_session, kill_session, check_multiplexer
│   ├── agent_hooks.rs    # Agent CLI detection + hook config generation (Claude, Codex, Qoder)
│   ├── agent_state.rs    # Agent state data model: AgentKind, AgentState, AgentSnapshot
│   ├── control_mode.rs   # tmux -C control mode session activity monitor
│   ├── process_info.rs   # [platform] Process enumeration: read_process_cmdline, walk_process_tree
│   └── pty_io.rs         # [platform] PTY writes + process cleanup: write_pty, kill_session_process
├── fs/mod.rs             # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── git/mod.rs            # Git worktree discovery
├── ws/
│   ├── mod.rs
│   ├── terminal.rs       # WebSocket terminal bridge: PTY ↔ WS binary frames, JSON control
│   └── acp.rs            # WebSocket ACP bridge: session_update broadcast ↔ WS, prompt/cancel commands
├── utils/path.rs         # Path security: sanitize_path
└── workspaces.rs         # Workspace operations
```

## API Endpoints

```
GET  /api/v1/health
POST /api/v1/auth/setup|login|logout
GET  /api/v1/auth/check
GET  /api/v1/projects
POST /api/v1/projects
DELETE /api/v1/projects/{id}
GET  /api/v1/projects/{pid}/worktrees (git worktree discovery)
GET  /api/v1/projects/{pid}/sessions
POST /api/v1/projects/{pid}/sessions
PATCH/DELETE /api/v1/sessions/{id}
GET  /api/v1/sessions/{id}/hook-status
POST /api/v1/sessions/{id}/hook-enable|hook-disable
POST /api/v1/sessions/{id}/prompt     # ACP: send a user prompt, returns stop_reason
GET  /api/v1/agents                   # CRUD agent process configs
POST/PUT/DELETE /api/v1/agents[/{id}]
GET  /api/v1/files (list)
POST /api/v1/files (upload multipart)
DELETE /api/v1/files
GET  /api/v1/files/download|read|search
POST /api/v1/files/write|mkdir|rename|move|copy
WS   /api/v1/ws/terminal/{session_id}  # tmux-backed pane
WS   /api/v1/ws/acp/{session_id}       # ACP session update stream + prompt/cancel commands
GET  /api/v1/files/watch (SSE)
```

## ACP Module (Phase 3)

`src/acp/` is the ACP (Agent Client Protocol) adapter that turns OmniTerm into a generic agent hub. It is runtime-agnostic — any agent that speaks ACP over stdio ndJSON can be plugged in via an `agents` table row.

Lifecycle:
1. `POST /projects/{pid}/sessions` with `runtime_kind: 'acp'` and `agent_id` → `api::sessions::create_session` resolves the workspace path, loads the `Agent`, calls `AcpClient::spawn_and_connect`, and registers the client in `AcpSupervisor`.
2. `AcpClient::spawn_and_connect` builds an `AcpAgent` transport (`KEY=VALUE` env prefix + command + args), runs `Client::builder().connect_with(transport, closure)`. Inside the closure it sends `InitializeRequest` + `NewSessionRequest`, clones the `ConnectionTo<Agent>` (which is `Clone` — channel senders) out via a oneshot, then waits on a shutdown oneshot.
3. Handlers registered on the builder:
   - `session/update` notification → broadcast via `session_update_tx` to all WS subscribers.
   - `request_permission` → auto-allow (finds first `AllowOnce`/`AllowAlways` option; Phase 4 will add a user-prompted path).
   - `terminal/{create,output,wait_for_exit,kill,release}` → `AcpTerminalManager` spawns `tokio::process::Command` children and monitors them with `tokio::select!` racing child exit vs an mpsc kill channel.
   - `fs/read` / `fs/write` → stubs (Phase 3); Phase 4 will plumb them through the existing `fs/` module.
4. `WS /ws/acp/{session_id}` subscribes to the broadcast; client messages `{"type":"prompt","text":…}` and `{"type":"cancel"}` are forwarded to the `AcpClient`.
5. `DELETE /sessions/{id}` on an ACP session calls `supervisor.dispose` + `AcpClient::disconnect`, which drops the shutdown oneshot so the connect_with closure returns and the child process is reaped.

## CLI Reference

```
omniterm [OPTIONS]

Options:
  -p, --port <PORT>              监听端口 (默认: 9777 [dev], 9075 [preview], 9077 [main/docker])
      --db <DB>                  数据库连接 [env: DATABASE_URL]
      --jwt-secret <KEY>         JWT 签名密钥 [env: JWT_SECRET]
  -V, --version                  版本号
  -h, --help                     帮助
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite:omniterm.db?mode=rwc` | SQLite connection string |
| `JWT_SECRET` | `omniterm-default-secret-change-me` | JWT signing secret |
| `BIND_ADDR` | `127.0.0.1:<port>` | Listen address (legacy, prefer --port) |
| `OMNITERM_PORT` | 9777 (dev) / 9075 (preview) / 9077 (main) | CLI --port override via env |
| `FRONTEND_DIR` | `frontend/dist` | Static files dir; falls back to embedded |

## Sessions Table

定义在 `migrations/20260620_init.sql` + `20260625_workspace_to_project.sql` + `20260715_add_runtime_kind.sql`。

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | UUID |
| `project_id` | TEXT FK | 所属项目 |
| `workspace_path` | TEXT | 工作目录 |
| `name` | TEXT? | 用户可见名 |
| `tmux_session_name` | TEXT? | tmux runtime 的会话名（`lt_xxxxxxxx`）；ACP session 为 NULL |
| `hook_enabled` | BOOLEAN | 是否注入了 tmux agent hook |
| `hook_status` | TEXT? | hook 运行状态 |
| `created_at` | TEXT | RFC3339 |
| `runtime_kind` | TEXT NOT NULL | `tmux` \| `acp`。DEFAULT `tmux` |
| `acp_session_id` | TEXT? | ACP adapter 分配的 session id；tmux session 为 NULL |
| `agent_id` | TEXT? | 关联的 `agents.id`；仅 `runtime_kind='acp'` 有值 |

创建 session 时 `runtime_kind` 默认 `tmux`（Phase 2）。传 `runtime_kind: 'acp'` + `agent_id` 时走 ACP 分支（Phase 3 后端实装）；前端 Chat 视图（Phase 4）上线后会默认翻转为 `acp`。
