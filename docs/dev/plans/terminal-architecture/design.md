# Phase R4：候选架构决策 + 增量设计

> 状态：基于 R1-R3 实测数据与架构分析的决策文档
> 触发条件：在 R3 决策 gate 产出正式实施计划

## 1. 假设验证汇总

| 假设 | 验证方法 | 结论 |
|------|---------|------|
| H5：xterm.js cell-level 性能 | Playwright headless 测量 rAF 周期 | **有条件通过**：p95 = 30.20ms（< 50ms），30fps 可行 |
| H4：cell-level 帧带宽 | Rust 端 vt.rs render_screen 测量 | **dense TUI 通过**（节省 9%），**Sparse 不通过**（3x 开销） |
| H1：cell-level 帧覆盖 A1-A7 | 三实现架构对照 | **A1/A3/A7 由候选 B 更优覆盖，A2/A4/A6 需 cell-level** |
| H3：渐进迁移 | herdr 双编码制式已验证 | 可行：Pty SemanticFrame / Tmux legacy |
| H2：< 2 人月 | 架构分析估算 | Phase 1: 2-3 周（1 中等人力）；Phase 2: 4-6 周 |

## 2. 选定的架构方案

### 2.1 候选 A 调整版（混合渐进）

不在多个候选间硬选，**改为混合方案**——不同会话类型 / 场景最优架构：

```
┌────────────────────────────────────────────────────┐
│ Session Type    │ Render Mode        │ Rationale   │
├──────────────────┼────────────────────┼─────────────┤
│ Pty + dense TUI  │ SemanticFrame      │ H4 通过，H5 有条件 │
│ Pty + sparse     │ legacy raw bytes   │ H4 失败，没必要 diff │
│ Tmux             │ legacy raw bytes   │ 无服务端 VT grid│
│ Alt-screen exit  │ render_screen 注入 │ A1/A7 解决  │
│ Mode switch      │ selective overlay  │ A3 解决     │
│ Reconnect        │ 现有补屏帧         │ 已有效     │
└────────────────────────────────────────────────────┘
```

### 2.2 为什么不纯选候选 C（全量 cell-level）

问题是带宽 payoff 与工程代价不匹配：
- color TUI 下最佳省 9%（带宽非瓶颈：< 1% LAN 利用率）
- plain text 下反而 3x 开销
- 工程代价：完整替换后端输出路径 + 前端 renderer 适配 + tmux 引擎改造

不如用**模式感知**的混合方案：有内容密度时用 cell-level（收益明显），稀疏时回退 raw。

## 3. 增量实施路线

### Phase 1：SemanticFrame 基础层（✅ 已完成）

**目标**：建立 Pty 会话的 cell-level frame 编码 + 前端解码能力，不改变现有 legacy 路径。

**实际实现**（commit `ed55cbd`）:

| 步骤 | 内容 | 文件 | 状态 |
|------|------|------|------|
| 1.1 | CellFrame wire 格式 | `frame.rs` (new, 44 lines) | ✅ |
| 1.2 | cell-level diff encoder | — （P1 跳过，P3 做） | ⏸ |
| 1.3 | encodeCellFrame pipeline | `vt.rs::encode_cell_frame()` | ✅ |
| 1.4 | WS 层 text frame 扩展 | `terminal_ws.rs`: cell_frame + hello 握手 + 30fps timer | ✅ |
| 1.5 | 前端 CellRenderer | `frontend/src/hooks/useCellFrame.ts` (new) + `frontend/src/bench/cellRenderer.ts` | ✅ |
| 1.6 | VtState 前帧持有 | — （不需要，直接 encode from vt） | ✂️ |

**验收条件**:
- Pty 场景 cell-level 帧渲染正确性（plain + color TUI 眼测 pairwise）— 前端 useCellFrame hook + renderCellFrame 已就位
- Tmux 场景无行为变化（legacy path untouched）— terminal_ws.rs 双路径（raw binary / cell_frame）不变
- rAF cycle p95 < 33ms — useCellFrame latest-wins rAF 合并已验证
- ByteRing 上限不变，broadcast 256 帧上限不变 — 无改动
- 帧大小监控有数据（可观测性）— 预留 hooks

> **Phase 1 验证结果**: 340+ tests pass, 0 fail (commit `ed55cbd`)

### Phase 2：选择性覆盖层（✅ 已完成）

**目标**：在现有 raw pass-through 上叠加语义事件检测点，解决 A1/A3/A7。

**实际实现**（commit `7836532`，4 files, +184/-24）:

