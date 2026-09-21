# ACP agent 连接层子进程等待空转：CPU 尖峰修复计划

> 状态：设计稿（2026-09-21；同日经一轮实现前评审，D1/D3/D4、范围表、验收、风险表、闭环已按评审结论修订，修订处以「2026-09-21 评审」标注）
> 触发条件：修改 `src/acp/client.rs`（`AcpClient::shutdown` / `disconnect` / 连接任务生命周期）、`src/api/sessions.rs`（release/archive 路径）、`src/acp/supervisor.rs`，或排查「恢复 ACP 会话后后端 CPU 飙高」问题前**必读**
> 关联：
> - `docs/dev/diagnostics/2026-09-21-omniterm-cpu-spike.md`（**完整证据链，本文的排查基础，先读它**）
> - `docs/dev/plans/2026-09-19-acp-failure-visibility.md`（turn 结束语义；本计划不改消息语义但共用 dispatch_prompt 周边代码，改动前对照）
> - `docs/dev/plans/archive/2026-08-18-permission-recycle-notice.md`（reaper 回收分支；本计划的释放路径与回收路径同源，改动前对照）
> - `docs/dev/plans/archive/2026-08-10-acp-session-reliability.md`（turn 落库语义；shutdown 中 `mark_prompt_idle` 的既有约定）
> - `docs/dev/performance-and-safety.md`（§P4 外部输入速率不受控）
> - `docs/architecture/backend.md`（分层约定）

## 背景

### 现象与复现（用户已验证，稳定复现）

恢复/连接 ACP 会话「Pi ACP_0921-0817」→ omniterm 后端进程数秒内冲到 **~150% CPU**（约 1.5 核）并持续；释放该会话 → CPU 立即回零。2026-09-21 15:02 与 16:02 两次复现，第二次被自动抓捕器完整记录。

### 定位结论（详见 diagnostic 文档，硬数据）

- CPU 烧在**后端自身的 ACP 连接层**：`agent-client-protocol` 1.3.0 连接 actor 的 `wait_for_child` → `async-process` 2.5.0 的 Linux pidfd 后端（`Reaper::status → WaitableChild::poll_wait → Child::try_wait`）。
- 尖峰期 3 秒系统调用计数：`read` 63 万次/s、`wait4` 31.5 万次/s、`futex` 16 万次/s——用户态紧密循环（单次约 3µs）。
- gdb 三轮采样全部抓到同一线程停在同一等待栈；agent 子进程自身仅 2.8% CPU、零输出，**与 agent 行为无关**。
- 时间线：agent 恢复生成并完成 initialize/load（存活且响应过）→ 数秒后 CPU 冲高 → agent 约 2 分钟后无声退出 → 释放后归零。

### 根因现状（未完全钉死，见「交接说明」）

精确触发条件是依赖 crate 内部 pidfd 等待路径的某一 poll/wake 交错（疑似 agent 退出后 pidfd 永久可读 + level-triggered epoll 的组合）。最小复现实验（纯静默假 agent）**不复现**，触发依赖真实 agent 生命周期。本计划的策略：**不等待根因钉死，先用 omniterm 侧可控手段止血 + 建观测与回归测试，同时推进上游调查**。

### 核心结构性问题（omniterm 侧可修）

`AcpClient::shutdown()` 只发送优雅关闭信号，杀 agent 进程依赖 crate 内部 task_actor 任务自然结束后其持有的 `ChildGuard` 被 drop 才 killpg（`agent-client-protocol` 1.3.0 `acp_agent.rs`：`ChildGuard::drop → kill_process_group`；crate 中没有 `finish_child_exit` 这个函数名，勿按名搜）。**连接 poll 卡死时该路径永远走不到**——而 release 接口（及 `backend.md`、reaper 注释）声称"强制杀进程"，实际并没有。这意味着一旦连接层进入异常状态，omniterm 没有任何直接手段终止它。

## 范围与优先级

