# pty 移动端 Termux 手感改造（方向稿）

> **状态**：设计稿 + 决策已部分拍板（2026-08-28 讨论，见 §9「决策记录」）。本文只定方向与决策边界，**不落具体代码**；后续会话接手后按「继续讨论入口」逐项收敛再进实施。
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
| 亚行精度 | `wheelAccumLines` 余量累积（**不足一行画面完全不动**，无像素偏移） | `viewportController.ts:174-186` | ✗ 只做到"不丢小步长"，非 Termux 的"亚行跟手" |
| **惯性** | **无**，抬手即停 | — | ✗ 缺失 |
| **触摸速度源** | **无** —— `onEnd()` 空实现，抬手时速度被丢弃 | `touchScroll.ts:59-62` | ✗ 缺失（惯性的前提，P0 第一块砖） |
| **渲染路径** | **WS 往返 + 整屏 JSON + ANSI 全屏写入** | `useTerminal.ts:265` → `useCellFrame.ts` → 后端 `vt.rs:513` | ✗ **根本差异** |
| 三路分支 | 鼠标协议放行 / alt-screen 禁用接管 / pty 接管 | `useTerminal.ts:663-673`（D1/D4） | ✓ 同构 |
| 触摸分派 | pty/tmux 共用监听，入口按 runtime 分流 | `useTerminal.ts:724` | ✓ 已分离 |
| 边界 | 硬钳制（`MAX_VIEWPORT_Y`），无回弹 | `viewportController.ts:32` | ✓ 与 Termux 同构（Termux 也无橡皮筋） |
| 键行 popup | 无 | `components/Terminal/MobileKeyBar.tsx:18-24` | ✗ 缺失 |
| 帧成本 | 整屏 cells JSON ≈ 50–120 KB（40×100，含 sgr） | `src/engine/pty/frame.rs:46-56` | ✗ 移动端 RTT 10–100ms 时成瓶颈 |
| 鼠标协议下惯性 | 直接放弃接管（`return true`），无惯性 | `useTerminal.ts:665` | △ 可接受降级（Termux 此处**仍**做惯性，见下） |
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

### 3.2 两项待实测的量化前提（2026-08-28 核查补充）

上文"根本瓶颈"在移动端比桌面严重一个量级，但**目前只有估算、没有数据**。落 P0 的同时必须补齐两组实测，它们直接决定 P1/P2/P4（预渲染窗口 + 后端按行区间供给）是否必要：

| 指标 | 估算 | 实测手段 | 用途 |
|---|---|---|---|
| 单帧体积 | 50–120 KB（40×100，每 cell `{"sgr":..,"ch":..}` 20–30 B） | 后端已有 `record_cell_frame_bytes`（`src/engine/pty/metrics.rs`，实时帧与窗口帧**共用同一计数器**（`vt.rs:497` / `vt.rs:547`），实测时须在纯滚动窗口内采样） | 判断是否需要按行区间供给（A4） |
| 移动端 RTT | 10–100 ms（WiFi/蜂窝/公网域名） | 真机 devtools 抓 `viewport_request` → 窗口帧往返 | 推翻"本地 RTT <1ms"假设 |

**假设修正**：方案 C D2 的"本地 WS RTT <1ms"（`pty-herdr-style-full-buffer-render.md` 勘误 2）只在 localhost/局域网成立。本改造目标恰是移动端（`.env.local` 的 `DOMAIN` 表明有公网部署路径），**该假设不适用于本场景**，不能作为"不做本地缓存也够快"的依据。

**鼠标协议差异（AGENTS §8）**：Termux 在鼠标协议激活时**仍驱动 Scroller**，只是改为发 wheel 码（`TerminalView.java:202-206`，按 `mouseTrackingAtStartOfFling` 分支）；我们是直接放弃接管、退化成逐事件 wheel。移动端在 vim/htop 内因此没有惯性 —— 属可接受降级，但不应误认为"对齐 Termux"。

---

## 4. 改造方向

### 方向 A：滚动手感

**目标架构：虚拟滚动窗口 + 亚行 transform**

不重造渲染器（保留 xterm.js），把滚动拆成两层：

1. **亚行部分（< 1 行）→ 纯本地 transform**
   手指移动 0.3 行时不动 xterm 内容，只做容器像素偏移（GPU 合成，零成本）。跨过整行阈值才真正更新内容。这是"跟手"的关键来源。

