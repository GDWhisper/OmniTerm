# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]

### Fixed

- 修复 ACP 会话聊天记录入库后，恢复/刷新页面时工具调用卡片与文本气泡顺序错乱或重复出现的问题 (2025-07-17 23:00)` for in-progress work.
- Changes grouped by category: `Added`, `Changed`, `Fixed`, `Removed`, `Refactored`.
- One line per change — concise, describes **what** and **why**, not how.
- Each entry ends with a timestamp in `(YYYY-MM-DD HH:MM)` format.
- Breaking API changes prefixed with **BREAKING**.
- File paths are relative to project root (e.g. `src/api/files.rs`, `frontend/src/components/...`).

### When to add an entry

- New API endpoint, new component, new feature → `Added`
- Behavior change, UI adjustment, dependency bump → `Changed`
- Bug fix → `Fixed`
- Deleted code, removed endpoint, dropped dependency → `Removed`
- Code reorganization without behavior change → `Refactored`

**只写实质性的改动**：对用户或下游开发者可见的行为变化。反复提交→修复→再出问题的循环 bug，在彻底解决前不写条目。

### When NOT to add an entry

- Typo fixes in comments, whitespace cleanup, lint fixes
- Changes to `AGENTS.md`, `PROGRESS.md`, or other internal docs
- Dev-only tooling tweaks (`.gitignore`, editor config)
- 提交后又回退的改动
- 同一 bug 的多次未遂修复（只写最终修复那次）

### Scope tags

Prefix each entry with the area it affects:

| Tag | Scope |
|-----|-------|
| `[backend]` | Rust backend (`src/`) |
| `[frontend]` | React frontend (`frontend/src/`) |
| `[api]` | REST/WebSocket API contract |
| `[infra]` | Docker, CI, build, dev scripts |
| `[docs]` | User-facing documentation |

---

## [Unreleased]

### Fixed

- (2026-07-29) `[infra]` 修复公开仓 main 的 CI audit job 恒红：`ci.yml` 无条件执行 `scripts/check-doc-index.sh`，但该脚本校验的 AGENTS.md/docs/ 均在 sync 黑名单中不进公开仓，脚本本身也随 main 清理不存在，push main 必然 exit 127；改为脚本存在时才执行（dev 生效、public main 跳过）（`.github/workflows/ci.yml`）

## [0.2.2] - 2026-07-29

### Changed

- (2026-07-29) `[frontend]` `[backend]` `[api]` Windows 上创建会话弹窗的终端会话类型显示为「psmux」（Windows 用 psmux 平替 tmux，两者无法在运行时区分，按平台编译期确定）：后端新增 `MULTIPLEXER_NAME` 常量经 `GET /system/info` 下发，前端 appStore 持有并在 AgentPicker 选项与提示文案中展示（`src/tmux/mod.rs`、`src/api/system.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/components/AgentPicker/AgentPicker.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-07-29) `[backend]` 修复 Windows 上终端会话只显示「已附加」无 shell 提示符、完全无法输入：psmux 遇 `;` 链式多命令会进入一次性命令模式执行完 exit 0 不 attach（真 tmux 则照常进入交互 attach），`build_tmux_attach_cmd` 按平台拆分：Windows 只跑纯 `new-session -A`，escape-time 改为 attach 前单独一次性 `set-option` 设置；Unix 链式命令保持不变（`src/ws/terminal.rs`）
- (2026-07-29) `[backend]` 降低 Windows 会话切换延迟：escape-time workaround 原为每次 WS 连接串行 `await` 一条 psmux 命令（实测 ~40ms 纯开销），改为 `tokio::spawn` fire-and-forget + 成功一次后 AtomicBool 缓存跳过（escape-time 是 server 级持久选项，设一次即全局生效）；剩余 ~100-200ms 为 Windows 固有成本（ConPTY 创建 + 进程 spawn + psmux DSR 探针/全屏重绘），基线数据见 `docs/architecture/backend.md`（`src/ws/terminal.rs`）
- (2026-07-29) `[frontend]` `[backend]` 修复 Windows 上侧边栏展开项目明显卡顿：前端 `toggleProject` 在 `setExpandedProjects` 前 `await` worktrees/sessions 请求，UI 展开被网络往返阻塞，改为立即展开 + fire-and-forget 加载（未加载时显示 Loading 占位）；后端 `list_workspaces` 串行 spawn 两个 git 子进程（`rev-parse` + `worktree list`，Windows 单次 spawn ~50ms），改用 `tokio::join!` 并发（`frontend/src/components/Sidebar/Sidebar.tsx`、`src/workspaces.rs`）
- (2026-07-29) `[backend]` `[frontend]` 修复 Windows 上工作区路径显示异常（`/g:/Codes` 多前导 `/`）：后端 `canonicalize()` 透传 verbatim 路径（`\\?\G:\...`）、psmux `pane_current_path` 返回反斜杠路径，新增 `fs::display_path[_str]` 剥离 verbatim 前缀并统一正斜杠，files/sessions API 的 cwd 返回与 adopt 入库路径均归一化；前端面包屑与 `getParentPath` 识别盘符路径，不再无条件加 `/` 前缀，盘符段保持 `G:/` 形式避免 drive-relative 路径（`src/fs/mod.rs`、`src/api/files.rs`、`src/api/sessions.rs`、`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/utils/path.ts`）
- (2026-07-29) `[frontend]` 修复 RTL 截断技巧引发的 bidi 重排：`direction: rtl` 容器（左侧省略号截断）中 LTR 文本末尾的中性字符被挪到视觉开头——项目路径尾部 `/` 显示为前导 `/`（`g:/Codes/…/` → `/g:/Codes/…`），三处渲染（Sidebar 项目路径、Git 面板文件路径、文件管理器时间列）内容改用 `<bdi dir="ltr">` 隔离（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/GitPanel/GitPanel.tsx`、`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-07-29) `[infra]` 修复 `dev.ps1` stop/restart 永久挂死：`Get-ProcessTree` 用数组切片模拟出栈，单元素时 `$a[1..0]` 降序切片返回原数组导致死循环，改用 `Queue[int]`；同时修复 Hashtable 用 UInt32 作 key、Int32 查询永远查不到子进程导致进程树杀不干净的问题（`dev.ps1`）
- (2026-07-29) `[backend]` 修复 Windows 上浏览用户主目录返回 500：`list_dir` 对单条目 `metadata` 失败（如 Windows 用户目录下 ACL 拒绝访问的遗留 junction「Application Data」「Cookies」等）直接 `?` 传播导致整个目录列表失败，现跳过不可读条目继续列出其余内容；子目录计数循环同样容错（`src/fs/mod.rs`）

## [0.2.1] - 2026-07-29

### Fixed