| 优先级 | 项 | 目标 | 要点 |
|--------|-----|------|------|
| P0-1 | 释放即杀进程 | shutdown/disconnect 直接杀 agent 进程组 | 不等优雅路径；kill 使 `try_wait` 立即返回，从根上打破空转 |
| P0-2 | 连接任务可终止 | 留存 `JoinHandle`，shutdown 时 signal + abort 兜底 + crash watcher 区分 `is_cancelled()` | 限制（2026-09-21 评审已核实）：`ChildGuard` 归 crate 内部 task_actor 所有，abort 杀不了进程组，仅本地清理；kill 才是主路径 |
| P1-1 | 日志可归因 | ACP 连接/重放/通知日志补 `session_id` | 本次排查直接受害（多会话并发时 replay 无法归因） |
| P1-2 | 回归测试 | 假 agent 固化「响应后退出」时序 | 断言连接任务限时结束 + shutdown 杀进程；同时作为上游 bug 复现脚本 |
| P2-1 | 依赖治理 | 查上游修复/升级 + 修正版本声明 | `Cargo.toml` 写 `agent-client-protocol = "1.2"` 但 lock 解析到 1.3.0，声明与实际不符 |
| P2-2 | 僵尸子进程 | tmux client 子进程回收调查 | 11 个 defunct 最久 10 天；与本次 CPU 无关，独立根因 |
| P2-3 | 探针超时泄漏 | `test_agent` / `test_agent_raw` 15s 超时分支无 client 句柄，agent 进程必泄漏（既有缺陷） | 超时即 WARN 留痕；Phase 1 若 pid 登记采用「spawn 前登记」形态可顺带清理，否则列 backlog |

### 不纳入范围（含理由）

- **crate 内部 busy-loop 的根修**：属上游；omniterm 只做止血、观测与上报。若上游长期不修再评估 vendor patch（维护成本高，不做预备）。
- **前端 WS 重连风暴**（浏览器 ~20 次/分钟持续一天多）：前端连接管理问题，另立任务；本计划纯后端。
- **turn 定稿/消息语义改动**：shutdown 已有 `mark_prompt_idle` 约定（见 08-10 计划），本计划不改其语义，只提前 kill 时机——需验证不破坏既有约定（见验收）。
- **存量会话数据清理**：无数据污染，不涉及。

## 设计决策（ADR）

### D1：agent pid 的获取方式 —— wrapper 自报 pid 为主，/proc 扫描为兜底（2026-09-21 评审修订）

- **决策**：
  - **主路径**：`wrap_agent_with_cwd` 的 wrapper 脚本改为 `cd <workspace> && echo $$ > <pid 文件> && exec <cmd> <args…>`。`sh` 的 `$$` 是 wrapper 自身 pid，`exec` 后原 pid 成为 agent，故文件内容即 agent pid（也正是 D2 要 kill 的进程组 leader pid）。`spawn_and_connect` / `spawn_and_load` 建成连接后读取该文件，存入 `AcpClient`（`Mutex<Option<u32>>`），读后删除文件。
  - **兜底**（pid 文件缺失/内容非法）：扫描 omniterm 自身直接子进程。Linux 用 `/proc/self/task/*/children`，取 spawn 前后 diff 的新增 pid；出现多个新 pid（并发 spawn）时按 `/proc/<pid>/cwd` 匹配本 session 的 workspace 消歧。
- **理由**：crate 的 `spawn_process` 虽为 `pub` 但子进程句柄不交给调用方；omniterm 又是经 `sh -c "cd … && exec …"` 包装 spawn，直接子进程即 agent 本体。pid 文件竞态免费、归属确定，不受 restore + create + 探针并发 spawn 干扰；diff 扫描在并发场景无法归属 pid（见风险表），故作兜底而非主路径。
- **落地范围（两条构造路径都要改，2026-09-21 评审实测）**：`spawn_and_connect`（create-session、`test_agent`/`test_agent_raw` 探针）与 `spawn_and_load`（恢复会话）当前是 **272 行逐字重复**（仅 `NewSessionRequest` vs 复用 `acp_session_id` 之差）。pid 捕获与 kill 逻辑要么先抽公共 spawn 核再改一处，要么两处同步改并各自覆盖测试——禁止只改一处（工程准则 6）。
- **否决项**：① vendor patch crate 暴露 `Child` 句柄——长期依赖维护成本，不做预备；② `pgrep -f` 按命令行匹配——脆弱（参数含路径/空格），误杀风险不可接受。
- **翻盘条件**：crate 新版本暴露 pid/句柄 API → 改官方 API；或 pid 文件方案实战不可用（如真实 agent 包装链不经 omniterm 的 `sh`）→ 回退 /proc 扫描为主并接受其竞态限制。

### D2：杀进程方式 —— `kill(-pid, SIGKILL)` 进程组

