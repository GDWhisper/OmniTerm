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
│   ├── config_prefs.rs   # 配置偏好持久化：session_config_options + agent_config_preferences 两层 CRUD + 恢复值校验
│   ├── handler.rs        # Session-update broadcast helper (fed by ACP SessionNotification); assigns per-client monotonic seq
│   ├── permission.rs     # PermissionManager: user-prompted approval via WS banner; no timeout auto-response
│   ├── supervisor.rs     # AcpSupervisor: HashMap<omniterm_session_id, Arc<AcpClient>> registry
│   ├── turn_accumulator.rs # TurnAccumulator: folds in-progress turn's raw session_update frames → one streaming chat_messages row (debounced writer)
│   ├── chat_persistence.rs # chat_messages CRUD: upsert_streaming_message / finalize_message / list_messages_page (cursor + byte-budget pagination) / sync_messages (row-id-first matching, non-destructive)
│   └── terminal.rs       # AcpTerminalManager: serve agent terminal/* requests via tokio::process
├── api/
│   ├── mod.rs            # Route registration, state wiring
│   ├── health.rs         # GET /api/v1/health
│   ├── auth.rs           # POST /api/v1/auth/setup|login|logout|settings|change-password, GET /auth/check
│   ├── targets.rs        # CRUD /api/v1/targets
│   ├── projects.rs       # CRUD /api/v1/projects
│   ├── agents.rs         # CRUD /api/v1/agents (ACP-capable agent process configs)
│   ├── sessions.rs       # CRUD /api/v1/sessions — dispatches on runtime_kind: 'tmux' (TmuxEngine) | 'pty' (PtyEngine, lazy spawn) | 'acp' (spawns AcpClient via supervisor)
│   ├── hooks.rs          # GET /sessions/{id}/hook-status, POST hook-enable|hook-disable
│   ├── settings.rs       # GET/PUT /api/v1/settings/acp-idle-recycle — ACP 空闲回收阈值（分钟，settings 表持久化 + 内存热更新）
│   ├── files.rs          # /api/v1/files — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
│   ├── files_watch.rs    # File watcher: SSE endpoint for live directory updates
│   └── git.rs            # /api/v1/git/* — git panel API, binds repo via resolve_base_from_query (ADR-2)
├── auth/mod.rs           # JWT token creation/verification（含 token_version 吊销校验）、require_auth_mw 中间件、登录限流 LoginGuard
├── models/               # SQLx-derived structs: User, Project, Session, Agent
├── proxy/                # 端口转发反向代理：路径前缀 /proxy/{port}/{*path} + 子域名 {port}.{base}（P1 HTTP 转发 + P2 WS relay）
│   ├── mod.rs            # ProxyState（reqwest client + self_port + base_host）、routes、proxy_handler（WS/HTTP 分流）、proxy_host_mw（子域名 Host 路由）、parse_proxy_host、端口白名单、header 重写纯函数 + 单测
│   └── ws.rs             # WS 双向 relay：connect_async 上游 + 四任务双向 + mpsc(64) 有界队列
├── engine/               # 会话引擎抽象层（D9）：SessionEngine trait + EngineRegistry 按 runtime_kind 路由
│   ├── mod.rs            # SessionEngine trait / EngineRegistry / EngineSessionInfo / WatchTarget / WS attach 分发
│   ├── pty_io.rs         # [platform] PTY 写 + 进程清理（引擎公共件）：write_pty, kill_session_process, kill_process_escalating
│   ├── tmux/             # 冻结引擎边界（只修致命 bug 不加功能）：tmux 命令门面 / control mode / hook 注入 / pane 枚举 / attach WS
│   └── pty/              # 自管 pty 引擎（Phase 2）：常驻会话 map + 补屏环 + alacritty_terminal VT grid
│       ├── mod.rs        # PtyEngine（SessionEngine 实现）：spawn/读循环/广播订阅/去抖落盘/cwd 采样回写后台任务
│       ├── session.rs    # PtySession：openpty + spawn + child 收割句柄
│       ├── ring.rs       # ByteRing：256KB 字节环形缓冲（重连补屏窗口，P1 有界）
│       ├── vt.rs         # VtState：alacritty_terminal Term 封装（feed/capture_visible/title/resize；应答经 take_responses 排空，由读循环按 attach 门控回写）
│       ├── scrollback.rs # ANSI 历史落盘（D5：0600/tmp+rename/UTF-8 截断/路径逃逸防护）
│       ├── cwd.rs        # [platform] 前台进程 cwd 采样（/proc）
│       └── terminal_ws.rs# pty WS attach：补屏回放 + resize nudge + detach 语义
├── agent/                # 引擎无关的 agent 检测体系
│   ├── state.rs          # Agent state data model: AgentKind, AgentState, AgentSnapshot
│   ├── detect.rs         # 屏幕规则引擎：TOML manifest 编译 + evaluate(屏幕/标题→状态) + Debounce 防抖（herdr 借鉴）
│   ├── watch.rs          # 全局屏幕检测轮询器（1s tick）：经 EngineRegistry 枚举 watch_targets → capture_screen → evaluate
│   ├── cli.rs            # agent CLI 识别（命令行模式匹配）
│   ├── process.rs        # [platform] Process enumeration: read_process_cmdline, foreground_pid(tpgid), walk_process_tree
│   └── manifests/        # 内置检测规则：claude.toml / codex.toml / qoder.toml（include_str! 编译期内嵌）
├── fs/mod.rs             # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── git/
│   ├── mod.rs            # Git worktree discovery
│   └── repo.rs           # Git panel service: status(porcelain v2)/diff/log/show/branches/stage/unstage/commit/discard/checkout/push/pull/fetch via git CLI subprocess (no git2)
├── ws/
│   ├── mod.rs
│   ├── terminal.rs       # 终端 WS 入口：共享协议类型（ClientControl/ServerControl）+ 按 runtime_kind 分发到 engine/*/terminal_ws
│   └── acp.rs            # WebSocket ACP bridge: session_update broadcast ↔ WS, prompt/cancel commands
├── utils/path.rs         # Path security: sanitize_path
└── workspaces.rs         # Workspace operations
```

## 会话引擎（SessionEngine 抽象 + 双引擎）

终端会话按 `runtime_kind` 路由到引擎（`engine::EngineRegistry`）：
`'tmux'` → `TmuxEngine`（冻结边界 `src/engine/tmux/`，只修致命 bug）；
`'pty'` → `PtyEngine`（自管常驻会话）；`'acp'` 不经此抽象。引擎之外
的代码（api/、ws/、agent/watch）只经注册表访问会话能力。

**PtyEngine 生命周期**：会话进程由引擎 map 常驻持有；WS 只是视图
（断开 = 解绑订阅，不杀进程）；子进程退出自动注销，下次 attach 重建。
attach = 补屏环快照回放（256KB 有界，原始 ANSI 字节）+ broadcast 订阅；
同锁「先快照后订阅」保证不重不漏。重连既有会话触发 resize nudge
（rows-1 → 30ms → rows）强制 TUI 重绘。恢复链路（D5）：5s 去抖落盘
ANSI 历史（`~/.omniterm/pty-sessions/<key>/history.ansi`，0600）+
30s 前台 cwd 采样回写 `sessions.last_cwd`；重建时 spawn 于 last_cwd
并 seed 历史进补屏环与 VT grid（alacritty_terminal）。显式 kill 删历史文件。

> **VT 模拟器 = `alacritty_terminal` 0.26（registry 依赖，计划 D8 v5 / Phase 2.5）**：
> 原 `wezterm-term` 为 git 依赖，使 `cargo package` 失败、阻塞 crates.io 发布
> （0.2.14 中止事故），已换 registry 依赖。对外四件套 feed/capture_visible/
> title/resize 语义不变。**应答归属**：pty 会话的 DSR/DA/颜色查询有两个可能
> 应答主体——浏览器 xterm.js（onData 回送）与服务端 VT；读循环 feed 后 drain
> 应答并门控：**有客户端订阅时服务端沉默（浏览器应答），detach 期间服务端
> 应答**（`should_server_respond`，以 `receiver_count()==0` 判据），杜绝双应答。
> 应答缓冲有界（≤64 条且 ≤8KB，超限丢旧 + warn）。**capture 细微差异**：
> 进入 alt-screen 时保留当前光标行（`\x1b[?1049h` 后 capture 首行可能为空，
> wezterm-term/vt100 归位首行）——xterm 语义上更正确，对整屏文本匹配的
> agent 检测无影响。OSC 52 剪贴板在服务端显式关闭（归前端 xterm.js）。

**双引擎行为差异表（AGENTS §8——前端不得以单一引擎行为推断另一引擎）**：

| 维度 | TmuxEngine | PtyEngine |
|------|-----------|-----------|
| 会话存活 | tmux server 常驻，后端重启幸存 | 后端进程持有，后端重启丢失 → D5 重建 + 回放 |
| is_active | control mode「最近 2s 有输出」 | 读循环时间戳 2s 窗口 |
| cwd 来源 | tmux `pane_current_path` | `/proc` 前台进程采样（Windows 回退 last_cwd） |
| agent 信道 | `@omniterm_agent` option 轮询（1s） | 屏幕检测（Phase 3 加 HTTP hook 推送） |
| capture | tmux `capture-pane`（干净文本） | alacritty_terminal VT grid 渲染（干净文本） |
| VT 应答（DSR/DA） | tmux server 自己应答，无此概念 | 按是否有客户端订阅二选一：attach 时浏览器应答 / detach 时服务端应答 |
| 外部会话收养 | 支持（D6 冻结能力） | 无对应物 |
| 补屏 | tmux `new-session -A` 原生 | 补屏环 ANSI 回放 + resize nudge |

## API Endpoints

```
GET  /api/v1/health
POST /api/v1/auth/setup|login|logout
GET  /api/v1/auth/check
POST /api/v1/auth/settings     # 密码验证总开关（受保护）
POST /api/v1/auth/change-password  # 受保护（需登录 + 当前密码）
GET  /api/v1/settings/acp-idle-recycle  # 读 ACP 空闲回收阈值（分钟；settings 表无记录/非数字回退 5）——受保护
PUT  /api/v1/settings/acp-idle-recycle  # 写 ACP 空闲回收阈值（分钟，值域 1..=60，越界 400）——受保护
GET  /api/v1/projects        # 响应每项含 path_valid：list_projects 实时计算项目路径是否仍存在（src/api/projects.rs），供前端标记失效项目
POST /api/v1/projects
DELETE /api/v1/projects/{id}   # 删除前级联清理其下全部 session 的运行时资源：kill tmux/psmux 会话 + dispose acp agent 子进程（与 DELETE /sessions/{id} 共用 cleanup_session_runtime）
GET  /api/v1/projects/{pid}/worktrees (git worktree discovery)
POST /api/v1/projects/{pid}/worktrees    # 非 git 仓库返回 400 {error, code:"not_a_git_repo", has_gitignore:bool}；请求体 init:true 时自动 git init + 初始提交
DELETE /api/v1/projects/{pid}/worktrees    # ?path=<worktree 绝对路径>[&delete_branch=true]；默认只 `git worktree remove --force`（**分支 ref 会保留**，仍出现在 /branches 与基准分支下拉）；`delete_branch=true` 时先从 `git worktree list` 反查该 path 对应分支（不信任前端传值）再 `git branch -D`，响应 `{ok:true, branch_deleted?:string, branch_error?:string}`——worktree 已移除后分支删除失败不降级为整体错误，而是用 `branch_error` 并存上报
POST /api/v1/projects/{pid}/git-init    # git init + 初始提交（前端确认「非 git 仓库」后调用）
GET  /api/v1/projects/{pid}/branches
GET  /api/v1/projects/{pid}/sessions
POST /api/v1/projects/{pid}/sessions
PATCH/DELETE /api/v1/sessions/{id}
GET  /api/v1/sessions/{id}/hook-status
POST /api/v1/sessions/{id}/hook-enable|hook-disable
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
GET  /api/v1/system/info              # home_dir + multiplexer（unix="tmux" / windows="psmux"，编译期 cfg 确定，前端展示用）
GET  /api/v1/system/version           # 版本检查（进程内缓存 GitHub latest，成功 1h/失败 5min）
POST /api/v1/system/update            # 一键升级（github_release 自替换 / npm 代跑；cargo 返回 400）
GET  /api/v1/git/status|diff|log|show|branches   # git panel reads; bind via ?session=|workspace_id=&workspace=
POST /api/v1/git/stage|unstage|commit|discard|checkout|branch|push|pull|fetch
ANY  /proxy/{port}/{*path}           # 端口转发反向代理（与 /api/v1 平级挂载，D1 禁止套进 /api/v1）；见「Port-forward proxy」小节
ANY  {port}.{proxy_domain}/*         # 子域名 Host 路由（仅配置 --proxy-domain/OMNITERM_PROXY_DOMAIN 时挂最外层 middleware，先于 fallback）；见「Port-forward proxy」小节
```

git 端点绑定规则（设计文档 ADR-2，`docs/dev/plans/2026-07-26-git-panel.md`）：复用 `files.rs::resolve_base_from_query` 解析 session/workspace 基准目录，再 `rev-parse --show-toplevel` 定位仓库根；**不接受任意路径参数**。非 git 目录返回 200 `{is_repo:false}`；失败返回 422（超时 504），body `{error, code}`，`code ∈ auth|non_fast_forward|no_upstream|dirty_worktree|timeout|generic`。所有 git 子进程带 `--no-optional-locks`、`GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND="ssh -oBatchMode=yes"`，远端操作 60s 超时。diff 超过 256KB 截断（`truncated: true`）。

## Port-forward proxy（`src/proxy/`）

`/proxy/{port}/{*path}` 把浏览器请求转发到宿主机 `127.0.0.1:{port}`，让机器 A 的浏览器经跑在机器 B 上的 OmniTerm 访问 B 的 localhost 服务（如 dev server）。设计见 `docs/dev/plans/2026-08-13-port-forward-proxy.md`（D1-D6）。

- **路由**：单一通配符 `/proxy/{*path}`（不拆 `{port}` + `{*rest}` 两条——axum 0.8 的 `{*rest}` 不匹配空剩余），handler 从通配符首个路径段解析端口，剩余路径取 `OriginalUri` 未解码原始路径（`strip_prefix("/proxy/{port}")`）。
- **安全边界（D2）**：目标 IP 永远硬编码 `127.0.0.1`，绝不从 path/header/query 解析地址。端口白名单 `3000..=65535` − 黑名单常量表（3306/5432/6379/27017/11211 + Consul 8500-8503 + ES 9200-9300）− 自身监听端口（`args.port` 经 `AppState.proxy.self_port` 注入，防回环）。路由挂 `require_auth_mw`（auth 开启时）；转发前剥离 `omniterm_token` cookie。
- **有界性（D5）**：请求体 `to_bytes` 上限 2MB（与 axum DefaultBodyLimit 一致）；响应 `Response::chunk()` + `unfold` 流式回写不 collect；WS 每方向 `mpsc(64)` 有界，满则拒新数据 + warn。
- **Header 重写（D6）**：请求侧 Host→`127.0.0.1:{port}`、剥离 hop-by-hop、剥离 **Accept-Encoding**（防上游返回 gzip 压缩体——reqwest 未启用自动解压，压缩字节经重写转码会被破坏，浏览器 `ERR_CONTENT_DECODING_FAILED`；强制明文 + 回环传输压缩收益可忽略）、WS 握手 Origin→`http://127.0.0.1:{port}`、Cookie 剥离 token；响应侧丢弃 Content-Length 改 chunked、`Set-Cookie` 剥离 `Domain=localhost` 并补 `/proxy/{port}` Path 前缀、`Location` 相对化（绝对路径/本机 URL→`/proxy/{port}/x`，外部 URL 不动）。
- **响应体重写（绝对路径 SPA 兜底）**：`text/html` 的 `src`/`href`/`srcset`/`action`/`poster` 属性、`text/javascript`（及 `application/javascript` 等）的 `"/api/`、`'/api/`、`` `/api/ `` 字符串字面量，统一补 `/proxy/{port}` 前缀。上限 HTML 4MiB / JS 16MiB，超限放弃重写、已读头部拼回流前部继续流式透传。重写是**全局一致**的——请求路径与 `===`/`includes` 比较字面量同步带前缀，比较逻辑不失真；外部 URL（`https://…`）、协议相对（`//cdn…`）、相对路径、已带 `/proxy/` 前缀的不动。见「响应体重写与绝对路径 SPA」小节。

### 子域名 Host 路由（`{port}.{base}`，D1 翻盘）

路径前缀无法代理**绝对路径资源**的 SPA（Vite `/@vite/client`、Next.js `/_next/*` 会绕过 `/proxy/{port}/` 前缀直达 omniterm-host 而 404）。配置 `--proxy-domain <base>`（env `OMNITERM_PROXY_DOMAIN`）后启用子域名方案：

- **入口**：最外层 middleware `proxy_host_mw`（仅 `base_host` 配置时挂载，先于 CorsLayer/TraceLayer/Router/fallback），`parse_proxy_host` 精确匹配 `{纯数字}.{base}`（可带 `:{listen_port}` 后缀，大小写不敏感），命中即代理、否则放行。端口白名单 + 鉴权（`verify_request`）与路径前缀入口完全等价——**子域名不走路由层 `require_auth_mw`，须在 middleware 内显式鉴权**，否则 auth 开启时成开放代理。
- **WS**：middleware 内 `is_ws_upgrade` 判头 + `WebSocketUpgrade::from_request_parts` 手动提取（middleware 无法用 extractor），复用 `ws::relay`。
- **鉴权 cookie 跨子域名**：登录/登出的 `omniterm_token` cookie 在启用子域名时加 `Domain={base}`（`src/api/auth.rs::token_cookie/clear_cookie`），使 `{port}.{base}` 子域名能携带 cookie 通过鉴权；未启用时维持 host-only。
- **前端**：`/system/info` 返回 `proxy_domain`，前端 `rewriteLocalUrl` 据此生成 `{port}.{base}` 子域名 URL（见 `docs/architecture/frontend.md`）。
- **DNS 部署（用户侧，非代码）**：局域网 IP 无法子域名（`3000.192.168.5.216` 非法），需用户配置可通配符解析的域名指向 OmniTerm 机器，三选一：局域网 DNS（dnsmasq/pihole `address=/.{base}/{IP}`）、公网 DNS（wildcard A 记录）、hosts 文件（逐端口加）。未配 DNS 则子域名不生效、路径前缀兜底。

### 响应体重写与绝对路径 SPA（路径前缀兜底，2026-08-14）

子域名方案依赖可通配符解析的域名，**局域网纯 IP 直连场景（`http://192.168.5.216:9777`）不可用**；Service Worker 方案需 secure context（HTTPS 或 localhost），局域网 HTTP 也不可用。因此路径前缀形态内置**响应体字节级重写**作为兜底，让绝对路径 SPA（new-api/one-api 等）在纯 IP 场景开箱即用：

- **HTML**（`text/html`）：重写 `src`/`href`/`srcset`/`action`/`poster` 属性值——`src="/assets/x.js"` → `src="/proxy/3000/assets/x.js"`。`srcset` 逗号分隔多项逐个重写（`/a.png 1x, /b.png 2x`）。
- **JS**（`text/javascript`/`application/javascript`/`application/x-javascript`）：重写字符串字面量 `"/api/`、`'/api/`、`` `/api/ ``（含模板字符串）——`fe.post("/api/card/batch")` → `fe.post("/proxy/3000/api/card/batch")`。不匹配变量拼接、正则字面量、相对路径。
- **边界**：① 超限（HTML 4MiB / JS 16MiB）回退流式透传（已读头部拼回流前部）；② 重写只覆盖「响应体静态内容」，**运行时动态拼接的绝对路径**（如 `"/api" + id`、服务端返回的 URL）覆盖不到，属已知限制；③ 内联 `<script>` 内的字符串不重写（HTML 属性重写只认属性）；④ **压缩体不重写**（2026-08-14 勘误）：reqwest 未启用 gzip feature（`default-features=false`），`chunk()` 返回压缩字节而非明文——`from_utf8_lossy` 转码会损坏 gzip 二进制，重写后响应头仍带 `Content-Encoding: gzip`，浏览器解码失败白屏（`ERR_CONTENT_DECODING_FAILED`）。修复：请求侧剥离 Accept-Encoding 强制上游回明文（主），响应侧 `Content-Encoding` 非空时跳过重写走流式原样透传（双重保险，压缩字节 + 保留编码头浏览器可正常解码）。
- **全局一致重写保证比较逻辑自洽**：请求路径字面量与 `===`/`includes` 比较字面量同步带前缀（如 new-api 的 `Y==="/api/ratio_config"`），故不破坏应用内路径判定。

### 多实现差异（AGENTS §8）

反向代理的「协议」= HTTP/WS，被无数 dev server 实现满足，不得以某一种（如 Vite）行为推断全部：

| 维度 | 差异 | 兜底 |
|---|---|---|
| 绝对路径资源 | Vite（`/@vite/client`、`/src/main.tsx`）、Next.js（`/_next/...`）用绝对路径，绕过 `/proxy/{port}/` 前缀直达 omniterm-host 而 404 | 路径前缀下 **HTML/JS 响应体重写兜底**（HTML 属性 + JS `/api/` 字面量加前缀，见上）；**子域名方案（`{port}.{base}`）根治**——浏览器对绝对路径的解析天然落到子域名 Host 上（D1 翻盘已实施，见上）；两者适用场景不同：子域名需可通配符解析域名，重写兜底覆盖局域网纯 IP |
| JS 运行时动态拼接路径 | 部分 SPA 用 `"/api" + id` 拼接、服务端返回 URL、axios 封装函数内拼 baseURL | 响应体重写覆盖不到，属已知限制（见上小节「边界」）；子域名方案不受此限 |
| WS 子协议 | Vite HMR 用 `vite-hmr`；Socket.IO 自定义；graphql-ws 用 `graphql-transport-ws` | 透传 `Sec-WebSocket-Protocol`，不假设不硬编码 |
| Origin 校验 | 部分 dev server（webpack-dev-server 等）严格校验 Origin；Vite 较宽松 | WS 握手统一重写 Origin 为 `http://127.0.0.1:{port}` 兜底 |
| Cookie 域 | 目标服务可能 `Set-Cookie` 带 `Domain=localhost` 或绝对 `Path` | 响应侧统一重写（D6） |

## ACP Module (Phase 3)

`src/acp/` is the ACP (Agent Client Protocol) adapter that turns OmniTerm into a generic agent hub. It is runtime-agnostic — any agent that speaks ACP over stdio ndJSON can be plugged in via an `agents` table row.

Lifecycle:
1. `POST /projects/{pid}/sessions` with `runtime_kind: 'acp'` and `agent_id` → `api::sessions::create_session` resolves the workspace path, loads the `Agent`, calls `AcpClient::spawn_and_connect`, and registers the client in `AcpSupervisor`.
2. `AcpClient::spawn_and_connect` builds an `AcpAgent` transport (`KEY=VALUE` env prefix + command + args), runs `Client::builder().connect_with(transport, closure)`. Inside the closure it sends `InitializeRequest` + `NewSessionRequest`, clones the `ConnectionTo<Agent>` (which is `Clone` — channel senders) out via a oneshot, then waits on a shutdown oneshot.
3. Handlers registered on the builder:
   - `session/update` notification → broadcast via `session_update_tx` to all WS subscribers.
   - `request_permission` → `PermissionManager` 登记 pending 并经 WS 推 `permission_request` 帧给前端 banner，由用户点击 `permission_response` 应答。**无超时自动应答**（ACP 规范 `Cancelled` outcome 仅限响应 `session/cancel`）；`session/cancel` 时 `AcpClient::cancel` 调 `cancel_all()` 以 `Cancelled` 应答全部 pending（规范 MUST）；WS 重连时重放 pending 事件恢复 banner；审批解决（用户应答 / cancel_all）时经 `resolved_tx` broadcast 推 `permission_resolved{id}` 帧给所有连接——审批可能由其他标签页/设备应答，各连接据此即时清除对应 banner；无人应答的兜底回收由 reaper 负责（30 分钟 cancel + disconnect）。
   - `terminal/{create,output,wait_for_exit,kill,release}` → `AcpTerminalManager` spawns `tokio::process::Command` children and monitors them with `tokio::select!` racing child exit vs an mpsc kill channel.
   - `fs/read` / `fs/write` → stubs (Phase 3); Phase 4 will plumb them through the existing `fs/` module.
4. `WS /ws/acp/{session_id}` subscribes to the broadcast; client messages `{"type":"prompt","text":…,"images":[{data,mime_type}…]?}` and `{"type":"cancel"}` are forwarded to the `AcpClient`. Prompt `images`（可选，≤3 张 base64）映射为 `ContentBlock::Image` 追加在 text block 后；服务端推送 `{"type":"capabilities","image":bool}` 帧（client 就绪/restore 时），值来自 initialize 捕获的 `promptCapabilities.image`（§8：agent 未声明则前端隐藏附件入口、后端拒绝带图 prompt）。Prompt 文本中的 `@path` 引用（`@` 前须行首/空白，去重上限 8）由 `ws/acp.rs::resolve_at_references` 解析：相对 session `workspace_path` 经 `fs::sanitize_path` 校验后读取（≤64KB 截断，越界/不存在/目录/非 UTF-8 静默跳过），注入 `ContentBlock::Resource`（TextResourceContents，`file://` URI）；agent 未声明 `promptCapabilities.embeddedContext` 时降级为内容内联进 text block（§8）。
5. `DELETE /sessions/{id}` on an ACP session calls `supervisor.dispose` + `AcpClient::shutdown`（shared reference 强制 kill 子进程，不依赖 Arc 引用归零——WS handler 持引用时 `disconnect` 无法消费 self），连接任务退出后子进程被 reap。
6. `DELETE /projects/{id}` 先取该项目下全部 session 的 `id`/`tmux_session_name`/`runtime_kind`，逐个调用 `api::sessions::cleanup_session_runtime`（acp → dispose + `shutdown`；tmux → `activity_monitor.remove_session` + `tmux::kill_session`），再删 `sessions`/`projects` 行——**删库不等于杀进程**，直接 `DELETE FROM sessions` 会让 psmux/tmux 会话与 agent 子进程残留（2026-08-04 修复）。`reaper` 空闲回收与手动 `release` 同样走 dispose + `shutdown`，保证 supervisor 移除与进程死亡同步（Sidebar `acp_process_alive` 才不会与实际进程存活脱节）。

### 流式消息后端权威持久化（turn accumulator）

消息真相源在后端，不依赖前端页面保活。`AcpClient` 持有 `accumulator: Arc<TurnAccumulator>`，在 `spawn_and_connect` / `spawn_and_load` 两处 `on_receive_notification` 回调（运行在 ACP 连接任务上、**不依赖任何 WS 客户端存活**）内喂入每条 `session/update`。

- **turn 门控排除重放**：累积仅在 `active` 时进行。turn 只由 `mark_prompt_active()`（用户 prompt 路径）开启，`load_session` 重放从不调用它 → 重放帧结构性地不被折叠。
- **fold**：`active` 时把 `serde_json::value::to_raw_value(&update)` 追加进 `frames`（预序列化 `RawValue`：窗口字节数免手工计量，flush 时只拷贝字节而非重新格式化），从 `AgentMessageChunk` 的文本块提取纯文本累加进 `text`（唯一的轻量提取，非完整分类；`text` 同样有界，见下文「正文列限界」），置 `dirty` 并向 writer 发 `Flush`。
- **窗口双维度限界**（`MAX_FRAMES=2000` 帧数 / `MAX_BLOCKS_BYTES=128KB` 字节 / `MAX_FRAME_BYTES=64KB` 单帧）：超限从队首淘汰，单帧超限则不入窗（其文本仍进 `text`，而 `text` 自身另有上限，见下条）。字节维度是必须的，不是保险——**单帧大小由 agent 决定，不由我们决定**（§8 实测差异：codebuddy 每个 `tool_call_update` 只带 1 字符增量内容，却在每一帧里重复携带完整 `rawInput`，实测 4.5KB/帧，>97% 是同一份副本；opencode/ccb 未观察到此行为）。仅限帧数时 2000 帧窗口曾达 8.7MB 单行，使 `GET /messages` 下发 15MB、切 ACP 会话阻塞约 0.5s。代价：肥帧下结构恢复窗口缩到数十帧，可接受——`text` 保全正文（在其自身上限内），且前端分类器把同 `toolCallId` 的所有 update 折叠成一张卡片，渲染结果几乎不变。
- **正文列限界（`text`）**（`MAX_TEXT_BYTES=1MiB` 总上限 / `TEXT_HEAD_BYTES=256KiB` 头部 / `TEXT_MARKER_MAX_BYTES=96` 标记预留 / 余下为尾窗）：**过去 `text` 是故意留的无界兜底，那本身就是缺口**——兜底路径不会因为叫兜底就不增长（实测单行 9,150,950 字符，所在会话只有 19 条消息），而每次防抖 flush 都重写整列，无界正文即 O(n²) 写放大（§P2）。超限策略是**头尾保留 + 中段显式标注**：渲染值为 `头部 + …（已省略 N 字符）… + 尾部`。三个不能简化的约束：（a）头部一旦封口就永久冻结，因为 UTF-8 边界会让它停在预算之下几字节，续填会把更新的文本插到更旧的文本之前；（b）尾窗按 1/4 预算的块摊还修剪，修剪到恰好等于预算则此后每个 chunk 都要 memmove 整个尾窗（又一个 O(n²)）；（c）单个 chunk 自身超预算时先裁再入缓冲，否则内存峰值等于 chunk 大小、上限形同虚设（与 `MAX_FRAME_BYTES` 存在的理由同构）。切割一律走 `floor_char_boundary` / `ceil_char_boundary`——切在多字节字符中间会 panic，而这段代码跑在 ACP 连接任务上，会折断整条连接。**对前端的影响**：`ChatView.tsx` 的 `toChatMessages` 在 blocks 解不出结构时会回退到 `text`，所以兜底文本在超长正文下**可能不完整但一定可读**（标记是给人看的，不是内部哨兵）。
- **blocks 列格式**：streaming 与 complete 行的 `blocks` 都存**原始帧包裹** `{"v":1,"frames":[<update>,...]}`（`finalize` 只翻 status，不重写 blocks）；前端复用现有 TS 分类器还原成结构化 blocks，杜绝 Rust 侧重复分类逻辑（AGENTS.md §8 / 禁 Copy-Paste）。cooked `ContentBlock[]` 数组用于 user 图片消息、**turn 结束后的回写**、`load_session` 重放写回、legacy 行——判别：数组=cooked，对象含 `frames`=原始帧。
  > **存量数据**：上述字节上限只作用于新写入。修复前产生的超大行（本地实测最大单行 9MB）仍会让那些历史会话首次打开时慢，需要时另做一次性截断迁移。
- **存储格式两态与收敛时机**：streaming 期间 `blocks` 是**原始帧** `{"v":1,"frames":[...]}`；前端用 **cooked** `ContentBlock[]` 经 `sync_messages` 覆盖它。两者体积差两个数量级——cook 把同一 `toolCallId` 的上千个 `tool_call_update` 折叠成一个 `tool_call`，每帧重复携带的 `rawInput` 副本只剩一份（实测：cooked 行最大 114KB，同库未被覆盖的原始帧行达 9,150,950 字符）。两个收敛触发点：
  - **`prompt_done`（每 turn）**：帧携带本 turn 的 `row_id`，前端只发**本 turn 一条** payload 按行 id 回写。不发全量——每 turn 重写整个会话是 O(m²) 写放大。短 turn 可能抢在防抖写之前 sync（影响 0 行），该行留在原始帧态。
  - **`replay_end`（手动 restore，罕见）**：全量写回，无 id 走文本匹配。

  前端 cook **不是重复劳动**而是唯一的体积收敛路径；但窗口上限（`MAX_BLOCKS_BYTES` / `MAX_FRAME_BYTES`）仍是必需兜底——前端不在线时（用户关了浏览器而 agent 继续跑）无人 cook。代价：cooked 覆盖后原始帧不可恢复，失去「分类器升级后重新解释旧历史」的能力（已明确接受，见计划 D2）。详见 `docs/reference/chat-history-loading-comparison.md`。
- **进行中行**：`chat_messages.status`（`streaming` | `complete`，migration `20260730_chat_message_status.sql`，字面默认值保持旧行有效）+ `last_seq`。一行一 turn，懒创建避免空气泡。防抖 writer（trailing ~250ms + max-latency ~1s）合并突发 `UPDATE`；`upsert_streaming_message`（INSERT..ON CONFLICT(id) DO UPDATE）/ `finalize_message`。DB sink 经 `attach_persistence(db, db_session_id)` 附加，仅在真实注册点（create session、load restore）调用；能力探针不 attach → fold 为内存 no-op（不改 spawn 签名）。
- **生命周期钩子**（挂 `AcpClient`，幂等）：`mark_prompt_active`→`begin_turn`；`send_prompt` 返回 / crash watcher→`finalize_turn`。cancel **不立即** finalize：合作的 agent 收到 `session/cancel` 后会让 `send_prompt` 以 `Cancelled` 返回、走正常定稿路径（取消后补发的尾部帧照常落库）；无视 cancel 的实现（§8）由 `spawn_cancel_turn_fallback` 兜底——超时（`CANCEL_TURN_FALLBACK_SECS`）后若同一 turn 仍在进行（prompt 世代计数守卫）则强制 `mark_prompt_idle` + 广播 turn 结束。
- **启动自愈**：`main.rs` migrate 后 `UPDATE chat_messages SET status='complete' WHERE status='streaming'`（重启后不可能有进行中 turn）。

#### 历史分页：`GET /sessions/{id}/messages`

参数 `?before=<cursor>&limit=<n>`，响应 `{ messages, hasMore, nextCursor }`，messages 永远**旧→新**排序（前端可直接前插）。

- **双预算切页**（与 turn 窗口同一哲学）：`MESSAGES_PAGE_DEFAULT_LIMIT=100` 条 / `MESSAGES_PAGE_MAX_LIMIT=500` 硬顶 / `MESSAGES_PAGE_MAX_BYTES=2MiB`。字节预算从最新端累加，**总至少返回一条**——否则单条超预算的存量巨行会让客户端无限翻页却永远渲染不出。
- **预算在 Rust 层而非 SQL 层**施加：本地 SQLite 读取比序列化+传输便宜一个数量级（实测 11MB 会话：读 50ms vs 序列化+传输 450ms+），限住「出进程的量」才是杠杆。
- **游标是复合的** `(created_at, id)`，编码为不透明字符串 `<created_at>|<id>`：`created_at` 单键**不是全序**（实测真实数据中 4 条消息同为 `06:17:57`），仅用它会在同秒边界上重取或漏取。
- **坐标不合法返回 400** 而非静默回退到首页：静默回退会让分页客户端反复拿到同一页而死循环。
- **与 `sync_messages` 兼容**：后者从不 DELETE，所以前端 store 里只有部分历史时写回不会删掉未加载的更早行。

#### 回写匹配语义：`POST /sessions/{id}/messages/sync`

前端把重建（`replay_end`）或 cooked 的消息写回时，每条 payload 项**带不带 `id` 决定走哪条路径**——两者不可合并，因为前端消息的 id 有两个来源：hydrate 来的是真 DB 行 id，live/replay 自造的 `genId()` 在 DB 中不存在。

| payload | 匹配 | 未命中时 | 更新范围 |
|---|---|---|---|
| 带 `id`（权威：hydrate 行 / turn 的 `row_id`） | `WHERE id=? AND session_id=?` | **跳过**（不猜、不 INSERT） | 只 `blocks` |
| 无 `id`（replay 重建） | `(session, role, text)` 的候选行按 `(created_at, id)` 取一条 | INSERT 新行 | 只 `blocks` |

- **一条 payload 只消费一行**，且同一次调用内已消费的行 id 不再命中。此前 `UPDATE ... WHERE session_id AND role AND text` 无行限定，把 text 相同的所有行一次覆盖成同一份 `blocks`（dev 库实测：14 行 `assistant`/"OK" 只剩 1 份 distinct blocks）。**匹配键不唯一等于没有约束**，与「上限维度选错」「淘汰轴选错」同族。
- **带 id 的路径不更新 `text`**：`text` 的权威在后端累积器，前端只拥有 cooked `blocks`。
- **未命中即跳过**是刻意的：短 turn 可能抢在防抖写之前 sync，此时行还不存在——留在原始帧态可自愈，猜一行更新则是不可逆的错误赋值。

### 配置偏好持久化（两层记忆）

底部配置栏（mode/model/thinking/config 选择器）的值**跨进程重启/新会话记忆**，migration `20260804_acp_config_preferences.sql`：

| 表 | 语义 | 应用时机 |
|----|------|---------|
| `session_config_options(session_id, config_id, value, updated_at)` | 会话级覆盖：单个会话内用户主动 set 过的配置 | restore 该会话时优先（覆盖 agent 级） |
| `agent_config_preferences(agent_id, config_id, value, updated_at)` | agent 级全局偏好：用户为该 agent 设过的配置 | 新建/恢复会话时作为默认值 |

- **写入时机**：只在**用户主动 set**（`AcpClient::set_config_option` 成功，`src/ws/acp.rs` 收 `set_config_option` 帧）时写库，不记 agent 内部状态变化。句柄经 `attach_config_prefs(db, db_session_id, agent_id)` 绑定（仿 `attach_persistence`），仅在真实会话注册点（create session / load restore）设置；能力探针不绑定 → 写入/恢复 no-op。
- **恢复时机**（`AcpClient::restore_config_prefs`）：读 agent 偏好 + 会话级 → 合并（会话级覆盖）→ 逐项 `set_config_option`。**必须在 `initial_config_options` 缓存已填充后调用**——create 路径 `spawn_and_connect` 已走 `NewSession` 可立即恢复；load 路径 `spawn_and_load` 缓存恒为空（不发送 NewSession），须等 `load_session` 返回（缓存被 `LoadSessionResponse.config_options` 回填）后再恢复。恢复广播的 `ConfigOptionUpdate` 经 replay staging 在 `ReplayEnd` 时落位，前端零改动。整体 10s 超时，单项目失败 warn 跳过。
- **删除清理**：SQLx 默认开启 `foreign_keys`（`ON DELETE CASCADE` 生效），`delete_session` / `delete_project` / `delete_agent` 的显式 `clear_*` 为防御性兜底。
- **§8 多实现差异**：restore 只匹配 agent **当前**仍提供的 `config_id`（缓存过滤，agent 已移除项自动跳过）；`validate_config_value` 校验值合法性——Boolean 限定 `"true"/"false"`，Select 扁平化 Ungrouped/Grouped 匹配，**options 为空放行**（不因信息缺失阻断恢复）。agent 不在 NewSession/LoadSession 响应返回 `config_options` 时（如 opencode 的 load 响应），restore 自动跳过（缓存空无法过滤、也不盲发）——该边界下配置栏本就可能为空，属已知能力边界。

### 重连续接协议（seq + turn_snapshot / turn_state）

per-client 单调 `seq`（`handler::handle_session_update` 在累积器锁内分配，跨 turn 不重置），broadcast 载荷为 `SeqNotification{ seq, notification }`；WS `session_update` 帧带 `seq`（config/commands/replay 帧无 seq）。连接时 supervisor-hit 分支**先 subscribe 再 snapshot**（消除 gap，把重叠窗变为 seq 可解的重复窗）：发 `turn_state{active}`，若 active 再发 `turn_snapshot{row_id, text, blocks, seq}`。前端据此按 `row_id` 收编在建消息、以 `seq` 为水位丢弃重叠重复帧（详见 frontend.md）。

`prompt_done{stop_reason, row_id?}` 同样携带本 turn 的 `row_id`（与 `turn_snapshot.row_id` 同一个值，`None` = 本 turn 未折叠任何帧），供前端把 cooked blocks 精确回写到那一行。三个广播点（正常完成、cancel 兜底、reaper 超时）均经 `AcpClient::turn_row_id()` 取值——专用轻量访问器，**不走 `turn_snapshot()`**（后者克隆全量 `text` 并重新序列化整个帧窗口，为拿一个 id 不值得）。`row_id` 存活到下一次 `begin_turn`，所以定稿后仍可读。

turn 结束信号（`prompt_done{stop_reason}` / `prompt_error{message}`）经 `AcpClient` 的 `turn_end_tx` broadcast 发给**所有** WS 连接（`spawn_turn_end_task`），与 `session_update`/`crash` 同模式。不能只回发起 prompt 的连接：prompt task 存活期跨 WS 重连，per-connection 通道会把结束帧发进死连接被静默丢弃，重连后的前端永远停留在 running 态。

### 权限审批帧协议（permission_request / permission_resolved / permissions_synced）

未决审批的权威在后端 `PermissionManager`（`src/acp/permission.rs`），支持**并发多个** `request_permission`（HashMap 按 id 挂起）。三条前端收敛路径：

- **事件驱动**：`handle_request` 广播 `permission_request`；`resolve` / `cancel_all`（用户应答、session cancel、reaper 权限超时 cancel）广播 `permission_resolved{id}`，所有连接据此出队。
- **连接重放 + 对账标记**：连接时逐条重放 `pending_events()`，完毕后发 `permissions_synced` 标记帧——前端清掉不在重放集合里的陈旧 banner（断连窗口错过 resolved 广播的过期项）。`restore_acp_session` 的新 client 无未决审批，同样发该标记清掉旧 client 遗留 banner。
- **resolve 失败收敛**：`permission_response` 消息 resolve 返回 false（审批已被其他连接应答 / cancel / 会话已释放）或 client 缺失时，向本连接回发 `permission_resolved{id}`，让陈旧点击收敛清除而非静默无响应。

前端侧为按 id 的**队列**（`chatStore.pendingPermissions`，上限 16 丢新到达项 + warn），UI 显示队首——单槽会被并发审批互相覆盖导致被覆盖项无 UI 入口、会话卡死。turn 收尾（`markDone`）**不得**清队列：合法清除只有上述三条路径（教训见 `docs/dev/debug-patterns/frontend-react.md` 模式 8）。

### 发送即自动恢复（进程已释放）

reaper 空闲回收 / 手动 release / 后端重启都会让 ACP agent 子进程离开 supervisor，但 WS 连接（`ws/acp.rs::handle_acp_ws`）不随之关闭——主循环仍持有 `notify_tx`，`client` 为 `Some`（连接已死）。此前用户此时发送 prompt 会命中死连接，`send_request` 报 "connection is no longer running" 原样透传前端。现在：

- **Prompt 到达时按需恢复**：`AcpClient::is_alive()` 组合显式 `alive: AtomicBool`（`shutdown()`/`disconnect()` 置 false——主动回收不触发 incoming EOF，仅靠 `is_incoming_closed()` 会误判死连接为存活）+ `!connection.is_incoming_closed()`（兜底 agent 崩溃的 EOF 路径）。client 缺失或已死 → 调 `restore_acp_session`（spawn agent + supervisor 注册 + 历史重放转发，与手动 `load_session` 复用同一流程），返回 `(new_client, replay_handle)`；replay 任务携带 load 结果（`JoinHandle<Result<(), String>>`），**仅 load 成功后**才经 `dispatch_prompt` 发送 prompt（避免与 replay 帧交错，更避免发进未加载/已死的会话）。前端零改动——重放走既有 replay 协议，`suppressReplay`（非手动 restore 且本地已有消息）自动丢弃重放内容帧，用户刚发的消息保留。
- **load 失败不发送 + 清理重试**：`session/load` 失败（agent 拒绝/进程死亡）时 replay 任务发 `load_failed` error 帧代替 `replay_end`，prompt 不 dispatch；同时若 supervisor 中仍是该 client（`Arc::ptr_eq` 防误删并发恢复的新 client）则 dispose + shutdown，让下次发送从干净状态重试恢复。
- **释放态发送的报错可读化**：`dispatch_prompt` 失败时若 `is_alive()` 已为 false（reaper 回收等在途 kill），不透传库的 "connection is no longer running"，改发「会话进程已释放，请重新发送以自动恢复连接」；连接存活时的 agent 侧错误仍原样透传。
- **连接时区分「已释放可恢复」与「已删除」**：supervisor miss 时查 `sessions` 行存在性。行存在（可恢复）→ 只发 `process_alive:false` 不发 `session_not_found`，前端保持 released 态、输入可用；行已删 → 发 `session_not_found` 标记 ended。
- **`acp_process_alive` 恒序列化**（`src/models/session.rs`，移除 `skip_serializing_if`）：此前 false 不出现在 `list_sessions` 响应，前端 3s 轮询整体替换 sessions 会把「已释放」态覆盖成 undefined，导致恢复按钮/DEAD 指示闪断。

### Multi-implementation compatibility

ACP is a protocol satisfied by multiple agent implementations. **Do not assume one implementation's behavior is the protocol.** For any field/notification/capability that is optional or may be absent, implement a fallback and document the divergence in code comments — but keep case-specific details out of AGENTS.md (they go stale). Before adding protocol-touching logic, verify the field's behavior across implementations rather than inferring the whole from one. (See AGENTS.md §8 多实现兼容性.)

已确认的行为差异：

- **`session/load` 历史回放为 agent 可选行为**：协议只要求 agent 接受 load 请求，是否把历史以 `session/update` 逐帧回放、回放多少条均不保证（omp 回放全量 285 条长历史，其他实现可能只回放部分或完全不回放）。因此后端重放转发必须边加载边并发转发（`ws/acp.rs`，broadcast 容量不构成上限，`Lagged` 仅告警不中断）；前端必须容忍空回放——staging 双缓冲在 `replay_end` 非空时才原子替换本地消息，空回放/失败保留 DB 水合的本地记录（`useAcpChat.ts` / `chatStore.commitReplay`）。
- **审批不一定都走 `session/request_permission`**：agent 内部的确认门（如 plan 模式的提案批准）可能在 agent 侧本地自动通过、完全不发 ACP 权限请求（实测 omp 的 propose 工具 4ms 内本地返回 "Plan approved"）。client 端无法拦截这类 agent 内部决策，权限 UI 只覆盖 agent 主动发来的 `request_permission`。

## CLI Reference

CLI 为 clap 4 子命令结构（`src/main.rs` 定义枚举与 dispatch；`update` 逻辑在 `src/update.rs`）。**CLI 输出统一英文**（help、启动/停止/状态提示、错误消息），与前端 i18n（zh/en）相互独立。

```
omniterm <COMMAND>

Commands:
  start       Start the server (foreground by default; add -d/--daemonize to run in background, Unix only)
  stop        Stop the background server (sends SIGTERM via the PID file)
  status      Show server running status
  reset-auth  Delete all user accounts (use after forgetting the password, then start to set a new one)
  update      Self-update to the latest release

start options:
  -p, --port <PORT>       Listen port (default: 9077; dev.sh 各 worktree 经 -p 传 9777 [dev] / 9075 [preview]) [env: OMNITERM_PORT]
      --db <DB>           Database connection string [env: OMNITERM_DB]
      --jwt-secret <KEY>  JWT signing key [env: OMNITERM_JWT_SECRET] (auto-generates a random key persisted to ~/.omniterm/jwt_secret if unset)
      --auth-enabled      Force password verification [env: OMNITERM_AUTH_ENABLED] (accepts 1/0/true/false; DB value used if unset)
      --reset-auth        Delete all users before startup [env: OMNITERM_RESET_AUTH]
  -d, --daemonize         Run in background (Unix only; errors on Windows), logs appended to ~/.omniterm/<binary>.log; the parent process blocks until the daemon binds the port — on success it prints "OmniTerm vX.Y.Z started in the background — http://host:port (PID)", on failure (port in use / DB unreachable) it prints the error to the terminal and exits non-zero, never silently "succeeding"
      --debug             Force omniterm debug logging (equivalent to RUST_LOG=omniterm=debug, takes precedence over the omniterm level in RUST_LOG)

stop / status / reset-auth options:
      --db <DB>           Database connection (used to locate the PID file) [env: OMNITERM_DB]

update options:
      --check             Only check for a new version, do not update
```

日志级别由 `RUST_LOG` 环境变量控制（`tracing_subscriber::EnvFilter`）：未设置时默认 `omniterm=info`（只输出 omniterm 的 info/warn/error，屏蔽 debug）；需要调试日志时用 `omniterm start --debug`（优先级高于 `RUST_LOG` 中 omniterm 的级别，其余 target 保留）或设 `RUST_LOG=omniterm=debug`（或更具体 target 如 `RUST_LOG=omniterm::tmux=debug`）。`dev.sh` 已兜底 `export RUST_LOG="${RUST_LOG:-omniterm=info}"`。

### `update` 渠道感知自更新

按 `current_exe()` 路径检测安装渠道，统一先查 GitHub `releases/latest`（semver 三态比对：相等→已最新；本地更新→提示 development build 不动作；远端更新→执行）：

| 渠道 | 判据 | 行为 |
|------|------|------|
| npm | 路径含 `node_modules` | 代跑 `npm install -g @gdwhisper/omniterm@latest`（透传退出码）。**不用 `npm update -g`**：`update` 受已安装 semver range 约束（不跨 major），且对平台二进制所在的 optionalDependencies 重解析不可靠 |
| cargo | 位于 `$CARGO_HOME/bin`（fallback `~/.cargo/bin`） | 代跑 `cargo install omniterm`（不自替换，避免与 `.crates.toml` 元数据脱钩） |
| 其它（install.sh / 手动） | 兜底 | 下载平台 asset → sha256 digest 校验（GitHub API asset `digest` 字段，缺失则跳过）→ spawn `--version` 验证 → 同目录临时文件原子 rename 替换；目录不可写提示 `sudo omniterm update`（不自动提权）；Windows 走 rename-self-to-`.old` 手法 |

Asset 命名与 `install.sh` 平台映射表一致（`omniterm-{os}-{arch}`，Windows 为 `.zip`）。任何失败不留半更新状态（写操作全在临时文件，rename 是最后一步）。

- 升级命令统一为 `npm install -g <pkg>@latest`。**Windows npm 渠道的已知行为差异**：npm reify 先把旧包目录 rename 为 `node_modules/@gdwhisper/.omniterm-<hash>`（retire）再就位新包，最后删 retire 目录。Windows 允许 rename 含运行中 exe 的目录、但不允许 unlink 运行中的 exe，所以服务器（或 `omniterm update` 自身）运行时升级会输出 `npm warn cleanup ... EPERM ... unlink omniterm.exe`。**这是成功路径**：新版已就位、退出码 0，仅留下一个待清的 retire 目录，且运行中的进程仍执行旧映像（必须重启才生效，即 `restart_required`）。CLI 在 Windows 下会补一句消歧义提示，避免用户把 warn 误读为失败。

**Web 端点**（`src/api/system.rs`，供 Sidebar UpdateBadge 用）：
- `GET /system/version` → `{current, latest, update_available, channel}`。后端做 semver 比较（dev 领先时 `update_available: false`）；GitHub latest 结果进程内缓存（成功 TTL 1h、失败负缓存 5min，防匿名限流 60 次/时）；GitHub 不可达且无缓存 → 502，前端 silent 降级不显示 badge。
- `POST /system/update` → 一键升级。`try_lock` 全局锁防并发（占用中 409）；先 fresh 查询，无新版 409 `already up to date`；`github_release` 走 `self_replace`，`npm` 走 `delegate_captured`（300s 超时 → 504），`cargo` 编译耗时过长不支持一键 → 400 `unsupported_channel`（前端只显示命令提示）。成功返回 `restart_required: true`，**不自动重启服务器**（持有 tmux/ACP/WS 连接），提示用户 `omniterm stop && omniterm start`。
- `delegate_captured()`（捕获输出、失败带 stderr 尾部返回 Result）专供服务器进程；CLI 的 `delegate()` 透传 stdio 且失败 `std::process::exit`，**严禁在服务器内使用**。两者都经 `resolve_program()`（`which` 解析为绝对路径）再 spawn：Windows 上 `std::process::Command` 只按 PATH 补 `.exe`、不读 `PATHEXT`，传裸名 `npm` 会因实际只有 `npm.cmd` 而报 `program not found`；`which` 遵循 PATHEXT，且 std ≥1.77.2 对 `.bat`/`.cmd` 结尾的 program 自动用 cmd.exe 包装（含 CVE-2024-24576 转义）。

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMNITERM_DB` | 按 argv0 推导（`~/.omniterm/<binary>.db`） | SQLite connection string（等价 `--db`） |
| `OMNITERM_JWT_SECRET` | 无默认值；缺省时自动生成随机密钥并持久化到 `~/.omniterm/jwt_secret`（0600） | JWT signing secret。不设公开默认值——可预测的密钥等于无鉴权 |
| `OMNITERM_AUTH_ENABLED` | 未设置时用 DB 值（`settings.auth_enabled`） | 强制密码验证开关（`1/0/true/false`），覆盖 DB 设置并写回。Docker/公网部署应显式设 1 |
| `OMNITERM_HOST` | `127.0.0.1` | 监听地址（等价 `-H`）；Docker 传 `0.0.0.0` 全网暴露 |
| `OMNITERM_PORT` | `9077` | 监听端口（等价 `-p`） |
| `FRONTEND_DIR` | `frontend/dist` | Static files dir; falls back to embedded |

**只认 `OMNITERM_*` 前缀**：通用名 `BIND_ADDR` / `BACKEND_PORT` / `DATABASE_URL` / `JWT_SECRET` 已全部弃用且**不再读取**（启动时若检测到会 warn 提示改名）。原因：这些名字会被继承的环境意外命中——开发实例派生的终端里启动 npm 正式版会被 `BIND_ADDR=127.0.0.1:<dev port>` 劫持（报 `Address already in use`），而 `DATABASE_URL` 是用户自己项目里极常见的变量（指向 Postgres 等），会让 omniterm 连错库。部署层改用 `OMNITERM_HOST` + `OMNITERM_PORT`（docker）或命令行参数（dev.sh）。

## Auth 安全模型

单用户（admin）密码认证，无状态 JWT（HS256，90 天）经 HttpOnly + SameSite=Lax cookie 传递。

- **密码验证总开关（`settings.auth_enabled`）**：**全新安装默认关闭**（免密码直接使用）；用户在 设置 → 认证 自行开启（首次开启要求设置密码）。**升级保护**：已有密码用户的部署在迁移后自动置 1，绝不静默降级；**Docker 部署默认 1**（`docker-compose.yml` 显式 `OMNITERM_AUTH_ENABLED=1`，因为 `OMNITERM_HOST=0.0.0.0` 全网暴露）。`OMNITERM_AUTH_ENABLED` 环境变量可强制覆盖并写回 DB。启动时若「鉴权关闭 + 非回环监听」输出醒目警告。关闭状态下 `require_auth_mw` 直接放行、`/auth/check` 返回 `authenticated: true`，前端不显示登录页；开启状态恢复完整鉴权。开关 API：`POST /auth/settings`（受保护）。
- **密钥**：`OMNITERM_JWT_SECRET` 无公开默认值。缺省时启动流程生成 256-bit 随机密钥并持久化到 `~/.omniterm/jwt_secret`（0600）；容器/多实例场景建议显式设置 `OMNITERM_JWT_SECRET`（自动生成的文件随容器重建丢失，届时需重新登录）。
- **token 吊销（`users.token_version`）**：JWT claims 携带 `ver`，验证时（`auth::verify_token_for_state`）与 `users.token_version` 比对。登出与改密均递增版本号 → 所有旧 token 立即失效。升级到本机制后所有存量 token 失效一次，需重新登录。
- **登录限流（`auth::LoginGuard`，`src/auth/rate_limit.rs`）**：IP 维度滑动窗口（5 次失败 / 5 分钟），超限返回 429 且不再执行 bcrypt。覆盖 `/auth/setup`、`/auth/login`、`/auth/change-password`（后者的 current_password 验证是等价暴力面）。成功登录/改密清零窗口。
- 登录失败与无用户均 sleep 1s（响应时间一致防枚举）；密码 bcrypt cost 10 存储，不落日志。

## Settings 表

`migrations/20260801_add_settings_table.sql`：全局 KV 设置（key → value 字符串）。当前 key：

| key | 语义 | 消费方 |
|-----|------|--------|
| `auth_enabled` | 密码验证总开关（`'1'`/`'0'`） | `main.rs` 启动注入 `AppState.auth_enabled`；`POST /auth/settings` 切换 |
| `acp_idle_recycle_min` | ACP 空闲回收阈值（分钟，值域 1..=60） | `main.rs` 启动解析（缺失/非数字回退 `IDLE_RECYCLE_SECS`=300s）注入 `AppState.acp_idle_recycle_secs: Arc<AtomicU64>`；`src/acp/reaper.rs` 每个 tick 动态 `load`（运行时热更新） |

**ACP 空闲回收阈值 API**（`src/api/settings.rs`，挂载在 `require_auth_mw` 保护路由组）：`GET /api/v1/settings/acp-idle-recycle` 返回 `{minutes}`，无记录/非数字回退默认 5；`PUT` 校验分钟值 1..=60（越界 400），合法则 upsert settings 表并热更新内存秒级阈值（分钟×60）。`run_reaper(supervisor, idle_recycle_secs)` 的 idle 判定每次读取该共享值，改配置无需重启即生效。`IDLE_RECYCLE_SECS` 保留为 DB 无配置时的兜底默认；`REQUIRES_ACTION_RECYCLE_SECS`（1800s）与 `PROMPT_STALE_SECS`（600s）仍为硬编码，本次仅把 idle 阈值提为可配置。

## Sessions Table

定义在 `migrations/20260620_init.sql` + `20260625_workspace_to_project.sql` + `20260715_add_runtime_kind.sql` + `20260812_add_last_cwd.sql`。

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | UUID |
| `project_id` | TEXT FK | 所属项目 |
| `workspace_path` | TEXT | 工作目录 |
| `name` | TEXT? | 用户可见名 |
| `tmux_session_name` | TEXT? | 引擎内会话键（冻结列名，两引擎共用，D10）：tmux 为 `lt_xxxxxxxx`，pty 为 session id；ACP session 为 NULL |
| `hook_enabled` | BOOLEAN | 是否注入了 agent hook |
| `hook_status` | TEXT? | hook 运行状态 |
| `created_at` | TEXT | RFC3339 |
| `runtime_kind` | TEXT NOT NULL | `tmux` \| `acp` \| `pty`。DEFAULT `tmux`（无 CHECK 约束） |
| `acp_session_id` | TEXT? | ACP adapter 分配的 session id；tmux/pty session 为 NULL |
| `agent_id` | TEXT? | 关联的 `agents.id`；仅 `runtime_kind='acp'` 有值 |
| `last_cwd` | TEXT? | pty 会话前台进程 cwd 的最近采样（30s 回写，D5 重建用）；tmux/acp 为 NULL |

创建 session 时 `runtime_kind` 枚举默认 `Acp`（ACP 阶段推进所致）；
创建路径显式传 `'tmux'` / `'pty'` 分流到对应引擎。pty 会话惰性 spawn：
创建只写 DB 行，进程在首次 WS attach / files 解析时由 PtyEngine
resolve-or-create。Phase 4 将把前端创建入口默认翻转为 `'pty'`。

## Terminal Input Path（tmux escape-time）

交互输入链路：xterm.js `onData` → WS binary → `ws/terminal.rs` 读循环 → mpsc → 写线程 `libc::write` 到 PTY master fd（`tmux/pty_io.rs`，刻意绕开 `portable_pty::MasterWriter` 的 Drop 注入 `\n\x04` 问题）→ PTY slave 上的 tmux client → tmux server → pane。**不走 `send-keys`**（`send-keys` 仅用于会话启动命令）。

**tmux escape-time 行为差异**：tmux 收到孤立 `\x1b` 后会等待 `escape-time`（默认 500ms）以区分 Alt/功能键序列。后果：1) 单次 ESC 延迟 500ms 才转发给 pane；2) 窗口内连按两次 ESC 被合并为 `\x1b\x1b`（Alt+ESC）一次转发。对需要连按 ESC 中止任务的 agent TUI（如 opencode 的 "esc again to interrupt"）这等于 ESC 完全失效。因此 `ws/terminal.rs` 的 `build_tmux_attach_cmd`（unix 版）在 spawn tmux client 时链式执行 `set-option -s escape-time 10 \; new-session -A`（server 级选项，一次生效覆盖全部会话；取 10ms 而非 0 以免慢速链路上转义序列被拆断）。

**psmux 链式命令行为差异（Windows，踩坑）**：Windows 上 tmux 由 psmux 平替（winget 安装同时提供 `tmux.exe`/`psmux.exe`/`pmux.exe` 三个别名，`-V` 均输出 `tmux 3.3.6`，无法在运行时靠 binary 名或版本号区分实现）。真 tmux 的 `;` 链式多命令执行完后照常进入交互 attach；**psmux 一旦命令行含多条命令就进入一次性命令模式，执行完直接 exit 0，不 attach**——终端只剩 "attached" 提示、无 shell 输出。因此 `build_tmux_attach_cmd` 按平台 cfg 拆分：windows 版只跑纯 `new-session -A -s <name>`（create-or-attach 语义 psmux 支持正常），escape-time 改由 attach 前单独一次性 `tmux set-option -s escape-time 10` 设置（fail-silent；一次性 psmux 命令实测 ~40ms，故 fire-and-forget 不阻塞 attach，且成功一次后用进程内 AtomicBool 缓存跳过——escape-time 是 server 级持久选项）。另：psmux attach 时会先发 DSR 光标探针 `\x1b[6n` 并等待终端回复（xterm.js 会自动回 `\x1b[1;1R`），在非交互管道下 attach 类命令只打印版本号即退出，诊断时必须走真实 ConPTY 链路。

**Windows 会话切换延迟基线**：每次切换 = 新建 WS + 重新 spawn psmux client。实测分解：ConPTY openpty ~8ms、spawn ~26ms、attach 首字节 ~18ms、DSR 探针往返 + 全屏重绘 ~45-140ms，合计 ~100-200ms（Linux+tmux 全链路 <10ms，故 `[已连接]` 横幅在 Linux 上瞬间被重绘覆盖无感知，Windows 上可见短暂停留）。这部分是 Windows 进程创建 + psmux 重绘的固有成本，进一步优化需要保活 client/连接池（属 pty-engine 计划 Phase 5 范围，不在 tmux 冻结代码内做）。


## Agent 屏幕状态检测（agent_watch / agent_detect）

herdr 借鉴（P0，`docs/reference/herdr-reference.md`）。tmux 会话中 agent CLI（Claude/Codex/Qoder）的 Running/Waiting/Idle 状态由**屏幕检测**判定，作为状态权威覆盖 hook 上报的 `agent_state`（Claude/Codex 的生命周期 hook 事件流不完整）；hook 仍独家提供 `attention_reason` / `agent_event` / `agent_nonce`。

链路：`agent_watch::spawn`（main.rs 启动，1s tick）→ `tmux list-panes -a` 列出活动 pane → `process_info::foreground_pid`（Unix 读 `/proc/<pid>/stat` tpgid；Windows 回退进程树）+ `read_process_cmdline` 识别 agent 种类 → `tmux::capture_screen` 取可见屏 → `agent_detect::evaluate`（TOML manifest 规则，优先级降序首中即停）→ `Debounce`（Running/Waiting 立即发布；Idle 需连续 2 tick 确认，除非规则带 `visible_idle` 证据）→ 内存快照。消费端：`api::sessions::list_sessions` / `list_external_sessions` 查询时合并（前端沿用既有 3s 轮询，无新增推送通道）。跳扫描优化：`#{window_activity}` 未变且已发布 Idle 时跳过 capture。

规则清单在 `src/tmux/manifests/*.toml`（`include_str!` 内嵌，测试断言编译数量防无声丢规则）。regex 区分大小写（herdr 原始模式内嵌 `(?i)`），`contains` 不区分；`prompt_box_body` / `after_last_horizontal_rule` 等 region 提取时剥离盒线字符（│┃║）以便行锚定模式命中。

**tmux -F 行为差异（踩坑）**：tmux 会把 format 字符串里的非打印字节按八进制转义为**字面文本**输出（`\x1f` → 4 字符 `\037`），因此 `-F` 分隔符不能用控制字符。`agent_watch` 用 `:`（tmux 会话名禁止含 `:`，中间字段均为数字，自由文本 `pane_title` 放末尾整体保留）；`mod.rs::list_sessions` 用 `|`（会话名放末尾 rejoin）。