2. **整行部分 → 预渲染窗口 + 预取**
   xterm 渲染 `rows + K` 行（K ≈ 2 屏的预渲染区），滚动在窗口内滑动，跨过阈值才重绘窗口并预取下一屏。惯性期间由 rAF 驱动衰减动画，持续更新偏移并按位置补行。

   > **落地约束（2026-08-28 核查补充）**：xterm 视口固定 `rows` 行，多渲染 K 行的唯一实现是 **over-allocate + 裁剪**（`term.rows = 可见 + K`，容器 `overflow:hidden` 裁掉溢出部分，滚动靠 `transform`）。由此产生三个本条未写的连带成本，直接影响 A1 的 K 取值：
   > 1. **`fit` 必须按可见行数计算**，与 `useTerminal.ts:604-630` 移动端 `proposeDimensions` 覆盖逻辑冲突，须一并改；
   > 2. **跨阈值 refill = 整窗 ANSI 重写**（xterm 重新解析），成本随 K 线性增长 —— K 取 2 屏意味着一次 refill ≈ 3 倍全屏解析开销，**K 必须取小**；
   > 3. refill 的数据来源只能是后端往返或前端行缓存 —— 故 **A4/A5 不是"收益递减时才做"，而是 A2 生效的前提**。

3. **惯性（对标 Android Scroller）**
   ```
   flingDistance = velocity² / (2 × deceleration)
   duration     ≈ |velocity| / deceleration
   Termux 额外乘 SCALE = 0.25（TerminalView.java:203）
   ```
   Android `Scroller` 的减速模型为 `DECELERATION_RATE ≈ 2.358`（`ln(0.78)/ln(0.9)`）；Web 侧可用等价缓动曲线复刻。

4. **后端协议演进（取决于 §3.2 实测，非"收益递减才做"）**
   `viewport_request` 从"给一整屏"改为"给行区间"，前端按行缓存（有界 LRU）。滚动命中缓存即本地渲染、零往返。
   > **2026-08-28 核查修正**：本条是第 2 点 refill 的数据来源前提（否则 refill 仍要往返），不是末端优化。是否实施由 P0 后的实测结论决定（§9 D-2）。

**待定决策**

| # | 决策点 | 候选 | 备注 |
|---|---|---|---|
| A1 | 预渲染窗口 K 取多大 | 1 屏 / 2 屏 / 动态按滑动速度 | 内存与流畅度的取舍；refill 成本随 K 线性增长 → **实测后定，且必须取小** |
| A2 | 惯性期间是否继续请求后端 | 每帧请求 / 仅动画结束后请求一次 | 影响后端压力与动画平滑度 |
| A3 | 是否做橡皮筋回弹 | 做（iOS 习惯） / 不做（对齐 Termux 硬钳制） | ✅ **已决定：不做**（见 §6）—— 历史是硬边界，回弹给出错误暗示 |
| A4 | 后端是否改为按行区间供给 | 改 / 不改（保持整屏） | 改了才能做到"命中缓存零往返"；**是否实施取决于 §3.2 实测**（§9 D-2） |
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
| B1 | 新键行是否只服务 pty | 只 pty / pty + tmux 共用但键位不同 | ✅ **已拍板**：新建 pty 专用组件（见 §9 D-3） |
| B2 | 默认键位内容 | 对齐 Termux 默认 / 按本项目用户群重排 | 需用户拍板 |
| B3 | 配置是否暴露给用户 | 内置固定 / `~/.omniterm` 配置 / 设置页 UI | 涉及产品定位 |
| B4 | 是否支持双指缩放字号 | 保留现状 / 对齐 Termux `onScale` | 现有是否支持待确认 |
| B5 | 键行是否可折叠 | 常驻 / 可收起（省屏幕） | 移动端屏幕紧张 |

---

## 5. 分期（粗粒度，实施时再细化）

| Phase | 内容 | 独立可验证 | 依赖 |
|---|---|---|---|
| **P0** | 触摸速度采样 + 亚行 transform 偏移 + 惯性衰减（rAF） | 小步长跟手不丢像素；抬手后继续滚并减速 | 无（纯前端，不动数据模型） |
| **P1** | 惯性滚动与数据模型对齐（内容供给跟上动画） | 快速滑动时内容不空白、不滞后 | P0 + 实测结论（§3.2） |
| **P2** | 预渲染窗口 + 预取 | 快速滑动不掉帧、不空白 | P1 |
| **P3** | 键行 Termux 化（popup + 长按重复 + 配置驱动） | 上滑出第二功能；长按连续发键 | 无（可与 P1/P2 并行） |
| **P4** | 后端按行区间供给 + 前端行缓存 | 命中缓存时零往返 | P2 |

P0 单独做即能拿到大部分"跟手 + 惯性"收益，且不动后端与数据模型。P3 与滚动无关，可独立排期（已决策与 A 并行，见 §9 D-1）。

