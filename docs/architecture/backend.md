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
│   ├── files_watch.rs    # File watcher: SSE endpoint for live directory updates
│   └── git.rs            # /api/v1/git/* — git panel API, binds repo via resolve_base_from_query (ADR-2)
├── auth/mod.rs           # JWT token creation/verification, RequireAuth extractor
├── models/               # SQLx-derived structs: User, Project, Session, Agent
├── tmux/
│   ├── mod.rs            # tmux command wrappers, multiplexer detection: new_session, kill_session, check_multiplexer, capture_screen
│   ├── agent_hooks.rs    # Agent CLI detection + hook config generation (Claude, Codex, Qoder)
│   ├── agent_state.rs    # Agent state data model: AgentKind, AgentState, AgentSnapshot
│   ├── agent_detect.rs   # 屏幕规则引擎：TOML manifest 编译 + evaluate(屏幕/标题→状态) + Debounce 防抖（herdr 借鉴）
│   ├── agent_watch.rs    # 全局 agent 屏幕检测轮询器（1s tick）：前台进程识别 → capture_screen → evaluate → 内存快照
│   ├── manifests/        # 内置检测规则：claude.toml / codex.toml / qoder.toml（include_str! 编译期内嵌）
│   ├── control_mode.rs   # tmux -C control mode session activity monitor
│   ├── process_info.rs   # [platform] Process enumeration: read_process_cmdline, foreground_pid(tpgid), walk_process_tree
│   └── pty_io.rs         # [platform] PTY writes + process cleanup: write_pty, kill_session_process
├── fs/mod.rs             # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── git/
│   ├── mod.rs            # Git worktree discovery
│   └── repo.rs           # Git panel service: status(porcelain v2)/diff/log/show/branches/stage/unstage/commit/discard/checkout/push/pull/fetch via git CLI subprocess (no git2)
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
GET  /api/v1/files/download|read|search   # search 条目额外带 rel_path（相对搜索根，@ 补全用）
POST /api/v1/files/write|mkdir|rename|move|copy
WS   /api/v1/ws/terminal/{session_id}  # tmux-backed pane
WS   /api/v1/ws/acp/{session_id}       # ACP session update stream + prompt/cancel commands
GET  /api/v1/files/watch (SSE)
GET  /api/v1/system/version           # 版本检查（进程内缓存 GitHub latest，成功 1h/失败 5min）
POST /api/v1/system/update            # 一键升级（github_release 自替换 / npm 代跑；cargo 返回 400）
GET  /api/v1/git/status|diff|log|show|branches   # git panel reads; bind via ?session=|workspace_id=&workspace=
POST /api/v1/git/stage|unstage|commit|discard|checkout|branch|push|pull|fetch
```

git 端点绑定规则（设计文档 ADR-2，`docs/dev/plans/2026-07-26-git-panel.md`）：复用 `files.rs::resolve_base_from_query` 解析 session/workspace 基准目录，再 `rev-parse --show-toplevel` 定位仓库根；**不接受任意路径参数**。非 git 目录返回 200 `{is_repo:false}`；失败返回 422（超时 504），body `{error, code}`，`code ∈ auth|non_fast_forward|no_upstream|dirty_worktree|timeout|generic`。所有 git 子进程带 `--no-optional-locks`、`GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND="ssh -oBatchMode=yes"`，远端操作 60s 超时。diff 超过 256KB 截断（`truncated: true`）。

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
4. `WS /ws/acp/{session_id}` subscribes to the broadcast; client messages `{"type":"prompt","text":…,"images":[{data,mime_type}…]?}` and `{"type":"cancel"}` are forwarded to the `AcpClient`. Prompt `images`（可选，≤3 张 base64）映射为 `ContentBlock::Image` 追加在 text block 后；服务端推送 `{"type":"capabilities","image":bool}` 帧（client 就绪/restore 时），值来自 initialize 捕获的 `promptCapabilities.image`（§8：agent 未声明则前端隐藏附件入口、后端拒绝带图 prompt）。Prompt 文本中的 `@path` 引用（`@` 前须行首/空白，去重上限 8）由 `ws/acp.rs::resolve_at_references` 解析：相对 session `workspace_path` 经 `fs::sanitize_path` 校验后读取（≤64KB 截断，越界/不存在/目录/非 UTF-8 静默跳过），注入 `ContentBlock::Resource`（TextResourceContents，`file://` URI）；agent 未声明 `promptCapabilities.embeddedContext` 时降级为内容内联进 text block（§8）。
5. `DELETE /sessions/{id}` on an ACP session calls `supervisor.dispose` + `AcpClient::disconnect`, which drops the shutdown oneshot so the connect_with closure returns and the child process is reaped.