- (2026-07-29) `[infra]` 修复 CI 质量门禁（ci.yml）rust job 与 `build.rs` 契约不匹配：原 rust job 仅 `mkdir -p frontend/dist` 空占位，但 `build.rs` 校验 `frontend/dist/index.html` 存在，导致 push main 时 rust job 恒红、CI 门禁失效。现 rust job 先 `pnpm build` 再 `cargo check`，与 sync 脚本及 release.yml 对齐（`scripts/sync-main.sh`、`.github/workflows/ci.yml`、`build.rs`）
- (2026-07-29) `[infra]` 发布流程强化：crates.io 发布不可逆，发布指导新增「强制发布顺序」铁律——`cargo publish` 必须排在 GitHub Release CI（release.yml）与 push main 的 CI（ci.yml）**全部转绿之后**，禁止抢跑。本次 0.2.0 因抢跑导致 crates.io 上线错版，以 0.2.1 重发覆盖（`docs/workflows/release-guide.md`）

## [0.2.0] - 2026-07-29

### Added

- (2026-07-28) `[frontend]` `[backend]` `[api]` Sidebar 版本号旁新版本提醒 badge + 一键升级：检测到 GitHub 有新 release 时显示像素风 `NEW` badge（hover 提示新版本号），点击弹出升级面板（当前→最新版本、`omniterm update` 命令提示、Release 链接、一键升级按钮）；新增 `GET /system/version`（semver 比较 + 进程内缓存：成功 1h/失败 5min，防匿名限流；GitHub 不可达前端静默降级）与 `POST /system/update`（全局锁防并发 409、无新版 409、github_release 渠道自替换、npm 代跑、cargo 编译耗时不支持一键返回 400 只显示命令提示）；升级成功不自动重启服务器（持有 tmux/ACP/WS 连接），面板提示 `omniterm stop && omniterm start`（`src/api/system.rs`、`src/update.rs`、`frontend/src/components/Sidebar/UpdateBadge.tsx`、`frontend/src/api/client.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-28) `[backend]` 新增 `omniterm update` 自更新子命令：渠道感知（npm 装的代跑 `npm update -g`、cargo 装的代跑 `cargo install`、install.sh/手动装的从 GitHub Release 下载对应平台 asset 自替换），semver 三态比对防 dev 构建被降级，sha256 digest 校验 + `--version` 二次验证 + 原子 rename 确保不留半更新状态，`--check` 只查不装；依赖新增 reqwest（rustls）/semver/sha2（`src/update.rs`、`src/main.rs`、`Cargo.toml`）
- (2026-07-28) `[frontend]` `[backend]` `[api]` Sidebar 一键创建 git worktree：项目行新增 `+` 按钮，弹窗填入分支名（必填）、目标路径（选填，留空创建平级目录 `<parent>/<dirname>-<branch>`，含提示文字）、基准分支（下拉框，从 `GET /projects/{id}/branches` 获取本地分支列表，默认当前 HEAD）；后端 `POST /projects/{id}/worktrees` 执行 `git worktree add -b`，创建成功后自动刷新 worktree 列表；新增 `GET /projects/{id}/branches` 获取本地分支（`src/git/mod.rs`、`src/api/projects.rs`、`frontend/src/api/client.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-27) `[frontend]` `[backend]` `[api]` ACP 聊天 `@` 引用文件（F04 Phase A，同计划 §3.4）：输入框光标处键入 `@` 触发文件补全弹窗（复用斜杠命令弹窗模式，200ms 防抖调 `/files/search`，↑↓/Enter/Tab/Esc 键盘导航），选中插入 `@相对路径`；发送时后端从 prompt 文本提取 `@path`（`@` 前须行首/空白排除 email，去重上限 8），经 sanitize（canonicalize + workspace 越界拒绝）读取内容（单文件 ≤64KB 截断、非 UTF-8/目录/不存在静默跳过）注入 `ContentBlock::Resource`；§8 能力门控：`promptCapabilities.embeddedContext` 未声明的 agent 降级为文件内容内联进 text block。`/files/search` 响应新增 `rel_path` 字段（相对搜索根路径，目录列表不返回）（`src/ws/acp.rs`、`src/acp/client.rs`、`src/fs/mod.rs`、`frontend/src/utils/atReference.ts`、`frontend/src/components/Chat/ChatInput.tsx`）