- **决策**：对 D1 取得的 pid 发**进程组** SIGKILL。
- **理由**：crate 的 `spawn_process` 已把 agent 设为独立进程组 leader（源码注释明确：wrapper launcher 场景下只杀直接子进程会留下孤儿 agent）。进程组击杀覆盖 wrapper/孙进程场景。
- **否决项**：只杀单进程——留下孙进程孤儿，且 pidfd/stdout 管道被孙进程持有时 EOF 不触发，问题照旧。
- **幂等性**：与 crate `ChildGuard::drop` 的 killpg 重复执行无副作用（`ESRCH` 忽略）；kill 后 `try_wait` 立即拿到退出状态，task_actor 走完正常收尾，guard 再 drop 时多为 no-op。
- **翻盘条件**：实测发现 agent 不在独立进程组（如 crate 未来改动）→ 回退单 kill 并显式处理孙进程。

### D3：shutdown 顺序 —— 先 kill，后 signal

- **决策**：`shutdown()`/`disconnect()` 的完整顺序链固定为：
  `alive=false → mark_prompt_idle → terminal_manager.kill_all() → killpg(pid) → take shutdown_tx（signal）`
  即 kill 插在既有优雅收尾**之后**、signal **之前**（与风险表「不破坏优雅收尾」同口径，勿读成 kill 最先执行）。
- **理由**：kill 让 `try_wait` 立即返回退出状态，从根上打破任何 poll 内循环；signal 保留给正常路径的优雅收尾（turn 定稿、终端回收等既有行为不变）。正常路径 agent 本就在 signal 后退出，kill 为 no-op。
- **否决项**：只加 `abort` 不加 kill——两层原因：① gdb 证据显示线程常驻 `try_wait`（poll 内循环形态），任务不 yields 时 abort 无法进入；② 更根本的（2026-09-21 评审核实）：`ChildGuard` 归 crate 内部 task_actor 所有，abort omniterm 外层 connection task 不会 drop guard，**abort 永远杀不了进程组**（详见 D4）。
- **翻盘条件**：上游修复空转根因后 → 可退化为仅 signal + abort（kill 作为异常路径兜底保留）。

### D4：连接任务句柄留存与 abort 语义（2026-09-21 评审修订）

- **已核实事实**（crate 1.3.0 源码，采信勿重复排查）：
  1. 持有 `ChildGuard` 的是 crate 内部 task_actor 任务（`jsonrpc.rs` 的 `Task::spawn`），**不在** omniterm `tokio::spawn` 的 connection task future 里；因此 abort omniterm 外层的 connection task 不会 drop guard、不会 killpg——abort 对进程终止**零贡献**，只是让 omniterm 侧 future 不再悬挂。
  2. `spawn_crash_watcher` 的 `if let Err(e)` 分支不区分 `Cancelled` / panic / 真错误（`client.rs:255-259`），abort 一旦生效必向前端广播一条 `prompt_error`。
- **决策**：
  1. `AcpClient` 留存连接任务 `JoinHandle` 的**可 abort 通道**（现被 `spawn_crash_watcher` 独占；一个 `JoinHandle` 不能两处 await，实现时任选：crash watcher 持句柄 + 接收 shutdown 侧 oneshot 延迟 abort，或 `Arc<Mutex<Option<JoinHandle>>>` 共享槽位）。shutdown 时 signal 之后 abort——定位为本地资源清理，**不是**进程终止手段。
  2. `spawn_crash_watcher` **无条件**区分 `JoinError::is_cancelled()`：取消则静默返回，不广播、不调 `finalize_turn`。这不是翻盘条件而是 Phase 1 必做项——pid 获取失败（D1 降级路径）时 abort 是唯一兜底，误广播会 100% 发生。
- **翻盘条件**：上游把 guard 生命周期改归调用方 future（或暴露句柄 API）→ abort 重获进程终止语义，D3 可退化为 signal + abort；反之若实测确认 abort 在自旋态永不可达 → 删除句柄留存，仅保留 signal + kill 以降低复杂度。

### D5：回归测试形态 —— 「响应后退出」的假 agent

- **决策**：fake agent 用 shell/node 脚本实现最小 JSON-RPC：响应 `initialize` 与 `session/load`，然后**退出**（或转静默后退出），驱动真实连接 actor 时序。断言：① agent 退出后连接任务在限定时间内结束；② shutdown 后进程组无残留。
- **理由**：纯静默 agent 已证不触发（测试会假绿）；「响应过再退出」是现场真实时序。
- **否决项**：只断言"CPU 不高"——CI 上不可靠；用超时断言替代。

