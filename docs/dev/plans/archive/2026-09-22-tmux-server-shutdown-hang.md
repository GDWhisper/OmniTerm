# tmux server 假死事故：SIGTERM 后被孤儿 control 客户端无限期冻结关闭流程

> 状态：**已实施**（2026-09-22 实施批次五笔提交：`8abd676` P0-1/P0-2 + 登记表、`221d0c7` 附录 C 机制定论、`ef2c96c` 前端告警、`9963c66` P1-3、`8e5b711` P1-1/P1-2 后端 health；P2-1 上游 issue **仅草稿**入附录 C、尚未提交。设计稿阶段同日经独立子代理审查后全文修订（勘误见 §10），实施偏差见文末「## 实施勘误（2026-09-22 实施批次）」）
> 触发条件：修改 `src/engine/tmux/control_mode.rs`（`ControlModeClient` 的 spawn / `stop()` / `Drop`）、`src/engine/tmux/terminal_ws.rs`、`src/engine/tmux/engine.rs` / `mod.rs` 的 tmux 子进程生命周期管理、本方案落地的健康/监控模块，或排查「tmux 命令报 `server exited unexpectedly` / tmux server 假死 / `tmux -C` 孤儿客户端堆积」前**必读**
> 关联：`docs/dev/debug-patterns/resource-lifecycle.md` 模式 10（父死不杀子）、`docs/dev/plans/archive/2026-09-21-acp-agent-connection-cpu-spin.md`（同类「优雅关闭路径走不到」的结构性缺陷）、commit `344750f`（tmux 控制连接子进程退出后留僵尸——Child 句柄改常驻收割任务，P2-2，只解决「收割」不解决「孤儿」）、`src/acp/agent_proc.rs` `should_kill_group`（kill 前 pid 归属校验先例，P0-2 与之抽共享真源）、`docs/architecture/backend.md`（tmux 引擎冻结边界）、`docs/reference/auth-not-enforced.md`（P1-1 自愈 API 鉴权教训）
> 来源：2026-09-22 凌晨 tmux server（PID 14747，07-28 启动，已运行约 8 周）对所有新 tmux 命令返回 `server exited unexpectedly`，tmuxes 服务（node 进程，8970 端口）`GET /api/targets/local/sessions` 返回 502。当日 00:21 已通过 SIGKILL + 清理 stale socket 恢复，本文为根因报告与修复方案。

## 0. 结论（TL;DR）

1. **不是 tmux 崩溃**：无段错误 / 无 core / 无 OOM，进程在 `poll()` 中正常存活 18 分钟。
2. **触发是一次 SIGTERM（00:03:22，投递方式/来源未确证，见 §3.2）**：tmux 正常进入关闭流程，所有 session 在 1-2 秒内被销毁。（注：`tmux kill-server` 本质也是 server 自体 SIGTERM，journal 证据无法区分投递方式。）
3. **冻结是 tmux 侧缺陷**：`server_client_check_exit()` 要求 control 客户端 `control_all_done()`（待写输出全部刷完）才允许 drop；对输出无法投递（管道读端随父消失、EPIPE 后滞留缓冲无人清理，见 §3.3 与附录 C「Resolved」）的 control 客户端**没有超时**。28 个客户端一个都掉不了 → `server_loop()` 永远不返回 1 → server 永远退不掉，但 `server_exit=1` 已置位 → 进入「半死」：**accept 新连接后立即 close**，所有新 tmux 命令必败。
4. **积因是 omniterm 侧缺陷**：omniterm 实例崩溃（非优雅退出）时，其 `tmux -C` 子进程按 Linux 语义**不会**被杀死（无 PDEATHSIG），`ControlModeClient::stop()`/`Drop` 的清理只覆盖优雅路径。约 4.5 周（08-10~09-11）里多个 omniterm 实例崩塌，积下 **28 个 PPID=1 的孤儿 control 客户端**（挂在 22 个旧 session 上），它们正是卡死关闭流程的元凶。
5. 信号来源**未能确证也不必再追**：omniterm / tmuxes 源码、crontab、shell history 均已排除（见 §3.2，含未排除的盲区声明）。剩下的可能是人工 `tmux kill-server` 或 pane 内 agent 执行——非交互执行不留痕。若复发，先用 eBPF/auditd 捕获再谈。

## 1. 环境

| 组件 | 事实 |
|------|------|
| tmux | 3.4（`/usr/bin/tmux`），server PID 14747，2026-07-28 启动（至事发约 56 天），socket `/tmp/tmux-1000/default` |
| omniterm（事发时唯一在跑） | dev 实例 PID 22659（`target/debug`，09-21 23:07:06 启动，连 `omniterm-dev.db`） |
| omniterm（npm 版） | PID 106111，09-22 00:12:16 启动（事发后才起，其 tmux 客户端一连即被关，全部变僵尸） |
| tmuxes 服务 | node 进程 PID 1725，8970 端口；本身健康，仅因底层 tmux server 假死而 502（**受害者，非根因**） |
| pane 跟踪 | systemd 为每个 tmux 子 pane 建 `tmux-spawn-<uuid>.scope`，journal 可精确回放每个 pane 的生死 |

## 2. 时间线（journal / DB 实证，本机时区）

| 时间 | 事件 | 证据 |
|------|------|------|
| 09-21 22:55–23:02 | tmux pane 正常批量启动（旧 omniterm 实例在铺 agent 终端） | journal `Started tmux-spawn-*.scope - tmux child pane NNNN launched by process 14747` |
| 09-21 23:07:06 | dev omniterm（22659）启动 | `ps lstart` |
| 09-21 23:48 | 最后一个 agent 会话创建（`oh-my-pi_0921-2348`） | `omniterm-dev.db` sessions 表 |
| **09-22 00:03:22–23** | **14 个 pane scope 在 1-2 秒内集中 `Consumed` = `server_send_exit()` 执行 = SIGTERM 到达** | journal（server healthy 时 pane 生死是分散的，集中死亡只可能是主动销毁） |
| 09-22 00:12:16 | npm omniterm 启动，随即生成的 tmux 客户端全部立刻死亡（僵尸）——server 已聋 | `ps`（5 个 `[tmux: client] <defunct>`，父 106111） |
| 09-22 00:14–00:21 | 排查期：`tmux ls` 稳定 5ms 内失败 `server exited unexpectedly`；socket 探针 connect 成功后 0.00s 收到 EOF | 见附录 A |
| 09-22 00:21:12 | 手动 SIGKILL 14747；3 个抗住 SIGHUP 的孤儿 pane（各 17h CPU、9GB 内存峰值）随之退出 | journal（scope `Consumed`） |
| 09-22 00:21:22 | 新 server 自动拉起，tmuxes API 全链路验证通过（200/201/204） | 附录 A |

## 3. 根因链

### 3.1 触发：一次 SIGTERM（00:03:22，来源未确证）

tmux 3.4 `server.c` 的 `server_accept()` 有一个明确分支：

```c
if (server_exit) {
    close(newfd);   /* accept 后立即关闭 */
    return;
}
```

`server_exit` 只由 `server_signal()` 的 SIGINT/SIGTERM 分支置 1。观测到的「连上即 EOF」**只能**由这个分支产生——崩溃的 server 会让 connect 得到 ECONNREFUSED，而不是 accept-then-EOF。配合 journal 的集中销毁记录，SIGTERM 到达时间可确定到 **00:03:22**。（投递方式不可区分：`tmux kill-server` 的实现就是 `kill(getpid(), SIGTERM)` 自杀，与外部 `kill -TERM 14747` 观测等价。）

同时排除「tmux 自身崩溃」：进程 18 分钟里一直在 `poll()`（`wchan: poll_schedule_timeout`）、RSS 64MB、单线程、无任何 dmesg/journal 崩溃记录。

### 3.2 信号来源：未能确证，且**不应继续追查**

已逐一排除：

- **omniterm**：`~/coding/OmniTerm` 全量检索，静态书写唯一的 `kill(pid, SIGTERM)` 调用点是 `src/main.rs:743`（打的是自己 PID file 里的 omniterm server；同函数 :754 另有 `kill(pid, SIGKILL)`，pty 升级链 `src/engine/pty_io.rs` 另经变量发 SIGTERM→SIGKILL）；对 tmux 只有 `tmux kill-session`（单会话，不碰 server）、对 `-C` 子进程 `start_kill()`。其余信号站点：`src/acp/agent_proc.rs:372`（`kill(-(pid), SIGKILL)` 杀 agent 进程组）、`src/engine/tmux/terminal_ws.rs:513/779`（对 tmux attach 客户端 SIGHUP）——**全部信号站点均以自身子进程/进程组或 pidfile PID 为对象，无一以 tmux server 为目标。**
- **tmuxes 服务**：源码无 `kill-server`。
- **crontab / bash history**：无记录。

**排除法盲区（明示，不装作已排除）**：

