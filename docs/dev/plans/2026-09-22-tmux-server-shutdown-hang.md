# tmux server 假死事故：SIGTERM 后被孤儿 control 客户端无限期冻结关闭流程

> 状态：事故报告 + 修复方案（2026-09-22）
> 触发条件：修改 `src/engine/tmux/control_mode.rs`（`ControlModeClient` 的 spawn / `stop()` / `Drop`）、`src/engine/tmux/terminal_ws.rs`、`src/engine/tmux/engine.rs` / `mod.rs` 的 tmux 子进程生命周期管理，或排查「tmux 命令报 `server exited unexpectedly` / tmux server 假死 / `tmux -C` 孤儿客户端堆积」前**必读**
> 关联：`docs/dev/debug-patterns/resource-lifecycle.md` 模式 10（父死不杀子）、`docs/dev/plans/2026-09-21-acp-agent-connection-cpu-spin.md`（同类「优雅关闭路径走不到」的结构性缺陷）、commit `344750f`（tmux 控制连接子进程退出后留僵尸——Child 句柄改常驻收割任务，P2-2，只解决「收割」不解决「孤儿」）
> 来源：2026-09-22 凌晨 tmux server（PID 14747，07-28 启动，已运行 55 天）对所有新 tmux 命令返回 `server exited unexpectedly`，tmuxes 服务（node 进程，8970 端口）`GET /api/targets/local/sessions` 返回 502。当日 00:21 已通过 SIGKILL + 清理 stale socket 恢复，本文为根因报告与修复方案。

## 0. 结论（TL;DR）

1. **不是 tmux 崩溃**：无段错误 / 无 core / 无 OOM，进程在 `poll()` 中正常存活 18 分钟。
2. **触发是一次外部 SIGTERM（00:03:22）**：tmux 正常进入关闭流程，所有 session 在 1-2 秒内被销毁。
3. **冻结是 tmux 侧缺陷**：`server_client_check_exit()` 要求 control 客户端 `control_all_done()`（待写输出全部刷完）才允许 drop；对停止 drain 的 control 客户端**没有超时**。28 个客户端一个都掉不了 → `server_loop()` 永远不返回 1 → server 永远退不掉，但 `server_exit=1` 已置位 → 进入「半死」：**accept 新连接后立即 close**，所有新 tmux 命令必败。
4. **积因是 omniterm 侧缺陷**：omniterm 实例崩溃（非优雅退出）时，其 `tmux -C` 子进程按 Linux 语义**不会**被杀死（无 PDEATHSIG），`ControlModeClient::stop()`/`Drop` 的清理只覆盖优雅路径。六周里多个 omniterm 实例崩塌，积下 **28 个 PPID=1 的孤儿 control 客户端**（挂在 22 个旧 session 上），它们正是卡死关闭流程的元凶。
5. 信号来源**未能确证也不必再追**：omniterm / tmuxes 源码、crontab、shell history 均已排除（见 §3.2）。剩下的可能是人工 `tmux kill-server` 或 pane 内 agent 执行——非交互执行不留痕。若复发，先用 eBPF/auditd 捕获再谈。

## 1. 环境

| 组件 | 事实 |
|------|------|
| tmux | 3.4（`/usr/bin/tmux`），server PID 14747，2026-07-28 启动，socket `/tmp/tmux-1000/default` |
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
| **09-22 00:03:22–23** | **14 个 pane scope 在 1-2 秒内集中 `Consumed` = `server_send_exit()` 执行 = SIGTERM 到达** | journal（server  healthy 时 pane 生死是分散的，集中死亡只可能是主动销毁） |
| 09-22 00:12:16 | npm omniterm 启动，随即生成的 tmux 客户端全部立刻死亡（僵尸）——server 已聋 | `ps`（5 个 `[tmux: client] <defunct>`，父 106111） |
| 09-22 00:14–00:21 | 排查期：`tmux ls` 稳定 5ms 内失败 `server exited unexpectedly`；socket 探针 connect 成功后 0.00s 收到 EOF | 见附录 A |
| 09-22 00:21:12 | 手动 SIGKILL 14747；3 个抗住 SIGHUP 的孤儿 pane（各 17h CPU、9GB 内存峰值）随之退出 | journal（scope `Consumed`） |
| 09-22 00:21:22 | 新 server 自动拉起，tmuxes API 全链路验证通过（200/201/204） | 附录 A |

## 3. 根因链

### 3.1 触发：一次外部 SIGTERM（00:03:22）

tmux 3.4 `server.c` 的 `server_accept()` 有一个明确分支：

```c
if (server_exit) {
    close(newfd);   /* accept 后立即关闭 */
    return;
}
```

`server_exit` 只由 `server_signal()` 的 SIGINT/SIGTERM 分支置 1。观测到的「连上即 EOF」**只能**由这个分支产生——崩溃的 server 会让 connect 得到 ECONNREFUSED，而不是 accept-then-EOF。配合 journal 的集中销毁记录，SIGTERM 到达时间可确定到 **00:03:22**。

