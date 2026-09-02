# PTY 帧 RLE 编码（pty 移动端手感改造 P1）

> **状态**：P1/P2/P3 已实施（P3 于 2026-08-30 完成，**D4 已执行**：cells 路径移除，
> runs 为唯一行编码）。**实施后实测见 §10** —— 帧体积 94.4 KB → 4.8 KB（19.8×）、
> RTT p50 12.75 ms → 2.78 ms、四类内容结构自洽全部 PASS。过程中暴露并一并修掉
> 两个独立的延迟源：diff 指纹的每帧 4000 次堆分配（E-7）与 Nagle + Delayed ACK
> 造成的 ~40 ms 尾延迟（E-8）；D4 执行期又暴露并修掉三个缺陷，见 §11 E-9/E-10/E-11。
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
| 3 | 前端：`CellFrame` 类型与行渲染支持 runs 格式解码（D4 后为唯一路径） |
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

### D3 能力协商：`hello` 扩展 `row_encoding`（**已随 D4 移除**）

协商期（P1/P2）的做法：`hello` 带 `row_encoding:"runs"` → 本连接切 RLE，字段缺失
回落 cells，行编码按**连接**持有（`Arc<Mutex<RowEncoding>>`，见 E-6）。

**D4 执行后（2026-08-30）该字段与 `RowEncoding` 一并删除**：`hello` 只需
`{"t":"hello","supports_cell_frame":true}`，cell_frame 一律是 runs。

### D4 双路径为过渡期脚手架，验收后移除 cells 路径

协商期两套编码并存。**P3 验收通过后删除 cells 编码与前端 cells 解码分支**（参照
方案 C D8「开关属过渡期脚手架，验收通过后移除」的处置），不留长期双路径。

> **已执行（2026-08-30）**，连带改动与取舍见 §11 E-9：后端删 `RowEncoding` /
> `CellData` / `row_cells`、前端删 `renderRowCells` 与按字段分派、`RowData` 由
> untagged enum 收敛为 `{ runs }` struct。无损性判据随之迁移（不再有第二种编码
> 可交叉比对）。

### D5 宽字符占位 cell：直接跳过（已实测无损）

`skip:true` 的占位 cell 是 `sgr:""`, `ch:""`（`vt.rs:674-682`），前端对它是 `continue` 且**不更新 `prevSgr`**（`useCellFrame.ts:71-79`）—— 即它在渲染输出中完全不存在。故 RLE 合并时跳过它，前后字符合并进同一 run，输出等价。

**已实测**（探针 [D] 组，四类内容逐行模拟渲染比对）：数字 21.6×、彩色 ls 19.5×、源码 21.6×、**CJK 混排 24.2×**，全部 `无损=PASS`。CJK 收益最高正来自占位 cell 被消除。

### D6 前端解码：`renderRow`（协商期名 `renderRowRuns`）

`useCellFrame.ts` 的行渲染按 `i += 2` 取 `(sgr, text)`；渲染时 sgr 变化才插入
`reset + SGR`，末尾补 reset。比逐 cell 判断**更快**（同 sgr 的连续字符只切一次样式）。

> **D4 后**：协商期曾有 `renderRowRuns` / `renderRowCells` 两个函数与按字段的
> 行级分派；cells 移除后收敛为单个 `renderRow(runs)`（奇数长度仍记一次 warn）。

---

## 4. 多实现差异与降级（AGENTS §8）

> **D4 后无行编码降级**：前后端由同一产物发布（前端 dist 经 `rust-embed` 编入
> 后端二进制，`src/embedded.rs`），不存在「新前端 + 旧后端」的运行组合，故不留
> cells 解码分支。浏览器缓存住旧 dist 时旧前端会读不到 `runs` 而显示空行 ——
> 接受该代价（强刷即恢复），以换取单一编码路径。

| 组合 | 行为 | 保障 |
|---|---|---|
| 同版本前后端 | hello 开 cell_frame → 一律 runs | 主路径 |
| 未发 hello（raw 直通前端） | 收原始字节流，无 cell_frame | 既有 raw 路径保留 |
| tmux 引擎 | raw 直通，无 grid 编码 | 不受影响 |
| runs 数组长度奇数 | 忽略末尾不完整的对 | 前端防御，不抛异常（S2 不掩盖：记 warn 一次） |

