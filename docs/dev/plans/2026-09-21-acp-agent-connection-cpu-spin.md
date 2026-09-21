# ACP agent 连接层子进程等待空转：CPU 尖峰修复计划

> 状态：设计稿（2026-09-21）
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

`AcpClient::shutdown()` 只发送优雅关闭信号，杀 agent 进程依赖 crate 连接任务走完优雅路径（`finish_child_exit → killpg`）。**连接 poll 卡死时该路径永远走不到**——而 release 接口的代码注释声称"强制杀进程"，实际并没有。这意味着一旦连接层进入异常状态，omniterm 没有任何直接手段终止它。

## 范围与优先级

| 优先级 | 项 | 目标 | 要点 |
|--------|-----|------|------|
| P0-1 | 释放即杀进程 | shutdown/disconnect 直接杀 agent 进程组 | 不等优雅路径；kill 使 `try_wait` 立即返回，从根上打破空转 |
| P0-2 | 连接任务可终止 | 留存 `JoinHandle`，shutdown 时 signal + abort 兜底 | 注明限制：poll 内自旋不 yields 时 abort 无效，kill 才是主路径 |
| P1-1 | 日志可归因 | ACP 连接/重放/通知日志补 `session_id` | 本次排查直接受害（多会话并发时 replay 无法归因） |
| P1-2 | 回归测试 | 假 agent 固化「响应后退出」时序 | 断言连接任务限时结束 + shutdown 杀进程；同时作为上游 bug 复现脚本 |
| P2-1 | 依赖治理 | 查上游修复/升级 + 修正版本声明 | `Cargo.toml` 写 `agent-client-protocol = "1.2"` 但 lock 解析到 1.3.0，声明与实际不符 |
| P2-2 | 僵尸子进程 | tmux client 子进程回收调查 | 11 个 defunct 最久 10 天；与本次 CPU 无关，独立根因 |

### 不纳入范围（含理由）

- **crate 内部 busy-loop 的根修**：属上游；omniterm 只做止血、观测与上报。若上游长期不修再评估 vendor patch（维护成本高，不做预备）。
- **前端 WS 重连风暴**（浏览器 ~20 次/分钟持续一天多）：前端连接管理问题，另立任务；本计划纯后端。
- **turn 定稿/消息语义改动**：shutdown 已有 `mark_prompt_idle` 约定（见 08-10 计划），本计划不改其语义，只提前 kill 时机——需验证不破坏既有约定（见验收）。
- **存量会话数据清理**：无数据污染，不涉及。

## 设计决策（ADR）

### D1：agent pid 的获取方式 —— spawn 后扫描自身直接子进程

- **决策**：`spawn_and_load` 建成连接后，扫描 omniterm 自身直接子进程（`/proc/self/task/*/children` 或 spawn 前后 diff）取新增 pid，存入 `AcpClient`（`Mutex<Option<u32>>`）。
- **理由**：crate 的 `spawn_process` 虽为 `pub` 但子进程句柄不交给调用方；omniterm 又是经 `sh -c "cd … && exec …"` 包装 spawn，直接子进程即 agent 本体。
- **否决项**：① vendor patch crate 暴露 `Child` 句柄——长期依赖维护成本，不做预备；② `pgrep -f` 按命令行匹配——脆弱（参数含路径/空格），误杀风险不可接受。
- **翻盘条件**：crate 新版本暴露 pid/句柄 API → 改官方 API；或扫描竞态导致实战不可用（见风险表）→ 改为「释放时扫描全部直接子进程并按启动时间匹配」。

### D2：杀进程方式 —— `kill(-pid, SIGKILL)` 进程组

- **决策**：对 D1 取得的 pid 发**进程组** SIGKILL。
- **理由**：crate 的 `spawn_process` 已把 agent 设为独立进程组 leader（源码注释明确：wrapper launcher 场景下只杀直接子进程会留下孤儿 agent）。进程组击杀覆盖 wrapper/孙进程场景。
- **否决项**：只杀单进程——留下孙进程孤儿，且 pidfd/stdout 管道被孙进程持有时 EOF 不触发，问题照旧。
- **翻盘条件**：实测发现 agent 不在独立进程组（如 crate 未来改动）→ 回退单 kill 并显式处理孙进程。

### D3：shutdown 顺序 —— 先 kill，后 signal

- **决策**：`shutdown()`/`disconnect()` 中**先** kill 进程组，**再**走原有优雅关闭信号（take `shutdown_tx`）。
- **理由**：kill 让 `try_wait` 立即返回退出状态，从根上打破任何 poll 内循环；signal 保留给正常路径的优雅收尾（turn 定稿、终端回收等既有行为不变）。
- **否决项**：只加 `abort` 不加 kill——gdb 证据显示线程常驻 `try_wait`（poll 内循环形态），任务不 yields 时 abort 无法进入，等于没修。
- **翻盘条件**：上游修复空转根因后 → 可退化为仅 signal + abort（kill 作为异常路径兜底保留）。

### D4：连接任务句柄留存与 abort 语义

