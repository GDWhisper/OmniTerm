# Windows-first 桌面版实施计划（Tauri 2 + 现有 omniterm sidecar）

> 状态：**设计稿**（2026-10-17）
> 触发条件：OmniTerm 目前只有 Web 形态，Windows 是需求最大的平台，需要可安装、可托盘驻留、可自动更新的桌面客户端。
> 关联：`docs/architecture/backend.md`（ACP / PTY / tmux 架构、平台差异）、`docs/architecture/frontend.md`（前端与同源 WS）、`docs/dev/reference/PLAN-TEMPLATE.md`、`docs/workflows/integration-checklist.md`（平台变体检查项）、`docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md`（进程生命周期与孤儿回收经验）。
>
> **本文定位**：只定义 Windows 桌面化。Web 版继续作为远程/多设备入口，不把桌面版做成第二套产品，也不重写 React 前端或 ACP 客户端。

---

## 1. 背景与结论

### 1.1 目标

交付一个 Windows 11 优先的桌面应用：

- 双击启动，不打开浏览器；
- 保留现有终端、ACP 聊天、文件、Git、端口转发能力；
- 关窗可收起到托盘，agent/终端不因误关窗而中断；
- 可安装、可卸载、可签名、可自动更新；
- 与 Web 版共享同一套 Rust 后端和 React 前端，只增加桌面壳与 Windows 进程适配。

### 1.2 结论

**可行，且代码复用度高；但 Windows 的关键路径不是 Tauri，而是 ACP 的 Windows 进程宿主。**

现有代码已经具备：

- `src/embedded.rs` + `src/main.rs:1050-1060`：前端编进二进制并由 Axum 同源提供；
- `src/main.rs:1078-1089`：默认只监听回环地址；
- 前端 API 走相对路径，终端/ACP WS 用 `window.location.host` 拼接；
- PTY 引擎已有 ConPTY 分支，tmux 引擎已有 psmux 分支；
- Windows release 构建已在 CI 中存在（`omniterm-windows-x86_64.zip`）。

因此桌面壳可以加载 `http://127.0.0.1:<port>`，无需改协议、无需加 CORS、无需重写前端。

### 1.3 对上一轮评估的勘误

上一轮把「ACP 暂不支持 Windows」当成整体结论，依据只是 `src/acp/agent_proc.rs:172` 的局部注释。经 `agent-client-protocol 2.2.0` 源码复核：

- `spawn_process` 有 `#[cfg(windows)]` 分支，设置 `CREATE_NO_WINDOW`；
- `ChildGuard` 在 Windows 上走 `child.kill()`；
- `from_args` 的 `KEY=VALUE` 环境变量解析与 ACP JSON-RPC 传输不依赖 Unix。

所以：**ACP 协议与 crate 运行时不是 POSIX-only**。当前 Windows 的阻碍来自本项目自己的实现缝隙，见 §2。此结论以源码为准，后续 Windows 实测如发现新差异，在本节加「勘误」块。

---

## 2. Windows 现状盘点

| 能力 | 代码证据 | 当前 Windows 状态 | 优先级 |
|---|---|---|---|
| 前端 / HTTP / WS / SQLite | `src/embedded.rs`、`src/api/mod.rs` | 已有 Windows release 构建；未做桌面壳 | P0 |
| PTY 引擎 / ConPTY | `src/engine/pty/`、`src/engine/pty_io.rs` | 已实现；进程树清理只到直接子进程 | P0 |
| tmux 引擎 | `src/engine/tmux/mod.rs:40-48` | Windows 走 psmux，外置依赖；健康/探针部分降级 | P1 |
| ACP 协议运行时 | `agent-client-protocol 2.2.0` | crate 支持 Windows，可编译/可握手 | P0（验证） |
| ACP agent cwd | `src/acp/client.rs:680-687` | **缺失**：Windows 分支直接 spawn，未 `cd` 到 workspace | P0 |
| ACP agent 命令解析 | `src/acp/resolve.rs:18-33` | **不完整**：外部 `which`、`HOME`、`.bin` 无 `.cmd` 处理 | P0 |
| ACP 进程回收 | `src/acp/agent_proc.rs:388-399` | **缺失**：Windows 无 pid/进程组，仅打 WARN | P0 |
| ACP terminal/create 子进程 | `src/acp/terminal.rs:48` | 直接 spawn；未纳入统一 Job Object | P0 |
| Agent hook 注入 | `src/engine/pty/agent_hooks.rs`、`src/engine/tmux/agent_hooks.rs` | **不兼容**：`$(date +%s).$$`、单引号、`|| true` 是 POSIX shell 语法 | P1 |
| 进程身份 / 孤儿对账 | `src/process_identity.rs` | Windows 用 sysinfo，代码注释明确「未实测」 | P1 |
| 桌面壳 / 安装器 / 更新 | 仓库内不存在 | 从零新增 | P0 |
| `--daemonize` / `stop` / `status` | `src/main.rs`、`docs/reference/requirements.md` | Windows 不支持；桌面 sidecar 不依赖它们 | 不纳入 |

