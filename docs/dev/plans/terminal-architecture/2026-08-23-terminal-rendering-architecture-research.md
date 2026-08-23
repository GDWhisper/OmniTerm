# 自研终端渲染架构研究计划

> 状态：草稿（待评审）
> 触发：alt-screen 水印 bug 修复过程中暴露的 raw-byte pass-through 架构局限性
> 关联：`docs/dev/plans/2026-07-28-pty-engine-implementation.md`（Phase 2 补屏机制依赖此架构）

## 0. 问题定义

### 现况

OmniTerm 的 pty 终端渲染走的是一条**原始字节透传**路径：

```
pty 子进程 → 读循环 → broadcast::Sender → WS → xterm.js.write(byte)
                ↓
           VT grid（alacritty_terminal，旁路跟踪）
```

VT grid 是"屏幕真相源"——只有它维护完整 cell-level 状态，用于：
- `capture_screen()`（agent 检测）
- `render_screen()`（重连补屏、重建回放）
- `capture_visible()`（文本快照）

但**渲染输出不是从 VT grid 来的**——前端 xterm.js 自己维护一套完全独立的终端状态机（double-buffer、alt/normal screen、scrollback），只靠原始字节流同步。两个状态机之间存在**不可桥接的语义鸿沟**。

> **tmux 引擎说明**：OmniTerm 有 PtyEngine 和 TmuxEngine 两个会话引擎。tmux 的渲染完全由 tmux 进程自身控制（`capture-pane -p` 提供纯文本快照，无服务端 VT grid），本节的 raw-byte pass-through 局限分析仅针对 PtyEngine。tmux 引擎在候选架构设计中的角色见 §3.1。

### 已暴露的结构性局限

| # | 局限 | 表现 | 现有 workaround |
|---|------|------|----------------|
| A1 | 无服务端渲染权威 | alt→normal 切换产生水印（本 bug） | 读循环检测 + render_screen() 注入 |
| A2 | 无 diff 输出能力 | 每次输出全量推送，带宽浪费 | 无 |
| A3 | 模式切换不可见 | 服务端 VT grid 知道 DECSET 状态，但无法干预前端 | 无 |
| A4 | scrollback 双轨 | ByteRing 落盘 + xterm.js 本地 scrollback 不一致 | 重建时 replay 进两者 |
| A5 | 无服务端 selection 能力 | 前端拖选复制看不到服务端屏幕内容 | pty 路径走 xterm.js 本地选区（D12） |
| A6 | agent 检测异步 | capture_screen() 读取 VT grid 快照，是"正在写入"的异步镜像 | 读循环 out→vt 锁序保证快照一致性 |
| A7 | 补屏时序粗粒度 | 退出 alt-screen 时补屏帧发送时机落后于主屏内容恢复 | 方向 2 / 方案 A 补丁 |

> **A7 的重新归类**：Exit TUI 画面不可控的根因是补屏帧发送时机不够精细（当前补屏依赖读循环事件驱动，无法感知 VT grid 已完成主屏恢复），而非 raw-byte pass-through 架构无法渲染。`VtState::capture_visible()` 能拿到正确的主屏内容，说明服务端已有能力渲染正确画面，只是通知前端的时机不对。

### 为什么修补式修复不够

每次遇到一个新场景（alt exit、scrollback sync、selection），都需要在 raw-byte pass-through 上打一个不对称的补丁。补丁之间互相不知道对方的存在，累积到一定程度会产生：
- 补丁之间的时序竞争
- 同一画面的多个渲染来源冲突
- 越来越复杂的"正确顺序"依赖

这不是"可以以后重构"的技术债——每加一个补丁，后续补丁的复杂度递增。需要注意的是，候选 B（选择性覆盖）通过系统化检测点来替代随机补丁，可将复杂度增量从 O(n²) 降为 O(n)。

## 1. 研究目标

**核心问题**：OmniTerm 是否需要从 raw-byte pass-through 迁移到服务端语义帧渲染？如果是，路径是什么？

### 1.1 待验证假设

