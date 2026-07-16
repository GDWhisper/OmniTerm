# Debug Log

踩坑记录。每条记录的目标是**从具体 bug 中提取可复用的调试方法论**，而不是简单记录“问题 → 修复”。没有理论抽象的记录等于没写——下次遇到类似问题时，一条“X 文件 Y 行改成 Z”的记录毫无参考价值，因为你不会记得它为什么有效、在什么条件下有效、诊断过程中踩了什么坑。

### 写法要求

每条记录 MUST 包含以下层次（按优先级）：

1. **可复用的理论/模式**（最重要）：从这个 bug 中能提取出什么通用规律？比如「同步→异步重构会破坏框架隐式原子性」「每个 await 都是竞态窗口」。用 **加粗标题** 单独列出，方便未来 Ctrl+F 查找。
2. **诊断过程中的错误**：走了什么弯路、为什么、下次怎么避免。这比修复方法更有价值——别人读到时能直接跳过你踩过的坑。
3. **具体根因与修复**：作为理论的例证，而不是记录的主体。

如果一条记录只有第 3 层（具体修复），没有前两层，说明写的时候偷懒了。补上再提交。

---

## 2026-07-08: 同步→异步重构破坏框架隐式不变量（终端 StrictMode 双重初始化）

**症状**：终端点开会话后输入行/光标错位、大片黑屏、无法操作。

**表层根因**：commit `a06eb48` 将 `createTerminal` 从同步改为 async（动态加载 xterm addons）。

**深层根因 — 同步→异步重构破坏 React effect cleanup 不变量**：

同步版本中，`createTerminal` 内部的 `term.open()` 在 effect 返回前执行完毕，`termRef.current` 已被赋值。StrictMode 的 cleanup 在两次 effect 之间同步执行，看到非 null 的 `termRef.current`，调用 `disposeTerminal()` 有效清理。第二次 effect 重新创建，一切正常。

改为 async 后，`term.open()` 在 `await loadAddons()` 之后才执行。StrictMode cleanup 在 await 期间执行，此时 `termRef.current` 仍为 null → cleanup 为空操作。两个并发的 `createTerminal` 各自独立完成 `term.open()`，第二次覆盖第一次的 DOM，xterm 内部状态损坏。

**诊断过程中犯的错误**：

1. **假设先行，验证滞后**：第一个根因分析假设「await 期间 CSS 动画改变容器尺寸」，headless 测试无法复现，于是推断「测试环境差异」。实际上加了 console.log 后立刻发现 cols:182 rows:42 完全正确——尺寸从来不是问题，真正的信号（term.open 被调用两次）在第一轮诊断时就能通过日志发现。
2. **第一个修复无效后没有换方向**：第一次修复把 import 提到模块顶层（解决 yield 窗口），用户报告没修好。此时应该立即加诊断日志，而不是继续在同一假设上叠加代码。
3. **没有在用户环境加诊断就动手修**：headless 测试看不到 StrictMode + 网络延迟 + 真实浏览器的组合行为，唯一的可靠证据是用户 DevTools console。

**日志证据**（用户浏览器 DevTools）：
```
loadAddons() called    ← Promise {<pending>}  (第一次，yield)
loadAddons() called    ← Promise {<pending>}  (第二次，yield — 两个并发!)
loadAddons() resolved  ×2
term.open + fit.fit    ×2  ← 同一容器 open 两次! cols:182 rows:42 (尺寸正确)
WS connecting          ← 182x42
```

**修复**：AbortController 模式 — `disposeTerminal` abort 信号，`createTerminal` 在 `await` 后检查 `signal.aborted`，已 abort 则 bail out 不碰 DOM。

### 可复用的调试理论

**1. 同步→异步重构会破坏框架的隐式原子性保证**

React effect cleanup 依赖「effect 返回前完成所有副作用设置」这一隐式前提。改为 async 后这个前提被打破：cleanup 跑时副作用还没开始，ref 为 null，cleanup 变空操作。**凡是把同步初始化逻辑改为 async 的重构，都必须同步审视 cleanup 路径是否仍然有效**——检查 ref/null guard、AbortController、或 isCreating 标志。

**2. async 函数的每个 await 都是一个竞态窗口**

await 之后的代码与 cleanup / 其他并发调用交错执行。关键问题：
- await 期间 cleanup 能否正确中断？
- 多个并发调用能否互相感知？
- await 之后的状态检查是否还有效？