- (2026-07-27) `[frontend]` ACP 聊天消息编辑与重新生成（F02，见 `docs/dev/plans/2026-07-27-acp-session-enhancements.md` §3.2）：用户消息 hover 显示 ✎ 编辑，气泡内 textarea 改稿后作为**新 prompt** 重发（ACP 无编辑历史语义，原消息保留并标灰色 `(edited)`，不做分支对话）；最后一条 assistant 消息 hover 显示 ↻ 重新生成，重发最近一条用户消息、回复追加不替换。sending 期编辑稿自动进 N=1 队列，regenerate 走 enqueue+cancel 复用 Send Now 的 drain 路径规避竞态（`frontend/src/stores/chatStore.ts` `markEdited`、`frontend/src/components/Chat/{ChatMessage,ChatView}.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-27) `[frontend]` `[backend]` `[api]` ACP 聊天图片附件（F03，同计划 §3.3）：输入框支持粘贴/拖拽图片（PNG/JPEG/WebP/GIF，单张 ≤5MB、单次 ≤3 张），缩略图条可逐张 ✕ 移除，>1MB 非 GIF 自动 canvas 降采样重编码 JPEG 缓解 WS 帧压力；WS `prompt` 帧新增可选 `images`（base64+mime，向后兼容），后端 `send_prompt` 构造多 ContentBlock（text + `ContentBlock::Image`），用户消息 blocks JSON 落库、刷新后缩略图可还原。§8 能力门控：initialize 捕获 `promptCapabilities.image`，新 `capabilities` WS 帧下发，前端据此隐藏附件入口、后端二次校验拒绝（`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/utils/imageAttachment.ts`、`frontend/src/components/Chat/{ChatInput,ChatView,ChatMessage}.tsx`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/{chatStore,acpConnectionStore}.ts`）。约束：带附件的消息仅支持 idle 直发（N=1 队列槽保持纯文本）
- (2026-07-27) `[frontend]` ACP 权限审批 banner 增加 diff/内容预览（F01，见 `docs/dev/plans/2026-07-27-acp-session-enhancements.md` §3.1）：permission request 的 `toolCall` 数据（title/kind/content/locations/rawInput）此前被 WS handler 丢弃、banner 只显示工具名盲批，现由新导出的 `parsePermissionRequest` 解析——含 diff 复用 `DiffView` 彩色渲染，含文本/入参降级为只读预览，无数据保持原纯文本 banner；兼容 camelCase/snake_case 及 legacy `tool_name` 格式（附 vitest 单测），`extractLocations` 顺带修复 `{path,line}` 对象形态 locations 在工具卡片中被丢弃的问题（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/{PermissionBanner,ChatMessage}.tsx`）
- (2026-07-27) `[frontend]` 设置 → 外观新增「像素字体（BETA）」开关（默认关，避免初见用户觉得风格不统一）：开启后标题/按钮/状态标签等显示文字使用像素字体，关闭时统一回退 reader 字体；顶栏一行（OMNITERM logo、版本号、面板标题条与 FILES|GIT 标签）始终保持像素。实现为 `body.pixel-font-on` 切换 `--pixel-font` 指向（关=`var(--reader-font)`，开=`var(--pixel-font-static)`），顶栏豁免规则直用 `--pixel-font-static`；顺手清理无 CSS 引用的死类 `pixel-ui-on` 与已无使用者的 `PIXEL_FONT`/`LOGO_FONT` JS 常量（`frontend/src/index.css`、`frontend/src/stores/appStore.ts`、`frontend/src/App.tsx`、`frontend/src/components/Settings/Settings.tsx`、`frontend/src/components/Common/CountBadge.tsx`、`frontend/src/utils/fonts.ts`、`docs/visual-design/ui-style-guide.md` §2/§9）
- (2026-07-27) `[frontend]` Sidebar ACP 会话驻留状态可视化：ACP 会话行左侧缩进槽叠加 `A` 徽标（`status-badge-3d` 规范，绝对定位不占行内布局），进程驻留（未释放）→绿字、已释放→灰字，不点进会话即可分辨会话类型与释放状态；Release 按钮改为仅进程驻留时显示（已释放会话无可释放对象）（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[frontend]` ACP 与 tmux 会话状态通知表现对齐：ACP 会话现与 tmux 同款状态点（等待决策→琥珀、执行中→蓝、空闲→灰）并纳入项目/worktree 聚合徽标（blocked>done>working）；`prompt_done` 触发完成提醒（用户取消/排队续发不触发）、`prompt_error` 触发错误提醒，与 tmux 屏幕检测链路的 done/error 一致。`agentAggregate.ts` 归一两类会话状态源（tmux `agent_state` / ACP chatStore `sending`+`pendingPermission`）；ACP 空闲驻留进程不再显示绿点（残留状态见 tooltip 与 Release 按钮）（`frontend/src/utils/agentAggregate.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[backend]` `[frontend]` tmux agent 屏幕状态检测（借鉴 herdr P0，见 `docs/reference/herdr-reference.md`）：后端新增 `src/tmux/agent_detect.rs`（TOML manifest 屏幕规则引擎，`src/tmux/manifests/{claude,codex,qoder}.toml` 声明式判 running/waiting/idle）+ `src/tmux/agent_watch.rs`（每秒轮询活跃 pane，idle 两连击防抖、`#{window_activity}` 未变跳扫描）+ `process_info::foreground_pid`（tpgid 前台进程识别 agent 种类）；屏幕检测为状态权威覆盖 hook 上报，`GET /sessions`/`/sessions/external` 直接返回检测结果，无需 agent 配合、手动启动的 agent 也可监控。前端新增 `utils/agentAggregate.ts` 会话组聚合（blocked>done>working），Sidebar 项目/worktree/会话三级状态徽标：等待输入→琥珀、完成未查看→绿、运行中→蓝脉冲；新增依赖 `regex`/`toml`
- (2026-07-26) `[frontend]` `[backend]` `[api]` 右侧栏 git 管理面板（FILES | GIT 标签路由）：新增 `RightPanel` 容器（统一标题栏/折叠 rail，FileManager 变纯内容组件）+ `GitPanel`（分支切换/新建、ahead/behind 徽标、FETCH/PULL/PUSH、CHANGES|HISTORY 视图、stage/unstage/discard、底部提交框）+ 自研 unified diff 渲染与 diff/commit 抽屉；后端 `src/git/repo.rs` git CLI 子进程服务 + `src/api/git.rs` 14 个 `/api/v1/git/*` 端点（仓库绑定复用 session/workspace 解析，不接受任意路径；错误细分 auth/non_fast_forward/no_upstream/dirty_worktree/timeout）；可见时串行轮询 5s + ACP 编辑工具完成即时刷新提示；设计文档 `docs/dev/plans/2026-07-26-git-panel.md`
- (2026-07-25) `[frontend]` ACP 聊天排队后续消息（queued follow-up）：agent 忙碌期输入框保持可编辑，按 Enter 不打断当前任务而是暂存到单槽队列，agent `prompt_done` 后自动发出。chatStore `queuedMessage` 字段（sessionStorage 镜像，`omniterm_chat_queue:{sid}`，F5 友好）+ `enqueueMessage` / `clearQueuedMessage` / `hydrateQueuedMessage` / `addUndeliveredMessage` actions；ChatInput 输入框上方加 `Next: <预览> ✕` chip，busy 时双按钮（`Cancel` 取消 in-flight + `Queue` 排队新消息），队列满时 Queue 按钮 disabled 强制先 ✕。断连时未发队列消息作为 `undelivered: true` user 消息写入内存流（不入库）留痕。drain 在 `useAcpChat` `prompt_done` 分支内联处理（避免 `useCallback` TDZ 与 ChatView 状态机同步问题），详见 `docs/adr/0001-acp-queue-drain-location.md`；domain glossary 见 `CONTEXT.md`（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/{ChatInput,ChatView,ChatMessage}.tsx`、`frontend/src/locales/{en,zh}/translation.json`、`docs/architecture/frontend.md`）
### Changed

- (2026-07-27) `[frontend]` 像素字体字距收归 token 统一管理并整体收紧 0.5px：新增 `--pixel-tracking-sm/md/lg`（0.5/1.5/2px，原硬编码 1/2/3px），index.css 18 处像素/logo 字体规则与 2 处 TSX 内联字距全部改引 token，Silkscreen 偏宽字形下观感更紧凑；阅读字体字距不受影响（`frontend/src/index.css`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/Settings/Settings.tsx`）
- (2026-07-27) `[frontend]` ACP 聊天列套用终端同款像素木框（`.terminal-panel-pixel`，2px 木色边框 + 3px 硬阴影）：聊天面板此前为平面 bg-base，与侧栏/右栏无反差导致三列分界不清；现标题条以下内容整体入框，与终端视图分区语言一致（`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-27) `[frontend]` UI 立体语言统一：所有浮层（Modal、Settings/Tmux 速查 popup、ConfigToolbar 下拉与 tooltip、聊天 @ 补全、Toast）从软阴影+圆角改为像素硬阴影（新增共享工具类 `.pixel-float` 4px / `.pixel-press` 2px+按压位移，禁止组件内联阴影）；补齐可交互元素硬阴影（Sidebar 加号/adopt 按钮、Git 分支/COMMIT 按钮、ConfirmDialog 改用 PixelButton、聊天发送/排队/取消、权限按钮）；圆角统一压平 0-2px；清理未定义变量 `--accent-glow-sm`/`--success-glow` 引用与残留模糊 glow（`frontend/src/index.css`、`docs/visual-design/ui-style-guide.md` §6.1/§12）

- (2026-07-26) `[frontend]` 像素显示字体从 VT323 换为 Silkscreen（几何方块风、自托管 woff2，VT323 保留为回退）：VT323 过于窄长，Silkscreen 专为小字号 UI 标签设计，字形更宽、字高统一；仅改 `--pixel-font` / `PIXEL_FONT` 单一真相源即全站生效（`frontend/src/index.css`、`frontend/src/utils/fonts.ts`、`docs/visual-design/ui-style-guide.md` §2）
- (2026-07-24) `[frontend]` 启用 TypeScript `strict: true`（`tsconfig.app.json`/`tsconfig.node.json`）；评估下零错直接落地，`tsc -b`/`lint`/`test` 通过

- (2026-07-28) `[frontend]` 新建项目时路径输入实时目录补全：输入路径时不再需要回车/失焦确认，浏览面板自动根据已输入内容解析目录前缀并拉取过滤匹配结果（200ms 防抖）；目录项点击补全末尾自动追加 `/`，↑↓/Tab/Enter/Esc 键盘导航；移除「回车或失焦以应用路径」提示文字与刷新按钮（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Fixed

- (2026-07-29) `[backend]` 修复 `omniterm stop` 可能导致 ACP agent 子进程变孤儿：`AcpSupervisor::shutdown_all()` 原依赖 `Arc::try_unwrap` 获取所有权再调 `disconnect()`，WS handler 仍持有引用时 unwrap 失败静默跳过清理；正式版 stop 只发单进程 SIGTERM（非进程组 kill），无 OS 兜底。新增 `AcpClient::shutdown(&self)` 通过共享引用直接回收子进程，`shutdown_all()` 不再依赖 `try_unwrap`（`src/acp/client.rs`、`src/acp/supervisor.rs`）
- (2026-07-27) `[frontend]` 修复服务端数据重置/删除后，localStorage 里的旧 project/workspace/session ID 永不清理导致文件列表等请求持续 404：Sidebar 的恢复逻辑此前以「列表非空」为触发条件，服务端列表为空时（如 DB 重建）早退跳过清理；现以「已完成拉取」判定（projects 加载标记 / worktrees・sessions 按 project 键判空），旧 ID 未命中即连带清空下游 workspace/session（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-26) `[backend]` 修复终端内 agent TUI（如 opencode）按 ESC 无法中止任务：tmux 默认 `escape-time` 500ms 使孤立 ESC 延迟 500ms 转发、快速连按两次 ESC 被合并为 Alt+ESC 单次事件；现 spawn tmux client 时链式 `set-option -s escape-time 10`（`src/ws/terminal.rs`）
- (2026-07-26) `[frontend]` 修复终端 idle 断开后重连按钮偶发无反应需刷新页面：被替换 socket 的晚到 close/error 事件会把健康新连接盖回「已断开」（现以 `wsRef.current === ws` 守卫并解绑旧 socket `onerror`）；addon 动态 import 失败被模块级缓存导致重连永久失败（现失败后重建 promise 可重试）；`createTerminal` 异常静默吞掉（现 toast 提示并保留覆盖层可重试）；重连按钮传入实时容器兜底 hook 内 `containerRef` 为 null 的场景（`frontend/src/hooks/useTerminal.ts`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-25) `[frontend]` 修复界面缩放非 100% 时终端鼠标选取文字位置偏移：xterm.js 坐标换算不感知 CSS `zoom`，现给终端挂载容器施加反向 zoom 使 xterm 子树有效缩放归一，字号乘以缩放系数保持视觉尺寸不变（`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-24) `[backend]` 修复 `fs::sanitize_path` 读取路径测试预期与实现契约不符（测试未创建被校验路径导致预先失败，阻塞 CI `cargo test`）（`src/fs/mod.rs`）
- (2026-07-24) `[frontend]` 消除 `Markdown.tsx` 触发 `no-explicit-any` 的 ESLint error（pnpm lint 此前预先失败）；记录 react-markdown 类型双实例根因为 TECH-DEBT（`frontend/src/components/Chat/Markdown.tsx`）

