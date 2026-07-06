## 1. Phase 0 — psmux 兼容性 spike(实现前强制完成)

- [ ] 1.1 准备 Windows 验证环境:本地 Windows 机器或 GitHub Actions `windows-latest` runner,执行 `winget install psmux`(或 cargo install psmux)
- [ ] 1.2 验证场景 A — 多 session:连续执行 `tmux new-session -d -s s1` 和 `tmux new-session -d -s s2`,再执行 `tmux list-sessions -F "#{session_name}"`,确认能列出两个 session。记录输出到 `docs/psmux-spike-results.md`
- [ ] 1.3 验证场景 B — `@user_option` format 展开:执行 `tmux set-option -t s1 @omniterm_agent "claude:idle"`,再执行 `tmux list-sessions -F "#{session_name}|#{@omniterm_agent}"`,确认第二列非空且为 `claude:idle`
- [ ] 1.4 验证场景 C — `pane_pid` 在 ConPTY 下的语义:执行 `tmux list-panes -t s1 -F "#{pane_pid}"`,取 PID 后用 PowerShell `Get-Process <pid>` 查看其进程名,记录是 `conhost.exe` / `OpenConsole.exe` / `pwsh.exe` 中的哪个;再用 `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"` 观察子进程层级,确认 `walk_process_tree` 需要递归几层
- [ ] 1.5 验证场景 D — 控制模式:执行 `tmux -C attach-session -t s1`,发送 `list-sessions\n`,确认收到 `%begin` / `%end` 响应帧;若失败,记录具体错误
- [ ] 1.6 验证场景 E — `pane_current_path`:在 session 中 `cd` 到某个目录,执行 `tmux display-message -t s1 -p '#{pane_current_path}'`,确认返回的是真实 cwd 而非空字符串
- [ ] 1.7 Spike 结论记录:将 5 个场景的输入/输出/结论写入 `docs/psmux-spike-results.md`,并在 proposal/design 对应章节加引用。**任一场景失败则本提案回退到 WSL2-only 方案,停止后续 task**

## 2. Phase 1 — 进程信息抽象(`src/tmux/process_info.rs`)

- [ ] 2.1 新建 `src/tmux/process_info.rs`,声明 `pub fn read_process_cmdline(pid: u32) -> Option<AgentKind>` 和 `pub fn walk_process_tree(pid: u32) -> Option<AgentKind>`,参数类型从 `i32` 改为 `u32`(同时更新调用点,Windows PID 语义为 unsigned)
- [ ] 2.2 添加 `sysinfo` 依赖到 `Cargo.toml`(可选,作为跨平台进程枚举后端);若 spike 阶段验证 sysinfo 在某些 Windows 形态下不可靠,改为 `windows-sys = { version = "0.61", features = ["Win32_System_Diagnostics_Toolhelp", "Win32_System_Threading"] }` 直接实现
- [ ] 2.3 实现 `cfg(unix)` 分支:将 `src/tmux/mod.rs` 中现有的 `/proc/<pid>/cmdline` 和 `/proc/<pid>/task/<tid>/children` 逻辑迁移过来,行为零变化
- [ ] 2.4 实现 `cfg(windows)` 分支:`read_process_cmdline` 读取进程命令行并调用 `detect_agent_kind`;`walk_process_tree` 递归 3 层父子关系(从 spike 结果确定深度)
- [ ] 2.5 将 `src/tmux/mod.rs` 中 `detect_agent_in_session` 与 `walk_process_tree` 的调用点改为 `process_info::` 路径,删除原内联实现
- [ ] 2.6 为 `read_process_cmdline` 添加单元测试:当前进程(不应匹配)、不存在 PID(返回 None)、已知 agent CLI 名(应匹配)、相似但不同名(不应匹配,如 `claudette.exe` 不应匹配为 `claude`)
- [ ] 2.7 为 `walk_process_tree` 添加集成测试(在 Linux 上通过嵌套 shell 模拟;在 Windows 上通过 spike 阶段的 fixture 数据模拟)

## 3. Phase 2 — PTY I/O 与进程清理抽象(`src/tmux/pty_io.rs`)

- [ ] 3.1 新建 `src/tmux/pty_io.rs`,声明 `pub fn write_pty(master: &Box<dyn MasterPty>, data: &[u8]) -> io::Result<usize>` 和 `pub fn kill_session_process(pid: u32)`
- [ ] 3.2 实现 `cfg(unix)` 分支:迁移 `src/ws/terminal.rs` 中现有的 `libc::write(master.as_raw_fd(), ...)` 与 `libc::kill(pid as i32, libc::SIGHUP)` 实现
- [ ] 3.3 实现 `cfg(windows)` 分支的 `write_pty`:直接使用 `portable_pty::MasterWriter`(ConPTY 无 Unix tty 层的 `\n\x04` drop bug)
- [ ] 3.4 实现 `cfg(windows)` 分支的 `kill_session_process`:先 `GenerateConsoleCtrlEvent(CTRL_CLOSE_EVENT, 0)` 并等待 500ms,若进程未退出则回退 `TerminateProcess`
- [ ] 3.5 将 `src/ws/terminal.rs` 中的 `libc::write` / `libc::kill` 调用替换为 `pty_io::write_pty` / `pty_io::kill_session_process`
- [ ] 3.6 `Cargo.toml` 依赖平台化:将 `libc = "0.2"` 移入 `[target.'cfg(unix)'.dependencies]`;新增 `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.61", features = [...] }`(若 Phase 2.2 选择了 windows-sys)

