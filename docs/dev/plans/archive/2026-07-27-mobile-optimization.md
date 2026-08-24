# 移动端体验优化计划

> 状态：已归档（Phase 1-4 全部落地，Phase 5 跟踪项见 `docs/dev/plans/backlog/mobile-ux-enhancements.md`）
> 触发条件：2026-07-27 全面审查移动端实现，发现性能遗留、Safe Area 缺失、PWA 缺位等问题
> 关联：`docs/superpowers/specs/2026-06-28-mobile-ux-design.md`（移动端 UX 设计稿）、`docs/visual-design/ui-style-guide.md`

---

## 1. 背景

### 1.1 审查范围

对以下移动端核心文件进行逐行审查：

| 文件 | 职责 |
|------|------|
| `frontend/src/hooks/useMediaQuery.ts` | 移动检测 + 键盘高度追踪 |
| `frontend/src/components/Layout/Layout.tsx` (MobileLayout) | 移动端主布局、滑动手势 |
| `frontend/src/components/Layout/MobileNav.tsx` | 底部 Tab 导航栏 |
| `frontend/src/components/Layout/MobileStatusBar.tsx` | 顶部状态栏 |
| `frontend/src/components/Terminal/MobileKeyBar.tsx` | 终端虚拟按键栏 |
| `frontend/src/stores/appStore.ts` | isMobile / activeTab / mobileFontSize 等状态 |
| `frontend/index.html` | viewport meta |

### 1.2 审查结论摘要

| # | 问题 | 严重度 | 类别 |
|---|------|--------|------|
| 1 | `useKeyboardHeight` 遗留 `console.log` 在每次 viewport 事件触发 | 🔴 高 | 性能 |
| 2 | 未处理 Safe Area（刘海屏 / Home Indicator 遮挡） | 🔴 高 | 兼容性 |
| 3 | `useKeyboardHeight` 维护未消费的 state，触发多余 re-render | 🟡 中 | 性能 |
| 4 | 缺少 `overscroll-behavior: none`，pull-to-refresh 干扰终端操作 | 🟡 中 | 体验 |
| 5 | 无 PWA 支持（manifest / Service Worker） | 🟡 中 | 体验 |
| 6 | 内联 `<style>` 每次 re-render 重建 DOM 节点 | 🟡 中 | 性能 |
| 7 | 滑动手势用 `dataset` 存坐标，触发 DOM attribute mutation | 🟢 低 | 性能 |
| 8 | MobileKeyBar 无触觉反馈 | 🟢 低 | 体验 |
| 9 | 横屏模式未优化（键盘占比过大） | 🟢 低 | 体验 |
| 10 | MobileNav shake 动画在快速切换时过于频繁 | 🟢 低 | 体验 |

---

## 2. 详细分析

### 2.1 console.log 遗留（#1）

**位置**：`frontend/src/hooks/useMediaQuery.ts:42-48`

```ts
console.log('[Keyboard]', { 
  innerHeight: window.innerHeight, 
  vvHeight: vv.height, 
  rawKb, 
  kbHeight: kb,
  isInputFocused 
})
```

**分析根据**：此 hook 监听 `visualViewport.resize` + `visualViewport.scroll` + `window.resize` 三个事件。移动端软键盘弹出/收起、页面滚动时均会高频触发。每次调用创建一个新对象字面量 → 短命对象 → GC 压力。在低端 Android 设备上可观测到 jank。属于调试遗留，无生产价值。

**修复**：直接删除。

### 2.2 Safe Area 缺失（#2）

**位置**：
- `frontend/index.html:6` — viewport meta 无 `viewport-fit=cover`
- `MobileNav.tsx` — 底部导航无 `env(safe-area-inset-bottom)` padding
- `MobileStatusBar.tsx` — 顶部状态栏无 `env(safe-area-inset-top)` padding

**分析根据**：
- iPhone X (2017) 起引入刘海 + 底部 Home Indicator，safe area 上下各约 44px / 34px。
- Android 挖孔屏（2018 起）同样存在 display cutout，`env(safe-area-inset-*)` 已获全面支持（caniuse: 97%+）。
- 当前 `MobileNav` 的 `padding: '6px 0'` 在 iPhone 上会导致按钮被 Home Indicator 遮挡，用户需从底部上滑才能触达——与系统手势冲突。
- 不加 `viewport-fit=cover` 时，`env()` 值恒为 0，页面被限制在 safe area 内（上下黑边）。