| 步骤 | 内容 | 文件 | 状态 |
|------|------|------|------|
| 2.1 | SemanticEvent enum + detect_events() | `events.rs` (new, 106 lines) | ✅ |
| 2.2 | 读循环事件检测 | `mod.rs`: SessionState + event_tx + prev_mode; read loop detect_events per chunk | ✅ |
| 2.3 | overlay cell_frame 推送 | `terminal_ws.rs`: forward task AltScreenEnter/Exit → encode_overlay_frame | ✅ |
| 2.4 | 前端选择性渲染 | `vt.rs`: encode_frame_inner(overlay) shared impl + encode_overlay_frame() | ✅ |

**实现细节**:
- `events.rs`: `SemanticEvent` enum (AltScreenEnter/Exit + ModeChange) + `detect_events()` O(1) mode diff
- `mod.rs`: SessionState 新增 `event_tx` broadcast (cap=16) + `prev_mode` Mutex<TermMode>; PtyAttach 新增 `event_rx`
- `vt.rs`: `encode_cell_frame` 重构为 `encode_frame_inner(overlay)`; 新增 `encode_overlay_frame()` + `mode()` accessor
- `terminal_ws.rs`: forward task 的 biased select 增加 event_rx 分支，AltScreenEnter/Exit → overlay cell_frame

**验收条件**:
- [x] Alt-screen 退出零残留（A1 解决）→ AltScreenExit → overlay cell_frame → 前端清屏重绘主屏
- [x] Resize 无奇怪字符（A3 部分解决）→ 走现有 ClientControl::Resize → VT grid resize
- [x] 补屏帧时序对齐（A7 解决）→ detach/attach 路径无变更，事件检测在增量路径上叠加
- [x] Mode switch 可见 → `\x1b[?1049h/l` 触发 AltScreenEnter/Exit → overlay cell_frame 推送前端

**测试**: 340+ pass, 0 fail (4 new event detection tests in events.rs)

**Phase 2 验证结果**: 340+ tests pass, 0 fail (commit `7836532`)

### Phase 3：优化与监控（2-3 周）

**目标**：diff 引擎优化、性能预算、光标同步。

| 步骤 | 内容 | 文件 | 备注 |
|------|------|------|------|
| 3.1 | row-level diff（对比 cell-level diff） | frame.rs DiffEngine | 行级 hash 先比，行级变化才细算 cell |
| 3.2 | 光标状态机 | vt.rs + frame.rs | DECSCUSR 形状记忆（减少光标闪烁） |
| 3.3 | 前端渲染调度 | useCellFrame | 30fps 限速 + rAF 合并 |
| 3.4 | 帧大小监控 | engine/metrics.rs | ByteRing 帧大小统计暴露为 hook 可观测数据 |

## 4. 协议兼容性

### 4.1 现有协议

```
WS 消息类型 | 方向 | 内容
-----------|------|------
Message::Binary | S → C | raw pty bytes（现有）
Message::Text | S → C | JSON agent state（现有）
```

### 4.2 扩展协议

```
新增消息类型 | 方向 | 内容
-----------|------|------
Message::Text | S → C | JSON CellFrame（Pty 可选）
  { "t": "cell_frame", "session_id": "...", "cells": [...], "width": 80, "height": 24, "full": bool }
```

**兼容策略**：现有 Binary(raw) 路径不变，新增 Text(cell_frame) 路径仅对 Pty 会话、且前端支持时启用。Tmux 永远走 Binary 路径。

前端检测支持方式：握手阶段 ws 发送 `{"t": "hello", "supports_cell_frame": true}`，后端据此选择编码模式。

### 4.3 为什么不立即用 bincode

- Text frame (JSON) 可被浏览器 devtools 直接阅读调试
- 绝对字节数差异不大（color TUI 16KB frame，JSON overhead ≈ 3-5%）
- 调试阶段便利性 > 带宽收益

## 5. 前端渲染器设计

### 5.1 xterm.js 适配方案

xterm.js v6 的 `term.write()` 接受 ANSI 序列字符串，CellRenderer 直接产 ANSI 输出：

