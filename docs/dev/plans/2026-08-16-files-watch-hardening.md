# 文件监控有界化与正确性加固（`/files/watch`）

> 状态：**设计稿（2026-08-16）**，ADR-6 已实施；**方向已于勘误 3 变更为 ADR-9（watch 范围收缩为视图范围）**，Phase 0-5 待实施
> 触发条件：修改 `src/api/files_watch.rs`、`src/fs/mod.rs` 的 ignore 规则（`SKIP_DIRS` / `search_recursive`）、`frontend/src/hooks/useFileWatcher.ts`、`frontend/src/components/FileManager/` 下 `FileManager.tsx` / `FileDrawer.tsx` / `FilePreview.tsx` 的文件变更刷新链路中任一项前**必读**（**先读勘误 3 与 ADR-9**，再看 ADR-1~8 的状态戳 —— 其中 4 条已撤销）
> 关联：`docs/architecture/backend.md` §File watcher、`docs/dev/debug-patterns/resource-lifecycle.md` 模式 8（外部注册集无界家族）、`docs/dev/performance-and-safety.md` §P1（无界累积）、`scripts/verify-inotify-fix.sh`
> 前序修复：commit `188a6b2`（手动递归注册跳过 node_modules）、`fbeb05d` / `9277493`（inotify fd 泄漏）

> **勘误 1（2026-08-16，落盘后核实取舍前提时三条证据修正）**：
> 1. **问题 10 从「P2 未验证」升为「P0 已确认」，并并入 Phase 1**。读 notify 8.2 源码后因果链已闭合，不需实测即可确认缺陷存在（证据见「问题 10 因果链」）；且 `188a6b2` 已随 **v0.2.15** 打 tag 发布，缺陷已在生产。修法比原估算简单得多（放宽一个 `if` 匹配条件，不需注册表），新增 ADR-8。
> 2. **ADR-1 的选项结构变了**：`walkdir` **只支持深度优先**（`walkdir-2/src/lib.rs:161`），「保留 walkdir 用其 API 实现 BFS」不成立；并新增否决项 (d)「从入口限制超大项目根」供权衡。
> 3. **ADR-4 的代价比原描述小**：`SKIP_DIRS` 只在 `search_recursive` 使用，**`list_dir` 不过滤** → 忽略只影响自动刷新，不影响浏览/编辑；且四个目录的证据强度不同，已调为分批推进。
>
> **勘误 2（2026-08-16，ADR-6 去抖 + 前端防抖/可见性已实施）**：
> 1. **ADR-6（Phase 4 的去抖部分）已实施**：`DEBOUNCE_WINDOW_MS=100` 窗口按 (kind, path) 去重合并，`MAX_PENDING=256` 超限或 broadcast Lagged 统一走 `resync` 降级出口（问题 6、7 一并关闭）。前端 `useFileWatcher.ts` 扩展 `kind: 'resync'`；`FileManager.tsx` 加 500ms 刷新防抖。**ADR-7（空流挂住 + 前端退避，问题 8）未做**，仍待 Phase 4 剩余部分。
> 2. **前端面板可见性控制（非 plan 范围，另行决策）**：`FileManager.tsx` 的 `useFileWatcher` 增加 `rightPanelTab === 'files'` 条件——切到 GIT tab 时断开 SSE（后端 watcher 注销），因组件仅 CSS 隐藏仍挂载。折叠 40px rail 时 RightPanel 直接卸载 FileManager，天然断开，无需处理。
>
> **勘误 3（2026-08-16，方向性变更：watch 范围收缩为视图范围，ADR-9）**：
> 讨论文件管理器 watch 的性能优化方向时，核对消费端后发现**监控范围与消费范围严重错配**：递归监控整棵项目树（165 ~ 35330 个目录），而全部消费者只关心 ≤2 个目录（见 ADR-9「错配实证」）。用户已确认产品预期为「文件管理器只需感知当前浏览目录 + 打开的文件，用户看不到的地方不用自动刷新」。
>
> 由此新增 **ADR-9（视图范围 watch）**，并连带变更本文档既有决策的状态：
>
> | 原决策 | 新状态 | 原因 |
> |---|---|---|
> | ADR-1（硬上界 + BFS + 截断） | **机制撤销，红线保留** | watch 数由构造保证 ≤2，红线退化为一个常量断言；BFS / 去 `walkdir` 之争随全树遍历删除一同消失。**待拍板事项 2 因此作废** |
> | ADR-2（`#[cfg]` 平台分流） | **撤销** | 单目录 `NonRecursive` 在 inotify / fsevent / ReadDirectoryChangesW 三个后端上代价都是 O(1)（macOS ≤2 次 stream 重建、Windows ≤2×16KB），分流的成本差消失 |
> | ADR-4（ignore 单一真源） | **watch 侧反转** | watch 侧不再遍历目录树 → 不需要剪枝清单，「两份真源」问题自然消失。反而 `should_ignore` 的**事件过滤**成了缺陷：`list_dir` 不过滤隐藏文件（列表里能看到 `.env`），却过滤它的变更事件 → 语义应与 `list_dir` 对齐。**待拍板事项 1（`dist`/`build`）因此作废** |
> | ADR-8（rename/move-in 补注册） | **撤销**，替换为新责任 | 深层子树不再被监控，问题 10 由范围收缩消解；但引入新边界：**被 watch 的目录自身被删除/改名**时需降级（ADR-9 §新增边界） |
> | 问题 2（注册失败静默 `break`） | 保留，成本降为一行 | ≤2 次 `watch()` 中任一失败即下发 `degraded` |
> | ADR-3 / ADR-5 / ADR-6 / ADR-7 | 保留 | ADR-6 已实施；ADR-5 兼具正确性与洪峰路径分配削减（新增理由，见其「补充」） |
>
> 消解的问题：**1、3、10 由范围收缩消解**（不再有大规模 watch 集合、不再有手动递归、不再有深层子树）；**4 反转为语义对齐**；**7 的刷新放大**在事件天然只来自可见目录后进一步收敛。

---

## 背景

### 前序修复的性质判定：一半根因，一半规避

commit `188a6b2` 修复了「含 node_modules 的大项目内存无界增长至 OOM」（正式版 RSS +5MB/s 到 7GB）。该 bug 有两层因果，修复只根治了第一层：

| 层 | 事实 | 修复是否触及根因 |
|---|---|---|
| 为什么会有 1 万+ watch | `should_ignore` 只作用于事件回调、不作用于注册；`RecursiveMode::Recursive` 让 notify 内部 WalkDir 把 node_modules 全注册 | **是，根因修复**。ignore 从「单向事件过滤」提升为「注册剪枝」，实测本仓库 10056 → 165 个目录（61×） |
| 为什么 1 万+ watch 会 100% CPU + 堆膨胀 | notify 8.2 `handle_inotify` 内层 `read_events` 循环饿死 mio poll（上游缺陷） | **否，规避触发条件**。代码里没有任何防线，只是把常见场景压到阈值以下 |