### 2.1 关键结论

- **协议层**：只依赖各 agent 的 ACP 适配度，这个判断成立。
- **宿主层**：Windows 上还需要 `.cmd` 解析、workspace cwd、Job Object 进程树、HOME/USERPROFILE、hook 语法这五类适配。
- 在这五类修完之前做 agent 兼容测试，会把宿主 bug 误判成「某 agent 不支持 Windows」。

---

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|---|---|---|---|
| **D1** | 桌面壳选 **Tauri 2 + 现有 omniterm sidecar**，不把 Axum 嵌入 Tauri 进程 | 后端零重写；sidecar 可崩溃隔离；Unix 已验证的生命周期原样保留；Tauri 体积远小于 Electron | ① Tauri 内嵌 Axum（需把 `main.rs` 拆库、协调 shutdown/信号/daemon 逻辑）；② Electron 壳（Chromium 一致但安装包和内存明显更大） | Tauri/WebView2 无法满足 xterm 渲染或 IME；或 sidecar 生命周期无法可靠收尾 |
| **D2** | 固定回环 origin：`http://127.0.0.1:19077`；独立 DB：`%USERPROFILE%\.omniterm\omniterm-desktop.db` | localStorage 按 origin（含端口）隔离；固定端口才能保留主题/布局/会话记忆；独立 DB 避免 PID 文件、cookie/JWT 实例身份和 Web 版冲突 | ① 动态端口（丢 localStorage）；② `localhost`（避免 IPv4/IPv6 解析不一致）；③ 与 Web 版共库（PID 文件同路径、两个后端同时跑） | 需要与 Web 版共享数据 → 另设「连接已有实例」模式，不直接共库 |
| **D3** | Windows ACP 使用**自有进程宿主**：`tokio::process::Command` + `ByteStreams` 接入 crate；Unix 保留现有 shell wrapper | 同时解决 cwd、child 句柄、`.cmd` 包装、Job Object 四个问题；不 fork crate、不重写 ACP | ① 用 `cmd.exe /c "cd /d ..."` 包装（引号/转义/进程层数更复杂）；② 依赖 crate `ChildGuard`（Windows 只杀直接子进程）；③ fork agent-client-protocol | crate 上游提供 `current_dir` + Windows Job Object API → 退回上游实现 |
| **D4** | Agent 命令先解析为绝对路径，再交给 `Command`；Windows 特别处理 `.cmd` | `std::process::Command` 在 Windows 不读 `PATHEXT`；`npx` 通常只有 `npx.cmd`；项目更新链路已踩过同类坑（`src/update.rs` 的 `resolve_program`） | 直接 spawn 裸 `npx` / `npm` | 所有目标 agent 都提供 `.exe` 且无 `.cmd` 包装层 |
| **D5** | Windows MVP 默认 **PTY 引擎**，psmux 作为可选能力 | 不把外置 psmux 变成安装阻塞；ConPTY 已有代码；psmux 的控制模式/健康/进程身份在 Windows 上本就标注降级 | 强制 psmux（安装摩擦大）；或直接删掉 tmux 引擎（丢失已有能力） | 产品要求终端会话在退出应用后继续存活 → 评估捆绑/引导 psmux |
| **D6** | Windows MVP **禁用 hook 注入**，状态识别依赖现有屏幕检测；hook 的 Windows 化后置 | 现有 hook 模板是 POSIX shell；为 cmd/PowerShell 重做模板并逐 agent 验证成本高；屏幕检测已是引擎无关能力 | 直接运行现有 hook 模板（大概率命令失败或产生噪声） | 屏幕检测延迟/准确度不可接受，或需要精确 PermissionRequest 状态 |
| **D7** | Tauri 退出：先调受保护的 shutdown 端点，再关 Job Object；关窗默认隐藏到托盘 | Windows GUI 无控制台，sidecar 的 `ctrl_c()` 不触发；硬杀会跳过 ACP 回收；关窗即杀 agent 不符合产品预期 | 直接 `child.kill()`；依赖 `ctrl_c`；没有托盘 | 关闭到托盘被用户明确否决 |
| **D8** | 桌面版禁用后端自更新、Service Worker、UpdateBadge；改用 Tauri updater | 替换已签名 `.app`/安装目录中的 sidecar 会破坏签名；Windows 运行中 exe 不能自替换；SW 可能缓存旧前端 | 复用 `/system/update`（会改坏安装包）；保留 SW | 桌面端只做内部工具且完全不做签名/更新 |
| **D9** | 桌面能力用 `OMNITERM_DESKTOP=1` 贯穿后端，`/system/info` 暴露 `desktop` 标志 | 前端可在启动时隐藏更新入口；后端可拒绝自更新；避免用 User-Agent 猜环境 | 前端根据 `navigator.userAgent` 判断（不可靠） | Tauri 能提供稳定的注入标记且无需 env |
| **D10** | 首期目标 Windows 11；Windows 10 21H2+ 尽力支持 | WebView2 在 Win11 自带；ConPTY 要求 Win10 1809+；首期减少系统矩阵 | 首期承诺 Win7/8（不可行） | 用户数据表明 Win10 占比高 → 补测试与安装器引导 |
| **D11** | 桌面版单实例；第二实例聚焦已有窗口 | 同一 DB/端口只能有一个后端；多窗口不是首期需求 | 多实例多端口（localStorage/DB 分裂） | 明确需要多窗口 → 每窗口独立 origin/DB，另行设计 |

