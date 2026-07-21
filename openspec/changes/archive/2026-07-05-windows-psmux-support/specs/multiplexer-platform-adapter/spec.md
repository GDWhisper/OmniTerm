## ADDED Requirements

### Requirement: 平台无关的进程信息查询接口
The system SHALL provide a unified process-info query interface `process_info::read_process_cmdline(pid) -> Option<AgentKind>` and `process_info::walk_process_tree(pid) -> Option<AgentKind>`, abstracting the differences between Linux `/proc` and Windows `CreateToolhelp32Snapshot` + `QueryFullProcessImageNameW`, for use by agent process detection logic.

#### Scenario: Linux 上保持原有 `/proc` 行为
- **WHEN** the program runs on Linux and is given a PID of a known agent process
- **THEN** `read_process_cmdline` SHALL return `Some(AgentKind)` with the correct kind (identical to current `/proc/<pid>/cmdline` behavior)

#### Scenario: Windows 上通过进程名或命令行识别 agent
- **WHEN** the program runs on Windows and is given a PID of a known agent process (e.g. `claude.exe`, `node.exe ... claude\cli.js`, `codex.exe`, `qoder.exe`)
- **THEN** `read_process_cmdline` SHALL return `Some(AgentKind)` with the correct kind

#### Scenario: 进程不存在或无权访问
- **WHEN** the given PID does not exist, has exited, or the current user lacks permission to access its command line
- **THEN** `read_process_cmdline` MUST return `None` (MUST NOT panic and MUST NOT treat the error as an agent signal)

#### Scenario: walk_process_tree 穿越 ConPTY 中间层
- **WHEN** on Windows, the `pane_pid` reported by tmux/psmux actually points to a ConPTY host process such as `conhost.exe` or `OpenConsole.exe`
- **THEN** `walk_process_tree` MUST traverse at least 3 levels of parent-child relationships and return the agent `AgentKind` when an agent CLI is found in a descendant

#### Scenario: PID 回收不误判
- **WHEN** the given PID has been reclaimed by the OS and reassigned to an unrelated process
- **THEN** `walk_process_tree` SHALL return `None` if the new process's command line does not match any agent (MUST NOT make decisions based on the PID value alone)

### Requirement: 平台无关的 PTY 写入接口
The system SHALL provide `pty_io::write_pty(master, data) -> io::Result<usize>`, preserving the current Unix `libc::write` implementation that works around the `portable_pty::MasterWriter::drop` bug, and using `portable_pty::MasterWriter` directly on Windows.

#### Scenario: Unix 写入保持现有修复
- **WHEN** the program writes a byte slice through the PTY on Unix
- **THEN** the behavior SHALL be identical to the current `libc::write(master_fd, ...)` implementation and MUST NOT inject extra bytes such as `\n\x04`

#### Scenario: Windows 写入通过 MasterWriter
- **WHEN** the program writes a byte slice through the PTY on Windows
- **THEN** the bytes SHALL be delivered verbatim to the ConPTY child process and MUST NOT reproduce the Unix tty-layer bug

### Requirement: 平台无关的会话进程清理接口
The system SHALL provide `pty_io::kill_session_process(pid)`, sending `SIGHUP` on Unix and using an appropriate termination mechanism on Windows (preferring `GenerateConsoleCtrlEvent(CTRL_CLOSE_EVENT)`, falling back to `TerminateProcess`).

#### Scenario: Unix 发送 SIGHUP
- **WHEN** the program cleans up a session process on Unix
- **THEN** it SHALL send `SIGHUP` to the target PID, identical to the current `libc::kill(pid, SIGHUP)` behavior

#### Scenario: Windows 优雅终止
- **WHEN** the program cleans up a session process on Windows
- **THEN** it SHALL first attempt a console close event to allow graceful exit; if the process does not respond, it SHALL fall back to forced termination and MUST NOT leave orphan `conhost.exe` or agent processes behind

### Requirement: agent CLI 形态识别扩展
The system SHALL extend `detect_agent_kind` to recognize agent command forms common on Windows, including `.exe` extensions, Node.js entry scripts, and PowerShell aliases.

#### Scenario: Windows .exe 形态
- **WHEN** the command line contains `claude.exe` / `codex.exe` / `qoder.exe` (absolute path or basename)
- **THEN** it SHALL return the corresponding `AgentKind`

#### Scenario: Node.js wrapper 形态
- **WHEN** the command line looks like `node.exe C:\...\claude\bin\cli.js`
- **THEN** it SHALL identify the agent via the script path and return the corresponding `AgentKind`

#### Scenario: 参数透传不误判
- **WHEN** the command line contains a program similar in name to an agent but different (e.g. `claudette.exe`, `codextool.exe`)
- **THEN** it MUST NOT return a wrong `AgentKind` (MUST perform basename or path-segment matching, not substring matching)