| 假设 | 验证方法 | 通过标准 |
|------|---------|---------|
| H1：cell-level 语义帧能覆盖结构性局限（A1-A6） | 对照三个参考实现的架构 | A1-A6 每个局限有对应机制覆盖；A7（补屏时序）在 cell-level 方案下自然解决，也可由候选 B 以更小代价覆盖 |
| H2：迁移代价在可接受范围内 | 估算 WS 协议 + 前端渲染 + 后端输出路径的改动量 | < 2 人月（增量迁移，非一次性切换） |
| H3：可以渐进迁移 | 检查现有 render_screen() / capture_visible() 能否作为迁移种子 | 至少一个可独立运行的渲染模式 |
| H4：WebSocket 带宽在 cell-level 帧方案下可接受 | 测算典型 TUI 场景的帧大小与频率 | 增量 diff < 原始字节流 |
| H5：xterm.js 不能直接消费 cell-level 帧 | 检查 xterm.js API 是否支持逐 cell 写入 | 如果支持则前端改动更小 |

### 1.2 非目标

- **不做**：直接切换到 herdr 的 libghostty-vt（Zig FFI，与本项目 alacritty_terminal 路线冲突）
- **不做**：替换前端 xterm.js（除非验证证明它无法适配）
- **不承诺**：任何特定的实现路径——本计划是研究，不是实施计划

## 2. 参考实现深度分析

### 2.1 herdr（Apache-2.0，可分析）

**关键架构决策**：

| 决策 | 证据 | 可借鉴程度 |
|------|------|-----------|
| VT 解析 + cell-level frame 输出 | `protocol/wire.rs`：`FrameData { cells: Vec<CellData>, width, height, cursor }` | 高——协议定义直接可用 |
| 两种渲染模式可选 | `RenderEncoding::SemanticFrame`（cell diff） / `RenderEncoding::TerminalAnsi`（ANSI bytes） | 高——渐进迁移的模板 |
| TerminalAnsi 模式也做 clear-before-full-redraw | `render_ansi.rs:full_redraw && clear_before_full_redraw → \x1b[2J` | 中——与本项目补屏帧逻辑等价 |
| 前端 diff 计算在服务端 | `BlitEncoder::encode` 对比 prev frame → 仅写变化的 cell | 高——解决 A2 |
| input_state 跟踪 | `InputState { alternate_screen, mouse_protocol_mode, ... }` | 高——解决 A3 |
| handoff_history_ansi 跳过 alt-screen | `pane.rs:1555-1565`：alt-screen 激活时返回 `None` | 中——与本项目 scrollback 策略一致 |

**herdr 不涉及的场景**（本项目需自行决策）：
- herdr 的 client 是原生 GUI（crossterm），无 xterm.js 约束
- herdr 用 libghostty-vt，本项目用 alacritty_terminal——VT grid API 不同
- herdr 无 ACP/tmux 双引擎并存

### 2.2 zellij（MIT，可分析）

**关键架构决策**：

| 决策 | 证据 | 可借鉴程度 |
|------|------|-----------|
| 自建 Grid，不依赖外部 VT 库 | `panes/grid.rs`：`AlternateScreenState` 保存/恢复完整主屏 | 中——本项目已选 alacritty_terminal，不回改 |
| `force_change_size → update_all_lines` | `grid.rs`：exit alt 时触发全 viewport 重绘 | 高——证明全量重绘是行业共识 |
| Tab 级 `should_clear_display_before_rendering` | `tab/mod.rs`：`\x1b[m\x1b[2J` pre-VTE instruction | 中——zellij 控制整个渲染管线 |
| `clear_viewport_before_rendering` dead field | 写入 3 处、读取 0 处 | 教训——不要留半成品机制 |
| 服务端权威渲染 | 所有内容经过 zellij 渲染管线，客户端只做最终输出 | 高——但本项目前端 xterm.js 是强约束 |

### 2.3 OmniTerm 自身（分析对象）

**已有基础（可复用于新架构）**：
- `VtState::render_screen()`：按 cell 遍历并输出紧凑 ANSI SGR 字节（`\x1b[0m`+`\x1b[...m`+CUP 换行；非结构化 cell 列表，可直接作为补屏帧前端）
- `VtState::capture_visible()`：cell-level 文本快照
- `VtState::feed()` / `Term::mode()`：VT 状态查询能力
- `ByteRing`：256KB 有界环形缓冲
- `scrollback` 落盘模块（分文件 / 0600 / tmp+rename）
- `Output { ring, tx }`：输出汇聚点，已有 lock 保证原子快照