**可复现的反证**：watch 根是数据库里的任意用户路径（`src/api/files.rs:87` `SELECT path FROM projects`）。把 `~` 加为项目时，剪枝 node_modules / `.` 开头 / target 之后本机仍有 **35330** 个目录 —— 远超 1 万+ 的触发规模，同样的 OOM 会原样复现。

`docs/architecture/backend.md` 现有表述「有界性：watch 目录列表有界于实际业务目录数（剪枝后）」**不是有界性论证**，而是输入依赖量的换词表述，需一并修正。

结论：前序修复正确、必要、收益 61 倍，但不是终态。本计划补上硬上界，并清理排查过程中暴露的静默失效。

### 补充发现：手动递归注册在 macOS/Windows 上是净退化

前序修复无条件把 `RecursiveMode::Recursive` 换成「逐目录 `NonRecursive`」。这是 inotify 特化优化，在另两个 notify 后端上代价截然不同（notify 8.2 源码实证）：

| 平台 / 后端 | 每次 `watch()` 调用的代价 | 165 个目录的实际后果 |
|---|---|---|
| Linux `inotify` | 1 次 `inotify_add_watch`，共用 1 个 fd | 符合预期，本次优化的目标平台 |
| macOS `fsevent` | `watch_inner` = `stop()` + `append_path` + `run()`（`fsevent.rs:308-314`）——**每次调用停掉并重建整个 FSEventStream + runloop**，且 `run()` 会 clone 整个 `recursive_info` HashMap（`fsevent.rs:423`） | **165 次 stream 停止/重建**，启动开销 O(n²)；原 Recursive 只需 1 次 |
| Windows `ReadDirectoryChangesW` | 每 watch = 1 个 `CreateFileW` HANDLE + 1 个未决 IO 请求 + **一个 `[u8; 16384]` buffer**（`windows.rs:40` `BUF_SIZE`、`:52`、`:279`） | 165 × 16KB = **2.6MB** 常驻 buffer + 165 个 HANDLE；上限放到 2000 就是 **32MB** —— 为修内存问题反而引入内存放大 |

项目确为跨平台（`Cargo.toml:50/53` 有 `cfg(unix)` / `cfg(windows)` 依赖分支，10+ 源文件含 `cfg(target_os)`，`backend.md` 记录 `multiplexer` 按 windows/unix 编译期分流），因此这不是假想问题。见 ADR-2。

### 问题清单

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | watch 目录数无显式上界（违反 AGENTS §6 无界累积红线） | `files_watch.rs:239` `collect_watch_dirs` | **P0** |
| 2 | 注册失败静默 `break`：inotify `max_user_watches` 耗尽 / EMFILE 时直接跳出，前端仍显示 `connected` 却永久收不到深层目录事件 | `files_watch.rs:105-108`、`:118-123` | **P0** |
| 3 | 手动递归在 macOS/Windows 上净退化（见上表） | `files_watch.rs:104-123` | **P0** |
| 4 | ignore 规则两处真源不一致，watch 侧仍注册 `dist`/`build`/`venv`/`vendor`（`venv`/`vendor` 吃 watch 预算；`dist` 疑为事件风暴源，**未实测**，见 ADR-4 证据分级） | `files_watch.rs:216` vs `src/fs/mod.rs:601` | P1 |
| 5 | 手写 JSON + `escape_json` 只转义 5 个字符，文件名含其它 C0 控制字符（U+0000–U+001F）产出非法 JSON，被前端 `catch {}` 静默吞掉 | `files_watch.rs:180/190-198/246`、`useFileWatcher.ts:70` | P1 |
| 6 | `broadcast(64)` 的 `Lagged` 静默 `continue`：`git checkout` 切大分支瞬间溢出 → 前端列表停在旧状态且无感知 | `files_watch.rs:143` | P1 |
| 7 | 无事件去抖：单次文件保存产生 N 个 Modify，而前端对**每个**事件都触发一次全量 list（`FileManager.tsx:278-280`）→ N 倍请求放大 | `files_watch.rs` + 前端 | P1 |
| 8 | 路径解析失败返回**立即结束的空流** → EventSource 视为错误 → 每 3s 无限重连，**每次重连后端都重跑全树遍历 + 逐个注册**；`useFileWatcher.ts:76-84` 固定 3s 无退避无上限 | `files_watch.rs:50-56`、`useFileWatcher.ts:76-84` | P1 |
| 9 | 零可观测性：本次定位靠 SIGSTOP 冻结线程试错 | `files_watch.rs` 全局 | P2 |
| 10 | **目录 rename / move-in 后整棵子树不再被监控且无任何提示**（手动递归从 `Recursive` 接过来但未实现的责任，因果链见下） | `files_watch.rs:83` | **P0**（源码已证；**已随 v0.2.15 发布**） |

> 问题 8 有旁证：`scripts/verify-inotify-fix.sh:31-33` 的注释专门警告「the watcher returns an empty stream for unknown paths, which would silently make the test vacuous」—— 连自家验证脚本都得绕开这个静默失效。

### 问题 10 因果链（notify 8.2 源码实证，无需实测即可确认）

目录被 `mv` 进来或改名后，新路径子树完全不被监控，因为**两道补注册机制同时失效**：

1. **notify 侧不补**：notify 对新目录自动补注册的唯一路径是 `add_watch_by_event`（`inotify.rs:61-76`），而它**要求父目录 `is_recursive == true`**（`:69-72`）。本代码全部用 `NonRecursive` 注册 → 条件永远为假 → notify 永不补注册。
2. **本代码侧也不补**：自建钩子只匹配 `EventKind::Create(CreateKind::Folder)`（`files_watch.rs:83`）。而 `mv` 进来的目录在 inotify 侧是 `MOVED_TO`（`inotify.rs:244-267`），被 notify 映射为 `Modify(Name(...))` / rename 事件，**不是** `Create(Folder)` → 钩子不触发。

反向的 `MOVED_FROM` 由 notify 自己 `remove_watch_by_event`（`:233`）处理，**旧路径 watch 不泄漏** —— 这一半没问题。

加重因素：`188a6b2` 已随 **v0.2.15** 打 tag 发布（`git tag --contains 188a6b2` → `v0.2.15`）；且 rename 是被重视的路径，已有两个专门修复（`f7273cb` 外部改名后 drawer 跟随、`8ca8ce3` 图片改名同步）。

