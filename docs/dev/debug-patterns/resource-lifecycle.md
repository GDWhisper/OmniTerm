# 资源与生命周期 — 调试模式

覆盖：删记录≠释放运行时资源、Drop 隐式副作用、对称释放路径、spawn 抽象 cwd、map vs 持久化行、存活多层独立事实、回收编排失败路径、无界累积有界化、后台化进程启动结果握手反馈。

---

## 模式 1：删记录 ≠ 释放运行时资源

**资源-成对生命周期**：「DB 持久化行 + 外部运行时对象（进程/会话/连接/锁）」成对出现的资源，销毁路径必须成对执行：删行前先取运行时标识，据此释放进程/连接，再删行。**级联删除（`ON DELETE CASCADE` / 批量 `DELETE WHERE project_id=?`）是隐藏运行时泄漏的高发区**——它帮你删干净子记录，却不帮你释放子记录对应的外部资源。批量路径必须逐个复用单条路径的清理逻辑。

**同一规律在外部工具上的延伸**：外部命令的删除语义边界常**窄于**用户心智里的「这一项」——UI 里一行代表的复合实体，底层可能由多层独立资源拼成，删一层不连带另一层。UI 列表项的语义 ≠ 底层命令的语义，删除路径要逐层点名残留物。**残留物的危害常不在删除现场，而在下一次创建时**（重名冲突、旧值仍出现在选择列表里），所以症状看起来像「缓存没清」，实则是删除范围没覆盖。

**适用**：任何「表行对应外部进程/连接/会话」的删除路径；新增删除入口时先对照已有的单条删除 handler。外部工具（git / 容器 / 云 API）的删除封装，先查它对邻接资源的处置是「连带删」还是「保留」。

**案例证据**：
- 2026-08-04 `delete_project` 只级联删库，从未调 `kill_session` → 项目下 psmux/tmux 会话及 acp agent 子进程残留。修复：提取 `cleanup_session_runtime` 公共函数，`delete_session` 与 `delete_project` 共用。
- 2026-08-10 sidebar 删掉 worktree 后，其分支仍出现在「创建 Worktree」的基准分支下拉，且同名分支重建被 git 拒绝。根因：创建走 `worktree add -b`（顺带建分支），删除只走 `worktree remove`（**不删分支 ref**），而下拉数据源是 `git branch`。诊断弯路：症状形态（「删了还看得见」）诱导先查前端缓存与 git 元数据残留，实际两者都干净——两分钟的隔离复现（temp repo 里 add→remove→`git branch`）本应是第一步。修复：删除确认框加 opt-in「同时删除分支」，后端反查分支后 `git branch -D`。

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

**资源-上限维度**：**上限维度选错等于没有上限**。「条目数上限」只在单条大小可控时才等价于「体积上限」，而单条大小往往由外部实现决定（AGENTS.md §8）——同一份数据被每帧重复携带，条目数守住了、体积照样爆。判定：写下 `MAX_X = N` 时必须回答「N × 单条最大 = ?」；答不出来（单条大小不由我们决定）就说明缺一条字节维度上限。两个维度界住不同成本：字节界 I/O/存储，条目数界 per-item CPU（如 hydrate 时逐帧分类），故通常都要留。

**资源-兜底悰论**：为一个上限辩护时写下的“没关系，另一侧会全量保留”，**那个另一侧就是下一个事故点**。兜底字段不会因为叫兜底就不增长，反而因为“它是兜底”而沒人去限它——这是上限维度选错的孪生形式：维度选错是限了但限错地方，兜底悰论是明知该限却为它开了口子。**判定**：在代码或文档里 grep “仍全量”/”兜底“/”full … lives in“ 这类措辞，每一处都是一个未登记的无界项。

**资源-流式截断**：给**流式累积**的字段加上限时，“超限就重新截一次整串”只是把 O(n²) 换了个形式。可行形状是“头部冻结 + 尾部滑窗 + 计数”，且尾窗必须**按块摊还修剪**（修剪到恰好等于预算 → 此后每个 chunk 都 memmove 整窗）；头部需显式封口标志而不能以“长度未满”作条件（UTF-8 边界会剩几字节，续填会把新文本插到旧文本前）。

**诊断弯路**：「历史越多越慢」的直觉是「条数多 → 渲染慢/查询慢」，据此查渲染与 SQL 会全部落空（本例 SQL 50ms、渲染无感、text 列总量仅 49KB）。正确切入是**先量体积再量耗时**：把响应字节数、DB 列字节数、最终渲染产物字节数三者摊在一起看，差几个数量级的那一段就是根因所在（本例传输 15MB → 渲染产物 1KB）。

