# Windows 支持方案：psmux

> **初步方案，非最终执行计划。** 此文档用于评审讨论，经评审并决策后才能作为正式执行依据。
> 所有估算均为粗略值，未经实测验证。
> 记录时间：2026-07-05

## 1. 问题

OmniTerm 深度依赖 tmux 作为会话管理、agent 状态轮询、控制模式的后端。Windows 无原生 tmux。WSL2 可行但对未安装的用户门槛高。

## 2. 方案：psmux

[psmux](https://github.com/psmux/psmux)（MIT，Rust 实现，2800+ stars）是 Windows 原生 tmux 替代品。它：

- 使用 Windows ConPTY API，原生运行（不需要 WSL/Cygwin/MSYS2）
- 实现了 83 个 tmux 命令，140+ format variables，tmux 配置兼容
- 安装 `tmux.exe` 别名，现有 `Command::new("tmux")` 调用直接命中
- 支持控制模式（`psmux -CC`）、自定义 session options（`#{@omniterm_agent}`）、agent teams
- 一行安装：`winget install psmux`（或 `cargo install psmux` / `scoot install psmux`）

**核心结论**：OmniTerm 的 tmux CLI 调用全部兼容，**一行不改**。需要改的只有 Rust 中 Unix-only 的系统调用（`libc::write`、`SIGHUP`、`/proc`）。

## 3. 兼容性矩阵

| OmniTerm 代码位置 | 调用 | psmux | 需改? |
|---|---|---|---|
| `src/tmux/mod.rs` `new_session()` | `tmux new-session -d -s <n> -c <d> -x 200 -y 50` | yes | no |
| `kill_session()` | `tmux kill-session -t <n>` | yes | no |
| `list_sessions()` | `tmux list-sessions -F "#{...}"` | yes | no |
| `session_exists()` | `tmux has-session -t <n>` | yes | no |
| `send_keys()` | `tmux send-keys -t <n> <keys> Enter` | yes | no |
| `pane_cwd()` | `tmux display-message -p '#{pane_current_path}'` | yes | no |
| `capture_pane()` | `tmux capture-pane -p -S -<N>` | yes | no |
| `get_session_agent_option()` | `tmux show-options -t <s> @omniterm_agent` | yes | no |
| `set-option @omniterm_agent` (agent_hooks) | `tmux set-option -q @omniterm_agent ...` | yes | no |
| `list-panes -F '#{pane_pid}'` | `tmux list-panes -t <s> -F '#{pane_pid}'` | yes | no |
| `detect_agent_in_session()` | `tmux list-panes` + **`/proc/<pid>/cmdline`** | yes + **Windows enum** | **yes** |
| `src/ws/terminal.rs` 输入 | `libc::write()`, `RawFd` | n/a | **yes** |
| `src/ws/terminal.rs` 清理 | `libc::kill(pid, SIGHUP)` | n/a | **yes** |
| `src/tmux/control_mode.rs` | `tmux -C attach-session -t <s>` (stdin/stdout pipe) | yes | no |
| `src/tmux/agent_hooks.rs` | 生成 agent hook config（`tmux set-option` 字符串） | yes | no |
| `src/tmux/agent_state.rs` | 解析 `@omniterm_agent` 值字符串 | yes | no |

**彩色**：tmux CLI 层绿色（无需修改），系统调用层红色（需要平台适配）。

## 4. 需要改的平台特定代码

### 4.1 PTY 输入回路（`src/ws/terminal.rs`）

当前实现为了绕过 `portable_pty::MasterWriter::drop` 写入 `\n\x04` 的 bug，直接用 `libc::write()` 往原始 fd 写。

```rust
// 当前（Unix only）
let pty_fd: RawFd = master.as_raw_fd();
unsafe { libc::write(pty_fd, buf, len); }

// 清理时
unsafe { libc::kill(pid, SIGHUP); }
```

**Windows 方案**：使用 `portable_pty::MasterWriter`。该 bug 只在 Unix tty 层出现，Windows ConPTY 无此问题。或者用 `cfg` 分平台：

```rust
#[cfg(unix)]
fn write_pty(master: &Box<dyn MasterPty>, data: &[u8]) -> io::Result<usize> {
    // 继续用 libc::write（已有修复）
}

#[cfg(windows)]
fn write_pty(master: &Box<dyn MasterPty>, data: &[u8]) -> io::Result<usize> {
    // 使用 MasterWriter
}
```

清理同理：
```rust
#[cfg(unix)]
fn kill_process(pid: u32) { unsafe { libc::kill(pid as i32, libc::SIGHUP); } }

#[cfg(windows)]
fn kill_process(pid: u32) {
    // TerminateProcess 或 GenerateConsoleCtrlEvent
}
```

### 4.2 Agent 进程检测（`src/tmux/mod.rs`）

```rust
// 当前（Linux only）
fn read_process_cmdline(pid: i32) -> Option<AgentKind> {
    let cmdline = fs::read_to_string(format!("/proc/{}/cmdline", pid)).ok()?;
    let cmdline = cmdline.replace('\0', " ");
    agent_hooks::detect_agent_kind(cmdline.trim())
}
```

**Windows 方案**：`CreateToolhelp32Snapshot` → `Process32First`/`Process32Next` → `OpenProcess` + `QueryFullProcessImageNameW`，或跨平台的 `sysinfo` crate。

粗略实现：
```rust
#[cfg(windows)]
fn read_process_cmdline(pid: i32) -> Option<AgentKind> {
    // 用 windows-sys 或 sysinfo crate 枚举进程
    // 读取进程名或命令行，匹配 agent CLI 名称
}
```

### 4.3 Cargo.toml 依赖调整

| 当前 | 改为 |
|---|---|
| `libc = "0.2"`（全局依赖） | `[target.'cfg(unix)'.dependencies] libc = "0.2"` |
| — | `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.59", features = ["Win32_System_Diagnostics_Toolhelp", "Win32_System_Threading"] }` |

## 5. 构建与发布变更

### 5.1 Release workflow（`.github/workflows/release.yml`）

新增 2 个矩阵条目：

```yaml
- os: windows-latest
  platform: windows-x86_64
  target: x86_64-pc-windows-msvc
- os: windows-11-arm
  platform: windows-aarch64
  target: aarch64-pc-windows-msvc
```

### 5.2 npm-package/install.js

```javascript
// 当前
if (p === 'win32') {
  console.error('omniterm: Windows is not supported (requires tmux).');
  process.exit(1);
}

// 改为
if (p === 'win32') {
  suffix = 'windows-x86_64';
  // 不 exit，继续下载
}

// 安装后检查 psmux（不是 tmux）
function checkMultiplexer() {
  // windows 上检查 tmux.exe 或 psmux.exe
  // 没有则提示 winget install psmux
}
```

### 5.3 install.sh / install.ps1

`install.sh` 当前拒绝 Windows。选择：

- **A:** 新增 `install.ps1`（PowerShell 安装脚本），处理 Windows 平台检测、二进制下载、psmux 依赖安装
- **B:** 扩展 `install.sh` 用 `pwsh` 检测 Windows（不推荐，bash on Windows 体验差）

推荐 A。

### 5.4 模块结构调整

```text
src/
├── tmux/
│   ├── mod.rs               # CLI 共享（无平台差异）
│   ├── agent_hooks.rs       # 共享（生成 hook 配置字符串）
│   ├── agent_state.rs       # 共享（解析 @omniterm_agent 值）
│   ├── control_mode.rs      # 共享（tokio process pipe）
│   ├── process_info.rs      # [新增] 进程信息抽象
│   │   #[cfg(unix)]  fn read_process_cmdline()  # /proc
│   │   #[cfg(windows)] fn read_process_cmdline() # Toolhelp32Snapshot
│   └── pty_io.rs            # [新增] PTY 输入/进程清理抽象
│       #[cfg(unix)]  fn write_pty()
│       #[cfg(windows)] fn write_pty()
│       #[cfg(unix)]  fn kill_session_process()
│       #[cfg(windows)] fn kill_session_process()
```

控制模式（`control_mode.rs`）和 agent_hooks 不需要平台分离——它们只通过标准进程管道通信，tmux CLI 调用在 psmux 上一样跑。

## 6. 已知风险与开放问题

| 风险 | 级别 | 说明 |
|---|---|---|
| `#{@omniterm_agent}` 在 psmux format 中展开 | **待验证** | 需在 Windows 实测 psmux 的 `list-sessions -F` 是否支持 user option format 变量。FAQ 说 `#{@myvar}` 可用，但需要确认。 |
| psmux `-t` 标志 | **待验证** | 当前代码大量使用 `-t <session>` 定位 session。psmux 文档说支持 `-t`，但需实测 `set-option -t <name> @omniterm_agent <val>` 和 `show-options -t <name> @omniterm_agent` 是否与 tmux 行为一致。 |
| control mode 协议差异 | **低** | psmux 文档说支持控制模式和 `%output` 事件，但 `%exit` 消息格式或错误行为可能与 tmux 有细微差别。 |
| `new-session -A` 在 psmux 中的行为 | **低** | `-A` 确认支持，但 attach 到已有 session 时 CWD 处理可能与 tmux 不同。 |
| `send-keys Enter` 行为 | **低** | Windows 换行符 `\r\n` 与 Unix `\n` 差异可能导致 agent hook 发送时序列不同。 |
| psmux `mouse on` | **低** | 已确认支持，但 mouse forwarding 行为可能有边缘差异。 |
| 版本兼容性 | **低** | psmux 是活跃项目，v0.3.5。需锁定最低版本或加 CI 测试。 |
| 跨平台测试 | **中** | CI 无 Windows runner 时无法自动回归 Windows 行为。需确认是否增加 Windows runner。 |

### 需要实地验证的测试场景

```
1. tmux list-sessions -F "#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{pane_current_path}|#{session_name}"
   → 输出格式是否与 Linux tmux 一致

2. tmux set-option -t testsession @omniterm_agent "claude:idle"
   tmux show-options -t testsession @omniterm_agent
   → 读写是否一致

3. tmux -C attach-session -t testsession
   → 控制模式 stdin/stdout pipe 是否工作

4. tmux send-keys -t testsession "echo hello" Enter
   → 回车行为
```

## 7. 实施步骤（草案）

> **此步骤仅为评审参考，非执行计划。**

| 步骤 | 内容 | 估算 |
|---|---|---|
| 1 | Windows 测试环境搭建 + psmux 兼容性验证（上述 4 个场景） | 0.5天 |
| 2 | `src/tmux/process_info.rs` 提取 + Windows 实现（Toolhelp32Snapshot） | 0.5天 |
| 3 | `src/ws/terminal.rs` 提取 PTY 平台抽象（write/kill） | 1天 |
| 4 | Cargo.toml `cfg(unix)`/`cfg(windows)` 依赖分离 | 0.5天 |
| 5 | Release workflow 新增 Windows targets | 0.5天 |
| 6 | npm-package/install.js Windows 支持 | 0.5天 |
| 7 | `install.ps1` 安装脚本 | 0.5天 |
| 8 | 集成测试 + 回归测试 | 1天 |
| **合计** | | **≈4-5天** |

## 8. 备选

如果 psmux 在关键路径上（如 `#{@omniterm_agent}` format 展开或 `-t` flag）不兼容，回退方案：

1. **WSL2 only**：文档告知 Windows 用户使用 WSL2，零代码改动
2. **Plain PTY fallback**：`TerminalBackend` trait + `NullMultiplexer` 实现，放弃 agent 集成和会话持久化，纯 WebSocket bridge 模式

---

*此文档为初步方案，记录于 2026-07-05。未经评审和决策，不得作为执行依据。*