> **P1/P2/P4 是否实施取决于 §3.2 实测结论**：若实测显示移动端帧往返能跟上快速滑动，则滚动改造止于 P0；跟不上再上 P1 → P2/P4。

---

## 6. 不做的事

- **不重造终端渲染器**。Termux 自己画 canvas 是因为它本就是原生应用；本项目已有 xterm.js，改造应复用它，只在其上叠加虚拟滚动与像素偏移。
- **不改动 tmux 路径**。已分离（`af3f2c1`），tmux 保持现状 —— 它是外部会话，无法定制。
- **不引入新的重量级依赖**（如手势库 / 物理引擎）。惯性动画自实现即可（缓动曲线 + rAF），避免为"可能用到"增加抽象层（奥卡姆剃刀）。
- **不做橡皮筋回弹（A3）**。对齐 Termux 硬钳制：历史是硬边界（后端 grid 1000 行），回弹会给出"还能再拉"的错误暗示，且要引入过冲状态与动画。硬钳制已实现（`MAX_VIEWPORT_Y` + 后端 `history_size` 钳制）。
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

1. **先读 §9 决策记录** —— 范围、滚动路线、键行归属已拍板，不要重新讨论。
2. **补齐 §3.2 实测**（帧体积 + 移动端 RTT），据此决定 P1/P2/P4 是否实施。
3. **细化分期**：把上表 Phase 拆成可独立提交、可独立验证的步骤。
4. **读源码**：先读本文 §2.1 索引的 Termux 文件（本地路径可直接打开），再读本项目 `viewportController.ts` / `touchScroll.ts` / `MobileKeyBar.tsx` 现状。
5. **剩余待拍板项**：B2（默认键位内容）、B3（配置是否暴露给用户）、B4（双指缩放字号）、B5（键行可折叠）、A1（K 值，实测后定）。
6. **写实施计划**：方向收敛后，另起 `docs/dev/plans/YYYY-MM-DD-*.md` 写带 ADR 与验收清单的实施计划（本文保持为方向稿，不被实施细节污染）。

**相关文档**
- 方案 C（滚动架构现状 + Phase 3 遗留）：`docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`
- 滚轮问题根因链：`docs/dev/plans/backlog/pty-scroll-handover.md`
- pty/tmux 分离提交：`af3f2c1`
- 手动回归清单：`docs/reference/user-testing.md`
- 性能与有界红线：`docs/dev/performance-and-safety.md`

---

## 9. 决策记录（2026-08-28 讨论拍板）

### D-1 范围：滚动 + 键行并行（A + B）

两条线无耦合（滚动在 `viewportController`/`touchScroll`，键行是独立组件），各自独立提交、独立验证，一起排期推进。

### D-2 滚动路线：先落 P0 + 补齐实测，再决定是否上 A2/A4

不预先承诺"预渲染窗口 + 后端按行供给"这条重路线。顺序：

1. 落 **P0**（触摸速度采样 + 亚行 transform + 惯性衰减）—— 纯前端、不动数据模型，拿到主要跟手收益；
2. 同时补齐 **§3.2 两项实测**（帧体积、移动端真机 RTT）；
3. 按实测结论决定是否进 P1/P2/P4。

**理由**：P0 的成本远低于 A2+A4，而 A2 的收益完全取决于"内容供给是否跟不上动画"—— 先用数据回答，避免为不存在的问题付后端协议演进的代价。

### D-3 键行：新建 pty 专用组件（B1）

`MobileKeyBar` 保持服务 tmux 现状，pty 侧另起组件（命名待定，倾向 `PtyKeyBar` —— 对齐的是 runtime 而非 Termux 品牌）。

**附带约束（避免违反 AGENTS §6 禁 copy-paste）**：两个组件共用的交互逻辑 —— 修饰键 latch、长按重复调度、popup 抬手判定 —— **必须抽到共享 hook/工具，不得存在两份 `handleClick` 实现**。DOM 层的输入模式同步已是可复用 util（`utils/terminalInputMode.ts`），直接复用而非复制。测试按各自键位表单独写，不算重复。

### 顺带修复的文档漂移（2026-08-28，同批提交）

`docs/architecture/backend.md` 双引擎差异表 D12 行原写 pty 为「xterm 本地 scrollback（`scrollLines`/视口位置驱动 scrollMode）」—— 方案 C Phase 2（`af3f2c1`）后已改为后端 viewport 供给，已更正为现行行为（后端视口供给 + `ViewportController` + alt-screen/鼠标协议交回 xterm 默认路径）。

> 同类命中已排查：archive 下的历史计划与 `pty-scroll-handover.md:24`（讲 xterm 内部 `BufferService.scrollLines` 机制，属根因分析）均为历史/正确表述，未改动。
