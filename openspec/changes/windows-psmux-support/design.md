## Context

OmniTerm 当前依赖 tmux 作为会话管理与 agent 状态轮询后端,所有 tmux CLI 调用集中在 `src/tmux/` 模块,通过 `tokio::process::Command` 子进程执行;平台相关代码(`libc::write`、`libc::kill(SIGHUP)`、`/proc/<pid>/cmdline`、`/proc/<pid>/task/<tid>/children`)散布在 `src/ws/terminal.rs` 与 `src/tmux/mod.rs`,阻止 Windows 支持。

psmux(v3.3.6、MIT、Rust 实现、基于 ConPTY)是一个成熟的 tmux 原生 Windows 替代品,通过 `Cargo.toml` 直接编译出 `tmux.exe` 二进制(不是 shim),CLI 协议、`-C`/`-CC` 控制模式、`@user-option`、`#{pane_current_path}` format 展开均与 tmux 兼容(已通过仓库源码核实,见 `docs/compatibility.md`、`docs/control-mode.md`、`docs/integration.md`)。这意味着 OmniTerm 现有的 `Command::new("tmux")` 调用在 Windows + psmux 环境下**零改动即可运行**——需要改动的只是底层 Unix-only 的系统调用。

**关键约束**:
- Linux/macOS 现有 tmux 行为必须零回归。
- 不得在用户不知情时执行任何包管理器命令(winget/scoop/cargo)。
- 进程枚举在 Windows 上有特殊语义:ConPTY 宿主进程(`conhost.exe`/`OpenConsole.exe`)作为 pane 直接子进程出现,agent CLI 在其下方 1-3 层;PID 会被操作系统回收。
- Windows 上没有 `SIGHUP`,需要用控制台关闭事件或强制终止替代。
- psmux 的 `pane_pid` 在 ConPTY 下返回的具体值、多 session 在单个 psmux server 下的行为等,**必须在实现前通过 spike 验证**(见 Risks 与 Open Questions)。

**已核实的 psmux 信息**:v3.3.6、MIT、`github.com/psmux/psmux`、`winget install psmux`/`scoop install psmux`/`cargo install psmux` 三种安装通道、`tmux.exe` 直接编译、控制模式线协议兼容、`#{@user_option}` format 展开、`pane_current_path` 展开。

## Goals / Non-Goals

**Goals:**
- 在 Windows 上以 psmux 作为 tmux 替代品,让 OmniTerm 的会话管理、agent 检测、控制模式功能正常可用。
- 将所有平台相关代码封装到独立模块(`process_info.rs`、`pty_io.rs`),通过 `cfg(unix)`/`cfg(windows)` 分离,Unix 路径零回归。
- 提供友好的 Windows 安装体验:PowerShell 脚本一行安装、npm 包可用、缺失 multiplexer 时给出明确安装命令提示。
- 在实现前完成 psmux 兼容性 spike,避免基于未验证假设写代码。

**Non-Goals:**
- **不实现**自动安装 multiplexer(避免 UAC、企业策略、网络问题)。
- **不支持** WSL2 作为 Windows 平台的主要路径(WSL2 用户可继续通过现有 Linux 路径使用,但不在本次范围内优化该体验)。
- **不引入**新的 multiplexer 抽象 trait(当前 tmux CLI 调用已足够统一,不需要 `MultiplexerBackend` 抽象)。
- **不改造** `detect_agent_in_session` 轮询机制本身(保持当前每秒轮询节奏)。
- **不实现** Windows 专属的进程监控替代方案(如 ETW 或 Job Object 回调)。

## Decisions

### Decision 1: 进程枚举用 `sysinfo` crate,而非直接 `windows-sys`