## 4. Phase 3 — agent CLI 形态识别扩展

- [ ] 4.1 在 `src/tmux/agent_hooks.rs` 的 `detect_agent_kind` 中扩展 Windows 形态:`claude.exe` / `codex.exe` / `qoder.exe`(绝对路径或 basename),使用 basename 匹配而非子串匹配,避免 `claudette.exe` 误判
- [ ] 4.2 支持 Node.js wrapper 形态:命令行形如 `node.exe C:\...\claude\bin\cli.js` 时,通过脚本路径中的 `claude`/`codex`/`qoder` 关键字识别 agent
- [ ] 4.3 添加单元测试覆盖 Windows 形态:`C:\Users\x\claude.exe`、`claude.exe --flag`、`node C:\...\claude\cli.js`、`claudette.exe`(负样本)、`codextool.exe`(负样本)

## 5. Phase 4 — 启动时 multiplexer 检测

- [ ] 5.1 在 `src/main.rs`(或启动流程合适位置)调用 `which::which("tmux")`,若返回 `Err` 则进入缺失处理分支
- [ ] 5.2 缺失处理:根据 `cfg!(unix)`/`cfg!(windows)` 打印平台对应的安装命令(Unix: `apt install tmux` / `brew install tmux` / `pacman -S tmux`;Windows: `winget install psmux` / `scoop install psmux` / `cargo install psmux`)
- [ ] 5.3 通过 API 返回结构化错误(错误码 + 缺失标识),前端可渲染友好提示而非原始 stderr
- [ ] 5.4 (可选)版本校验:解析 `tmux -V` 或 `psmux --version` 输出,低于已知兼容版本时打印警告(不阻断启动)
- [ ] 5.5 前端侧:在 session 列表加载失败的错误处理中识别"multiplexer 缺失"错误码,显示安装指引与"复制命令"按钮

## 6. Phase 5 — Windows 安装脚本与 npm 包支持

- [ ] 6.1 新增 `install.ps1` PowerShell 脚本:检测架构(`$env:PROCESSOR_ARCHITECTURE`)、从 release asset 下载对应 `omniterm-windows-<arch>.zip`、解压到用户目录(如 `$env:LOCALAPPDATA\omniterm`)、加入用户 `PATH`
- [ ] 6.2 `install.ps1` 在完成后检测 `tmux` / `psmux` 是否在 `PATH`,缺失时打印 `winget install psmux`(首选)/ `scoop install psmux` / `cargo install psmux`,不自动执行
- [ ] 6.3 `install.ps1` 的公网托管 URL:复用现有 `install.sh` 的 CDN 或 GitHub Release raw URL(待运维确认,见 design.md Open Question 5)
- [ ] 6.4 修改 `npm-package/install.js`:解除 `if (p === 'win32') process.exit(1)` 分支,在平台映射表中添加 `win32-x64` → `omniterm-windows-x86_64.zip`、`win32-arm64` → `omniterm-windows-aarch64.zip`
- [ ] 6.5 `install.js` 在 Windows 上完成二进制安装后,执行 multiplexer 检测,缺失时打印 psmux 安装提示(不阻断 npm 安装)
- [ ] 6.6 在 Windows 机器(或 Wine / 虚拟机)上跑 `npm i -g omniterm`,验证 install.js 完整流程

## 7. Phase 6 — Release workflow 扩展

- [ ] 7.1 修改 `.github/workflows/release.yml`,在构建矩阵中新增条目:`{ os: windows-latest, target: x86_64-pc-windows-msvc, platform: windows-x86_64 }`
- [ ] 7.2 (第二阶段,可后置)新增 `aarch64-pc-windows-msvc` 矩阵条目,使用 `windows-11-arm` runner(确认 runner 可用性与配额)
- [ ] 7.3 Release workflow 在 Windows runner 上执行 `cargo build --release --target <target>`,产物 `omniterm.exe` 打包为 `omniterm-windows-<arch>.zip` 并上传到 release asset
- [ ] 7.4 Release workflow 在完成后触发 npm publish,`npm-package/install.js` 的平台映射与新发布的 asset 名称对应
- [ ] 7.5 首次 Windows release 作为 RC 验证:在干净 Windows 11 环境跑完整安装流程(install.ps1 → 启动 → 创建 session → 启动 agent → 验证 agent 状态显示)

## 8. Phase 7 — 文档与 CHANGELOG

- [ ] 8.1 更新 `README.md` 增加 Windows 安装章节(`winget install psmux` + `npm i -g omniterm`)
- [ ] 8.2 新增 `docs/windows-support.md`:Windows 平台已知差异(ConPTY 中间层、`SIGHUP` 替代、PowerShell OSC 7 行为)、故障排查、psmux 版本要求
- [ ] 8.3 更新 `docs/architecture-backend.md` 中 tmux 模块章节,说明 `process_info.rs` 与 `pty_io.rs` 的平台化设计
- [ ] 8.4 `CHANGELOG.md` 添加条目:`feat: add native Windows support via psmux`
- [ ] 8.5 将 spike 阶段的验证结果固化到 `docs/psmux-spike-results.md`,作为未来回归参考
