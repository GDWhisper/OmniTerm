# Debug Log

踩坑记录，简要记录开发过程中遇到的问题和解决方案。

---

## 2026-06-23: 切换会话时 TUI 多一行 + opencode 断联

**症状**：
1. 切换 tmux 会话时，pane 中 TUI 应用的输入框多了一行可输入的行
2. tmux 中运行 opencode 后切换会话，opencode 断联

**根因**：`portable-pty` 的 `UnixMasterWriter::drop()` 在关闭 PTY fd 前会写入 `\n` + EOF 字符到 PTY。切换会话时，后端只靠 `master_pty.take()` 关闭 fd，触发了这个 Drop 行为，导致 `\n` + EOF 泄漏到 tmux pane 中的 TUI 应用。

对比 tmuxes 参考实现（`server/src/ws/terminalSession.ts`），tmuxes 在 dispose 时显式调用 `ptyProc.kill()`（发送 SIGHUP），绕过了 `MasterWriter::drop()`，不会写入任何额外字符。

**调试过程**：
1. 在 `onData` 回调中加 `console.log`，发现只有 xterm.js 的 DA 自动响应（`\x1b[?1;2c`, `\x1b[>0;276;0c`, OSC 10/11），没有用户输入 `\r`/`\n` → 排除前端键盘事件泄漏
2. 对比 tmuxes 源码，发现关键差异：tmuxes 用 `ptyProc.kill()` 显式发 SIGHUP，OmniTerm 靠 PTY fd 关闭
3. 查看 `portable-pty` 源码（`src/unix.rs`），发现 `UnixMasterWriter::drop()` 会写 `\n` + EOF 到 PTY

**修复**：
1. 在 drop PTY master 之前，显式发送 SIGHUP：`libc::kill(pid, SIGHUP)`
2. 附带优化：WebSocket URL 传递 `?cols=X&rows=Y`（和 tmuxes 一致），PTY 从创建时就是正确 viewport 尺寸，不再需要 SIGWINCH 二次布局

**教训**：
- 不要依赖 RAII 的 Drop 做关键清理（如发送信号），显式调用更可控
- 第三方库的 Drop 实现可能有意外副作用，需要查看源码确认
- 对比参考实现时，关注"清理/销毁"路径，不只是"创建/连接"路径

---

## 2026-06-23: 拖拽条不跟手

**症状**：Sidebar 和 FileManager 的拖拽条拉动时有明显延迟，不跟手。

**根因**：
1. `setSidebarWidth`/`setFileManagerWidth` 每次调用都写 `localStorage`，在高频 `mousemove` 事件中阻塞主线程
2. CSS `transition: 'width 0.2s ease'` 导致每次宽度变化都有 200ms 动画延迟

**修复**：
1. Store 中移除 `localStorage` 写入，改为松手时（`onUp`）持久化一次
2. 拖拽时动态禁用 CSS transition：`transition: isDragging ? 'none' : 'width 0.2s ease'`

**教训**：高频事件（mousemove/scroll）中避免同步 I/O（localStorage），CSS transition 会影响拖拽响应性。

---

## 2026-06-23: 拖拽条宽度限制硬编码

**症状**：Sidebar 最大 280px，FileManager 最大 400px，不适配不同屏幕尺寸。

**根因**：硬编码的像素值没有考虑屏幕宽度。

**修复**：改为动态计算：
- Sidebar: `Math.floor(window.innerWidth / 3)`
- FileManager: `Math.floor(window.innerWidth / 2)`

**教训**：布局限制应该用相对值（屏幕比例），不要用绝对像素。

---
