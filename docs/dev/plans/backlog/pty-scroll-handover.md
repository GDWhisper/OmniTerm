# PTY 终端滚轮问题交接文档

> **状态**：根因已定位（2026-08-28 静态核查，见 §零）。出路为方案 C。
> **最后修改**：2026-08-28 根因核查
> **关联文档**：`docs/dev/plans/backlog/pty-cell-frame-viewport-scroll.md`（方案 B，**已撤销**）
> `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（方案 C，**唯一自洽出路，已确认前提**）

---

## 零、2026-08-28 根因核查：此前全部尝试的前提与 xterm.js 6.0.0 实际行为不符

本轮核查将交接文档的假设链逐条对照实际安装的 `@xterm/xterm@6.0.0` 源码与后端代码验证，结论如下。

### 核查点 1：`ESC[2J`（ED2）在 xterm.js 6.0.0 中**不清 scrollback**

`InputHandler.eraseInDisplay` case 2 仅 reset 视口内各行；清 scrollback 的是 case 3（ED3 / `ESC[3J`）。case 2 仅在 `scrollOnEraseInDisplay` 选项开启时才连带滚动（本项目未开启）。

→ **尝试 1 的前提（"ED2 周期性清掉 scrollback 导致滚轮失效"）不成立**。那次修复修的是一个不存在的机制；其"画面漂移"副作用另有原因（diff 帧误走全屏路径，已在尝试 2 修复），与 scrollback 无关。

### 核查点 2："全帧 30fps 写入把 viewport 拉回底部"**不存在**

xterm.js 6.0.0 有原生的用户滚动保持机制：

- `BufferService.scrollLines`：用户向上滚（disp < 0）置 `isUserScrolling = true`；滚回底部才复位。
- `BufferService.scroll`（底部行换行推 scrollback 时触发）：`isUserScrolling` 置位时**不**强制 `ydisp = ybase`，视口保持。
- cell_frame 全帧是纯 CUP + EL + 内容重绘，**不产生底部换行，从不触发 `BufferService.scroll`**，ydisp 无从被"拉"。

→ **尝试 2 的分析（"光标定位最后一行触发 auto-scroll"）与尝试 3 的整套 `scrollModeRef` 暂存/回底 resync 机制，防的是一个基本不存在的敌人**。方向 1（scrollModeRef 时序诊断）随之失效。

### 核查点 3：真根因 —— cell_frame 模式下**前端 xterm scrollback 结构性冻结**

hello 握手后，后端只发 cell_frame 文本帧（`terminal_ws.rs` cell-frame ticker 分支，raw 字节只喂 VT grid，不再转发）。前端 xterm 因此**永远收不到底部行的 LF** → `BufferService.scroll` 永不触发 → `ybase ≈ 0` 恒定 → **滚轮无内容可滚**。

前端 scrollback 仅有的来源：

1. WS open 到 hello 生效之间的**raw 窗口期**（tmux attach 重绘 burst，概率性滚入几行内容）；
2. 状态行 `writeln`。

这完整解释了全部症状：

| 症状 | 解释 |
|------|------|
| 有时无法滑动 | `ybase = 0`，滚轮无空间 |
| 滑一下又被弹回 | 窗口期恰好滚入 1~2 行，滚完即到底；且 xterm 默认 `scrollOnUserInput: true`（滚动中按任意键强制回底）加重"弹回"体感 |
| 切换会话临时恢复 | 每次重连产生新的 raw burst，重建一小段（垃圾）scrollback |
| 间歇性 | 窗口期输出量随 attach 时序波动 |

### 核查点 4：`1;2c1;2c` 已定位 —— Primary DA 应答泄漏

链条：tmux attach 时（raw 窗口期内）发 `ESC[c`（Primary DA 查询）→ 转发到前端 → xterm.js 自动经 `onData` 回复 `\x1b[?1;2c`（InputHandler DA1 handler）→ WS → 后端写入 PTY stdin → tmux 收到**迟到/多余**的应答，透传给 pane 内 shell → PTY echo 回显（ESC 不可见）→ 屏幕出现 `1;2c`。每次会话切换泄漏一次，多次切换连成串——与症状完全吻合。

关键事实：**后端 alacritty VT 已经应答 DA1**（`identify_terminal` → `PtyWrite("\x1b[?6c")`，经 `vt.rs` 的 `ResponseSink` 回写 PTY）。前端应答是**纯重复**，过滤它不影响 tmux 拿到应答。

修复方案（已落地）：pty 会话的 `onData` 路径按**锚定整串白名单**过滤 xterm.js 全部自动应答形态（DA1/DA2/CPR/DECXCPR/DSR/DECRPM/窗口尺寸/OSC 应答），tmux/外部会话不过滤（那里 xterm 是唯一终端模拟器，应答必需）。鼠标协议上报（SGR/X10 mouse report）形态与白名单不重叠，正常放行。

### 探索方向重估（对照原文档 §五）

| 原方向 | 重估结论 |
|--------|---------|
| 方向 1（scrollModeRef 时序） | ❌ 前提失效（核查点 2），撤 |
| 方向 2（平台重现/远程调试） | ❌ 不需要，根因已静态确认 |
| 方向 3（wheel 时暂停全帧） | ❌ 全帧不拉视口（核查点 2），撤 |
| 方向 4（限制 ESC[2J 频率） | ❌ ED2 不清 scrollback（核查点 1），撤 |
| 方向 5（未追踪输入路径） | ✅ 已解开：`1;2c` = DA1 应答泄漏（核查点 4） |
| 方向 6 / 方案 B | ❌ 前提崩塌：scrollback 冻结意味着 viewport 偏移几乎恒为 0，坐标映射修的是不会发生的状态。**已撤销** |
| **方案 C** | ✅ **唯一架构自洽的出路**：把"历史视图"职责整个移交后端 viewport 窗口请求。前提已验证：后端 grid 配有 1000 行 scrollback（`vt.rs` `scrolling_history: VT_SCROLLBACK_LINES`） |

---

## 一、问题描述

> 症状描述仍然有效，成因见 §零。

PTY 终端的鼠标滚轮**概率性失效**——用户向上滚动查看历史输出时，滚轮有时无法滑动，或滑了一下又被弹回底部。切换会话再切回来可以临时恢复，但很快再次失效。

核心矛盾：滚轮**不是完全不可用**，而是**间歇性被击穿**。这比"永远不可用"更难定位。

---

## 二、已尝试的方案与尝试记录

> ⚠️ **2026-08-28 勘误**：本节尝试 1/2/3 的**分析前提**均已被核查推翻（见 §零），记录保留仅为历史价值，勿沿其结论继续推理。

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
  ✅ 滚轮概率性失效 —— 根因已定位（§零核查点 3：scrollback 结构性冻结），
     出路 = 方案 C（后端 viewport 窗口渲染）
  ✅ 多次会话切换冒出 1;2c1;2c1;2c —— 已定位（§零核查点 4：DA1 应答泄漏），
     修复 = pty 会话 onData 过滤 xterm.js 自动应答
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

> ⚠️ 2026-08-28：本表与 §零 核查冲突时，以 §零 为准。

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

> ⚠️ **2026-08-28 勘误**：本节已整体被 §零 的方向重估表取代——方向 1/2/3/4/6 撤销，方向 5 已解答，方案 C 立项。以下原文保留作历史记录。

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
| 输入侧自动应答过滤 | `frontend/src/utils/ptyInputFilter.ts` + `useTerminal.ts` onData 内 pty 分流（1;2c 修复，见 §零 核查点 4） |

---

## 七、不误导声明

原交接时的三条不确定性，2026-08-28 核查后状态：

1. **尝试 3 失败原因** —— 已解答：前提错误（全帧写入本就不会拉视口，见 §零 核查点 2），非时序问题。
2. **`1;2c1;2c1;2c` 来源** —— 已定位：xterm.js 对 Primary DA 查询的自动应答泄漏（见 §零 核查点 4）。
3. **tmux multi-client 竞争** —— 与本问题无关；root cause 在前端双终端模拟器消费同一流的架构，已由 §零 排除。
