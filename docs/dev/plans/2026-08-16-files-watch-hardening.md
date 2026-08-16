# 文件监控有界化与正确性加固（`/files/watch`）

> 状态：**设计稿（2026-08-16）**，待批准后实施
> 触发条件：修改 `src/api/files_watch.rs`、`src/fs/mod.rs` 的 ignore 规则（`SKIP_DIRS` / `search_recursive`）、`frontend/src/hooks/useFileWatcher.ts`、`frontend/src/components/FileManager/FileManager.tsx` 的文件变更刷新链路中任一项前**必读**
> 关联：`docs/architecture/backend.md` §File watcher、`docs/dev/debug-patterns/resource-lifecycle.md` 模式 8（外部注册集无界家族）、`docs/dev/performance-and-safety.md` §P1（无界累积）、`scripts/verify-inotify-fix.sh`
> 前序修复：commit `188a6b2`（手动递归注册跳过 node_modules）、`fbeb05d` / `9277493`（inotify fd 泄漏）

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
| 4 | ignore 规则两处真源不一致，watch 侧仍注册 `dist`/`build`/`venv`/`vendor` —— `vite build` 猛写 `dist/` 正是事件风暴源 | `files_watch.rs:216` vs `src/fs/mod.rs:601` | P1 |
| 5 | 手写 JSON + `escape_json` 只转义 5 个字符，文件名含其它 C0 控制字符（U+0000–U+001F）产出非法 JSON，被前端 `catch {}` 静默吞掉 | `files_watch.rs:180/190-198/246`、`useFileWatcher.ts:70` | P1 |
| 6 | `broadcast(64)` 的 `Lagged` 静默 `continue`：`git checkout` 切大分支瞬间溢出 → 前端列表停在旧状态且无感知 | `files_watch.rs:143` | P1 |
| 7 | 无事件去抖：单次文件保存产生 N 个 Modify，而前端对**每个**事件都触发一次全量 list（`FileManager.tsx:278-280`）→ N 倍请求放大 | `files_watch.rs` + 前端 | P1 |
| 8 | 路径解析失败返回**立即结束的空流** → EventSource 视为错误 → 每 3s 无限重连，**每次重连后端都重跑全树遍历 + 逐个注册**；`useFileWatcher.ts:76-84` 固定 3s 无退避无上限 | `files_watch.rs:50-56`、`useFileWatcher.ts:76-84` | P1 |
| 9 | 零可观测性：本次定位靠 SIGSTOP 冻结线程试错 | `files_watch.rs` 全局 | P2 |
| 10 | 目录 rename 后 notify 路径映射可能失配（inotify watch 绑 inode 不绑路径；Recursive 模式下 notify 内部自维护映射，手动递归把该责任接了过来但未实现） | `files_watch.rs:83-92` | P2（**未验证** ） |

> 问题 8 有旁证：`scripts/verify-inotify-fix.sh:31-33` 的注释专门警告「the watcher returns an empty stream for unknown paths, which would silently make the test vacuous」—— 连自家验证脚本都得绕开这个静默失效。

---

## 范围与优先级

- **P0（有界性与跨平台正确性）**：问题 1 / 2 / 3。目标 = 任何输入下 watch 数有硬上界，超限可解释地降级且用户可见；非 Linux 平台不退化。
- **P1（正确性与单一真源）**：问题 4 / 5 / 6 / 7 / 8。
- **P2（另行排期）**：问题 9 / 10。问题 10 **先验证再定方案**，不在本轮承诺修法。

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| 引入 `ignore` crate 读 `.gitignore` | 需增依赖，且 `.gitignore` 不覆盖所有重目录（`node_modules` 常被 ignore 但 `dist` 未必），并非本问题的充分解。硬上界 + 共享黑名单已覆盖已确证需求。翻盘条件：出现「用户项目含自定义重目录导致反复触顶上限」的真实反馈 |
| watcher 复用池（按 `watch_path` 引用计数 + fan-out） | 实测当前只有一个消费点（`FileManager.tsx:114`；`FileDrawer` 仅 `import type`），inotify 实例上限 128 尚未接近。属「将来可能用到」，按奥卡姆剃刀不做。翻盘条件：新增第二个 watch 消费点，或实测出现 instance 耗尽 |
| 升级 notify 到 9.0.0-rc | 当前锁 8.2.0（`Cargo.lock:1828`），上游 9.0.0-rc.4 已发布，但**我未能核实其是否修了 `handle_inotify` 饿死 mio poll**（crates.io API 返回限流错误，未读到 changelog / issue）。不在无证据情况下升 pre-release 依赖。**后续动作**：查 notify issue tracker 确认；若上游确已修，那才是剩下那一半的真正根因修复，届时单独评估 |

---

## 设计决策（ADR）

### ADR-1 · watch 数硬上界 + 截断降级（而非拒绝服务）

