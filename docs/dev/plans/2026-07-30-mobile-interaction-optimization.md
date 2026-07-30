# 移动端交互优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：已实施（2026-07-31，Task 1-9 全部完成；测试用例落于 user-testing.md T28-T33）
> 触发条件：用户反馈「移动端基本只有形，交互没怎么优化」；本次会话完成现状审计后立项
> 关联：`docs/dev/plans/2026-07-27-mobile-optimization.md`（Phase 1-4 已落地，Phase 5 两项由本计划吸收）、`docs/dev/plans/backlog/mobile-ux-enhancements.md`（实施完毕后清空）、`docs/superpowers/specs/2026-06-28-mobile-ux-design.md`、`docs/visual-design/ui-style-guide.md`

**Goal:** 把移动端从「布局像 App」补齐到「手势像 App」：终端手指滚动、跟手滑动切 tab、触觉反馈、横屏/效率/粘贴等 8 项交互优化。

**Architecture:** 全部改动限制在 `isMobile` 分支、移动端组件（Layout/MobileKeyBar/MobileStatusBar/MobileNav/Terminal）与新增纯函数 utils 内，桌面端零回归。可测逻辑（手势判定、滚动换算、会话循环）抽成 `utils/` 纯函数配 vitest；DOM 挂载层保持薄壳。

**Tech Stack:** React 19 + zustand 5 + xterm.js 6（tmux `mouse on` 已开，wheel 事件直达 tmux 历史滚动）+ vitest。

## Global Constraints

- **桌面端零回归**：禁止改动桌面分支行为；新工具函数不得影响现有调用方。
- **UI 规范**（`ui-style-guide.md`）：inline style 颜色一律 `var(--token)`；禁止 emoji（`⏎ ↑ ↓ ← → ^C` 属等宽符号，允许）；浮层挂 `.pixel-float`；按钮按压复用现有体系。
- **i18n**：所有新增用户可见文案 en/zh 双写（`frontend/src/locales/{en,zh}/translation.json`）。
- **禁魔法数字**：手势阈值/时长/系数一律提取为模块级命名常量。
- **每个 Task 一次提交**：`feat:` 前缀（AGENTS 核心规则 2）；提交前跑 `cd frontend && npx tsc -b && npm run lint && npm test`。
- React hooks 约定（`frontend.md`）：handler 先定义后引用、依赖数组完整、订阅必 cleanup。

---

## 1. 背景与审计

移动端骨架（三 tab 药丸导航、顶部状态栏、MobileKeyBar、safe-area、PWA）已于 2026-06 设计稿与 2026-07-27 优化计划 Phase 1-4 落地。本次审计确认的**交互缺口**：

| # | 缺口 | 严重度 | 根因/证据 |
|---|------|--------|-----------|
| 1 | 终端不能手指滚动 | 🔴 P0 | xterm v6 触摸只做手势/选择（node_modules 实证 `onTouchStart/Move` 为 Gesture 识别），不产生 wheel；现有「滚动」按钮 = tmux copy mode + 方向键翻页，反直觉。后端 `src/tmux/mod.rs:78` 已开 `mouse on`，合成 wheel 即可滚动 |
| 2 | 滑动切 tab 无跟随反馈 | 🔴 P0 | `Layout.tsx` MobileLayout：flick 手势（touchend 才判定，40px 阈值，全程零视觉反馈）；起点 24px 边缘被排除，与设置文案「边缘滑动手势」矛盾 |
| 3 | 无触觉反馈 | 🟡 P1 | backlog 已有；MobileKeyBar 按键无物理行程 |
| 4 | 横屏键盘挤出终端 | 🟡 P1 | backlog 方案 A：横屏+软键盘弹出时可视高度为负 |
| 5 | 会话切换 3 步 | 🟡 P1 | 状态栏点名 → sessions tab → 点会话；无快速通道 |
| 6 | KeyBar 缺 Enter / 一键 ^C | 🟡 P1 | `docs/dev/debug-log.md:203` 记录在案；软键盘收起（滚动模式）时无 Enter |
| 7 | 无粘贴路径 | 🟡 P1 | 移动端无 Ctrl+V/右键；长按菜单从未实现 |
| 8 | 触摸目标偏小 + 文案矛盾 | 🟢 P2 | Nav 键 32×32、KeyBar 键高 32（iOS 指南 44pt）；手势文案与实际行为不符 |

## 2. 范围与不纳入项

- **P0（Phase 1）**：Task 1 终端触摸滚动、Task 2 跟手滑动切 tab、Task 3 触觉反馈
- **P1（Phase 2）**：Task 4 横屏 KeyBar 隐藏、Task 5 状态栏滑切会话、Task 6 KeyBar Enter/^C、Task 7 长按粘贴
- **P2（Phase 3）**：Task 8 Nav 44pt + 设置文案修正

**不纳入（奥卡姆剃刀 + 风险）**：

| 排除项 | 理由 | 翻盘条件 |
|--------|------|----------|
| 全轨道预览滑动（三面板常驻横轨） | 用户已选「跟手+阻尼回弹」档；常驻隐藏态有 xterm 尺寸/轮询副作用 | 跟手档落地后用户仍要求相邻预览 |
| 触觉反馈开关（`mobileHapticEnabled`） | backlog 标「可选」；YAGNI | 有用户投诉震动 |
| 惯性滚动（momentum） | 合成 wheel 无惯性已可用；惯性需自建物理循环 | 滚动手感反馈偏「硬」 |
| 双指/三指手势 | 与浏览器/系统手势冲突面大，收益不明 | 明确需求出现 |
| 横屏 MobileNav 侧排（backlog 方案 B） | 改动大；方案 A 已覆盖核心痛点 | 方案 A 实测仍不可用 |

## 3. 设计决策（ADR）

### D1：终端滚动走「合成 wheel 事件」，而非 `term.scrollLines`

- **决策**：touch-drag → 在 touchstart target 上 dispatch `WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })`。
- **理由**：tmux mouse on 时 xterm 自身 scrollback 为空（alternate buffer），`scrollLines` 无效；桌面滚轮路径（wheel → xterm mouse 转义序列 → tmux 滚历史）是唯一已验证通路，合成事件完整复用它。xterm 内部 wheel 监听带 `{passive:false}`（node_modules 实证），bubbles 必达。
- **否决项**：`scrollLines`（alt buffer 下空转）；自绘 viewport 滚动（绕过 tmux 会撕裂状态）。
- **翻盘条件**：xterm 升级后内部 listener 结构变化导致合成事件失效 → 退回「滚动模式」按钮并重新评估。

### D2：纵向 drag 接管滚动、横向 drag 保留选择