### Multi-implementation compatibility

ACP is a protocol satisfied by multiple agent implementations. **Do not assume one implementation's behavior is the protocol.** For any field/notification/capability that is optional or may be absent, implement a fallback and document the divergence in code comments — but keep case-specific details out of AGENTS.md (they go stale). Before adding protocol-touching logic, verify the field's behavior across implementations rather than inferring the whole from one. (See AGENTS.md §8 多实现兼容性.)

## CLI Reference

CLI 为 clap 4 子命令结构（`src/main.rs` 定义枚举与 dispatch；`update` 逻辑在 `src/update.rs`）。

```
omniterm <COMMAND>

Commands:
  start       启动服务
  stop        停止后台运行的服务（通过 PID 文件发 SIGTERM）
  status      查看服务运行状态
  reset-auth  清空所有用户（忘记密码后，先用此命令再 start 设新密码）
  update      自更新到最新发布版本

start options:
  -p, --port <PORT>       监听端口 (默认: 9777 [dev], 9075 [preview], 9077 [main/docker]) [env: BACKEND_PORT]
      --db <DB>           数据库连接 [env: DATABASE_URL]
      --jwt-secret <KEY>  JWT 签名密钥 [env: JWT_SECRET]
      --reset-auth        启动前清空所有用户 [env: OMNITERM_RESET_AUTH]

stop / status / reset-auth options:
      --db <DB>           数据库连接（用于定位 PID 文件）[env: DATABASE_URL]

update options:
      --check             只检查是否有新版本，不执行更新
```

### `update` 渠道感知自更新

按 `current_exe()` 路径检测安装渠道，统一先查 GitHub `releases/latest`（semver 三态比对：相等→已最新；本地更新→提示 development build 不动作；远端更新→执行）：

| 渠道 | 判据 | 行为 |
|------|------|------|
| npm | 路径含 `node_modules` | 代跑 `npm update -g @gdwhisper/omniterm`（透传退出码） |
| cargo | 位于 `$CARGO_HOME/bin`（fallback `~/.cargo/bin`） | 代跑 `cargo install omniterm`（不自替换，避免与 `.crates.toml` 元数据脱钩） |
| 其它（install.sh / 手动） | 兜底 | 下载平台 asset → sha256 digest 校验（GitHub API asset `digest` 字段，缺失则跳过）→ spawn `--version` 验证 → 同目录临时文件原子 rename 替换；目录不可写提示 `sudo omniterm update`（不自动提权）；Windows 走 rename-self-to-`.old` 手法 |

Asset 命名与 `install.sh` 平台映射表一致（`omniterm-{os}-{arch}`，Windows 为 `.zip`）。任何失败不留半更新状态（写操作全在临时文件，rename 是最后一步）。

**Web 端点**（`src/api/system.rs`，供 Sidebar UpdateBadge 用）：
- `GET /system/version` → `{current, latest, update_available, channel}`。后端做 semver 比较（dev 领先时 `update_available: false`）；GitHub latest 结果进程内缓存（成功 TTL 1h、失败负缓存 5min，防匿名限流 60 次/时）；GitHub 不可达且无缓存 → 502，前端 silent 降级不显示 badge。
- `POST /system/update` → 一键升级。`try_lock` 全局锁防并发（占用中 409）；先 fresh 查询，无新版 409 `already up to date`；`github_release` 走 `self_replace`，`npm` 走 `delegate_captured`（300s 超时 → 504），`cargo` 编译耗时过长不支持一键 → 400 `unsupported_channel`（前端只显示命令提示）。成功返回 `restart_required: true`，**不自动重启服务器**（持有 tmux/ACP/WS 连接），提示用户 `omniterm stop && omniterm start`。
- `delegate_captured()`（捕获输出、失败带 stderr 尾部返回 Result）专供服务器进程；CLI 的 `delegate()` 透传 stdio 且失败 `std::process::exit`，**严禁在服务器内使用**。

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