---

## 4. Windows ACP 进程宿主（P0 核心）

### 4.1 目标流程

```text
resolve agent command (absolute path, .cmd aware)
        │
        ▼
tokio::process::Command
  current_dir(workspace)
  envs(agent.env + API keys)
  env_remove(leak vars)
  stdin/stdout/stderr piped
  CREATE_NO_WINDOW
        │
        ├── CreateJobObject + AssignProcessToJobObject（每个 AcpClient 一个）
        │
        ▼
ByteStreams::new(child_stdout.compat_write(), child_stdin.compat())
        │
        ▼
现有 Client::builder().connect_with(transport, ...)
```

不改变 ACP 消息、session、permission、prompt、cancel 的任何逻辑，只替换「进程怎么起、怎么收」。

### 4.2 具体改动

| 改动 | 落点 | 说明 |
|---|---|---|
| Windows spawn 分支 | `src/acp/client.rs` 的 `spawn_with_session` | `#[cfg(windows)]` 使用自有 transport；Unix 分支保持现状 |
| 新 Windows 进程模块 | 新 `src/acp/agent_proc/windows.rs` 或 `src/acp/windows_process.rs` | 负责命令解析、spawn、Job Object、stderr、终止 |
| 命令解析 | `src/acp/resolve.rs`、`src/presets.rs` | 用 `which` crate / `where`，解析绝对 `.cmd`；`HOME` → `USERPROFILE`；npm 私有目录按 `.cmd` 查找 |
| 进程句柄 | `AcpClient` 的平台字段 | Windows 保存 `Child` + Job handle + pid；`agent_pid` 不再恒为 `None` |
| 终止语义 | `agent_proc::kill_agent_process_group` 或新 trait | Windows 调 `TerminateJobObject`；Unix 保留 killpg |
| terminal/create | `src/acp/terminal.rs` | agent 请求的终端命令也分配/加入同一 Job Object，避免独立孙进程泄漏 |
| API key / env 注入 | 现有 `all_args` 解析路径 | 改为直接 `.envs()` + `.env_remove()`，避免 `KEY=VALUE` 参数与 `.cmd` 包装层耦合 |

新增依赖（实施前按工程准则确认）：

