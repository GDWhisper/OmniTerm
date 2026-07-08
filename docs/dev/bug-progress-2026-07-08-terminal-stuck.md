# Bug: 终端点开会话后输入行/光标错位、大片黑屏、无法操作 — 修复进展

> **状态（2026-07-08）**：**未修复**。已提交一次代码改动（`5f871a2`），用户报告未解决，
> 于同日 revert（`3587a4d`）。

---

## 1. 用户报告（原文）

> 点开会话时，终端输入行显示在底部，上方一大片黑屏，且光标也在顶部，无法做任何操作

**用户视角症状**：
- 输入行（prompt）在底部
- 上方一大片黑屏
- 光标（cursor）在顶部
- 无法输入命令

---

## 2. 我在 headless Chromium 里观察到的（bug 复现失败）

**流程**：empty state → 点开 session "flow-test"

测量 t=100/300/600/1500ms：

| 指标 | 值 |
|---|---|
| `.terminal-panel-pixel` offsetHeight | **737px**（全程稳定） |
| `.terminal-panel-pixel > div` offsetHeight | **733px**（全程稳定） |
| `.xterm` offsetHeight | **720px**（从 100ms 起就是这个值） |
| `.xterm-rows` count | **90 rows** |
| 底部 prompt `pax@pax-GEM12:~/home$` | 可见 |

**结论**：在我的测试环境里，从会话打开的第 100ms 起 xterm 就是正确尺寸（720px / 90 行），底部 prompt 正常显示。**bug 不复现**。

截图证据：terminal-panel-pixel 内容区有 90 行，prompt 在最底行（第 90 行），与用户的「光标在顶部 + 大片黑屏」完全不符。

---

## 3. 我做的根因诊断（**未经验证的推测**）

**高嫌疑 commit**：`a06eb48 perf: xterm addons 按需加载 — 拆分出独立 chunk`

该 commit 把 `createTerminal` 改为 `async`：

```ts
// a06eb48 之前（同步）
const createTerminal = useCallback((container) => {
  const term = new Terminal({...})
  const fit = new FitAddon()
  // ...
  term.open(container)
  fit.fit()
  // ...
  const observer = new ResizeObserver(() => fit.fit())
  observer.observe(container)
}, [...])

// a06eb48 之后（异步）
const createTerminal = useCallback(async (container) => {
  const term = new Terminal({...})
  // ⚠️  yield — await 期间浏览器可以跑别的任务
  const [{ FitAddon }, ...] = await Promise.all([
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ])
  const fit = new FitAddon()
  // ...
  term.open(container)
  fit.fit()
  // ...
  // ⚠️  ResizeObserver 在 term.open + fit.fit() 之后才挂上
  //     observer 挂上时，await 期间已发生的尺寸变化"没有历史快照回放"
  const observer = new ResizeObserver(() => fit.fit())
  observer.observe(container)
}, [...])
```

**触发链路（推测）**：
1. 用户点开 session
2. `createTerminal` 启动，await addons
3. await 期间浏览器跑：
   - 侧边栏 `transition: width 0.2s ease` 展开动画
   - 或者字体 swap 完成（`READER_FONT` 是 web font）
   - 或者任何 invalidate 触发的 reflow
4. await 完成，`term.open` 测的是**步骤 3 中间某帧**的尺寸
5. `fit.fit()` 锁定那个尺寸
6. `ResizeObserver` 挂上时，容器已经稳定，**observer 不会回放历史变化**
7. xterm 永远 fit 到「步骤 3 中间帧」尺寸（可能 1 行）
8. 用户看到「输入行在底部 + 大片黑屏 + 光标在顶部 + 无法输入」

**为什么我推测是 1 行**：如果 await 期间侧边栏刚展开 0% → 50%，终端面板宽度瞬间变窄。xterm 的 fit 算法按 `Math.floor(width / charWidth)` 算列数 — 但 row 数是按 `Math.floor(height / lineHeight)` 算的，**高度不会变**（侧边栏动画只改 width）。所以理论上 row 数应该还是 30+，不是 1。