## Terminal Input Path（tmux escape-time）

交互输入链路：xterm.js `onData` → WS binary → `ws/terminal.rs` 读循环 → mpsc → 写线程 `libc::write` 到 PTY master fd（`tmux/pty_io.rs`，刻意绕开 `portable_pty::MasterWriter` 的 Drop 注入 `\n\x04` 问题）→ PTY slave 上的 tmux client → tmux server → pane。**不走 `send-keys`**（`send-keys` 仅用于会话启动命令）。

**tmux escape-time 行为差异**：tmux 收到孤立 `\x1b` 后会等待 `escape-time`（默认 500ms）以区分 Alt/功能键序列。后果：1) 单次 ESC 延迟 500ms 才转发给 pane；2) 窗口内连按两次 ESC 被合并为 `\x1b\x1b`（Alt+ESC）一次转发。对需要连按 ESC 中止任务的 agent TUI（如 opencode 的 "esc again to interrupt"）这等于 ESC 完全失效。因此 `ws/terminal.rs` 的 `build_tmux_attach_cmd` 在 spawn tmux client 时链式执行 `set-option -s escape-time 10 \; new-session -A`（server 级选项，一次生效覆盖全部会话；取 10ms 而非 0 以免慢速链路上转义序列被拆断）。


## Agent 屏幕状态检测（agent_watch / agent_detect）

herdr 借鉴（P0，`docs/reference/herdr-reference.md`）。tmux 会话中 agent CLI（Claude/Codex/Qoder）的 Running/Waiting/Idle 状态由**屏幕检测**判定，作为状态权威覆盖 hook 上报的 `agent_state`（Claude/Codex 的生命周期 hook 事件流不完整）；hook 仍独家提供 `attention_reason` / `agent_event` / `agent_nonce`。

链路：`agent_watch::spawn`（main.rs 启动，1s tick）→ `tmux list-panes -a` 列出活动 pane → `process_info::foreground_pid`（Unix 读 `/proc/<pid>/stat` tpgid；Windows 回退进程树）+ `read_process_cmdline` 识别 agent 种类 → `tmux::capture_screen` 取可见屏 → `agent_detect::evaluate`（TOML manifest 规则，优先级降序首中即停）→ `Debounce`（Running/Waiting 立即发布；Idle 需连续 2 tick 确认，除非规则带 `visible_idle` 证据）→ 内存快照。消费端：`api::sessions::list_sessions` / `list_external_sessions` 查询时合并（前端沿用既有 3s 轮询，无新增推送通道）。跳扫描优化：`#{window_activity}` 未变且已发布 Idle 时跳过 capture。

规则清单在 `src/tmux/manifests/*.toml`（`include_str!` 内嵌，测试断言编译数量防无声丢规则）。regex 区分大小写（herdr 原始模式内嵌 `(?i)`），`contains` 不区分；`prompt_box_body` / `after_last_horizontal_rule` 等 region 提取时剥离盒线字符（│┃║）以便行锚定模式命中。

**tmux -F 行为差异（踩坑）**：tmux 会把 format 字符串里的非打印字节按八进制转义为**字面文本**输出（`\x1f` → 4 字符 `\037`），因此 `-F` 分隔符不能用控制字符。`agent_watch` 用 `:`（tmux 会话名禁止含 `:`，中间字段均为数字，自由文本 `pane_title` 放末尾整体保留）；`mod.rs::list_sessions` 用 `|`（会话名放末尾 rejoin）。