## [0.1.9] - 2026-07-22

### Added

- (2026-07-15) `[backend]` sessions 表新增 `runtime_kind` / `acp_session_id` 列，`Session` DTO 与前端 TypeScript 类型同步；`POST /projects/{pid}/sessions` 接受可选 `runtime_kind`（Phase 2 默认 `tmux`，`acp` 返 501 占位，Phase 3 实装）（`migrations/20260715_add_runtime_kind.sql`、`src/models/session.rs`、`src/api/sessions.rs`、`frontend/src/api/client.ts`）
- (2026-07-15) `[backend]` 新增 `agents` 表 + `Agent` / `CreateAgent` / `UpdateAgent` 模型 + CRUD API（`GET/POST/PUT/DELETE /api/v1/agents[/{id}]`）（`migrations/20260715_add_agents_table.sql`、`src/models/agent.rs`、`src/api/agents.rs`）
- (2026-07-15) `[backend]` 新增 `src/acp/` 模块：`AcpClient`（spawn agent 子进程 + ACP 握手 + session/prompt/cancel/disconnect）、`AcpSupervisor`（`HashMap<omniterm_session_id, Arc<AcpClient>>` 注册表）、`PermissionManager`（auto-allow）、`AcpTerminalManager`（`tokio::process` + mpsc kill channel 服务 agent 的 `terminal/*` 请求）、session/update broadcast handler（`src/acp/{client,supervisor,permission,terminal,handler}.rs`）
- (2026-07-15) `[backend]` ACP session HTTP/WS 路由实装：`POST /projects/{pid}/sessions` ACP 分支加载 agent → spawn `AcpClient` → 注册 supervisor；`DELETE /sessions/{id}` ACP 分支 dispose + disconnect；`POST /sessions/{id}/prompt` 透传用户 prompt；`WS /ws/acp/{session_id}` 订阅 session/update 广播 + 转发 prompt/cancel 命令（`src/api/sessions.rs`、`src/ws/acp.rs`、`src/api/mod.rs`）
- (2026-07-15) `[frontend]` API client 新增 `Agent` / `CreateAgent` / `UpdateAgent` 类型与 `listAgents`/`getAgent`/`createAgent`/`updateAgent`/`deleteAgent`/`sendPrompt` 方法；`createSession` 增加 `runtimeKind` + `agentId` 参数；`Session` 类型加 `agent_id` 字段（`frontend/src/api/client.ts`）
- (2026-07-15) `[frontend]` 新增 `agentStore`（Zustand）：agent 配置列表 CRUD 状态（`frontend/src/stores/agentStore.ts`）
- (2026-07-15) `[frontend]` 新增 `AgentPicker` 下拉组件并接入 Sidebar 「新建会话」 modal：选中 agent 时 `runtime_kind='acp'`、留空时维持原 tmux 行为；新增 `agentPicker.*` 与 `settings.agents.*` 中英文翻译（`frontend/src/components/AgentPicker/AgentPicker.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-15) `[frontend]` Settings 面板新增 AGENTS tab（`AgentSettings` 组件）：支持新建/编辑/删除 agent，含 env 行编辑（`frontend/src/components/Settings/AgentSettings.tsx`、`Settings.tsx`）
- (2026-07-16) `[frontend]` ACP Chat 视图（Phase 4a）：新增 `chatStore`（按 `session_id` 索引的纯状态 Zustand store）、`useAcpChat` hook（管理 `/ws/acp/{id}` 生命周期并把协议帧翻译成 store 动作）、`ChatView` + `ChatMessage` + `ChatInput` 三件套渲染 ACP 会话的 title bar / 滚动消息列表 / 输入行；新增 `.chat-streaming-caret` CSS 动画复用 `blink-cursor` keyframe（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/*`、`frontend/src/index.css`）
- (2026-07-22) `[frontend]` ACP 聊天流在 agent 整轮忙碌期（`sending`，自发送 prompt 至 `prompt_done`）底部持续显示终端式状态行动效（hex 解码噪声，前缀 `▌` 游标，风格对齐 FileManager 路径栏 `b7b08acf56c1`，等宽逐槽滚动、长度恒定无抖动），长任务（工具调用/等待/思考）期间画面不再静默；`pixelAnimationsEnabled` 关闭时回退静态「思考中…」（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-22) `[frontend]` 加速 ACP 会话重放（长时间断连后回连恢复历史）：重放期间后端逐帧推送的历史 `session_update` 不再逐帧触发整列表重渲染，而是攒进本地 buffer 按 `requestAnimationFrame` 批量合并提交（`chatStore.applyReplayBatch` 一次 state 变换处理多条帧），重渲染成本从 O(帧数) 降到 O(动画帧数)；重放结束统一把残留 streaming 消息标为已完成。`replay_start…replay_end` 期间 ChatView 底部显示轻量「正在恢复会话记录…」指示器（spinner + 文案，含 `chat.replaying` 中英翻译），避免用户误以为卡死（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/index.css`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-22) `[backend]` `[frontend]` 修复「恢复会话后聊天记录在浏览器刷新后丢失」：此前 `LoadSession` 重放的历史只推给当前 WS 连接（前端内存 store），从不落库，刷新即从 DB 空还原、需重新释放+恢复。新增 `POST /sessions/{id}/messages/sync`，前端在 `replay_end` 把 store 重建的完整消息写回 DB，刷新后 `list_messages` 可还原历史（`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-22) `[backend]` `[frontend]` 修复 sync 误删历史 + 记录不全：原 `sync_messages` 整轮 `DELETE` 重建会清掉实时 prompt 已落库的 user 消息（ACP `session/load` 重放流不含 user prompt），且只存纯文本导致工具卡片/思考/计划在刷新后丢失。改为**不删除、按内容去重插入**；`chat_messages` 新增 `blocks TEXT` 列（migration `20260722_chat_message_blocks.sql`）持久化结构化内容（工具调用/思考/计划），hydrate 时优先用 blocks 还原富渲染、坏 JSON 回退纯文本；前端 sync 时合并连续 assistant 为整轮（文本+blocks 一并拼接）（`migrations/20260722_chat_message_blocks.sql`、`src/acp/chat_persistence.rs`、`src/api/sessions.rs`、`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatView.tsx`）
- (2026-07-22) `[backend]` `[frontend]` 修复「恢复会话后刷新仍丢历史」（精确边界版）：根因是 `replay_end` 经 notify_tx(mpsc) 转发时可能早于积压的重放 `session_update` 到达前端，导致 sync 写入半截历史。改为**后端保证顺序**——`LoadSession` 分支在 `load_session` 返回前先订阅 `session_update` 广播，返回后 `try_recv` 排空所有重放帧并经 `notify_tx`（FIFO）逐帧转发，确认全部发完再发 `replay_end`；实时帧的 `spawn_notify_task` 推迟到 `replay_end` 之后订阅，避免重复。前端由此可在 `replay_end` **即时 sync**（移除之前的 1s 稳定窗口计时器），无延迟、不漏帧（`src/ws/acp.rs`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-23) `[backend]` 修复「恢复会话后配置栏（mode/model/thinking）不显示」：根因是 `load_session` 仅在 `session/load` 响应返回 `config_options` 时才发 `ConfigOptionUpdate`，而 opencode 等 agent 不在 load 响应里返回 config（仅 codebuddy 返回，故仅它显示）。改为与实时 `set_config_option` 兜底逻辑一致——load 响应缺 config 时回退到创建会话时缓存的 `initial_config_options`，合成 `ConfigOptionUpdate` 经由重放广播推给前端，恢复后配置栏即有数据（`src/acp/client.rs`）
- (2026-07-23) `[frontend]` 修复「opencode/ccb 恢复会话后配置栏需手动刷新才出现」：根因是重放期间当 session 已有历史（`suppressReplay`）时，前端在 `session_update` 分支整帧丢弃，连 `ConfigOptionUpdate` 状态同步帧也一并丢弃，只能等刷新走 WS 连接分支的 `initial_config_notification` 才补到。`suppressReplay` 期间改为放行配置/命令/模式/用量类状态帧（`setConfigOptions`/`setCommands`/`setMode`/`setUsage`），仅丢弃文本内容帧，恢复即显示配置栏（`frontend/src/hooks/useAcpChat.ts`）

