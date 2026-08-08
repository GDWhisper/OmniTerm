# 资源与生命周期 — 调试模式

覆盖：删记录≠释放运行时资源、Drop 隐式副作用、对称释放路径、spawn 抽象 cwd、map vs 持久化行、存活多层独立事实、回收编排失败路径、无界累积有界化。

---

## 模式 1：删记录 ≠ 释放运行时资源

**资源-成对生命周期**：「DB 持久化行 + 外部运行时对象（进程/会话/连接/锁）」成对出现的资源，销毁路径必须成对执行：删行前先取运行时标识，据此释放进程/连接，再删行。**级联删除（`ON DELETE CASCADE` / 批量 `DELETE WHERE project_id=?`）是隐藏运行时泄漏的高发区**——它帮你删干净子记录，却不帮你释放子记录对应的外部资源。批量路径必须逐个复用单条路径的清理逻辑。

**适用**：任何「表行对应外部进程/连接/会话」的删除路径；新增删除入口时先对照已有的单条删除 handler。

**案例证据**：
- 2026-08-04 `delete_project` 只级联删库，从未调 `kill_session` → 项目下 psmux/tmux 会话及 acp agent 子进程残留。修复：提取 `cleanup_session_runtime` 公共函数，`delete_session` 与 `delete_project` 共用。

---

## 模式 2：第三方库的 Drop 隐式副作用

**资源-Drop 陷阱**：第三方库 `Drop` 若做「外部副作用」（写 IO、发信号），就构成隐性外部依赖；要么不用、要么显式控制其 drop 时机。dup 出来的独立 fd 不随 master drop 失效——「先发 SIGHUP 再 drop」不一定够，要从源头避免副作用（不创建会 drop 时写 fd 的对象）。

**适用**：任何持 OS 资源（fd / handle / 进程）的 RAII 对象；改清理路径时先看库源码的 Drop 实现。

**案例证据**：
- 2026-06-28 `portable_pty::MasterWriter::drop` 往 PTY 写 `\n + VEOF(0x04)` → agent（raw mode TUI）收到 EOF 中断任务，且 writer fd 是 dup 出来的独立 fd，drop master 不失效。修复：不创建 MasterWriter，writer 线程用 `master.as_raw_fd()` + `libc::write`，master drop 后 write 返 EBADF 自然退出。
- 2026-06-23 同根因早期版本：切换会话时 TUI 多一行 + opencode 断联。修复：drop 前显式 SIGHUP。

---

## 模式 3：对称释放路径（注册必有释放）

**资源-对称性**：每个 `Watcher::new()` / `inotify_add_watch()` / `tokio::spawn` 都应对应 drop / `unwatch()` / `abort()`。任何「只增不减」的注册表都是泄漏嫌疑。**`spawn_blocking` + 长生命周期资源是高危组合**：future drop 不会 abort blocking 线程，必须显式给它退出路径（watch channel / AtomicBool / CancellationToken），并把 sender 绑到上层 drop 上。资源泄漏与运行时长的相关性是最强信号（同二进制、不同运行时长、fd 数差 N 倍 → 几乎 100% 泄漏）。

**适用**：SSE / 流式接口的连接级资源；任何 `spawn_blocking` 里持 fd/连接/锁的循环。

**案例证据**：
- 2026-07-16 SSE handler 每连接 spawn_blocking 一个线程，`RecommendedWatcher` 循环 sleep 永不退出，`JoinHandle` 被 `let _` 丢弃 → inotify fd 单调增长（5 天 1320 fd）。修复：watch channel，generator drop → sender drop → 线程退出 → Watcher drop。完整方案见 `docs/dev/plans/archive/2026-07-16-inotify-leak-investigation.md`。

---

## 模式 4：spawn 抽象必须验证 cwd 是显式设置还是隐式继承

**资源-spawn 契约**：任何「漂亮的 spawn 抽象」默认值都是继承父进程 cwd。协议层提示参数（ACP `NewSessionRequest::new(cwd)`）≠ 进程层 OS cwd——验证必须看 `/proc/<pid>/cwd`，不能依赖「传了 cwd 参数 = 子进程在那个目录」。`sh -c "cd <dir> && exec <cmd>"` 是「无法修改依赖」时的兜底，`exec` 保 PID / 信号透传 / 进程组归属。

**适用**：所有会 fork 出独立进程的代码（见 `docs/workflows/integration-checklist.md` A.1 必做 e2e 验证）。

**案例证据**：
- 2026-07-23 agent 子进程 cwd 继承后端而非 session workspace，git/文件读写全基于错误目录。修复：`sh -c` + `sh_quote` 包装。补遗：修一层后须从入口到 UI 走完请求流——后端 `resolve_session_base` 假设旧字段非 NULL，ACP session 该列 NULL 导致 FileManager 404。

---