- **pidfile PID 复用**：`src/main.rs:722-756` 的 `Stop` 与 `dev.sh` 均按记录 PID 直接 kill、无 cmdline 归属校验——pidfile 陈旧 + PID 复用时，SIGTERM 完全可能落到 tmux server 头上。此盲区需 cmdline 校验才能证伪，作为 P1-3 顺手收紧。
- **systemd user 单元/定时器**：未核查（journal 只被用于 pane 生死回放）。

剩余可能：人工执行 `tmux kill-server`，或 pane 内的 agent 执行（非交互 shell 不留 history），或上述盲区。**在没有 auditd / eBPF 的事后环境下无法进一步归因，继续排查是浪费**——本次要修的是「SIGTERM 之后为什么会聋 18 分钟」，不是「谁发的 SIGTERM」。若复发，先上捕获手段再谈归因。

> **取证前提注记**：§3.2 的排除论证以「omniterm 没有任何向 tmux server 发信号的路径」为前提。P1-1 内建自愈（D3）落地后该前提对新版本**永久失效**——未来同类归因须先排除 omniterm 自愈动作（自愈动作必须留结构化日志，作为替代取证线索）。

### 3.3 冻结：tmux 关闭流程对卡死的 control 客户端无超时（tmux 侧缺陷）

tmux 3.4 `server-client.c` 的 `server_client_check_exit()`：

```c
if (c->flags & CLIENT_CONTROL) {
    control_discard(c);
    if (!control_all_done(c))
        return;      /* 待写输出没刷完，永不 EXITED、永不 drop */
}
```

关闭链路：`server_send_exit()` 把全部客户端标记 `CLIENT_EXIT` 并销毁 session（**这一步完成了**——00:03:23 时 14 个 pane 当即死亡）→ 事件循环持续运行，但每个 control 客户端都要等 `control_all_done()` 才被 drop → `clients` 列表永不空 → `server_loop()` 的退出条件（含 `TAILQ_EMPTY(&clients)`）永不满足 → `proc_loop` 永不返回 → 进程在 poll 里**永久挂机**，而 `server_exit=1` 让所有新连接 accept 即 close。

观测完全吻合：事件循环活着（否则新连接不会被 accept 再关），28 个客户端 18 分钟一个未掉。**任何一个输出无法投递的 control 客户端——乃至客户端进程已死、只剩滞留缓冲的 client 结构——就能冻结整个 server 的关闭，且没有超时。**

**机制（2026-09-22 对照 tmux 3.4 `control.c`/`client.c` 逐字核对定论，详见附录 C「Resolved」；本节早期「客户端停止 drain」表述已证伪——client 进程根本不在输出数据路径上：`client_send_identify` `dup(STDOUT)`→`MSG_IDENTIFY_STDOUT` 把 stdout fd 直交 server，`control_start` `bufferevent_new(c->out_fd)` 由 server 直写）**：管道读端随父进程消失后 server 写入得 EPIPE → `control_error_callback` 只置 `CLIENT_EXIT`、不清 `all_blocks`/写缓冲，`control_discard` 也不碰，唯一清理点 `control_stop` 恰被 `control_all_done()` 卡住 ⇒ 死锁闭环、`control_all_done()` 永假；**client 进程死亡冻结照样持续**（残留 client 结构的滞留缓冲无人清）。连带发现 `CONTROL_MAXIMUM_AGE`（300000ms）保险阀只由 pane 输出回调驱动，shutdown 时 pane 已先销毁、永不触发。（就地修正见实施勘误 ③）

次要观察：session 销毁只发 SIGHUP，不升级 SIGKILL——3 个 pane 进程抗住 SIGHUP 作为孤儿又活了 18 分钟（00:21 才退出）。注意 tmux 在 `window_pane_destroy` 里**同步** `close(wp->fd)`（pty master 00:03:23 即已关闭，经 tmux 3.4 源码核对），这 3 个进程 00:21 才退出的**真实触发未确证（不确定）**——本文早期版本曾括注「直至 server 被杀、pty master 关闭才退出」，与源码不符，已勘误（§10）。

### 3.4 积因：omniterm 崩溃路径不收尸，约 4.5 周积 28 个孤儿 control 客户端（omniterm 侧缺陷）

00:14 清点：**28 个 `tmux -C attach-session` 客户端，全部 PPID=1**（原始父进程已死，被 init 收养），启动时间跨度 08-10 至 09-11，分别挂在 **22 个不同的旧 `lt_*` session** 上。它们是历次 omniterm 实例崩塌的遗留：

- Linux 父进程死亡**不会**杀子（无 PDEATHSIG 语义）；
- omniterm 的清理只写在优雅路径上——`ControlModeClient::stop()`（`src/engine/tmux/control_mode.rs:176-220`：关 stdin → 经 reaper 转发强杀 → 有界等退出码回收；344750f 之前的旧实现是「关 stdin → `start_kill()` → `wait()`」，即旧 :114-166）和 `Drop`（:223-244，旧 :169-186）。进程级崩溃 / SIGKILL / panic-abort 时这些根本不执行；
- 每次崩塌留几个，约 4.5 周积出 28 个。注意 commit `344750f` 解决的是「子进程退出后留僵尸」（收割），**不解决「父崩子留」**，两者互补。

### 3.5 天然实验：有 reader 的客户端全部按时退出

事发时 omniterm（22659）自己持有约 7-8 个活客户端（用户侧 UI 观测；无独立佐证——dev 库的 ACP 会话数**不能**作量级佐证：ACP 会话不经 `track_session`，不产生任何 `tmux -C` 客户端，与 control 客户端不是同一总体）。这些客户端的输出有人读（omniterm 的 `reader_loop`），SIGTERM 后全部干净退出——00:14 清点时 PPID=22659 的客户端一个不剩（退出时间上界为 00:14 清点，即 <11 分钟；「几秒内」的说法超出证据强度，已勘误）。**每一个有活跃 reader 的都退了；18 分钟后仍挂着的全部是无主孤儿。** 这基本锁定卡死关闭流程的就是 §3.4 的积奴，排除其他嫌疑。（清点口径注：22659 构建自 344750f 之前，其死客户端经 `ensure_session → stop()` 惰性收割；npm 版 106111 的 5 个僵尸是客户端**进程**已死未收割，与「连接存活」是两回事。）

## 4. 影响面

- 09-22 00:03:22–00:21（约 18 分钟）：所有新 tmux 命令失败（`server exited unexpectedly`）；tmuxes 服务会话列表/创建/删除全 502。
- 所有 session 在 00:03:22 即已销毁（14 个 pane 进程当即死亡，3 个 SIGHUP 幸存进程至 00:21 才退出），但 omniterm UI 在重连前仍显示这些终端——**UI 显示 ≠ 后端存活**。
- 恢复需人工介入（SIGKILL + 清 stale socket）；若无人值守，聋 server 会**无限期**持续。
- 复发条件现成：只要 omniterm 再崩溃几次攒下新的孤儿，任何一次对 tmux server 的 SIGTERM（或任何触发 `server_exit` 的路径）都会重演。

## 5. 修复方案（omniterm 侧）

> 落点约束：P0-1/P0-2/P1-3 按「致命 bug 修复」豁免进 `src/engine/tmux/`（冻结边界「只修致命 bug 不加功能」，`docs/architecture/backend.md`）；P1-1/P1-2 的探测与统计**落引擎无关的健康/监控模块**，不解冻 engine/tmux（决策见 D4）。实施分期：P0-1、P0-2 可并行先行（无依赖）；P1-1 依赖 P0 落地后的谓词/分类函数复用；P1-3 独立小项。预估（粗估）：P0-1 约 0.5 人日、P0-2 约 1 人日、P1-1 约 1.5 人日（含前端）、P1-2 约 0.5 人日、P1-3 约 0.5 人日。

### P0-1 崩溃兜底：`tmux -C` 子进程设置 PDEATHSIG（仅 Linux，不含 pty 路径——D1）

- spawn `tmux -C` 时经 `cmd.as_std_mut()` + `std::os::unix::process::CommandExt::pre_exec` 调 `prctl(PR_SET_PDEATHSIG, SIGKILL)`：父进程死亡时**内核直接杀子**，覆盖 panic/abort/SIGKILL 等 `Drop` 到不了的路径。pre_exec 闭包必须 async-signal-safe（`prctl`/`getppid` 均安全）。
- 三个坑，其中前两条是**并列硬约束，不是二选一**：
  1. PDEATHSIG 语义跨内核有差异（本机 kernel 7.0 实测 = **进程**退出触发；man prctl / kernel.org #43300 / dotnet/runtime#96470 记载 = **创建该子进程的线程**终止时触发）——原文「spawn 在 tokio worker 线程同步执行」的纪律已**升级为结构边界**：fork/exec 固定发生在长寿命 spawn 线程 `omniterm-tmux-spawn`（实施勘误 ①），并**禁止包 `spawn_blocking`**（阻塞池线程空闲约 10s 退役，会在按线程触发的内核上误杀活得好好的客户端），spawn 点留 VERIFIED 注释（`docs/workflows/integration-checklist.md` A.2）；
  2. `pre_exec` 内 `getppid()` 复查（已变则自行退出）单列，只覆盖 fork→prctl 之间的父**进程**死亡竞态，**不能替代**约束 1；
  3. 平台边界：`prctl(2)` 仅 Linux——`#[cfg(target_os = "linux")]` 门控，macOS/Windows 无等价机制，由 P0-2 启动对账兜底（覆盖率差异见风险表，沉淀进 `docs/architecture/backend.md`，工程准则 8）。