- `tokio-util` 的 `compat` feature（把 tokio 子进程流接到 crate 的 `ByteStreams`）；
- `windows-sys` 增加 `Win32_System_JobObjects`、`Win32_Foundation` 等 Job Object 所需 feature；
- 不新增第二个进程池/异步运行时，复用现有 tokio runtime。

### 4.3 Job Object 规则

- 每个 `AcpClient` 创建一个 Job Object；
- 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
- agent 进程及其后代、agent 请求的 `terminal/create` 子进程统一归属该 Job；
- 正常 `shutdown`：先走现有优雅收尾，再 `TerminateJobObject` 兜底；
- 崩溃/强杀：Tauri 外层 Job 的 `KILL_ON_JOB_CLOSE` 负责整棵 sidecar 树；
- 释放会话：`TerminateJobObject` 后关闭 handle，避免泄漏；
- 关闭句柄前不要重复杀进程；所有 handle 用 RAII 封装。

> Windows 的 Job 分配存在「spawn 后、Assign 前子进程已创建」的极短窗口。首期可接受「spawn 后立即 Assign」；若实测有 agent 在毫秒级创建孙进程，再评估 `CREATE_SUSPENDED` + 恢复线程，或引入专用 launcher。

### 4.4 命令解析规则

1. 优先用 `which` crate（项目已有依赖）解析绝对路径；Windows 需遵循 `PATHEXT`。
2. 解析到 `.cmd` 时保留绝对路径，交给 `std::process::Command`（Rust ≥1.77.2 会自动用 `cmd.exe` 包装并做参数转义）。
3. 私有安装目录 `<home>/.omniterm/agents/node_modules/.bin`：
   - Windows 同时查找 `command`、`command.cmd`、`command.exe`；
   - `HOME` 缺失时用 `USERPROFILE`；
   - `npm` 本身也要解析为绝对 `.cmd`。
4. 解析失败时报出「尝试过的路径 + 安装提示」，不要只报 `program not found`。
5. 单元测试覆盖：`.exe`、`.cmd`、无扩展名、带空格路径、中文路径、`HOME` 缺失、`USERPROFILE` 回退。

### 4.5 Hook 策略

Windows MVP：

- `augment_agent_command` 在 `cfg(windows)` 下直接返回 `None`，不注入 hook；
- 保留 `agent::watch` 屏幕检测作为 Running/Waiting/Idle 来源；
- 在设置页/文档标注「Windows 首期状态检测粒度低于 Unix」。

后续若要精确 hook：

- Claude/Qoder：`--settings` 的 JSON 不变，但 hook command 改成 PowerShell 调用 `curl.exe`；
- Codex：`-c` 参数按 Windows shell 规则重写；
- 每个 agent 单独验证 hook 执行 shell，不假设 cmd/PowerShell 行为一致。

### 4.6 优雅关闭端点

新增仅回环可达的 `POST /api/v1/system/shutdown`：

- 启动时生成随机 token，经 `OMNITERM_SHUTDOWN_TOKEN` 注入 sidecar；
- Tauri 在退出前调用，header 带 token；
- 后端执行：
  1. `acp_supervisor.shutdown_all()`
  2. pty 会话/terminal manager 清理
  3. 触发 axum graceful shutdown
- token 不写日志；非回环请求直接拒绝；
- Tauri 等待超时（建议 10s）后关闭外层 Job。

同时把 `src/main.rs` 的 shutdown 信号改为「SIGTERM/SIGINT 或 shutdown 通道」二选一，Windows 不依赖 `ctrl_c`。

---

## 5. 桌面壳设计（Tauri 2）

### 5.1 目录

```text
desktop/
  README.md
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    src/main.rs
    binaries/omniterm-x86_64-pc-windows-msvc.exe   # 构建产物，不入库
    icons/
```

- `desktop/src-tauri` 作为独立 Cargo 项目，**不加入根 workspace**，避免 `cargo test --workspace` 把 WebKitGTK/GTK 等桌面依赖带进现有 Linux CI。
- sidecar 使用 Tauri `externalBin`；命名遵循 target triple。
- 版本号以根 `Cargo.toml` 为唯一真相源；扩展 `scripts/bump-version.sh` 同步 `desktop/src-tauri/tauri.conf.json`。

### 5.2 启动序列

