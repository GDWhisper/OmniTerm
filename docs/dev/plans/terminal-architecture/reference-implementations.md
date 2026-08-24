# Phase R3：参考实现架构对比

> 来源：三个参考实现的深度分析
> - herdr：`/home/pax/coding/research/herdr`
> - zellij：`/home/pax/coding/research/zellij`
> - OmniTerm：`/home/pax/coding/OmniTerm-dev`（本项目）

## 1. 引言

本阶段基于 Phase R1（xterm.js 性能验证，数据见 `bench-xterm-cell-render.md`）和 Phase R2（帧大小/频率测量，数据见 `frame-size-benchmarks.md`）的实测数据，系统化对比三个参考实现的关键架构决策：
- **herdr**（Apache-2.0）：cell-level SemanticFrame + TerminalAnsi 双编码制式
- **zellij**（MIT）：自建 Grid + 行级 dirty tracking + zero-copy alt-screen
- **OmniTerm**（FSL-1.1-MIT）：alacritty_terminal + raw-byte pass-through + 补屏帧机制

对比维度：cell-level 输出、diff 计算、alt-screen、scrollback、wide char、光标同步、模式通知、双引擎支持、渐进迁移、WS 协议。

## 2. herdr 架构分析

### 2.1 Wire 协议（`protocol/wire.rs`）

herdr 使用 **length-prefix 定长帧**（4-byte LE + bincode payload），最大帧 2MB，图形帧 32MB。

两种渐进式渲染编码：

| 编码 | 数据结构 | 说明 |
|------|---------|------|
| `RenderEncoding::SemanticFrame` | `FrameData { cells, width, height, cursor, hyperlinks, graphics }` | cell-level 语义帧 |
| `RenderEncoding::TerminalAnsi` | `TerminalFrame { seq, width, height, full, bytes }` | 原始 ANSI 字节流（类似 OmniTerm） |

握手阶段：客户端声明 `requested_encoding`，服务端选择实际编码。这是重要的渐进迁移路径：
- legacy 客户端：走 TerminalAnsi，只发 raw bytes
- 新客户端：走 SemanticFrame，cell-level diff
- 同一连接内可以混合（每次帧 declare encoding）

**CellData** 定义：
```rust
pub struct CellData { symbol: String, fg: u32, bg: u32, modifier: u16, skip: bool, hyperlink: Option<u32> }
```
- `fg/bg` 为 packed `u32`（0xAARRGGBB 或调色板索引），直接 NetworkOrder 传输
- `skip` 标记宽字符的右半位，避免重复
- `hyperlinks` 独立存储：URI 去重 → 索引化，大幅减小重复 URL 的传输量

### 2.2 渲染管线（`protocol/render_ansi.rs`）

**BlitEncoder**：有状态 diff 编码器

```
BlitEncoder {
    last_frame: Option<FrameData>,         // 上一帧（用于 diff）
    last_visible_cursor: Option<(u16, u16)>,
    last_cursor_shape: u8,
}
```

**diff 策略**：
1. 对比 prev frame → current frame，逐 cell 比较 `symbol/fg/bg/modifier/hyperlink`
2. **wide char 传播**：当前 cell 宽 2 则影响下一列（`invalidated > 0`）
3. **batch 内联**：`next_inline_col` 范围内同样式的连续 cell 批处理为单次 SGR 转换
4. 以 `\x1b[?2026h` / `\x1b[?2026l`（synchronized output）包裹，避免跨帧混淆

光标策略（输出时间点奇巧）：
- 写 cell 前隐藏光标 `\x1b[?25l`
- 全量重绘前清屏 `\x1b[2J`
- 收尾：光标复位 + DECSCUSR 形状 + 显隐

### 2.3 与 OmniTerm 的差异

| 维度 | herdr | OmniTerm |
|------|-------|----------|
| VT 引擎 | libghostty-vt（Zig FFI） | alacritty_terminal 0.26（Rust） |
| 前端 | crossterm（原生 GUI） | xterm.js（浏览器） |
| 渲染策略 | 完全服务端权威 | raw fallback，补屏帧注入 |
| 双引擎 | 仅 Pty | Pty + Tmux + ACP |
| Session | 单 pane | 多 session、常驻 detach |

### 2.4 可借鉴程度

