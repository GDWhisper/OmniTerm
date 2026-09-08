# PTY 增量同步加固：周期对账 + 帧序号 + 状态行入队（A+C）

> 状态：设计稿（2026-09-08）
> 触发条件：用户持续报告「pty 运行中画面错位/延迟显示，切换终端/会话回来后恢复正常」。结构性分析（见背景）结论：症状家族已修六轮仍复发，根因不在单个漏洞，而在「无校准的增量镜像」架构——本次按建议先落地 A+C 止血。
> 关联：`docs/dev/debug-patterns/terminal-pty.md` 模式 7/8/10/12、`docs/dev/plans/2026-09-03-pty-viewport-fingerprint-anchor.md`（视口锚定，已实施）、`docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（方案 D，长期方向）、`docs/dev/performance-and-safety.md` §P1（有界缓冲红线）

## 背景

### 架构现状

```
PTY 输出 → 后端 VT grid（真相源）→ 每连接独立编码（33ms tick + 事件驱动）
  → cell_frame（首帧全帧，后续按行 hash diff）→ WS
  → 前端 rAF 有序队列 → ANSI 一次性 write + 光标写入 → xterm.js
```

全帧仅四个触发点：attach/重连、resize、alt-screen overlay、前端 resync 控制帧。**稳态运行中没有任何周期性全帧锚点**，diff 帧的正确性依赖一条不变式：

> 台账（diff 基线）推进序列 ≡ 前端渲染历史

而前端**没有任何机制能发现自己已失配**：无帧序号、无周期对账，resync 只由「队列溢出」单一信号触发。任何一次性扰动都会造成**不自愈**的错位，直到走全帧路径（切换会话/重连/resize）才恢复——这正是症状签名。

### 已核实的缺陷清单（证据见附录）

| # | 缺陷 | 后果 | 症状对应 |
|---|------|------|---------|
| 1 | diff 基线会话级共享，每连接独立消费（明知未修，当时「单页面」确认故搁置） | 并发连接（另一标签页、重连时旧连接未死透）交替取走增量 → 互相偷基线 | 错位，切换恢复 |
| 2 | 前端 attached/error/exit 状态行 `writeln` 绕过 rAF 有序队列直写 | mid-stream 写入触发换行滚动，未变化行**永不重画** → 永久错位 | 错位，切换恢复 |
| 3 | xterm 写缓冲无背压（50MB 才报错，12ms 切片让出），前端不消费 write 回调 | 高速输出时显示持续落后、追帧跳变 | 延迟 |
| 4 | 后端单连接 select 循环串行（编码→发送→viewport/agent 事件），慢帧阻塞全分支（5ms 告警已留） | 帧间延迟 | 延迟 |
| 5 | 帧尺寸竞态窗口内错尺寸帧照常渲染（RTT ~1 帧后自愈） | 短暂错位 | 已有自愈，残余小 |

### 历史修复与为何复发

模式 7（事件驱动推帧）、模式 8 × 2（有序队列+resync、keepFrom 锚点+补发定时器）、模式 10 × 2（history_size 锚定→指纹锚定）、模式 12（行数分叉自愈+回底校准）——每轮堵一个具体漏水口，架构不变式从未被补上，下一个扰动源冒出来症状依旧。本次不再逐口打补丁，而是给不变式加「检测 + 兜底」。

## 范围与优先级

| 级别 | 内容 | 目标 |
|------|------|------|
| **P0-A** | 周期性全帧对账 + 帧序号（后端协议 + 前端检测） | 把一切失配的可见时间上界压到 ≤1s（周期全帧兜底），失配可被**检测**（seq 断链→主动 resync 即时收敛） |
| **P0-C** | 状态行直写后触发重同步锚点 | 根治缺陷 2 的滚动错位 |
| P1-B | diff 基线按连接隔离 | 根治缺陷 1（A 落地后其后果已被兜底，降级为 P1 择机） |
| P2-D | Herdr 式全缓冲渲染 | 长期方向，维持 backlog，不在本次范围 |

**不纳入**：resize 期间锚点保真（2026-09-03 计划已声明降级）；raw legacy 模式；tmux 路径（字节流架构，无 cell_frame diff，不受影响）；viewport 窗口帧的 seq（不占 diff 基线，无断链语义）；缺陷 3/4 的深度优化（A 的兜底使其退化为体验问题而非正确性问题）。

## 设计决策

### A1：周期性全帧对账（决策：做，时间驱动）

- 每 `FULL_FRAME_INTERVAL_MS = 1000`（常量，per 连接计时）强制下一帧 `full: true`。实现为 `encode_cell_frame` 增加 `force_full: bool` 参数；全帧走既有 CUP+EL 逐行重画路径（无 `\x1b[2J`，不动 scrollback，无闪烁——模式 8 的 keepFrom 修复已依赖此语义）。
- **理由**：全帧自含、幂等，是唯一对所有失配源通吃的兜底；RLE 后全帧 ~5KB，1s 一次 ≈ 40kbps，可忽略；空 diff 帧本就以 30fps 在流，编码量级不变。
- **否决：帧数驱动（每 N 帧）**——低速输出时 N 帧跨度过长，兜底上界不可控；时间驱动上界恒定。
- **翻盘条件**：实测 1s 全帧在低端设备/移动端引起可感知渲染抖动 → 拉长到 5s 并依赖 seq 检测（A2）即时收敛。

### A2：帧序号（决策：做，per-session 单调递增）

- `CellFrame` 新增 `seq: Option<u64>`（仅 live 编码路径 `encode_cell_frame` 携带；viewport 帧/overlay 省略，前端无 seq 字段则跳过检测）。计数器放 `VtState`（会话级，重连不清零；后端重启归零 → 前端检出断链请求 resync，无害）。
- 前端 `useCellFrame` 入队时校验 `seq == lastSeq + 1`：断链即 `armResync()`（复用既有节流+补发定时器）。断链 ≡ 基线被并发连接消费（缺陷 1 的直接信号）。
- **理由**：把「无法发现的失配」变成「可检测事件」，是 A1 之外的即时收敛通道，也提供观测数据（断链频率 ≈ 并发连接干扰频率）。
- **否决：per-connection 序号**——共享基线下 per-connection 连续性无法表达「别人偷走了我的增量」，检测不到缺陷 1。
- **翻盘条件**：若断链误报（找到非并发连接的合法断链源）→ 只保留 A1 兜底，seq 降级为纯日志观测。

### C1：状态行直写后强制重同步（决策：做，最小改动）

- mid-stream 的 `error`/`exit` `writeln` 后立即 `requestResync()`（守卫 `ws.readyState === OPEN`）：一次全帧重画抵消滚动副作用。`connected`/`attached` 在首帧 reset 前写入、`onclose`/`onerror` 在流死后写入，均无需处理。
- **理由**：状态行是罕见事件，一次全帧成本 ~5KB；保留现有 UX（终端内彩色状态行）零视觉变化。
- **否决：状态行改 toast/overlay**——改动 UX 且需新增 UI 表面，收益不成比例。
- **翻盘条件**：若后续状态行使用频率变高（如每次 attach 提示）或用户反馈全帧重画闪烁 → 改走 UI 表面，从根上消灭终端写入。

### B：diff 基线按连接隔离（决策：P1 暂缓）

- A 落地后缺陷 1 的可见后果已被 ≤1s 兜底 + seq 检测覆盖，ROI 下降。实施需把 `DiffEngine` 从 `VtState` 拆到 per-connection 持有（`encode_cell_frame` 的基线簿记参数化），涉及编码路径重构，单独评估。
- **翻盘条件**：A2 实测断链频率高到 1s 全帧仍不够平滑（多标签页成常态使用）→ 提级。

### 多实现差异（AGENTS §8）

`seq`/`force_full` 均为**两端同发**（前后端同一产物部署，无跨版本负担），但 `seq` 用 `Option` 且前端对「无 seq 字段」的帧跳过检测——旧前端缓存的降级路径已有 user-testing 已知限制条目覆盖（cell_frame 协议错配），不新增兼容层。

## 实施分期

### Phase 1 — C1（前端，独立可先行）

> 状态：✅ 已实施（2026-09-08，commit 97dd0ec）。单测 4 例（error/exit 触发；connected/attached、onclose/onerror 不触发）覆盖计划两用例并细化了「首帧前/流死后」的边界；测试经 FakeTerminal/FakeWebSocket probe 模式，onerror 用例刻意保持 readyState=OPEN 以证明路径本身不调 requestResync 而非被守卫挡住。

| 产出 | 文件 |
|------|------|
| error/exit writeln 后 `requestResync()`（readyState 守卫） | `frontend/src/hooks/useTerminal.ts` |
| 单测：mid-stream writeln 触发 resync；首帧前/流死后不触发 | `useTerminal` 同目录 `*.test.ts` |

### Phase 2 — A（后端协议 → 前端检测）

> 状态：✅ 已实施（2026-09-08，commit 9987430）。
> - **force_full 实现**：`encode_frame_body` 内先 `diff_engine.invalidate()` 再走正常路径——`full = is_untracked()` 自然为 true、全行编码、基线随后推进到当前 grid，与自然全帧语义完全一致（单测 `force_full_emits_all_rows_and_keeps_baseline_semantics` 守护）。
> - **force_full 触发点**：仅 30fps tick 分支（per 连接 `last_full_at`）；事件驱动的 rx 编码不强制，保持低延迟语义。首个全帧出现在连接后 ~1s（首帧本就 untracked 全帧）。
> - **seq 语义**：`VtState.frame_seq` 每次调用 `encode_cell_frame` 递增（wrapping_add，u64 溢出 ~190 亿年）；viewport/overlay 构造点显式 `seq: None`，单测 `seq_increments_on_live_frames_and_skips_viewport_overlay` 守护「不占 seq」。
> - **前端**：`lastSeq` ref 置于 `useCellFrame`；首帧（lastSeq 为 null）直接接受；无 seq 帧不校验也不推进 lastSeq。
> - **实施偏差**：`useTerminal.ts` 零改动——`CellFrame` 类型唯一定义在 `useCellFrame.ts`（useTerminal 仅 re-import），计划表格中「useTerminal.ts（类型）」无需执行。
> - **已知无害误报**：切换会话 / 会话进程退出后重建 / 后端重启时，前端 `lastSeq` 残留旧值 → 首帧检出断链 → 一次 armResync（1s 节流限频）→ 全帧收敛，代价 ~5KB。重连（会话存活）场景计数器不清零、无误报。

| 产出 | 文件 |
|------|------|
| `VtState` 增 `frame_seq` 计数器；`encode_cell_frame(force_full)` 签名调整并盖 `seq` | `src/engine/pty/vt.rs`、`frame.rs`（`CellFrame.seq`） |
| 转发循环：`FULL_FRAME_INTERVAL_MS` 常量 + per-connection 计时传 `force_full` | `src/engine/pty/terminal_ws.rs` |
| 入队 seq 连续性校验 → `armResync()`；缺 seq 帧跳过 | `frontend/src/hooks/useCellFrame.ts`、`useTerminal.ts`（类型） |
| 单测：seq 连续通过/断链触发 resync/无 seq 跳过；后端 force_full 出全帧且基线语义不变、viewport 帧不占 seq | 两端 `#[cfg(test)]` / `*.test.ts` |

### Phase 3 — 实测验证

- 故障注入验收：复现期用第二个 WS 探针连同一会话偷基线，前端应在 1 个周期内自愈（修复前永久错位直到切换）。
- 回归：`scripts/pty-frame-regression.mjs`、`cargo test --workspace`、`pnpm build`（含 tsc）、`cargo fmt + clippy -D warnings`。

### Phase 4 — 文档闭环

- `docs/dev/debug-patterns/terminal-pty.md`：模式 8 追补「增量同步必须配检测+兜底」规律与本案证据。
- `docs/architecture/backend.md`：cell_frame 协议新增 `seq`、周期全帧语义。
- `docs/architecture/frontend.md`：useCellFrame 队列 seq 校验。
- `docs/reference/user-testing.md`：新增并发连接/状态行回归用例；CHANGELOG 实施条目。

## 验收标准

- [ ] 故障注入（探针偷基线）下，画面 ≤1s 自愈，无需切换会话（修复前永久错位）
- [ ] seq 断链 → 前端 1 帧内发出 resync，收到全帧后收敛（实测记录断链→全帧延迟）
- [ ] mid-stream error/exit 后画面无一行偏移残留
- [ ] 1s 周期全帧在 100 行/秒持续输出下无可感知闪烁（录屏对照）
- [ ] 带宽：空闲会话 1s 全帧 + 空 diff 总量 ≤ 10KB/s
- [ ] viewport/overlay/首帧前路径回归通过，scrollback 不受全帧影响（无 `\x1b[2J`）
- [ ] 两端单测覆盖（后端 force_full/seq；前端断链 resync/缺 seq 跳过）；fmt/clippy/tsc 零新增
- [ ] Phase 4 文档闭环完成

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 周期全帧与用户滚动视口冲突（历史区被 live 全帧覆盖） | 既有 `acceptFrame` 门控已丢弃 viewport 模式下的实时帧（方案 C D3），全帧同走此门控，无新增风险 |
| 全帧重画引入闪烁 | CUP+EL 逐行路径无清屏（模式 8 已验证语义）；翻盘条件见 A1 |
| seq 断链误报引发 resync 风暴 | armResync 已有 1s 节流 + 补发定时器（模式 8 修复），天然限频；翻盘条件见 A2 |
| 基线共享下全帧与并发连接交错 | 全帧自含幂等，多连接各收各的全帧互不污染（模式 8 案例已实证） |

## 附录：证据索引

| # | 结论 | 证据 |
|---|------|------|
| 1 | diff 基线会话级共享、编码时推进、每连接独立消费 | `src/engine/pty/vt.rs:339-341`（`diff_engine` 挂 `VtState`）；`src/engine/pty/frame.rs` `changed_rows_from`（编码即更新 `prev`）；`src/engine/pty/terminal_ws.rs:196-199`（每连接 `encode_now` 锁共享 vt） |
| 2 | 稳态无周期全帧；全帧仅 attach/resize/overlay/resync | `terminal_ws.rs:108/227/342`；`src/engine/pty/mod.rs` `resize_state` → invalidate |
| 3 | 前端状态行直写绕过 rAF 队列 | `frontend/src/hooks/useTerminal.ts:251/322-326/349/355`（`writeln`）；帧走 `useCellFrame.ts` rAF 队列 |
| 4 | xterm 写缓冲无背压、12ms 切片、50MB 上限 | `frontend/node_modules/@xterm/xterm/lib/xterm.js`：`_pendingData>5e7`、`performance.now()-i>=12 → setTimeout` |
| 5 | 队列 120 帧上限 + 1s resync 节流 + keepFrom | `frontend/src/hooks/useCellFrame.ts`（`MAX_PENDING_FRAMES`/`RESYNC_THROTTLE_MS`） |
| 6 | 后端单连接串行循环、慢帧阈值 | `terminal_ws.rs:29`（`SLOW_FRAME_US=5ms`）、`select!` 循环 183-271 |
| 7 | 切换恢复 = attach 全帧重渲染（数据未丢的反证） | `mod.rs` `attach()`：ring 尾 + `\x1b[2J` + `render_screen()` |
| 8 | resync 控制帧 → 作废基线下发全帧 | `terminal_ws.rs:339-343`；前端 `{ type: 'resync' }` `useTerminal.ts:134-137` |

**未证实项**：xterm `reset()` 是否清空内部写缓冲（压缩源码无法确认）——若不清，「切换会话后旧会话尾部字节延迟涌入」是缺陷 3 的补充来源；Phase 3 验证时用未压缩源码核实，结果记入勘误。