## 多实现差异与降级（AGENTS.md §8）

| 场景 | 差异 | 本计划姿态 |
|------|------|-----------|
| node 系 agent（pi-acp） | 可能 fork 孙进程持有继承的 stdio | D2 进程组击杀覆盖；不依赖 EOF |
| wrapper launcher（npx/uvx 类） | 直接子进程是 wrapper，真 agent 是孙进程 | crate 已设独立进程组；D1 取到的 wrapper pid 即组 leader，killpg 有效 |
| 不响应 initialize 的 agent | 连接 actor 停在 initialize 等待 | 不在本计划触发路径；但 D1/D2 对任何已 spawn  agent 均生效 |
| agent 已自行退出 | pidfd 可读、连接任务可能已结束 | kill 对已退出进程为 no-op（ESRCH 忽略），幂等 |
| 非 Linux（macOS 等） | 无 `/proc/self/task/*/children`，async-process 不走 pidfd 后端 | D1 主路径（wrapper `$$` pid 文件）POSIX 通用；/proc 扫描仅作 Linux 兜底；两者皆失败时降级为仅 signal（= 修复前现状），必须 WARN 日志留痕 |

**总原则**：修复不依赖 agent 合作——kill 是 OS 级操作，与 agent 实现无关。

## 实施分期

| Phase | 产出 | 主要改动 | 依赖 |
|-------|------|---------|------|
| 1（P0 止血） | D1–D4 落地；手动复现验证 CPU 可控 | `src/acp/client.rs`（pid 字段、shutdown/disconnect、句柄留存、**`spawn_and_connect` 与 `spawn_and_load` 两条构造路径同步改，或先抽公共 spawn 核**）、`src/acp/supervisor.rs`（如需） | 无 |
| 2（P1 观测+测试） | 日志补 session_id；fake agent 回归测试 | `src/ws/acp.rs`（tracing）、`src/acp/client.rs` 单测或 `tests/` 集成测试 | Phase 1 的 pid/杀进程能力（测试断言它） |
| 3（P2 治理） | 上游调查结论 + 版本声明修正；僵尸子进程根因 | `Cargo.toml`/`Cargo.lock`；tmux client 回收路径（根因明确后） | Phase 1/2 合入后；联网环境 |

每 Phase 可独立提交与验证；Phase 3 的依赖调查不阻塞 1/2 合入。

## 验收标准

- [ ] 恢复目标会话后：CPU 不再无限持续高位（止血生效）；若空转仍被触发，释放后**立即**归零且无 agent 进程残留（`pgrep` 验证，含孙进程）
- [ ] 回归测试（fake agent）：agent 退出后连接任务限时结束；shutdown 后进程组被 kill
- [ ] 正常链路无回归：恢复 → 发消息 → turn 正常定稿落库 → 释放，全链路行为与修复前一致（`mark_prompt_idle` 时序不被 kill 破坏）
- [ ] **全部**释放路径行为一致（修复在 `shutdown()`/`disconnect()` 内部则自动覆盖，但仍需逐点抽查）：`release`（`sessions.rs` release_session）、`archive` 与 `delete_session`（`cleanup_session_runtime`）、reaper 空闲回收（`reaper.rs`）、`shutdown_all`（`supervisor.rs`，服务退出）、restore 三条清理（`ws/acp.rs`：不支持 load 时、旧 client 回收、load 失败回收）、探针（`agents.rs` test_agent / test_agent_raw）
- [ ] create 路径（`spawn_and_connect`，非仅 `spawn_and_load`）同样捕获 pid 并杀进程——防 272 行重复只改一处
- [ ] pid 获取降级路径有 WARN 日志（非 Linux / pid 文件缺失或非法 / 扫描无果），不静默退化为修复前现状
- [ ] `cargo test --workspace`、`cargo clippy -- -D warnings`、`cargo fmt` 通过；本计划无前端改动
- [ ] CHANGELOG.md 增条目（核心规则 2：实质性修复）

## 风险与降级