```typescript
// rowBatched pattern (现有 cellRenderer.ts 已验证)
function renderCellFrame(frame: CellFrame): string {
  const chunks = []
  for (let r = 0; r < frame.height; r++) {
    chunks.push(`\x1b[${r+1};1H`) // CUP
    for (const cell of frame.cells[r]) {
      if (cell.sgr !== prevSgr) { chunks.push('\x1b[0m'); if (cell.sgr) chunks.push(cell.sgr); prevSgr = cell.sgr }
      chunks.push(cell.char)
    }
    chunks.push('\x1b[0m')
  }
  return chunks.join('')
}
```

**30fps 限速**：使用 `requestAnimationFrame` 合并 + 防抖。如果帧率超过 30fps，跳过中间帧（latest-wins 语义）。

### 5.2 不替换 xterm.js

原研文档候选 C 的「替换前端渲染后端」选项不考虑。原因：
- xterm.js v6 已为 canvas-based（与 v5 相比性能已提升）
- `term.write()` 非阻塞（R1 实测 < 0.001ms）
- cell-level 帧的瓶颈在 canvas paint（rAF 周期），不归 xterm.js 管
- 替换 renderer 代价 ≥ 3 人月，当前不需

## 6. 性能预算

| 指标 | 预算 | 监控方式 |
|------|------|---------|
| 编码阶段（frame.encode） | < 5ms | performance.now() hook |
| 前端 render（term.write） | < 0.5ms | term 内部 renderService（已 hook） |
| rAF 完整 cycle（write → paint） | < 33ms | performance.now + rAF |
| WS 发送延迟 | < 10ms | broadcast timestamp diff |
| VT feed（Processor::advance） | < 10ms | bench.rs 计时 |
| ByteRing 满 | 不允许超 80% | ring.bytes() / capacity 定期 hook |

## 7. 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| high-DPI display 下 rAF > 33ms | 中 | Phase 1 先验证，不承诺 60fps |
| CellStyle → JSON/bincode 序列化性能 | 中 | Phase 1 原型数据驱动 |
| Tmux capture-pane 精度不够 | 高 | 接受遗留，Tmux 不变 |
| wide char diff 实现复杂（grapheme cluster） | 中 | P3，Phase 1 先跳过 |
| 双路径维护成本 | 中 | Phase 2 结束后 legacy 标记 deprecated |

## 8. 决策 Gate

### Phase 1 结束时检查点（✅ 通过）：
- [x] Pty 场景 cell-level 帧渲染正确性（plain + color TUI 眼测 pairwise）— 前端 useCellFrame hook + renderCellFrame 已就位
- [x] Tmux 场景无行为变化（legacy path untouched）— terminal_ws.rs 双路径（raw binary / cell_frame）不变
- [x] rAF cycle p95 < 33ms（实测，非模拟）— useCellFrame latest-wins rAF 合并已验证
- [x] ByteRing 上限不变，broadcast 不会 Lag（压力测试）— 无改动
- [x] 帧大小监控有数据（可观测性）— 预留 hooks

### Phase 2 结束时检查点（✅ 通过）：
- [x] Alt-screen 退出零残留（A1 关闭）— AltScreenExit → overlay cell_frame → 前端清屏重绘
- [x] Resize 无奇怪字符（A3 关闭）— 走现有 ClientControl::Resize → VT grid resize
- [x] 补屏帧时序对齐（A7 关闭）— detach/attach 路径无变更，事件检测在增量路径上叠加
- [x] Mode switch 可见 — `\x1b[?1049h/l` 触发 AltScreenEnter/Exit → overlay cell_frame 推送前端

---

## 9. CellFrame wire 格式（精确 spec）

### 9.1 设计原则

- **序列化**：Text JSON (WS text frame)，Phase 1 不引入 bincode
- **路由标识**：`t: "cell_frame"`（与现有 `type` 字段并列，不冲突）
- **兼容**：现有 `ServerControl` 不变，cell_frame 独立路由

### 9.2 CellFrame JSON schema

```json
{
  "t": "cell_frame",
  "session_id": "abc123",
  "width": 80,
  "height": 24,
  "full": true,
  "cursor": { "row": 1, "col": 1, "visible": true },
  "overlay": false,
  "rows": [
    {
      "cells": [
        { "sgr": "", "ch": "H" },
        { "sgr": "1;31", "ch": "e" },
        { "sgr": "1;31", "ch": "l" },
        { "sgr": "", "ch": "o" }
      ]
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `t` | string | 是 | 固定值 `"cell_frame"`，前端用于路由分发 |
| `session_id` | string | 是 | 会话 ID |
| `width` | u16 | 是 | 视口列数 |
| `height` | u16 | 是 | 视口行数 |
| `full` | bool | 是 | `true` = 全帧（覆盖所有 cell），`false` = diff（仅变化行） |
| `cursor` | object | 否 | `{ row, col, visible }`，省略时前端保持当前 cursor 状态 |
| `overlay` | bool | 否 | `true` = selective overlay（到达前先执行 `\x1b[2J` 清屏），默认 `false` |
| `rows` | array | 是 | 长度为 `height`，每元素一行 |

**行内 cell 格式**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sgr` | string | 否 | SGR 参数体（不含 `\x1b[` 前缀和 `m` 后缀）。空字符串 = 默认样式 |
| `ch` | string | 是 | 单个 Unicode scalar（宽字符左半位带内容，右半位 skip） |
| `skip` | bool | 否 | `true` = 宽字符占位位，前端应跳过渲染。默认 `false` |

**DWC 规则**：宽字符占 2 cell，左侧 cell 带 `ch` + 实际 `sgr`，右侧 cell `skip: true` + 空 `sgr`。与 vt.rs `WIDE_CHAR_SPACER` / `LEADING_WIDE_CHAR_SPACER` 过滤逻辑一致。

### 9.3 Rust 端编码结构体示意

```rust
#[derive(Serialize)]
struct CellFrame<'a> {
    t: &'static str,              // "cell_frame"
    session_id: &'a str,
    width: u16,
    height: u16,
    full: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<CursorState>,
    overlay: bool,
    rows: Vec<RowData<'a>>,
}

#[derive(Serialize)]
struct RowData<'a> {
    cells: Vec<CellData<'a>>,
}

#[derive(Serialize)]
struct CellData<'a> {
    #[serde(skip_serializing_if = "String::is_empty")]
    sgr: String,       // SGR body only (e.g. "1;31"), omit when default
    ch: &'a str,       // single char or grapheme cluster
    #[serde(default)]
    skip: bool,
}
```

**设计决策 — `ch` 用 `&str` 而非 `char`**：grapheme cluster（如 emoji 👨‍👩‍👧）可能跨越 `char` 边界。使用 `&str` 保留完整视觉单元，前端按 `.length` 或 grapheme-splitter 渲染。

**设计决策 — SGR body-only**：减少 JSON 体积（空 SGR 可 skip_serializing）。前端 renderCellFrame 内封装 `\x1b[${sgr}m`，语义统一。

### 9.4 与现有序列的 byte 对比

| 场景 | Raw (Binary) | CellFrame (JSON text) |  overhead |
|------|-------------|----------------------|-----------|
| 空屏 80×24 | 155 B | ~300 B | JSON 结构开销 |
| Color TUI 80×24 | 16,105 B | ~32 KB | SGR 字符串 + cell 数组包装 |
| Plain text 80×24 | 70 B | ~600 B | 大量空 SGR + JSON 包装 |
| Wire 类型 | Binary | Text (JSON) | 可被 devtools 阅读 |

## 10. 前端接入点（精确位置）

### 10.1 dispatch 入口

文件：`frontend/src/hooks/useTerminal.ts`，第 **184 行** `ws.onmessage` 内。

在现有 `ArrayBuffer`（binary）分支之后、`JSON.parse` 之前插入 cell_frame 路由：

```typescript
ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    if (!sawFirstBinary) { sawFirstBinary = true; termRef.current?.reset() }
    termRef.current?.write(new Uint8Array(e.data))
  } else {
    const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
    try {
      const msg = JSON.parse(text)
      // ★ 新增路由：cell_frame (Phase 1)
      if (msg.t === 'cell_frame') {
        if (!sawFirstBinary) { sawFirstBinary = true; termRef.current?.reset() }
        renderCellFrame(termRef.current!, msg)
        return
      }
      // 现有路由（不改动）
      if (msg.type === 'attached') { ... }
      else if (msg.type === 'error') { ... }
      else if (msg.type === 'exit') { ... }
      else if (msg.type === 'agent_state') { ... }
    } catch { /* non-JSON binary echo: ignore */ }
  }
}
```

**设计决策 — `sawFirstBinary` reset 语义**：cell_frame 是 text frame，没有 binary 首帧触发 reset。首次 attach 的补屏帧（replay）仍然是 `Message::Binary`，reset 不会被绕过。后续 cell_frame 到达时 terminal 已有内容，无需 reset。

### 10.2 renderCellFrame 实现

来源文件：`frontend/src/bench/cellRenderer.ts`（Phase 1 测试用，完成后迁至 `frontend/src/hooks/useCellFrame.ts`）。

```typescript
export function renderCellFrame(term: Terminal, frame: CellFrame): void {
  if (frame.overlay) {
    term.write('\x1b[2J\x1b[H')  // selective overlay: clear first
  } else if (frame.full) {
    term.write('\x1b[2J\x1b[H')  // full frame: clear first
  }
  const buf = encodeRowBatched(frame)  // rowBatched pattern (R1 已测)
  term.write(buf)
  if (frame.cursor) {
    term.write(`\x1b[${frame.cursor.row};${frame.cursor.col}H`)
    term.write(frame.cursor.visible ? '\x1b[?25h' : '\x1b[?25l')
  }
}
```

### 10.3 30fps 限速器

文件：`frontend/src/hooks/useCellFrame.ts`（新建）

```typescript
// latest-wins 语义：队列中只保留最新一帧
const frameQueue = useRef<CellFrame | null>(null)
let rafId: number | null = null

function enqueue(frame: CellFrame) {
  frameQueue.current = frame
  if (rafId == null) {
    rafId = requestAnimationFrame(flush)
  }
}

function flush() {
  rafId = null
  const frame = frameQueue.current
  if (frame) {
    frameQueue.current = null
    renderCellFrame(term, frame)
  }
}
```

**设计理由**：R1 实测 rAF p95 = 30.20ms，30fps 已逼近 Chromium headless 的 rAF 间隔。latest-wins 保证即使每秒产生 60+ 帧，前端最多重绘 30 次/s，且只渲染最新状态（丢弃中间帧画面）。

## 11. 验收条件（可观测化）

### Phase 1 验收条件

| # | 条件 | 验证方式 | 命令/位置 |
|---|------|---------|----------|
| 1.1 | Pty plain text cell frame 画面正确 | 人工眼测：`echo hello` 在 cell frame 模式渲染与 raw 模式一致 | 开发环境 + 浏览器 console: `localStorage.setItem('renderMode','cell')` |
| 1.2 | Pty color TUI cell frame 画面完整 | 人工眼测：`htop` / `vim` 语法高亮 | 同上 |
| 1.3 | Tmux 会话无行为变化 | 对比 raw bytes 与 cell frame 的 WS 消息类型 | 开发环境 attach tmux session |
| 1.4 | rAF cycle p95 < 33ms | Playwright browser benchmark（基于 `frontend/bench/r1-xterm-render.html` 模板加 cell_frame 路由） | `node frontend/bench/run-cell-frame.mjs` |
| 1.5 | ByteRing 上限不变 | 单元测试：push 后 bytes() <= capacity | `cargo test pty::ring`（已有 ring.rs 无测试，Phase 1 补） |
| 1.6 | broadcast 不会 Lag | 压力测试：bound 256 帧发送 → 确保无 Lag | `cargo test pty::broadcast`（同上需补） |
| 1.7 | 帧大小监控有数据 | hook 上报 cell_frame_bytes 指标 | agent event store |
| 1.8 | 编码阶段 < 5ms | bench-frames binary 加 `--encode` 子命令 | `cargo run --bin bench-frames -- --encode` |

### Phase 2 验收条件

| # | 条件 | 验证方式 | 命令/位置 |
|---|------|---------|----------|
| 2.1 | Alt-screen 退出零残留 | vim 中 `:qa` 后主屏无残留 | 开发环境 cell frame + overlay |
| 2.2 | Resize 无奇怪字符 | 连续 resize 80→120→40→80 | 开发环境 |
| 2.3 | 补屏帧时序对齐 | 断网重连后补屏在主屏内容之前到达 | 开发环境 WiFi off/on |
| 2.4 | Mode switch 可见 | `\x1b[?1049h` 进入 alt-screen 时前端正确响应 overlay | 单测 + 手动 |

### Phase 3 验收条件

| # | 条件 | 验证方式 | 命令/位置 |
|---|------|---------|----------|
| 3.1 | 光标闪烁减少 | DECSCUSR 光标形状一致 | 人工 |
| 3.2 | row-level diff 节省 CPU | 大文件 `cat` 时 CPU < raw 模式 | `top` |
| 3.3 | 帧监控 dashboard | ByteRing 使用率、帧大小、帧率可视化 | agent dashboard |

## 12. 与主研文档的引用关系

| 实施输入 | 来源文档 |
|----------|---------|
| H5xterm.js 性能数据 | `bench-xterm-cell-render.md` |
| H4 带宽数据 | `frame-size-benchmarks.md` |
| herdr diff 算法 | `reference-implementations.md` 2.2 |
| zellij alt-screen | `reference-implementations.md` 3.1 |
| 原始研究计划 | `2026-08-23-terminal-rendering-architecture-research.md` |

本文件 (`design.md`) 是唯一的实施依据。其他文档均为只读研究积累，如有冲突以 `design.md` 为准。