---

## 范围与优先级

> **勘误 3 后的现行优先级**（下方原优先级保留为轨迹）：
> - **P0（范围收缩，一次性解决有界性 + 跨平台 + 已发布缺陷）**：**ADR-9**。它消解问题 1 / 3 / 10，并把问题 2 降为一行。目标 = watch 数由构造 ≤2、无全树遍历、监控范围等于渲染范围。
> - **P1（正确性）**：问题 5（ADR-5 serde，兼分配削减）、问题 8（ADR-7 降级挂起 + 退避，含 ADR-9 新增的 `watch_target_gone` 出口）、问题 4 的**反转部分**（事件过滤与 `list_dir` 语义对齐）。
> - **P2 提前为 Phase 0**：问题 9（可观测性最小形态）—— 现有 `100ms` / `500ms` / `2000` 全为推断值，无计数器则任何窗口调参与效果验证都是盲调。
> - **已实施**：ADR-6（问题 6 / 7 的出口合并）。
>
> 原优先级（勘误 3 前）：

- **P0（有界性与跨平台正确性、已发布缺陷）**：问题 1 / 2 / 3 / **10**。目标 = 任何输入下 watch 数有硬上界，超限可解释地降级且用户可见；非 Linux 平台不退化；rename / move-in 后子树仍被监控。
- **P1（正确性与单一真源）**：问题 4 / 5 / 6 / 7 / 8。
- **P2（另行排期）**：问题 9（可观测性）。

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| 引入 `ignore` crate 读 `.gitignore` | 需增依赖，且 `.gitignore` 不覆盖所有重目录（`node_modules` 常被 ignore 但 `dist` 未必），并非本问题的充分解。硬上界 + 共享黑名单已覆盖已确证需求。翻盘条件：出现「用户项目含自定义重目录导致反复触顶上限」的真实反馈。**勘误 3：ADR-9 后彻底作废** —— 不再枚举目录树，无需任何 ignore 清单 |
| watcher 复用池（按 `watch_path` 引用计数 + fan-out） | 实测当前只有一个消费点（`FileManager.tsx:114`；`FileDrawer` 仅 `import type`），inotify 实例上限 128 尚未接近。属「将来可能用到」，按奥卡姆剃刀不做。翻盘条件：新增第二个 watch 消费点，或实测出现 instance 耗尽 |
| 升级 notify 到 9.0.0-rc | 当前锁 8.2.0（`Cargo.lock:1828`），上游 9.0.0-rc.4 已发布，但**我未能核实其是否修了 `handle_inotify` 饿死 mio poll**（crates.io API 返回限流错误，未读到 changelog / issue）。不在无证据情况下升 pre-release 依赖。**后续动作**：查 notify issue tracker 确认；若上游确已修，那才是剩下那一半的真正根因修复，届时单独评估。**勘误 3：ADR-9 后该上游缺陷不再可达**（≤2 watch 远离其触发规模），升级动机从「修 bug」降为「常规维护」 |
| 列表条目数上界（`list_dir` 无 `MAX_ENTRIES`） | 讨论中发现：`list_dir`（`fs/mod.rs:293`）对返回条目数无上限，含十万文件的目录会产出巨大响应体。属**独立于 watch 的既有问题**（手动打开该目录同样触发），不混入本 plan。**后续动作**：登记到 `docs/dev/plans/backlog/`，按 AGENTS §6 单独评估 |


---

## 设计决策（ADR）

### ADR-1 · watch 数硬上界 + 截断降级（而非拒绝服务）

> **状态：机制撤销（勘误 3 / ADR-9）**。下方论证保留为决策轨迹：它正确地指出「剪枝 ≠ 有界」，而 ADR-9 用更小的范围直接满足了该红线（watch 数由构造 ≤2），因此 BFS、截断、`watch_limit` 降级事件均不实施。`walkdir` 依赖仍按本条设想移除——但原因变成「全树遍历本身被删除」。

**决策**：`MAX_WATCH_DIRS = 2000` 常量。`collect_watch_dirs` 到限即停并返回「已截断」标志；截断时经 SSE 下发 `{"kind":"degraded","reason":"watch_limit"}`，已注册部分继续正常工作。

**理由**：上限依据 = 本仓库剪枝后 165 个目录（12× 余量），而触发 notify 忙循环的实测规模是 1 万+，两者间有一个数量级的安全带。选截断而非拒绝服务，是因为「部分监控 + 明确告知」优于「完全不监控」。

**配套项 —— 遍历顺序从 DFS 改 BFS**：当前是深度优先，截断会被某一棵深子树吃满而饿死其他顶层目录；改为按深度递增的 BFS 后，截断语义变成「浅层全覆盖、深层丢弃」，可写成断言。

> **`walkdir` 只支持 DFS**（`walkdir-2/src/lib.rs:161`「Results are returned in depth first fashion」；`contents_first` 只是 DFS 的先叶后枝变体）。因此「保留 walkdir 用其 API 实现 BFS」不成立，真实选项只有：手写 BFS（`VecDeque` + `read_dir`，约 15 行，可同时移除 `Cargo.toml:48` 的 `walkdir` 依赖）、或保留 walkdir 但放弃浅层优先。手写的风险比看上去小：`std::fs::DirEntry::file_type()` **不跟随** symlink，symlink-to-dir 被判为 symlink 而非 dir → 天然无 loop 风险，而 loop 检测正是 `walkdir` 的主要价值（其排序 / min_depth / follow_links 本处一概不用）。

**BFS 必要性的判据 = 「`~` 作为项目根」算不算真实场景**（本 ADR 唯一存疑处）：
- 若算（它正是问题 1 的反证基础，实测剪枝后 35330 目录，必然触顶）—— DFS 截断会把 2000 预算全花在字母序第一个顶层目录的深处，用户实际项目目录**完全不被监控**，表现为「彻底失效」；BFS 下浅层全覆盖，降级从「彻底失效」变成「部分可用」。此时 BFS 不是优化，是降级可用性的前提。
- 若不算 —— 则应选否决项 (d)，且 BFS 变为过度设计（为罕见路径做精心顺序设计）。

**否决项**：
- 限制最大深度（`maxdepth`）—— 深浅项目差异太大，同一个深度上限对 monorepo 和扁平项目意义完全不同，且仍不构成数量上界。
- 静默截断不通知前端 —— 制造「看起来在工作实则半瘫」的静默失效，与问题 2 同类。
- **(d) 从入口限制超大项目根**（添加项目时对目录数过大警告 / 拒绝）—— **保留为待拍板替代方案，非彻底否决**。它更接近根因（不让不合理的输入进来），选它则 BFS 与 `walkdir` 取舍一同消失；代价是把限制加在用户可见的产品行为上（「不得把 home 当工作区」），而该用法对终端管理器而言完全合理。若选 (d)，硬上界仍需保留（红线），只是截断退化为罕见分支。