**决策**：`MAX_WATCH_DIRS = 2000` 常量。`collect_watch_dirs` 到限即停并返回「已截断」标志；截断时经 SSE 下发 `{"kind":"degraded","reason":"watch_limit"}`，已注册部分继续正常工作。

**理由**：上限依据 = 本仓库剪枝后 165 个目录（12× 余量），而触发 notify 忙循环的实测规模是 1 万+，两者间有一个数量级的安全带。选截断而非拒绝服务，是因为「部分监控 + 明确告知」优于「完全不监控」。

**配套必需项 —— 遍历顺序必须从 DFS 改 BFS**：当前 `WalkDir` 是深度优先，截断会被某一棵深子树吃满而饿死其他顶层目录，退化行为不可解释也不可测。改为按深度递增的 BFS 后，截断语义变成「浅层全覆盖、深层丢弃」—— 用户正在浏览的路径大概率仍被监听，且可写成断言。

**否决项**：
- 限制最大深度（`maxdepth`）—— 深浅项目差异太大，同一个深度上限对 monorepo 和扁平项目意义完全不同，且仍不构成数量上界。
- 静默截断不通知前端 —— 制造「看起来在工作实则半瘫」的静默失效，与问题 2 同类。

**翻盘条件**：实测出现正常项目频繁触顶 2000（说明上限选低），或 notify 升级后忙循环消失（说明上限可放宽，但**红线要求的上界本身不取消**）。

**顺带取舍（需拍板）**：BFS 用 `VecDeque` + `std::fs::read_dir` 手写约 15 行即可实现，则前序修复引入的 `walkdir` 依赖（`Cargo.toml:48`）可移除。倾向这么做（奥卡姆剃刀：少一个依赖、且 `filter_entry` 的剪枝语义手写同样清晰）。

### ADR-2 · 手动递归注册按平台分流（`#[cfg]`）

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

**决策**：`src/fs/mod.rs` 暴露 `pub fn is_ignored_component(name: &str) -> bool` + 精简后的 `HEAVY_DIRS`，watch 侧与搜索侧共用。

**理由**：两处语义已核对为**等价** —— `fs/mod.rs:644` 是 `name.starts_with('.') || SKIP_DIRS.contains(name)`，`files_watch.rs:216-224` 是逐段的同一判断；差异仅在黑名单条目。且 `SKIP_DIRS` 里 `.git` / `.venv` / `.next` / `.cache` 四项被 `starts_with('.')` 完全覆盖，是死条目，合并时一并清理。命中 AGENTS §7.1（同一判断出现在 ≥2 处 → 立单一真源）。

`HEAVY_DIRS` = `node_modules` / `target` / `__pycache__` / `venv` / `dist` / `build` / `vendor`。

**⚠️ 行为变更（需拍板）**：watch 侧将新增忽略 `dist` / `build` / `venv` / `vendor`。收益是消掉主要事件风暴源；代价是**用户手动改 `dist/` 里的文件不再自动刷新列表**。这改了用户可见语义，须显式确认，并写入 CHANGELOG。

**否决项**：只在 watch 侧补齐条目、不动 `fs` 侧 —— 留下两份需同步维护的清单，正是本条要消除的问题。

### ADR-5 · JSON 改 serde

**决策**：`#[derive(Serialize)] struct FileChange`，`#[serde(rename_all = "camelCase")]` 保住 `newPath`，`Option` + `skip_serializing_if` 维持现有 wire format；删除 `escape_json`（成为死代码）。

**理由**：修的是真实正确性缺陷（问题 5），不是风格偏好。`serde_json` 已是既有依赖（`Cargo.toml:18`），不增实体。前端零改动。

**否决项**：给 `escape_json` 补全 C0 控制字符转义 —— 手写序列化的正确性负担会一直存在（下一个字段、下一个转义规则都要重来），且已有依赖可用。

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

---

## 实施分期

| Phase | 内容 | 改动文件 | 依赖 | commit |
|---|---|---|---|---|
| 1 | ADR-1（上界 + BFS + 截断）、ADR-2（`cfg` 分平台）、ADR-3（降级通道）、问题 2（`break` → `warn!` + 上报） | `src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts`、`Cargo.toml`（可选移除 `walkdir`） | 无 | `fix(files_watch): watch 数硬上界与截断降级，手动递归按平台分流` |
| 2 | ADR-4（单一真源） | `src/fs/mod.rs`、`src/api/files_watch.rs` | Phase 1 | `refactor(fs): ignore 规则单一真源，watch 与搜索共用` |
| 3 | ADR-5（serde） | `src/api/files_watch.rs` | 无（可与 2 并行） | `fix(files_watch): 改 serde 序列化，修控制字符产生非法 JSON` |
| 4 | ADR-6（去抖 + Lagged）、ADR-7（空流 + 退避） | `src/api/files_watch.rs`、`frontend/src/hooks/useFileWatcher.ts` | Phase 1（复用 `resync`/`degraded` 类型） | `fix(files_watch): 事件去抖与溢出重同步；前端重连退避` |
| 5 | 问题 10 验证 → 另行排期 | — | — | 不在本轮 |