- **pty 子进程不做 PDEATHSIG（D1 决策）**：pty 直接子进程是用户 shell、agent 是其子孙；父死时 pty master 全关本就触发 pty(7)「SIGHUP 到前台进程组」的可捕获挂断，SIGKILL 同办等于把可收尾挂断升级为不可捕获强杀；且 `portable_pty::CommandBuilder`（`src/engine/pty/session.rs:42-47`）无 `pre_exec` 钩子，按现状 API 不可行。
- 被子仍需被收割——与 `344750f` 的常驻收割任务兼容（PDEATHSIG 只在父进程/线程死亡时触发，此时 reap 任务已随进程消亡；存活期子进程被杀仍由 `reap_child` 的 `select!(child.wait(), …)` 恰好收割一次），不冲突。
- 改动文件：`src/engine/tmux/control_mode.rs`（`spawn_client`，把 pre_exec 放进假客户端测试 seam 内，让测试同样覆盖）。

（已实施，偏差见文末「实施勘误」①②⑳。）

### P0-2 启动对账：pidfile 登记 + 清理上一实例残留（载体见 D2）

- 登记载体：`~/.omniterm/` 下 pidfile 类登记文件，命名 `<BRANCH_BINARY_NAME>-<instance-pid>.clients`，tmp + rename 原子写；启动时扫描本 stem 下**全部**登记文件（覆盖上一实例与其他实例残留），优雅退出时删除自己的文件；其登记进程全部消亡的孤儿文件超期回收。不落 DB（D2 否决项）。
- 登记内容：每个 control 客户端 `(pid, spawn_ppid, /proc/<pid>/stat starttime)` 三元组 + 目标 session。（已实施：starttime 落为平台抽象 `start_key`——Linux=stat starttime tick / 其余 Unix=ps lstart 文本 / Windows=sysinfo start_time 秒，见实施勘误 ㉖）
- 启动对账 kill 谓词（**与 `src/acp/agent_proc.rs:333-345` `should_kill_group` 抽共享真源**，工程准则 7①——同型「防 PID 复用误杀」校验 ≥2 处）：
  - `/proc/<pid>/cmdline` **argv 结构化相等** `argv[0..2] == ["tmux", "-C"]`（拒绝子串匹配，防 `vim 'tmux -C.md'` 之类误配）；
  - 当前 ppid **≠ spawn_ppid**（替代「PPID=1」判据——孤儿可能被 subreaper 收养而非 init，PPID=1 判据会漏杀）；
  - `/proc/<pid>/stat` starttime 未变（PID 复用检测）。
  - kill 走 `pidfd_open` + `pidfd_send_signal`（内核级免疫 PID 复用，收口 check-then-kill 的 TOCTOU）；非 Linux 回退 `kill(2)` + 谓词复查。
- 登记表上限（P1 三问显式回答）：
  - **上限**：`MAX_TRACKED_CLIENTS` 命名常量（数值实施时定，禁散落魔法数字）；
  - **超限策略**：先清已死条目，仍超限则拒登新 spawn 并 `tracing::warn` 降级（父死场景已由 P0-1 兜底，登记缺失不构成泄漏）；
  - **守上限的单测**：构造超上限登记，断言长度恰为上限且超限项被拒（验收 §9）。
- 增删对称性（审查指出的累积点）：`SessionActivityMonitor::ensure_session`（`src/engine/tmux/control_mode.rs:370-398`）死连接重建路径在替换登记条目时**先注销旧条目**，注销不只挂 `stop`/优雅退出——否则实例内死条目滞留累积。
- 「优雅退出时注销」挂**显式 shutdown 路径**而非 `Drop`（axum 关闭是否 drop `AppState` 未验证，见风险表）；即便注销失败，启动对账天然幂等，可重复收敛。

（已实施，落点 `src/engine/tmux/client_registry.rs` + `src/process_identity.rs` + `src/main.rs` Start/Stop 接线；注销实挂 spawn/reap/stop 三路径，测试 fixture 坑见「实施勘误」⑳。）

### P1-1 聋 server 检测与自愈（探测/分类落引擎无关模块，D4；自愈归属见 D3）

- 健康探测：周期探针（`DEAF_PROBE_INTERVAL` / `DEAF_CONFIRM_COUNT` 命名常量），可与既有 `agent/watch.rs` 的周期 tmux 观测合并评估，避免再造一条周期 spawn 链（工程准则 4/7①）。（已评估：**不合流**——30s vs 1s 节奏不同，且避免耦合进引擎 watch 链，见实施勘误 ⑱）
- **失败语义四态分类**，独立分类函数（`Healthy / NoServer / Deaf / Other`）：
  - `no server running` = `NoServer`（正常空态，首条命令自动拉起新 server）；
  - `server exited unexpectedly` 或 connect 成功后立即 EOF = `Deaf`（本次事故签名）；
  - EACCES / socket 属主冲突 / tmux 缺失 / psmux 等其余失败 = `Other`，**一律不触发自愈**（误分类的尾部风险是 SIGKILL 健康 server、毁掉全部 tmux 会话与运行中 agent）。
  - 同步收窄 `src/engine/tmux/mod.rs:208` 的空 stdout 兜底：stderr 含聋签名时**不得**归「无会话」（现 `list_sessions` 会把聋签名吞成空态，探测若复用此路径即 S2 吞异常）。
  - 多实现差异显式写明并沉淀 `docs/architecture/backend.md`：psmux 空 stdout 即当无会话（`mod.rs:207` 注）、Windows 行为（未验证，标注「不确定」）。
- 自愈动作（omniterm 内建，D3）流程钉死：
  1. 连续 `DEAF_CONFIRM_COUNT` 次 `Deaf` → 前端告警 + 「重建 tmux server」按钮；
  2. 后端处理：**单飞互斥**（并发触发只执行一次；锁**先于**重探针取得——「第二次触发立即 in_progress」与「全程持锁」才能同时成立，原文 a→b 顺序不成立，见实施勘误 ⑧）→ **重探针确认聋签名仍成立**（防陈旧状态触发）→ **socket inode 反查 server PID**（deaf server 不响应 `display-message`：`/proc/<pid>/fd` → `socket:[inode]` 与监听 socket 反查）→ SIGKILL → 删 stale socket → 下一条命令自动重建。
- 幂等论证：步骤 2 的「重探针 + 单飞」保证并发双击/多标签重复触发不会命中已自动重建的**健康新 server**；动作全程结构化日志（供 §3.2 类归因——取证前提已被本动作破坏，日志是替代线索）。
- 若做成 API 端点必须挂 `require_auth_mw`（S4/S5，参照 `docs/reference/auth-not-enforced.md` 教训）。
- 术语：**聋 server（deaf server）**= `server_exit=1` 且事件循环存活、accept 后立即 close 的半死态（P2-1 上游 issue 复用同一措辞）。

（已实施，落点 `src/health/{mod,classify,probe,heal}.rs` + `src/api/tmux_health.rs` + `frontend/src/components/TmuxHealthAlert/`；偏差见「实施勘误」⑧–⑳、㉑–㉓。）

### P1-2 孤儿堆积监控（引擎无关模块，D4）

- 周期统计满足「当前 ppid ≠ spawn_ppid ∧ argv 结构化匹配 `tmux -C`」（**与 P0-2 同一谓词真源**）的客户端数量。原文另要求的「socket 归属本机 tmux server 反查」（`/proc/<pid>/fd` → `socket:[inode]` 与 server 监听 socket 配对）**实测不可实现**——`/proc/net/unix` 已连接客户端侧条目无 Path（实施勘误 ④），统计范围收窄为本机全部 `tmux -C` 客户端；未登记进程按 ppid==1 近似判据（被 subreaper 收养的会漏计，只少计不误计）。
- 超 `ORPHAN_WARN_THRESHOLD` 命名常量记 `tracing::warn`（前端提示**不走**原定的 chat system 消息通道——改为 `GET /tmux/health` 的 `orphan_count` 字段 + 前端全局横幅提示，理由见实施勘误 ㉕）——这是 tmux server 进入「一 SIGTERM 就假死」高危状态的先兆指标。

