# PTY Herdr 式全缓冲前端渲染

> **状态**：backlog（方案 A 已解决滚轮基础可用性，本方案追求最佳滚动体验）。
> **触发条件**：重新评估终端滚动架构、或前端渲染层改造时参考。
> **关联**：`docs/dev/plans/2026-08-13-port-forward-proxy.md`（协议设计）、
> `docs/dev/plans/backlog/pty-cell-frame-viewport-scroll.md`（方案 B 渐进版）。

## 背景

当前架构：

```
PTY 后端 VT grid ──cell_frame──→ xterm.js ──→ 用户
```

xterm.js 同时承担两重职责：
1. **渲染引擎**：绘制可见屏幕
2. **历史缓冲**：维护 scrollback buffer，响应滚轮

cell frame 架构已经接管了 (1)，但 (2) 仍由 xterm.js 的 scrollback 承担。方案 A 让两者和平共处，方案 B 让两者坐标对齐，方案 C 彻底放弃 xterm scrollback，由后端全权提供历史内容。

Herdr（以及 WezTerm、Zed Terminal 等现代终端）的做法是：**后端保存全部输出历史，前端只负责请求和渲染当前视口**。前端不管 scrollback，不管偏移量，不管坐标映射——它只渲染"后端说我应该看到的内容"。

## 方案

### 架构

```
PTY 后端 VT grid（含 1000 行 scrollback）
    │
    ├─ 正常输出：30fps cell_frame（仅可见屏，或全屏）
    │
    ├─ 滚轮/翻页 → 前端请求 viewport 窗口：
    │    WS 发送 { type: 'viewport_request', y: offset }
    │    → 后端 encode_viewport_frame(y) → 仅该窗口的 cell_frame
    │
    └─ resize → 后端 invalidate + 全帧
```

### 核心改动

#### 1. 后端：新增 viewport 编码模式

```rust
pub fn encode_viewport_frame(&mut self, session_id: &str, viewport_y: i32) -> String {
    let grid = self.term.grid();
    let rows = self.term.screen_lines();
    let cols = self.term.columns();
    
    // 编码 viewport 窗口：从 viewport_y 开始的 rows 行
    let start_row = viewport_y.max(0) as usize;
    let out_rows: Vec<RowData> = (start_row..(start_row + rows))
        .filter(|&r| r < grid.total_lines())
        .map(|r| self.encode_row_static(grid, cols, r))
        .collect();
    
    let frame = CellFrame {
        t: "cell_frame",
        session_id,
        width: cols as u16,
        height: rows as u16,
        full: true,
        overlay: false,
        row_indices: None,
        rows: out_rows,
    };
    serde_json::to_string(&frame).expect("CellFrame serialization must not fail")
}
```

#### 2. 前端：接管滚动行为

```typescript
// 前端 viewport 管理器
class ViewportController {
  private ws: WebSocket
  private term: Terminal
  private currentY = 0 // 当前 viewport 在缓冲区中的偏移
  
  onWheel(deltaY: number) {
    this.currentY = (this.currentY + deltaY.sign).clamp(0, maxScrollback)
    this.requestViewport(this.currentY)
  }
  
  requestViewport(y: number) {
    this.ws.send(JSON.stringify({ type: 'viewport_request', y }))
  }
}
```

### 改动清单

| 文件 | 改动 |
|---|---|
| `src/engine/pty/vt.rs` | 新增 `encode_viewport_frame(y)` 方法 |
| `src/engine/pty/terminal_ws.rs` | WS 读循环新增 `ClientControl::ViewportRequest { y }` |
| `src/ws/terminal.rs` | 新增 `ClientControl::ViewportRequest` 变体 |
| `frontend/src/hooks/useTerminal.ts` | 新增 viewport 控制器；滚轮时发送 viewport_request |
| `frontend/src/hooks/useCellFrame.ts` | viewport 帧标记（用于区分"正常帧"和"历史帧"） |

### 设计决策

#### Q1: 显示/隐藏 xterm 原生 scrollbar？

Modern 终端的答案是**隐藏**——视觉上用户看到的是后端提供的内容，xterm scrollbar 与之无关反而造成困惑。`overflow: clip` 已到位，scrollbar 已隐藏（coarse 设备额外 CSS）。如果 viewport 模式启用，强制隐藏 scrollbar。

#### Q2: 30fps 定时器在滚动时怎么处理？

**暂停**。用户在滚动历史时不需要实时更新（没有人会在 scrollback 里跑 top）。viewport_request 是按需触发的单向请求-响应，不需要周期性整帧刷新。

```
用户停止滚动 200ms 后 → 恢复 30fps（避免错过新输出）
→ 此时 viewport_y 归 0（底部），恢复正常全帧流
```

#### Q3: 复制/选择怎么处理？

xterm.js 的文本选择仍正常工作——它操作的是**当前渲染在屏幕上的内容**。用户在选择历史内容时，前端已经在显示该 viewport 窗口的内容，xterm 的选择 API 可以正确捕获。

唯一区别：此时后端 PTY 的"活动屏"和前端显示的可能不一致。但这在 tmux copy mode 中也是常态——复制和实时输出是独立的。

### 验收标准

1. 滚轮上下滚动如原生终端般流畅（无闪烁、无弹跳、无坐标错位）
2. 在 scrollback 中看到新输出 → 自动弹回底部（与 WezTerm/VSCode 终端一致）
3. 选择（Shift+拖拽）在 scrollback 中正常工作
4. 移动端 touch-scroll 同样精确
5. resize 后正确重绘

### 与方案 B 的取舍对比

| 维度 | 方案 B（Viewport-Relative） | 方案 C（Herdr 式） |
|------|---------------------------|-------------------|
| 改动量 | 中等（前端坐标映射 + 后端 viewport_y 字段） | 较大（新请求类型 + 滚动状态机 + 定时器暂停/恢复） |
| 滚动精准度 | 好（坐标对齐后滚动无错位） | 最好（后端精确提供视口内容，零猜测） |
| 性能 | cell_frame JSON 体积不变 | 低活跃期零 cell_frame（滚动中无 30fps 开销） |
| 复杂度 | 坐标映射的逻辑分散在前端和后端 | 状态机集中在前端（viewport controller） |
| 与现有架构兼容性 | 渐进增强，可独立开关 | 需要重构滚动相关代码（useTerminal + useCellFrame + Terminal.tsx） |
| 用户体验 | 接近方案 C | 与 WezTerm/VSCode 终端平级 |

**建议**：先做 B 验证坐标对齐的正确性，再考虑 C 做最终体验优化。B 是 C 的垫脚石。

### 不做的

- 不放弃 cell frame diff 机制（正常输出仍用 diff 帧，节约带宽）
- 不做后端行缓存层（VT grid 已经是缓存）
- 不拦截 xterm 的文本选择（保持前端能力）
