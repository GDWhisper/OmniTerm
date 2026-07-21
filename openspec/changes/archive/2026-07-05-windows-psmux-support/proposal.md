## Why

OmniTerm 深度依赖 tmux 作为会话管理、agent 状态轮询、控制模式的后端,而 Windows 没有原生 tmux。psmux 是一个 MIT 协议、Rust 实现、v3.3.6 的 tmux 原生 Windows 替代品,基于 ConPTY API,实现了 tmux CLI 协议、`-C`/`-CC` 控制模式、`@user-option` 以及 `#{pane_current_path}` 等 format 变量——这意味着 OmniTerm 现有的 `Command::new("tmux")` 调用在 psmux 上**零改动即可运行**。需要改动的只是底层 Unix-only 的系统调用(`/proc`、`libc::write`、`libc::kill`)以及启动时的 multiplexer 检测与安装引导。本次变更让 OmniTerm 在 Windows 上获得与 Linux/macOS 一致的会话与 agent 集成能力,同时保留 Linux/macOS 上对 tmux 的使用。

## What Changes

- **新增 psmux 平台适配层**:将 Unix-only 的进程信息查询(`read_process_cmdline`、`walk_process_tree`)和 PTY I/O(`libc::write`、`libc::kill(SIGHUP)`)抽象为平台无关的接口,Unix 路径保持原行为,Windows 路径使用 `sysinfo` crate + `windows-sys` 实现。
- **新增 multiplexer 启动检测**:OmniTerm 启动时检测 `tmux` 是否在 PATH 中;若不在,根据平台给出明确安装提示。Windows 上缺失时提示 `winget install psmux`(或 scoop/cargo)。**不自动安装**,仅展示可复制命令。
- **新增 Windows 安装脚本 `install.ps1`**:与现有 `install.sh` 对等的 PowerShell 安装入口,负责下载 omniterm Windows 二进制、验证 psmux 可用、打印下一步指引。
- **扩展 `npm-package/install.js`**:解除 `win32` 平台的拒绝逻辑,允许 Windows 下载对应 binary,并调用 multiplexer 检测分支(winget 提示)。
- **扩展 release workflow**(`.github/workflows/release.yml`):新增 `x86_64-pc-windows-msvc` 与 `aarch64-pc-windows-msvc` 两个矩阵条目,产出 Windows 二进制与 npm 包。
- **Cargo.toml 依赖平台化**:`libc` 改为 `cfg(unix)` 专属,新增 `cfg(windows)` 的 `windows-sys` 依赖(Toolhelp + Threading features)。
- **`detect_agent_kind` 匹配规则扩展**:识别 Windows 形态的 agent CLI(`claude.exe`、`node.exe ... claude\cli.js`、PowerShell alias)。
- **现有 tmux CLI 调用零改动**:`new_session`、`kill_session`、`list_sessions`、`send_keys`、`capture_pane`、`pane_cwd`、`get_session_agent_option`、`set-option @omniterm_agent`、`list-panes -F '#{pane_pid}'` 在 psmux 上直接可用。

## Capabilities

### New Capabilities
- `multiplexer-platform-adapter`: 抽象 tmux/psmux 的平台相关底层实现(进程枚举、PTY 写入、进程信号),使同一套 tmux CLI 调用在 Unix 和 Windows 上都能正确执行。
- `multiplexer-detection`: 启动时检测系统是否安装了 tmux(Unix)或 psmux(Windows),并在缺失时给出平台对应的安装引导。
- `windows-installer`: 提供 Windows 原生的 PowerShell 安装脚本,与 `install.sh` 对等,处理二进制下载与 multiplexer 依赖提示。

### Modified Capabilities
*(无 — 现有 `image-preview-refresh` 与本变更无关,现有会话/agent/控制模式行为的对外接口不变,仅内部实现平台化。)*

## Impact

- **代码**:
  - `src/tmux/mod.rs`:`read_process_cmdline` 与 `walk_process_tree` 提取到新文件 `src/tmux/process_info.rs`,平台分支通过 `cfg(unix)`/`cfg(windows)` 分离。
  - `src/ws/terminal.rs`:`libc::write` / `libc::kill` 调用提取到 `src/tmux/pty_io.rs`,Windows 使用 `portable_pty::MasterWriter` 与 `windows_sys` 进程终止。
  - `src/tmux/agent_hooks.rs`:`detect_agent_kind` 扩展 Windows 命令形态匹配(`.exe`、Node.js wrapper、PS alias)。
  - `src/main.rs` 或启动流程:加入 multiplexer 检测,缺失时输出结构化错误与安装命令。
- **依赖**:
  - `Cargo.toml`:`libc` 移入 `[target.'cfg(unix)'.dependencies]`,新增 `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.61", features = [...] }`。可选加入 `sysinfo` 作为跨平台进程枚举的兜底。
- **CI/CD**:
  - `.github/workflows/release.yml` 增加 Windows 矩阵与产物上传。
- **用户可见**:
  - Windows 用户首次可以原生安装 OmniTerm,安装体验为:`winget install psmux` → `npm i -g omniterm`(或 `install.ps1`)→ 启动,agent 检测、会话持久化、控制模式与 Linux 一致。
  - Linux/macOS 用户零感知,tmux 路径不变。
- **前置验证(spike)**:本提案依赖一个**必须在实现前完成**的 psmux 兼容性 spike,验证多 session、`#{@user_option}` format 展开、`pane_pid` 在 ConPTY 下的语义、`-CC` 控制模式 4 个场景。任何一项失败则回退到 WSL2-only 方案,不进入本次实现。详见 `design.md`。