---

## 5. 实施分期

| Phase | 内容 | 改动文件 | 状态 |
|---|---|---|---|
| **P1** | 后端 RLE 编码 + 协商 | `src/engine/pty/frame.rs`（`RowEncoding` + `RowData` 改 enum + runs 编码）、`src/engine/pty/vt.rs`（`encode_row_static` 分派 + 零分配行指纹）、`src/engine/pty/terminal_ws.rs`（hello 解析）、`src/main.rs`（TCP_NODELAY） | ✅ 完成（偏差见 §11 E-6/E-7/E-8） |
| **P2** | 前端解码与渲染 | `frontend/src/hooks/useCellFrame.ts`（类型 + 行渲染）、`frontend/src/hooks/useTerminal.ts`（hello 带 `row_encoding`，D4 后移除该字段）、`useCellFrame.test.ts` | ✅ 完成 |
| **P3** | 验证 + 清理 | 探针复跑、自动化回归、移除 cells 路径（D4） | ✅ 完成（2026-08-30）：自动化回归 17/17、探针复跑达标、cells 路径已移除；剩浏览器内视觉确认（§6 末组） |

P1 与 P2 可并行开发，但端到端验证需两者都就位。

---

## 6. 验收标准

**后端**
- [x] `encode_row_static` 的 runs 编码单测：空行、整行同 sgr、sgr 频繁切换、CJK 宽字符（含占位）、整行单 run、行尾空格
- [x] 不变式单测：runs 展开后的「字符 → 该字符生效时 sgr」序列 == cells 的同一序列（覆盖 D5）
- [x] 协商单测：`parse_row_encoding` 仅 `"runs"` 切 RLE，其余（含字段缺失）回落 cells（该单测随 D4 删除）
- [x] `cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check` 零新增

**前端**
- [x] `useCellFrame.test.ts`：行渲染输出与逐字符渲染的参考实现等价（模拟 SGR 状态机判据；D4 后参考实现不再 `renderRowCells`）
- [x] 兼容性单测：帧无 `runs` 时回落 cells；`runs` 长度为奇数时不抛异常（warn 一次）
- [x] `pnpm lint` / `tsc -b` / `pnpm test --run` 零新增失败（顺手修了既有的一处脆弱断言：resync 用例依赖 jsdom 真实时钟累积到 1s，改为固定 `performance.now()`）

**端到端（`node scripts/pty-viewport-probe.mjs`，改动前后对比）**
- [x] [A] 单帧体积：94.4 KB → **4.8 KB**（目标 ≤6 KB）
- [x] [A] RTT p50：12.75 ms → **2.78 ms**（目标 ≤3 ms，2026-08-30 复测）—— 需连 E-7/E-8 一起才达标，见 §10.2
- [x] [D] 四类内容（数字 / 彩色 ls / 源码 / CJK）帧体积与 runs 结构自洽 PASS
- [x] [B] 吞吐仍零丢失

**手动回归（`docs/reference/user-testing.md`）** —— P3 剩余项
- [ ] pty 会话显示正常：CJK、emoji、TUI（htop）、vim、alt-screen 进入/退出
- [ ] 滚动历史窗口内容正确（含 CJK 行的对齐）
- [ ] 快速输出（如 `seq 1 20000`）不丢行、不错位
- [ ] 断线重连补屏正常

> 其中可结构化断言的部分已由 §10.4 的自动化回归覆盖（**17/17 PASS**，连跑三轮
> 稳定），此处剩的是**浏览器内的视觉确认**（字体、配色、光标形状、emoji 字形、
> TUI 刷屏观感）—— 需人工过一遍。

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

- [x] `docs/architecture/backend.md`：cell_frame 协议段落改写为「runs 是唯一行编码」（含零宽字符、重连全帧、ticker 唤醒点三条约束）
- [x] `docs/dev/plans/backlog/pty-mobile-termux-feel.md`：§5 分期表 P1 标为已实施并链回本计划；§3.3 补「改动后」实测（含 P1.5）
- [x] `docs/architecture/frontend.md`：不适用（该文件未记录 cell_frame 渲染流程）
- [x] `CHANGELOG.md`：已添加条目（2026-08-28，`[backend]` `[frontend]` pty 终端帧体积瘦身 20 倍）

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