1. 单实例锁；已有实例则聚焦并退出。
2. 确定端口 `19077` 与 DB 路径；端口被占用时显示原生错误对话框，不静默换端口。
3. 创建/复用 `%USERPROFILE%\.omniterm\omniterm-desktop.db` 目录。
4. 以 `CREATE_NO_WINDOW` spawn sidecar：
   ```text
   omniterm.exe start --host 127.0.0.1 --port 19077 --db <path>
   ```
   注入 `OMNITERM_DESKTOP=1`、`OMNITERM_SHUTDOWN_TOKEN`；若 `HOME` 缺失，注入 `HOME=%USERPROFILE%`。
5. 轮询 `/api/v1/health`，超时 20s 报错并展示 sidecar stderr 日志尾部。
6. 创建 WebView2 窗口，加载 `http://127.0.0.1:19077`。
7. 窗口关闭 → 隐藏到托盘；托盘「退出」→ shutdown 端点 → 等待 → 关闭 Job → 退出。
8. sidecar 崩溃 → 记录日志，按退避重启；窗口保留并复用前端自动重连。

### 5.3 WebView2 / 桌面交互

- 外链：拦截 `window.open` / `target=_blank`，用系统默认浏览器打开；
- 下载：接 WebView2 下载事件，写入用户下载目录并提示；
- 拖拽：配置 Tauri 的拖拽行为，保证文件可拖进文件管理器/聊天输入框；
- 快捷键：禁用 WebView2 默认刷新/打印等会干扰终端的快捷键；保留 Ctrl+C/V 与 xterm 语义；
- 窗口：记住尺寸/位置/最大化；DPI 缩放；
- 字体：使用系统等宽字体，缺字回退链要在 Windows 实测。

### 5.4 桌面能力标志

后端 `/api/v1/system/info` 增加：

```json
{ "desktop": true, "platform": "windows" }
```

前端：

- 桌面模式不注册 Service Worker（`frontend/src/main.tsx`；可通过 build-time `VITE_DESKTOP=1` 或稳定查询参数，二选一并只保留一个真源）；
- 桌面模式隐藏 UpdateBadge / 一键升级入口；
- 后端 `/system/update` 在 `OMNITERM_DESKTOP=1` 时返回明确错误，避免误触；
- 其余 UI 不需要分支。

> 构建注意：sidecar 内嵌的是 `frontend/dist`。桌面构建必须先以桌面标志构建前端，再编译 sidecar；Web 构建保持原样。若首期不想维护两套前端构建，可用固定查询参数 `?desktop=1` 并在 `main.tsx` 检查，但必须保证刷新/SPA 导航后仍保留该参数。

### 5.5 更新与分发

- 安装器：Tauri NSIS（优先），MSI 可选；WebView2 用 Evergreen bootstrapper（Win11 自带）。
- 代码签名：Windows OV/EV 证书 + `signtool`；未签名版本仅内测。
- 自动更新：Tauri updater；更新包必须包含 sidecar，不能只替换后端。
- 现有 `omniterm update` / `/system/update` / npm 自更新在桌面版全部禁用。
- 更新前先优雅关闭 sidecar；更新后重启应用。
- 不使用 Microsoft Store / 沙盒分发：终端和 agent 需要自由 spawn 子进程、访问用户文件，商店沙盒不匹配。
- CI 建议新增独立 `.github/workflows/desktop-release.yml`（Windows runner）：
  1. 安装 Rust MSVC、Node/pnpm、Tauri CLI；
  2. `pnpm build` 构建前端；
  3. `cargo build --release` 构建 `omniterm.exe` 并复制到 `desktop/src-tauri/binaries/`；
  4. `cargo tauri build` 产出 NSIS/MSI；
  5. 签名 + 生成 updater manifest。
- 根 CI 的 `cargo test --workspace` 不接入 `desktop` crate，避免 Linux job 被 WebView2/GTK 依赖污染；Windows job 单独跑桌面构建与针对性测试。

---

## 6. 实施分期

> 预估假设：1 名熟悉 Rust/React 的开发者；Windows 11 + MSVC + WebView2；不包含证书采购、Agent 厂商发布节奏等外部等待。

### Phase 0：Windows 基线（0.5–1 天）