**缺失能力（需新增）**：
- cell-level diff 计算（对比 prev frame，输出变更 cell 列表）
- 前端 cell-level 渲染器（xterm.js 或替代方案）
- 模式切换事件通知（alt-screen enter/exit、scroll region 变化等）
- 服务端 cursor 位置同步

## 3. 候选架构

### 3.1 候选 A：渐进式双模式（推荐研究）

保持 raw-byte pass-through 为默认，新增 SemanticFrame 模式为可选。

**tmux 引擎的适配**：tmux 没有服务端 VT grid，无法生成 cell-level 帧。候选 A 的渐进迁移路径中 tmux 会话始终使用 legacy 模式，pty 会话可选 SemanticFrame。WS 层区分帧来源——pty SemanticFrame 走 text frame（JSON/bincode），tmux 和 pty legacy 走 binary frame（raw bytes）。前端已有的双通道能力可直接复用。

```
                        ┌─────────────────┐
                        │  VT grid (真相源) │
                        └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
               legacy 模式                SemanticFrame 模式
          (现有 raw-byte)              (新增 cell-level)
                    │                         │
          broadcast::Sender        FrameDiffEngine
          WS binary (bytes)         ┌──────────────┐
          xterm.js 消费             │ prev vs curr │
                                    │ cell diff    │
                                    └──────────────┘
                                           │
                                   WS text (JSON/bincode)
                                   frontend::FrameRenderer
                                   (逐 cell 写入 xterm.js)
```

**优势**：
- 零破坏现有路径
- 可在创建会话时选择渲染模式（类似 D12 引擎选择器）
- pty 和 tmux 各有最优模式，渐进迁移不要求统一
- 不同模式间的切换有 fallback（切换 mode → 发送全帧 → 切换到新模式）

**需要验证**：
- xterm.js 能否高效消费 cell-level 帧（逐 cell CUP + SGR + 字符写入的性能）
- 增量 diff 的帧大小 vs 原始字节流（典型 TUI 场景的帧频和大小）
- bincode vs JSON 序列化性能

### 3.2 候选 B：选择性覆盖架构（raw-byte + selective semantic overlay）

保持 raw-byte 为主，仅在服务端知道但客户端无法感知的特定语义事件点注入全帧：
- alt-screen 进入/退出时注入全帧
- 全屏 redraw 时注入全帧
- 模式切换（DECSET/DECRST）时注入全帧
- 其他时刻 raw-byte 透传

这是对当前补丁方案的**系统化升级**——将零散的 render_screen() 触发点从事件驱动升级为语义事件驱动的渲染覆盖层。与 zellij 的 clear_viewport_before_rendering 机制同构。

**优势**：
- 改动面可控（只在检测点额外发一帧，不改变正常输出路径）
- 解决 A1（alt-screen 水印）、A3（模式切换可见）、A7（补屏时序）
- 不引入 diff 引擎或前端渲染器改造
- tmux 引擎天然适用

**劣势**：
- 不解决 A2（diff 输出）、A4（scrollback 双轨）、A5（selection）、A6（agent 检测异步）
- 检测点覆盖不全时仍有盲区
- 相比 cell-level 方案是中间路线，长期仍需择路

### 3.3 候选 C：全量 cell-level（herdr 模式）

完整替换 raw-byte pass-through，服务端 cell-level frame 为唯一输出。

**优势**：
- 一次性解决全部 A1-A7
- 架构最干净

**劣势**：
- 改动面最大（WS 协议、前端渲染、后端输出路径）
- xterm.js 作为 cell-level frame 渲染器的适用性未知
- 没有渐进路径

## 4. 研究计划与里程碑

### Phase R1：xterm.js cell-level 渲染可行性验证（1-2 天）

**目标**：验证假设 H5——xterm.js 能否高效消费 cell-level 帧。