**修复**：
1. viewport meta 加 `viewport-fit=cover`
2. MobileNav 容器加 `paddingBottom: 'env(safe-area-inset-bottom, 0px)'`
3. MobileStatusBar 加 `paddingTop: 'env(safe-area-inset-top, 0px)'`，高度改为 `calc(30px + env(safe-area-inset-top, 0px))`

### 2.3 未消费 state 引起多余渲染（#3）

**位置**：`frontend/src/hooks/useMediaQuery.ts:20-21`

```ts
const [kbHeight, setKbHeight] = useState(0)
const [viewportHeight, setViewportHeight] = useState(window.innerHeight)
```

**分析根据**：`MobileLayout`（唯一消费者）只解构 `{ vvHeight }`。但 `update()` 内同时调用 `setViewportHeight` + `setKbHeight` + `setVvHeight` 三个 setState。React 18 虽会 batch，但每次键盘事件仍多执行两次 state 比较 + 一次额外 render cycle（bailout 前需进入 reducer）。在键盘动画期间（iOS 约 250ms 内触发 10-15 次 resize），累积开销可观。

**修复**：删除 `kbHeight` / `viewportHeight` state，hook 只返回 `vvHeight`。若未来需要键盘高度，从 `window.innerHeight - vvHeight` 即时计算即可。

### 2.4 overscroll-behavior 缺失（#4）

**位置**：`MobileLayout` 根容器（`Layout.tsx:271-273`）

**分析根据**：
- Chrome Android 默认 `overscroll-behavior: auto` → 顶部下拉触发 pull-to-refresh，终端内滚动到顶时页面被拉下。
- iOS Safari 有橡皮筋回弹（rubber-band），虽无法用此属性完全禁止，但 `overscroll-behavior: none` 可阻止 Chrome/Edge/Firefox Android 的导航手势干扰。
- 终端场景用户频繁上下滚动查看历史输出，pull-to-refresh 误触率高。

**修复**：MobileLayout 根容器 style 加 `overscrollBehavior: 'none'`。同时在 `index.css` 的 `html, body` 加 `overscroll-behavior: none`（仅移动端生效——通过 JS 加 class 或直接全局加，桌面无副作用）。

### 2.5 PWA 缺位（#5）

**分析根据**：
- 项目定位为"Web-based tmux terminal manager"，移动端使用场景为 SSH 到服务器管理——高频、短时、反复打开。
- PWA standalone 模式去除浏览器 chrome（地址栏/工具栏），终端可视面积增加约 80-120px 高度。
- Service Worker 缓存前端 shell（JS/CSS/字体），弱网/地铁场景秒开。
- 当前无任何 PWA 基础设施：无 `manifest.json`、无 SW 注册、无 icon 资源。

**修复（分步）**：
1. 创建 `frontend/public/manifest.webmanifest`（name、short_name、display: standalone、theme_color、icons）
2. 生成 192x192 + 512x512 icon（可复用现有 logo）
3. `index.html` 加 `<link rel="manifest">` + `<meta name="theme-color">`
4. 用 `vite-plugin-pwa` 或手写极简 SW（仅 cache-first 静态资源）
5. iOS 需额外 `<meta name="apple-mobile-web-app-capable" content="yes">`

### 2.6 内联 `<style>` 重建（#6）

**位置**：
- `MobileNav.tsx:23-30`（shake keyframes）
- `MobileKeyBar.tsx:76-86`（.mobikey-btn 样式）
- `Layout.tsx:275-290`（mobileSlide* keyframes）

**分析根据**：React 每次 re-render 会卸载旧 `<style>` 节点、挂载新节点 → 浏览器重新解析 CSS + 触发 style recalc。MobileLayout 在键盘弹出期间可能高频 re-render（vvHeight 变化）。keyframes 定义是静态的，无需动态注入。

**修复**：将三处 keyframes/class 移入 `frontend/src/index.css`（或新建 `mobile.css` 由 index.css import）。删除 JSX 中的 `<style>` 标签。

### 2.7 dataset 存触摸坐标（#7）

**位置**：`Layout.tsx` MobileLayout swipe handler（约 302-319 行）