**翻盘条件**：实测出现正常项目频繁触顶 2000（说明上限选低），或 notify 升级后忙循环消失（说明上限可放宽，但**红线要求的上界本身不取消**）。

**顺带取舍（需拍板）**：见上方 BFS 段与否决项 (d) —— 「手写 BFS + 去 walkdir」与「入口限制」二选一。

### ADR-2 · 手动递归注册按平台分流（`#[cfg]`）

> **状态：撤销（勘误 3 / ADR-9）**。下方跨平台代价分析仍然成立且已沉淀进 `backend.md`，但它只在「手动逐目录注册 N 个 watch」的前提下构成问题；ADR-9 把 N 降到 ≤2 后，三个后端的代价差（O(n²) stream 重建、16KB/watch buffer）都退化为常数级，`#[cfg]` 分叉不需要存在。**这同时是「不为单一实现背书」的正面结果：统一代码路径反而消除了平台差异面。**

**决策**：`#[cfg(target_os = "linux")]` 走「BFS 剪枝 + 逐目录 `NonRecursive` + 上限」；其余平台保留单次 `RecursiveMode::Recursive`。

**理由**：见「补充发现」表 —— macOS 每次 `watch()` 重建整个 FSEventStream（O(n²) 启动），Windows 每 watch 一个 16KB buffer（2000 watch = 32MB）。手动递归的收益（绕开 inotify 规模缺陷）是 Linux 独有的，成本在另两个平台却是净增。**这是对已合并代码的缺陷指认**，不属原 bug 范围，但同一处代码，一并修成本最低。

**副作用（正面）**：分流后 ADR-1 的上限只需服务 Linux 分支，无需为 Windows 的 16KB/watch 单独设一套阈值。

**否决项**：统一压低上限到几百以兼顾 Windows —— 会让 Linux 侧正常项目频繁触顶，用平台 A 的成本惩罚平台 B。

**翻盘条件**：notify 修复 inotify 规模缺陷后，Linux 分支也可回归 `Recursive`，此 `cfg` 分叉随之删除（届时 ignore 剪枝会失效，需重新评估 —— 注意 `Recursive` 下无法跳过 node_modules 是 notify 的既有行为，不随忙循环修复而改变）。

### ADR-3 · 降级/重同步走现有 `change` 事件，扩 `kind` 联合类型

**决策**：新增 `kind: 'resync' | 'degraded'`（`path` 为空串），不新增 SSE event name。

**理由**（均经代码核对）：
- `FileManager.tsx:278-280` 对**任何**事件都触发一次全量 `fetchFiles` → `resync` 天然生效，前端零新增分支。
- `FileDrawer.tsx:139-140` 按 `path` 的文件名匹配后提前 return，`path` 为空串时天然免疫，不会误报「文件被外部删除」。

前端仅需扩 `useFileWatcher.ts:3-7` 的类型，并对 `degraded` 加一处 toast。

**否决项**：新增 `event: status` 通道 —— 语义更干净但要加前端订阅 + hook 返回值扩展，为一个二元状态增加一条链路，收益不抵成本。

**翻盘条件**：降级状态需要携带结构化字段（如已注册数 / 上限值）供 UI 展示时，升级为独立通道。

### ADR-4 · ignore 规则单一真源

> **状态：watch 侧反转（勘误 3 / ADR-9）**。ADR-9 后 watch 侧不再枚举目录树 → 没有第二份剪枝清单需要同步，「两处真源」问题**消失而非被统一**（AGENTS §7 的默认不增实体：删掉一方比抽出公共层更优）。`SKIP_DIRS` 回归为 `search_recursive` 独占，`fs/mod.rs` 内部四个被 `starts_with('.')` 覆盖的死条目（`.git` / `.venv` / `.next` / `.cache`）仍值得清理，但降为搜索侧的局部改善，不再是本 plan 的 P1。
>
> **反转部分（新的 P1）**：`files_watch.rs` 的 `should_ignore` 事件过滤应**删除或与 `list_dir` 对齐**。理由是 `list_dir`（`fs/mod.rs:293`）**不过滤**隐藏项与 `node_modules`，所以列表里明明显示 `.env` / `node_modules/`，其变更事件却被 `should_ignore` 丢掉 —— 视图范围收缩后，「事件过滤严于列表」不再是省事件的优化，而是可见条目不刷新的缺陷。
>
> 下方原论证保留为轨迹（含 `dist`/`build` 的证据分级），其结论不再需要拍板。

**决策**：`src/fs/mod.rs` 暴露 `pub fn is_ignored_component(name: &str) -> bool` + 精简后的 `HEAVY_DIRS`，watch 侧与搜索侧共用。

**理由**：两处语义已核对为**等价** —— `fs/mod.rs:644` 是 `name.starts_with('.') || SKIP_DIRS.contains(name)`，`files_watch.rs:216-224` 是逐段的同一判断；差异仅在黑名单条目。且 `SKIP_DIRS` 里 `.git` / `.venv` / `.next` / `.cache` 四项被 `starts_with('.')` 完全覆盖，是死条目，合并时一并清理。命中 AGENTS §7.1（同一判断出现在 ≥2 处 → 立单一真源）。

`HEAVY_DIRS` 候选全集 = `node_modules` / `target` / `__pycache__` / `venv` / `vendor` / `dist` / `build`。
实际首批取前 5 项（见下方「实施调整」），`dist` / `build` 待实测。

**代价比初估小**（落盘后核实）：`SKIP_DIRS` 只在 `search_recursive`（`fs/mod.rs:644`）使用，**`list_dir`（`:293`）不过滤**。所以 watch 侧忽略某目录只意味着「不自动刷新」—— 用户仍能正常浏览 / 打开 / 编辑 `dist/` 里的文件，手动刷新即可见。这也排除了「全禁 / 仅不 watch」两级黑名单的必要：一级列表足够。

**四个新增目录属于两类原因，证据强度不同**：

| 目录 | 纳入理由 | 证据强度 |
|---|---|---|
| `node_modules`（已有） | 高频写 → 事件风暴 + 目录数极大 | **实测**（10056→165，RSS 归因已验） |
| `venv` / `vendor` | 目录数大 → 吃 watch 预算 | 推断（本机无样本；site-packages 典型数百至数千目录）。但**收益无争议** —— 没人需要 site-packages 自动刷新 |
| `dist` / `build` | 高频写 → 事件风暴 | **仅推断，未实测**。且 `vite dev` 的 HMR 走内存不落盘，只有 `vite build` 才写 `dist` |