（已实施，落点 `src/health/orphan.rs`；偏差见「实施勘误」④⑭⑮⑲㉕。）

### P1-3 pidfile kill 归属校验统一（小项）

- `src/main.rs:722-756` 的 `Stop` 与 `dev.sh` 的 pidfile kill 补 cmdline 归属校验（与 P0-2 同一谓词真源），封掉 §3.2 的 PID 复用盲区。

（已实施，偏差见「实施勘误」⑤⑥⑦。）

### P2-1 tmux 上游

- 向 tmux 提 issue：control 客户端输出无法投递（管道读端随父消失）后 `control_all_done()` 永假、且无超时导致 shutdown 永久挂起（3.4 仍存在）；建议有界等待后强制 drop。可附本例完整证据（journal 时间线 + 源码路径 + §3.3 机制[已定论，见附录 C]）。草稿见附录 C，截至实施批次结束**尚未提交**上游。
- 记录备用规避：若上游不接受，评估 omniterm 侧对孤儿客户端超时后主动 `kill -9`（P0-1/0-2 落地后此需求应自然消失）。

## 6. 设计决策（ADR）

### D1 pty 子进程不做 PDEATHSIG，保留 pty(7) SIGHUP 收尾（用户拍板 2026-09-22）

- **决策**：PDEATHSIG 只落 `tmux -C` 路径；pty（用户 shell/agent）不动。
- **理由**：① `portable_pty::CommandBuilder` 无 `pre_exec`，按现状 API 不可行；② 父死时 pty master 全关触发 pty(7) 可捕获 SIGHUP，用户 shell/agent 有收尾机会，SIGKILL 会剥夺之；③ pty 场景的「孤儿」由 SIGHUP 语义自然覆盖大半。
- **否决项**：改造 pty spawn 绕过 portable_pty 加 SIGKILL（产品语义损失 + 改动面大）。
- **翻盘条件**：确证 SIGHUP-ignoring 的 pty 孤儿真实堆积（P1-2 监控可见），且用户拍板「父死强杀用户终端」的产品语义。

### D2 登记表载体 = `~/.omniterm/` pidfile 类登记文件（用户拍板 2026-09-22）

- **决策**：按 `<BRANCH_BINARY_NAME>-<instance-pid>.clients` 命名、tmp+rename 原子写，启动扫描 stem 下全部文件。
- **理由**：DB 按 `--db` 实例隔离（配置统一管理），只能对账「同分支库上一实例」的残留——本次事故主体 28 个孤儿横跨多个实例，DB 对账**覆盖不到**；pidfile 可跨实例共享扫描，对账覆盖面匹配真实问题。
- **否决项**：DB 表（跨实例残留永远不进对账范围，只能靠 P1-2 监控兜底；另引 migrations 义务）。
- **翻盘条件**：并发实例互不误伤/孤儿文件回收在实施中被证明不可靠（参照 `resource-lifecycle.md` 模式 9 的 PID 文件教训），或登记量超过文件可承载规模（`MAX_TRACKED_CLIENTS` 上限内不会）。

### D3 自愈动作内建于 omniterm（用户拍板 2026-09-22，推翻审查者「脚本+告警」建议）

- **决策**：P1-1 做成 omniterm 内建动作（前端按钮 + 后端 API），按 §5 流程钉死。
- **理由**：无人值守场景下聋 server 无限期持续（§4），检测与恢复必须同闭环才能自愈；手动脚本在无人值守下等于没有。
- **否决项**：`scripts/` 手动脚本 + omniterm 告警（与「勿开先例」措辞最自洽，但用户体验断裂、无人值守不可用）——**§6 第一条据此收窄**，并接受 §3.2 取证前提对新版本失效（用结构化日志补位）。
- **翻盘条件**：出现**一次**「自愈动作误杀健康 server」事故 → 立即降级为脚本 + 告警（D3 翻盘），并复盘分类函数为何失守。

### D4 P1-1/P1-2 探测与统计落引擎无关的健康/监控模块（用户拍板 2026-09-22）

- **决策**：`docs/architecture/backend.md` 的 tmux 引擎冻结边界（「只修致命 bug 不加功能」）不解冻；P0-1/P0-2/P1-3 按致命 bug 豁免进 `src/engine/tmux/`，P1-1 探测/分类与 P1-2 监控落引擎无关模块（复用引擎抽象出口，不改引擎行为）。
- **理由**：冻结边界是既有架构约定（工程准则 3），本次没有解冻的必要——探测/统计不需要引擎内部新功能。
- **否决项**：直接在 `src/engine/tmux/` 内加健康探测与监控功能（违反冻结约定）。
- **翻盘条件**：健康模块与 engine/tmux 耦合被证明无法避免（如分类必须读引擎内部状态）→ 按工程准则 1① 请示解冻并留痕。

## 7. 风险与降级

| 风险 | 缓解 | 兜底 | 翻盘条件 |
|------|------|------|----------|
| PDEATHSIG 线程误触发（spawn 线程退出杀掉活客户端） | P0-1 硬约束 1（已升级为长寿命 spawn 线程 `omniterm-tmux-spawn` 结构边界 + 禁 `spawn_blocking` + VERIFIED 注释，实施勘误 ①） | §9 反向断言「线程死亡不误杀」守门 | 出现误杀即回退 PDEATHSIG，P0-2 升主防线 |
| 非 Linux 无 PDEATHSIG | P0-2 启动对账为主防线 | P1-2 孤儿监控可观测堆积 | —（平台差异写入 backend.md） |
| 自愈误杀健康 server | 四态分类 + `Other` 不动作 + 重探针 + 单飞互斥 | 「健康 server 不得被命中」验收用例 | 出现一次即降级脚本（D3 翻盘） |
| 登记表 kill 误杀（PID 复用） | pidfd + 三元组谓词 + argv 结构化相等 | 与 `agent_proc` 共享真源单测 | — |
| 登记表超限拒登 | 超限先清死条目 + WARN 降级 | 父死场景由 P0-1 兜底，登记缺失不泄漏 | — |
| 优雅退出注销不可靠（axum 关闭是否 drop `AppState` 未验证） | 注销挂显式 shutdown 路径 | 启动对账天然幂等、可重复收敛 | — |
| 客户端输出无法投递后滞留缓冲无人清理的死锁机制（已定论，见 §3.3 与附录 C「Resolved」） | P2-1 上游 issue 附证据推动修复 | P1-1 自愈覆盖症状（聋 server 可恢复） | — |

## 8. 明确不做的事

- **除 P1-1 自愈动作显式点名的 SIGKILL（仅限重探针确认的聋 server）外，不新增任何向 tmux server 发信号的路径**（现状没有，勿开先例；该例外对 §3.2 取证前提的影响见该节注记）。
- **不给 pty 子进程加 PDEATHSIG**（D1）。
- **不继续追查 SIGTERM 来源**（§3.2：无审计条件下不可证，复发时先上 eBPF/auditd）。
- **不改 tmuxes 服务**（独立项目，本次只是受害者）。
- **不把计划外手动清理 `/tmp/tmux-*` 残留 socket 当常规方案**——那是症状清理；对账（P0-2）与自愈（P1-1）落地后不再需要。

## 9. 验收标准