### Changed

- (2026-07-15) `[backend]` tmux 缺失时改为 warning 日志并继续启动，不再 `exit(1)` — 为 ACP runtime 接入解耦启动依赖；tmux-backed session 在运行时按需失败，前端可通过 `/system/multiplexer` 查询可用性（`src/main.rs`）
- (2026-07-16) `[backend]` `RuntimeKind::default()` 由 `Tmux` 翻转为 `Acp`（Phase 4 Chat 视图落地，新会话默认走 ACP runtime）；`DB schema DEFAULT 'tmux'` 保持不变以兼容历史行；Sidebar 「新建会话」 modal 未选 agent 时显式传 `'tmux'`（`src/models/session.rs`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-16) `[frontend]` Layout + MobileContent 按 `activeSession.runtime_kind` 分发：`tmux → <Terminal>`、`acp → <ChatView>`；新增 `chat.*` 中英文 i18n 命名空间（`frontend/src/components/Layout/Layout.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-15) `[docs]` `docs/architecture/backend.md` 源树 + API 端点 + Sessions 表段同步到 Phase 3 状态，新增「ACP Module (Phase 3)」章节；`docs/reference/user-testing.md` 追加 §11 ACP 智能体会话手工测试用例
- (2026-07-16) `[docs]` `docs/architecture/frontend.md` 源树补 `agentStore`/`chatStore`/`useAcpChat`/`Chat/`/`AgentPicker/`；新增「ACP Chat View (Phase 4a)」章节（state/connection split + SessionUpdate 解析策略）；`docs/reference/user-testing.md` 追加 §12 ACP Chat 视图手工测试用例
- (2026-07-20) `[frontend]` ACP 助手回合由「单一气泡」拆分为分块堆叠：文本输出 → 气泡、工具调用 → 带状态色左边框的卡片（运行中 accent / 完成绿 / 失败红，等宽字体标题）、思考 → 低调斜体可折叠（无填充背景）、计划 → 细边框容器；流式光标跟随末尾文本块，工具执行期间独立显示（`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-21) `[frontend]` Sidebar 操作按钮图标（新建/重命名/删除/释放）由固定色 PNG 换成线性描边 SVG（复用 FileManager `icons.tsx` 风格：16×16 / stroke 1.5 / round caps / `currentColor`）：图标随按钮 hover 变色（accent/danger/warning）恢复正常，重命名图标由误用的金币修正为铅笔；删除 4 个 PNG 资源（含无引用的 `hero.png`）；`icons.tsx` 新增通用 `IconPlus` / `IconPower`（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/components/FileManager/icons.tsx`）

### Removed

- (2026-07-17) `[backend]` 删除 `agents` 表的专属凭据字段 `api_key_env_var` / `api_key_value` — 凭据归 agent 自管，OmniTerm 只负责 spawn + ACP 协议，不再做一等公民的密钥注入；用户仍可通过通用 `env` 字段给子进程传任意环境变量。新增 migration 删列、`AcpClient` 移除注入块、`AgentSettings` 移除两行输入框与 dirty 语义、删 `settings.agents.apiKey*` 翻译（`migrations/20260717_remove_api_key_from_agents.sql`、`src/models/agent.rs`、`src/api/agents.rs`、`src/acp/client.rs`、`frontend/src/api/client.ts`、`frontend/src/components/Settings/AgentSettings.tsx`、`frontend/src/locales/{en,zh}/translation.json`）

### Fixed

- (2026-07-17) `[backend]` 修复 `/api/v1/files/watch` SSE 端点的 inotify watch 泄漏：每个连接 spawn 的 `spawn_blocking` 线程持有 `notify::Watcher` 后进入永不退出的 `sleep` 循环，客户端断开时 watcher 不 drop → `inotify_rm_watch` 永不调用，长运行实例 fd 单调增长（5 天累积 1320 个），最终撑满系统上限触发 Vite/cargo-watch 等 ENOSPC。改为 `tokio::sync::watch` channel 把 shutdown sender 绑到 stream generator，generator drop 时触发 blocking task 退出并释放 watcher（`src/api/files_watch.rs`）
- (2026-07-20) `[frontend]` 修复 ACP 工具调用刷屏 `[ToolCallUpdate]` 芯片：`tool_call_update` 是 partial 事件（只带 `toolCallId` + 变更字段，通常无 title/status），此前落入 system chip fallback，每帧生成一条芯片；现改为按 `toolCallId` upsert 合并进同一张工具卡片，undefined 字段保留卡片原值，一个 prompt 内的全部工具事件聚合为单卡（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/stores/chatStore.ts`、`frontend/src/components/Chat/ChatMessage.tsx`）
- (2026-07-20) `[frontend]` 修复 ACP 权限审批完全失效：`permission_request` wire frame 的 options 用 camelCase `optionId`，前端只读 snake_case `option_id` 导致每个 option_id 为空串，点 Allow 发送空 option_id → 后端 60s 超时回退 deny，工具永远到不了 completed；现在 wire 边界同时接受两种命名（`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/PermissionBanner.tsx`）
- (2026-07-21) `[backend]` 修复非 codebuddy agent（ccb、opencode 等）的 mode/model/thinking 切换不生效：`set_config_option` 丢弃了 `SetSessionConfigOptionResponse.config_options`（ACP 规范中 agent 返回更新后全量配置的主通道），仅 codebuddy 会额外主动推送 `ConfigOptionUpdate` 通知故只有它能刷新 UI；现在 response 写回本地缓存并合成 `ConfigOptionUpdate` 广播，所有 agent 均可同步；boolean 类型选项改发 `{"type":"boolean"}` 而非字符串值（`src/acp/client.rs`）
- (2026-07-21) `[frontend]` 配置切换乐观更新（对齐参考实现 obsidian-agent-client）：选中下拉项时立即 patch 该选项 `currentValue`，无需等待 agent 往返；后端 `ConfigOptionUpdate` 广播随后全量替换确认，UI 响应即时且对所有 agent 普适（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-21) `[backend]` ACP 空闲自动回收：新增 `src/acp/reaper.rs` 看护任务（默认 30s 扫描），按后端可观测活跃度信号回收孤儿 `codebuddy --acp` 进程——静默待命满 5 分钟（`IDLE_RECYCLE_SECS`）或权限请求无响应满 30 分钟（`REQUIRES_ACTION_RECYCLE_SECS`）即 `disconnect` 杀进程释放内存；活跃工作中（有进行中 prompt / 有未决权限）不回收。`AcpClient` 新增 `ActivityState` 跟踪（prompt 进行中标记 + 任意 session/update 刷新活动时间），`PermissionManager` 暴露 `pending_count`，`AcpSupervisor` 新增 `snapshot`；`main.rs` 启动 reaper；`LoadSession` 覆盖前先 dispose 旧 client 防泄漏（`src/acp/{reaper,client,supervisor,permission}.rs`、`src/ws/acp.rs`、`src/main.rs`）
- (2026-07-21) `[frontend]` ACP 权限请求（对应后端 `requires_action`）接入 `AttentionProvider`：收到 `permission_request` 时 `attention.fire(sid, sid, 'decision')`，用户响应后 `clearAlert`，自动复用 Sidebar 决策徽标闪烁 + 标签栏标题闪烁 + 提示音，断连后仍持续提醒用户回来处置（`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-21) `[backend]` 新增 `POST /sessions/{id}/release`：仅 `supervisor.dispose` + `disconnect` 释放 ACP agent 子进程（`codebuddy --acp` 等），**不删除会话记录**，与 reaper 自动回收语义一致，之后可"恢复会话"重新 spawn；非 acp 会话返回 400（`src/api/sessions.rs`）
- (2026-07-21) `[backend]` `[frontend]` 修复输入 `/` 不弹出斜杠命令列表：agent 在会话创建时即推送 `AvailableCommandsUpdate`，早于 WS 订阅导致通知丢失（与 config options 同类时序问题）——后端现缓存该通知并在 WS 连接时重放（`initial_commands_notification`，同 `initial_config_notification` 模式）；前端 `ChatInput` 过滤逻辑未剥离 `/` 前缀导致永远匹配不到命令、选中后也丢失 `/` 前缀致 agent 无法识别，一并修复（`src/acp/client.rs`、`src/ws/acp.rs`、`frontend/src/components/Chat/ChatInput.tsx`）
- (2026-07-21) `[frontend]` 斜杠命令补全透传 agent 的 `description` / `input.hint`（此前仅保留命令名）：`SlashCommand {name, description, hint}` 结构化存入 store，`/` 下拉框命令名旁以淡色展示描述（超长省略），对齐参考实现的透传行为（`frontend/src/stores/chatStore.ts`、`frontend/src/hooks/useAcpChat.ts`、`frontend/src/components/Chat/ChatInput.tsx`）
- (2026-07-21) `[frontend]` 移除全局 `svg { shape-rendering: crispEdges }` / `stroke-linecap: square` CSS：该规则优先级高于 presentation attribute，把全应用线性描边图标（icons.tsx / BookIcon / Settings / Modal 等）声明的 `round` 端帽压成方角、曲线/斜线锯齿化（GitHub logo 因此难以辨认）；像素精灵（PixelSprites / OmniTermLogo）本就自行声明 `crispEdges` 不受影响。`ui-style-guide.md` §13 同步重写为「线性描边图标 + 像素精灵」双图标体系（`frontend/src/index.css`、`docs/visual-design/ui-style-guide.md`）
- (2026-07-21) `[frontend]` Sidebar ACP 会话条新增「释放」图标按钮（仅 `runtime_kind='acp'` 渲染，hover 用 `--warning` 黄色区别于删除的 `--danger` 红），调用 `releaseSession` 手动 kill 进程但保留会话；新增 `sidebar.releaseAcp` / `sidebar.sessionReleased` i18n 中英词条（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `list_sessions` 用 `supervisor.snapshot()` 一次性标记每个 ACP 会话的 `acp_process_alive`（进程是否在后端驻留），`Session` 模型新增该运行期字段（`src/api/sessions.rs`、`src/models/session.rs`)
- (2026-07-21) `[backend]` 修复后端正常停止/重启时 ACP agent 子进程（codebuddy --acp 等）变孤儿持续占内存：新增 SIGTERM/SIGINT 优雅退出钩子，退出前 `AcpSupervisor::shutdown_all()` 显式 kill 所有 supervisor 中驻留的子进程（实测 22 个孤儿→0）。注：SIGKILL / panic / 崩溃来不及运行，此类场景产生的孤儿仍需下次启动时手动清理或"恢复会话"（`src/main.rs`）
- (2026-07-21) `[frontend]` Sidebar 区分「未释放/已释放」ACP 会话：运行中显示绿点 + tooltip「Agent process running」，已释放显示灰点 + 「已释放」小标签 + tooltip「点击会话可恢复」；ACP 会话不再误用 tmux 的 `is_active` 假状态（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[frontend]` 修复 ACP 会话「断开/释放后不显示恢复按钮、需刷新页面才出现」：ChatView 恢复按钮显示条件从仅 `sessionEnded` 扩展为 `sessionEnded || (acp_process_alive===false)`，进程被手动释放/reaper 回收/后端重启后即时显示「恢复会话」；Sidebar `handleReleaseSession` 释放当前聚焦会话后立刻 `markEnded` 实现零延迟；新增 `chat.status.released` 中英文案（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `[frontend]` ACP 进程存活状态由 3 秒轮询改为 **WS 事件驱动**：`AcpSupervisor` 内置 `broadcast::Sender<AcpProcessEvent>`，在 `insert`/`dispose` 时自动广播；`ws/acp.rs` 订阅后按 `session_id` 过滤转发 `process_alive` 帧（含连接建立时的初始同步帧）；前端 `useAcpChat` 收到后即时 `setAcpProcessAlive` 更新指示灯。恢复会话后绿点从「最多 ~4-5s（spawn+轮询）」降为「进程注册即亮」（约 spawn 耗时 ~1.6s，无需等轮询）。保留 Sidebar 轮询仅服务 tmux 会话（`src/acp/supervisor.rs`、`src/ws/acp.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useAcpChat.ts`）
- (2026-07-22) `[backend]` `[frontend]` 修复 ACP 三类错误被静默丢弃、用户看不到根因：（1）agent 子进程崩溃/异常退出时，`disconnect` 中 `let _ = connection_task.await` 吞掉错误，仅显示「恢复会话」而无崩溃原因——新增 `crash_tx` 广播通道 + `spawn_crash_watcher` 看护任务，连接非正常退出即经 `prompt_error` 帧透传崩溃原因；（2）`set_config_option` 失败仅记日志不回传，现回 `config_option_failed` 错误帧；（3）`cancel` 失败仅记日志不回传，现回 `cancel_failed` 错误帧（`src/acp/client.rs`、`src/ws/acp.rs`）
- (2026-07-22) `[backend]` `[frontend]` 提升 ACP agent 动作可见性，防止静默执行：（1）**修复文件读写空实现**——`ReadTextFile`/`WriteTextFile` 原为空 stub（读返回空串、写假装成功但不落盘），现用 `tokio::fs` 真正读写，路径经 `resolve_fs_path` 限制在 workspace 内防越界，失败如实 `respond_with_internal_error` 回报 agent（不再假装成功）；（2）**终端命令可见**——`AcpTerminalManager` 新增 `TerminalActivity` 事件（创建/退出），经 `terminal_event_tx` 广播 → WS `terminal_activity` 帧 → 前端聊天区紧凑卡片显示「agent 跑了什么命令 + 退出码」，消除后台命令盲点（`src/acp/{client,terminal}.rs`、`src/ws/acp.rs`、`frontend/src/{stores/chatStore.ts,hooks/useAcpChat.ts,components/Chat/ChatView.tsx}`）
- (2026-07-23) `[backend]` 修复 ACP agent 子进程 OS cwd 继承后端而非 session workspace：根因是 `agent-client-protocol` crate 的 `AcpAgent::spawn_process` 不接受 `current_dir` 也不调 `Command::current_dir()`，导致 agent（codebuddy/ccb/opencode 等）OS 进程的 cwd 永远是后端启动时的目录（如 `/home/pax/coding/OmniTerm-dev`），与 session 记录的 `workspace_path` 无关。表现为：用户在任何 project 下创建 ACP session，agent 都跑在后端目录里，读不到 session workspace 的 git 状态、读不到正确文件、看不到该项目的 branch 和 worktree——是用户报告「branch/WORKSPACES 检测不到 + workspace 始终是 OmniTerm-dev」的根因。修复：`AcpClient::spawn_and_connect` / `spawn_and_load` 用 `sh -c "cd <workspace> && exec <cmd> <args>"` 包装 agent 命令，`exec` 替换 shell 进程保留信号透传和进程组清理；新增 `sh_quote` / `wrap_agent_with_cwd` 单元测试 + 端到端测试（spawn `pwd` 验证 cwd 切到目标 workspace，含空格路径回归覆盖）；POSIX-only（`#[cfg(unix)]`，ACP 暂不支持 Windows）（`src/acp/client.rs`）
- (2026-07-23) `[backend]` 修复 FileManager 对 ACP session 返 404：上一条修复了 agent OS cwd 但后端 `resolve_session_base` 只查 `tmux_session_name`、ACP session 该列为 NULL → 整个函数返 None → `/api/v1/files?session=…` 返 404「session not found or tmux unavailable」，前端 FileManager 加载 ACP session 文件列表永远报错；现在一次性查 `(runtime_kind, tmux_session_name, workspace_path)`，识别 `runtime_kind='acp'` 走 workspace_path 分支，FileManager 与 agent 看到同一个工作区（`src/api/files.rs`）

