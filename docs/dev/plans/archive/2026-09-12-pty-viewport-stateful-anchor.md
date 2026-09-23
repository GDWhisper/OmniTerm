# pty 历史视口锚定修复：删除指纹重定位，改后端有状态锚 + 滚移检测

> 状态：已实施（2026-09-12，P0-P2 完成；自动化验收全绿——探针实机回归与浏览器手动回归待 dev 后端运行新二进制后执行，见验收清单）
> 触发条件：用户持续报告「pty 上翻看历史时，上面有一部分内容像锁住，只能翻滚下屏一点点内容」；tmux 路径无此问题；pi / codebuddy / gemini CLI 等 agent 上均复现（输出流式进行时）。
> 关联：`docs/dev/plans/archive/2026-09-03-pty-viewport-fingerprint-anchor.md`（指纹锚定，本计划**取代其 D1-D5 机制**，其「y 不是稳定标识」结论仍是本设计前提）、`docs/dev/plans/archive/2026-09-08-pty-incremental-sync-hardening.md`（A1/A2 与本计划正交，不得回归）、`docs/dev/debug-patterns/terminal-pty.md` 模式 10/12、`docs/dev/performance-and-safety.md`（§P1/P2/P6，编码热路径改动前必读）
> 探针脚本（诊断证据，gitignored，实施时升级为正式回归）：`.dev/viewport-suction-probe.mjs`、`.dev/viewport-suction-final.mjs`

## 背景：根因（已实证，非推断）

### 症状

用户在 pty 会话上翻查看历史时，视口被"吸"回 live 屏附近：屏幕顶部始终显示同一形态的重复内容（空行/框线/分隔线），只有屏幕下缘随新输出变化；用户的上滚进度在 ≤100ms 内被抹掉。agent 空闲（无输出）时滚动正常——问题只在**输出流式进行期间翻历史**时出现，恰是用户边看历史边等 agent 的主场景。

### 根因机制链（每步有代码定位）

1. 用户滚动停在历史某处，**窗口首行（锚点行）多半是重复内容**：空行、TUI 框线、分隔线、提示符行——agent 输出的常态。
2. agent 持续输出时，前端每 100ms 发一次「保锚重拉」（`frontend/src/utils/viewportController.ts:211` `notifyLiveOutput`，`REFRESH_THROTTLE_MS = 100`），携带锚点指纹 `fp` 和 `currentY`（`viewportController.ts:220-228`）。
3. 请求到达时 `currentY` 相对后端 grid 已**滞后 k 行**（k = 两次刷新间的新增行数）。后端由滞后 y 反推搜索起点 `top = hs - y`，落在真锚点**靠 live 一侧 k 行**处（`src/engine/pty/vt.rs:634-643`）。
4. `relocate_anchor`（`vt.rs:691-713`）从该起点**双向交替**向外找首个单行指纹匹配。真锚点在旧向距离 k 处；**更新方向的副本**（历史中周期为 p 的同内容行）只需 `p - k` 距离——**p < 2k 时必然先命中更新的副本**；p ≪ k 时直接吸附在起点附近（起点附近全是同内容行）。
5. 误命中位置作为权威 y 回传，前端 `acceptFrame` 同步 `currentY = frame.viewport`（`viewportController.ts:186-189`）——用户滚动位置被系统性擦除，视口每轮刷新向 live 棘轮推进，直到贴底。表现为：饱和期滑移（p ≪ k）、周期棘轮（p 与 k 同量级）。

### 探针证据（差分复现，直连后端 WS 复刻前端请求序列）

| 实验 | 锚点行内容 | 内容周期 p | 每轮新增 k | 实测 drift（刷新响应 y − 请求 y） | 判定 |
|------|-----------|-----------|-----------|--------------------------------|------|
| 唯一内容（`seq 1 2000`） | 唯一行 | ∞ | ~21 | **+21**，窗口首行内容保持 | ✅ 锚定精确 |
| 空行密布（每 3 行 1 空行） | 空行 | 3 | ~18 | **−1**/轮，吸附到附近空行副本 | ❌ |
| 分隔线周期（每 11 行 1 条），burst 含分隔线 | `----------------` | 11 | ~6 | **−5**/轮，窗口末行 `line 46→56→66→76`（内容前移） | ❌ 棘轮 |
| 同上但 burst **不含**分隔线 | 同上 | 11 | ~6 | **−5**/轮——**历史自身的周期性即足以触发** | ❌ |
| 空行周期 2 | 空行 | 2 | ~6 | y 表面 +1/轮，窗口内容全速滑移（与不带 fp 的旧行为无异） | ❌ 滑移 |

