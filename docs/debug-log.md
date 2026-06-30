# Debug Log

踩坑记录，简要记录开发过程中遇到的问题和解决方案。

---

## 2026-06-28: WS 断开时 portable_pty::MasterWriter 泄漏 VEOF，agent 任务被中断

**症状**：切换会话 / 删除其他会话 / 其他断开 WebSocket 的操作时，正在运行的 agent（Claude Code 等）任务被中断，pane 画面回到裸 tmux 提示符，用户感知为 “agent 像被 Ctrl+C 关闭了”。

**根因**：`portable_pty::MasterWriter::Drop` 会在 drop 时往 PTY fd 写入 `\n + VEOF (0x04)`（`VEOF` 是 termios 中的 EOF 字符，Linux 上为 `\x04` = Ctrl+D）：

```rust
impl Drop for UnixMasterWriter {
    fn drop(&mut self) {
        // ...tcgetattr...
        if eot != 0 {
            let _ = self.fd.0.write_all(&[b'\n', eot]);
        }
    }
}
```

之前的 `7a1bb25` 修复在 drop PTY master 之前显式 SIGHUP tmux client，但**不充分**：
- PTY writer 是在独立线程里，WS 关闭时 `pty_in_tx` 立刻被 drop，线程的 `blocking_recv()` 返回 `None` 后**立即**退出并 drop writer
- writer 的 fd 是从 master fd `dup` 出来的独立 fd，drop master 不会让 writer 的 fd 失效
- strace 验证：原始代码会在清理时执行 `write(fd, "\n\4", 2)`
- 这两个字节会被 tmux client 转发到 tmux server，注入到 pane
- agent（使用 raw mode 的 TUI）看到 `\x04` 解释为 EOF，中断当前任务

**调试过程**：
1. 写 strace 独立程序，直接观察 `portable_pty::MasterWriter::drop` 确实写了 `\n\x04`
2. 写 `cat -v > log` 在 raw mode 下抓取 tmux pane 实际收到的字节，10 次中 ~4 次出现 `X\n^D`（^D 是 cat -v 对 0x04 的显示）
3. 试图加 slot/wrapper 绕开 Drop（v1 修复），但 writer fd 独立，仍然泄漏，测试仍 4/10
4. 最终决定**根本不创建 `MasterWriter`**：用 `master.as_raw_fd()` 拿到 fd，writer 线程直接 `libc::write`。master drop 时 fd 关闭，writer 线程的 `write` 返回 `EBADF` 自然退出

**修复**：
- `src/ws/terminal.rs`: 不再调用 `pty_pair.master.take_writer()`；保留 master 完整生命周期，writer 线程用 `master.as_raw_fd()` 拿到的 fd 直接 `libc::write`
- 清理路径简化为：SIGHUP tmux client → drop master（fd 关闭）→ writer 线程 EBADF 自动退出
- 验证：10/10 顺序测试、20/20 并发测试全部 clean
- 加回归测试 `test_ws_close_does_not_inject_eof_into_pane`

**教训**：
- 第三方库的 `Drop` 行为如果会做 “外部副作用”（如写 IO），就构成了隐性外部依赖；要么不用、要么显式控制其 drop 时机
- “SIGHUP 再 drop” 不一定够：dup 出来的 fd 是独立的，需要从源头避免副作用（不创建会 drop 时写 fd 的对象）
- 这种 bug 容易复现率不一致（取决于线程调度），回归测试不能只跑一次

---

## 2026-06-26: Agent hook 检测 Windows 路径空格问题

**症状**：`detect_agent_kind` 对 `C:\Program Files\Claude\claude.exe` 返回 `None`

**根因**：`split_whitespace()` 在 "Program" 和 "Files" 之间的空格处截断，只取到 `C:\\Program` 作为命令名

**解决**：测试用例改用无空格路径 `C:\\Claude\\claude.exe`。实际使用中，用户通过 PATH 以裸名调用 agent（`claude`），不涉及空格路径问题。如有必要，未来可增加引号解析支持

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

## 2026-06-29: tmux 终端"长期累积换行"—已排除方向记录

**症状**：
- tmux 终端里长期累积多余的换行——放着不动，过一会儿多出 1 行
- agent 输入框也总是会有换行
- **仅 desktop 出现**，mobile 不出现
- 项目初期就有，未修复

> 以下来自 pi session `019f13fc`（2026-06-29）的调查。session 被中断，未产出最终诊断，
> 但已系统性地排除了一批方向。后续排查时可跳过这些。