- [x] PDEATHSIG 生效（集成/单测，沿 `#[cfg(test)]` + 假客户端 seam——`spawn_client` 是私有，`tests/` 走公有 `new()` 需真 tmux server，形态对齐 `344750f` 先例）：spawn 受管理的 `tmux -C` 子进程 → SIGKILL 父进程 → 子进程在约定时限内消失；**OS 真值断言** `/proc/<pid>/status` 的 `PDeathSig: 9` 字段（integration-checklist A.1，不只看死活）。→ 落地 `control_mode.rs` 回归 `pdeathsig_kills_child_when_parent_process_dies`（真进程 e2e）+ `pdeathsig_os_truth_pdeathsig_field_is_sigkill`；**`PDeathSig` 字段受内核配置门控（本机未导出）⇒ 该字段断言降级为「存在则断言 = 9、缺失以父死杀子 e2e 行为断言为准」**（实施勘误 ②）。
- [x] **反向断言（PDEATHSIG 线程误触发）**：spawn 线程退出而进程存活 → 子进程必须存活（起独立线程 spawn 后 join，观察子进程）。→ `pdeathsig_child_survives_spawning_thread_exit`；且因 fork/exec 固定长寿命 spawn 线程（实施勘误 ①），本断言按字面成立为结构保证。
- [x] 收割不回归：被测子进程仍由既有常驻收割任务恰好回收，不引入新僵尸。→ `pdeathsig_child_is_still_reaped_exactly_once`。
- [x] 登记表：记录 spawn 的 PID 三元组；启动对账杀掉谓词全通过的残留；starttime 已变（PID 复用）的条目被安全跳过不误杀；**超限用例**（构造超 `MAX_TRACKED_CLIENTS` 登记，断言长度恰为上限 + 超限项被拒 + WARN）。→ `client_registry.rs` 测试：`register_deregister_roundtrip_writes_file_atomically` / `reconcile_kills_fully_matching_orphan` / `reconcile_skips_pid_reuse_without_killing` / `registry_cap_rejects_overflow_after_pruning_dead`（另含活跃父保留、argv 误配拒绝、孤儿文件回收）。
- [x] 单测：四态分类（`server exited unexpectedly` ≠ `no server running` ≠ `Other`）；`src/engine/tmux/mod.rs:208` 空 stdout 兜底收窄（stderr 含聋签名不得归空态）。→ `health/classify.rs` 测试组（`four_states_are_pairwise_distinct` / `deaf_signature_with_empty_stdout_is_not_empty_state` 等）；判定纯函数落 `health/classify.rs`、`list_sessions` 反向依赖之（实施勘误 ⑰⑩）。
- [x] 自愈动作：「健康 server 不得被命中」防护用例；并发触发单飞用例（第二次动作不命中已重建的新 server）。→ `health/heal.rs` 测试组（`heal_refuses_when_reprobe_not_deaf` / `heal_single_flight_rejects_concurrent_trigger_immediately` / `heal_kills_verified_owner_removes_socket_then_refuses_rebuilt_server` / `heal_aborts_without_killing_when_owner_identity_mismatched`）。
- [x] 前端：告警 + 「重建 tmux server」按钮功能回归；实施时过 `frontend-patterns` / `ui-style-guide` / i18n 双 locale（P1-1 含 UI）。→ `frontend/src/components/TmuxHealthAlert/`（13 用例：告警阈值/四态表现/409 两分支/防双击/轮询生命周期）+ zh/en 双 locale；UI 形态为 App 级横幅（实施勘误 ㉑）。
- [x] 手动回归：`docs/reference/user-testing.md` 补一条「假死检测 + 重建 server」流程。→ 本次文档闭环补入 §19（含私有 socket 实验护栏与 macOS/Windows 降级已知限制）。
- [x] spawn 点 VERIFIED 注释（integration-checklist A.2）。→ `control_mode.rs::spawn_client` 文档注释（含 kernel 7.0 实测口径与线程边界说明）。
- [x] `cargo fmt/clippy`、`tsc -b`、前端 lint/test 零新增警告；pre-commit 通过。→ 五笔提交均经 pre-commit 门禁（fmt/clippy/tsc/lint/前端测试）落库。
- [x] 实施后按惯例在 `CHANGELOG.md` 补条目（属实质性修复），并把 Phase 进展/偏差就地以「勘误」块回写本文；文档闭环：`docs/architecture/backend.md` 补 spawn 生命周期（PDEATHSIG 行为）、平台/psmux 多实现差异表、健康/监控新模块条目（若届时改选 DB 表载体，则 `migrations/` 新文件按「新增即登记」处理——D2 已否决，默认无）。→ `CHANGELOG.md` [Unreleased] Fixed 条目、本文「实施勘误」章、`docs/architecture/backend.md`（Source Tree 四条目 + control-mode 生命周期/登记表/健康自愈/收窄四小节 + 多实现/平台差异表 + API 两行）、`docs/architecture/frontend.md`、`docs/reference/user-testing.md` 均已闭环；载体仍为 pidfile 类登记文件，无新 migration。

## 10. 审查勘误（2026-09-22 独立子代理审查产出，已就地修正）

1. `control_mode.rs` 行号/行为描述按 `344750f` 后现状更正（旧 :114-166 / :169-186 → 现 `stop()` :176-220 / `Drop` :223-244；行为「关 stdin → `start_kill()` → `wait()`」→「关 stdin → 经 reaper 转发强杀 → 有界等退出码」）。原文引用的是 344750f 之前的实现，入库时即失效。
2. `src/main.rs:739` → **:743**（书写时即错）；「唯一的 `libc::kill(pid, SIGTERM)`」断言收窄为「静态书写唯一的 `kill(pid, SIGTERM)` 调用点」并补枚举 `agent_proc.rs:372` killpg、`terminal_ws.rs:513/779` SIGHUP、`pty_io.rs` 升级链。结论不变。
3. §3.3/§4 的「pane 已死光」「3 个 pane 直至 server 被杀、pty master 关闭才退出」机制括注经 tmux 3.4 源码核对**不成立**（`window_pane_destroy` 同步 `close(wp->fd)`，master 00:03:23 即关）——3 个幸存进程 00:21 退出的真实触发标注「未确证（不确定）」。
4. §3.5「11 个活跃 ACP 会话，量级吻合」系类别错配（ACP 会话不经 `track_session`，不产生 `tmux -C` 客户端），已删；「几秒内就干净退出」超出证据强度，改为「退出时间上界为 00:14 清点」。
5. 附录 A 探针命令引号错误（`\$` 导致 python 收到字面 `$(id -u)`）修正；「正常 server 会先发版本行」与 tmux 握手方向不符，判据改为「立即 EOF = 聋 server；阻塞无输出 = 正常」。
6. 时间口径统一：「六周」→「约 4.5 周（08-10~09-11 的积累期）」；「55 天」→「约 8 周（至事发约 56 天）」。`docs/dev/debug-patterns/resource-lifecycle.md` 模式 10 案例行同步。
7. §6「不向 tmux server 发信号」与 P1-1 自愈的自相矛盾按 D3 收窄解决（自愈 SIGKILL 为唯一显式例外）。
8. §3.2 补排除法盲区声明（pidfile PID 复用、systemd user 单元）；「外部 SIGTERM」措辞改「一次 SIGTERM（来源/投递方式未确证）」——`tmux kill-server` 本质是 server 自体 SIGTERM。
9. PDEATHSIG 平台缺环（Linux-only）与坑①「`getppid()` 复查不能替代长寿命线程约束」补入 P0-1；登记表 P1 三问、kill 谓词三元组/pidfd、验收反向断言等按审查 major 补入 §5/§7/§9。

## 11. 附录 A：关键证据与诊断命令（复现检测用）

```bash
# 1) 聋 server 签名：新客户端连上即被关（5ms 内失败，稳定复现）
tmux ls                       # → server exited unexpectedly
# 探针：connect 成功后立即 EOF = 聋 server；阻塞无输出 = 正常
# （tmux 握手由客户端先发，server 不主动发版本行）
python3 -c "import os,socket;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/tmux-%d/default'%os.getuid());print(s.recv(100))"

# 2) 区分「进程死了」与「进程半死」：fds 里 LISTEN + 一堆 ESTAB，但新连接被拒
ls -la /tmp/tmux-$(id -u)/    # socket 文件在
lsof -p <server_pid> | awk '$5=="unix"'   # 有 LISTEN、有 ~29 条 ESTAB
pgrep -af 'tmux -C'           # 孤儿客户端仍在（注意 ppid）
ps -o pid,ppid,lstart,cmd -p <pids>        # PPID=1 + 启动时间远早于事发 ⇒ 孤儿

# 3) SIGTERM / session 销毁的精确时刻（systemd 为每个 pane 建 scope）
journalctl --since "2026-09-21 20:00" --until "2026-09-22 01:00" | grep tmux-spawn
# "Started" = pane 诞生；集中出现的 "Consumed" = session 被批量销毁

# 4) tmux 退出条件（源码路径，3.4）
# server.c:            server_accept() 的 if (server_exit) close(newfd)
# server.c:            server_send_exit() / server_loop() 退出条件含 TAILQ_EMPTY(&clients)
# server-client.c:     server_client_check_exit() 的 control_all_done() 无超时
# window.c:            window_pane_destroy() 同步 close(wp->fd)（pty master 随销毁即关）
```

## 12. 附录 B：本次恢复动作记录（已完成，勿重复执行）

09-22 00:21 对 PID 14747 `SIGKILL`（SIGTERM 无效——它已在退出流程里卡死）；28 个孤儿客户端随 server 死亡全部自然退出；验证 tmux 自动清理 stale socket 并重建 server（create/list/kill session 全通过）；tmuxes API 端到端验证（GET 200 → POST 201 → DELETE 204）；清除 5 个确认无服务的残留 socket（`mansio-*`、`sshleak*`）。遗留：5 个僵尸进程待 omniterm（106111）退出时回收，无害。

## 13. 附录 C：tmux 上游 issue 草稿（P2-1）