- **决策**：`AcpClient` 留存连接任务 `JoinHandle`（现被 `spawn_crash_watcher` 独占）；shutdown 时 signal 之后 abort。
- **理由**：双保险；crash watcher 对已 abort 任务的 `await` 返回 `JoinError::Cancelled`，不触发崩溃广播——需确认该语义不污染前端（crash watcher 现有分支只对 `Err(e)` 广播）。
- **翻盘条件**：abort 导致 crash watcher 误报 → 区分 `is_cancelled()` 后静默处理。

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

**总原则**：修复不依赖 agent 合作——kill 是 OS 级操作，与 agent 实现无关。

## 实施分期

| Phase | 产出 | 主要改动 | 依赖 |
|-------|------|---------|------|
| 1（P0 止血） | D1–D4 落地；手动复现验证 CPU 可控 | `src/acp/client.rs`（pid 字段、shutdown/disconnect、句柄留存）、`src/acp/supervisor.rs`（如需） | 无 |
| 2（P1 观测+测试） | 日志补 session_id；fake agent 回归测试 | `src/ws/acp.rs`（tracing）、`src/acp/client.rs` 单测或 `tests/` 集成测试 | Phase 1 的 pid/杀进程能力（测试断言它） |
| 3（P2 治理） | 上游调查结论 + 版本声明修正；僵尸子进程根因 | `Cargo.toml`/`Cargo.lock`；tmux client 回收路径（根因明确后） | Phase 1/2 合入后；联网环境 |

每 Phase 可独立提交与验证；Phase 3 的依赖调查不阻塞 1/2 合入。

## 验收标准

- [ ] 恢复目标会话后：CPU 不再无限持续高位（止血生效）；若空转仍被触发，释放后**立即**归零且无 agent 进程残留（`pgrep` 验证，含孙进程）
- [ ] 回归测试（fake agent）：agent 退出后连接任务限时结束；shutdown 后进程组被 kill
- [ ] 正常链路无回归：恢复 → 发消息 → turn 正常定稿落库 → 释放，全链路行为与修复前一致（`mark_prompt_idle` 时序不被 kill 破坏）
- [ ] release/archive/reaper 空闲回收三条释放路径行为一致（都杀进程）
- [ ] `cargo test --workspace`、`cargo clippy -- -D warnings`、`cargo fmt` 通过；本计划无前端改动
- [ ] CHANGELOG.md 增条目（核心规则 2：实质性修复）

## 风险与降级

| 风险 | 影响 | 缓解/兜底 |
|------|------|-----------|
| pid 扫描竞态（spawn 后 agent 秒退，扫不到） | 退化为仅 signal（现状） | 扫不到时记 WARN 日志； Phase 3 评估稳定获取方式 |
| 进程组边界误杀 | 误杀同组其他进程 | crate 保证 agent 独立进程组；kill 前校验 pid 仍为自身直接子进程 |
| abort 使 crash watcher 误广播崩溃 | 前端闪现错误提示 | D4 翻盘条件：区分 `is_cancelled()` 静默 |
| kill 提前破坏优雅收尾 | turn 未定稿/终端未回收 | kill 放在 `mark_prompt_idle` 与 `kill_all` **之后**；正常路径 agent 本就会在 signal 后退出，kill 为 no-op |
| 测试时序 flaky | CI 偶发 | 断言用超时上限（如 5s）而非精确值；fake agent 脚本确定性时序 |

## 文档闭环

实施完成后需更新：

1. 本计划状态 → `已实施`（若分 Phase 合入，就地记录各 Phase 偏差「勘误」块）
2. `docs/dev/diagnostics/2026-09-21-omniterm-cpu-spike.md` 标注修复指向本计划
3. `AGENTS.md` 文档索引：新增本计划行（本文即「改 `client.rs` 释放路径前必读」）；若 `AcpClient` 生命周期语义变化，同步 `docs/architecture/backend.md`
4. `CHANGELOG.md`：实质性修复条目
5. `./scripts/check-doc-index.sh` 校验通过

## 交接说明（给接手会话）

**已完成（可直接采信）**：

- 完整诊断与两次现场抓获，全部硬数据在 diagnostic 文档（perf stat 系统调用计数、gdb 栈、时间线、排除项清单）——`/tmp` 下的原始证据文件已丢失（重启易失），关键数字已抄录。
- 最小复现实验结论：纯静默 agent 不复现；触发依赖「响应后再退出/静默」的真实时序（D5 据此设计）。
- 已排除假设清单（agent 输出驱动、前端重连风暴、replay 重放、reactor 跨线程、try_wait 返回 None 路径等）——**不要重复排查这些**。

**未解决/未知**：

- 空转的精确触发条件（crate 内部 pidfd 等待路径的 poll/wake 交错）——Phase 2 的 fake agent 测试若复现，可据此向上游提 issue；若不复现，说明还有未识别的时序变量。
- 上游是否已有修复版本：诊断时 crates.io 网络不通，未验证。Phase 3 第一件事。
- 僵尸子进程根因（P2-2）：未排查。

**现场状态**：

- 正式版 0.2.23（npm 安装）在跑，PID 会变；目标会话保持释放态可规避；dev 实例未运行。
- 规避手段：不要恢复该会话；或恢复后尽快释放。

**动手前必读**（按 AGENTS.md 文档索引）：本文 → diagnostic 文档 → 上述四个关联 plan → `docs/dev/performance-and-safety.md` → `docs/architecture/backend.md`。