**方法**：
1. 写一个微型 benchmark：模拟 24×80 的 `FrameData`，逐 cell 写入 xterm.js
2. 对比吞吐：原始 ANSI 字节 vs cell-level CUP+SGR+字符
3. 检查 xterm.js 是否有批量写入 API（`term.write()` 之外的优化路径）
4. 测试 UI 冻结：xterm.js 的单线程模型在大帧时的卡顿

**量化验收标准**：
- 通过：逐 cell 写入 80×24 全帧耗时 ≤ 16ms（60fps 预算）
- 有条件通过：逐 cell 写入 ≤ 50ms，且存在可优化的批量路径
- 不通过：逐 cell 写入 > 50ms 且无可用批量 API

**失败后续**：如果逐 cell 不通过，估算自建 canvas 渲染器成本（≥ 3 人月，同等功能覆盖+无障碍+IME → 不推荐）

**产出**：
- `docs/dev/plans/terminal-architecture/bench-xterm-cell-render.md`
- 通过/不通过/有条件通过 的量化结论

### Phase R2：帧大小与频率实测（1-2 天）

**目标**：验证假设 H4——cell-level 帧的带宽可接受。

**方法**：
1. 在实际 pty 会话中运行典型 TUI（vim、htop、opencode、bash）
2. 用现有 `ByteRing` 记录原始字节流
3. 对每一帧计算 cell-level diff 大小（模拟 `BlitEncoder` 的逻辑）
4. 统计：最大帧大小、平均帧大小、每秒帧数、每秒总字节数
5. 对比场景：纯文本 vs 彩色 TUI vs 宽字符

**产出**：
- `docs/dev/plans/terminal-architecture/frame-size-benchmarks.md`
- 帧大小分布直方图
- 带宽 vs 原始字节流的比值

> **执行策略**：R1 和 R2 互不依赖，建议并行启动以压缩整体研究周期。R3 依赖 R1/R2 的数据。R4 依赖全部前三项。

### Phase R3：参考实现架构对比文档（2-3 天）

**目标**：系统化对比 three implementations，产出决策依据。

**内容**：

> **tmux 侧说明**：能力矩阵和 migration mapping 表中需额外记录「该能力对 tmux 引擎的适用性」（继承 / 不可用 / 需 alternative 实现）。

- herdr：wire 协议定义（`wire.rs`）、渲染管线（`render_ansi.rs`）、VT 接口（libghostty-vt）
- zellij：Grid 架构（`grid.rs`）、渲染管线（`output_buffer`）、DECSET 处理
- OmniTerm：现有架构（`mod.rs`、`vt.rs`、`ring.rs`）、渲染路径（`terminal_ws.rs`）

**产出**：
- `docs/dev/plans/terminal-architecture/reference-implementations.md`
- 对照表：能力矩阵（alt-screen、scrollback、mouse、selection、diff rendering）
- 迁移映射表：herdr Feature X → OmniTerm 对应位置 / 改动量

### Phase R4：候选架构设计 + 决策（2-3 天）

**目标**：基于 R1-R3 的可验证数据，选定迁移候选 + 设计增量路径。

**内容**：
- 选定候选架构（A/B/C 其一或组合）
- 增量迁移步骤（每个步骤可独立运行、可回退）
- WS 协议兼容性方案
- 前端渲染器设计（xterm.js 适配或替换方案）
- 性能预算与监控

**产出**：
- `docs/dev/plans/terminal-architecture/design.md`
- 实施路线图（每个里程碑的可验证验收条件）

## 5. 参考代码库索引

### 5.1 本仓库（OmniTerm）

| 文件 | 角色 | 相关性 |
|------|------|--------|
| `src/engine/pty/mod.rs` | PtyEngine 核心：会话 map、读循环、broadcast、flush | 主战场——输出路径改造 |
| `src/engine/pty/vt.rs` | VtState：alacritty_terminal 封装 | 真相源——已有 cell-level 能力 |
| `src/engine/pty/ring.rs` | ByteRing：256KB 环形缓冲 | 补屏窗口——可能需要升级 |
| `src/engine/pty/terminal_ws.rs` | WS attach：补屏、resize、detach | WS 入口——协议切换点 |
| `src/engine/pty/scrollback.rs` | ANSI 历史落盘 | 双轨问题——可能需要合并 |
| `frontend/src/hooks/useTerminal.ts` | 终端 hook：WS 连接、输入处理 | 前端消费端——渲染模式切换；已有双通道能力（ArrayBuffer raw-bytes + text frame JSON），SemanticFrame 可直接走 text frame |
| `frontend/src/components/Terminal/Terminal.tsx` | Terminal 组件：xterm.js 生命周期 | 渲染后端——cell-level 适配点 |