- [ ] 安装 VS Build Tools（MSVC v143 + Windows SDK）、Rust MSVC target、Node 22、pnpm 10、Git、Tauri CLI、WebView2。
- [ ] 在 Windows 上构建前端与 release 二进制，确认 `frontend/dist/index.html` 与 `RustEmbed` 正常。
- [ ] 记录 `where.exe npx/node/git/curl/tmux/psmux` 的实际结果。
- [ ] 确认 `cargo test` 在 Windows 的基线（允许跳过的 Unix 专用测试要记录原因）。
- **退出条件**：Windows 上能启动现有二进制并通过浏览器访问；记录所有环境差异。

### Phase 1：Tauri 壳最小闭环（3–5 天）

- [ ] 新建 `desktop/src-tauri`，spawn sidecar、健康等待、WebView2 加载。
- [ ] 固定端口 + 桌面 DB + 单实例 + 日志落盘。
- [ ] 关闭窗口/退出流程（先硬退，Phase 5 接优雅关闭）。
- [ ] 构建 NSIS 安装包（未签名）。
- **退出条件**：安装后双击可打开 OmniTerm，终端 WS 可用，关闭/重开不崩。

### Phase 2：Windows ACP 进程宿主（5–8 天，核心）

- [ ] 新 Windows spawn 模块 + `ByteStreams` 接入。
- [ ] `current_dir(workspace)` + env/env_remove + stderr 有界捕获。
- [ ] Job Object 创建/分配/终止/RAII。
- [ ] `AcpClient` 保存 Windows 进程句柄；`shutdown`/`disconnect`/reaper 走 Job 终止。
- [ ] `AcpTerminalManager` 子进程纳入同一 Job。
- [ ] 单元/集成测试：fake agent、cwd 断言、终止后无残留、stderr 诊断。
- **退出条件**：Windows 上创建 ACP 会话，agent 的 OS cwd 是 workspace；释放会话后进程树无残留。

### Phase 3：命令解析与路径（2–3 天）

- [ ] `.cmd` / `.exe` / PATH / `USERPROFILE` / 私有 npm bin 全链路。
- [ ] `presets.rs` 的 `where` 检测与 spawn 解析使用同一真源。
- [ ] 失败文案包含尝试路径与安装提示。
- [ ] 文件读写路径、Windows 长路径、中文路径、盘符根目录回归。
- **退出条件**：`npx` 型 Claude/Codex 预设能在 Windows 创建会话；不依赖用户手工把 `.cmd` 改成 `.exe`。

### Phase 4：终端与 psmux 策略（2–4 天）

- [ ] PTY 会话 Job Object / 进程树清理（Windows）。
- [ ] Windows 默认 PTY 引擎；psmux 检测、安装引导、降级提示。
- [ ] Windows hook 注入关闭，屏幕检测回归。
- [ ] ConPTY 下滚动、resize、重连、CJK/IME、粘贴、vim/top 等 TUI 回归。
- **退出条件**：不安装 psmux 也能使用终端和 ACP；安装 psmux 后 tmux 会话可用且不崩。

### Phase 5：桌面生命周期与 UX（3–5 天）

- [ ] shutdown 端点 + token + graceful shutdown 通道。
- [ ] 关窗到托盘、托盘菜单、显式退出、sidecar 崩溃重启。
- [ ] 外链系统浏览器、下载、拖拽文件、窗口状态记忆、快捷键冲突处理。
- [ ] 桌面标志：禁用 SW、隐藏 UpdateBadge、`/system/update` 拒绝。
- **退出条件**：退出应用后无 ACP/PTY 孤儿；关窗后 agent 继续运行；外链/下载/拖拽可用。

### Phase 6：安装、签名与更新（3–5 天）

- [ ] NSIS 安装器、WebView2 bootstrapper、图标/版本信息。
- [ ] `signtool` 签名、SmartScreen 验证；Tauri updater 签名与更新源。
- [ ] 版本同步脚本与 CI Windows job。
- [ ] 升级流程：旧版运行中 → 退出 → 替换 → 新版启动；失败可回滚。
- **退出条件**：干净 Windows 机器可安装、升级、卸载；无残留进程/开机项。

### Phase 7：Agent 兼容矩阵（5–8 天，可与 Phase 5/6 并行）