支持纳入 `dist` 的论证（非数据）：风暴发生在**构建进行中**，而那时用户注意力在终端而非文件列表；「构建完想看 dist 自动刷新」这个损失场景恰好与风暴场景重合但错峰。

**实施调整（需拍板）**：改为**分批** —— 先只加 `venv` / `vendor`（收益无争议、语义变更几乎不可感）；`dist` / `build` 待一次实测（跑 `pnpm build` 数事件速率）后再定。理由：按证据分级推进，不用未实测的推断改用户可见语义。若选择一次到位（全 7 项），CHANGELOG **必须**写明 `dist`/`build` 不再自动刷新。

**否决项**：只在 watch 侧补齐条目、不动 `fs` 侧 —— 留下两份需同步维护的清单，正是本条要消除的问题。

### ADR-5 · JSON 改 serde

**决策**：`#[derive(Serialize)] struct FileChange`，`#[serde(rename_all = "camelCase")]` 保住 `newPath`，`Option` + `skip_serializing_if` 维持现有 wire format；删除 `escape_json`（成为死代码）。

**理由**：修的是真实正确性缺陷（问题 5），不是风格偏好。`serde_json` 已是既有依赖（`Cargo.toml:18`），不增实体。前端零改动。

**否决项**：给 `escape_json` 补全 C0 控制字符转义 —— 手写序列化的正确性负担会一直存在（下一个字段、下一个转义规则都要重来），且已有依赖可用。

> **补充理由（勘误 3）**：serde 化同时是**洪峰路径上的分配削减**，不只是正确性修复。`escape_json` 是 5 次链式 `String::replace`（`:310-316`），即使无字符命中也产生 5 次全量拷贝；叠加 `to_string_lossy` + `format!` + `merge_pending` 的 `change.clone()`（`:215`）+ broadcast 内部克隆，单个事件路径约 9 次分配。这正是「1 万+ watch 时高频分配致堆膨胀」里可由本项目控制的那一半。
>
> **顺带（同一改动区域，AGENTS §4）**：`merge_pending` 同时维护 `Vec<String>` + `HashSet<String>` 两份字符串。前端对任何事件都是全量刷新、不依赖事件顺序，因此可只留 `HashSet` 并 drain，省掉每事件一次 clone 与一份存储。

### ADR-6 · 去抖与 Lagged 收敛到同一条出口

**决策**：在 SSE generator 侧做 100ms 窗口合并，按 `(kind, path)` 去重后批量 yield；窗口内 pending 表设 `MAX_PENDING` 上限，超限即清空并下发单条 `resync`；`broadcast` 的 `Lagged` 走**同一条** `resync` 出口。

**理由**：
- 去抖收益是硬的：前端对每个事件全量 list（`FileManager.tsx:278-280`），单次保存的 N 个 Modify 会放大成 N 次请求。
- 放 generator 侧而非 blocking 线程侧：那个 250ms 循环（`files_watch.rs:110-131`）已同时承担关停检测 + 新目录补注册，再塞去抖会变成三职责怪物。
- 两个不同溢出源（channel Lagged / 窗口内洪峰）收敛到一处处理，符合 §7 抽象成立判据 —— 新增同类溢出源只需接同一出口。
- pending 表设上限是 §6 红线要求：合并缓冲本身也是累积结构。

**否决项**：放大 `broadcast` 容量了事 —— 把无界推给更大的有界，洪峰仍会溢出，且不解决请求放大。

**翻盘条件**：100ms 延迟被感知为迟滞（人眼阈值下，预计不会）→ 降到 50ms。

### ADR-7 · 空流改降级挂起 + 前端指数退避

**决策**：后端路径解析失败时先下发 `{"kind":"degraded","reason":"unresolved_path"}`，再 keep-alive 挂住（不立即结束流）；前端退避 3s→30s，`onopen` 重置。

**理由**：现状是「立即结束的空流 → EventSource 判错 → 3s 重连 → 后端重跑全树遍历 + 逐个注册」的自激循环，既烧 CPU 又掩盖真实原因。挂住占 1 个连接、**0 个 inotify watch**，比无限重连划算。

**否决项**：只加前端退避不改后端 —— 退避把频率从 3s 降到 30s，自激循环仍在，且用户永远看不到「路径没解析出来」这个真实原因。

### ADR-8 · rename / move-in 的补注册：放宽钩子匹配条件，不引入注册表

> **状态：撤销（勘误 3 / ADR-9）**。问题 10 的因果链依赖「手动 `NonRecursive` 递归覆盖整棵子树」这一前提；ADR-9 删除该前提后，深层子树本就不在监控范围内，「rename 后子树失监」不再是缺陷。**但责任没有凭空消失，只是换了形态**：见 ADR-9 §新增边界（被 watch 的目录自身被删除/改名）。已发布缺陷（v0.2.15）的用户可见症状同样由 ADR-9 消除——因为深层变更不再需要被感知。

**决策**：把 `files_watch.rs:83` 的钩子从 `EventKind::Create(CreateKind::Folder)` 扩到「`Create(Folder)` 加 rename-To/Both 事件且目标路径实际是目录」，沿用现有 `new_dir_tx` 通道。

**理由**：消费循环已经会对收到的目录补注册并 `collect_watch_dirs` 补整棵子树（`:111-118`），所以修法本质是**放宽一个 `if` 的匹配条件**，不需新建状态。这推翻了初估的「修法可能需引入 path→WatchDescriptor 注册表」担心。

**否决项**：
- 自建 `path → WatchDescriptor` 注册表并在 rename 时 unwatch 旧子树 + rewatch 新子树 —— 旧路径侧 notify 已自行处理（`inotify.rs:233` `remove_watch_by_event`），自建注册表是重复造轮且与当前无状态设计冲突。
- 回退到 `RecursiveMode::Recursive` 以让 notify 自己补注册（其 `is_recursive` 分支会生效）—— 等于放弃前序修复，node_modules 重新被全量注册，OOM 回归。

**翻盘条件**：若实测发现同一目录既走 rename-To 又走 Create 导致 watch 预算被重复消耗，则需在消费侧加幂等判重（notify 对已注册路径会合并 watchmask，见 `inotify.rs:439-441`，预计不会真正双计，但需验）。

### ADR-9 · watch 范围收缩为视图范围（当前浏览目录 + 打开文件所在目录）

**决策**：删除全树递归监控。watch 集合 = **当前列表目录** + **抽屉打开文件所在目录**，各自 `NonRecursive`，数量由构造恒定 ≤2。前端 watch 目标变化时重连 SSE。

#### 错配实证（决策依据，已核对全部消费点）

