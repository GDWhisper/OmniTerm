# Windows Support

> **⚠️ 实验性特性 — 未经充分验证**
>
> Windows 支持所需的底层代码（平台分支、进程枚举、进程清理、agent 检测）**已在代码层面实现**，
> 但 `openspec/changes/windows-psmux-support` 的 **Phase 0 兼容性 spike 尚未完成**（未在任何真实
> Windows 环境 / `windows-latest` runner 上验证 psmux 多 session、`@user_option` 展开、`pane_pid`
> ConPTY 语义、控制模式、`pane_current_path` 等关键场景）。
>
> 因此本文档描述的能力**目前视为实验性**：代码可编译，但未在真实 Windows 上跑通端到端验证。
> 请谨慎使用，并优先在 Linux/macOS 或 WSL2 下运行 OmniTerm。相关问题欢迎反馈。

OmniTerm supports Windows natively via [psmux](https://github.com/psmux/psmux), a Rust-based tmux replacement built on the Windows ConPTY API.

## Prerequisites

- **psmux** (v3.0+) — provides the `tmux` CLI compatible with OmniTerm
  ```powershell
  winget install psmux    # recommended
  scoop install psmux
  cargo install psmux
  ```

## Known Differences from Linux/macOS

### ConPTY Intermediate Process

On Windows, the `pane_pid` reported by psmux points to a ConPTY host process (`conhost.exe` or `OpenConsole.exe`), not the shell directly. Agent CLI processes (e.g. `claude.exe`) run 1–3 levels below this host process. OmniTerm's `walk_process_tree` handles this by recursively scanning child processes.

### No SIGHUP

Windows lacks `SIGHUP`. Session cleanup uses a two-step approach:
1. `GenerateConsoleCtrlEvent(CTRL_CLOSE_EVENT)` — signals the process to exit gracefully
2. After 500ms timeout, `TerminateProcess` — forced termination if still running

### PTY Writes

The Unix tty-layer bug (where `portable_pty::MasterWriter::drop` injects `\n\x04`) does not occur on Windows ConPTY. The Windows path uses `MasterWriter` directly.

### PowerShell OSC 7

`pane_current_path` depends on the shell emitting OSC 7 escape sequences. PowerShell 7+ sends these by default. Windows PowerShell 5.1 does not — users on 5.1 may see empty CWD values in the file browser.

**Recommendation**: Use PowerShell 7+ for the best experience.

## Platform Architecture

```text
src/tmux/
├── mod.rs               # CLI calls (platform-neutral)
├── agent_hooks.rs       # Hook config + detect_agent_kind (shared)
├── agent_state.rs       # State parsing (shared)
├── control_mode.rs      # Control mode (shared)
├── process_info.rs      # [platform] Process enumeration
└── pty_io.rs            # [platform] PTY writes + process cleanup
```

- **`process_info.rs`**: `cfg(unix)` uses `/proc/<pid>/cmdline` + `/proc/<pid>/task/<tid>/children`. `cfg(windows)` uses `sysinfo` crate for cross-platform process enumeration.
- **`pty_io.rs`**: `cfg(unix)` uses `libc::write` + `libc::kill(SIGHUP)`. `cfg(windows)` uses `portable_pty::MasterWriter` + `GenerateConsoleCtrlEvent`/`TerminateProcess`.

## Agent CLI Detection on Windows

The `detect_agent_kind` function recognizes:
- Direct executables: `claude.exe`, `codex.exe`, `qoder.exe`
- Node.js wrappers: `node.exe C:\...\claude\bin\cli.js`
- Path-based: `C:\Users\x\claude.exe`

Negative samples (`claudette.exe`, `codextool.exe`) are correctly rejected via exact basename matching.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "terminal multiplexer not found" | psmux not installed | `winget install psmux` |
| Agent status shows "unknown" | ConPTY process tree too deep | Check psmux version (need 3.0+) |
| File browser shows wrong CWD | PowerShell 5.1 lacks OSC 7 | Upgrade to PowerShell 7+ |
| Orphan `conhost.exe` processes | Session cleanup race | Restart OmniTerm; processes will be reclaimed |