唯一内容下传输/钳制/请求通道全部健康（drift 精确等于新增行数）——缺陷**仅在锚点行内容重复时触发**。

### 为什么此前六轮修复均未发现

- 09-03 指纹锚定的验收用 `seq 1 3000`——**全唯一行**，指纹永不误匹配，实测"漂移 0 行"全绿。真实 agent 输出的重复结构从未进过测试。
- 09-03 计划风险表明确记载「重复行误匹配 → 视觉等价，无害」。该判断对**单次**刷新成立（窗口首行内容确实相同），对**连续刷新**不成立——每次都向更新的副本重新锚定，累积即棘轮/滑移。
- 09-04 勘误修过 y=0 的同款吸附（模式 10 追补），未推广到 y>0 的周期内容。
- 无输出时滚动走纯位置定位（fp=null 不重定位），完全正常——静态/空闲测试漏掉该缺陷。

## 方案选型（含翻盘记录）

**写作时的重要翻盘**：诊断报告口头推荐的「邻域指纹 + 单侧搜索」组合在计划推演中被**否决**，用户批准时基于的是口头版，此处记录否决理由：

- **否决邻域指纹（把单行哈希换成 R=2 的 5 行邻域哈希）**：周期 p ≤ 2R+1 的内容邻域指纹仍然重复——空行带（p=2，agent 输出最常态）必绕过 R=2 邻域；把 R 加大到 8 也只把失效条件推迟到 17 行以上的均匀带（Ink 系 TUI 底部预留 5-8 空行 + 段间空行，实际可达）。指纹回答的是「这内容在哪」，用户要的是「我看的那个位置在哪」——**内容不唯一时前者原理上无解**。
- **否决单侧（只向旧）搜索**：搜索起点落在真锚点靠 live 一侧 k 行，起点与真锚点之间的 gap 副本 (A, A+k] 仍在旧向路径上、先于真锚点被命中——v3 对照组（burst 无分隔线仍 −5/轮）已实测棘轮不依赖新输出里的副本。
- **否决保留重定位 + 限幅/单调护栏**：重定位误命中本身不可检测（命中副本内容与锚点相同），护栏只能限制单步幅度，滑移依旧累积。

**选定方案：删除指纹重定位机制，改为后端有状态位置锚 + 饱和期滚移检测。** 位置记忆驻留在持有 grid 真相源的一侧（09-03 的核心结论「位置换算归属真相源一侧」的彻底化），刷新路径不再有任何"重新决定位置"的步骤——缺陷类整体消失，而非逐口堵漏。

## 范围与优先级

| 级别 | 内容 | 目标 |
|------|------|------|
| **P0** | 后端有状态锚 + 协议意图显式化 + 滚移检测；前端 fp 链路拆除 | 重复内容下锚点保持（drift == 新增行数），上翻不再被吸回 live |
| P1 | 探针升级为 `scripts/` 正式回归（本缺陷逃逸的直接原因就是缺重复内容回归） | 三种周期形态 + 唯一内容差分判据固化 |
| P2 | 前端 `anchorFp` 死代码清理 | 准则 6（禁死代码） |

**不纳入**：Herdr 式全缓冲渲染（方案 D，维持 backlog 长期方向，本修复不增加其成本）；resize reflow 期间的锚保真（reflow 必然失配，清锚降级，沿用 09-03 降级声明）；tmux 路径（字节流架构，无此机制）；per-connection 锚隔离（见 D5）。

## 设计决策

### D1：后端有状态锚（核心）

`VtState` 新增 `viewport_anchor: Option<i32>`（**绝对行索引**，0 = 最旧一行，`hs` = 最新可见屏顶；即现 `top = hs - y` 的 `top` 语义）。

- **滚动请求**（`refresh=false`，用户意图）：`anchor = clamp(hs - y, 0, hs)`，存储并按该位置出窗口。不做任何搜索。
- **刷新请求**（`refresh=true`，输出触发）：**直接按存储的 `anchor` 出窗口，完全忽略请求 y，无任何搜索/重定位**；`anchor == None` 时回退按请求 y 位置定位（降级不失效，覆盖后端重启/清锚后首个刷新）。
- `encode_viewport_frame` 签名 `&self` → `&mut self`（存锚需要；调用点 `terminal_ws.rs:262-266` 已持独占锁，`DerefMut` 可用）。
- 响应 `viewport` = 实际服务的 y（`hs - 实际窗口顶`），前端响应 y 权威同步语义不变。