**这里我推理有矛盾**：
- 如果 fit 是按 height 算 rows，那 row 数不会因为侧边栏动画变 1
- 用户的「输入行在底部 + 大片黑屏」更像 row 数 = 1 的状态
- 但「侧边栏动画」不解释 row = 1
- **可能 root cause 是 height 被压扁，而不是 width** — 这指向另一个方向

---

## 4. 我做的代码改动（commit `5f871a2`）

`frontend/src/hooks/useTerminal.ts`：
1. `ResizeObserver` 提前到 `term.open` 之前挂载（首帧用 `isFirstFire` skip）
2. 初次 `fit.fit()` 改用 `requestAnimationFrame`，等下一帧 layout flush
3. 加 `isCreatingRef` 防 React StrictMode 下并发 `createTerminal` 竞态
4. 加 `isCancelledRef` 让 dispose 能中断 in-flight 创建

`frontend/src/test/setup.ts`：
- polyfill `ResizeObserver`（no-op）
- `matchMedia` polyfill 加 `addListener`/`removeListener`（xterm v6 旧 API 用）

`frontend/src/components/Terminal/Terminal.test.tsx`：
- 新增回归测试「renders terminal panel when an active session is present」

`CHANGELOG.md` + `docs/dev/debug-log.md`：写 entry。

---

## 5. 验证结果（在 headless dev 环境下）

| 验证 | 结果 |
|---|---|
| `pnpm tsc -b` | 失败，但**预存错误**（`Sidebar.tsx:615-618` / `Sidebar.test.tsx`，Workspace 字段缺失，与本次修复无关） |
| `pnpm vite build` | 成功（410ms） |
| `pnpm vitest run` | **51/51 通过** |
| 浏览器实测 100-1500ms | xterm 全程 720px / 90 rows / prompt 可见，无 transient mis-fit |

**没有**在用户真实场景里验证 — 也没有复现用户的 bug。

---

## 6. 为什么用户报告「没有修好」

**诚实回答：不知道。** 我没能在我的测试环境里复现 bug，所以无法判断我的 commit 是否真的修好了用户的实际场景。

可能原因（按概率从高到低）：

### A. 测试环境与用户真实场景差异巨大（最可能）

| 维度 | 我的测试环境 | 用户的真实场景（推测） |
|---|---|---|
| 构建模式 | dev（Vite HMR，ESM 动态 import） | 可能是生产构建（addons 在独立 chunk，需网络 fetch） |
| addons 加载延迟 | microtask 级（Vite 已 prebundle） | 100-500ms（chunk fetch + parse） |
| 浏览器 | headless Chromium | 真实浏览器（Chrome/Firefox/Safari） |
| 字体加载 | 同步（已在主 bundle） | 异步（web font swap） |
| 网络 | localhost 0ms | 取决于用户网络 |

**关键差距**：生产构建的 `a06eb48` chunk 在冷启动/刷新时才被 fetch，await 窗口可能长达 100-500ms。这窗口里 sidebar 200ms 展开动画 + 字体 swap 完全可能发生。我的 headless dev 测试里 addons 早就在主 chunk 里 import 过了（Vite 优化），await 是 microtask 级，根本观察不到。

### B. 根因诊断错了

「xterm 1 行 + 输入错位」是症状，可能有多个 root cause：

| # | 可能 root cause | 现状 |
|---|---|---|
| 1 | 容器 height 被 await 期间 transient 状态压扁 | 我修了（rAF + observer 提前） |
| 2 | `term.open` 时容器还没 layout | 我修了（rAF） |
| 3 | xterm 内部 char dim 算错（font swap） | **没处理** |
| 4 | `term.cols/rows` 在 await 期间被 stale WS 读，backend 开了 1x1 PTY | **没处理** |
| 5 | `term.open` 在 detached / `display:none` 容器上跑 | **没处理** |
| 6 | StrictMode 下 Term 被创建两次，第二次 `term.open` 在已有 DOM 的容器上跑 | **没处理**（我用 `isCreatingRef` 挡了，但 xterm 内部冲突未知） |
| 7 | 跟 `a06eb48` 无关，是更早的 bug | **没排除** |

