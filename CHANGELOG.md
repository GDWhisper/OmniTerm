# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]` for in-progress work.
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

### Changed

- (2026-07-15) `[backend]` tmux 缺失时改为 warning 日志并继续启动，不再 `exit(1)` — 为 ACP runtime 接入解耦启动依赖；tmux-backed session 在运行时按需失败，前端可通过 `/system/multiplexer` 查询可用性（`src/main.rs`）
- (2026-07-16) `[backend]` `RuntimeKind::default()` 由 `Tmux` 翻转为 `Acp`（Phase 4 Chat 视图落地，新会话默认走 ACP runtime）；`DB schema DEFAULT 'tmux'` 保持不变以兼容历史行；Sidebar 「新建会话」 modal 未选 agent 时显式传 `'tmux'`（`src/models/session.rs`、`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-07-16) `[frontend]` Layout + MobileContent 按 `activeSession.runtime_kind` 分发：`tmux → <Terminal>`、`acp → <ChatView>`；新增 `chat.*` 中英文 i18n 命名空间（`frontend/src/components/Layout/Layout.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-15) `[docs]` `docs/architecture/backend.md` 源树 + API 端点 + Sessions 表段同步到 Phase 3 状态，新增「ACP Module (Phase 3)」章节；`docs/reference/user-testing.md` 追加 §11 ACP 智能体会话手工测试用例
- (2026-07-16) `[docs]` `docs/architecture/frontend.md` 源树补 `agentStore`/`chatStore`/`useAcpChat`/`Chat/`/`AgentPicker/`；新增「ACP Chat View (Phase 4a)」章节（state/connection split + SessionUpdate 解析策略）；`docs/reference/user-testing.md` 追加 §12 ACP Chat 视图手工测试用例
- (2026-07-20) `[frontend]` ACP 助手回合由「单一气泡」拆分为分块堆叠：文本输出 → 气泡、工具调用 → 带状态色左边框的卡片（运行中 accent / 完成绿 / 失败红，等宽字体标题）、思考 → 低调斜体可折叠（无填充背景）、计划 → 细边框容器；流式光标跟随末尾文本块，工具执行期间独立显示（`frontend/src/components/Chat/ChatMessage.tsx`）

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
- (2026-07-21) `[frontend]` Sidebar ACP 会话条新增「释放」图标按钮（仅 `runtime_kind='acp'` 渲染，hover 用 `--warning` 黄色区别于删除的 `--danger` 红），调用 `releaseSession` 手动 kill 进程但保留会话；新增 `sidebar.releaseAcp` / `sidebar.sessionReleased` i18n 中英词条（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `list_sessions` 用 `supervisor.snapshot()` 一次性标记每个 ACP 会话的 `acp_process_alive`（进程是否在后端驻留），`Session` 模型新增该运行期字段（`src/api/sessions.rs`、`src/models/session.rs`)
- (2026-07-21) `[backend]` 修复后端正常停止/重启时 ACP agent 子进程（codebuddy --acp 等）变孤儿持续占内存：新增 SIGTERM/SIGINT 优雅退出钩子，退出前 `AcpSupervisor::shutdown_all()` 显式 kill 所有 supervisor 中驻留的子进程（实测 22 个孤儿→0）。注：SIGKILL / panic / 崩溃来不及运行，此类场景产生的孤儿仍需下次启动时手动清理或"恢复会话"（`src/main.rs`）
- (2026-07-21) `[frontend]` Sidebar 区分「未释放/已释放」ACP 会话：运行中显示绿点 + tooltip「Agent process running」，已释放显示灰点 + 「已释放」小标签 + tooltip「点击会话可恢复」；ACP 会话不再误用 tmux 的 `is_active` 假状态（`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/api/client.ts`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[frontend]` 修复 ACP 会话「断开/释放后不显示恢复按钮、需刷新页面才出现」：ChatView 恢复按钮显示条件从仅 `sessionEnded` 扩展为 `sessionEnded || (acp_process_alive===false)`，进程被手动释放/reaper 回收/后端重启后即时显示「恢复会话」；Sidebar `handleReleaseSession` 释放当前聚焦会话后立刻 `markEnded` 实现零延迟；新增 `chat.status.released` 中英文案（`frontend/src/components/Chat/ChatView.tsx`、`frontend/src/components/Sidebar/Sidebar.tsx`、`frontend/src/locales/{en,zh}/translation.json`）
- (2026-07-21) `[backend]` `[frontend]` ACP 进程存活状态由 3 秒轮询改为 **WS 事件驱动**：`AcpSupervisor` 内置 `broadcast::Sender<AcpProcessEvent>`，在 `insert`/`dispose` 时自动广播；`ws/acp.rs` 订阅后按 `session_id` 过滤转发 `process_alive` 帧（含连接建立时的初始同步帧）；前端 `useAcpChat` 收到后即时 `setAcpProcessAlive` 更新指示灯。恢复会话后绿点从「最多 ~4-5s（spawn+轮询）」降为「进程注册即亮」（约 spawn 耗时 ~1.6s，无需等轮询）。保留 Sidebar 轮询仅服务 tmux 会话（`src/acp/supervisor.rs`、`src/ws/acp.rs`、`frontend/src/stores/appStore.ts`、`frontend/src/hooks/useAcpChat.ts`）

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