**理由**：根因是「每次刷新从滞后 y + 内容搜索重新决定位置」。有状态锚让重定位这一步整体消失；y=0 指纹吸附勘误（09-03）所代表的整类问题随之消灭。

**否决**：邻域指纹 / 单侧搜索 / 限幅护栏——见「方案选型」翻盘记录。

**翻盘条件**：若实施中发现会话级锚与多视图产生不可接受干扰（超出 D5 已知限制），回退为 per-connection 锚（转发循环局部状态，`terminal_ws.rs` 的 forward task 持有，经 `viewport_rx` 消息传递）。

### D2：协议意图显式化 `{y, fp} → {y, refresh}`

- `ClientControl::ViewportRequest`（`src/ws/terminal.rs:33`）：`fp: Option<String>` → `refresh: bool`（`#[serde(default)]`）。
- 删除 `relocate_anchor`、`ANCHOR_SEARCH_RADIUS`（`vt.rs:52`）、`parse_anchor_fp`（`terminal_ws.rs:430`）、`CellFrame.viewport_fp`（`frame.rs:40`）及全部构造点。
- 前端 `ViewportController`：`sendRequest(y, fp)` → `sendRequest(y, refresh: boolean)`；删除 `anchorFp` / `pendingFp` 及 `viewport_fp` 消费（`acceptFrame`）。滚动→`false`，重拉→`true`（`pendingRefresh` 语义原样保留，重拉同 y 不去重）。
- 两端同一产物部署，无跨版本兼容负担（09-08 A2 先例）。

**理由**：现行「fp 空与非空区分意图」是 D5「混用会把用户刚滚走的位置拉回来」隐患的根源（`viewportController.ts:39-40` 注释自述）；显式布尔根除该类。前端 `anchorFp` 簿记在 D1 下全部失效，按准则 6 清除。

**翻盘条件**：无（两端同发，无兼容负担；旧前端缓存降级路径已有 user-testing 已知限制覆盖惯例）。

### D3：饱和期滚移检测（唯一新增机制）

锚定内容在**历史未饱和期天然不动**（绝对索引 = Line + hs，输出滚动时 Line 减小、hs 增大，恒等抵消），无需任何检测。**饱和后**（`hs` 恒 1000，本仓库常态）内容绝对索引每滚一行减 1，锚必须随之调整，否则滑移。检测器挂在 live 编码路径：

- `VtState` 新增 `prev_screen_hashes: Vec<u64>`（上一 live 帧的屏幕行哈希，rows 大小）与 `prev_history_size: u32`。
- `encode_frame_body`（`vt.rs:733`）每帧本就计算 `row_hashes`（`vt.rs:753-757`）——检测零新增哈希成本：
  1. `hs > prev_hs`（未饱和增长 g 行）：不动锚（绝对索引稳定）。
  2. `hs == prev_hs`（饱和）：找 s ∈ 1..=rows−1 使 `match_count = |{i ∈ s..rows : row_hashes[i] == prev[i−s]}|` 最大的首个 s（按 s 升序取第一个达标者），达标阈值 `match_count ≥ (rows − s) × 3 / 4`（重叠区按比例）；命中 → `anchor = max(anchor − s, 0)`。
  3. 未命中（全屏重绘 TUI / scroll region / 突发 > 屏高）：**不调整**（有界缓滑移，无棘轮），`tracing::debug!` 记 miss。
  4. `hs < prev_hs`：不发生（resize 另行清锚，D4）。
- 每帧末尾无条件 `prev_screen_hashes = row_hashes; prev_history_size = hs`（比较基线必须持续前进）。
- 锚为 `None` 时跳过调整但**保留基线更新**（首个刷新前也要有新鲜基线）。
- overlay 编码路径（`encode_overlay_frame`）不做检测（alt-screen 切换已清锚，D4）。

**理由**：复用每帧既有的行哈希，P1/P2 合规（rows 大小固定缓冲、无 O(n²) 数据增长项；40×40 次 u64 比较上界，30fps 下可忽略）。