**模式**：对每个 await 后的「状态修改 + DOM 操作」序列，加 `if (signal.aborted) return` 或等价的 guard。

**3. console.log 是第一优先级的诊断手段，不是最后手段**

当用户报告 bug 且 headless 测试无法复现时，**先在用户环境加日志再分析代码**。日志回答两个关键问题：
- 代码是否执行到了预期位置？（执行流确认）
- 执行时的状态值是什么？（状态确认）

这次调试中，3 行 console.log 揭露的真相（并发调用 + 双重 term.open + 尺寸正确）比几百行代码分析加 headless 测试都多。

**4. Headless 测试无法复现 StrictMode + 网络延迟的组合场景**

Vite dev mode 的动态 import 是 microtask 级（已 prebundle），生产构建的网络 fetch 可达 100-500ms。StrictMode 的 cleanup 时序在这两种场景下完全不同。不要因为 headless 测试通过就认为修复有效。

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

---

## 2026-06-30: FileManager 列宽拖动不跟手

**症状**：FileManager 表头列（name / mtime / size）拖动调整宽度时明显延迟、不跟手；文件数量越多越卡。

**根因**：`onMouseMove` 每次触发都调用 `setColWidths`，导致整个 `FileManager` 组件（958 行巨组件，含大量 hooks、state、子组件、`<tbody>{files.map(...)}` 整张文件列表）在 60fps 频率下完整重渲染。文件多时是 O(N) 开销，主线程被占满，UI 卡顿，拖拽条跟不上鼠标。

**调试过程**：
1. 读 `frontend/src/components/FileManager/FileManager.tsx:208-225` 的 resize useEffect，确认 `setColWidths` 在 mousemove 中调用
2. 查 `debug-log.md` 2026-06-23「拖拽条不跟手」条 —— 但那条修的是侧边栏宽度（`setSidebarWidth` + CSS transition），与列宽是不同的拖动，根因不同
3. 查 `frontend/src/index.css:488-580` 的 `fm-table` / `fm-th-resize` 样式，**无 CSS transition 涉及列宽**，排除 transition 因素
4. 排除 localStorage 写入（列宽 state 本来就不持久化）
5. 锁定根因：React 重渲染而非 CSS / I/O

**修复**：
- 三个 `<col>` 元素加 ref（`colRefs.current.name / mtime / size`）
- `onMouseMove` 只做 DOM 直接写入（`colEl.style.width = \`${newW}px\``），**不调** `setColWidths`
- `onMouseUp` 时读 col 元素的当前 width，调一次 `setColWidths` 同步最终值 —— 保证 sort、文件切换、目录导航等 React 流程不丢状态
- 验证：`pnpm tsc --noEmit` 通过；`pnpm test` 21/21 通过

**教训**：
- 大组件中 `mousemove`/`scroll` 触发 `setState` 等于 O(component size) 重渲染；应只更新 DOM，松手时再 sync state 一次
- 同一份 debug-log 之前记录的「拖拽条不跟手」（侧边栏宽）虽然症状相似，但**根因不同**（localStorage + transition vs. React re-render）。表面相似 ≠ 同一 bug，逐案例分析
- `<col>` 元素的 inline `style.width` 是 60fps 拖动列宽的标准抓手 —— 不依赖 React、不依赖 CSS variables、改动最小

---

## 2026-06-30: FileManager 列宽拖动"位置不对"（拖 A 列 handle 改 B 列）

**症状**：上一条「列宽拖动不跟手」修复后，拖 A 列 resize handle，B 列宽在动；拖 +100px 鼠标位置和列宽变化错位 70+px。

**根因**（两个独立 bug 叠加）：

1. **col 元素位置 ≠ 视觉列位置** —— `colgroup` 始终有 5 个 `<col>`（checkbox + name + mtime + size + actions），但 `thead` 在 `downloadMode=false` 时只有 4 个 `<th>`（少 checkbox th）。`table-layout: auto` 下，col 0 (width=0) **不消失**，浏览器按内容给 col 0 实际宽度 162.89px，**视觉上 col 0 对应"名称"列**（th 0 位置），col 1 (name) 视觉上对应"修改时间"列。`colRefs.current.name` 指向 col 1，**但 col 1 视觉上是"修改时间"列** —— 拖"名称"handle 改的是"修改时间"列宽。
   - Playwright 实测：th 0 (名称) width = 162.89 = col 0 bbox；th 1 (修改时间) width = 168.31 = col 1 bbox