**分析根据**：`e.currentTarget.dataset.startX = ...` 每次 touchstart 修改 DOM attribute → 触发 MutationObserver（如有）+ attribute 序列化。相比 `useRef({x:0, y:0})`，多一次 DOM 写操作。影响微小但在 120Hz 触控采样率设备上累积可感知。

**修复**：改用 `const touchStart = useRef<{x:number,y:number}|null>(null)`。

### 2.8 触觉反馈（#8）

**分析根据**：iOS 10+ / Android 7+ 支持 `navigator.vibrate()`。终端虚拟按键无物理行程，触觉确认能降低误触感知。竞品（Termius、Blink Shell）均有此功能。

**修复**：MobileKeyBar `handleClick` 内加 `navigator.vibrate?.(10)`（feature detect，iOS Safari 不支持 vibrate 则静默跳过）。

### 2.9 横屏优化（#9）

**分析根据**：横屏时屏幕高度约 360-414px（主流手机），减去 StatusBar(30) + KeyBar(~76) + MobileNav(~50) + 软键盘(~260) 后终端可视高度为负值。实际体验：横屏打开键盘后终端完全不可见。

**修复方向**（待设计）：
- 方案 A：横屏 + 键盘弹出时自动隐藏 KeyBar（用户已有软键盘）
- 方案 B：横屏时 MobileNav 改为侧边竖排图标
- 方案 C：检测横屏时提示用户竖屏使用

建议先实施方案 A（改动最小、收益最大）。

### 2.10 shake 动画频率（#10）

**分析根据**：当前每次 `activeTab` 变化都触发 400ms shake。用户快速左右滑动切换 tab 时，icon 连续抖动，视觉噪音大。

**修复**：仅在从非相邻 tab 跳转（如点击 nav 直接从 sessions → files）时播放 shake；swipe 相邻切换不播放。或改为更微妙的 scale pulse（150ms）。

---

## 3. 实施分期

### Phase 1：快速修复（P0，预计 30min）

| 任务 | 对应问题 | 改动文件 |
|------|----------|----------|
| 删除 console.log | #1 | `useMediaQuery.ts` |
| 删除未消费 state | #3 | `useMediaQuery.ts` |
| 加 overscroll-behavior | #4 | `Layout.tsx` / `index.css` |
| dataset → useRef | #7 | `Layout.tsx` |

### Phase 2：Safe Area 适配（P0，预计 20min）

| 任务 | 对应问题 | 改动文件 |
|------|----------|----------|
| viewport-fit=cover | #2 | `index.html` |
| MobileNav safe-area padding | #2 | `MobileNav.tsx` |
| MobileStatusBar safe-area padding | #2 | `MobileStatusBar.tsx` |

### Phase 3：CSS 整理（P1，预计 20min）

| 任务 | 对应问题 | 改动文件 |
|------|----------|----------|
| 内联 style → index.css | #6 | `MobileNav.tsx` / `MobileKeyBar.tsx` / `Layout.tsx` / `index.css` |
| shake 动画优化 | #10 | `MobileNav.tsx` |

### Phase 4：PWA 基础设施（P1，预计 1-2h）

| 任务 | 对应问题 | 改动文件 |
|------|----------|----------|
| manifest + icons + meta | #5 | `public/` / `index.html` |
| Service Worker（vite-plugin-pwa） | #5 | `vite.config.ts` / `package.json` |

### Phase 5：体验增强（P2，待排期）

| 任务 | 对应问题 | 改动文件 |
|------|----------|----------|
| 触觉反馈 | #8 | `MobileKeyBar.tsx` |
| 横屏 KeyBar 自动隐藏 | #9 | `Layout.tsx` / `useMediaQuery.ts` |

---

## 4. 验证清单

- [ ] Chrome DevTools Lighthouse PWA 审计通过（Phase 4 后）
- [ ] iPhone Safari（模拟器）：底部 nav 不被 Home Indicator 遮挡
- [ ] Android Chrome：终端内滚动不触发 pull-to-refresh
- [ ] 键盘弹出/收起：无控制台日志输出、无多余 re-render（React DevTools Profiler）
- [ ] 横屏 + 键盘：终端区域仍可见（Phase 5 后）
- [ ] 添加到主屏幕后 standalone 模式正常（Phase 4 后）