**翻盘条件**：实测全屏重绘型 TUI 下 miss 率高到滑移可感知 → 评估 feed 层字节侧换行计数兜底，或直接提级方案 D（全缓冲渲染）。

### D4：锚的失效与清理（全列显式）

| 事件 | 动作 | 依据 |
|------|------|------|
| 滚动请求 y=0（回底） | 清锚 | 回底 = 放弃历史位置；现 y=0 跳过重定位的勘误语义由「清锚」自然承接 |
| resize（行数变化） | 清锚 | reflow 改变行内容与位置，指纹/位置双双失配（09-03 已声明降级） |
| AltScreenEnter | 清锚 | 屏幕切换后历史位置无意义（overlay 帧发射处顺带，`terminal_ws.rs:238-252`） |
| 锚行被淘汰（abs ≤ 0） | 钳 0 续供 | follow-eviction：视口贴住最旧可用行随淘汰滑动 = 真实终端语义 |
| 后端重启 | 锚 None | refresh 回退按 y 位置定位，降级不失效；前端 lastSeq resync 已有 |
| 会话切换 | 前端 `reset()` 不发请求 | 后端残留锚无害，下次滚动覆盖 |

### D5：锚存 `VtState`（会话级共享）

单视图模型（最后 attach 者决定尺寸，09-08 缺陷 1 同款已知限制）。多连接（调试探针 + 前端）互相踩锚：最坏 = 视口跳到对方位置一次，无正确性破坏（D1 下不存在重定位误命中链式放大）。不做 per-connection（奥卡姆；实施成本与状态同步复杂度不成比例）。

### D6：观测性

滚移检测 miss 与锚钳 0 事件打 `tracing::debug!`（带 session 标识，仅状态变化时打，不刷屏）。不新增 metric 面。

### 多实现差异（AGENTS §8）

协议字段 `refresh` 为两端同发，无跨版本负担。前端对旧协议（无 `refresh` 字段）不做兼容层——与 09-08 A2 的 `Option<seq>` 降级惯例一致：`#[serde(default)]` 使缺省 `false` = 滚动语义，旧前端缓存的刷新请求会按滚动定位（降级为滑移，不报错不断连），user-testing 已知限制登记一条即可。

## 实施分期

### Phase 0 — 前置阅读（实施前必做）

- 本文件全文（根因与翻盘记录）。
- `docs/dev/plans/archive/2026-09-03-pty-viewport-fingerprint-anchor.md`（被取代机制的原始决策，Phase 4 要写勘误）。
- `docs/dev/plans/archive/2026-09-08-pty-incremental-sync-hardening.md`（A1/A2 语义，不得回归）。
- `docs/dev/performance-and-safety.md` §P1/P2/P6（编码热路径 + 检测器缓冲约束）。
- `docs/dev/debug-patterns/terminal-pty.md` 模式 10（含 y=0 勘误）与模式 12。

### Phase 1 — 后端

| 产出 | 文件 |
|------|------|
| `VtState` 新增 `viewport_anchor: Option<i32>` / `prev_screen_hashes: Vec<u64>` / `prev_history_size: u32` | `src/engine/pty/vt.rs:343` |
| `encode_viewport_frame(&mut self, session_id, y, refresh)`：refresh 分支按锚出窗（钳 0、None 回退 y）、scroll 分支存锚；删除 fp 参数与 `viewport_fp` 构造 | `src/engine/pty/vt.rs:630-682` |
| 滚移检测：`encode_frame_body` 内 hs 比对 + 哈希相关，`prev_*` 基线每帧更新 | `src/engine/pty/vt.rs:733-818` |
| 删除 `relocate_anchor` / `ANCHOR_SEARCH_RADIUS` | `vt.rs:52, 684-713` |
| `ClientControl::ViewportRequest { y, refresh }`；删除 `parse_anchor_fp`；读循环透传；转发循环分支改签名 | `src/ws/terminal.rs:33`、`src/engine/pty/terminal_ws.rs:257-270, 381-395, 426-432` |
| `CellFrame` 删 `viewport_fp` 字段 | `src/engine/pty/frame.rs:40` |
| resize / AltScreenEnter 清锚（resize 处顺带重置 `prev_screen_hashes` 长度） | `src/engine/pty/mod.rs`（resize_state → invalidate 路径）、`terminal_ws.rs` overlay 分支 |
| 后端单测：存锚/按锚出窗；refresh 无锚回退 y；y=0 清锚；未饱和 hs 增长不动锚；饱和相关命中调整 s；全重绘 miss 不调整（无棘轮）；淘汰钳 0；resize/alt-screen 清锚；既有 fp 用例改写/删除（`viewport_frame_y0_ignores_fingerprint_even_when_history_matches` 等随机制删除） | `vt.rs` `#[cfg(test)]`、`terminal.rs` 协议测试 |