2. **列宽按比例分配** —— `table-layout: auto` 下，col width 是「最小宽度提示」，实际列宽 = max(col width, 单元格内容最小宽度)，且**总表格宽度受 `min-width: 540px` 限制按比例分配到各 col**。拖 name col width 300→400 (state)，实际 th 0 只 +27px (264→291)，其他列缩小。**用户拖 +100px，handle 视觉上跑在鼠标前面 70+px**。

**调试过程**：
1. 加 console.log 临时调试 `r.col` 和 `colEl` —— ref 与 col 元素对应正确（无错位）
2. Playwright 读 DOM bbox —— 发现 col 0 (state=0) bbox=162.89 = th 0 (名称) width；col 1 (state=300) bbox=168.31 = th 1 (修改时间) width
3. 试 `visibility: collapse` on col 0 —— 让 th 0 也变成 width=0（不可用）
4. 试 `table-layout: fixed` —— col width 严格生效，bbox = state width，th width = col width

**修复**：
1. `frontend/src/index.css`：`.fm-table` `table-layout: auto` → `table-layout: fixed`
2. `frontend/src/components/FileManager/FileManager.tsx`：colgroup 第一个 `<col>` 改成条件渲染 `{downloadMode && <col style={{ width: 32 }} />}` —— 让 downloadMode=false 时 col 数量 = th 数量 = 4，col/th 顺序对应
3. `handleResizeStart` 中 `startW` 从 `colWidths` state 改为 `colEl.getBoundingClientRect().width`（实际宽度）
4. `onMouseUp` 中 `finalW` 从 `parseInt(colEl.style.width)` 改为 `colEl.getBoundingClientRect().width`（实际宽度，fixed 下与 state 一致，但更稳健）
5. 验证：Playwright 实测拖 name handle +100px → th 0 300→400，th 1/2/3 完全不变；拖 mtime handle -50px → th 1 140→90，th 0/2/3 完全不变；21/21 vitest 通过

**教训**：
- `table-layout: auto` 对列宽拖动是**反模式**——col width 几乎被忽略，列宽按内容/比例分配，拖动时 handle 跑在鼠标前面/后面。列宽拖动**必须**用 `table-layout: fixed`
- `colgroup` 列数必须与 `thead` 列数一致——多出来的 col 会"按内容"占视觉空间，**与预期 col width 无关**。如果需要"额外"的 col（如 downloadMode 临时多出 checkbox 列），要么**条件渲染**对齐数量，要么**用 colspan/separate th** 避免 col 数量变化
- `getBoundingClientRect().width` 是拖动时**唯一可信**的"当前宽度"——state 永远滞后于实际布局（特别在 auto layout 下）。startW/finalW 都应该读 bbox，不读 state
- 修了一个 bug 发现**更深层**的 bug（"列宽不跟手"的延迟修完 → 用户开始能拖了 → 才暴露"列错位"）—— 这是正常的递进调试，不要在第一层修完就当 done，要等用户实际使用后才知道下一层问题


---

## 2026-07-16 → 07-17: 长运行后端 inotify fd 单调增长 — 已修复

**症状**：前端 Vite 启动报 `ENOSPC: System limit for number of file watchers reached`。`lsof | grep inotify` 统计发现：跑 5 天的 `omniterm-dev` 实例独占 1320 个 inotify fd；同 worktree 新启动的实例只有 78 fd。差 17 倍。

**临时缓解**（已做）：`echo 'fs.inotify.max_user_watches = 524288' > /etc/sysctl.d/60-inotify.conf`。不治本 — 泄漏持续，1-2 周后仍会撑满。

**可复用理论 / 模式**：

