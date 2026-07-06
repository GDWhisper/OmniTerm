## ADDED Requirements

### Requirement: 启动时检测 multiplexer 可用性
OmniTerm MUST detect at early startup whether a usable terminal multiplexer is installed on the current system, and report a structured error when missing rather than failing on the first tmux invocation.

#### Scenario: Linux/macOS 检测到 tmux
- **WHEN** the program starts on Unix and `tmux` is executable in `PATH`
- **THEN** startup SHALL continue and all subsequent tmux invocations SHALL work normally

#### Scenario: Windows 检测到 psmux 提供的 tmux.exe
- **WHEN** the program starts on Windows and `tmux` (the shim shipped by psmux or a directly installed `tmux.exe`) is executable in `PATH`
- **THEN** startup SHALL continue and all subsequent tmux invocations SHALL work normally

#### Scenario: Unix 缺失 tmux
- **WHEN** the program starts on Unix and `tmux` is not in `PATH`
- **THEN** startup SHALL fail with a clear error instructing the user to install via package managers such as `apt install tmux`, `brew install tmux`, or `pacman -S tmux`

#### Scenario: Windows 缺失 psmux
- **WHEN** the program starts on Windows and neither `tmux` nor `psmux` is in `PATH`
- **THEN** startup SHALL fail with a clear error listing three install methods in order: `winget install psmux`, `scoop install psmux`, `cargo install psmux`

### Requirement: 缺失时仅提示、不自动安装
The system MUST only display copyable install commands to the user and MUST NOT automatically invoke `winget`, `scoop`, `cargo`, or any other package manager to install the missing multiplexer.

#### Scenario: 不自动触发包管理器
- **WHEN** the multiplexer is detected as missing
- **THEN** the program SHALL print the install commands and exit, and MUST NOT spawn any subprocess that performs installation (to avoid UAC prompts, enterprise-policy violations, or silent failures behind proxies)

#### Scenario: 错误信息可机器解析
- **WHEN** the frontend or a script needs to handle a "multiplexer missing" error
- **THEN** the backend MUST report the missing state via a structured channel (e.g. a JSON error code or a dedicated API), not only via stderr text, so the frontend can render a friendly prompt

### Requirement: 版本最低要求校验(可选)
The system SHALL have the option to, after detecting tmux/psmux, parse its version number and print a warning if it is below a known compatible version.

#### Scenario: psmux 版本过低
- **WHEN** psmux is detected at a version below v3.0 (placeholder, to be fixed by spike results)
- **THEN** the program SHALL print an upgrade warning but MUST NOT block startup