| 组件 | 可借鉴程度 | 原因 |
|------|-----------|------|
| wire.rs 双编码制式 | **高** | SemanticFrame/TerminalAnsi 是渐进迁移的模板 |
| BlitEncoder diff 逻辑 | **高** | 通用 diff 算法（逐 cell 比较 + batch） |
| Cursor 状态记忆 | **高** | 减少光标命令，OmniTerm 补屏帧无此优化 |
| length-prefix 定长帧 | **中** | WS binary/text 两种帧类型可参考 |
| URI hyperlink 去重 | **中** | 宽字符 skip 机制有参考价值 |
| libghostty-vt | **低** | Zig FFI 与 alacritty_terminal 不兼容 |
| crossterm client | **低** | 与 xterm.js 的 canvas 渲染约束完全不同 |

## 3. zellij 架构分析

### 3.1 Grid 设计（`panes/grid.rs`）

zellij **自建 Grid**，不依赖外部 VT 库：

```
Grid {
    lines_above: VecDeque<Row>,          // 滚动出视口的历史行
    viewport:    VecDeque<Row>,          // 当前可见行
    lines_below: VecDeque<Row>,          // 预留（当前基本为空）
    output_buffer: OutputBuffer,         // ← cell-level dirty tracking
    alternate_screen_state: Option<AlternateScreenState>,
    should_render: bool,
    clear_viewport_before_rendering: bool,
    ...
}
```

每个 Row 是 `VecDeque<TerminalCharacter>`，每个 TerminalCharacter = 字符 + 样式（`style: CharacterStyle`）。

**OutputBuffer** 行级 dirty tracking：
```rust
pub struct OutputBuffer {
    changed_lines: HashSet<usize>,      // 脏行索引
    should_update_all_lines: bool,       // true → 全量渲染
}
```

**changed_chunks_in_viewport** 是核心 diff 函数：
- `should_update_all_lines = true`：全屏逐行遍历 → 产出 `Vec<CharacterChunk>`
- else：只遍历 `changed_lines` HashSet → 增量 `Vec<CharacterChunk>`

粒度是**行级**（非 cell 级），但行内可以嵌套 cell 序列。

### 3.2 alt-screen 处理

**进入 alt-screen**：零拷贝 swap（`std::mem::swap`）：
```rust
let current_lines_above = std::mem::take(&mut self.lines_above);
let current_viewport = std::mem::take(&mut self.viewport);
// ... swap all fields ...
self.alternate_screen_state = Some(AlternateScreenState::new(...));
self.output_buffer.update_all_lines(); // 全脏，触发清除
```

**退出 alt-screen**：
```rust
alternate_screen_state.apply_contents_to(...) // 零拷贝交换回来
self.clear_viewport_before_rendering = true
self.force_change_size(self.height, self.width) // 强制 resize → 全量重绘
```

### 3.3 渲染调度

`TerminalPane::render()`：
1. 检查 `should_render` 脏标记
2. 若不脏 → return Ok(None)（跳过整个 pane）
3. 若脏 → `Grid::render()` → `OutputBuffer::changed_chunks_in_viewport()` → 产出 `Vec<CharacterChunk>`

`Tab::render()`：
1. 收集所有 pane 的 `CharacterChunk`
2. 通过 `hide_cursor_and_clear_display_as_needed` 在 chunk 前注入：
   - `\x1b[?25l`（隐藏光标）
   - `\x1b[m\x1b[2J`（SGR reset + clear display）——仅当 `should_clear_display_before_rendering = true` 时

### 3.4 dead field 教训

`clear_viewport_before_rendering` 在 Grid 中有定义，有 3 处写入、0 处读取，从 zellij v0.2 起遗留至 v0.4。这说明不要留半成品机制——这和 OmniTerm 补屏帧时序的模糊性有共性：设置了一个 flag 但行为不严格绑定。

### 3.5 与 OmniTerm 的差异

| 维度 | zellij | OmniTerm |
|------|--------|----------|
| VT parser | 自建 vte 调用 | alacritty_terminal（完整 VTE 实现） |
| Grid 来源 | 自维护 VecDeque<Row> | alacritty_terminal 内建 Grid |
| 客户端协议 | ANSI escape 序列（cell → VTE → bytes） | raw bytes direct pass-through |
| Web client | 通过 WebSocket 接收 ANSI 序列 | 同（tmp session 降级方案） |
| scrollback | 内建 lines_above VecDeque | ByteRing + 文件落盘 |
| alt-screen | zero-copy swap + resize trigger | VtState::grid() 全帧重画 |

**关键观察**：zellij 的"服务端权威渲染"优势恰恰是因为它自己完全控制 Grid。OmniTerm 选择 alacritty_terminal 作为 VT 引擎（vt.rs 则是 Grid 包装层），这意味着 VT 解析的正确性和完整性有保障，但 grid 的访问粒度受限于 alacritty_terminal 的 API 设计（行级切片，非 cell 级直接写入）。

## 4. OmniTerm 现状能力映射