> 状态：**草稿，尚未提交**至 tmux/tmux（P2-1 落地时整段复制正文提交）。
> 证据出处：本文 §2 / §3 / §11（附录 A）实证记录，无外部来源。
> **源码引用经事故分析核对（tmux 3.4）**——两轮校验（源码核对 + 独立子代理审查）；代码块内注释为本文作者标注、非上游原文注释（issue 正文中以英文标注呈现并声明）。
> 「Known unknown」一节照 §3.3「机制断点」原话转写为英文 open question，未添加任何结论。（**2026-09-22 更新**：该 open question 已取 tmux 3.4 `control.c`/`client.c` 真源逐字核对**定论**，正文对应小节改写为 Resolved；唯 `server_send_exit` 是否直发 MSG_SHUTDOWN 一点仍如实标注为推断/待核。）
> 措辞约束：SIGTERM 投递来源/方式未确证（§3.2），正文只写 "a SIGTERM"，**不得**写成 kill-server。

**拟用标题（Suggested title）**：

```
Shutdown hangs indefinitely when a control-mode client's output becomes undeliverable: server_client_check_exit() waits on control_all_done() with no timeout
```

**正文（以下内容可整体复制为 issue body）**：

---

### Summary

On tmux 3.4 (Linux), after the server receives SIGTERM it enters a normal shutdown (`server_send_exit()` destroys all sessions), but shutdown then freezes indefinitely as soon as **any** control-mode (`tmux -C`) client has undeliverable pending output — e.g. the read end of the pipe behind the client's stdout fd disappears when the client's parent process dies: `server_client_check_exit()` only drops a `CLIENT_CONTROL` client once `control_all_done()` is true, once delivery has failed `control_all_done()` can never become true again (a closed loop — see Analysis), and there is **no timeout**. Because `server_loop()`'s exit condition (which includes `TAILQ_EMPTY(&clients)`) can then never be satisfied, the process never exits, while `server_exit=1` is already set — so `server_accept()` accepts and immediately closes every new connection and **all** new tmux commands fail with `server exited unexpectedly` (a half-dead "deaf server": the socket is up, the event loop is alive, and nobody can use it). We observed this frozen for the full ~18 minutes of our incident (00:03:22 → 00:21:12) with zero progress before we resorted to SIGKILL. With no timeout in the gate, the wait is unbounded.

### Steps to reproduce

Minimal shape, abstracted from our incident's diagnostic commands (see Additional evidence; we did not run a clean-room scripted repro — the mechanism below is established from tmux 3.4 source, see Analysis and the resolved question):

1. Start a server with a session: `tmux new-session -d -s s1 'sleep 3600'`
2. Start one or more control-mode clients on it with their stdout attached to a pipe whose read end you control (`tmux -C attach-session -t s1 > <pipe>`) — then make at least one client's pending output **undeliverable** by removing the read end of that pipe (e.g. kill the process that reads the client's stdout) while the server still has output queued for it. In our incident this happened to orphaned `tmux -C` clients whose parent process had died (Linux does not kill children on parent death). **A single such client is enough to freeze shutdown (N = 1 suffices).**
3. Send SIGTERM to the server process.
4. Observe:
   - all sessions/panes are destroyed within 1–2 s (`server_send_exit()` runs to completion);
   - the server process never exits — in our incident it stayed in `poll()` for ~18 minutes;
   - `tmux ls` fails every time, within a few ms, with `server exited unexpectedly` (stable: every attempt, ≤5 ms in our measurements);
   - a raw probe of the server's socket connects successfully and then receives EOF immediately (accept-then-close, not ECONNREFUSED):

     ```sh
     python3 -c "import os,socket;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/tmux-%d/default'%os.getuid());print(s.recv(100))"
     ```

### Expected behavior

Shutdown completes: the server waits a **bounded** time for control clients to flush their pending output, then force-drops them (discarding whatever remains), so `server_loop()` returns and the process exits — instead of letting one wedged client block the exit path forever.

### Actual behavior

Shutdown hangs indefinitely (we observed the full ~18 minutes until we gave up; nothing in the code path suggests it would ever stop). `server_loop()` / `proc_loop` never return. Meanwhile `server_exit=1` makes the server reject every new command with `server exited unexpectedly`, so a live server is unusable and appears as a persistent outage. At that point SIGTERM is useless (the process is already wedged inside its exit path); only SIGKILL recovers it, after which tmux cleans up the stale socket itself and the next command auto-spawns a fresh server.

### Analysis

Source quotes below were verified against tmux 3.4 during our incident analysis (源码引用经事故分析核对（tmux 3.4）); they are abridged to the relevant branches, and comments in the code blocks are our annotations, not upstream comments.

1. **Why every new command fails (`server_exit=1` half-dead state).** `server.c`, `server_accept()`:

   ```c
   if (server_exit) {
       close(newfd);   /* accept, then immediately close */
       return;
   }
   ```

   `server_exit` is set to 1 by the SIGINT/SIGTERM branch of `server_signal()`. The connect-ok-then-EOF signature we observed can only come from this branch (a crashed server would give ECONNREFUSED at connect time). Together with the journal's record of sessions being destroyed en masse, this pins the SIGTERM arrival time (in our incident: 00:03:22). `server_send_exit()` marks all clients `CLIENT_EXIT` and destroys all sessions — **that part completes**: all 14 panes died within 1–2 s of the signal.