**适用**：流式进度累积 + 周期 flush 到 DB/网络；新增无界 `push`/`append` 前必读 `docs/dev/performance-and-safety.md` §P1。

**案例证据**：
- 2026-08-04 长 ACP turn `turn_accumulator` 无界 `Vec<Value>` push 7.7 万帧 + 每次 flush 全量重序列化覆盖写库 → 单条 blocks 100MB、RES 4.5GB、tokio worker 99%。修复：`VecDeque` + `MAX_FRAMES=2000` 有界窗口，text 仍全量累积。
- 2026-08-10 同一家族复发：切 ACP 会话卡顿且历史越多越慢。`MAX_FRAMES=2000` 帧数上限完好，但 codebuddy 每个 `tool_call_update` 只带 1 字符增量却重复携带完整 `rawInput`（实测 4.5KB/帧，>97% 是同一份副本）→ 单条 blocks 8.7MB、`GET /messages` 下发 15MB、切会话阻塞约 0.5s。修复：补 `MAX_BLOCKS_BYTES=128KB` 窗口字节上限 + `MAX_FRAME_BYTES=64KB` 单帧上限（超限帧不入窗、text 兜底），帧改存 `RawValue` 使字节计量免费且 flush 不再重格式化；前端 `ChatView` 对已 hydrate 会话不再重复 `GET /messages`。
- 2026-08-12 同一家族第三次，这回就是前两次的“兜底”：上两条修复都以“`text` 仍全量累积”作为丢帧的理由，而 `text` 恰恰因此从未被限——实测 dev 库单行 9,150,950 字符，所在会话只有 19 条消息（即“会话短”不提供任何保护），且同一个防抖 writer 每次 flush 重写整列。修复：`MAX_TEXT_BYTES=1MiB`，头 256KiB 冻结 + 尾窗滑动，中段为可读的 `…（已省略 N 字符）…`；切割走 `floor_char_boundary` / `ceil_char_boundary`（切在多字节字符中间会 panic 并折断整个 ACP 连接任务）。
- 2026-08-16 同一家族（外部注册集无界）：`files_watch` 用 notify `RecursiveMode::Recursive`，其内部 WalkDir 不跳过 node_modules/.git/target——OmniTerm-dev 项目注册 1 万+ inotify watch（事件侧 `should_ignore` 过滤不掉注册侧），notify 8.2 在该规模 + 持续事件下 `handle_inotify` 内层 `read_events` 循环饿死 mio poll：`notify-rx` 线程 100% CPU、高频分配致堆膨胀（正式版 RSS +5MB/s 至 7GB）。修复：`collect_watch_dirs`（walkdir `filter_entry` 剪枝）手动递归注册 + 新目录通道补注册，watch 数降到业务目录量级。

---

## 模式 9：后台化进程的启动结果必须握手反馈，不能只写日志

**资源-后台握手**：任何 daemonize / 重定向 stdio 的「后台化」程序，父进程**绝不能直接 `exit(0)`**——必须通过同步通道（pipe/套接字）阻塞等待子进程完成关键初始化（端口绑定、DB 连接等）并显式反馈「就绪/失败」后才退出。理由：fork 后 stdout/stderr 已重定向到日志文件，**一切后续报错对用户终端不可见**，父进程先退出 = 命令"看似成功"却返回 0，启动失败（端口被占/依赖不可用）完全静默。同类地，**PID 文件等"成功标志"必须在关键初始化成功之后写入**，失败路径不写不清理——否则失败后残留 stale PID，`stop`/`status` 读到陈旧 PID 误报"已停止"，且并发启动时新实例会覆盖在跑实例的 PID 文件导致 `stop` 误杀。

**适用**：任何 `start -d` / `--daemonize` / nohup+重定向 的后台启动入口；编写「fork 后父进程立即退出」的代码前必读。

**案例证据**：
- 2026-08-09 `start -d` double-fork 后父进程 exit(0)，daemon 子进程 bind 失败错误只进 `~/.omniterm/*.log`，命令静默返回 0 且 PID 文件（bind 前已写）残留 stale。修复：pipe 握手（子进程 ready/fail 通知，父进程打印错误并 exit(1)）+ PID 写入移到 bind 后。