两种行编码各跑一轮（`node scripts/pty-viewport-probe.mjs` 与
`ROW_ENCODING=cells node ...`），同一环境、同一后端二进制：

| 指标 | cells（旧） | runs（新） | 变化 |
|---|---|---|---|
| 单帧体积（数字 seq） | 94.4 KB | 4.8 KB | **19.8×** |
| 单帧体积（彩色 ls） | 98.5 KB | 5.4 KB | 18.1× |
| 单帧体积（源码 cat） | 94.4 KB | 4.8 KB | 19.8× |
| 单帧体积（CJK 混排） | 93.4 KB | 4.3 KB | **21.9×** |
| 请求→响应 p50 | 12.75 ms | **2.84 ms** | 4.5× |
| 请求→响应 p95 | 15.87 ms | 5.38 ms | 3.0× |
| 请求→响应 max | 15.93 ms | 6.07 ms | 2.6× |
| 实时 diff 帧平均 | 3758 B | **409 B** | 9.2×（实时流同样走 runs） |
| 无损性 | — | 四类内容全部 PASS | 双连接交叉比对 |
| 吞吐（16ms 连发 60 次） | 零丢失 | 零丢失 | 持平 |

验收标准里的「RTT p50 ≤3 ms」**达标**（2.84 ms）。

当时的无损验证方式：行编码是**连接级**的（§11 E-6），探针可对同一会话同时开
cells 与 runs 两个连接、对同一 y 各取一帧做逐行 `(字符 → 该字符生效时 sgr)`
序列比对——不是设计期的估算，而是服务端真实产出的交叉验证。**D4 后该对照消失**
（只有 runs），判据迁移见 §11 E-9。

> 两种编码的 RTT 不能在同一轮里对照测：两条连接共享同一个 Node 事件循环，
> 另一条持续收 30fps 实时帧会把本组的尾延迟抬高一个量级（曾据此得出过错误
> 结论）。故探针一轮只开一条连接。

### 10.2 过程中暴露并修掉的两个独立延迟源

原假设是「p50 的主因就是编码 94 KB JSON」。实测后发现不止于此——按发现顺序：

**(a) diff 指纹的每帧 4000 次分配（§11 E-7）**

`encode_cell_frame` 的 diff 路径先 `row_cells()` 为整行构造 `CellData`（每 cell
一次 `sgr_body` 的 String 分配 + 一次 `to_string`），再交给 `hash_row`。40×100 的
屏即 4000 次分配/帧。RLE 把行编码成本压下来后，这笔开销反成了实时帧的主要成本：
30fps tick 的「编码 + 发送」实测 p50 **7.5 ms**/帧，占转发循环 23% 的时间——而
同一循环内分支的 `send().await` 一阻塞，其余分支（含 viewport 请求）就得不到轮询。
改为 `hash_grid_row` 直接遍历 grid 后，>5 ms 的慢帧告警从 **405 次/轮降到 2 次**。

**(b) Nagle + Delayed ACK（§11 E-8）**

修掉 (a) 后，RTT 的尾部尖峰（max ~50 ms）**仍在**。逐项排除：后端 viewport 处理
只占 p50 2.5 ms / max 6.3 ms，其中 send 仅 50-150 µs（即无背压）；单连接、非
V8 GC 均已排除。~40 ms 这个量级指向 Delayed ACK 超时：WebSocket 每 33 ms 发一个
~200 B 的实时小帧，Nagle 会把它攒到前一个包的 ACK 到达，与对端 40 ms 的
Delayed ACK 叠加。给 accept 的每个连接开 `TCP_NODELAY` 后，max 从 50 ms 降到
**6.07 ms**、p95 从 42 ms 降到 5.38 ms，两轮稳定复现。

tick 之所以是这个链条的触发点：只有它在 33 ms 周期上持续产出小包——临时把它改成
1000 ms 尖峰即消失，这是最初的定位线索（该实验已还原，tick 仍为 33 ms）。

**遗留的结构弱点**：转发循环是单个 `select!`，分支内的 `send().await` 一旦被背压
阻塞仍会拖住其余分支。当前帧已小到几乎不触发，故不改动 task 结构；在 tick 分支
留了 `SLOW_FRAME_US` 告警作为哨兵，防止其悄悄回潮。