| 消费者 | 实际需要的范围 | 代码依据 |
|---|---|---|
| `FileManager` 文件列表 | **单个目录**（扁平视图，无树形展开、无虚拟滚动） | `FileManager.tsx:180` `fetchFiles(path)` → `list_dir` 单目录（`fs/mod.rs:293`） |
| `FileDrawer` 已打开文件 | 该文件所在目录 | `FileDrawer.tsx:135-163` |
| `FilePreview` 已打开文件 | 同上 | `FilePreview.tsx:34-48` |

对照供给端：`collect_watch_dirs`（`files_watch.rs:299`）递归全树，本仓库 165 个目录，`~` 作项目根时 35330 个。**供给 : 消费 = 35330 : 2。**

用户确认的产品预期（2026-08-16）：「文件管理器只需感知当前浏览目录 + 打开的文件，用户看不到的地方不用自动刷新」。

#### 收益（按开销分段，与 ADR-1/6 的覆盖面对照）

| 开销段 | 现状 | ADR-9 后 |
|---|---|---|
| **建立期**（每次连接 / 重连 / 切回 FILES tab） | 全树 `read_dir` 遍历 + N 次 `inotify_add_watch`（N ≤ 35330；冷缓存下是秒级 IO，占 tokio blocking 池） | ≤2 次 `inotify_add_watch`，无遍历 |
| **稳态** | 内核约 1KB/watch → `~` 场景约 35MB | 约 2KB |
| **洪峰** | 全树任意位置的写入都进事件管道（ADR-6 在出口合并） | 只有可见目录的直接子项产生事件，**从源头消除**而非在出口合并 |
| **刷新期** | 任意位置事件 → 一次全量 `list_dir`：每条目 2 次 stat + **每个子目录一次完整 `read_dir`**（`fs/mod.rs:334-343`，上限 1000/目录） | 只有可见目录变化才刷新，无关刷新归零 |

> 刷新期此前**完全未被本 plan 覆盖**，而它的单次成本被低估：查看含 300 个子目录的目录，一次刷新 = 300 次 `read_dir` + 600 次 stat。ADR-6 的去抖只减少次数，不减少单次成本；ADR-9 直接砍掉触发条件。

**顺带修掉的正确性缺陷**：`FileDrawer.tsx:139` / `FilePreview.tsx:40` 用 `path.split('/').pop()` **只比文件名** —— 全树监控下，项目里任何位置的 `index.ts` 变动都会让抽屉里打开的 `index.ts` 重载（假阳性）。范围收缩后应一并改为**比完整相对路径**（AGENTS §4 局部改善，同一改动区域）。

#### 协议设计

`/files/watch?session=<id>&path=<rel>&drawer=<rel>` —— 两个语义不同的具名槽位，而非可重复参数或逗号分隔列表。

**理由**：槽位数由协议本身限制为 2，「watch 数有界」成为**类型级事实**而不是运行期检查；逗号分隔会与合法文件名冲突（`,` 在文件名中合法）。`path` 沿用 `FileQuery.path`（`files.rs:32`）的既有语义与 `fs::sanitize_path` 边界校验（含 `is_inside_git_toplevel` 兜底，`fs/mod.rs:84`），与列表接口的越界语义天然一致：列表能看的目录就能 watch，看不到的（越界且无 git 兜底）返回 `degraded` 而不是静默空流（ADR-7）。

`drawer` 与 `path` 解析到同一目录时只注册一次（notify 对已注册路径合并 watchmask，`inotify.rs:439-441`）。

#### 重连成本与 inotify instance 有界性

导航即重连，需论证不制造新的资源问题：

- **单次重连成本**：1 次 HTTP 请求 + 1 个 `spawn_blocking` 线程 + 1 个 inotify **instance** + ≤2 次 `inotify_add_watch`。相比现状的全树遍历，成本塌缩到近零 —— 这也顺带让 ADR-7 的「重连风暴」危害降级（但不取消 ADR-7，见其状态）。
- **instance 上限是真实约束**：`max_user_instances = 128`（本机实测；`max_user_watches = 524288` 反而宽松）。旧连接由 `shutdown_rx.recv_timeout(250ms)` 的 `Disconnected` 分支回收（`files_watch.rs:140-146`），**最坏 250ms 的重叠窗口**。
- **有界性论证**：前端对 watch 目标变化加去抖（`WATCH_TARGET_DEBOUNCE_MS`，建议 300ms > 250ms 回收窗口），使连续导航不产生每步一条连接；稳态并发 instance 数 = 打开的 FileManager 数（当前架构为 1）。**这是本 ADR 唯一新增的累积面，必须带上限与单测**（AGENTS §6）。

#### 新增边界：被 watch 的目录自身消失（接过 ADR-8 撤销后的责任）

全树监控时，浏览目录被删除/改名仍有父目录的 watch 兜底报告；范围收缩后，该目录的 watch 被 inotify 标记 `IGNORED`，**流会静默变哑**。处理：

1. 事件回调侧识别 watch 根自身的 `Remove` / `Modify(Name)` → 下发 `{"kind":"degraded","reason":"watch_target_gone"}`（复用 ADR-3 通道）。
2. 前端收到即触发一次刷新 —— 列表请求会因目录不存在而失败，走既有错误路径（回退到 following 模式），语义正确。

**否决项**：
- **保留全树监控 + 前端相关性过滤**（讨论中的「路线 C」）—— 只覆盖刷新期，建立期 / 稳态 / 洪峰照旧，且 ADR-1/2/8 的全套机制仍要实施与长期维护。用更大的实现成本换更小的收益面。
- **watch 目标改用双向通道更新（不重连）** —— 需要新增一条控制协议（SSE 单向 → 得配 POST 端点或 WS），为一个 ≤2 元素的集合引入协议复杂度；重连成本已塌缩到 ≤2 次 syscall，收益不抵成本。**翻盘条件**：实测导航时的重连造成可感知闪烁或 instance 争用。
- **watch 当前目录 + 一层子目录**（让子目录的条目数徽标 `size` 保持新鲜）—— 子目录条目数是列表的次要信息，为它把 watch 数变成「1 + 子目录数」（无界，回到 ADR-1 的问题），得不偿失。手动刷新即可。

**翻盘条件（明确记录，便于将来判断）**：文件管理器引入**树形展开**、**递归 git 状态徽标**或**跨目录搜索结果实时更新**中任一项 —— 届时 watch 集合改为「已展开 / 已渲染节点集合」，仍有界于**可见节点数**（而非磁盘目录数），ADR-9 的核心论证（监控范围 = 渲染范围）不变，只是集合变大且需重新引入上限常量。

---

## 实施分期