- **决策**：方向判定带 10px slop，先动者胜；纵向一旦接管即 `preventDefault`（抑制 compat mouse events，xterm 选择不会启动）；横向直接放行给 xterm 选择。
- **理由**：终端内横向 drag = 文本选择是桌面肌肉记忆的延伸；纵向滚动是移动端第一手势。两者不可兼得，按方向分流。
- **否决项**：全部 drag 接管滚动（杀死选择）；长按启动选择（xterm 无此手势，需自研）。
- **翻盘条件**：用户反馈选择难以触发（slop 太小误判滚动）→ 调大 slop 或加「选择模式」开关。

### D3：滑动切 tab = 跟手 + 阻尼回弹，终端区排除

- **决策**：内容 wrapper `touchAction: 'pan-y'`（浏览器只管纵向滚动，横向留给 JS）；move 中 `translateX` 跟手；无相邻 tab 方向乘 0.35 阻尼；松手 ≥64px 提交切换，否则回弹。touchstart target 在 `.xterm` 内时**跳过手势**（保选择，D2）。
- **理由**：`pan-y` 用 CSS 声明手势所有权，避免 React passive listener 无法 preventDefault 的坑；终端区排除后，terminal tab 用 Nav/状态栏切换（与现状 flick 在终端可用相比是行为变化，可接受——终端内横向手势已分配给选择）。
- **否决项**：全屏含终端接管滑动（杀死选择，同 D2）；24px 边缘排除（与文案矛盾且阉割手势面积）。
- **翻盘条件**：sessions/files 列表内横向操作（未来的横向滚动表格）被误吞 → 在 axis 判定上提高横向阈值或加局部豁免 class。

### D4：滑动提交跳过 MobileContent 进出场动画

- **决策**：MobileLayout 向 MobileContent 传 `swipeCommitRef`；提交切 tab 时置位，MobileContent effect 读到后**立即切换 displayedTab**（跳过 200ms exit + enter 动画）。
- **理由**：跟手拖动已表达方向与位移，再播 slide 动画会与外层 transform 叠加出「旧内容二次滑出」的跳变。
- **否决项**：保留动画（实证跳变）；改 store 加 `tabSwitchAnim` 字段（新实体，同文件 ref 已够用）。
- **翻盘条件**：后续 MobileContent 移出 Layout.tsx → 把 ref 上提为 props 链或 store 字段。

### D5：键盘弹出检测用高度差启发式

- **决策**：`keyboardOpen = isMobile && (window.innerHeight - vvHeight) > 150`。
- **理由**：visualViewport API 是唯一跨 iOS/Android 可用的信号；150px 阈值低于所有主流软键盘高度（≥260px），高于地址栏伸缩（≤110px）。
- **否决项**：focus 事件推断（xterm textarea 常聚焦，键盘未必弹出）。
- **翻盘条件**：某 WebView `innerHeight === vvHeight` → keyboardOpen 恒 false，回退现状（KeyBar 常显），无回归。

### D6：粘贴走「长按弹菜单 → 点击触发 readText」

- **决策**：长按 500ms 弹单选项浮动菜单，点击「粘贴」才调 `navigator.clipboard.readText()`。
- **理由**：剪贴板读取需用户手势上下文，菜单点击是最稳的授权时机；长按直接读在 iOS 上每次弹系统授权条，体验差。
- **否决项**：长按直接读（授权噪音）；双击粘贴（与 xterm 双击选词冲突）。
- **翻盘条件**：iOS 仍频繁拒绝 → 改引导用户使用系统文本框粘贴。

---

## 4. 实施任务

> 执行顺序即 Task 编号序。每个 Task 独立可验证、独立提交。
> 测试统一命令（frontend/ 下）：`npm test`（vitest run）、`npx tsc -b`、`npm run lint`。

### Task 1: 终端手指滚动（touch-drag → 合成 wheel）

**Files:**
- Create: `frontend/src/utils/touchScroll.ts`
- Test: `frontend/src/utils/touchScroll.test.ts`
- Modify: `frontend/src/hooks/useTerminal.ts`（createTerminal 内挂载 + teardown 清理，参照 `mouseUpHandlerRef` 模式，useTerminal.ts:104/367-369/506）
- Modify: `frontend/src/index.css`（`.terminal-panel-pixel` 加 `touch-action: none`，放在 `.terminal-panel-pixel` 既有规则块内，约 index.css:1660 附近）

**Interfaces:**
- Consumes: xterm 6 内部 wheel 监听（`{passive:false}`，bubbles 可达）；无需 React。
- Produces: `attachTouchScroll(container: HTMLElement): () => void`（返回 detach）；`createTouchScroll(onScroll: (deltaY: number) => void)`（纯逻辑，供测试）。

- [ ] **Step 1: 写失败测试** `frontend/src/utils/touchScroll.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTouchScroll, TOUCH_SCROLL_FACTOR } from './touchScroll'

function ev(touches: Array<{ clientX: number; clientY: number }>) {
  return { touches, preventDefault: vi.fn() } as unknown as TouchEvent
}
const t = (x: number, y: number) => ({ clientX: x, clientY: y })

describe('createTouchScroll', () => {
  it('vertical drag upward emits positive deltaY scaled by factor', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    s.onMove(ev([t(100, 180)])) // dy = -20, beyond slop → axis y
    s.onMove(ev([t(100, 170)])) // dy = -10 → deltaY = 10 * factor
    expect(onScroll).toHaveBeenLastCalledWith(10 * TOUCH_SCROLL_FACTOR)
  })

  it('horizontal drag is ignored (selection preserved) and does not preventDefault', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    const moveEv = ev([t(60, 195)]) // dx dominant
    s.onMove(moveEv)
    expect(onScroll).not.toHaveBeenCalled()
    expect(moveEv.preventDefault).not.toHaveBeenCalled()
  })

  it('multi-touch is ignored', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200), t(120, 220)]))
    s.onMove(ev([t(100, 150), t(120, 170)]))
    expect(onScroll).not.toHaveBeenCalled()
  })

  it('axis resets on end; vertical scroll preventDefaults to suppress selection', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    const moveEv = ev([t(100, 150)])
    s.onMove(moveEv)
    expect(moveEv.preventDefault).toHaveBeenCalled()
    s.onEnd()
    s.onStart(ev([t(100, 200)]))
    s.onMove(ev([t(50, 200)])) // now horizontal works again
    expect(onScroll).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/utils/touchScroll.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `frontend/src/utils/touchScroll.ts`

```ts
/** Mobile touch scroll bridge for xterm.js.
 *
 *  xterm has no native touch scrolling (its touch layer only drives tap
 *  gestures and text selection). On desktop, scrolling reaches tmux via
 *  wheel events → mouse escape sequences (tmux `mouse on` is enabled
 *  server-side). This module converts vertical finger drags into synthetic
 *  WheelEvents dispatched on the original touch target, reusing that exact
 *  desktop path. Horizontal drags are left untouched so xterm's
 *  drag-to-select keeps working (see plan D2). */

