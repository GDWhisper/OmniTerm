# Debug Log

踩坑记录，简要记录开发过程中遇到的问题和解决方案。

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
