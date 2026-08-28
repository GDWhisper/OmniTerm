# PTY 帧 RLE 编码（pty 移动端手感改造 P1）

> **状态**：P1/P2 已实施（2026-08-28），P3 验证与清理待办。**实施后实测见 §10**——
> 帧体积 94.4 KB → 4.8 KB（19.8×）、四类内容无损全部 PASS，并暴露出一个独立的
> 延迟源（30fps tick 争用，§10.2），需另立项处理。
> **触发条件**：`docs/dev/plans/backlog/pty-mobile-termux-feel.md` §9 E-5 —— 实测确认单帧 94.4 KB 且与滚动步长无关，帧体积是移动端滚动滞后的主因，需先做帧瘦身。
> **关联**：
> - `docs/dev/plans/backlog/pty-mobile-termux-feel.md`（方向稿与实测数据，§3.2 / §9）
> - `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（cell_frame 与 viewport 帧的来源，方案 C）
> - `docs/dev/performance-and-safety.md` §P1/P4（有界与外部输入速率红线）
> - `scripts/pty-viewport-probe.mjs`（实测探针，改动前后各跑一次对比）
>
> **范围**：pty 引擎的 cell_frame 行编码格式。tmux 引擎走 raw 直通，**不受影响**。

---

## 1. 背景与根因

### 1.1 实测数据（2026-08-28，`scripts/pty-viewport-probe.mjs`，100×40 pty 会话）

| 指标 | 实测 |
|---|---|
| 单帧体积 | 94.4 KB（源码 / 数字）、98.5 KB（彩色 ls）、93.4 KB（CJK） |
| 帧体积 vs 步长 | Δy=1 与 Δy=40 **同为 94.4 KB** |
| 请求→响应（本地回环） | p50 **10.2 ms**、p95 12.9 ms |
| 吞吐 | 16 ms 间隔连发 60 → 60 响应，零丢失 |

### 1.2 根因

`CellData` 是**逐 cell 的 JSON 对象**（`src/engine/pty/frame.rs:46-56`）：每个字符携带 `"sgr"` / `"ch"` / `"skip"` 三个键名 + 值，100 列的一行 ≈ 2.4 KB，其中绝大部分是重复的键名与空 sgr。40 行即 94 KB。

滚 1 行也要重传整屏（Δy=1 = Δy=40），是因为 `encode_viewport_frame` 恒输出 `full: true` 整屏全帧 —— **行级 diff 只存在于实时帧路径，历史窗口帧没有**（方向稿 §9 E-4）。

10.2 ms 的延迟主因是服务端**编码 94 KB JSON**（序列化 + 分配），与传输距离无关。

### 1.3 为什么是 RLE 而不是别的

| 方案 | 收益 | 否决理由 |
|---|---|---|
| permessage-deflate（WS 层压缩） | 48–137× | **不可行**：`tungstenite 0.29` 已移除 `deflate` feature，axum 0.8 不透出压缩选项 |
| 应用层 gzip | 48–137× | 收益最高，但要新增二进制帧类型标记（与现有 raw 二进制帧冲突）+ 前端 `DecompressionStream` 降级路径 → 列 P4 可选 |
| **行内 RLE** | **19.5–24.2×** | **本计划采用**：收益稳定（不随内容类型波动）、纯 JSON 协议改动、零浏览器兼容风险、且服务端编码量同比例下降（顺带治 10.2 ms 延迟） |
| 尾部空格截断 | 额外数 KB | 有背景色行尾（TUI 高亮选区）会被抹掉，不安全 → 不纳入（见 §2.2） |

---

## 2. 范围

### 2.1 纳入

| # | 内容 |
|---|---|
| 1 | 后端：行编码由「逐 cell 对象」改为「RLE runs」，`encode_row_static` 单点改造（三帧共用） |
| 2 | 后端：`hello` 握手协商行编码格式，旧客户端继续收 cells 格式 |
| 3 | 前端：`CellFrame` 类型与 `renderRowCells` 支持 runs 格式解码 |
| 4 | 前后端单测 + 探针实测验证 + 手动回归 |

### 2.2 不纳入（含理由）

- **应用层 gzip**：RLE 后单帧已降至个位数 KB，gzip 的边际收益（再 2–6×）不足以抵消二进制帧标记 + 解压降级的复杂度 → 留在方向稿 P4，按 P1 实测结论再定。
- **尾部空格截断**：行尾空格在 TUI 中可能带背景色（选中行高亮），截断会抹掉视觉状态。需按 sgr 分情况处理才安全，属独立优化，不在本计划范围。
- **给历史窗口帧加行级 diff**：能进一步把「滚 1 行」压到 1 行，但要改 diff 基线语义（窗口帧与实时帧两套基线），复杂度显著高于 RLE。RLE 落地后若仍需，另立计划。
- **tmux 引擎**：raw 直通，无 grid 编码。

---

## 3. 设计决策

### D1 行格式：扁平 runs 数组 `[sgr, text, sgr, text, ...]`

```jsonc
// 现在（逐 cell）:  {"cells":[{"sgr":"1;32","ch":"p"},{"sgr":"1;32","ch":"a"}, ...]}
// RLE:              {"runs":["1;32","pa", "","rest of line"]}
```

- **理由**：扁平数组最省 —— 相对 `[[sgr,text],...]` 每 run 省 2 字节，相对 `[{s:"..",t:".."}]` 每 run 省 ~10 字节（按 200 run/帧算，后者会让收益从 21.6× 掉到 ~14×）。
- **否决项**：对象数组（体积）、自定义分隔符字符串（需转义，易错）。
- **翻盘条件**：若前端解析健壮性问题（奇数长度、类型混淆）在测试中反复出现，改为 `[[sgr,text],...]` 二元组。

### D2 编码入口收敛到 `encode_row_static`

三个帧类型（`encode_cell_frame` / `encode_overlay_frame` / `encode_viewport_frame`）都经 `src/engine/pty/vt.rs:665` 的 `encode_row_static` 编码行 —— **只改这一处，三种帧全部受益**。

- **翻盘条件**：无（已核实调用链）。

### D3 能力协商：`hello` 扩展 `row_encoding`

```jsonc
// 客户端 → 服务端（terminal_ws.rs:25-30 ClientHello 扩展）
{"t":"hello","supports_cell_frame":true,"row_encoding":"runs"}
```

- 服务端收到 `row_encoding:"runs"` → `VtState` 切 RLE 模式；字段缺失或为其他值 → cells 模式。
- **理由**：cell_frame 本身已有 hello 握手（`supports_cell_frame`）这一现成的能力协商点，复用它成本最低，且让前后端可独立提交、独立验证、独立回滚。
- **否决项**：不协商、直接切（新旧版本错配必然白屏）；协议版本号（比能力字段重）。
- **翻盘条件**：无。

### D4 双路径为过渡期脚手架，验收后移除 cells 路径

协商期两套编码并存。**P3 验收通过后删除 cells 编码与前端 cells 解码分支**（参照方案 C D8「开关属过渡期脚手架，验收通过后移除」的处置），不留长期双路径。

### D5 宽字符占位 cell：直接跳过（已实测无损）

`skip:true` 的占位 cell 是 `sgr:""`, `ch:""`（`vt.rs:674-682`），前端对它是 `continue` 且**不更新 `prevSgr`**（`useCellFrame.ts:71-79`）—— 即它在渲染输出中完全不存在。故 RLE 合并时跳过它，前后字符合并进同一 run，输出等价。

**已实测**（探针 [D] 组，四类内容逐行模拟渲染比对）：数字 21.6×、彩色 ls 19.5×、源码 21.6×、**CJK 混排 24.2×**，全部 `无损=PASS`。CJK 收益最高正来自占位 cell 被消除。

### D6 前端解码：`renderRowRuns`

`useCellFrame.ts` 新增 `renderRowRuns(runs)`，按 `i += 2` 取 `(sgr, text)`；渲染时 sgr 变化才插入 `reset + SGR`，末尾补 reset。比现有 `renderRowCells` **更快**（同 sgr 的连续字符只切一次样式，而非每字符判断一次）。

行级分派：`row.runs ? renderRowRuns(row.runs) : renderRowCells(row.cells)`。

---

## 4. 多实现差异与降级（AGENTS §8）

| 组合 | 行为 | 保障 |
|---|---|---|
| 新前端 + 新后端 | hello 带 `row_encoding:"runs"` → RLE | 主路径 |
| 旧前端 + 新后端 | hello 无该字段 → cells | 协商降级（D3） |
| 新前端 + 旧后端 | 帧无 `runs` 字段 → 走 cells 分支 | 前端按字段分派（D6） |
| tmux 引擎 | raw 直通，无 grid 编码 | 不受影响 |
| runs 数组长度奇数 | 忽略末尾不完整的对 | 前端防御，不抛异常（S2 不掩盖：记 warn 一次） |

---

## 5. 实施分期

| Phase | 内容 | 改动文件 | 状态 |
|---|---|---|---|
| **P1** | 后端 RLE 编码 + 协商 | `src/engine/pty/frame.rs`（`RowEncoding` + `RowData` 改 enum + runs 编码）、`src/engine/pty/vt.rs`（`encode_row_static` 分派）、`src/engine/pty/terminal_ws.rs`（hello 解析） | ✅ 完成（见 §11 勘误 E-6：行编码改连接级） |
| **P2** | 前端解码与渲染 | `frontend/src/hooks/useCellFrame.ts`（类型 + `renderRowRuns` + 分派）、`frontend/src/hooks/useTerminal.ts`（hello 带 `row_encoding`）、`useCellFrame.test.ts` | ✅ 完成 |
| **P3** | 验证 + 清理 | 探针复跑、手动回归、移除 cells 路径（D4） | ⏳ 待办：手动回归（§6 末组）未完成；cells 路径按 D4 在回归通过后移除 |

P1 与 P2 可并行开发，但端到端验证需两者都就位。

---

## 6. 验收标准

**后端**
- [x] `encode_row_static` 的 runs 编码单测：空行、整行同 sgr、sgr 频繁切换、CJK 宽字符（含占位）、整行单 run、行尾空格
- [x] 不变式单测：runs 展开后的「字符 → 该字符生效时 sgr」序列 == cells 的同一序列（覆盖 D5）
- [x] 协商单测：`parse_row_encoding` 仅 `"runs"` 切 RLE，其余（含字段缺失）回落 cells
- [x] `cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check` 零新增

**前端**
- [x] `useCellFrame.test.ts`：`renderRowRuns` 与 `renderRowCells` 对同一行渲染输出等价（模拟 SGR 状态机判据）
- [x] 兼容性单测：帧无 `runs` 时回落 cells；`runs` 长度为奇数时不抛异常（warn 一次）
- [x] `pnpm lint` / `tsc -b` / `pnpm test --run` 零新增失败（顺手修了既有的一处脆弱断言：resync 用例依赖 jsdom 真实时钟累积到 1s，改为固定 `performance.now()`）

**端到端（`node scripts/pty-viewport-probe.mjs`，改动前后对比）**
- [x] [A] 单帧体积：94.4 KB → **4.8 KB**（目标 ≤6 KB）
- [ ] [A] RTT p50：12.3 ms → **4.8 ms**（目标 ≤3 ms，未达）—— 根因是 30fps tick 争用而非帧体积，见 §10.2
- [x] [D] 四类内容（数字 / 彩色 ls / 源码 / CJK）`无损=PASS`
- [x] [B] 吞吐仍零丢失

**手动回归（`docs/reference/user-testing.md`）** —— P3 待办
- [ ] pty 会话显示正常：CJK、emoji、TUI（htop）、vim、alt-screen 进入/退出
- [ ] 滚动历史窗口内容正确（含 CJK 行的对齐）
- [ ] 快速输出（如 `seq 1 20000`）不丢行、不错位
- [ ] 断线重连补屏正常

**手动回归（`docs/reference/user-testing.md`）**
- [ ] pty 会话显示正常：CJK、emoji、TUI（htop）、vim、alt-screen 进入/退出
- [ ] 滚动历史窗口内容正确（含 CJK 行的对齐）
- [ ] 快速输出（如 `seq 1 20000`）不丢行、不错位
- [ ] 断线重连补屏正常

---

## 7. 风险与降级

| 风险 | 缓解 |
|---|---|
| RLE 破坏渲染等价性 | 已用四类内容逐行模拟渲染验证（D5）；P1/P2 各加不变式单测；端到端探针每次改动后复跑 |
| 新旧版本错配 | hello 能力协商 + 前端按字段分派（§4 四种组合均覆盖） |
| 组合字符 / grapheme 跨 cell | RLE 把连续字符合成一个字符串一次性写入，比逐字符写入**更**利于 xterm 合成 grapheme；手动回归含 emoji 用例 |
| cells / runs 双路径长期滞留 | D4 明确 P3 验收后移除，不留开关 |
| 编码量下降后暴露其他瓶颈（如前端渲染） | P3 实测若 RTT 未达标，用探针数据定位下一瓶颈，回写方向稿 |

---

## 8. 文档闭环

- [ ] `docs/architecture/backend.md`：cell_frame 协议段落补 runs 格式与 hello 协商字段
- [ ] `docs/dev/plans/backlog/pty-mobile-termux-feel.md`：§5 分期表 P1 标为已立项并链回本计划；实测数据（§3.2）在实施后补「改动后」一行
- [ ] `docs/architecture/frontend.md`：不适用（该文件未记录 cell_frame 渲染流程）
- [ ] `CHANGELOG.md`：实施后按 AGENTS 规则 3 添加条目（帧体积是用户可感知的性能改进）

---

## 9. 术语

| 术语 | 含义 |
|---|---|
| cells 格式 | 现行行编码：每 cell 一个 `{sgr, ch, skip}` 对象 |
| runs 格式 | 本计划引入：行内按 sgr 合并连续字符的扁平数组 `[sgr, text, ...]` |
| 占位 cell | 宽字符占的第二列，`skip:true`、`ch:""`，渲染时被跳过 |
| 无损 | 同一行用两种格式渲染后，每个可见字符及其生效 sgr 完全一致 |

---

## 10. 实施后实测（2026-08-28，`scripts/pty-viewport-probe.mjs`，100×40 pty 会话）

### 10.1 收益

| 指标 | 改动前（cells） | 改动后（runs） | 变化 |
|---|---|---|---|
| 单帧体积（数字 seq） | 94.4 KB | 4.8 KB | **19.8×** |
| 单帧体积（彩色 ls） | 98.5 KB | 5.4 KB | 18.1× |
| 单帧体积（源码 cat） | 94.4 KB | 4.8 KB | 19.8× |
| 单帧体积（CJK 混排） | 93.4 KB | 4.3 KB | **21.9×** |
| 请求→响应 p50 | 12.3 ms | 4.8 ms | 2.6× |
| 无损性 | — | 四类内容全部 PASS | 双连接交叉比对 |
| 吞吐（16ms 连发 60 次） | 零丢失 | 零丢失 | 持平 |

无损验证方式同步升级：行编码改为**连接级**后（§11 E-6），探针可对同一会话同时
开 cells 与 runs 两个连接、对同一 y 各取一帧做逐行 `(字符 → 该字符生效时 sgr)`
序列比对——不再是设计期的估算，而是服务端真实产出的交叉验证。

### 10.2 未达标项与根因：RTT p50 4.8 ms（目标 ≤3 ms）

体积降 19.8× 而 RTT 只降 2.6×，说明编码已不是 RTT 的主要成分。用「同环境
cells vs runs 对照」+「临时把 30fps tick 改成 1000ms」两步定位：

| 条件 | runs RTT p50 | runs RTT max |
|---|---|---|
| tick = 33ms（现状） | 4.83 ms | **49.95 ms** |
| tick = 1000ms（仅实验，已还原） | 2.48 ms | 2.67 ms |

**根因**：`src/engine/pty/terminal_ws.rs` 的转发循环用单个 `tokio::select!`
串行处理多路输出，tick 分支与 viewport 分支都在分支内部 `ws_tx.send(..).await`。
一旦某次发送因背压阻塞，**整个 select! 循环就停在该分支上**，期间到达的
viewport 请求只能排队。tick 每 33ms 触发一次，故尖峰与其同周期（后端 trace
日志显示相邻响应间隔 ~41-50 ms 的尖峰，占样本 ~7.5%）。

帧变小后尖峰的**绝对值反而变大**（cells max 21 ms → runs max 50 ms）：cells
时代 p50 本身有 12 ms 的编码成本垫底，尖峰不突出；runs 把常态压到 2.5 ms 后，
tick 争用成为唯一剩下的延迟源，对比度因此变高。cells 侧同样受此影响
（tick=1000ms 时 p50 12.3 → 9.7 ms）。

**不纳入本计划**：修它要动转发循环的 task 结构（把发送移出 select! 分支，或让
viewport 响应绕过排队），有方案取舍 → 另立项，已登记到方向稿 §5。

### 10.3 编码成本本身

tick=1000ms 下 cells p50 9.73 ms / runs p50 2.48 ms → **94 KB 的 JSON 编码约占
7.3 ms**，与方向稿 §9 E-2「p50 10.2ms 主因是服务端编码」的推断吻合。

---

## 11. 勘误与实施偏差

### E-6 行编码由会话级改为连接级（实施期修正）

原设计（D3）把 `row_encoding` 存在 `VtState` 上。实施中发现这是把**视图属性**
放进了**屏幕状态**：一个 pty 会话可被多个 WS 连接同时 attach（多标签页/多设备），
会话级存放会互相覆盖——若最后 hello 的是新客户端，先前连着的旧客户端就会被切
成 runs 格式而白屏（它只认 cells）。

改为：`encode_cell_frame` / `encode_overlay_frame` / `encode_viewport_frame`
各接受一个 `encoding: RowEncoding` 参数，由 `terminal_ws.rs` 按连接持有
（`Arc<Mutex<RowEncoding>>`，hello 时写入、编码时瞬时读取，不跨 await）。
`VtState` 恢复「纯屏幕真相源」语义。

正向副作用：两个连接可用不同编码并存，探针因此能做 §10.1 的交叉无损验证。