/** Pixels of movement before the gesture axis is decided. */
export const AXIS_SLOP_PX = 10
/** Scroll amplification — raw pixel deltas feel sluggish vs native scroll. */
export const TOUCH_SCROLL_FACTOR = 2

export interface TouchScrollHandlers {
  onStart: (e: TouchEvent) => void
  onMove: (e: TouchEvent) => void
  onEnd: () => void
}

export function createTouchScroll(onScroll: (deltaY: number) => void): TouchScrollHandlers {
  let startX = 0
  let startY = 0
  let lastY = 0
  let tracking = false
  let axis: 'x' | 'y' | null = null

  return {
    onStart(e) {
      if (e.touches.length !== 1) {
        tracking = false
        return
      }
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastY = touch.clientY
      axis = null
      tracking = true
    },
    onMove(e) {
      if (!tracking || e.touches.length !== 1) return
      const touch = e.touches[0]
      if (!axis) {
        const dx = touch.clientX - startX
        const dy = touch.clientY - startY
        if (Math.abs(dy) >= AXIS_SLOP_PX && Math.abs(dy) > Math.abs(dx)) axis = 'y'
        else if (Math.abs(dx) >= AXIS_SLOP_PX && Math.abs(dx) > Math.abs(dy)) axis = 'x'
        else return
      }
      if (axis !== 'y') return
      // Suppress browser scroll + compatibility mouse events (selection).
      e.preventDefault()
      const delta = lastY - touch.clientY
      lastY = touch.clientY
      if (delta !== 0) onScroll(delta * TOUCH_SCROLL_FACTOR)
    },
    onEnd() {
      tracking = false
      axis = null
    },
  }
}