### 5.2 herdr（/home/pax/coding/research/herdr）

| 文件 | 角色 | 相关性 |
|------|------|--------|
| `src/protocol/wire.rs` | wire 协议：FrameData / TerminalFrame / ServerMessage | cell-level frame 定义——协议设计参考 |
| `src/protocol/render_ansi.rs` | ANSI 帧 blitting：diff + 全量重绘 + cursor 管理 | ANSI fallback 模式——与本项目 render_screen() 对标 |
| `src/pane/terminal.rs` | PaneTerminal：VT 解析 + input_state 跟踪 | mode 感知 + alt-screen 状态——`alternate_screen` 字段 |
| `src/pane.rs` | Pane：会话生命周期 + handoff | handoff_history_ansi 跳过 alt-screen 策略 |
| `vendor/libghostty-vt/` | Ghostty VT 解析器（Zig） | 不直接移植，但 switchScreenMode 语义值得对照 |

### 5.3 zellij（/home/pax/coding/research/zellij）

| 文件 | 角色 | 相关性 |
|------|------|--------|
| `zellij-server/src/panes/grid.rs` | Grid：自建 VT grid + alt-screen swap | 全量重绘触发器（`force_change_size → update_all_lines`） |
| `zellij-server/src/panes/terminal_pane.rs` | TerminalPane：VTE 解析 + 渲染调度 | 渲染管线入口 |
| `zellij-server/src/tab/mod.rs` | Tab：pane 布局 + 渲染调度 | `should_clear_display_before_rendering` 机制 |
| `zellij-server/src/output/mod.rs` | Output：changed_chunks_in_viewport | diff 渲染逻辑——`update_all_lines` 实现 |
| `zellij-client/src/web_client/utils.rs` | Web 客户端 | zellij 也有 web client——同赛道 |
| `zellij-server/src/panes/unit/grid_tests.rs` | Grid 单元测试 | DECSET 1049 行为测试——可直接对照我们的 vt.rs 测试 |

## 6. 决策 gate

在 Phase R4 结束时，基于可验证数据做以下决策：

| 问题 | 选项 | 决策标准 |
|------|------|---------|
| xterm.js 能否做 cell-level 渲染？ | 能 / 不能 / 有条件能 | Phase R1 bench 结果通过阈值 |
| 帧大小是否可接受？ | 接受 / 需优化 / 不可接受 | Phase R2：增量 diff < 2× 原始字节大小 |
| 选哪个候选架构？ | A（渐进双模式）/ B（Hybrid）/ C（全量替换） | R1+R2 数据 + 工程成本估算 |
| 是否需要替换前端渲染后端？ | 保留 xterm.js / 替换为自定义 | xterm.js 逐 cell 写入性能 vs 自建 canvas 渲染器 |

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| xterm.js 不适合 cell-level frame | 中 | 候选 A/C 失效，需替换前端渲染后端 | Phase R1 尽早验证 |
| 帧大小超预期 | 低 | 远程场景带宽问题 | Phase R2 实测；可加 SGR 压缩 |
| 研究结论是"不需要改" | 低 | 时间投入无产物 | 研究阶段不承诺实现，只产出文档 |
| 双模式维护成本 | 中 | 两条渲染路径都要测试和维护 | 明确 sunset 路径：legacy 模式在试点稳定后标记 deprecated |

## 8. 下一步

本计划草稿完成后：
1. 评审确认研究范围和里程碑
2. 按 Phase R1→R2→R3→R4 顺序执行
3. 每 Phase 产出可独立审阅的文档
4. R4 决策 gate 产出实施计划（进入 docs/dev/plans/ 正式流程）
