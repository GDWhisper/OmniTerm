# Backend Architecture

Rust (Axum) backend. Source under `src/`.

## Source Tree

```
src/
├── main.rs              # Entry: Axum + clap CLI args, SQLite pool, migrations, embedded static serving
├── embedded.rs           # rust-embed: frontend dist/ compiled into binary
├── api/
│   ├── mod.rs            # Route registration, state wiring
│   ├── health.rs         # GET /api/v1/health
│   ├── auth.rs           # POST /api/v1/auth/setup|login|logout, GET /auth/check
│   ├── targets.rs        # CRUD /api/v1/targets
│   ├── projects.rs       # CRUD /api/v1/projects
│   ├── sessions.rs       # CRUD /api/v1/sessions (auto-creates tmux session)
│   ├── hooks.rs          # GET /sessions/{id}/hook-status, POST hook-enable|hook-disable
│   ├── files.rs          # /api/v1/files — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
│   └── files_watch.rs    # File watcher: SSE endpoint for live directory updates
├── auth/mod.rs           # JWT token creation/verification, RequireAuth extractor
├── models/               # SQLx-derived structs: User, Project, Session
├── tmux/
│   ├── mod.rs            # tmux command wrappers: new_session, kill_session, capture_pane, pane_cwd
│   └── hooks.rs          # Agent state scanner: scan_agent_state()
├── fs/mod.rs             # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── git/mod.rs            # Git worktree discovery
├── ws/
│   ├── mod.rs
│   └── terminal.rs       # WebSocket terminal bridge: PTY ↔ WS binary frames, JSON control
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
GET  /api/v1/files (list)
POST /api/v1/files (upload multipart)
DELETE /api/v1/files
GET  /api/v1/files/download|read|search
POST /api/v1/files/write|mkdir|rename|move|copy
WS   /api/v1/ws/terminal/{session_id}
GET  /api/v1/files/watch (SSE)
```

## CLI Reference

```
omniterm [OPTIONS]

Options:
  -p, --port <PORT>              监听端口 (默认: 9075 [main], 9777 [dev], 9077 [release])
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
| `OMNITERM_PORT` | 9075 (main) / 9077 (release) | CLI --port override via env |
| `FRONTEND_DIR` | `frontend/dist` | Static files dir; falls back to embedded |