同时排除「tmux 自身崩溃」：进程 18 分钟里一直在 `poll()`（`wchan: poll_schedule_timeout`）、RSS 64MB、单线程、无任何 dmesg/journal 崩溃记录。

### 3.2 信号来源：未能确证，且**不应继续追查**

已逐一排除：

- **omniterm**：`~/coding/OmniTerm` 全量检索，唯一的 `libc::kill(pid, SIGTERM)`（`src/main.rs:739`）打的是自己 PID file 里的 omniterm server；对 tmux 只有 `tmux kill-session`（单会话，不碰 server）、对 `-C` 子进程 `start_kill()`、对 pty 子进程 SIGHUP→SIGTERM→SIGKILL。**没有任何代码路径向 tmux server 发信号。**
- **tmuxes 服务**：源码无 `kill-server`。
- **crontab / bash history**：无记录。

剩余可能：人工执行 `tmux kill-server`，或 pane 内的 agent 执行（非交互 shell 不留 history）。**在没有 auditd / eBPF 的事后环境下无法进一步归因，继续排查是浪费**——本次要修的是「SIGTERM 之后为什么会聋 18 分钟」，不是「谁发的 SIGTERM」。若复发，先上捕获手段再谈归因。

### 3.3 冻结：tmux 关闭流程对卡死的 control 客户端无超时（tmux 侧缺陷）

tmux 3.4 `server-client.c` 的 `server_client_check_exit()`：

```c
if (c->flags & CLIENT_CONTROL) {
    control_discard(c);
    if (!control_all_done(c))
        return;      /* 待写输出没刷完，永不 EXITED、永不 drop */
}
```

关闭链路：`server_send_exit()` 把全部客户端标记 `CLIENT_EXIT` 并销毁 session（**这一步完成了**——00:03:23 时 pane 已死光）→ 事件循环持续运行，但每个 control 客户端都要等 `control_all_done()` 才被 drop → `clients` 列表永不空 → `server_loop()` 的退出条件（含 `TAILQ_EMPTY(&clients)`）永不满足 → `proc_loop` 永不返回 → 进程在 poll 里**永久挂机**，而 `server_exit=1` 让所有新连接 accept 即 close。

观测完全吻合：事件循环活着（否则新连接不会被 accept 再关），28 个客户端 18 分钟一个未掉。**任何一个停止 drain 的 control 客户端就能冻结整个 server 的关闭，且没有超时。**

次要观察：session 销毁只发 SIGHUP，不升级 SIGKILL——3 个 pane 进程抗住 SIGHUP 作为孤儿又活了 18 分钟（直至 server 被杀、pty master 关闭才退出）。

### 3.4 积因：omniterm 崩溃路径不收尸，六周积 28 个孤儿 control 客户端（omniterm 侧缺陷）

00:14 清点：**28 个 `tmux -C attach-session` 客户端，全部 PPID=1**（原始父进程已死，被 init 收养），启动时间跨度 08-10 至 09-11，分别挂在 **22 个不同的旧 `lt_*` session** 上。它们是历次 omniterm 实例崩塌的遗留：

- Linux 父进程死亡**不会**杀子（无 PDEATHSIG 语义）；
- omniterm 的清理只写在优雅路径上——`ControlModeClient::stop()`（`src/engine/tmux/control_mode.rs:114-166`：关 stdin → `start_kill()` → `wait()` 回收）和 `Drop`（:169-186）。进程级崩溃 / SIGKILL / panic-abort 时这些根本不执行；
- 每次崩塌留几个，六周积出 28 个。注意 commit `344750f` 解决的是「子进程退出后留僵尸」（收割），**不解决「父崩子留」**，两者互补。

### 3.5 天然实验：有 reader 的客户端全部按时退出

事发时 omniterm（22659）自己持有约 7-8 个活客户端（用户侧 UI 观测；其 dev 库有 11 个活跃 ACP 会话，量级吻合）。这些客户端的输出有人读（omniterm 的 `reader_loop`），SIGTERM 后**几秒内就干净退出了**——00:14 清点时 PPID=22659 的客户端一个不剩。**每一个有活跃 reader 的都退了；18 分钟后仍挂着的全部是无主孤儿。** 这基本锁定卡死关闭流程的就是 §3.4 的积奴，排除其他嫌疑。

## 4. 影响面

- 09-22 00:03:22–00:21（约 18 分钟）：所有新 tmux 命令失败（`server exited unexpectedly`）；tmuxes 服务会话列表/创建/删除全 502。
- 所有 session 在 00:03:22 即已销毁（pane 进程被杀），但 omniterm UI 在重连前仍显示这些终端——**UI 显示 ≠ 后端存活**。
- 恢复需人工介入（SIGKILL + 清 stale socket）；若无人值守，聋 server 会**无限期**持续。
- 复发条件现成：只要 omniterm 再崩溃几次攒下新的孤儿，任何一次对 tmux server 的 SIGTERM（或任何触发 `server_exit` 的路径）都会重演。

## 5. 修复方案（omniterm 侧）

### P0-1 崩溃兜底：给 `tmux -C` 子进程设置 PDEATHSIG