> **现行分期（勘误 3 / ADR-9）**。原分期表保留在本节末作轨迹。

| Phase | 内容 | 改动文件 | 依赖 | commit |
|---|---|---|---|---|
| **0** | 可观测性最小形态（问题 9 提前）：连接建立时 `debug!(watch_path, drawer_path)`、`degraded` / `resync` 各一条 `warn!`/`debug!` 计数 —— **先于调参，用于验证 ADR-9 的效果而非事后解释** | `src/api/files_watch.rs` | 无 | `feat(files_watch): 补 watch 生命周期与降级事件日志` |
| **1** | **ADR-9 后端**：`WatchQuery` 加 `path` / `drawer` → `fs::sanitize_path` 解析 → ≤2 次 `NonRecursive` 注册；删除 `collect_watch_dirs` / `new_dir_tx` 补注册通道 / `is_ignored_dir` / `Cargo.toml` 的 `walkdir`；问题 2（失败 → `warn!` + `degraded`）；ADR-3 降级通道；`watch_target_gone` 出口；问题 4 反转（事件过滤与 `list_dir` 对齐） | `src/api/files_watch.rs`、`Cargo.toml` | Phase 0 | `perf(files_watch): watch 范围收缩为当前视图目录` |
| **2** | **ADR-9 前端**：`useFileWatcher` 增 `watchPath` / `drawerDir` 参数 + 目标变更去抖（`WATCH_TARGET_DEBOUNCE_MS = 300`）；`FileManager` 传当前列表目录；`FileDrawer` / `FilePreview` 匹配由**文件名**改**完整相对路径**（消除假阳性） | `frontend/src/hooks/useFileWatcher.ts`、`FileManager.tsx`、`FileDrawer.tsx`、`FilePreview.tsx` | Phase 1 | `perf(files): 文件监听按视图目录订阅，抽屉按全路径匹配` |
| **3** | ADR-5（serde + `merge_pending` 去掉 clone） | `src/api/files_watch.rs` | 无（可与 1/2 并行） | `fix(files_watch): 改 serde 序列化，修控制字符产生非法 JSON` |
| **4** | ADR-7（空流改降级挂起 + 前端指数退避），含 `unresolved_path` / `watch_target_gone` 两个降级理由 | `src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts` | Phase 1/2 | `fix(files_watch): 路径不可解析改降级挂起；前端重连退避` |
| **5** | 调参复核（依赖 Phase 0 的数据）：事件天然只来自可见目录后，`SSE_REFRESH_DEBOUNCE_MS`（前端 500ms）与 `DEBOUNCE_WINDOW_MS`（后端 100ms）是否可下调以改善响应感 | `FileManager.tsx`、`src/api/files_watch.rs` | Phase 0-4 | `perf(files): 依实测下调刷新去抖窗口` |

**撤销不实施**：ADR-1 的 BFS / 截断 / `watch_limit`、ADR-2 的 `#[cfg]` 分流、ADR-4 的 `HEAVY_DIRS` 共享清单、ADR-8 的钩子放宽（理由见各 ADR 状态戳）。

<details>
<summary>原分期表（勘误 3 前，保留作轨迹）</summary>

| Phase | 内容 | 改动文件 | 依赖 | commit |
|---|---|---|---|---|
| 1 | ADR-1（上界 + BFS + 截断）、ADR-2（`cfg` 分平台）、ADR-3（降级通道）、**ADR-8（rename/move-in 补注册）**、问题 2（`break` → `warn!` + 上报） | `src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts`、`Cargo.toml`（可选移除 `walkdir`） | 无 | `fix(files_watch): watch 数硬上界与截断降级、平台分流、rename 子树补注册` |
| 2 | ADR-4（单一真源） | `src/fs/mod.rs`、`src/api/files_watch.rs` | Phase 1 | `refactor(fs): ignore 规则单一真源，watch 与搜索共用` |
| 3 | ADR-5（serde） | `src/api/files_watch.rs` | 无（可与 2 并行） | `fix(files_watch): 改 serde 序列化，修控制字符产生非法 JSON` |
| 4 | ADR-6（去抖 + Lagged）、ADR-7（空流 + 退避） | `src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts` | Phase 1（复用 `resync`/`degraded` 类型） | `fix(files_watch): 事件去抖与溢出重同步；前端重连退避` |
| 5 | 问题 9（可观测性：启动时 `debug!(watch_dirs)`、超阈值 `warn!`） | — | — | 另行排期 |

原 Phase 5（问题 10 验证）已并入 Phase 1（勘误 1）。

</details>

---

## 验收清单

> 勘误 3 后重写。被撤销 ADR 的验收项一并移除（BFS 序、`cargo check --target`、`is_ignored_component` 单一真源、rename 子树补注册）。

**后端（ADR-9）**
- [ ] watch 集合恒定 ≤2：`path` 与 `drawer` 解析到同一目录时只注册一次；单测覆盖「两参数相同 / 不同 / `drawer` 缺省」三态
- [ ] `path` 越界（不在 workspace 根内且无 git toplevel 兜底）→ 下发 `degraded{reason:"unresolved_path"}`，**不是空流**（回归问题 8 与 `scripts/verify-inotify-fix.sh:31-33` 记录的静默失效）
- [ ] `path` 语义与 `list_files` 一致：列表能打开的目录都能 watch（含 `resolve_effective_workspace_root` 兜底命中的跨 worktree 场景）
- [ ] 注册失败（≤2 次中任一）有 `warn!` 且下发 `degraded`
- [ ] `watch_target_gone`：`mkdir a` → watch `a` → `rmdir a` / `mv a b`，断言收到 `degraded{reason:"watch_target_gone"}`（**ADR-9 新增边界，无此项则退化为静默变哑**）
- [ ] 事件过滤与 `list_dir` 对齐：列表里可见的 `.env` / `node_modules/` 条目，其变更**能**触发事件（问题 4 反转的直接回归）
- [ ] 非直接子项不产生事件：watch `a` 时 `touch a/sub/f` 不触发（`NonRecursive` 语义断言，也是范围收缩的正向证明）
- [ ] serde wire format 单测：文件名含 `"`、`\n`、U+0008、中文 —— 输出可被 `serde_json::from_str` 回读（问题 5）
- [ ] 去抖合并纯函数单测保持通过（ADR-6 已实施部分的回归）
- [ ] `walkdir` 从 `Cargo.toml` 移除后 `cargo build` 通过（确认无其他使用点）