**Phase 5 验证脚本先行**（只验证、不预设修法）：`mkdir -p a/b` → 建立 watch → `mv a c` → `touch c/b/f`，观察事件路径报 `a/b/f`（映射过期，需修）还是 `c/b/f`（无问题）。

---

## 验收清单

**后端**
- [ ] `collect_watch_dirs` 超限时返回数量 ≤ `MAX_WATCH_DIRS` 且 `truncated == true`（构造 3 层树 + 低上限）
- [ ] BFS 序断言：低上限截断下，所有顶层目录仍在结果中（浅层优先可测）
- [ ] `#[cfg(target_os = "linux")]` 分支外的平台走单次 `Recursive`（至少 `cargo check --target x86_64-pc-windows-msvc` 通过）
- [ ] `is_ignored_component` 单一真源单测；`fs` 侧 `search_files` 现有测试作回归（确认 4 个冗余隐藏项清理未改变搜索行为）
- [ ] serde wire format 单测：文件名含 `"`、`\n`、U+0008、中文 —— 输出可被 `serde_json::from_str` 回读（直接回归问题 5）
- [ ] 去抖合并纯函数单测：同路径多事件合并为一；pending 超限转单条 `resync`
- [ ] 注册失败路径有 `warn!` 且下发 `degraded`

**前端**
- [ ] `FileChangeEvent.kind` 扩展后 `tsc` 零新增错误
- [ ] `degraded` 触发 toast；`resync` 触发全量刷新
- [ ] `useFileWatcher` 退避序列单测（3s→6s→…→30s 封顶，`onopen` 重置）；基建参考 `frontend/src/utils/path.test.ts`
- [ ] `FileDrawer` 收到 `resync`/`degraded` 不误报「文件被外部删除」

**边界与降级**
- [ ] 把 `~` 加为项目后 RSS 稳定、`notify-rx` 线程 CPU 正常（本计划的核心验收 —— 对应「反证」场景）
- [ ] `scripts/verify-inotify-fix.sh` 仍通过（fd 不泄漏）
- [ ] 无效 session 时不再出现 3s 一次的重连风暴

**质量门禁**
- [ ] `cargo clippy` / `rustfmt` / `tsc` 零新增告警；全量测试通过

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| ADR-4 的语义变更用户可察觉（`dist/` 不再刷新） | 唯一不可静默回退项 → 需事前拍板 + 写入 CHANGELOG；若反馈为负，`HEAVY_DIRS` 移除 `dist`/`build` 即可回退（单一真源使回退是一行改动） |
| ADR-6 引入 ≤100ms 刷新延迟 | 人眼阈值下；若感知迟滞降到 50ms（常量单点可调） |
| ADR-2 的非 Linux 分支缺真机验证 | 本机无 macOS/Windows 环境 → 只能保证 `cargo check --target` 通过，行为正确性依赖 notify 原生 `Recursive` 语义（分流后即回到前序修复之前的、已长期运行的代码路径，风险低于现状） |
| BFS 手写替代 `walkdir` 引入新遍历 bug | 上限截断 + 浅层优先两条断言直接覆盖遍历语义；符号链接不跟随（与 `walkdir` 默认一致）需显式测 |

---

## 文档闭环

| 文档 | 更新内容 |
|---|---|
| `docs/architecture/backend.md` §File watcher | **修正现有错误表述**（「有界性：有界于实际业务目录数」→ 硬上限 + 截断语义 + 降级事件）；补 §8 跨平台后端成本差异表（ADR-2） |
| `docs/dev/debug-patterns/resource-lifecycle.md` 模式 8 | 2026-08-16 案例补一句结论：**剪枝 ≠ 有界，硬上限才是**；补跨平台后端代价差异 |
| `docs/dev/performance-and-safety.md` §P1 | 登记两个新界：`MAX_WATCH_DIRS`、`MAX_PENDING` |
| `AGENTS.md` 文档索引 | 新增本 plan 条目（`scripts/check-doc-index.sh` 会校验存在性与 git 跟踪） |
| `CHANGELOG.md` | 一条：文件监控有界化 + 事件去抖 + 非法 JSON 修复；**须写明 `dist`/`build` 不再监控的行为变更** |

---

## 待拍板事项

1. **ADR-4 行为变更**：watch 不再监听 `dist` / `build` / `venv` / `vendor` —— 接受吗？
2. **ADR-1 顺带取舍**：手写 BFS 换掉 `walkdir` 依赖（少一个依赖），还是保留 `walkdir` 用其 API 实现 BFS？
3. **Phase 5**（目录 rename 映射失配）本轮验证还是完全另排？