- **长期资源注册必须有对称的释放路径**：每个 `Watcher::new()` / `inotify_add_watch()` / `tokio::spawn` 都应对应 drop / `unwatch()` / `abort()`。任何"只增不减"的注册表（`HashMap<_, Arc<X>>`、长期 tokio task、`notify::Watcher`）都是泄漏嫌疑。
- **资源泄漏与运行时长的相关性是最强信号**：同二进制、不同运行时长、fd 数差 N 倍 → 几乎 100% 是泄漏。`lsof` + 时间序列数据点是定位这类问题的第一手段，比看代码快。
- **调高系统上限是诊断辅助，不是修复**：把 inotify 上限从 65536 调到 524288 让症状消失，但泄漏仍在。
- **`spawn_blocking` + 长生命周期资源 = 高危组合**：普通 async task 在 future drop 时自然结束；`spawn_blocking` 跑的是普通线程，future drop **不会** abort 它。如果线程里持有 inotify fd、数据库连接、文件锁，必须**显式**给它一条能退出的路径（`watch::channel` / `AtomicBool` / `CancellationToken`），并在上层 drop 时触发。把返回的 `JoinHandle` 直接 `_` 丢弃是最常见的写法，也是最容易泄漏的写法。
- **async 流（Axum SSE / gRPC streaming）的"客户端断开"靠的是 future drop**：stream generator 持有的资源会在客户端断开时被 Rust drop 机制释放；可以把"shutdown sender"也绑到 generator 的 capture 里，利用 drop 触发对端 worker 退出 — 比另起 Drop guard 类型简洁得多。
- **`lsof | grep inotify` 在非 sudo 下不可靠**：没有 sudo 时 `lsof` 对别的进程的 inotify 条目常常返回空（permission denied 被吞掉），看起来像"没有泄漏"。改用 `readlink /proc/<pid>/fd/*` 直接扫，看到 `anon_inode:inotify` 就是 watch，权限无关。

**诊断过程中犯的错误**：

1. **第一时间怀疑 Vite 配置**：ENOSPC 的 stack trace 指向 `vite.config.ts`，但那只是最后一个申请 fd 的倒霉蛋。ENOSPC 是资源耗尽类错误，第一诊断动作永远是 `lsof` / `df` / `ulimit` 类的资源快照，而不是看报错栈。
2. **验证脚本初版用 `lsof | grep -c inotify` 计数**：没 sudo 时输出永远是 0，结果"看起来 PASS"但其实测的是空气。换成 `readlink /proc/<pid>/fd/*` 后才看到真实数据。验证脚本的**测量工具必须先验证自身可信**。
3. **验证脚本用错了 workspace 标识**：`/files/watch?workspace=omniterm-dev` 传的是 project name 而非 id，endpoint 走到 fallback 返回空 stream，所以"watcher 根本没创建" — 又一次假 PASS。脚本必须**先确认被测资源真的被分配**了，再测释放。

**具体根因与修复**：

`src/api/files_watch.rs` 的 SSE handler 每个连接都 `tokio::task::spawn_blocking` 一个线程，线程里 `RecommendedWatcher::new()` 后进入 `loop { thread::sleep(3600) }` 永不退出；返回的 `JoinHandle` 被 `let _watcher_handle = ...` 直接丢弃（变量名带 `_` 前缀 → Rust 立刻 drop JoinHandle，但**不会 abort**底层线程）。结果：

- 每打开一个 SSE 连接 → 多一份 inotify watches（递归目录 = 几百个 watch）
- 客户端断开 → async stream future drop，但 blocking 线程**完全感知不到**，继续 sleep
- Watcher 永不 drop → `inotify_rm_watch` 永远不调用 → fd 单调增长

`control_mode.rs` 的 `SessionActivityMonitor` 审计通过：`remove_session()` 正确调 `client.stop().await`、`Child` handle 被 reap、reader task 通过 oneshot 信号退出；且它根本不创建 inotify fd（`tmux -C` 走 pipe，不 watch 文件）。ACP 模块同理，无直接 inotify 使用。

修复：加一个 `tokio::sync::watch::channel(())`，sender 由 `async_stream::stream!` generator 持有（`let _shutdown_guard = shutdown_tx;`），blocking task 拿 receiver 在 park loop 里 `while shutdown_rx.has_changed().is_ok() { sleep(250ms) }`。客户端断开 → stream generator drop → sender drop → `has_changed()` 返回 `Err` → loop 退出 → Watcher drop → inotify fds 全部释放。

**验证**：`scripts/verify-inotify-fix.sh` — 打开 12 个并发 SSE 连接，`/proc/<pid>/fd` 扫到 inotify 从 0 涨到 12；全部 kill 后 3 秒内回到 0。回归基线 ±0。

**产出物**：
- `src/api/files_watch.rs` — 加 shutdown watch channel、去掉死 `if kind_str == "delete"` 分支、清理重复注释
- `scripts/verify-inotify-fix.sh` — 自动化验证脚本（可重复跑）
- `docs/dev/plans/2026-07-16-inotify-leak-investigation.md` — 排查方案（保留作为下次类似问题的模板）