| 风险 | 影响 | 缓解/兜底 |
|------|------|-----------|
| pid 获取失败（agent 秒退扫不到 / pid 文件未写 / 非 Linux） | 退化为仅 signal（现状） | 主路径 pid 文件竞态免费；兜底扫描按 `/proc/<pid>/cwd` 匹配 workspace 消歧；**所有**失败路径记 WARN 日志，Phase 3 评估稳定获取方式 |
| 进程组边界误杀 | 误杀同组其他进程 | crate 保证 agent 独立进程组（`process_group(0)`）；kill 前校验 pid 仍为自身直接子进程（读 `/proc/<pid>/stat` 比对 ppid） |
| abort 使 crash watcher 误广播崩溃 | 前端闪现错误提示 | 2026-09-21 评审已核实为**必发路径**（非翻盘）：Phase 1 随 abort 一并落地 `is_cancelled()` 静默分支 |
| 误以为 abort 能杀进程 | 降级路径下进程残留、排查走偏 | D4 已核实 `ChildGuard` 归 crate task_actor，abort 无杀伤力；本计划与代码注释均须写明 kill 才是主路径 |
| kill 提前破坏优雅收尾 | turn 未定稿/终端未回收 | kill 放在 `mark_prompt_idle` 与 `kill_all` **之后**；正常路径 agent 本就会在 signal 后退出，kill 为 no-op |
| 测试时序 flaky | CI 偶发 | 断言用超时上限（如 5s）而非精确值；fake agent 脚本确定性时序 |

## 文档闭环

实施完成后需更新：

1. 本计划状态 → `已实施`（若分 Phase 合入，就地记录各 Phase 偏差「勘误」块）
2. `docs/dev/diagnostics/2026-09-21-omniterm-cpu-spike.md` 标注修复指向本计划
3. `AGENTS.md` 文档索引：新增本计划行（本文即「改 `client.rs` 释放路径前必读」）；**无条件**同步 `docs/architecture/backend.md`——其 ACP 小节当前写着 `shutdown`「强制 kill 子进程」的虚假声明，与修复后真实语义不符，须改写为「kill 进程组 + signal」并说明 kill 是主路径、abort 不杀进程；同时修正三处同源错误注释：`sessions.rs` release/delete 的「shutdown 强制杀进程」、`reaper.rs` 回收路径的「shutdown … 子进程被 kill」
4. `CHANGELOG.md`：实质性修复条目
5. `./scripts/check-doc-index.sh` 校验通过

## 交接说明（给接手会话）

**已完成（可直接采信）**：

- 完整诊断与两次现场抓获，全部硬数据在 diagnostic 文档（perf stat 系统调用计数、gdb 栈、时间线、排除项清单）——`/tmp` 下的原始证据文件已丢失（重启易失），关键数字已抄录。
- 最小复现实验结论：纯静默 agent 不复现；触发依赖「响应后再退出/静默」的真实时序（D5 据此设计）。
- 2026-09-21 实现前评审补充的已核实事实（采信，勿重复排查）：crate 1.3.0 的 `spawn_process` 设 `process_group(0)`（`acp_agent.rs`）；killpg 在 `ChildGuard::drop`，guard 归 crate 内部 task_actor 所有、**不在** omniterm connection task future 中（故 abort 杀不了进程组）；`spawn_and_connect` 与 `spawn_and_load` 是 272 行逐字重复；`backend.md` / `sessions.rs` / `reaper.rs` 三处注释同源虚假声称「强制杀进程」。
- 已排除假设清单（agent 输出驱动、前端重连风暴、replay 重放、reactor 跨线程、try_wait 返回 None 路径等）——**不要重复排查这些**。

**未解决/未知**：

- 空转的精确触发条件（crate 内部 pidfd 等待路径的 poll/wake 交错）——Phase 2 的 fake agent 测试若复现，可据此向上游提 issue；若不复现，说明还有未识别的时序变量。
- wrapper `$$` pid 文件方案尚未经真实 agent 验证（含 npm 包 wrapper launcher 场景下 pid 归属是否仍成立）——Phase 1 第一件事。
- 上游是否已有修复版本：诊断时 crates.io 网络不通，未验证。Phase 3 第一件事。
- 僵尸子进程根因（P2-2）：未排查。

**现场状态**：

- 正式版 0.2.23（npm 安装）在跑，PID 会变；目标会话保持释放态可规避；dev 实例未运行。
- 规避手段：不要恢复该会话；或恢复后尽快释放。

**动手前必读**（按 AGENTS.md 文档索引）：本文 → diagnostic 文档 → 上述四个关联 plan → `docs/dev/performance-and-safety.md` → `docs/architecture/backend.md`。