### 4.1 已有能力

| 能力 | 位置 | 说明 |
|------|------|------|
| cell-level 遍历 | `vt.rs: render_screen()` | 逐行遍历 grid，SGR 映射，尾部裁剪 |
| 纯文本快照 | `vt.rs: capture_visible()` | 非结构化文本，用于 agent 检测 |
| feed / take_responses | `vt.rs` | VTE 解析输入 / 应答排空 |
| ByteRing 有界缓冲 | `ring.rs` | 256KB，push/snapshot |
| scrollback 原子落盘 | `scrollback.rs` | 0600 权限 + tmp+rename |
| 补屏帧构造 | `mod.rs: attach()` | ring.snapshot() + `\x1b[H\x1b[2J` + vt.render_screen() |
| WS 双通道 | `terminal_ws.rs` | Binary（raw bytes）+ Text（JSON agent state） |
| Pty/Tmux/Acp 三引擎 | `engine/` | 分层隔离，交互分流 |
| 锁序保证 | `mod.rs` | `out → vt`（读循环/attach 均遵守） |

### 4.2 缺失能力

| 缺失能力 | 影响 | 优先级 |
|----------|------|--------|
| cell-level diff 引擎 | 每次输出全量推送，带宽浪费 | P2 — 已有 render_screen 基础 |
| 模式切换事件通知 | alt/scroll region 切换不可见 | P1 — 当前 alt exit 水印 bug 直接原因 |
| 服务端 cursor 同步 | 前端 cursor 不可控 | P2 — 独立于渲染策略 |
| VtState Clone（前帧对比） | diff 引擎前提 | P3 — 可以持有 Arc 方案 |

## 5. 三实现对比矩阵

| 能力 | herdr | zellij | OmniTerm |
|------|-------|--------|----------|
| cell-level frame 输出 | ✅ 完整（FrameData） | ✅ 完整（CharacterChunk） | ⚠️ 部分（render_screen 可产 ANSI 帧） |
| diff 计算 | ✅ BlitEncoder，逐 cell | ✅ OutputBuffer，行级 | ❌ 无（每次全帧） |
| alt-screen 处理 | ✅ 跳过 history，full redraw | ✅ zero-copy swap + resize trigger | ⚠️ render_screen 全帧重画（A7 遗留） |
| scrollback 同步 | ✅ handoff_history_ansi 跳过 alt | ✅ lines_above VecDeque | ✅ ByteRing + 文件落盘 |
| wide char / DWC | ✅ skip + invalidated 传播 | ✅ WideChar 跟踪 | ✅ WIDE_CHAR_SPACER 过滤 |
| 光标同步 | ✅ 状态记忆（DECSCUSR） | ✅ 行级 cursor 绘制 | ❌ 无服务端同步 |
| 模式切换通知 | ✅ input_state 跟踪 | ✅ should_render 脏检查 | ⚠️ 读循环隐式（无显式事件） |
| 双引擎支持 | ❌ 仅 Pty | ❌ 仅 Pty | ✅ Pty + Tmux + ACP |
| 渐进迁移 | ✅ 双编码制式协商 | N/A（单引擎） | ⚠️ legacy / SemanticFrame 双模式可行 |
| WebSocket 协议 | ✅ 自定义 length-prefix + bincode | ✅ ANSI 字节流 via WS | ⚠️ Binary(raw) + Text(JSON)，无统一编码 |

## 6. 迁移映射表

### 6.1 herdr → OmniTerm

| herdr 组件 | OmniTerm 对应位置 | 改动量 | 难度 |
|-----------|------------------|--------|------|
| `RenderEncoding` 协商 | `terminal_ws.rs` WS attach | 新增编码协商握手 | **低** |
| `FrameData` cell 结构 | `frontend/src/bench/cellRenderer.ts` + Rust `render_screen()` | Extend vt.rs CellStyle → 序列化 | **中** |
| `BlitEncoder::encode` | 新建 `src/engine/pty/diff.rs` （独立模块） | cell-to-cell 前帧对比 + batch SGR | **中** |
| TerminalFrame.full flag | 补屏帧现有标志 | 复用现有"是否全量"标志 | **低** |
| length-prefix 帧格式 | `terminal_ws.rs` Message enum | 在 Binary/Text 外增加 JSON/bincode TextFrame | **低** |
| cursor 状态记忆 | vt.rs render_screen 收尾 | 保存 prev cursor → 条件发 DECSCUSR | **低** |
| URI hyperlink 去重 | 暂不纳入（OmniTerm 无链接高亮需求） | - | - |

### 6.2 zellij → OmniTerm