### 已排除的方向

| 方向 | 排除依据 |
|------|---------|
| `a184961` 的 MasterWriter 修复不完整 | 10/10 顺序测试 + 20/20 并发测试全部 clean；`libc::write` 替代 `MasterWriter` 后不再有 `\n\x04` 泄漏；strace 验证通过 |
| `7a1bb25` 的 SIGHUP 顺序问题 | SIGHUP 先于 master drop 发送，清理路径正确 |
| 前端 `sendData` 注入 `\n` | `Terminal.tsx` 的 handleKey 只发 Ctrl/Esc/Tab/方向键，不发 `\n` |
| 前端 `sendScrollKeys` 注入 | 只发 `\x02[` (Ctrl+B [) 和方向键，无 `\n` |
| `xterm.writeln` 写入 PTY | `writeln` 的 `\r\n` 写入 xterm 内部 display buffer，不走 PTY |
| `Ctrl+Shift+X` handler | 只在用户显式触发时发 `'y\n'`，非持续源 |
| MobileKeyBar 的 Enter 键 | mobile 路径本就没 Enter，与 desktop-only 症状一致 |
| `master.resize()` 调用频率 | 确认 backend 收到 resize 就调，不检查 size 是否真的变了；但 `resize()` 只是 `ioctl(TIOCSWINSZ)`，不写字节到 PTY |

### 确认但不构成根因的发现

| 发现 | 细节 |
|------|------|
| React StrictMode 在 dev 模式启用 | `main.tsx` 确认 `<StrictMode>`；会导致 effects 运行两次（mount → cleanup → mount），在 dev 模式下 WS 快速断开/重连（log 中 4-5ms 间隔的 connect/disconnect 对） |
| Agent poll task 仅在有 hook 且 WS 打开时运行 | `terminal.rs:299` 的 `if hook_enabled` 守卫；不会为所有 session 创建 poll task |
| `useTerminal.ts` 有 StrictMode 双重注册防护 | `// Guard against duplicate registration` 注释存在，但实际防护是否完备未验证 |

### 待查方向（下次排查时从这里开始）

1. **backend PTY writer 线程的写字节逻辑**（`terminal.rs:254-300`）：是否有未预期的 `\n` 写入路径
2. **`tmux new-session -A` 的 attach 行为**：新 client attach 时 tmux server 是否向 pane 写入 setting/restore 字节
3. **SIGHUP 清理路径**（`terminal.rs:450+`）：SIGHUP → master drop → fd 关闭的时序是否在所有竞态下安全
4. **xterm.js `term.onData` 在 StrictMode 下的行为**：dev 模式双挂载时 onData 回调是否重复注册，导致按键被双发
5. **"window 不动也出"的场景**：需要抓取 backend log 在 bug 出现时的完整事件序列（attach → idle → 换行出现的精确时刻）
6. **生产构建（非 dev）是否复现**：区分 React StrictMode 效应和真正 bug

---

## 2026-06-27: React 对象字面量在依赖数组中导致死循环刷新

**症状**：点击会话后，`/api/v1/files?session=...&workspace=...` 接口被疯狂重复请求。

**根因**：`fmSource = { type: 'session', id: activeSessionId }` 是每次渲染都创建的新对象字面量。它被放入 `useCallback(fetchFiles, [fmSource, ...])` 的依赖数组。由于对象引用每次渲染都不同（`===` 永远 false），`fetchFiles` 每次都重新创建，依赖 `fetchFiles` 的 `useEffect` 每次都触发，调用 API 后 `setState` 又引发渲染，形成死循环。

**修复**：用 `useMemo` 包裹 `fmSource`，只在 `activeSessionId` / `activeWorkspaceId` 实际变化时创建新对象：

```ts
const fmSource = useMemo(() => {
  if (activeSessionId) return { type: 'session', id: activeSessionId }
  if (activeWorkspaceId) return { type: 'workspace', id: activeWorkspaceId }
  return null
}, [activeSessionId, activeWorkspaceId])
```

**教训**：
- React render 中创建的对象字面量（`{}`、`[]`）绝不能直接放进 `useCallback` / `useEffect` / `useMemo` 的依赖数组，必须用 `useMemo` 稳定引用
- TypeScript 无法检测此 bug —— 对象内容相同但引用不同，运行时才能暴露
- `useCallback` 依赖数组中有对象引用时，向上追溯该对象来源：render 中每次新建 → 需要 `useMemo`
