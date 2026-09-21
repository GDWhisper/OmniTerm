# CPU 占用排查记录：omniterm 后端 vs 内部 agent（2026-09-21 15:00–16:30）

> **2026-09-21 修复指向**：止血方案已按 `docs/dev/plans/2026-09-21-acp-agent-connection-cpu-spin.md` 实施 Phase 1（P0）——omniterm 侧 killpg 杀 agent 进程组 + 共享构造核重构；精确触发条件（crate 内部 pidfd 等待路径的 poll/wake 交错）仍未钉死，Phase 2 fake agent 回归测试负责固化时序并向上游提 issue。
>
> **2026-09-21 16:30 更新**：用户定位到具体会话并用「释放/重连」稳定复现，尖峰被现场抓获
> （152%），根因锁定到 ACP agent 连接层的子进程监管循环。下文保留首轮排查过程，
> 「二轮：现场抓获」为最终结论。

## 结论（二轮修订）

高 CPU 由 **omniterm 后端进程本身**造成（npm release 0.2.23，PID 792178，端口 9077），
**不是** agent 子进程（pi-acp node 全程 2.8% CPU、零输出）。精确位置：**ACP agent 连接
actor 的子进程监管循环**——`agent-client-protocol` 1.3.0 的 `acp_agent::wait_for_child`
→ `async-process` 2.5.0 的 Linux pidfd 后端（`reaper::wait::Reaper::status` →
`WaitableChild::poll_wait` → `Child::try_wait`）。

触发条件：**恢复/连接 ACP 会话「Pi ACP_0921-0817」（session f64e63b9，agent pi-acp）**；
释放会话（杀 agent）CPU 即回零。用户已验证两次（15:02、16:02 各一次），16:02 尖峰
被自动抓捕器完整抓获。

## 二轮：现场抓获（16:02 尖峰，硬数据）

抓捕器（CPU>25% 持续 3s 即抓栈 + perf）在 16:02:19 捕获 152% 尖峰：

1. **perf stat 3 秒系统调用计数**：`read` 189 万次（63 万/s）、`wait4` 94.6 万次
   （31.5 万/s）、`futex` 49 万次、`epoll_wait` 21 万次、`write` 21 万次——典型
   用户态紧密循环（每次迭代约 3µs）。
2. **gdb 三轮采样全部抓到同一线程**（LWP 3217785）停在同一栈：
   `wait4(pid=3892659, options=1 /*WNOHANG*/)` ← `Child::try_wait` ←
   `WaitableChild::poll_wait` ← `Reaper::status`（pidfd 后端）←
   `acp_agent::wait_for_child` ← `AcpAgent::connect` 的
   `select(protocol_future, child_wait)` ← jsonrpc `task_actor` ←
   `process_stream_concurrently` 的 `Race2/FuturesUnordered`。
3. 时间线：16:02:16 agent（pid 3892659）恢复生成 → 16:02:18 `load_session ok`
   （agent 存活且响应过）→ 16:02:19 CPU 冲 152% → agent 约 16:04 无声退出
   （无 crash 日志、无 OOM）→ 用户释放后 CPU 回零。
4. agent 自身：2.8% CPU、`/proc/<pid>/io` wchar 3 秒零增长——**spin 与 agent 输出无关**。
5. perf 叶子符号：`try_wait` 35 样本、`ChildStderr/ChildStdout::poll_read` 29 样本、
   `futures_unordered Task` 14、`AtomicWaker` 16、`mpsc Queue::pop_spin` 10、
   `Condvar::notify_one_slow` 17——子进程 stdio 轮询 + 子进程退出等待两条线同时空转。

### 已排除的假设

- agent 输出/管道 EOF 驱动：agent 零写入；24 个 pipe fd 与 4 个 ptmx 全部 poll 无可读/HUP。
- 前端重连风暴：连接/断开每分钟约 20 次，但尖峰前后 CPU 为零时同样在连，非充分条件。
- ACP replay/load_session 重放：首轮尖峰窗口（07:02–07:10 UTC）内无 replay 事件。
- async-io reactor 跨线程 ticker 失真：Reactor 是全局 OnceLock 单例，tick 比较逻辑正确。
- 「子进程被抢 reap 后 try_wait 返回 None 致 pidfd 永可见」：rustc 1.96 实验证明被外部
  waitpid 抢先 reap 后 `Child::try_wait` 返回 **Err(ECHILD)**，循环会退出而非空转。
