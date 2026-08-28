# pty 移动端 Termux 手感改造（方向稿）

> **状态**：设计稿（2026-08-28）。本文只定方向与决策边界，**不落具体代码**；后续会话接手后按「继续讨论入口」逐项收敛再进实施。
> **触发条件**：pty 移动端手感改造（滚动 + 底部键行）。前置条件已具备 —— `af3f2c1` 完成 pty/tmux 滚动状态分离，pty 侧可独立演进且不影响 tmux。
> **关联**：
> - `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（方案 C，滚动架构现状与 Phase 3 遗留）
> - `docs/dev/plans/backlog/pty-scroll-handover.md`（滚轮问题根因链，方案 B 已撤销）
> - `docs/reference/user-testing.md`（改造后的手动回归入口）
>
> **不进 AGENTS.md 索引**：本文是方向稿 + 长期跟踪项，索引会污染主索引表。接手路径见文末「继续讨论入口」。

---

## 1. 背景：为什么现在才能做

历史上 pty 与 tmux 共用同一套滚动状态（`scrollMode`）与触摸回调，任何 pty 侧改动都可能波及 tmux。tmux 是外部会话（无法改其源码），只能围绕它做妥协 —— 当前底部键行就是这套妥协的产物。

`af3f2c1` 之后：

| 已分离 | pty 侧 | tmux 侧 |
|---|---|---|
| 滚动状态 | `ptyScrollMode`（ViewportController 驱动） | `tmuxScrollMode` + `tmuxScrollModeRef`（copy-mode 驱动） |
| 翻页 | `ViewportController.pageScroll()` | 发 `Ctrl+B [` + PageUp/Down |
| 退出滚动 | `scrollToLive()` | 发 `Esc` |
| 触摸回调 | 不维护本地状态 | 维护 copy-mode 标志 |

**结论**：pty 现在是可深度定制的自有实现（后端 VT grid 在我们手里），不必再迁就 tmux 的约束。这是本改造的前提。

---

## 2. 目标：Termux 手感是什么

「手感」在本项目中拆成两件事：**滚动物理感** 与 **键行交互密度**。二者都需对齐 Termux，且只作用于 pty。

### 2.1 Termux 源码索引（本地可读）

仓库：`/home/pax/coding/research/termux-app`（以下路径相对该目录）

**滚动**（`terminal-view` 模块）

| 关注点 | 文件:行 | 说明 |
|---|---|---|
| 滚动状态 | `terminal-view/src/main/java/com/termux/view/TerminalView.java:70` | `int mTopRow` —— 唯一状态，负值 = 看历史，0 = live |
| 亚行余量 | `TerminalView.java:84,180-183` | `mScrollRemainder` 累积不足一行的像素，保证像素级精度 |
| 惯性 | `TerminalView.java:81,197-230` | `Scroller mScroller` + `onFling` 里 `fling(0, mTopRow, 0, -(int)(velocityY * SCALE), 0, 0, -activeTranscriptRows, 0)`；`SCALE = 0.25` |
| 惯性驱动 | `TerminalView.java:210-227` | `post(Runnable)` 自递归，每帧 `computeScrollOffset()` → `doScroll(diff)` |
| 三路分支 | `TerminalView.java:574-589` | `doScroll()`：鼠标协议 → 发 wheel 码；alt-screen → 发方向键；否则本地滚 `mTopRow` + `invalidate()` |
| 本地渲染 | `terminal-view/.../TerminalRenderer.java:57-73` | `render(mEmulator, canvas, topRow, ...)` —— 按 `topRow` 逐行绘制本地缓冲 |
| 手势识别 | `terminal-view/.../GestureAndScaleRecognizer.java:44-75` | `onFling` / `onLongPress` / `onDoubleTap` / `onScale`（双指缩放字号） |

**键行**（`termux-shared` 模块）

| 关注点 | 文件:行 | 说明 |
|---|---|---|
| 配置语法 | `termux-shared/.../extrakeys/ExtraKeysInfo.java:20-88` | JSON array-of-arrays；支持 `key` / `macro` / `popup` / `display` |
| 长按重复 | `termux-shared/.../extrakeys/ExtraKeysConstants.java:13-16` | `PRIMARY_REPETITIVE_KEYS = [UP,DOWN,LEFT,RIGHT,BKSP,DEL,PGUP,PGDN]` |
| 键码表 | `ExtraKeysConstants.java:21-49` | `ESC/TAB/HOME/END/PGUP/PGDN/INS/DEL/BKSP/方向/ENTER/F1-F12` |
| 交互 | `termux-shared/.../extrakeys/ExtraKeysView.java:422-470` | 按下变色 + 启动长按调度；上滑出按钮（`event.getY() < 0`）触发 popup；抬手判定 popup vs 普通点击 |
| 修饰键 | `termux-shared/.../extrakeys/SpecialButton.java` | `CTRL / ALT / SHIFT / FN`（latch 语义） |
| 文本选择 | `terminal-view/.../textselection/TextSelectionCursorController.java` | 长按 → 选区手柄 |

**配置示例**（`ExtraKeysInfo.java:45-63`）

```
# 单行
[[ESC, TAB, CTRL, ALT, {key: '-', popup: '|'}, DOWN, UP]]

# 双行（含 popup 与 macro）
[[{key: ESC,  popup: {macro: "CTRL f d", display: "tmux exit"}},
  {key: CTRL, popup: {macro: "CTRL f BKSP", display: "tmux ←"}},
  {key: LEFT, popup: HOME},
  {key: UP,   popup: PGUP},
  {key: RIGHT,popup: END}]]
```

### 2.2 Termux 手感要素提炼

| 要素 | Termux 做法 | 手感贡献 |
|---|---|---|
| 单一滚动状态 | `mTopRow` 整数行 | 状态简单、无坐标映射歧义 |
| 亚行精度 | `mScrollRemainder` 余量累积 | 像素级跟手，小步长不丢 |
| 惯性 | `Scroller.fling`（速度 ×0.25）+ 每帧驱动 | 抬手后继续滚并减速 |
| 本地渲染 | 改 int → `invalidate()` → canvas 重绘 | **零 IO、零序列化** |
| 三路分支 | 鼠标协议 / alt-screen 转方向键 / 本地历史 | 应用内滚动不冲突 |
| 键行 popup | 上滑出一键的第二功能 | 键位密度翻倍 |
| 长按重复 | 8 个键长按连续发 | 连续操作不连点 |
| 修饰键 latch | CTRL/ALT/SHIFT/FN | 单手组合键 |

---

## 3. 现状差距

对照上表，pty 侧现状（`frontend/src/`）：

| 要素 | 现状 | 位置 | 差距 |
|---|---|---|---|
| 单一滚动状态 | `ViewportController.currentY` | `utils/viewportController.ts` | ✓ 同构 |
| 亚行精度 | `wheelAccumLines` 余量累积 | `viewportController.ts:174-186` | ✓ 同构（与 `mScrollRemainder` 同一思路） |
| **惯性** | **无**，抬手即停 | — | ✗ 缺失 |
| **渲染路径** | **WS 往返 + 整屏 JSON + ANSI 全屏写入** | `useTerminal.ts:265` → `useCellFrame.ts` → 后端 `vt.rs:513` | ✗ **根本差异** |
| 三路分支 | 鼠标协议放行 / alt-screen 禁用接管 / pty 接管 | `useTerminal.ts:663-673`（D1/D4） | ✓ 同构 |
| 触摸分派 | pty/tmux 共用监听，入口按 runtime 分流 | `useTerminal.ts:724` | ✓ 已分离 |
| 边界 | 硬钳制（`MAX_VIEWPORT_Y`），无回弹 | `viewportController.ts:32` | ✓ 与 Termux 同构（Termux 也无橡皮筋） |
| 键行 popup | 无 | `components/Terminal/MobileKeyBar.tsx:18-24` | ✗ 缺失 |
| 长按重复 | 无（仅终端区长按 = 菜单） | `hooks/useLongPress.ts` | ✗ 缺失 |
| 修饰键 latch | 有（Shift/Ctrl/Alt） | `MobileKeyBar.tsx:18` | ✓ 同构 |

### 3.1 根本瓶颈（决定架构路线，非调参可解）

```
Termux：mTopRow += 1; invalidate();          // 改一个 int + 本地重绘，零 IO
我们：  ws.send({type:'viewport_request', y})  // 一次往返（useTerminal.ts:147）
       → 后端 encode_viewport_frame（rows×cols cells 的 JSON，vt.rs:513）
       → 前端 renderCellFrame（整屏 ANSI 写入，useCellFrame.ts:105）
```

滚动 1 行的成本：Termux 是"改一个 int"；我们是"一次网络往返 + 整屏重编码 + 整屏 ANSI 解析"。**在"后端供给整屏视口"的模型下，手感存在天花板** —— 无论怎么调节流参数，快速滑动都会等后端。

因此改造方向必须让**滚动的绝大部分变成纯本地操作**。

---

## 4. 改造方向

### 方向 A：滚动手感

**目标架构：虚拟滚动窗口 + 亚行 transform**

不重造渲染器（保留 xterm.js），把滚动拆成两层：

1. **亚行部分（< 1 行）→ 纯本地 transform**
   手指移动 0.3 行时不动 xterm 内容，只做容器像素偏移（GPU 合成，零成本）。跨过整行阈值才真正更新内容。这是"跟手"的关键来源。

2. **整行部分 → 预渲染窗口 + 预取**
   xterm 渲染 `rows + K` 行（K ≈ 2 屏的预渲染区），滚动在窗口内滑动，跨过阈值才重绘窗口并预取下一屏。惯性期间由 rAF 驱动衰减动画，持续更新偏移并按位置补行。

3. **惯性（对标 Android Scroller）**
   ```
   flingDistance = velocity² / (2 × deceleration)
   duration     ≈ |velocity| / deceleration
   Termux 额外乘 SCALE = 0.25（TerminalView.java:203）
   ```
   Android `Scroller` 的减速模型为 `DECELERATION_RATE ≈ 2.358`（`ln(0.78)/ln(0.9)`）；Web 侧可用等价缓动曲线复刻。

4. **后端协议演进（可选，收益递减时才做）**
   `viewport_request` 从"给一整屏"改为"给行区间"，前端按行缓存（有界 LRU）。滚动命中缓存即本地渲染、零往返。

**待定决策**

| # | 决策点 | 候选 | 备注 |
|---|---|---|---|
| A1 | 预渲染窗口 K 取多大 | 1 屏 / 2 屏 / 动态按滑动速度 | 内存与流畅度的取舍 |
| A2 | 惯性期间是否继续请求后端 | 每帧请求 / 仅动画结束后请求一次 | 影响后端压力与动画平滑度 |
| A3 | 是否做橡皮筋回弹 | 做（iOS 习惯） / 不做（对齐 Termux 硬钳制） | Termux 无回弹；移动端用户可能期待 |
| A4 | 后端是否改为按行区间供给 | 改 / 不改（保持整屏） | 改了才能做到"命中缓存零往返" |
| A5 | 前端行缓存上界 | 1000 / 5000 行 | 需符合性能红线（有界 + 淘汰策略 + 单测） |

### 方向 B：底部键行 Termux 化

**定位**：当前 `MobileKeyBar` 是 tmux 时代的妥协产物（围绕无法改动的 tmux 设计）。pty 是自有实现，键行应重新设计。

**要引入的 Termux 特性**（按价值排序）

1. **popup（上滑出第二功能）** —— 键位密度翻倍，是 Termux 键行最精髓的设计
   - 例：`-` 上滑 = `|`；`↑` 上滑 = `PgUp`；`ESC` 上滑 = 自定义 macro
2. **长按重复** —— 8 个键（`UP/DOWN/LEFT/RIGHT/BKSP/DEL/PGUP/PGDN`）长按连续发
3. **macro** —— 一键发键序列
4. **FN 键** —— 第四修饰键（现有 Shift/Ctrl/Alt）
5. **配置驱动** —— 键位从硬编码数组改为 JSON 配置（对齐 `ExtraKeysInfo` 语法），为后续用户自定义铺路
6. **haptic feedback** —— 按键震动（项目已有 `utils/haptics.ts`）

**待定决策**

| # | 决策点 | 候选 | 备注 |
|---|---|---|---|
| B1 | 新键行是否只服务 pty | 只 pty / pty + tmux 共用但键位不同 | 用户已明确：pty 深度定制、tmux 保持现状 → 倾向前者 |
| B2 | 默认键位内容 | 对齐 Termux 默认 / 按本项目用户群重排 | 需用户拍板 |
| B3 | 配置是否暴露给用户 | 内置固定 / `~/.omniterm` 配置 / 设置页 UI | 涉及产品定位 |
| B4 | 是否支持双指缩放字号 | 保留现状 / 对齐 Termux `onScale` | 现有是否支持待确认 |
| B5 | 键行是否可折叠 | 常驻 / 可收起（省屏幕） | 移动端屏幕紧张 |

---

## 5. 分期（粗粒度，实施时再细化）

| Phase | 内容 | 独立可验证 | 依赖 |
|---|---|---|---|
| **P1** | 惯性滚动 + 亚行 transform 偏移 | 滑一下能感到"惯性"；小步长跟手不丢 | 无（纯前端） |
| **P2** | 预渲染窗口 + 预取 | 快速滑动不掉帧、不空白 | P1 |
| **P3** | 键行 Termux 化（popup + 长按重复 + 配置驱动） | 上滑出第二功能；长按连续发键 | 无（可与 P1/P2 并行） |
| **P4** | 后端按行区间供给 + 前端行缓存 | 命中缓存时零往返 | P2 |

P1 单独做即能拿到大部分滚动手感收益，且不动后端。P3 与滚动无关，可独立排期。

---

## 6. 不做的事

- **不重造终端渲染器**。Termux 自己画 canvas 是因为它本就是原生应用；本项目已有 xterm.js，改造应复用它，只在其上叠加虚拟滚动与像素偏移。
- **不改动 tmux 路径**。已分离（`af3f2c1`），tmux 保持现状 —— 它是外部会话，无法定制。
- **不引入新的重量级依赖**（如手势库 / 物理引擎）。惯性动画自实现即可（缓动曲线 + rAF），避免为"可能用到"增加抽象层（奥卡姆剃刀）。
- **本阶段不做桌面端**。改造范围限定移动端（触摸 + 键行），桌面滚轮语义保持不变。

---

## 7. 风险与红线

| 风险 | 缓解 |
|---|---|
| 前端行缓存无界增长 | 必须显式上界 + 淘汰策略 + 单测（AGENTS 技术债红线 §6、`docs/dev/performance-and-safety.md` §P1） |
| 预渲染窗口增大内存与首帧成本 | K 值需实测；提供降级（低内存设备缩小 K） |
| 惯性动画与后端帧到达时序冲突 | 明确"本地偏移"与"服务端内容"的校正时机，避免视觉跳变 |
| 改造期间 pty 与 tmux 再次耦合 | 复用 `af3f2c1` 的分离边界；任何跨 runtime 的状态写入视为回归 |

---

## 8. 继续讨论入口

新会话接手时，按此顺序收敛：

1. **确认范围**：只做滚动（方向 A），还是滚动 + 键行（A + B）一起？
2. **拍板待定决策**：优先 A3（橡皮筋）、A4（后端是否按行供给）、B1/B2（键行归属与默认键位）—— 这四项决定工作量量级。
3. **细化分期**：把上表 Phase 拆成可独立提交、可独立验证的步骤。
4. **读源码**：先读本文 §2.1 索引的 Termux 文件（本地路径可直接打开），再读本项目 `viewportController.ts` / `MobileKeyBar.tsx` 现状。
5. **写实施计划**：方向收敛后，另起 `docs/dev/plans/YYYY-MM-DD-*.md` 写带 ADR 与验收清单的实施计划（本文保持为方向稿，不被实施细节污染）。

**相关文档**
- 方案 C（滚动架构现状 + Phase 3 遗留）：`docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`
- 滚轮问题根因链：`docs/dev/plans/backlog/pty-scroll-handover.md`
- pty/tmux 分离提交：`af3f2c1`
- 手动回归清单：`docs/reference/user-testing.md`
- 性能与有界红线：`docs/dev/performance-and-safety.md`