- spawn `tmux -C`（及评估 pty 子进程）时经 `CommandExt::pre_exec` 调 `prctl(PR_SET_PDEATHSIG, SIGKILL)`：父进程死亡时**内核直接杀子**，覆盖 panic/abort/SIGKILL 等 `Drop` 到不了的路径。
- 两个已知坑必须处理：① PDEATHSIG 在父**线程**死亡时触发，spawn 必须发生在长寿命线程上（或 `pre_exec` 内复查 `getppid()` 已变则自行退出）；② 被子仍需被收割——与 `344750f` 的常驻收割任务兼容，不冲突。
- 改动文件：`src/engine/tmux/control_mode.rs`（spawn 点）；`src/engine/pty` 的 spawn 路径评估后同办。

### P0-2 启动对账：登记 + 清理上一实例的残留

- 新增有界登记表（DB 表或 `~/.omniterm/` 下 pidfile，二选一，勿双写）：记录本实例 spawn 的每个 control 客户端 PID + 目标 session。
- 启动时对账：对每个登记项，若进程仍活着且 **PPID=1**（孤儿）且 `/proc/<pid>/cmdline` 仍匹配 `tmux -C`（防 PID 复用误杀），则 kill。优雅退出时正常注销登记项。
- 登记表天然有界（实例寿命内增删），但需按 AGENTS §6 显式上限 + 单测。

### P1-1 聋 server 检测与自愈

- 健康探测：周期 `tmux list-sessions`（或直连 socket 探测）。**两种失败语义必须区分**：`no server running` = 正常空态（首条命令会自动拉起新 server）；`server exited unexpectedly` / connect 成功后立即 EOF = **聋 server**（P1 的事故签名）。
- 连续 N 次聋签名 → 前端告警 + 提供「重建 tmux server」动作：SIGKILL 假死 server → 删 stale socket → 下一条命令自动重建。恢复动作必须幂等。

### P1-2 孤儿堆积监控

- 启动时（或周期）统计 PPID=1 且 socket 归属本机 tmux server 的 `tmux -C` 客户端数量，超阈值记日志/告警——这是 tmux server 进入「一 SIGTERM 就假死」高危状态的先兆指标。

### P2-1 tmux 上游

- 向 tmux 提 issue：control 客户端停止 drain 时 `control_all_done()` 无超时导致 shutdown 永久挂起（3.4 仍存在）；建议有界等待后强制 drop。可附本例完整证据（journal 时间线 + 源码路径）。
- 记录备用规避：若上游不接受，评估 omniterm 侧对孤儿客户端超时后主动 `kill -9`（P0-1/0-2 落地后此需求应自然消失）。

## 6. 明确不做的事

- **不给 omniterm 加任何向 tmux server 发信号的逻辑**（现状没有，勿开先例）。
- **不继续追查 SIGTERM 来源**（§3.2：无审计条件下不可证，复发时先上 eBPF/auditd）。
- **不改 tmuxes 服务**（独立项目，本次只是受害者）。
- **不手动清理 `/tmp/tmux-*` 残留 socket** 作为常规方案——那是症状清理；对账（P0-2）与自愈（P1-1）落地后不再需要。

## 7. 验收标准

- [ ] 集成测试（`tests/`）：spawn 受 omniterm 管理的 `tmux -C` 子进程 → SIGKILL 父进程（或等价模拟父线程死亡）→ 断言子进程在约定时限内消失（PDEATHSIG 生效）；被测子进程的收割仍由既有任务完成，不引入新僵尸。
- [ ] 集成测试：登记表记录 spawn 的 PID；启动对账能杀掉 PPID=1 且 cmdline 匹配的残留；PID 已被复用的条目被安全跳过（不误杀）。
- [ ] 单测：聋 server 签名与正常空态的区分（`server exited unexpectedly` ≠ `no server running`）。
- [ ] 手动回归：`docs/reference/user-testing.md` 补一条「假死检测 + 重建 server」流程。
- [ ] `cargo fmt/clippy`、`tsc -b`、前端 lint/test 零新增警告；pre-commit 通过。
- [ ] 实施后按惯例在 `CHANGELOG.md` 补条目（属实质性修复），并把 Phase 进展/偏差就地以「勘误」块回写本文。

## 8. 附录 A：关键证据与诊断命令（复现检测用）

```bash
# 1) 聋 server 签名：新客户端连上即被关（5ms 内失败，稳定复现）
tmux ls                       # → server exited unexpectedly
# 探针：connect 成功后立即收到 EOF（正常 server 会先发版本行）
python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/tmp/tmux-\$(id -u)/default');print(s.recv(100))"

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
```

## 附录 B：本次恢复动作记录（已完成，勿重复执行）

09-22 00:21 对 PID 14747 `SIGKILL`（SIGTERM 无效——它已在退出流程里卡死）；28 个孤儿客户端随 server 死亡全部自然退出；验证 tmux 自动清理 stale socket 并重建 server（create/list/kill session 全通过）；tmuxes API 端到端验证（GET 200 → POST 201 → DELETE 204）；清除 5 个确认无服务的残留 socket（`mansio-*`、`sshleak*`）。遗留：5 个僵尸进程待 omniterm（106111）退出时回收，无害。