**前端**
- [ ] `FileChangeEvent.kind` 扩展 `degraded` 后 `tsc` 零新增错误
- [ ] watch 目标去抖单测：300ms 内连续导航 N 次只产生 1 次连接（**instance 有界性的直接验收，AGENTS §6**）
- [ ] `degraded` 触发 toast；`resync` 触发全量刷新
- [ ] `useFileWatcher` 退避序列单测（3s→6s→…→30s 封顶，`onopen` 重置）；基建参考 `frontend/src/utils/path.test.ts`
- [ ] `FileDrawer` / `FilePreview` 按**完整相对路径**匹配：打开 `src/index.ts` 时修改 `docs/index.ts` **不**触发重载（假阳性回归）
- [ ] `FileDrawer` 收到 `resync`/`degraded` 不误报「文件被外部删除」

**边界与降级**
- [ ] 把 `~` 加为项目后：watch 数 = ≤2（对比现状 35330）、RSS 稳定、无建立期遍历延迟 —— **本计划核心验收，对应「反证」场景**
- [ ] `scripts/verify-inotify-fix.sh` 仍通过（fd 不泄漏）；脚本内针对空流的绕行注释可随 ADR-7 移除
- [ ] 连续导航 20 个目录后 `ls /proc/<pid>/fd | grep inotify | wc -l` 稳定不增长（instance 回收，250ms 窗口）
- [ ] 无效 session 时不再出现 3s 一次的重连风暴

**质量门禁**
- [ ] `cargo clippy` / `rustfmt` / `tsc` 零新增告警；全量测试通过

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **ADR-9：用户在 A 目录浏览时 B 目录的变化不再自动反映** | 用户已确认为**预期行为**（「用户看不到的地方不用自动刷新」）。且 UI 本就不渲染 B 的内容 → 当前无功能损失。翻盘条件写入 ADR-9（树形展开 / 递归 git 徽标 / 搜索结果实时更新） |
| **ADR-9：导航即重连，短时间产生多条 SSE 连接 → inotify instance（上限 128）争用** | 前端 300ms 目标去抖（> 后端 250ms 回收窗口）+ 验收项显式测 fd 稳定性；这是本 ADR 唯一新增累积面，按 §6 带上限与单测 |
| **ADR-9：被 watch 的目录自身消失后流静默变哑** | 新增 `watch_target_gone` 降级出口 + 验收项；这是从 ADR-8 撤销处**接过来**的责任，不是遗漏 |
| ADR-6 引入 ≤100ms 刷新延迟（叠加前端 500ms 最坏 600ms） | 人眼阈值内；Phase 5 依 Phase 0 的实测数据复核下调（范围收缩后请求放大已小，可换取响应感） |
| ADR-5 改 serde 时 wire format 漂移（`newPath` 大小写、字段缺省） | `#[serde(rename_all = "camelCase")]` + `skip_serializing_if`，并以「前端零改动」为验收标准 |
| 移除 `walkdir` 依赖影响其他模块 | 先 `rg -n 'walkdir'` 确认仅 `files_watch.rs` 使用；`cargo build` 作门禁 |

<details>
<summary>已撤销 ADR 的原风险项（保留作轨迹）</summary>

| 风险 | 缓解 |
|---|---|
| ADR-4 的语义变更用户可察觉（`dist/` 不再刷新） | **勘误 3 后不存在**：watch 侧不再有 ignore 清单 |
| ADR-2 的非 Linux 分支缺真机验证 | **勘误 3 后不存在**：无平台分叉 |
| BFS 手写替代 `walkdir` 引入新遍历 bug | **勘误 3 后不存在**：无全树遍历 |
| ADR-8 扩大钩子匹配面，可能对同一目录双重注册 | **勘误 3 后不存在**：无补注册钩子 |

</details>

---

## 文档闭环

| 文档 | 更新内容 |
|---|---|
| `docs/architecture/backend.md` §File watcher | **修正现有错误表述**（「有界性：有界于实际业务目录数」）→ 改为 ADR-9 的有界性论证：**watch 集合 = 视图范围，由协议槽位数限制为 ≤2**；记录 `path` / `drawer` 参数与降级理由枚举（`unresolved_path` / `watch_target_gone` / `resync`）；跨平台代价差异表**仍值得保留**（它是「为何不做手动递归」的依据） |
| `docs/architecture/frontend.md` | `useFileWatcher` 参数变更（`watchPath` / `drawerDir` + 目标去抖）；`FileDrawer`/`FilePreview` 改全路径匹配 |
| `docs/dev/debug-patterns/resource-lifecycle.md` 模式 8 | 2026-08-16 案例补两句结论：**① 剪枝 ≠ 有界；② 先问「谁在消费」再优化供给** —— 本例的最大收益来自把监控范围对齐渲染范围，而非把过大的范围优化得更快 |
| `docs/dev/performance-and-safety.md` §P1 | 登记界：`MAX_PENDING`（已实施）、`WATCH_TARGET_DEBOUNCE_MS`（前端连接节流）；删除计划中的 `MAX_WATCH_DIRS`（由协议构造保证，改为记一条「结构性有界」范例） |
| `docs/dev/plans/backlog/` | 新增条目：`list_dir` 返回条目数无上界（独立于 watch，见「不纳入范围」） |
| `AGENTS.md` 文档索引 | 本 plan 条目已存在；触发条件补 `FileDrawer.tsx` / `FilePreview.tsx` |
| `CHANGELOG.md` | 一条：文件监听改为按当前视图目录订阅（大项目内存与 CPU 显著下降）+ 抽屉文件同名假阳性重载修复 + 非法 JSON 修复 |

---

## 待拍板事项

> 原第 1 项（ADR-4 分批 vs 一次到位）与第 2 项（ADR-1 BFS vs 入口限制）**均因 ADR-9 作废** —— watch 侧不再有 ignore 清单，也不再有全树遍历。原第 3 项已于勘误 1 决完。

**已决（2026-08-16，用户确认）**：
1. **watch 范围界定** → 「当前浏览目录 + 打开文件所在目录」，用户看不到的地方不自动刷新（ADR-9 成立前提）。
2. **watch 目标更新方式** → **导航时重连 SSE**（不新增双向控制通道）。依据：重连成本已从「全树遍历」塌缩到 ≤2 次 syscall，为 ≤2 元素的集合引入协议复杂度不成立（ADR-9 否决项 2，含翻盘条件）。
3. **可观测性提前** → 作为 Phase 0 先行。依据：`100ms` / `500ms` 两个窗口均为推断值，无计数器则 Phase 5 的调参与 ADR-9 的效果验证都只能靠体感。

**剩余待确认（不阻塞 Phase 0-1）**：
- Phase 5 的调参目标：范围收缩后是否把前端 `SSE_REFRESH_DEBOUNCE_MS` 从 500ms 下调（候选 200ms）？建议等 Phase 0 的事件速率数据再定，不预先拍。

