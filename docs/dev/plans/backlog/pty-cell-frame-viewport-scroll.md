# PTY Cell Frame Viewport-Relative 渲染

> **状态**：backlog（方案 A 已修复滚轮基础可用性，本方案解决滚动中途渲染错位）。
> **触发条件**：修改 `renderCellFrame` / `encode_cell_frame` / 前端 viewport 同步逻辑前必读。
> **关联**：`docs/dev/plans/2026-08-18-ghost-message-and-known-issues.md`（cell frame diff 机制）、
> `docs/dev/plans/backlog/scroll-pty-paging-bug.md`（tmux scroll mode 历史）。

## 背景

方案 A 去掉了全帧的 `ESC[2J`，滚轮不再被周期性弹到底部。但 cell frame 的坐标系仍有结构性限制：

- **后端**：`encode_cell_frame` / `encode_overlay_frame` 编码的是后端 VT grid 的**绝对行号**（`\x1b[{r+1};1H`，r 从 0 到 height-1）。
- **前端**：xterm.js 维护自己的 scrollback Buffer，用户滚轮操作后 viewport 可能偏移到缓冲区的任意位置。
- **矛盾**：当 viewport 偏移 N 行后，后端发送的 `\x1b[5;1H` 写入的是 xterm 屏幕第 5 行，而不是用户当前视野中从上往下数第 5 行。

静默期 + 无输出时这不构成问题（全屏渲染 = 全屏可见）。活跃输出 + 用户在 scrollback 中时：
- diff 帧写入的行可能不在当前视口范围内（不可见或写到了错误位置）
- 用户看到的是旧内容残留或闪烁

## 方案

### 核心改动

前端在 WebSocket 连接建立时（或 viewport 变化时），向后端发送当前 viewport 偏移：

```typescript
// 前端：订阅 xterm viewport 变化，发送到后端
term.onScroll(() => {
  const viewportY = term.buffer.active.viewportY  // 缓冲区内偏移
  ws.send(JSON.stringify({ type: 'viewport', y: viewportY }))
})
```

后端 `VtState` 记录前端报告的 `viewport_y`，编码时以此为基准调整行坐标：

```rust
// 后端编码时：行号 = grid 绝对行 - viewport_y + 1（屏幕坐标）
let screen_row = (grid_row as i32) - self.frontend_viewport_y + 1;
if screen_row < 1 { continue; } // 行在视口上方，前端不可见
chunks.extend_from_slice(format!("\x1b[{};1H", screen_row).as_bytes());
```

### 具体改动

| 文件 | 改动 |
|---|---|
| `src/engine/pty/vt.rs` | `VtState` 新增 `frontend_viewport_y: i32` 字段；`encode_frame_body` / `encode_row_static` 编码时以 viewport_y 为基准偏移行坐标 |
| `src/engine/pty/terminal_ws.rs` | WS 读循环新增 `ClientControl::Viewport { y }` 处理分支 |
| `frontend/src/hooks/useTerminal.ts` | `connectWs` 中订阅 `term.onScroll`，发送 `{ type: 'viewport', y }` |
| `src/engine/pty/frame.rs` | 如果 `row_indices` 涉及视口上方行，编码时跳过而非写入负坐标 |

### 边界处理

- 连接建立时 viewport_y = 0（默认底部 = 正常状态）
- viewport_y > grid.scrollback 时前端看到的内容全部在 grid 范围内，无越界
- resize 后后端 invalidate_diff → 下一帧全帧，自然覆盖整个视口

### 备选简化方案

如果 viewport 同步带来太多复杂性，替代路径：
- **前端本地修正**：`renderCellFrame` 接收 `viewportY` 参数，在 CUP 坐标中减去偏移量。后端只发送原始 grid 坐标，前端做映射。
- 优点：后端改动为 0。
- 缺点：前端承担坐标映射，diff 帧的 `row_indices` 需要前端做 viewport 裁剪逻辑。

## 验收标准

1. 滚轮向上滚动 50 行后，新输出到达时视口位置不变（内容在正确行更新）
2. 滚轮向下滚回底部，后续输出仍正常全屏渲染
3. 翻倍 resize 后全帧重置，无残留
4. 移动端 touch-scroll 同样有效

## 不做的

- 不改 xterm.js 源码
- 不放弃 cell frame 协议（不退回 raw binary）
- 不做 viewport 预请求（后端按需查询历史行）——当前 cell frame 已经持有全量 grid