### Phase 2 — 前端

| 产出 | 文件 |
|------|------|
| `ViewportController`：`sendRequest(y, refresh: boolean)`；删 `anchorFp`/`pendingFp`/`viewport_fp` 消费；`pendingRefresh` 去重豁免语义保留；响应 y 权威同步保留 | `frontend/src/utils/viewportController.ts` |
| `useTerminal`：sendRequest 回调改发 `{ type: 'viewport_request', y, refresh }` | `frontend/src/hooks/useTerminal.ts:174-184` |
| `CellFrame` 类型删 `viewport_fp` | `frontend/src/hooks/useCellFrame.ts:52-55` |
| 单测：滚动发 refresh=false、重拉发 refresh=true 且同 y 不去重、响应 y 同步保持；fp 相关用例改写 | `frontend/src/utils/viewportController.test.ts` |

### Phase 3 — 实测验证

- **探针升级为正式回归** `scripts/pty-viewport-anchor-regression.mjs`（以 `.dev/viewport-suction-probe.mjs` v3 + v4 为底，判据差分固化）：唯一内容 / 空行 p=3 / 分隔线 p=11（burst 含与不含副本）/ 空行 p=2 五形态，连续 ≥8 轮「输出→refresh 刷新」，判据 **drift == 该轮新增行数**（容差 ±1 行）且窗口首行内容保持；y 轨迹不得单调递减。
- `scripts/pty-frame-regression.mjs` 20/20；`cargo test --workspace`；`cd frontend && pnpm build`（含 tsc）；`cargo fmt --all && cargo clippy --quiet --workspace --all-targets -- -D warnings`。
- 浏览器手动回归（`docs/reference/user-testing.md` 用例）：agent 流式输出期间上翻历史——锚定内容不动、可继续上滚、回底提示条正常、回底恢复 live、resize 后滚动正常。

### Phase 4 — 文档闭环

- `docs/dev/debug-patterns/terminal-pty.md` 模式 10 追补规律：「内容指纹重定位在周期性内容上必然棘轮/滑移——重定位型锚点必须有位置记忆或唯一性保证」+ 本案证据；y=0 勘误标注由本修复整体承接。
- `docs/dev/plans/archive/2026-09-03-pty-viewport-fingerprint-anchor.md` 就地加「勘误」块：D1-D5 机制被本计划取代（指纹重定位对周期内容失效，2026-09-12 实证）。
- `docs/architecture/backend.md`：viewport_request 协议字段变更、VtState 锚与滚移检测。
- `docs/architecture/frontend.md`：ViewportController 请求意图链路变更。
- `docs/reference/user-testing.md`：新增「输出流式期间上翻历史」回归用例 + 旧前端缓存降级已知限制。
- `CHANGELOG.md`：实质性修复条目。
- `AGENTS.md` 文档索引：本计划条目的「何时读取」保持；`check-doc-index.sh` 校验。

## 验收标准

- [ ] 五形态探针回归（唯一 / 空行 p=3 / 分隔线 p=11 含副本 / 分隔线 p=11 不含副本 / 空行 p=2）连续 8 轮 drift == 新增行数（±1），窗口首行内容保持，y 轨迹无递减（`scripts/pty-viewport-anchor-regression.mjs`，需 dev 后端运行新二进制）
- [x] `relocate_anchor` / `ANCHOR_SEARCH_RADIUS` / `parse_anchor_fp` / `viewport_fp` 全链路删除，前后端无 fp 残留引用（rg 验证，2026-09-12）
- [x] y=0 回底、resize、alt-screen、锚淘汰钳 0、后端重启回退五条失效路径单测覆盖（`scroll_to_y0_clears_anchor` / `resize_clears_anchor` / `alt_screen_enter_clears_anchor` / `anchor_clamps_to_zero_when_anchor_line_evicted` / `refresh_without_anchor_falls_back_to_requested_y`）
- [x] 饱和期滚移检测：相关命中调整正确；全重绘 miss 不调整且可观测（debug 日志）（`anchor_follows_screen_scroll_when_history_saturated` / `anchor_holds_when_full_screen_redraw_misses_detection`）
- [x] `cargo test --workspace` 全绿；`pnpm build` 通过；fmt/clippy -D warnings 零新增（2026-09-12）；`pty-frame-regression.mjs` 20/20 与前端 638 测试同属提交前自动检查，实机项待后端新二进制
- [ ] 浏览器手动回归：输出流式期间上翻锚定不动、可继续上滚、回底链路正常（`docs/reference/user-testing.md` §4.6 V11/V12）
- [x] Phase 4 文档闭环完成（2026-09-12）