### 10.3 编码成本

cells p50 12.75 ms − runs p50 2.84 ms ≈ **10 ms**，是「94 KB 的 JSON 编码 +
序列化 + 传输」的总差，与方向稿 §9 E-2「p50 主因是服务端编码」的推断吻合。

### 10.4 自动化回归（`scripts/pty-frame-regression.mjs`）

§6 手动回归里可结构化断言的部分已脚本化，17 项全 PASS（2026-08-30 连跑三轮稳定）：

| 组 | 断言 | 结果 |
|---|---|---|
| T1 | 历史窗口相邻 y 恰好错开 1 行（数字 seq，5 个 y × 39 行 = 195 行比对） | 错位 0 |
| T2 | 同上（CJK 混排 1500 行）+ 行显示宽度不超屏宽 | 错位 0，最宽 100/100 列 |
| T3 | emoji / 组合字符：runs 解码的行文本能在 pty 原始字节流里原样找到（raw 直通连接作独立真相源）+ runs 结构成对且 text 非空 + 组合音标未被吞 | 一致 |
| T4 | `seq 1 20000` 输出中滚动窗口逐行差恒为 1（6 次全窗口取样） | 跳号 0 |
| T5 | alt-screen：进入发 `alt_screen=true` overlay、退出发 `false`、退出后主屏恢复且无 alt 残留 | 全通过 |
| T6 | TUI（less / top）帧可解析、内容非空 | 通过（htop/vim 未安装，用 less/top 代替） |
| T7 | 断线重连：首帧 `full:true` 且 40 行、可见屏含断开前内容、末行一致 | 通过 |

> **T3 的独立真相源如何随 D4 演变**：原本是 cells / runs 双连接交叉比对（§11
> E-9）；cells 移除后改为 raw 直通连接（不发 hello）的 pty 原始字节流 —— 它比
> 「另一种编码」更外一层，于是暴露了 cells 与 runs 都漏掉的零宽组合字符缺陷
> （§11 E-10）。

**RTT 复测偏差（2026-08-29 那次）**：p50 一度稳定在 4.7–4.8 ms，高于 §10.1 的
2.84 ms。判定为**环境基线差异而非 RLE 退化**：同环境 cells 对照 p50 12.56 ms 与
§10.1 一致、帧体积与内容判据一致、后端零 `slow tick frame` 告警。差异落在 2 ms
量级，属测量环境敏感度。

**2026-08-30（D4 后）复测**：p50 **2.78 ms**、p95 4.01 ms、max 4.34 ms，帧体积
4.8 KB —— 回到 §10.1 的水平，验收标准「p50 ≤3 ms」达标。

**2026-08-30（`history_size` 字段后）复测**：p50 4.66 ms、p95 5.07 ms、
max 5.30 ms，帧体积 4.8 KB，实时 diff 帧平均 419 B（字段前 409 B，+10 B）。
该值落在上一节记录的 4.7–4.8 ms 环境带内，**判为环境基线而非字段退化**：
`history_size` 取 `grid.history_size()`（O(1)）、帧体积仅增 10 B，无法解释
2 ms 量级差异；同轮 [D] 四类内容结构仍全部 PASS。

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

### E-7 diff 行指纹改为零分配（实施期，由 §10.2(a) 暴露）

原 `hash_row(&[CellData])` 的输入来自 `row_cells()`，后者为整行构造 `CellData`
（每 cell 一次 `sgr_body` 的 String 分配 + 一次 `c.to_string()`）。40×100 的屏 =
4000 次分配/帧，30fps 下即 12 万次/秒——RLE 压下行编码成本后，这笔开销成了
实时帧的主要成本（实测 tick 帧 7.5 ms/帧）。

改为 `hash_grid_row(grid, cols, line)` 直接遍历 grid：字符用码点、样式用
`(flags.bits(), color_key(fg), color_key(bg))`，全程无堆分配。指纹只需保证
「内容/样式变 → 值变」，无需经过 SGR 字符串，故与编码格式解耦。

`row_cells`（仅服务于 hash）与 `frame::hash_row` 一并删除，无死代码残留。
新增单测 `row_hash_detects_content_and_style_changes` 守住「变必检出」——漏检的
后果是 diff 帧不发该行、界面停在旧内容，属静默错误。

