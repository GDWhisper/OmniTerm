# PTY 终端滚轮问题交接文档

> **状态**：方案 A 未收敛，停止修补，等待新思路。
> **最后修改**：`d54745c`（会话切换内容泄漏修复）
> **关联文档**：`docs/dev/plans/backlog/pty-cell-frame-viewport-scroll.md`（方案 B）
> `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（方案 C）

---

## 一、问题描述

PTY 终端的鼠标滚轮**概率性失效**——用户向上滚动查看历史输出时，滚轮有时无法滑动，或滑了一下又被弹回底部。切换会话再切回来可以临时恢复，但很快再次失效。

核心矛盾：滚轮**不是完全不可用**，而是**间歇性被击穿**。这比"永远不可用"更难定位。

---

## 二、已尝试的方案与尝试记录

### 尝试 1：去掉全帧的 `ESC[2J`（commit `172723a`）

**改动**：`renderCellFrame` 全帧路径去掉 `\x1b[2J\x1b[H`，改为逐行 CUP + 内容写入。

**预期**：`ESC[2J` 是 xterm.js 的 ED2（Erase Entire Display），清掉屏幕 + 全部 scrollback。去掉后 scrollback 不再被周期性清掉，滚轮应该持续可用。

**实际结果**：❌ 画面漂移。
**根因**：去掉了 `isFull` 分支判断后，**diff 帧也走了全屏逐行写入路径**。但 diff 帧的 `rows[]` 只包含变化的行（可能有 3 行），它们的 `row_indices` 指明了正确的屏幕行号（如第 12、18、22 行）。被全屏路径写入到屏幕行 1、2、3，画面自然漂移。

### 尝试 2：恢复 `isFull` 分支（commit `f40babc`）

**改动**：恢复 `if (isFull)` 分支，全帧走逐行 CUP + EL + 内容（无 ESC[2J），diff 帧走原有 `row_indices` 映射。

**预期**：diff 帧不再被误写，画面恢复正常，scrollback 不再被清。

**实际结果**：画面正常，但滚轮仍**间歇性失效**。
**分析**：去掉 ESC[2J 后 scrollback 不再被清掉，但全帧仍然在 30fps 持续写入视口内容。当用户向上滚动后，全帧会覆盖当前 viewport 位置的内容（虽然不清 scrollback，但会把 viewport 拉回底部，因为光标定位在最后一行触发 xterm auto-scroll）。这不是每次都发生——取决于终端输出活跃度和 timing。

### 尝试 3：滚动时跳过全帧 + 滚回底部时 resync（commit `ef38577`）

**改动**：
- `useCellFrame` 新增 `scrollModeRef` 参数。用户向上滚动时，全帧/overlay 帧被 `pendingFullRef` 暂存（不渲染到 viewport），diff 帧照常渲染。
- `useTerminal` 的 `onScroll` 回调检测用户滚回底部时触发 resync（`requestResync` → 后端 invalidate_diff → 下一帧发全帧 → 前端 flush 暂存的完整帧）。

**预期**：用户滚动时全帧不会打断 viewport，等滚回底部时通过 resync 刷新。

**实际结果**：❌ 用户反馈"没有改善"。
**未知原因**：可能的问题点：
1. `scrollModeRef` 的同步时机——在 rAF 外读取 `scrollModeRef.current`，而该 ref 由 `onScroll` 回调更新，两者不在同一微任务中。rAF 回调读取时 ref 可能仍是旧值。
2. 或者问题不在帧渲染路径，而在更底层——比如 cell frame 协议本身在滚动场景下就有 viewport 坐标不匹配的问题。

### 尝试 4：会话切换内容泄漏修复（commit `d54745c`）

**改动**：
- `connectWs` 切换会话时立即 `term.reset()`，防止旧 session 的 SGR/scrollback 在新 session 首帧到达前闪现。
- 自定义键盘事件处理器改为从 `wsRef.current` 读取 ws 引用，避免闭包捕获已关闭的旧连接。

**实际结果**：`1;2c1;2c1;2c` 仍然出现（用户报告）。
**分析**：`1;2` 是 SGR bold+dim 残留，`c` 来自 `\x02c`（tmux new-window）。这两个应该都被修复覆盖了。可能是：
1. 有另一个未追踪的输入/输出路径，不经过 custom key handler 也不经过 WS close → reset 的窗口
2. 或者泄漏来自 tmux 服务端（多个 client attach 到同一 session 的竞争）

---

## 三、目前确认的状态

```
已修复（用户确认或测试证实）:
  ✅ 盲打输入丢行（commit 7f7fe22）
  ✅ 输出不实时（commit 78e4093）  
  ✅ 会话切换时旧 buffer 残留（commit d54745c）
  ✅ 键盘快捷键打到旧连接（commit d54745c）
  ⚠️ 滚轮概率性失效（多次尝试未收敛）
  ⚠️ 多次会话切换冒出 1;2c1;2c1;2c（仍未定位来源）
```

### 代码当前状态

| 文件 | 关键改动 | 状态 |
|------|---------|------|
| `frontend/src/hooks/useCellFrame.ts` | `isFull` 分支去掉 ESC[2J，添加 `scrollModeRef` + `pendingFullRef` | 行为正确但效果存疑 |
| `frontend/src/hooks/useTerminal.ts` | `scrollModeRef` 提前声明、切换时 `term.reset()`、键盘处理器读 `wsRef.current` | 已合并 |
| `docs/dev/plans/backlog/pty-cell-frame-viewport-scroll.md` | 方案 B 记录 | 待实施 |
| `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md` | 方案 C 记录 | 待实施 |

---

## 四、已排除的方向

| 方向 | 排除原因 |
|------|---------|
| xterm.js 版本问题 | 使用的是最新稳定版，无已知 scroll wheel bug |
| 前端 CSS `overflow: clip` | 不阻止 wheel 事件传播，scrollbar 隐藏不影响事件 |
| `touch-action: none` | 仅影响触摸手势，不影响鼠标滚轮 |
| PTY 写入失败 | tmux send-keys 绕开 PTY 也失败（scroll-pty-paging-bug.md 已有记录） |
| `cell_frame` 协议本身不可用 | 正常渲染完全正常，问题只在滚动场景 |
| 30fps 定时器的帧积压 | 已验证：rAF 批量渲染 + 帧队列上限（MAX_PENDING_FRAMES=120）+ resync 机制 |

---

## 五、可能的探索方向

### 方向 1：诊断 `scrollModeRef` 同步时序（低成本）

**问题假设**：尝试 3 失败的原因是 `scrollModeRef` 在 rAF 回调中读到旧值。

**验证方法**：
```typescript
// 在 useCellFrame 的 enqueue 中加日志
const skipFull = (frame.full || frame.overlay) && scrollModeRef?.current
console.log('[cellFrame] skipFull=', skipFull, 'scrollModeRef=', scrollModeRef?.current, 'viewportY=', termRef.current?.buffer.active.viewportY)
```

**解除条件**：如果日志显示 `scrollModeRef.current` 已经是 `false` 但 viewport 已被弹回底部，则问题确实是时序——ref 比实际滚动状态更新得快。

### 方向 2：用有类型平台重现 + 远程调试（低成本）

在 macOS/Windows 上运行，用 Chrome DevTools 的 Performance 面板录制滚轮操作，检查：
- WheelEvent 是否到达 xterm.js viewport
- 全帧渲染（`ESC[2J` 已去掉）是否还伴随"Synthetic mouse wheel"或"Programmatic scroll"
- viewportY 的实时变化曲线

### 方向 3：直接跳过滚轮时的全帧渲染（中成本）

**思路**：不只是检测 `scrollMode`（事后已滚动），而是在 wheel 事件到达时**主动通知后端暂停全帧发送**。

具体做法：前端检测到 wheel deltaY < 0（向上滚）时，给后端发一个"我正在看历史，请不要发全帧"的信号——但只发 diff 帧或暂停 cell_frame 一段时间。

实现：后端 `encode_cell_frame` 增加一个"模式"参数，或前端直接发 `Resync` 让后端 invalidate_diff + 以更高间隔发全帧。

**风险**：这与现有 30fps 定时器路径耦合，改动涉及前端+后端。

### 方向 4：回到 ESC[2J 但限制其频率（中成本）

**思路**：ESC[2J 本身不是问题，问题是 30fps 持续触发。如果在用户滚动后的一定时间内不加 ESC[2J，而是延迟写入，等用户回到底部后再一次性清屏。

改为后端在 invalidate_diff 后发一个标记帧，前端收到标记帧后"记住"需要下次清屏，只在 viewport 回到底部时执行。

### 方向 5：查看是否有未追踪的外部输入路径（低成本但高启发）

`1;2c1;2c1;2c` 的出现提示可能存在不经过 WebSocket 的输入路径。需要确认：
- 是否有其他组件持有对同一个 xterm 实例的引用并调用 `term.write()` 或 `term.onData()`？
- Settings 页面的 "Mouse Mode" 按钮是否直接调用了 `sendData` 发 tmux 命令而没有经过 wsRef？
- FileManager 的 "在此打开终端" 是否在创建新 session 时没有 clean up 旧 session 的终端状态？

搜索代码：
```bash
grep -rn 'term\.write\|term\.writeln\|\.send(data' frontend/src/ --include="*.ts" --include="*.tsx"
```

### 方向 6：方案 B/C 直接落地（高成本但最彻底）

方案 B/C 的设计文档已经写好。核心思路是让 xterm scrollback 不再承载"历史视图"职责，改为后端按需提供 viewport 窗口内容。

**路线**：先做方案 B（前端本地 viewport 坐标映射），不改后端。在 `renderCellFrame` 中传入当前 `viewportY`，全帧/diff 帧的 CUP 坐标减去偏移量。验证是否解决了"内容写入错误位置"的问题，再决定是否需要方案 C。

---

## 六、关键代码入口（供交接方使用）

| 关注点 | 入口位置 |
|--------|---------|
| 全帧渲染路径 | `useCellFrame.ts:renderCellFrame()` — `isFull` 分支 |
| diff 帧渲染路径 | `useCellFrame.ts:renderCellFrame()` — diff 分支，`row_indices` 映射 |
| 帧入队 + scrollMode 拦截 | `useCellFrame.ts:useCellFrame()` → `enqueue()` 中 `skipFull` 逻辑 |
| scrollMode 状态来源 | `useTerminal.ts:createTerminal()` → `term.onScroll()` |
| 会话切换重置 | `useTerminal.ts:connectWs()` 顶部的 `term.reset()` |
| 键盘处理器 ws 引用 | `useTerminal.ts:createTerminal()` → `attachCustomKeyEventHandler` |
| WS onmessage 首帧 reset | `useTerminal.ts:connectWs()` → `sawFirstBinary` + `term.reset()` |
| 后端 VT grid 编码 | `src/engine/pty/vt.rs:encode_cell_frame()` / `encode_frame_body()` |
| 后端 PTY 输出转发 | `src/engine/pty/terminal_ws.rs:forward_handle` → `encode_now()` |

---

## 七、不误导声明

以下是我**不确定**的：

1. **尝试 3 失败的确切原因**。我怀疑是 `scrollModeRef` 时序问题，但没有加日志验证。可能是这个，也可能完全是另一个问题。
2. **`1;2c1;2c1;2c` 的来源**。session-switch 的 `reset()` 和键盘 handler 的 `wsRef` 改法看起来正确，但用户反馈仍未改善。不排除有其他代码路径在写入这些字符。
3. **问题是否与 tmux multi-client 有关**。同一 tmux session 有 PTY client + control mode client 两个 attach。在 copy-mode + 多 client 的场景下可能有输入竞争，这是 tmux 官方文档中提到过的问题域。

这些不确定性应该被下一个接手的人认真对待，不要假设"应该修好了"。