- 最小复现（临时 example，已验证后删除）：`AcpAgent::from_args(["sleep","300"])` +
  同构 `connect_with`，静默 agent 下 5 秒 CPU 仅 1%——**不空转**。触发依赖真实
  agent 生命周期（initialize/load 响应 → 静默 → 退出）。

### 机制判断（未完全确认为单一代码行，条件已消失无法复现）

pidfd 后端（async-process 2.5.0 新增，#68 移植较新）在「agent 退出/静默」后的某一
poll/wake 交错下进入 busy loop：pidfd 对已退出进程永久可读（level-triggered），若
try_wait 一侧未能一次性收尾（或 async-io `poll_ready` 的 waker 替换唤醒路径参与，
reactor.rs:462），reactor 每轮 epoll 立即返回 → 反复 wake → 反复 try_wait/poll_read。
精确定位需 instrument 或上游 issue 排查；现有证据链（等待栈 + 31.5 万次 wait4/s +
尖峰与恢复动作严格同步）已足够支撑修复立项。

## 附带发现（非本次 CPU 主因）

- **前端 WS 重连风暴**：192.168.5.212 浏览器以 ~20 次/分钟持续 connect/disconnect
  终端 WS，超过一天累计 1100+ 次，属异常行为（正常操作不可能这么快切换会话）。
  建议从前端 `useAcpChat`/`useTerminal` 连接管理侧排查重连触发条件。
- **11 个僵尸子进程**未回收（defunct `tmux: client` ×10 + bash ×1，最久 10 天，
  父进程均为 792178）；僵尸不烧 CPU，但说明 tmux client 子进程 wait 路径有泄漏。
- 16:15 pty 会话 b9c98de0 退出 code=1 后被 kill；其 history.ansi 曾累积 260KB 重复
  状态栏帧（pi TUI 高频重绘），非 agent 故障。
- freebuff（`~/.config/manicode/freebuff`）向 /dev/pts/0 写 14KB/s、tmux server 向
  自己的控制终端写 15.8KB/s——本机其他工具行为，非 omniterm。
- 运行版本 0.2.23 与仓库 `Cargo.toml` 一致；dev 实例（dev.sh）未运行，排除双实例。

## 复现与修复建议

1. **用户侧稳定复现**：恢复该 ACP 会话 → CPU 数秒内冲 150%；释放 → 回零。
   临时规避：保持该会话处于释放态。
2. **现场抓获手段**（本次已跑通，可复用）：
   - CPU 监视 + 尖峰自动抓捕：3s 窗口 >25% 即 `gdb thread apply all bt` ×3 +
     `perf record -F 99 -g` + `perf script`（sudo；perf_event_paranoid=4，禁 `P`/`dwarf`）。
   - `sudo perf stat -e syscalls:sys_enter_read,syscalls:sys_enter_wait4,... -p <pid> -- sleep 3`
     直接量化循环频率（read/wait4 计数是最灵敏指标）。
3. **修复立项建议**：
   - 上游排查：agent-client-protocol 1.3.0 + async-process 2.5.0（Linux pidfd 后端 #68
     移植较新）在 agent 退出后的 busy-loop；查上游 issue / 评估升级。
   - omniterm 侧缓解：release / agent 退出 / supervisor dispose 时确保连接 actor 被
     `JoinHandle::abort()` 而非仅 shutdown 信号；`AcpClient::shutdown` 后确认
     connection task 真正退出。
   - 加观测：对高频 `try_wait`/`poll_read` 加 tracing 计数或 metric，便于复现验证。
4. strace/gdb 直连被 yama ptrace_scope=1 拒绝，须 sudo（本机 sudo 免密）。
5. 证据文件（/tmp，重启丢失）：omni-spike-gdb.txt、omni-spike-script.txt、
   omni-spike-perf.data、omni-catch.log。