---

## [0.1.8] - 2026-07-13

### Added

- (2026-07-13) `[infra]` 版本号统一为 `Cargo.toml` 单一真相源 — 移除 `.env.local` 的 `BRANCH_VERSION`（gitignored，导致各 worktree 版本号失同步），Rust 编译期读 `CARGO_PKG_VERSION`、前端构建时从 `Cargo.toml` 注入 `VITE_APP_VERSION`；`bump-version.sh` 改为同步 `Cargo.toml` + `frontend/package.json`（`src/main.rs`、`frontend/vite.config.ts`、`scripts/bump-version.sh`）
- (2026-07-13) `[backend]` Windows/psmux 兼容增强 — `check_multiplexer()` 在 Windows 上额外 fallback 到 `psmux`；`list-sessions` 空输出视为无 session；`/sessions/external` 在 tmux 错误时返回空列表而非 500（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-07-12) `[infra]` 新增 Windows 原生启动脚本 `dev.ps1` — `dev.sh` 依赖 bash/`ss`/`kill`/`/proc` 等 Unix 语义，原生 Windows 无法直接运行。PowerShell 版功能对齐：用 Windows 原生机制后台拉起（`Start-Process` + `.dev/*.pid`）、`Get-NetTCPConnection` 端口检测、`Stop-Process` + 进程树递归停止，支持 `start`/`stop`/`restart`/`status`/`logs`（`dev.ps1`）
- (2026-07-12) `[frontend]` Sidebar 图标按钮统一为 PNG 像素风图标 — 创建/编辑/删除按钮由文字与 emoji 改为 `add.png`/`edit.png`/`delete.png`（24×24 像素图标，`imageRendering: pixelated`）（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`、`frontend/public/buttons/`）
- (2026-07-11) `[frontend]` 终端 tab blur/idle 延迟断连 — 切换标签页或空闲时延迟断开 WebSocket，切回立即恢复，避免无谓重连（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-10) `[frontend]` 移动端滚动激活模式临时禁用输入法 — 进入 tmux copy mode 后将 xterm `<textarea>` 的 `inputmode` 同步为 `none`，退出恢复 `text`，避免点按 ↑/↓ 滚动时软键盘弹起遮挡终端（`frontend/src/hooks/useTerminal.ts`、`frontend/src/utils/terminalInputMode.ts`）
- (2026-07-10) `[frontend]` 移动端功能键改用自然焦点 — Modifier 键（Ctrl/Shift/Alt）点按后主动 refocus xterm textarea 保持 IME 打开，非 modifier 键靠按钮自然夺焦关闭键盘（`frontend/src/components/Terminal/MobileKeyBar.tsx`）

### Changed

- (2026-07-13) `[docs]` README 安装说明拆分为独立代码块并标注 tmux/psmux 前置依赖 — 各安装方式（brew/cargo/npm/源码/Windows）配 `<small>` 说明；明确 Linux/macOS 需 tmux、Windows 需 psmux 或 tmux（`README.md`、`README_zh.md`）

### Fixed

- (2026-07-13) `[backend]` `[frontend]` 文件管理器下载文件夹失败 — 下载模式勾选目录被忽略，单选文件夹时提示「正在下载0个文件」且无法下载。修复：后端 `/files/download` 检测目标为目录时递归打包为 zip 流式返回，前端不再过滤目录；新增 `fm.downloadStartedDir` 提示（`src/api/files.rs`、`frontend/src/components/FileManager/FileManager.tsx`、`frontend/src/locales/*/translation.json`）
- (2026-07-12) `[frontend]` 终端断连后黑屏、重连按钮不显示 — overlay 依赖全局 `connected`（由 Sidebar 每 5 秒健康检查驱动），blur/idle 断连销毁 xterm 后健康检查把 `connected` 拉回 `true` 导致按钮永不渲染。修复：新增与全局 `connected` 解耦的 `terminalDisconnected` 状态，overlay 改依赖它，断连后跳过自动重建（`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useTerminal.ts`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-07-10) `[frontend]` 移动端修饰键锁存 + 软键盘输入经 IME 合成被丢弃 — 导致 Ctrl+C 等组合键失效，修复 `useTerminal.ts` 的键序列发送逻辑（`frontend/src/hooks/useTerminal.ts`）
- (2026-07-10) `[frontend]` 移动端按方向键/功能键时呼出软键盘 — 调整 `MobileKeyBar` 焦点管理避免误触（`frontend/src/components/Terminal/MobileKeyBar.tsx`）
- (2026-07-13) `[frontend]` Sidebar 测试：项目标题栏「创建」按钮 class 与工作区「创建会话」按钮冲突 — `querySelector('.sidebar-wt-add-btn')` 总命中先出现的项目按钮导致测试点击错误，项目按钮 class 改为 `sidebar-proj-add-btn`（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/index.css`）

---

## [0.1.7] - 2026-07-08

### Added

- (2026-07-08) `[backend]` 智能启动日志 — 检测运行模式自动切换：dev 模式（前端目录存在）输出详细分支/版本/端口信息，生产模式（内嵌前端）输出简洁一行 `OmniTerm v0.1.7 — http://host:port`（`src/main.rs`）
- (2026-07-08) `[infra]` 新增 `scripts/sync-main.sh` 分支同步脚本 — 自动处理黑名单文件删除、Cargo.toml/Dockerfile/docker-compose 分支专属配置修复、Cargo.lock 重新生成，支持 dev → main 单向同步（`scripts/sync-main.sh`）

### Changed

- (2026-07-08) `[docs]` 分支模型重构 — dev/preview/main 三层结构，废弃 release 分支，main 作为发布分支直接同步到 public 仓（`docs/workflows/branch-workflows.md`、`docs/workflows/release-guide.md`、`docs/workflows/worktree-setup.md`）
- (2026-07-08) `[docs]` README 预览图改为 `pic/overview.png`，移除 Contributing 中重复的中英文链接（`README.md`、`README_zh.md`）