## 模式 5：内存 map 与持久化行的生命周期不匹配

**资源-持久化**：「运行时对象 map + 持久化指针」组合，要么持久化与运行时同寿（写入/重启时同步清理 DB），要么持久化只记元数据、运行时按需重建。启动期 `DELETE FROM x WHERE runtime_kind='acp'` 一行代码解决「重启后前端打开旧 session 永远 not found」一类问题。

**适用**：内存 supervisor / 注册表 + 跨重启存活的 DB 行。

**案例证据**：
- 2026-07-19 `AcpSupervisor` 是 HashMap，重启清空；`sessions` 表 `runtime_kind='acp'` 行跨重启存活 → 重启后打开旧 session 报 "ACP session not found"。

---

## 模式 6：存活状态有多层独立事实（WS open ≠ 连接可用 ≠ 进程存活）

**资源-存活分层**：进程/连接/传输三层存活是独立事实，互不能替代：
- WS 传输级存活 ≠ 连接可用（mpsc/broadcast 通道可能已死但 WS 还开着）。
- 连接可用 ≠ 进程存活：库的 `is_incoming_closed()` 只在 **incoming 读到 EOF** 时置位，**主动 shutdown 不走 EOF** → 恒 false，误判死连接为存活。

**判定「外部进程是否已被回收」最可靠的是记录我方已执行的回收动作**（显式 `AtomicBool`，shutdown/disconnect 里置 false），库状态探测只作崩溃等异常路径的兜底。组合：`alive.load() && !is_incoming_closed()`。对库状态接口的假设，必须用能区分「我方主动回收」与「对端崩溃」的最小探针测试验证。

**适用**：任何「进程/连接/WS」三层存活互相替代判定的代码。

**案例证据**：
- 2026-08-04 `Arc::try_unwrap` 依赖引用归零才杀进程：WS handler 持 `Arc<AcpClient>` → reaper 回收时 try_unwrap 必失败 → 进程存活、Sidebar 灰「已释放」但可继续对话。修复：reaper/删除/释放/覆盖四处统一 `client.shutdown().await`（shared-ref 显式 kill）。同构点须 grep `Arc::try_unwrap` 一次性收敛。
- 2026-08-04 reaper `shutdown` 杀进程但 WS 不断、`client` 是 Some(死连接) → 发送报 "connection is no longer running"。
- 2026-08-05 `is_incoming_closed()` 在主动 shutdown 后恒 false → `is_alive()` 误判 true → 不走自动恢复。修复：`alive: AtomicBool` 记录我方回收意图。

---

## 模式 7：回收编排的失败路径（JoinHandle 返回 Result + 失败注销 + 错误分流）

**资源-编排**：
1. **`JoinHandle<()>` 把业务成败抹平成任务生命周期**——「等前置步骤完成再执行下一步」的串联，前置任务必须返回 `Result`，等待方分支处理；JoinHandle 只保证任务退出、不保证业务成功。
2. **注册表先注册后初始化的模式，失败路径必须有配套注销**——否则半成品污染后续所有判定（load 失败后死 client 滞留 supervisor，重试无法触发新恢复）。
3. **错误透传区分「我方主动动作的后续效应」与「对端故障」**——前者翻译成可操作提示（「会话进程已释放，请重新发送以自动恢复连接」），后者原样透传。

**适用**：自动恢复 / 重连 / 延迟初始化等「先注册再异步初始化」的流程。

**案例证据**：
- 2026-08-06 自动恢复路径 `let _ = handle.await; dispatch_prompt(...)` 不取 load 结果：`session/load` 失败后 prompt 仍发进死连接。修复：replay 任务返回 `JoinHandle<Result>`，仅 `Ok(Ok(()))` 才 dispatch；load 失败 `Arc::ptr_eq` 守卫 dispose+shutdown；dispatch 失败按 `is_alive()` 分流报错。

---

## 模式 8：无界累积有界化（O(n²) 防抖写）

**资源-缓冲有界**：任何「周期快照整个增长中的缓冲区」的模式，缓冲区必须有界。「防抖写」不等于「增量写」：每写一次全量重新序列化累积状态的防抖，把 O(n) 单次写放大成 O(n²) 总成本——CPU、内存、存储三者一起平方膨胀，同一根因的三个投影。诊断时从「累积缓冲是否有界」切入一击命中。

**适用**：流式进度累积 + 周期 flush 到 DB/网络；新增无界 `push`/`append` 前必读 `docs/dev/performance-and-safety.md` §P1。

**案例证据**：
- 2026-08-04 长 ACP turn `turn_accumulator` 无界 `Vec<Value>` push 7.7 万帧 + 每次 flush 全量重序列化覆盖写库 → 单条 blocks 100MB、RES 4.5GB、tokio worker 99%。修复：`VecDeque` + `MAX_FRAMES=2000` 有界窗口，text 仍全量累积。