| zellij 组件 | OmniTerm 对应位置 | 改动量 | 难度 |
|------------|------------------|--------|------|
| `OutputBuffer`（行级 dirty） | 需新建（当前无持久 shim） | 新增 shim 层 + event hook 到 VtState | **高** |
| `force_change_size` exit alt | vt.rs alt-screen 处理 | 复用 render_screen，altevent 触发时机 | **中** |
| `should_clear_display_before_rendering` | vt.rs 已有 clear-before-redraw | 规范化补屏帧构造时机 | **低** |
| `CharacterChunk` | Cell-level 输出数据格式 | 定义 batch format | **中** |
| dead field 教训 | N/A | 已学习：明确 flag 生命周期 | - |

## 7. tmux 侧适用性

OmniTerm 的 tmux 引擎有一个根本约束：**无服务端 VT grid**。这决定了某些 cell-level 能力对 tmux 不可用。

| 能力 | Pty 引擎 | Tmux 引擎 | 说明 |
|------|---------|-----------|------|
| cell-level frame 输出 | ✅ 可行 | ❌ 不可用 | tmux 只能获取 raw 文本（capture-pane -p） |
| diff 计算 | ✅ 可行 | ❌ 不可用 | 无 VT grid 做前帧对比 |
| alt-screen 处理 | ✅ via render_screen | ⚠️ limited | tmux 自身管理 alt-screen，OmniTerm 只能感知最终状态 |
| scrollback 同步 | ✅ ByteRing + 文件 | ⚠️ UITableView | 需 tmux's `capture-pane -S -2000 -p` 获取历史 |
| wide char / DWC | ✅ via alacritty_terminal | ⚠️ tmux unicode | tmux 3.x 有 unicode 支持，但宽度计算精度低 |
| 光标同步 | ✅ vt.rs renderable_content | ⚠️ via DSR | 需额外请求 `\x1b[6n`（同步阻塞风险） |
| 渐进迁移 | ✅ Pty 可选 SemanticFrame | ⚠️ Tmux 永久 legacy | Tmux 无 Grid，只能沿用 raw pass-through |
| **tmux 侧结论** | 全部 SemanticFrame 能力 | **始终限于 legacy / raw pass-through** | tmux 引擎不参与 cell-level 渲染迁移 |

## 8. 结论与建议

### 8.1 可行验证（来自 R1 + R2）

| 假设 | 结论 | 证据 |
|------|------|------|
| H5：xterm.js 能做 cell-level render | **有条件通过** | rAF 测量 p95 = 30ms，低于 50ms 阈值；缓冲入队 < 0.001ms；推荐 30fps 定点发射避免 freeze |
| H4：cell-level frame 带宽可接受 | **sparse 内容通过** | color TUI 节省 9%，空屏 render_screen 155 bytes；LAN 峰值 472 KB/s @ 30fps |
| H2：迁移代价可接受 | **初步判断可行** | 核心改动：新建 `diff.rs`（中等规模）+ WS 帧扩展（低风险）+ 前端 CellRenderer（低风险） |
| H3：渐进迁移可行 | **proven pattern** | herdr 双编码制式是成熟先例；Pty/Tmux 拆分是自然的渐进点 |

### 8.2 推荐架构（候选 A 调整版）

基于实测数据，推荐以下渐进路线：

```
Phase 1（最快可用，2-3 周）：
  - 定义 CellFrame（cell-level frame 格式）+ encodeCellSgr
  - 在 vt.rs 中追加 frame_diff()（prev vs curr diff 计算）
  - 前端 renderCellFrame（wrap renderScreenSim pattern）
  - WS 层新增 text-frame JSON encoding for Pty SemanticFrame
  - Tmux: 无变化（继承 raw pass-through）

Phase 2（optional，4-6 周）：
  - 光标状态机（dcusrs memory）
  - row-level diff engine（vs cell-level）
  - scrub frame dispatch（avoid flooding during rapid output）

Phase 3（长期）：
  - broadcast::Sender 级 frame budget（限帧率防淹没）
  - WebSocket binary frame with discriminator header
  - tmux: upgrade窗口探索（capture-pane 优化）
```

### 8.3 关键决策点

1. **帧率控制**：30fps 定点发射（每 33ms），避免偶发 30ms freeze（R1 数据）
2. **tmux 隔离**：tmux 引擎永久使用 legacy raw pass-through，不引入 cell-level 复杂度
3. **前帧持有**：将前帧 CellData 保存在 `Output` struct（不是 VtState），避免 Clone Term
4. **协议扩展**：在现有 Binary(raw)/Text(JSON) 基础上增加 TextFrame(cell JSON) for Pty only