## 实施勘误（2026-09-12，实施时定稿的偏差）

- **D3 检测参数收紧**：s 的搜索上界从计划的 `rows−1` 收紧为 `rows − rows/4`（重叠区下限 `min_overlap = rows/4`）——排除大 s 端「一两次巧合判等即达标」的弱证据区，突发超过 ~3/4 屏高时放弃检测（滑移有界）。阈值公式同计划（重叠区 × 3/4，另加 `.max(1)` 防零）。
- **D3 基线失配跳过**：实现以「`prev_hashes.len() == row_hashes.len() && prev_hs == hs && 屏幕有变化`」为检测前提（计划第 4 条 `hs < prev_hs` 不发生的场景由长度失配统一覆盖）；屏幕哈希与上帧**完全一致**的帧直接跳过——垂直同构内容（空行带）在无滚移时也会自相关，不设此闸会按帧误调（单测 `scroll_detection_skips_unchanged_screen`）。
- **D6 观测语义**：`AnchorAdjust::{Adjusted, Miss, Inactive}` 三态；命中与 miss 均打 `tracing::debug!`，但仅在与上帧状态迁移时打（30fps 连续同态不刷屏），比计划的「miss 才打」多覆盖了命中侧观测。
- `prev_history_size` 落为 `i32`（计划写 `u32`；与 `history_size()` 的 i32 运算对齐，免转换）。

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 全屏重绘型 TUI 下滚移检测 miss → 锚缓滑移 | 有界（无棘轮：不调整 ≠ 向 live 跳变）、debug 可观测；翻盘条件见 D3 |
| scroll region 局部滚动使整屏相关失败 | 同 miss 路径降级；chat 型 agent（Ink 系）不用 scroll region，实测覆盖场景即主场景 |
| 会话级锚被并发连接（探针/第二标签页）踩动 | D5 已知限制，最坏视口跳位一次，无链式放大；与 09-08 缺陷 1 同类 |
| 旧前端缓存发无 `refresh` 字段的刷新请求 | `serde(default)` → false = 按滚动定位，降级滑移不断连（§多实现差异） |
| 饱和 + 检测 miss 长期累积造成贴底 | 贴底即 live 屏，用户可见后果 = 「跟不动历史」而非错位；前端回底提示条语义不变 |

## 附录：证据索引

| # | 结论 | 证据 |
|---|------|------|
| 1 | 唯一内容锚定精确（传输/钳制健康） | `.dev/viewport-suction-probe.mjs` v1：drift +21 == burst 行数 |
| 2 | 周期内容棘轮/滑移（根因） | 同上 v2/v3 + `.dev/viewport-suction-final.mjs` v4：−5/轮、内容前移、burst 无副本仍触发 |
| 3 | 搜索起点滞后偏差 + 双向就近命中 | `vt.rs:634-643`（top = hs − y）、`vt.rs:691-713`（双向 for d in [abs−d, abs+d]） |
| 4 | 前端刷新 100ms 节流 + 响应 y 权威同步擦除用户位置 | `viewportController.ts:211-229`（REFRESH_THROTTLE_MS）、`viewportController.ts:186-189`（acceptFrame 同步） |
| 5 | 09-03 验收用唯一内容 + 「视觉等价无害」错误假设 | `docs/dev/plans/archive/2026-09-03-pty-viewport-fingerprint-anchor.md` 风险表与实测记录 |
| 6 | 07-30 起六轮修复史与症状家族 | `docs/dev/debug-patterns/terminal-pty.md` 模式 7/8/10/12、`docs/dev/plans/archive/2026-09-08-pty-incremental-sync-hardening.md` 背景 |