/** Attach the bridge to the xterm host container. Returns a detach function. */
export function attachTouchScroll(container: HTMLElement): () => void {
  let wheelTarget: EventTarget | null = null
  const handlers = createTouchScroll((deltaY) => {
    if (!wheelTarget) return
    wheelTarget.dispatchEvent(
      new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
    )
  })
  const onStart = (e: TouchEvent) => {
    wheelTarget = e.target
    handlers.onStart(e)
  }
  container.addEventListener('touchstart', onStart, { passive: true })
  container.addEventListener('touchmove', handlers.onMove, { passive: false })
  container.addEventListener('touchend', handlers.onEnd)
  container.addEventListener('touchcancel', handlers.onEnd)
  return () => {
    container.removeEventListener('touchstart', onStart)
    container.removeEventListener('touchmove', handlers.onMove)
    container.removeEventListener('touchend', handlers.onEnd)
    container.removeEventListener('touchcancel', handlers.onEnd)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/utils/touchScroll.test.ts`
Expected: 4 passed

- [ ] **Step 5: 挂载进 useTerminal**

`useTerminal.ts`：
1. 顶部 import：`import { attachTouchScroll } from '../utils/touchScroll'`
2. `mouseUpHandlerRef`（:104）旁新增：`const touchScrollCleanupRef = useRef<(() => void) | null>(null)`
3. teardown（:367-369 同一块）追加：

```ts
    if (touchScrollCleanupRef.current) {
      touchScrollCleanupRef.current()
      touchScrollCleanupRef.current = null
    }
```

4. createTerminal 内 `container.addEventListener('mouseup', handleMouseUp)` 块（:505-508）之后追加：

```ts
    // Mobile touch scroll: vertical finger drags become wheel events so
    // tmux mouse-mode scrolls history (xterm has no native touch scroll).
    touchScrollCleanupRef.current = attachTouchScroll(container)
```

`index.css` `.terminal-panel-pixel` 规则块追加一行（手势全自管：禁止浏览器默认滚动/缩放/兼容鼠标事件）：

```css
.terminal-panel-pixel {
  /* ...既有属性保持... */
  touch-action: none;
  -webkit-touch-callout: none; /* iOS 长按系统菜单让位给自定义菜单（Task 7） */
}
```

- [ ] **Step 6: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Expected: 全绿
Commit: `git add frontend/src/utils/touchScroll.* frontend/src/hooks/useTerminal.ts frontend/src/index.css && git commit -m "feat: mobile terminal touch-drag scrolling via synthetic wheel events"`

---

### Task 2: 跟手滑动切换 tab（跟手 + 阻尼回弹）

**Files:**
- Create: `frontend/src/utils/swipe.ts`
- Test: `frontend/src/utils/swipe.test.ts`
- Modify: `frontend/src/components/Layout/Layout.tsx`（MobileLayout 手势区 :311-356、MobileContent :371-418）

**Interfaces:**
- Consumes: `appStore.activeTab / setActiveTab / mobileGestureEnabled`。本 Task 不接触觉反馈——Task 3 统一接入（避免两次改同一处产生冲突）。
- Produces: `decideSwipeAxis / applyEdgeResistance / resolveSwipeCommit`（纯函数）；MobileContent 新 prop `swipeCommitRef: React.MutableRefObject<boolean>`。

- [ ] **Step 1: 写失败测试** `frontend/src/utils/swipe.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { decideSwipeAxis, applyEdgeResistance, resolveSwipeCommit, SWIPE_AXIS_SLOP_PX, SWIPE_COMMIT_PX, EDGE_RESISTANCE } from './swipe'

describe('decideSwipeAxis', () => {
  it('returns null below slop', () => {
    expect(decideSwipeAxis(5, 3)).toBeNull()
  })
  it('vertical wins when dy dominates', () => {
    expect(decideSwipeAxis(20, 40)).toBe('y')
  })
  it('horizontal wins when dx dominates', () => {
    expect(decideSwipeAxis(40, 20)).toBe('x')
  })
  it('slop threshold is exclusive boundary-safe', () => {
    expect(decideSwipeAxis(SWIPE_AXIS_SLOP_PX, 0)).toBe('x')
  })
})

describe('applyEdgeResistance', () => {
  it('passes through when neighbor exists', () => {
    expect(applyEdgeResistance(-80, true, true)).toBe(-80)
  })
  it('damps toward missing neighbor', () => {
    expect(applyEdgeResistance(80, false, true)).toBe(80 * EDGE_RESISTANCE) // prev missing
    expect(applyEdgeResistance(-80, true, false)).toBe(-80 * EDGE_RESISTANCE) // next missing
  })
})

describe('resolveSwipeCommit', () => {
  it('commits past threshold toward existing neighbor', () => {
    expect(resolveSwipeCommit(-(SWIPE_COMMIT_PX + 1), true, true)).toBe('next')
    expect(resolveSwipeCommit(SWIPE_COMMIT_PX + 1, true, true)).toBe('prev')
  })
  it('snaps back below threshold or toward missing neighbor', () => {
    expect(resolveSwipeCommit(-(SWIPE_COMMIT_PX - 1), true, true)).toBeNull()
    expect(resolveSwipeCommit(-200, true, false)).toBeNull()
    expect(resolveSwipeCommit(200, false, true)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `cd frontend && npx vitest run src/utils/swipe.test.ts` → FAIL

- [ ] **Step 3: 实现** `frontend/src/utils/swipe.ts`

```ts
/** Pure gesture math for the mobile follow-finger tab swipe (Layout.tsx).
 *  Kept DOM-free so the decision rules are unit-testable. */

/** Pixels before the gesture axis (horizontal vs vertical) is decided. */
export const SWIPE_AXIS_SLOP_PX = 12
/** Minimum horizontal displacement at touchend to commit a tab switch. */
export const SWIPE_COMMIT_PX = 64
/** Drag multiplier when there is no neighbor tab in the dragged direction. */
export const EDGE_RESISTANCE = 0.35

export type SwipeAxis = 'x' | 'y' | null

export function decideSwipeAxis(dx: number, dy: number): SwipeAxis {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (ady >= SWIPE_AXIS_SLOP_PX && ady > adx) return 'y'
  if (adx >= SWIPE_AXIS_SLOP_PX && adx > ady) return 'x'
  return null
}

/** dx > 0 drags rightward (toward previous tab); dx < 0 toward next. */
export function applyEdgeResistance(dx: number, canPrev: boolean, canNext: boolean): number {
  if (dx > 0 && !canPrev) return dx * EDGE_RESISTANCE
  if (dx < 0 && !canNext) return dx * EDGE_RESISTANCE
  return dx
}

export function resolveSwipeCommit(
  dx: number,
  canPrev: boolean,
  canNext: boolean,
): 'prev' | 'next' | null {
  if (dx <= -SWIPE_COMMIT_PX && canNext) return 'next'
  if (dx >= SWIPE_COMMIT_PX && canPrev) return 'prev'
  return null
}
```

- [ ] **Step 4: 跑测试确认通过** — 3 suites passed

- [ ] **Step 5: 改造 MobileLayout 手势区**（`Layout.tsx`）

在文件顶部 import：`import { decideSwipeAxis, applyEdgeResistance, resolveSwipeCommit } from '../../utils/swipe'`

**模块级常量**（放组件外——避免 useCallback 依赖数组引用每轮 render 新建的对象，违反 hooks 约定）：

```tsx
const TAB_ORDER: AppState['activeTab'][] = ['sessions', 'terminal', 'files']
const SWIPE_SETTLE_MS = 160
```

MobileLayout 内，删除现有 `touchStart` ref 与 `handleSwipe`，替换为：

```tsx
  const contentRef = useRef<HTMLDivElement>(null)
  const swipeCommitRef = useRef(false)
  const settlingRef = useRef(false)
  const dragRef = useRef<{ startX: number; startY: number; dx: number; axis: 'x' | 'y' | null } | null>(null)

  const settleTransform = useCallback((x: number, onDone: () => void) => {
    const el = contentRef.current
    if (!el) { onDone(); return }
    settlingRef.current = true
    el.style.transition = `transform ${SWIPE_SETTLE_MS}ms ease-out`
    el.style.transform = `translateX(${x}px)`
    window.setTimeout(() => {
      el.style.transition = ''
      el.style.transform = ''
      settlingRef.current = false
      onDone()
    }, SWIPE_SETTLE_MS)
  }, [])

  const onSwipeStart = useCallback((e: React.TouchEvent) => {
    if (settlingRef.current) return
    // Terminal area: horizontal drag is text selection (plan D2/D3).
    if ((e.target as HTMLElement).closest('.xterm')) return
    const touch = e.touches[0]
    dragRef.current = { startX: touch.clientX, startY: touch.clientY, dx: 0, axis: null }
  }, [])

  const onSwipeMove = useCallback((e: React.TouchEvent) => {
    const drag = dragRef.current
    if (!drag || !contentRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY
    if (!drag.axis) {
      drag.axis = decideSwipeAxis(dx, dy)
      if (drag.axis === 'y') dragRef.current = null // hand back to list scroll
      return
    }
    const idx = TAB_ORDER.indexOf(activeTab)
    const damped = applyEdgeResistance(dx, idx > 0, idx < TAB_ORDER.length - 1)
    drag.dx = damped
    contentRef.current.style.transform = `translateX(${damped}px)`
  }, [activeTab])

  const onSwipeEnd = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.axis !== 'x' || !contentRef.current) return
    const idx = TAB_ORDER.indexOf(activeTab)
    const canPrev = idx > 0
    const canNext = idx < TAB_ORDER.length - 1
    const commit = resolveSwipeCommit(drag.dx, canPrev, canNext)
    if (!commit) {
      settleTransform(0, () => {})
      return
    }
    const width = contentRef.current.clientWidth
    const target = commit === 'next' ? TAB_ORDER[idx + 1] : TAB_ORDER[idx - 1]
    settleTransform(commit === 'next' ? -width : width, () => {
      swipeCommitRef.current = true // MobileContent skips its slide animations (D4)
      setActiveTab(target)
    })
  }, [activeTab, setActiveTab, settleTransform])
```

容器 JSX（现 :338-359）替换为：

```tsx
        <div
          ref={contentRef}
          className="flex-1 overflow-hidden"
          style={{ touchAction: 'pan-y' }}
          onTouchStart={mobileGestureEnabled ? onSwipeStart : undefined}
          onTouchMove={mobileGestureEnabled ? onSwipeMove : undefined}
          onTouchEnd={mobileGestureEnabled ? onSwipeEnd : undefined}
          onTouchCancel={mobileGestureEnabled ? onSwipeEnd : undefined}
        >
          <MobileContent swipeCommitRef={swipeCommitRef} />
        </div>
```

- [ ] **Step 6: MobileContent 跳过动画（D4）**

签名与 effect 改为：

```tsx
function MobileContent({ swipeCommitRef }: { swipeCommitRef: React.MutableRefObject<boolean> }) {
  const activeTab = useAppStore((s) => s.activeTab)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const [displayedTab, setDisplayedTab] = useState(activeTab)
  const [animState, setAnimState] = useState<'idle' | 'exiting'>('idle')

  useEffect(() => {
    if (activeTab === displayedTab) return
    // Swipe commit: the finger already conveyed direction/distance — switch
    // instantly instead of replaying slide animations (would double-translate).
    if (swipeCommitRef.current) {
      swipeCommitRef.current = false
      setDisplayedTab(activeTab)
      setAnimState('idle')
      return
    }
    // ...既有 needsExit 分支保持原样...
  }, [activeTab, displayedTab, swipeCommitRef])
```

（其余 `getAnimation` / switch 渲染不变。）

- [ ] **Step 7: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/utils/swipe.* frontend/src/components/Layout/Layout.tsx && git commit -m "feat: follow-finger swipe tab switching with edge resistance and snap-back"`

---

### Task 3: 触觉反馈（haptics）

**Files:**
- Create: `frontend/src/utils/haptics.ts`
- Test: `frontend/src/utils/haptics.test.ts`
- Modify: `frontend/src/components/Terminal/MobileKeyBar.tsx`、`frontend/src/components/Layout/MobileNav.tsx`、`frontend/src/components/Layout/Layout.tsx`（swipe commit 处）、`frontend/src/components/Terminal/MobileKeyBar.test.tsx`

**Interfaces:**
- Produces: `hapticTap(durationMs?: number): void`。消费方：KeyBar 按键、Nav 切 tab、滑动提交、（Task 5 会话切换、Task 7 长按触发）。

- [ ] **Step 1: 写失败测试** `frontend/src/utils/haptics.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { hapticTap, HAPTIC_TAP_MS } from './haptics'

afterEach(() => vi.unstubAllGlobals())

describe('hapticTap', () => {
  it('calls navigator.vibrate with default duration', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    hapticTap()
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_TAP_MS)
  })
  it('is a silent no-op when vibrate is unsupported (iOS Safari)', () => {
    vi.stubGlobal('navigator', {})
    expect(() => hapticTap()).not.toThrow()
  })
})
```

- [ ] **Step 2: 确认失败** — `npx vitest run src/utils/haptics.test.ts` → FAIL

- [ ] **Step 3: 实现** `frontend/src/utils/haptics.ts`

```ts
/** Short vibration confirming virtual-key / gesture interactions.
 *  iOS Safari does not implement the Vibration API — the optional call is a
 *  silent no-op there. Termius uses 10ms, Blink Shell 15ms. */
export const HAPTIC_TAP_MS = 10

export function hapticTap(durationMs: number = HAPTIC_TAP_MS): void {
  try {
    navigator.vibrate?.(durationMs)
  } catch {
    /* never break interaction on haptic failure */
  }
}
```

- [ ] **Step 4: 接入三处**
  - `MobileKeyBar.tsx` `handleClick` 首行：`hapticTap()`（import 自 `../../utils/haptics`）
  - `MobileNav.tsx` tab `onClick`：`onClick={() => { hapticTap(); setActiveTab(tab.id) }}`
  - `Layout.tsx` Task 2 的 `onSwipeEnd` commit 分支：`settleTransform(...)` 之前加 `hapticTap()`

- [ ] **Step 5: 补 MobileKeyBar 测试**（在 `MobileKeyBar.test.tsx` 追加，沿用该文件既有 `setup`/`findBtn`/`teardown` createRoot 风格）

```ts
  it('fires haptic feedback on key tap', async () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const { container, root } = setup()
    const esc = await findBtn(container, 'Esc')
    esc.click()
    expect(vibrate).toHaveBeenCalled()
    vi.unstubAllGlobals()
    teardown(container, root)
  })
```

- [ ] **Step 6: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/utils/haptics.* frontend/src/components/Terminal/MobileKeyBar.* frontend/src/components/Layout/ && git commit -m "feat: haptic feedback for mobile key bar, nav and swipe commit"`

---

### Task 4: 横屏 + 软键盘弹出时隐藏 MobileKeyBar

**Files:**
- Modify: `frontend/src/hooks/useMediaQuery.ts`（新增 `useIsLandscape`）
- Modify: `frontend/src/components/Terminal/Terminal.tsx`（MobileKeyBar 渲染条件 :305）

**Interfaces:**
- Consumes: `useKeyboardHeight()`（已存在，返回 `{ vvHeight }`）。
- Produces: `useIsLandscape(): boolean`。

- [ ] **Step 1: 实现 useIsLandscape**（`useMediaQuery.ts` 追加；该 hook 为浏览器 API 订阅，无纯逻辑可抽，按项目惯例不配单测）

```ts
export function useIsLandscape() {
  const [landscape, setLandscape] = useState(
    () => window.matchMedia('(orientation: landscape)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)')
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setLandscape(e.matches)
    handler(mq)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return landscape
}
```

- [ ] **Step 2: Terminal 渲染条件**

`Terminal.tsx`：
1. import 更新：`import { useKeyboardHeight, useIsLandscape } from '../../hooks/useMediaQuery'`（如无既有 import 则新增行）
2. 组件内（`isMobile` 声明附近）：

```tsx
  const isLandscape = useIsLandscape()
  const { vvHeight } = useKeyboardHeight()
  // Heuristic (plan D5): soft keyboards are >=260px tall, browser chrome
  // shrinkage stays <=110px. Falls back to "closed" on odd WebViews.
  const KEYBOARD_OPEN_MIN_PX = 150
  const keyboardOpen = isMobile && window.innerHeight - vvHeight > KEYBOARD_OPEN_MIN_PX
  const hideKeyBar = isLandscape && keyboardOpen
```

3. 渲染处（:305）`{isMobile && (` 改为 `{isMobile && !hideKeyBar && (`。

- [ ] **Step 3: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/hooks/useMediaQuery.ts frontend/src/components/Terminal/Terminal.tsx && git commit -m "feat: auto-hide mobile key bar in landscape with soft keyboard open"`

---

### Task 5: 状态栏左右滑动切换会话

**Files:**
- Create: `frontend/src/utils/sessionNav.ts`
- Test: `frontend/src/utils/sessionNav.test.ts`
- Modify: `frontend/src/components/Layout/MobileStatusBar.tsx`（触摸手势）
- Modify: `frontend/src/components/Layout/Layout.tsx`（MobileLayout 组装排序列表 + handler）

**Interfaces:**
- Consumes: `appStore.projects / sessions / activeSessionId / activeExternalSession / activateSession`；`hapticTap`。
- Produces: `nextSessionId(orderedIds: string[], activeId: string | null, dir: 'prev' | 'next'): string | null`；MobileStatusBar 新 prop `onSwipeSession: (dir: 'prev' | 'next') => void`。

- [ ] **Step 1: 写失败测试** `frontend/src/utils/sessionNav.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { nextSessionId } from './sessionNav'

const ids = ['a', 'b', 'c']

describe('nextSessionId', () => {
  it('advances and wraps around', () => {
    expect(nextSessionId(ids, 'a', 'next')).toBe('b')
    expect(nextSessionId(ids, 'c', 'next')).toBe('a')
  })
  it('retreats and wraps around', () => {
    expect(nextSessionId(ids, 'a', 'prev')).toBe('c')
    expect(nextSessionId(ids, 'b', 'prev')).toBe('a')
  })
  it('returns null when fewer than 2 sessions', () => {
    expect(nextSessionId(['a'], 'a', 'next')).toBeNull()
    expect(nextSessionId([], null, 'next')).toBeNull()
  })
  it('starts from first when active id unknown', () => {
    expect(nextSessionId(ids, 'zzz', 'next')).toBe('a')
    expect(nextSessionId(ids, null, 'next')).toBe('a')
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现** `frontend/src/utils/sessionNav.ts`

```ts
/** Session cycling order for the mobile status-bar swipe. The caller
 *  flattens sessions in sidebar display order (projects.flatMap); this
 *  function only owns the wrap-around arithmetic. */
export function nextSessionId(
  orderedIds: string[],
  activeId: string | null,
  dir: 'prev' | 'next',
): string | null {
  if (orderedIds.length < 2) return null
  const idx = orderedIds.findIndex((id) => id === activeId)
  if (idx === -1) return orderedIds[0]
  const step = dir === 'next' ? 1 : orderedIds.length - 1
  return orderedIds[(idx + step) % orderedIds.length]
}
```

- [ ] **Step 4: 确认通过** — 4 passed

- [ ] **Step 5: MobileStatusBar 手势**

props 接口加 `onSwipeSession: (direction: 'prev' | 'next') => void`；组件内：

```tsx
const SWIPE_MIN_PX = 40
const touchStart = useRef<{ x: number; y: number } | null>(null)
```

根 div 加（import `useRef` from 'react'）：

```tsx
      onTouchStart={(e) => {
        const touch = e.touches[0]
        touchStart.current = { x: touch.clientX, y: touch.clientY }
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current
        touchStart.current = null
        if (!start) return
        const touch = e.changedTouches[0]
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return
        onSwipeSession(dx < 0 ? 'next' : 'prev')
      }}
```

- [ ] **Step 6: MobileLayout 接线**

`Layout.tsx` MobileLayout：`useAppStore()` 解构追加 `projects, activeExternalSession, activateSession`；import `nextSessionId` 与 `hapticTap`；新增：

```tsx
  const handleSwipeSession = useCallback((dir: 'prev' | 'next') => {
    if (activeExternalSession) return // external tmux sessions have no DB ordering
    const orderedIds = projects.flatMap((p) => sessions[p.id] ?? []).map((s) => s.id)
    const nextId = nextSessionId(orderedIds, activeSessionId, dir)
    if (!nextId) return
    hapticTap()
    activateSession(nextId)
  }, [projects, sessions, activeSessionId, activeExternalSession, activateSession])
```

`<MobileStatusBar ... />` 加 prop `onSwipeSession={handleSwipeSession}`。

- [ ] **Step 7: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/utils/sessionNav.* frontend/src/components/Layout/ && git commit -m "feat: swipe on mobile status bar to cycle sessions"`

---

### Task 6: MobileKeyBar 增加 Enter / ^C，键高加大 + 弹性宽度

**Files:**
- Modify: `frontend/src/components/Terminal/MobileKeyBar.tsx`
- Modify: `frontend/src/components/Terminal/Terminal.tsx`（handleKey 映射 :176-221）
- Modify: `frontend/src/components/Terminal/MobileKeyBar.test.tsx`
- Modify: `frontend/src/locales/en/translation.json`、`frontend/src/locales/zh/translation.json`（「滚动」硬编码顺手 i18n 化——局部改善）

**Interfaces:**
- Consumes: 现有 `onKey(name)` 契约；Terminal.handleKey 新增 `'Enter' | '^C'` 两个 name。
- Produces: 无新对外接口。

- [ ] **Step 1: 先写/改测试**（`MobileKeyBar.test.tsx` 追加，沿用文件既有 `setup`/`findBtn`/`teardown` 风格）

```ts
  it('emits Enter bypassing an active modifier latch', async () => {
    const { container, root, onKey } = setup()
    const ctrl = await findBtn(container, 'Ctrl')
    flushSync(() => { ctrl.click() }) // latch Ctrl
    const enter = await findBtn(container, '⏎')
    enter.click()
    expect(onKey).toHaveBeenCalledWith('Enter') // 不是 'Ctrl+Enter'
    // latch 被消费：下一键为普通键
    onKey.mockClear()
    const esc = await findBtn(container, 'Esc')
    esc.click()
    expect(onKey).toHaveBeenCalledWith('Esc')
    teardown(container, root)
  })

  it('emits ^C as a plain key', async () => {
    const { container, root, onKey } = setup()
    const cut = await findBtn(container, '^C')
    cut.click()
    expect(onKey).toHaveBeenCalledWith('^C')
    teardown(container, root)
  })
```

- [ ] **Step 2: 确认失败**（⏎/^C 不存在）→ FAIL

- [ ] **Step 3: 实现 MobileKeyBar 改动**

```tsx
const ROW1_ITEMS = ['Esc', '^C', 'Shift', 'Tab', 'PgUp', 'PgDn'] as const
const ROW2_ITEMS = ['Ctrl', 'Alt', 'Del', 'Home', 'End'] as const
/** Keys that never combine with a latched modifier — sent as-is. */
const LATCH_BYPASS_KEYS = new Set<string>(['Enter', '^C'])
```

`handleClick` 在 `if (MOD_KEYS...)` 之后、`else if (latchMod)` 之前插入：

```tsx
      } else if (LATCH_BYPASS_KEYS.has(name)) {
        if (latchMod) onSetLatchMod(null)
        onKey(name)
      }
```

布局（两行容器结构改为「左 flex 区 + 右固定簇」；`useTranslation` 引入，`滚动` 改 `t('terminal.keyScroll')`）：

```tsx
      {/* Row 1: Esc ^C Shift Tab PgUp PgDn  ·  ↑ 滚动 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          {ROW1_ITEMS.map((k) => renderBtn(k, true))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
          <button {...mobiBtnProps} key="arrow-up" onClick={() => handleClick('↑')} style={clusterKeyStyle}>↑</button>
          <button
            {...mobiBtnProps}
            key="scroll"
            onClick={() => { onToggleScrollMode() }}
            style={{
              ...clusterKeyStyle,
              minWidth: 52,
              color: scrollMode ? 'var(--accent)' : 'var(--text-muted)',
              background: scrollMode ? 'rgba(167,139,250,0.10)' : 'var(--bg-surface)',
            }}
          >
            {t('terminal.keyScroll')}
          </button>
        </div>
      </div>
      {/* Row 2: Ctrl Alt Del Home End  ·  ← ↓ → ⏎ */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          {ROW2_ITEMS.map((k) => renderBtn(k, true))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
          <button {...mobiBtnProps} key="arrow-left" onClick={() => handleClick('←')} style={clusterKeyStyle}>←</button>
          <button {...mobiBtnProps} key="arrow-down" onClick={() => handleClick('↓')} style={clusterKeyStyle}>↓</button>
          <button {...mobiBtnProps} key="arrow-right" onClick={() => handleClick('→')} style={clusterKeyStyle}>→</button>
          <button {...mobiBtnProps} key="enter" onClick={() => handleClick('Enter')} style={clusterKeyStyle}>⏎</button>
        </div>
      </div>
```

`renderBtn` 完整替换为：

```tsx
  const renderBtn = (k: string, fluid = false) => (
    <button
      key={k}
      {...mobiBtnProps}
      onClick={() => handleClick(k)}
      style={{
        ...(isModKey(k) ? modBtnStyle(k) : keyButtonStyle),
        ...(fluid ? { flex: 1, minWidth: 0 } : {}),
      }}
    >
      {k}
    </button>
  )
```

样式常量：

```tsx
const keyButtonStyle: React.CSSProperties = {
  minWidth: 36,          // was 40 — 配合 flex 布局收窄（纵向触摸目标由 minHeight 保障）
  minHeight: 36,         // was 32 — 加大触摸目标（P2 #8 合并于此）
  padding: '0 8px',
  borderRadius: 5,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-surface)',
  color: 'var(--text-secondary)',
  fontFamily: READER_FONT,
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 0.08s ease, filter 0.08s ease',
}

const clusterKeyStyle: React.CSSProperties = {
  ...keyButtonStyle,
  flexShrink: 0,
}
```

（`keyButtonStyle` 原有 `minWidth: 40, minHeight: 32` 两行按上表替换，其余字段不动。）

- [ ] **Step 4: Terminal.handleKey 映射**（`Terminal.tsx` 非组合 switch 内追加两个 case）

```tsx
      case 'Enter':
        sendData('\r')
        break
      case '^C':
        sendData('\x03')
        break
```

- [ ] **Step 5: i18n** — en: `"terminal.keyScroll": "SCROLL"`；zh: `"terminal.keyScroll": "滚动"`

- [ ] **Step 6: 跑测试 + 门禁 + 提交**

Run: `cd frontend && npx vitest run src/components/Terminal/MobileKeyBar.test.tsx && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/components/Terminal/ frontend/src/locales/ && git commit -m "feat: add Enter and one-tap Ctrl+C to mobile key bar, larger key targets"`

---

### Task 7: 长按终端弹出粘贴菜单

**Files:**
- Modify: `frontend/src/components/Terminal/Terminal.tsx`
- Modify: `frontend/src/locales/en/translation.json`、`frontend/src/locales/zh/translation.json`
- Modify: `frontend/src/index.css`（如需菜单专用样式；优先复用 `.pixel-float`）

**Interfaces:**
- Consumes: `sendData`（useTerminal 返回）、`useToastStore`、`hapticTap`。
- Produces: 无对外接口。

- [ ] **Step 1: 长按检测 + 菜单状态**（`Terminal.tsx`）

import 追加：`useToastStore`（`../../stores/toastStore`）、`hapticTap`。组件内：

```tsx
  const [pasteMenu, setPasteMenu] = useState<{ x: number; y: number } | null>(null)
  const longPressTimer = useRef<number | null>(null)
  const longPressStart = useRef<{ x: number; y: number } | null>(null)
  const LONG_PRESS_MS = 500
  const LONG_PRESS_CANCEL_PX = 10

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handlePaste = useCallback(async () => {
    setPasteMenu(null)
    try {
      const text = await navigator.clipboard.readText()
      if (text && sendData) sendData(text)
    } catch {
      useToastStore.getState().addToast('error', t('terminal.pasteFailed'))
    }
  }, [sendData, t])

  const onTermTouchStart = (e: React.TouchEvent) => {
    if (!isMobile) return
    const touch = e.touches[0]
    longPressStart.current = { x: touch.clientX, y: touch.clientY }
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => {
      const start = longPressStart.current
      if (!start) return
      hapticTap()
      // Clamp inside viewport: menu is ~120x44px.
      setPasteMenu({
        x: Math.min(start.x, window.innerWidth - 128),
        y: Math.max(8, start.y - 52),
      })
    }, LONG_PRESS_MS)
  }

  const onTermTouchMove = (e: React.TouchEvent) => {
    const start = longPressStart.current
    if (!start) return
    const touch = e.touches[0]
    if (Math.abs(touch.clientX - start.x) > LONG_PRESS_CANCEL_PX ||
        Math.abs(touch.clientY - start.y) > LONG_PRESS_CANCEL_PX) {
      cancelLongPress()
    }
  }
```

挂载点：`.terminal-panel-pixel` 那个 div（:265）加 `onTouchStart={onTermTouchStart} onTouchMove={onTermTouchMove} onTouchEnd={cancelLongPress} onTouchCancel={cancelLongPress}`。组件卸载清理：既有 useEffect 体系外加

```tsx
  useEffect(() => cancelLongPress, [cancelLongPress])
```

- [ ] **Step 2: 菜单 JSX**（Terminal return 内、`.terminal-panel-pixel` div 之后）

```tsx
      {pasteMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={() => setPasteMenu(null)}
            onTouchStart={() => setPasteMenu(null)}
          />
          <div
            className="pixel-float"
            style={{
              position: 'fixed',
              left: pasteMenu.x,
              top: pasteMenu.y,
              zIndex: 200,
              background: 'var(--bg-elevated)',
            }}
          >
            <button
              type="button"
              onClick={handlePaste}
              style={{
                padding: '10px 18px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                fontFamily: 'var(--reader-font)',
                fontSize: 13,
              }}
            >
              {t('terminal.paste')}
            </button>
          </div>
        </>
      )}
```

- [ ] **Step 3: i18n** — en: `"terminal.paste": "Paste"`, `"terminal.pasteFailed": "Unable to read clipboard"`；zh: `"terminal.paste": "粘贴"`, `"terminal.pasteFailed": "无法读取剪贴板"`

- [ ] **Step 4: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/components/Terminal/Terminal.tsx frontend/src/locales/ frontend/src/index.css && git commit -m "feat: long-press paste menu on mobile terminal"`

---

### Task 8: MobileNav 触摸目标 44pt + 设置手势文案修正

**Files:**
- Modify: `frontend/src/components/Layout/MobileNav.tsx`
- Modify: `frontend/src/locales/en/translation.json`、`frontend/src/locales/zh/translation.json`

- [ ] **Step 1: MobileNav 尺寸**

`nav` 容器 `gap: 40` → `gap: 24`，`padding: '5px 32px'` → `'6px 24px'`；按钮 `width: 32, height: 32` → `width: 44, height: 44`，`borderRadius: 6` → `borderRadius: 8`；图标 `width={18} height={18}` → `width={20} height={20}`。

- [ ] **Step 2: 文案**（与 D3 行为对齐——内容区滑动，终端内横向为选择）

en/translation.json:
```json
"settings.mobileGesture": "Swipe gestures",
"settings.mobileGestureHint": "Swipe left/right on the content area to switch tabs (horizontal drag inside the terminal selects text)",
```
zh/translation.json:
```json
"settings.mobileGesture": "滑动手势",
"settings.mobileGestureHint": "在内容区左右滑动切换标签页（终端内横向拖动为选择文本）",
```

- [ ] **Step 3: 门禁 + 提交**

Run: `cd frontend && npx tsc -b && npm run lint && npm test`
Commit: `git add frontend/src/components/Layout/MobileNav.tsx frontend/src/locales/ && git commit -m "feat: enlarge mobile nav tap targets to 44pt, fix swipe gesture copy"`

---

### Task 9: 文档闭环（无代码）

**Files:**
- Modify: `CHANGELOG.md`（综合条目一条）
- Modify: `docs/architecture/frontend.md`（utils/hooks 清单）
- Modify: `docs/dev/plans/backlog/mobile-ux-enhancements.md`（两项已落地，清空为「已吸收」）
- Modify: `docs/reference/user-testing.md`（§7 移动端新增手动用例）
- Modify: `AGENTS.md` 文档索引（登记本计划，ADR D1-D6 供后续移动端手势/终端触摸开发参照）
- Modify: 本计划状态 → `已实施`

- [ ] **Step 1: CHANGELOG**（格式沿用既有版本段；放当前版本 `Unreleased`/最新段）

```markdown
### Mobile（交互优化）
- 终端支持手指拖动滚动（合成滚轮事件直达 tmux 历史），纵向滚动/横向选择自动分流
- 标签页切换改为跟手滑动：边缘阻尼、松手提交/回弹，终端区域排除以保留文本选择
- 虚拟按键、导航切换、会话切换增加触觉反馈（Android）
- 横屏 + 软键盘弹出时自动隐藏虚拟键栏
- 顶部状态栏左右滑动快速切换会话
- 虚拟键栏新增 Enter 与一键 ^C，按键触摸目标加大
- 长按终端弹出粘贴菜单
- 底部导航触摸目标加大至 44pt
```

- [ ] **Step 2: frontend.md** `utils/` 行追加 `touchScroll.ts`（触摸滚动桥）、`swipe.ts`（手势判定）、`haptics.ts`（震动）、`sessionNav.ts`（会话循环）；hooks 行 `useMediaQuery.ts` 描述追加 `+ useIsLandscape/useKeyboardHeight`。

- [ ] **Step 3: backlog 清空** — `mobile-ux-enhancements.md` 全文替换为：

```markdown
# 移动端体验增强（已吸收）

> 原 P2 两项（触觉反馈、横屏 KeyBar 自动隐藏）已于 2026-07-30 由
> `docs/dev/plans/2026-07-30-mobile-interaction-optimization.md` 落地。本文件保留作追溯。
```

- [ ] **Step 4: user-testing.md §7 追加用例**

```markdown
| T21 | 终端触摸滚动 | 移动端终端区单指纵向拖动 | 终端内容滚动（tmux 历史）；横向拖动仍为选择 |
| T22 | 跟手滑动切 tab | 内容区（非终端）横向往返拖动 <64px | 面板跟手，松手回弹原 tab |
| T23 | 滑动提交切 tab | 内容区横向拖动 ≥64px 松手 | 切换相邻 tab，无二次滑出动画 |
| T24 | 状态栏滑切会话 | 顶部状态栏左右滑动 | 按侧栏顺序循环切换会话，状态栏名即时更新 |
| T25 | 横屏键盘 | 横屏弹出软键盘 | KeyBar 自动隐藏，终端可视区最大化 |
| T26 | 长按粘贴 | 终端区长按 0.5s → 点「粘贴」 | 剪贴板文本注入终端 |
```

- [ ] **Step 5: AGENTS.md 文档索引追加一行**（参照 `2026-07-30-ui-polish.md` 既有行格式）：

```markdown
| `docs/dev/plans/2026-07-30-mobile-interaction-optimization.md` | 修改移动端手势（滑动切 tab/触摸滚动/长按）、MobileKeyBar、状态栏交互前参考其 ADR（D1-D6） | ADR 决策被推翻或翻盘条件触发时更新 |
```

- [ ] **Step 6: 提交** — `git add CHANGELOG.md docs/ AGENTS.md && git commit -m "docs: mobile interaction optimization changelog and doc closure"`

---

## 5. 验收清单（全部 Task 完成后）

- [ ] `cd frontend && npx tsc -b && npm run lint && npm test` 全绿
- [ ] 桌面端（>768px）零回归：滚轮滚动、文本选择、右键、Sidebar/RightPanel 行为不变
- [ ] 移动端 390px 视口手动回归：`docs/reference/user-testing.md` §7 全部用例（含新增 T21-T26）
- [ ] iOS Safari + Android Chrome 各验一遍 T21/T22/T26（触摸路径差异最大处）
- [ ] 亮/暗双主题下粘贴菜单、KeyBar 新键视觉符合 `ui-style-guide.md` §14 checklist
- [ ] `grep -rn "font-family:" frontend/src --include="*.css" --include="*.tsx" | grep -v "var(--"` 无新增违规

## 6. 风险与降级

| 风险 | 影响 | 缓解/兜底 |
|------|------|-----------|
| 合成 wheel 与 xterm 内部实现耦合 | 滚动失效 | bubbles dispatch 不依赖具体监听元素；失效则退回「滚动」按钮路径（保留） |
| `touch-action: none` 禁用终端区捏合缩放 | 无法 pinch 放大终端 | 产品接受：字号有移动端独立设置（mobileFontSize 12-20） |
| keyboardOpen 启发式个别 WebView 失效 | KeyBar 不隐藏 | 回退现状，无回归（D5） |
| 滑动切 tab 误吞列表横向交互 | sessions/files 列表横滑 | axis 判定垂直优先；浏览器 `pan-y` 先拿纵向；出现真实冲突再加豁免 class |
| iOS 剪贴板授权每次弹窗 | 粘贴多一次确认 | 系统行为不可绕；失败路径 toast 引导（D6） |
| MobileContent ref 跳过动画逻辑腐化 | 动画错乱 | D4 翻盘条件：组件移出同文件时上提为 props/store |

## 7. 术语表

| 术语 | 含义 |
|------|------|
| 合成 wheel | JS `new WheelEvent` 派发到 DOM，复用 xterm→tmux 桌面滚动通路 |
| 跟手 / follow-finger | 拖动中内容实时 `translateX` 跟随手指位移 |
| 阻尼回弹 | 无相邻 tab 方向位移 ×0.35；松手未达阈值 transition 归位 |
| latch | MobileKeyBar 修饰键（Ctrl/Shift/Alt）单击锁定、下一键消费的一次性状态 |
| slop | 手势方向判定前的最小位移死区 |