### E-8 给每个 TCP 连接开 TCP_NOELAY（实施期，由 §10.2(b) 暴露）

原启动时直接 `axum::serve(TcpListener, ..)`，accept 出的连接保持系统默认的
Nagle 开启。终端是交互式小包流，小帧被 Nagle 攒到 ACK 到达，与对端 40 ms 的
Delayed ACK 叠加后，单次请求-响应的尾延迟暴涨到 ~50 ms。

改为用 axum 自带的 `ListenerExt::tap_io`（`src/main.rs`）在 accept 时对每个
连接 `set_nodelay(true)`，跨平台且不新增依赖（axum 官方示例即为此用途）。
HTTP 响应同样受益。

### E-9 D4 执行：cells 路径移除与判据迁移（2026-08-30）

**移除内容**：`frame::RowEncoding` / `frame::CellData` / `RowData::Cells` /
`vt::encode_row_cells` / `terminal_ws::parse_row_encoding` /
`ClientHello::row_encoding` / 连接级 `Arc<Mutex<RowEncoding>>`；前端 `CellData` /
`renderRowCells` / `renderRow` 的字段分派 / `hello` 的 `row_encoding`。
`RowData` 由 untagged enum 收敛为 `{ runs: Vec<String> }` struct（线格格式不变）。

**无损性判据迁移**（cells 消失后交叉比对失去对象，改由三层守住）：

| 层 | 判据 |
|---|---|
| 后端单测 | `runs_encoding_is_lossless_against_grid`：runs 解码的「字符 → 生效 sgr」序列 == **直接遍历 grid** 的独立参考实现（`grid_seq`） |
| 前端单测 | `renderRow` 输出 == 逐字符渲染参考实现（`renderPerChar`），经模拟 SGR 状态机比对 |
| 端到端 | 回归脚本 T3：runs 解码的行文本 == pty 原始字节流（raw 直通连接） |

**版本错配的取舍**：前端 dist 编入后端二进制，同产物发布，故不留 cells 解码
（§4）。缓存住旧 dist 的浏览器会读到无 `runs` 的行 → 空行，强刷恢复。

**测量脚本一并改造**：`pty-viewport-probe.mjs` 删掉 `ROW_ENCODING` 与双连接对照，
[D] 组改为「帧体积 + runs 结构自洽」；`pty-frame-regression.mjs` 的 T3 改用 raw
连接对照。

### E-10 零宽组合字符被丢弃（D4 执行期由 T3 的 raw 对照暴露）

alacritty 把组合音标、emoji 变体选择符之类**零宽**字符存在 cell 的
`zerowidth` 里（`Cell::zerowidth()`），而编码只取 `cell.c` → `e` + U+0301 显示成
`e`。cells 与 runs 两种编码都漏它，所以旧的交叉比对测不出来；换成 raw 字节流
对照后立刻暴露。

修复：`push_cell_text()` 把主字符与零宽字符一起写入 run（常态零分配，不回到
E-7 之前的每 cell 一次 String 分配）；行指纹 `hash_grid_row` 也混入零宽字符，
否则组合字符变化不会被 diff 检出（静默错误）。单测
`runs_keeps_zerowidth_combining_characters` 守这条。

### E-11 重连到空闲会话时 cell_frame 静默不启用（D4 执行期由 T7 暴露）

`forward_handle` 的 ticker 原本是懒初始化：loop 顶部见 `cell_frame_enabled`
为真才创建。但 loop 主体是单个 `select!`，会话空闲（pty 无输出、无 viewport
请求）时它**永久挂起**，之后到达的 hello 再无机会被 loop 顶部看到 → 连接停
在 raw 模式，既不发 cell_frame，也不再消费 `viewport_request`（该分支只存在于
cell_frame 分支内）。重连到一个空闲会话即必现（T7 时 pass 时 fail）。

修复：ticker 在连接建立时创建，raw 模式的 `select!` 保留
`_ = ticker.tick() => {}` 空分支作唤醒点（33 ms 一次空转，代价可忽略）。

同一轮还修了 T7 暴露的另一处：新连接 attach 到既有会话时 diff 基线是会话共享
的，首帧是 diff 而非 full，前端画面与后端 grid 已错位（断开期间的滚动不会
补发）→ `attach.reconnected` 时先 `invalidate_diff()`。