- [ ] 按 §7 矩阵逐项验证并留证据（agent 版本、命令、日志、截图/事件）。
- [ ] 对不支持的 agent 给出明确降级文案，不假装可用。
- **退出条件**：核心 agent 至少 Claude、Codex、Qoder 通过；其余有明确状态。

**总计**：内部原型约 1.5–2.5 周；可用 Beta 约 4–5 周；签名 + 更新 + 全矩阵约 6–8 周。

---

## 7. Windows Agent 兼容矩阵

> 前置：Phase 2–3 完成后才开始判定 agent「不支持」。否则 cwd/`.cmd`/Job Object 的失败会被误归因给 agent。

| Agent | 启动方式 | Windows 重点 | 首期状态 |
|---|---|---|---|
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | `.cmd` 解析、cwd、hooks、权限、取消 | 必测 |
| Codex | `npx -y @agentclientprotocol/codex-acp` | 同上；`-c` hook 参数不注入 | 必测 |
| Gemini CLI | `gemini --experimental-acp` | Windows 二进制/安装渠道、ACP 参数 | 必测 |
| Qwen Code | `qwen --experimental-acp` | Windows 支持、路径 | 必测 |
| OpenCode | `opencode acp` | Windows 安装包、session/list、terminal/create | 必测 |
| Kiro | `kiro-cli acp` | Windows 分发、会话恢复 | 按用户需求 |
| Qoder / Qoder CN | `qodercli --acp` / `qoderclicn --acp` | Windows 安装包、路径编码、session/load | 必测（若为主力） |
| omp | `omp acp` | Windows 二进制、session/list 不完整 | 按用户需求 |
| Pi | `npx -y pi-acp` | `.cmd`、标题/会话能力 | 按用户需求 |

每个 agent 的统一检查项：

- [ ] `initialize` 成功；
- [ ] `session/new` 的 cwd 是 workspace（进程 cwd 与 RPC cwd 都验证）；
- [ ] prompt / streaming / cancel / permission；
- [ ] `session/load` / `session/list` / `session/delete`（有能力的）；
- [ ] `terminal/create` 子进程可执行、可回收；
- [ ] 若 agent 的 `terminal/create` 命令依赖 `bash`/`sh`，记录为 **agent 侧 Windows 适配缺口**（宿主不代做 POSIX shell 翻译，错误必须可见）；
- [ ] 文件读写、Windows 路径、中文/空格路径；
- [ ] 释放会话后无 `node.exe` / `cmd.exe` / agent 进程残留；
- [ ] 应用退出后无进程树残留。

---

## 8. 验收标准

### 8.1 核心

- [ ] Windows 11 干净机器安装后双击启动，无控制台窗口。
- [ ] 后端仅监听 `127.0.0.1:19077`；端口冲突有明确提示。
- [ ] 主题、布局、字号、当前会话在重启后保留（固定 origin + 固定 DB）。
- [ ] 终端：新建/切换/重连/resize/滚动/CJK 输入/粘贴/TUI 正常。
- [ ] ACP：创建会话、prompt、流式、权限、取消、恢复、历史面板正常。
- [ ] 文件管理：上传/下载/预览/编辑/重命名/删除；Git 面板状态/提交可用。
- [ ] 端口转发 HTTP/WS 可用。
- [ ] 关闭窗口到托盘后 agent/终端继续运行；显式退出后进程树干净。
- [ ] 强制结束 Tauri 进程后，外层 Job 能清掉 sidecar 与 agent 进程树。

### 8.2 质量门禁

- [ ] `cargo fmt --all && cargo clippy --quiet --workspace --all-targets -- -D warnings`（Windows 上至少 clippy/测试通过；Unix 专属测试按平台 SKIP 并记录原因）。
- [ ] `cd frontend && pnpm lint && pnpm test`。
- [ ] `cd frontend && pnpm build`。
- [ ] `./scripts/check-doc-index.sh`（提交文档后）。
- [ ] Windows Tauri 构建产物可在无开发环境的干净机安装。

### 8.3 边界与降级