2. **Why the process never exits (`control_all_done()` gate has no timeout).** `server-client.c`, `server_client_check_exit()`:

   ```c
   if (c->flags & CLIENT_CONTROL) {
       control_discard(c);
       if (!control_all_done(c))
           return;      /* pending output not flushed: never EXITED, never dropped */
   }
   ```

   Shutdown chain: `server_send_exit()` (done) → the event loop keeps running, but each control client is only dropped once `control_all_done()` becomes true → for a client whose output delivery has failed (EPIPE once the pipe's read end is gone), that never happens (see item 4) → the `clients` list never empties → `server_loop()`'s exit condition (server.c, includes `TAILQ_EMPTY(&clients)`) never holds → `proc_loop` never returns → the process sits in `poll()` forever while `server_exit=1` closes every new connection on accept. Our observations match exactly: the event loop was alive (new connections were being accepted-then-closed), and none of 28 stuck clients dropped in 18 minutes. **A single control client with undeliverable pending output freezes the entire server's shutdown, with no timeout.**

3. **pty timing (included for clarity).** `window.c`, `window_pane_destroy()` synchronously `close(wp->fd)`, i.e. pty masters are closed at session-destroy time (verified against tmux 3.4 source). We mention this only because our own first write-up of this incident wrongly guessed that surviving pane processes exited "when the server was killed and the pty master closed" — that mechanism does not hold; the real trigger for their later exit is unestablished on our side.

4. **Why a wedged control client can never be dropped — the closed loop (tmux 3.4 `control.c` / `client.c`, checked line-by-line, 2026-09-22).**（勘误括注：incident report §3.3 及本稿早期的「客户端停止 drain」/"stops draining" 表述不准确——the client never drains its output at all, since it hands its stdout fd to the server at identify time；准确机制是「管道读端消失 → EPIPE 后未清缓冲被 `control_all_done()` 无限追认」。）First, the output data path never crosses the client process: `client.c`, `client_send_identify()` does `dup(STDOUT_FILENO)` → `proc_send(MSG_IDENTIFY_STDOUT, fd, …)`, and `control.c`, `control_start()` sets `cs->write_event = bufferevent_new(c->out_fd, …)` — the server writes control output **directly to that fd** (in our incident: the pipe into our session manager). The pieces:

   - `control.c`, `control_all_done()` is `TAILQ_EMPTY(&cs->all_blocks)` **and** `EVBUFFER_LENGTH(cs->write_event->output) == 0` — the pending block queue *and* the write buffer must both be empty.
   - `control.c`, `control_error_callback()` (error callback of both the read and the write bufferevent) only does `c->flags |= CLIENT_EXIT;` — it clears **neither** `all_blocks` **nor** `write_event->output`.
   - `control.c`, `control_discard()` (called from `server_client_check_exit()`) only frees per-pane blocks and stops the read event — it also touches neither. The single cleanup point, `control_stop()`, runs at client teardown — exactly the step that is blocked by `control_all_done()`.
   - ⇒ once the pipe's read end is gone, later server writes get EPIPE → the error callback sets `CLIENT_EXIT` only → the undelivered bytes in `all_blocks` / the write buffer can never be cleared → `control_all_done()` is false **forever** → `server_client_check_exit()` `return`s forever → the client is never dropped → `server_loop()` never returns. It is a closed loop: no reachable code path clears those buffers after a delivery failure.
   - The freeze is independent of the client **process** being alive: if the control client process itself dies, the socket error callback likewise only sets `CLIENT_EXIT`, so the leftover `client` struct with its uncleared output buffer still blocks shutdown. What wedges the exit path is a buffer-holding `client` struct, not a live process.
   - The existing safety valve does not fire when it is most needed: `control_check_age()`'s `CONTROL_MAXIMUM_AGE` (300000 ms) "too far behind" auto-exit is driven only by pane output callbacks (`control_write_output` / `control_write_pending`) — during shutdown, sessions/panes are destroyed first (item 1), so the valve is never triggered in exactly the situation it would cover.

### Resolved: the client-side mechanism (formerly an open question; tmux 3.4 source checked line-by-line, 2026-09-22)

The question as originally framed — *why does the `tmux -C` client stop draining but not exit after its parent dies?* — rested on a wrong premise (our earlier "stops draining" wording; see the erratum note in Analysis item 4): **the client process is not on the output data path at all** — it hands its stdout fd to the server at identify time (`client_send_identify()`), and the server writes to that fd directly (`control_start()`). With that corrected, both halves of the question are explained from source:

- **Source-verified (checked line-by-line against tmux 3.4 `control.c` / `client.c`, 2026-09-22)**: (a) *why pending output is never accounted as flushed* — the closed loop in Analysis item 4: `control_error_callback()` and `control_discard()` clear neither `all_blocks` nor `write_event->output`, and the only cleanup point (`control_stop()`) is the very step blocked by `control_all_done()`; (b) *why the client process lingers* — `client.c`, `client_main()`'s main loop is `proc_loop()` waiting for server messages, and the client exits on teardown notifications (MSG_EXIT / MSG_SHUTDOWN via `client_dispatch_wait` / `client_dispatch_attached`); with the server's teardown stuck, those never arrive. This matches our observation (client processes still alive 18 minutes later).
- **Inference, not line-checked (stated honestly, not over-asserted)**: whether `server_send_exit()` ever attempts to broadcast MSG_SHUTDOWN directly has **not** been checked against `server.c` line-by-line. We leave that one point open-but-immaterial: whatever that path does, the closed loop in Analysis item 4 keeps shutdown frozen.

### Suggested fix

Any fix must break the closed loop in Analysis item 4 — i.e. give the shutdown path a way to clear (or stop waiting on) `all_blocks` + `cs->write_event->output` for a client whose delivery has failed. In decreasing order of directness:

1. **Bounded wait in `server_client_check_exit()` (primary suggestion)**: during shutdown, wait a bounded time for `control_all_done()`, then force-teardown the client through `control_stop()` (the only path that frees `all_blocks` and the write bufferevent) / drop it, discarding any remaining pending output. Discarding is safe here: delivery has already failed (EPIPE), the sessions are already destroyed, and the recipient side is gone — those bytes cannot reach anyone.
2. **Clear the buffers on delivery failure**: let `control_error_callback()` (or the `server_exit` branch of `server_client_check_exit()`) drop `all_blocks` and `cs->write_event->output` once the output side is known dead, so `control_all_done()` can become true naturally. (Scope this to shutdown / permanent delivery failure, so a transient write error cannot silently lose live output.)
3. **Make the existing safety valve fire during shutdown**: `control_check_age()`'s `CONTROL_MAXIMUM_AGE` "too far behind" auto-exit is currently driven only by pane output callbacks, which are gone by the time sessions are destroyed — exactly when it is needed. Drive it from the shutdown path as well.

A server-wide shutdown deadline in `server_loop()` would fix the symptom regardless of which of the above is chosen. The essential property: `control_all_done()` must not be able to block shutdown unboundedly.

### Additional evidence

Incident journal timeline (local time, 2026-09-22; tmux 3.4, server up ~8 weeks):

- **00:03:22** — a SIGTERM arrives (**delivery method/source not established** — we deliberately say "a SIGTERM", not "kill-server"; we had no audit tooling to tell how it was delivered). 14 pane scopes are consumed within 1–2 s = all sessions destroyed by `server_send_exit()`.
- **The wedged clients**: 28 orphaned `tmux -C attach-session` clients, all PPID=1 (their parent process had crashed), attached to 22 old sessions, accumulated over ~4.5 weeks of parent crashes (each crash left a few behind). None of them dropped in 18 minutes.
- **Natural control group**: the 7–8 control clients that still had an active reader (our session manager was reading their output) all exited cleanly after the signal — none remained at the 00:14 census (<11 min after the signal; we did not measure their exact exit times). Everything still hanging 18 minutes in was an orphan with nobody left reading the pipe behind its stdout fd. This strongly localizes the freeze to the clients whose output delivery had failed.
- **00:21:12** — SIGKILL (SIGTERM was already useless — the process was wedged in its exit path). tmux then auto-cleaned the stale socket, the next command auto-spawned a fresh server, and the full chain recovered (session create/list/kill all passed; an HTTP API on top verified end-to-end: 200/201/204).
- **Failure stability**: `server exited unexpectedly` reproduced on **every** attempt, within 5 ms; the socket probe's connect→immediate-EOF likewise. The process was not crashed during the freeze: it sat in `poll()`, single-threaded, ~64 MB RSS, no crash records.

### Workaround / backup (our side)

On our side (OmniTerm, a tmux/pty session manager) we are landing two mitigations so this cannot accumulate again: (1) `PR_SET_PDEATHSIG` on the `tmux -C` client processes we spawn, so parent death kills them at the kernel level; (2) startup reconciliation that kills stale orphan control clients (with PID-reuse-safe predicates: structured argv match on `["tmux", "-C"]`, changed ppid, unchanged `/proc/<pid>/stat` starttime), preventing orphan accumulation in the first place. If upstream declines to fix this, we will evaluate proactively `kill -9`-ing orphan control clients after a bounded timeout on our side — but once the anti-accumulation measures above land, that need should disappear on its own.

> **Upstream status（checked 2026-09-22，tinyfish 检索）**：queries `tmux server shutdown hang control client control_all_done never exits` / `github tmux control_all_done OR server exited unexpectedly shutdown stuck issue` 只命中无关 issue（#2376 / #4200 / #3007 崩溃类、#3905 机器关机挂起、#4151 OOM），**未发现本缺陷已有 issue**（非重复）；master / 3.5+ 是否已修**未能核**（CHANGES 抓取失败），如实标注为「未核」。

## 实施勘误（2026-09-22 实施批次）

> 实施 = 五笔提交：`8abd676`（P0-1/P0-2）、`221d0c7`（附录 C 机制定论）、`ef2c96c`（前端告警）、`9963c66`（P1-3）、`8e5b711`（P1-1/P1-2）。编号 ①–㉖ 收录全部「原文 → 实际 + 理由」偏差（㉕㉖ 为编排方终审/收尾补录）；标注「已就地修正」的条目其正文措辞已在上文同步改写。

### A. 编排方实测（kernel 7.0）

1. **① PDEATHSIG 语义跨内核差异**：原文 §5 P0-1 坑①断言「PDEATHSIG 在创建该子进程的线程终止时触发」、以「spawn 在 tokio worker 同步执行」为纪律 → 实测本内核（7.0）为**进程退出**触发，man prctl / kernel.org #43300 / dotnet/runtime#96470 记载为**创建线程**触发，跨内核不可依赖；纪律**升级为结构边界**——fork/exec 固定在长寿命 spawn 线程 `omniterm-tmux-spawn`（`control_mode.rs::spawn_thread`），「线程死亡不误杀」成为结构保证，§9 反向断言按字面成立。（已就地修正 §5 P0-1 坑①、§7 风险表）
2. **② `PDeathSig` 字段不可作硬断言**：原文 §9 要求 OS 真值断言 `/proc/<pid>/status` 的 `PDeathSig: 9` → 该字段受内核配置门控（本机未导出）；断言降级为「字段存在则断言 = 9、缺失以父死杀子 e2e 行为断言为准」（`pdeathsig_os_truth_pdeathsig_field_is_sigkill` + `pdeathsig_kills_child_when_parent_process_dies`）。（已就地修正 §9）
3. **③ §3.3「客户端停止 drain」表述证伪**（本批最重要勘误）：原文假定 client 在输出路径上「停止 drain」→ 实际 client **从不在输出数据路径上**——`client_send_identify` `dup(STDOUT)`→`MSG_IDENTIFY_STDOUT` 把 stdout fd 直交 server（`control_start` `bufferevent_new(c->out_fd)`）。准确机制 = 管道读端随父消失 → 写入 EPIPE 后 `control_error_callback` 只置 `CLIENT_EXIT` 不清缓冲、`control_discard` 不碰、唯一清理点 `control_stop` 恰被卡 ⇒ `control_all_done()` 永假死锁闭环，**client 进程死亡冻结照样持续**（残留 client 结构的滞留缓冲无人清）。连带发现 `CONTROL_MAXIMUM_AGE`(300000ms) 保险阀只由 pane 输出回调驱动、shutdown 时永不触发。理由：tmux 3.4 `control.c`/`client.c` 逐字核对（附录 C「Resolved」）。（已就地修正 §0.3 / §3.3 / §5 P2-1 / §7 的「停止 drain」措辞为「输出无法投递/管道读端消失」口径）
4. **④ P1-2 socket 归属反查不可实现**：原文要求按 `/proc/<pid>/fd` → `socket:[inode]` 与 server 监听 socket 配对限定统计范围 → 实测 `/proc/net/unix` 的**已连接客户端侧条目没有 Path 字段**，客户端↔server 无法从 /proc 配对；改为 argv 谓词近似（统计范围 = 本机全部 `tmux -C` 客户端），未登记进程按 ppid==1 判据，**subreaper 盲区**注明（被 subreaper 收养的未登记孤儿漏计，只少计不误计）。（已就地修正 §5 P1-2）

### B. P1-3（pidfile kill 归属校验）

5. **⑤ 旧格式 pid 文件 kill 侧 fail-closed**：原文只要求「补 cmdline 归属校验」→ 实际 `dev.sh` pid 文件格式改为 `<pid> <comm>`；旧格式（裸 pid）无记录值无法校验归属 ⇒ kill 侧**不发信号**（fail-closed，含进程组放大面），只清理 pid 文件；现行服务首次 stop 走端口兜底（`kill_port_orphans`），一次 stop/start 迁移到新格式。
6. **⑥ `write_pidfile` 需 fork→exec 落定采样**：原文未提 → 实测 `$!` 即时采样 comm 会漂移（3/30 次读空、1/3 记到未 exec 的子壳 bash，之后比对必误判 PID 复用）；加 `COMM_SETTLE_*`（0.1s × 5）有界等待落定 + 空值重试，超限仍空记空值（kill 侧按「无记录值」fail-closed）。
7. **⑦ `is_running` 对新格式也做 comm 比对**：原文未提 → 状态查询同样比对记录 comm，PID 复用时视为未运行并清理 pid 文件（status 不谎报运行中）。

### C. 后端 health（P1-1/P1-2）

8. **⑧ heal 单飞锁先于重探针取得**：原文 §5 P1-1 流程 = 重探针 → 单飞 → 反查 → 击杀 →「全程持锁 + 第二次触发立即 in_progress」→ 两要求与 a→b 顺序矛盾；实际**先 try_lock 取单飞锁再重探针**，三个性质（立即拒绝、全程持锁、重探针新鲜）同时成立。（已就地修正 §5 P1-1）
9. **⑨ 签名只判 stderr**：原文未限定通道 → stdout 是会话列表**数据通道**，会话名可为任意字符串，子串匹配会把健康 server 误判成聋 = 自愈误杀入口；`classify`/`classify_list_sessions_failure` 一律只查 stderr，socket 探针兜底复核。
10. **⑩ 「失败 + 空 stdout 无签名」的四态归属 = `Other`**：与 `list-sessions` 空态收窄的 `EmptyStdout` 是**两个函数的分工**——前者（探针 `classify`）不作自愈依据（可被 socket 探针实锤升级为 Deaf/NoServer），后者（`list_sessions` 失败分支）保留 psmux 空态语义。
11. **⑪ `/proc/net/unix` LISTEN 判据实测 `St=01`**：同 Path 的 `St=03` 已连接行**必须过滤**（server 侧 accept 出的已连接 socket 同样带 Path），不过滤会反查到已连接 socket 的 inode。列序 = Num RefCount Protocol Flags Type St Inode Path，Path 列按剩余整段取（可含空白）。
12. **⑫ inode 多属主保守放弃击杀**：原文只说「找不到/复核不过放弃」→ 实际加强为 **>1 个 `exe==tmux` 属主也放弃击杀**（无法唯一确定即不动手）——超出原文的安全加固。
13. **⑬ 删 stale socket 失败不回滚击杀**：原文未规定 → 击杀成功后删 socket 失败只降级 `socket_removed:false`，仍返回 200 + detail 说明（击杀事实不回滚、如实上报）。
14. **⑭ 告警节奏防刷屏**：连续 Deaf 第 3/6/9… 次**复告**（持续聋不能只留一条告警沉进日志海）；orphan 告警**仅较上轮增长时**发（不每 tick 刷屏）。原文只说「达阈值 warn」。
15. **⑮ `last_deaf_at` 语义**：= 最后一次判聋时刻、恢复后**粘滞保留**（历史标记）；「进行中」语义由 `consecutive_deaf` 承担。原文未定义。
16. **⑯ P1 三问补全**：连续 Deaf 计数上限 = `CONSECUTIVE_DEAF_CAP`（`u32::MAX`）**饱和封顶不回绕**（回绕会把「持续聋」误显示为 0 并跳过复告）+ 守限单测 `deaf_streak_saturates_at_cap`。
17. **⑰ 判定纯函数落 `health/classify.rs`**：`engine/tmux/mod.rs::list_sessions` 反向依赖 `health::classify`（叶子工具层依赖，与 `process_identity` 同模式）——D4 冻结边界**未解冻**（判定函数是叶子工具，不是引擎功能）。
18. **⑱ 与 `agent/watch.rs` 周期任务不合流**：原文留「合并评估」→ 评估结论**不合流**：30s 探针 vs 1s 检测节奏不同，且避免把健康探测耦合进引擎 watch 链（D4 精神）；独立 `spawn_monitor()` 周期任务。
19. **⑲ 非 Linux 平台降级矩阵**：heal 反查不可用 ⇒ WARN + 500 **拒绝击杀**（绝不猜 PID）；orphan 未登记扫描 degrade（`scan_degraded` + 一次性 WARN，只统计已登记条目）；socket 探针 `Inconclusive`（一次性 WARN）。（已沉淀 `docs/architecture/backend.md` 多实现/平台差异表）
20. **⑳ 实施期 fixture flaky 留痕**：测试 fixture「copy python3 → exec」偶发 ETXTBSY（内核 `deny_write_access` 写句柄回收与 exec 的竞态窗口；干净压测 8×30 次复现 3 次，与调用方逻辑无关）→ 有界重试 40×50ms 修复（`health/test_support.rs::SPAWN_BUSY_*`）；登记表测试的 `execv` 换影竞态同理由 `wait_argv0` 有界轮询收口。

### D. 前端

21. **㉑ 告警形态 = App 级横幅**：否决 §7.3 Toast（约 4s 自动消失，承载不了持续性故障 + 操作按钮）与 §4.1 status badge（明确「不可点击」、侧栏可折叠成 40px rail 全局可见性不足）；复用 Sidebar dup-banner 的「⚠ + 文案 + 行动按钮」交互模式，挂载层级学 `ToastContainer`（App 级浮层，桌面/移动/侧栏折叠均可见）。
22. **㉒ 前端也有 `DEAF_CONFIRM_THRESHOLD=3` 判定**：与后端 `DEAF_CONFIRM_COUNT=3` 同值（后端第 3 次才 warn 立哨、前端第 3 次才出横幅）——**双处同值义务**：改任一侧必须同步另一侧（双保险防单次探测抖动误报「自愈入口」这种高危动作的诱因）。
23. **㉓ `last_deaf_at` / `probe_interval_secs` 已入类型暂无 UI 展示**：API 契约字段前端 `TmuxHealth` 类型已收，界面当前不显示（记账留档，接展示零成本）。

### E. 运维事故留痕

24. **㉔ 实现期一次疑似误杀真实 tmux server（非 heal 动作）**：一条探查 `TMUX_TMPDIR` 语义的命令（执行中断）疑似误杀**默认 socket** 上的真实 tmux server——会话于 20:35:32 重建、环境已自愈。**不是自愈动作误杀，不触发 D3 翻盘**（D3 翻盘条件限于「自愈动作误杀健康 server」），但性质同类；事后确立护栏：**测试一律临时 socket 注入**（`health/test_support.rs` 全部 fixture 指向临时路径私有 socket，测试禁止触碰默认 socket），手动实验护栏同步写入 `docs/reference/user-testing.md` §19。

### F. 编排方终审补录

25. **㉕ 孤儿堆积前端提示不走 chat system 消息通道**：原文 §5 P1-2「前端提示复用既有 system 消息通道」→ 实际为 `tracing::warn` + `GET /tmux/health` 的 `orphan_count` 字段 + 前端 `TmuxHealthAlert` 全局横幅提示；**没有写 `chat_messages` system 行**。理由：system 消息是 ACP **会话级**聊天行，全局孤儿告警无会话归属，硬写入任一会话会造成跨会话刷屏与归属误导；全局横幅（App 级浮层）才是与「全局先兆指标」匹配的呈现位。（已就地修正 §5 P1-2）
26. **㉖ `start_key` 为平台抽象而非纯 `/proc` starttime**：原文 §5 P0-2 登记三元组写死「`/proc/<pid>/stat starttime`」→ 实现为平台抽象 `start_key`（Linux = stat starttime tick，实测口径；其余 Unix = `ps -o lstart=` 文本；Windows = `sysinfo` start_time 秒级，后两者未实测）——语义不变（PID 复用检测的「启动时刻」硬标识），属实现扩展而非证伪；平台差异已入 `docs/architecture/backend.md` 多实现/平台差异表。（已就地修正 §5 P0-2 括注）