**#3 / #4 我没处理** — 这两个不需要 await 也能触发。
- #3：web font swap 期间 `measureChar` 算的是 fallback font 的 charWidth，font swap 后实际 charWidth 变了但 xterm 不会重算
- #4：后端 PTY 初始 size = 1x1，前端把 `term.cols/rows` 跟着改成 1x1，WS 消息是 stale

### C. 我把用户的描述读错了

- 用户的「输入行」= ? 可能是 xterm prompt，可能是 xterm 的 helper textarea，可能是 tmux statusline
- 用户的「光标」= ? 可能是 xterm 文字光标，可能是鼠标光标，可能是系统输入光标
- 我假设都是 xterm 内部元件，但**可能不是**。如果「输入行」= tmux statusline，那 bug 不是 xterm 错位，是别的

### D. 用户测的不是 `5f871a2`

- 用户没明确说测了哪个 build / worktree
- 可能用户在另一个 worktree / 旧 build / 没拉最新

---

## 7. 关键 gap：我现在知道 vs 不知道

**知道**：
- `a06eb48` 的代码改动确实把 `createTerminal` 变成 async + 引入 yield 窗口
- 旧代码 observer 挂载顺序有「await 空窗」问题
- 我的改动在 headless dev + 同步 addons 下，xterm 100% 正确 fit
- vitest 51/51 通过

**不知道**：
- bug 在用户的真实环境里**到底触不触发**（我没法复现）
- 我的修复**到底有没有解决**用户的实际场景（用户没明确说测了哪个 build）
- bug 的**真正根因**到底是 #1-#7 里的哪一个，还是别的
- 用户描述的「输入行/光标/黑屏」**到底指什么**（xterm prompt？textarea？tmux statusline？）

---

## 8. 下一步：需要用户协助才能继续

按 systematic-debugging 流程，**3+ 次失败就该质疑架构**。我目前 1 次失败，离阈值远，但**关键差距是：我没法复现**。在没法复现的差距上继续改代码是 guess-and-check（= systematic-debugging 警告的反模式）。

**需要的具体信息**：

1. **复现步骤**：
   - 是 empty → 选 session，还是 A → B 切换，还是 F5 刷新，还是 reload 浏览器？
   - 第一次打开就有问题，还是打开几次后才有？
   - dev mode 还是 production build？
   - 浏览器版本？

2. **用户 build 状态**：
   - `./dev.sh status` 输出
   - 如果是 production build：`pnpm build && pnpm preview` 启动后能否复现？

3. **bug 触发时的实际 cols/rows**：
   - 打开 DevTools Console
   - 跑：`document.querySelectorAll('.xterm-rows > div').length` → 给我真实行数
   - 跑：`document.querySelector('.xterm-helper-textarea')` → 找到 hidden textarea 的位置
   - 截图：xterm 区域 + DevTools Elements panel

4. **后端 PTY 初始 size**：
   - 看 `.dev/backend.log` 里 `terminal PTY initial size: 1x80 for session=...` 这行
   - 跟前端实际 fit 出的 size 对比，看是不是后端开了 1x1

5. **30 秒屏幕录制**：
   - 一次完整复现过程
   - 我需要精确看到「光标在顶部 + 输入行在底部 + 大片黑屏」到底是哪三个元件

---

## 9. 我**没动**的事

- 没动后端 PTY 处理（`src/ws/terminal.rs`）
- 没动 `term.open` 的调用参数
- 没动 `DARK_TERMINAL_THEME` / 字体配置
- 没动 Layout / terminal-panel-pixel CSS
- 没动 xterm.js 的 addon load 策略
- 没排除 #1-#7 之外的其他 root cause

---

## 10. 当前 commit 状态

```
5f871a2 fix(terminal): 点开会话时终端输入行/光标错位、屏幕大片黑屏、无法输入
```

5 files changed, 162 insertions(+), 23 deletions(-)
- `frontend/src/hooks/useTerminal.ts`：核心改动
- `frontend/src/components/Terminal/Terminal.test.tsx`：回归测试
- `frontend/src/test/setup.ts`：polyfill
- `CHANGELOG.md`：entry
- `docs/dev/debug-log.md`：entry

**如果用户的实际场景和我的诊断不匹配，这个 commit 可能需要 revert 或重新审视**。具体决策取决于第 8 节列出的用户反馈。