- [ ] 未安装 Node/npx：创建 Claude/Codex 预设时给出安装提示，不崩溃。
- [ ] 未安装 psmux：PTY 引擎可用，UI 明确提示 tmux 会话不可用。
- [ ] npx 解析失败：错误包含解析路径与 agent 名称。
- [ ] Windows 10 21H2：PTY/WebView2 可用；不可用项明确提示。
- [ ] 路径含空格/中文/超长：文件 API、cwd、agent 启动均通过。
- [ ] 休眠/唤醒、网络断开后：WS 自动重连，不重复启动 sidecar。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Job Object 分配前的极短竞态 | 极快 agent 可能逃逸 | spawn 后立即 Assign；必要时 CREATE_SUSPENDED/launcher；以残留检测兜底 |
| `.cmd` 参数转义/注入 | 启动失败或命令注入 | 使用绝对路径交给 std 的 `.cmd` 包装；不手工拼 shell 字符串；参数单独传递 |
| Agent 只提供 POSIX 版本 | 某 agent 不可用 | 兼容矩阵如实标注；不伪造「支持」 |
| psmux 行为差异 | 终端会话异常 | 首期 pty 默认；psmux 只做可选；保留 `GET /system/multiplexer` 提示 |
| WebView2 渲染/IME | 终端输入体验差 | Phase 1 先做 TUI/CJK 回归；失败再评估 Electron（仅作为壳，不重写后端） |
| 代码签名/SmartScreen | 用户安装受阻 | 尽早采购证书；内测分开发布；NSIS + signtool |
| Windows 自更新替换运行中 exe | 更新失败/损坏 | 禁用后端自更新；Tauri updater 退出后替换 |
| 本地回环服务无鉴权 | 同机进程可控制终端 | 文档说明与 Web 版同一边界；可选启用密码/每实例 token |
| Windows 长路径/盘符规范化 | 文件/Git/cwd 异常 | Phase 3 专项回归；复用 `fs::display_path` 口径 |
| hook 状态缺失 | 侧栏状态延迟 | MVP 用屏幕检测；后续 Windows hook 模板 |

---

## 10. 文档闭环

实施时同步更新：

| 文档 | 更新内容 |
|---|---|
| `docs/architecture/backend.md` | 新增「Windows ACP 进程宿主」小节；记录 `.cmd`、Job Object、hook 差异、关闭端点 |
| `docs/architecture/frontend.md` | 桌面模式标志、SW 禁用、更新入口隐藏 |
| `docs/workflows/agent-edit-manual.md` | Windows 桌面构建/调试入口（desktop 目录、sidecar 路径） |
| `docs/workflows/integration-checklist.md` | 若新增 spawn 平台变体，登记 Windows 检查项 |
| `docs/reference/requirements.md` | 若产品确认 Windows 桌面需求，登记范围与状态（本文不擅自改） |
| `CHANGELOG.md` | 仅在实质功能落地后写；计划文档本身不写 |
| `AGENTS.md` 文档索引 | 本文件已登记 |

---

## 11. 待确认决策

1. **psmux**：首期完全不捆绑、只做检测 + pty 默认，是否接受？
2. **DB**：桌面版独立 DB 是否接受（与 Web 版数据不互通）？
3. **Hooks**：MVP 关闭 hook、仅屏幕检测，是否接受状态精度下降？
4. **Windows 10**：是否承诺 21H2+，还是只支持 Windows 11？
5. **登录**：桌面版是否默认关闭密码验证（沿用全新库默认），还是首次启动强制设密？
6. **签名**：公开发布是否已有 Windows 代码签名证书与 Tauri updater 签名密钥？
7. **默认 shell**：PTY 首期固定 `cmd.exe` 是否可接受，还是必须提供 PowerShell 选择？

---

## 12. Windows 第一天检查清单

```powershell
# 环境
rustc -Vv
cargo -V
node -v
pnpm -v
where.exe npx
where.exe node
where.exe git
where.exe curl
where.exe tmux
where.exe psmux

# 构建
cd frontend
pnpm install
pnpm build

# 现有后端
cd ..
cargo build --release
```

- [ ] 确认 `npx` 实际是 `.cmd` 还是 `.exe`；
- [ ] 确认 `where.exe tmux`/`psmux` 是否有结果；
- [ ] 确认 WebView2 Runtime 已安装；
- [ ] 跑一次现有 `omniterm.exe start --host 127.0.0.1 --port 19077 --db <临时库>`，用浏览器验证终端/ACP；
- [ ] 再进入 Phase 1，避免把环境问题误判成桌面壳问题。