**选择**:引入 [`sysinfo`](https://crates.io/crates/sysinfo) crate 作为跨平台进程信息查询的统一后端。`sysinfo` 封装了 `CreateToolhelp32Snapshot` + `QueryFullProcessImageNameW`(Windows)和 `/proc`(Linux)的差异,API 稳定,活跃维护。

**理由**:
- 减少直接调用 `windows-sys` 的代码量,避免手动处理进程权限(`PROCESS_QUERY_LIMITED_INFORMATION`)、句柄泄漏、PID 回收等陷阱。
- `sysinfo::System::process(pid)` 直接返回命令行与可执行路径,且已处理 Unicode 转换。
- 未来如需添加 macOS 支持,`sysinfo` 已经支持。
- 性能足够:OmniTerm 每秒轮询一次,`sysinfo::System::refresh_processes()` 在 Windows 上的开销远低于轮询间隔。

**替代方案**:直接用 `windows-sys::Win32::System::Diagnostics::Toolhelp` 和 `Threading`。代码更"原生",但要自己处理的边界 case 多,且需要维护一个独立的 Linux 实现。在 AI 辅助下实现时间差异可忽略,但**正确性风险**显著更高——否决。

**权衡**:`sysinfo` 是一个新增依赖,但已是 Rust 生态事实标准之一,引入成本低。

### Decision 2: PTY 写入平台化 —— 最小改动

**选择**:在 `src/tmux/pty_io.rs` 提供 `write_pty` 与 `kill_session_process`,Unix 分支保留现有 `libc::write`/`libc::kill(SIGHUP)` 实现,Windows 分支使用 `portable_pty::MasterWriter` 与 `windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent`(失败回退 `TerminateProcess`)。

**理由**:Unix 侧的 `libc::write` 是为绕过 `portable_pty::MasterWriter::drop` 写入 `\n\x04` 的已知 bug,这个 bug 只在 Unix tty 层出现,Windows ConPTY 无此问题,因此 Windows 可以直接用 `MasterWriter`,无需重复 hack。

**替代方案**:统一用 `portable_pty::MasterWriter`。需要先在 Unix 上验证 bug 是否还存在,且可能回归——否决,风险大于收益。

### Decision 3: 模块结构 —— 新增两个平台化文件

```text
src/
├── tmux/
│   ├── mod.rs               # CLI 共享(无平台差异)
│   ├── agent_hooks.rs       # 共享(生成 hook 配置字符串)+ detect_agent_kind 扩展
│   ├── agent_state.rs       # 共享(解析 @omniterm_agent 值)
│   ├── control_mode.rs      # 共享(tokio process pipe)
│   ├── process_info.rs      # [新增] 进程信息抽象(cfg(unix)/cfg(windows))
│   └── pty_io.rs            # [新增] PTY 写入与进程清理(cfg(unix)/cfg(windows))
└── ws/
    └── terminal.rs          # 将 libc::write/kill 调用替换为 pty_io 接口
```

**理由**:最小侵入,不破坏现有 `tmux/mod.rs` 的结构。新增两个文件集中承载平台差异,未来如有新平台(如 BSD)只需在这两个文件加分支。

### Decision 4: 启动时 multiplexer 检测的实现方式

**选择**:在 `src/main.rs`(或合适的启动 hook)调用 `which::which("tmux")`,缺失时根据 `cfg!(unix)`/`cfg!(windows)` 打印结构化错误 + 安装命令,同时通过 API 返回错误码供前端渲染。

**理由**:`which` 已是项目依赖(通过 psmux 源码看到其在 Rust 生态中常用),跨平台,API 简洁。

**替代方案**:用 `std::process::Command::new("tmux").output()` 试跑。会多一次子进程开销,且难以区分"未安装"与"安装但启动失败"——否决。

### Decision 5: 不自动安装 —— 仅提示

**选择**:检测到 multiplexer 缺失时,只打印可复制的命令(`winget install psmux` 等),不触发任何子进程执行安装。

**理由**:
- winget / scoop 需要用户同意,可能弹 UAC。
- 企业环境可能禁止自动安装。
- 网络代理/防火墙可能导致下载失败,用户无法感知原因。
- "提示 + 用户手动执行"是 Rust 工具链(`rustup`)、Node.js 等同类工具的标准做法。

### Decision 6: install.ps1 独立脚本,而非扩展 install.sh

**选择**:新增 `install.ps1` PowerShell 脚本,与 `install.sh` 并行存在。

**理由**:PowerShell 是 Windows 原生,`irm ... | iex` 模式已成 Windows 开发者习惯(rustup、scoop 都用)。扩展 `install.sh` 在 Git Bash 下可用但体验差,且需要引入 pwsh 检测。

**替代方案**:用 `install.sh` + `pwsh -c "..."`。复杂且依赖 Git Bash——否决。

## Risks / Trade-offs

### Risk: psmux "one session per server" 行为不明确 → 必须先 spike

`docs/control-mode.md:366` 提到 "psmux uses one session per server",字面理解是单个 psmux 进程只支持一个 session,这与 OmniTerm 多 session 模型冲突。

→ **Mitigation**:本变更在 Phase 1(实现)之前强制一个 spike 阶段,在真实 Windows 环境(或 GitHub Actions `windows-latest` runner)验证 `tmux new-session -d -s s1` + `tmux new-session -d -s s2` + `tmux list-sessions` 能否列出两个 session。任何一条失败,本提案回退到 WSL2-only 方案,不进入实现。

### Risk: ConPTY 中间进程导致 agent 检测不准

psmux 给出的 `pane_pid` 可能指向 `conhost.exe` 或 `OpenConsole.exe`,agent 进程在其子孙层。递归深度与匹配规则容易写错。

→ **Mitigation**:`walk_process_tree` Windows 版递归至少 3 层;增加单元测试,用 `cmd.exe /c ping -t` 等 Windows 常见命令形态做负样本验证;`detect_agent_kind` 改为 basename 匹配(而非子串匹配),避免 `claudette.exe` 误判为 `claude`。

### Risk: PID 回收导致误判

Windows 回收 PID 比 Linux 频繁,旧 session 的 PID 可能被分配给新进程。

→ **Mitigation**:`read_process_cmdline` 只基于命令行内容判断,不缓存 PID → AgentKind 映射;session 清理时及时调用 `kill_session_process` 终止关联进程树。

### Risk: `libc::kill(SIGHUP)` 在 Windows 上没有对等语义

`GenerateConsoleCtrlEvent(CTRL_CLOSE_EVENT, ...)` 对 GUI 进程无效,`TerminateProcess` 不留清理机会。

→ **Mitigation**:先 `GenerateConsoleCtrlEvent`,等待 500ms,检查进程是否退出;未退出则 `TerminateProcess`。这是 Windows 上最常见的"优雅终止"两步走模式,与 Node.js / Go 的 subprocess 终止策略一致。

### Risk: Release workflow Windows runner 不可用或构建慢

`windows-latest` runner 在 GitHub Actions 有配额与时长限制,ARM64 runner(`windows-11-arm`)是较新资源。

→ **Mitigation**:第一阶段只加 `windows-latest`(x86_64),ARM64 作为第二阶段或后续 PR 引入;复用现有 cross-compile setup。

### Risk: 依赖新增(sysinfo)可能引入兼容问题

`sysinfo` 在某些 Windows 版本上可能需要额外 manifest。

→ **Mitigation**:spike 阶段在至少一个真实 Windows 10/11 机器上跑 `sysinfo::System::refresh_processes()`,验证返回的命令行字段非空。

### Trade-off: 不引入 MultiplexerBackend 抽象

保持 `Command::new("tmux")` 调用不变,通过 psmux 提供同名二进制做"协议级兼容"。这比引入 trait 抽象更简洁,但也意味着**如果未来 psmux 与 tmux 出现协议分歧**,需要回头做抽象。考虑到 psmux 已声明线协议兼容,且当前风险可控,优先选择简单路径。

## Migration Plan

本变更**无用户侧数据或配置迁移**。部署步骤:

1. **Phase 0 — Spike**(实现前,~0.5 天):在 Windows 环境验证 psmux 4 个关键场景(多 session、`@option` format 展开、`pane_pid` 语义、`-CC` 控制模式)。失败则回退到 WSL2-only 方案,本提案不继续。
2. **Phase 1 — 模块重构与平台化**:新增 `process_info.rs`、`pty_io.rs`,Unix 行为零变化,可独立合入,不影响任何用户。
3. **Phase 2 — Windows 实现**:补 `cfg(windows)` 分支,本地 Windows 构建通过,但不在 CI 发布。
4. **Phase 3 — 启动检测与安装引导**:`main.rs` 加 multiplexer 检测,`install.ps1` / `install.js` 新增 Windows 路径,可在 Unix CI 验证逻辑。
5. **Phase 4 — Release workflow**:加入 Windows 矩阵,第一次 Windows 发布作为 RC 验证,手动跑回归测试后再发正式版。
6. **回滚策略**:任何阶段出问题,直接 revert 对应 PR,不影响 Linux/macOS 路径(平台化重构已保证 Unix 分支不变)。

## Open Questions

1. **psmux 多 session 真实行为**:文档措辞可能是指"一个 session 一个 server 进程"(启动 tmux server 时 attach 到 session),但 `tmux new-session` 多次是否产生多个 server 实例,还是单 server 多 session,需要 spike 验证。如果是前者,OmniTerm 的"会话列表"在 Windows 上要改为扫描多个 psmux server,而非调用一次 `list-sessions`。**Spike 必须回答**。

2. **`pane_pid` 在 ConPTY 下的语义**:psmux 的 `list-panes -F '#{pane_pid}'` 返回的是 ConPTY 宿主 PID 还是 PowerShell PID?如果前者,`walk_process_tree` 递归策略需要调整;**Spike 必须回答**。

3. **Windows 上 `pane_current_path` 的 OSC 7 支持**:tmux 的 `pane_current_path` 依赖 shell 发送 OSC 7 转义序列,PowerShell 默认不发。psmux 是否自带 hook?PowerShell 7+ 是否默认发送?如果不可靠,需要补充:在 psmux 配置里注入 OSC 7 prompt hook,或文档告知用户使用 PowerShell 7+。**Spike 阶段验证**。

4. **sysinfo vs windows-sys 的最终取舍**:本 design 偏向 sysinfo,但实际实现时若发现 sysinfo 在特定 Windows 版本上的命令行读取不完整(如受 `PPL` 保护的系统进程),可能需要回退到 `windows-sys`。允许实现阶段微调,不视为 design 变更。

5. **install.ps1 的托管 URL**:`irm https://.../install.ps1 | iex` 需要一个稳定的公网 URL。是否复用现有 `install.sh` 的 CDN / GitHub Release raw URL?待运维侧确认。
