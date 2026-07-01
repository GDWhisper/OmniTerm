# 像素风格改造 — 阶段 2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OmniTerm 添加四种马里奥式游戏化正反馈动效、8-bit 音效合成、设置面板开关。

**Architecture:** 新增两个工具模块（`pixelAnimations.ts` 和 `audioFeedback.ts`），在 `appStore` 中添加三个设置开关，在 Settings UI 中添加 toggle，在业务组件触发点调用动效函数。CSS 动画定义在 `index.css`。

**Tech Stack:** React + CSS Animations + Web Audio API + Zustand

**Spec:** `docs/superpowers/specs/2026-07-01-pixel-style-redesign-design.md` §3

---

### Task 1: 添加动效 CSS @keyframes 到 index.css

**Files:**
- Modify: `frontend/src/index.css`（文件末尾追加）

- [ ] **Step 1: 在 `index.css` 末尾追加 4 组 @keyframes 和对应 CSS 类**

```css
/* ────────────────────────────────────────────────────────────────────
   Pixel gamified animations — Phase 2
   All use steps() for discrete 8-bit feel.
   Y-axis only — no horizontal shake.
   ──────────────────────────────────────────────────────────────────── */

/* Block Bump — button press squash & stretch */
@keyframes mario-jump {
  0%   { transform: translateY(0) scale(1, 1); }
  20%  { transform: translateY(2px) scale(1.1, 0.9); }
  50%  { transform: translateY(-8px) scale(0.95, 1.05); }
  80%  { transform: translateY(0) scale(1.05, 0.95); }
  100% { transform: translateY(0) scale(1, 1); }
}
.pixel-bump {
  animation: mario-jump 0.4s steps(6, end) forwards;
}

/* Coin Pop — score text flies up and fades */
@keyframes coin-pop {
  0%   { transform: translateX(-50%) translateY(0) scale(0.5); opacity: 1; }
  50%  { transform: translateX(-50%) translateY(-20px) scale(1.2); opacity: 1; }
  100% { transform: translateX(-50%) translateY(-30px) scale(1); opacity: 0; }
}
.pixel-coin-pop {
  position: absolute;
  top: 0;
  left: 50%;
  font-family: 'VT323', monospace;
  font-size: 16px;
  color: var(--success);
  text-shadow: 2px 2px 0px var(--pixel-shadow);
  pointer-events: none;
  animation: coin-pop 0.6s steps(5, end) forwards;
  z-index: 100;
}

/* Stomp Vanish — element squashes flat and disappears */
@keyframes stomp-vanish {
  0%   { transform: scaleY(1); opacity: 1; }
  30%  { transform: scaleY(0.1); opacity: 1; }
  100% { transform: scaleY(0.1) translateY(10px); opacity: 0; }
}
.pixel-stomp {
  animation: stomp-vanish 0.3s steps(4, end) forwards;
}

/* Starman Flash — border color high-frequency blink */
@keyframes starman-flash {
  0%, 100% { border-color: var(--accent); box-shadow: 4px 4px 0px 0px var(--pixel-shadow); }
  50%      { border-color: var(--accent-pink); box-shadow: 4px 4px 0px 0px var(--accent-pink); }
}
.pixel-starman {
  animation: starman-flash 0.4s steps(1, end) infinite;
}
```

- [ ] **Step 2: 提交**

```bash
git add frontend/src/index.css
git commit -m "feat: 添加游戏化动效 CSS @keyframes（mario-jump/coin-pop/stomp-vanish/starman-flash）"
```

---

### Task 2: 创建 pixelAnimations.ts 工具模块

**Files:**
- Create: `frontend/src/utils/pixelAnimations.ts`

- [ ] **Step 1: 创建动效触发工具函数**

```ts
// frontend/src/utils/pixelAnimations.ts

const THROTTLE_MS = 500
const lastTriggered = new WeakMap<HTMLElement, number>()

function isThrottled(el: HTMLElement): boolean {
  const now = Date.now()
  const last = lastTriggered.get(el) ?? 0
  if (now - last < THROTTLE_MS) return true
  lastTriggered.set(el, now)
  return false
}

function isAnimationsEnabled(): boolean {
  return localStorage.getItem('omniterm_pixel_animations') === 'true'
}

export function triggerBump(el: HTMLElement): void {
  if (!isAnimationsEnabled()) return
  if (isThrottled(el)) return
  el.classList.remove('pixel-bump')
  void el.offsetWidth // force reflow to restart animation
  el.classList.add('pixel-bump')
  el.addEventListener('animationend', () => el.classList.remove('pixel-bump'), { once: true })
}

export function triggerScorePop(el: HTMLElement, text = '+1 ✓'): void {
  if (!isAnimationsEnabled()) return
  if (isThrottled(el)) return

  const pop = document.createElement('span')
  pop.className = 'pixel-coin-pop'
  pop.textContent = text
  el.style.position = 'relative' // ensure positioning context
  el.appendChild(pop)
  pop.addEventListener('animationend', () => pop.remove(), { once: true })
}

export function triggerStomp(el: HTMLElement, onDone?: () => void): void {
  if (!isAnimationsEnabled()) {
    onDone?.()
    return
  }
  el.classList.add('pixel-stomp')
  el.addEventListener('animationend', () => {
    el.classList.remove('pixel-stomp')
    onDone?.()
  }, { once: true })
}

export function addStarman(el: HTMLElement): void {
  if (!isAnimationsEnabled()) return
  el.classList.add('pixel-starman')
}

export function removeStarman(el: HTMLElement): void {
  el.classList.remove('pixel-starman')
}
```

- [ ] **Step 2: 提交**

```bash
git add frontend/src/utils/pixelAnimations.ts
git commit -m "feat: 创建 pixelAnimations.ts 动效触发工具函数"
```

---

### Task 3: 创建 audioFeedback.ts 工具模块

**Files:**
- Create: `frontend/src/utils/audioFeedback.ts`

- [ ] **Step 1: 创建 8-bit 音效合成模块**

```ts
// frontend/src/utils/audioFeedback.ts

let audioCtx: AudioContext | null = null

function getContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function isSoundEnabled(): boolean {
  return localStorage.getItem('omniterm_sound_enabled') === 'true'
}

const VOLUME = 0.1

function playTone(frequency: number, duration: number, startTime: number, type: OscillatorType = 'square'): void {
  const ctx = getContext()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, startTime)
  gain.gain.setValueAtTime(VOLUME, startTime)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

export function play8BitSound(type: 'coin' | 'stomp'): void {
  if (!isSoundEnabled()) return
  const ctx = getContext()
  const now = ctx.currentTime

  if (type === 'coin') {
    // Two ascending square wave notes
    playTone(800, 0.05, now)
    playTone(1200, 0.05, now + 0.05)
  } else {
    // Descending frequency sweep
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(400, now)
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.1)
    gain.gain.setValueAtTime(VOLUME, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.1)
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add frontend/src/utils/audioFeedback.ts
git commit -m "feat: 创建 audioFeedback.ts Web Audio API 8-bit 音效合成"
```

---

### Task 4: 添加设置开关到 appStore + 连接 CRT overlay

**Files:**
- Modify: `frontend/src/stores/appStore.ts`
- Modify: `frontend/src/components/Layout/Layout.tsx`

- [ ] **Step 1: 在 appStore 中添加三个开关**

在 `frontend/src/stores/appStore.ts` 中：

**AppState 接口**（在 `immersiveMode` 之后）添加：

```ts
  pixelAnimationsEnabled: boolean
  soundEnabled: boolean
  crtScanlines: boolean
```

**setter 接口**（在 `setImmersiveMode` 之后）添加：

```ts
  setPixelAnimationsEnabled: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setCrtScanlines: (v: boolean) => void
```

**初始值**（在 `immersiveMode` 初始化之后）添加：

```ts
    pixelAnimationsEnabled: localStorage.getItem('omniterm_pixel_animations') === 'true',
    soundEnabled: localStorage.getItem('omniterm_sound_enabled') === 'true',
    crtScanlines: localStorage.getItem('omniterm_crt_scanlines') === 'true',
```

**setter 实现**（在 `setImmersiveMode` setter 之后）添加：

```ts
    setPixelAnimationsEnabled: (v) => {
      localStorage.setItem('omniterm_pixel_animations', String(v))
      set({ pixelAnimationsEnabled: v })
    },
    setSoundEnabled: (v) => {
      localStorage.setItem('omniterm_sound_enabled', String(v))
      set({ soundEnabled: v })
    },
    setCrtScanlines: (v) => {
      localStorage.setItem('omniterm_crt_scanlines', String(v))
      set({ crtScanlines: v })
    },
```

- [ ] **Step 2: 连接 CRT overlay 到 Layout**

在 `frontend/src/components/Layout/Layout.tsx`：

**Desktop layout**: 从 `useAppStore` 中解构 `crtScanlines`，将 `{false && <div className="crt-overlay" />}` 替换为 `{crtScanlines && <div className="crt-overlay" />}`。

**Mobile layout (MobileLayout)**: 同样从 `useAppStore` 中解构 `crtScanlines` 并替换。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/stores/appStore.ts frontend/src/components/Layout/Layout.tsx
git commit -m "feat: 添加像素动效/音效/CRT 设置开关到 appStore + 连接 CRT overlay"
```

---

### Task 5: 在 Settings 面板添加 toggle UI

**Files:**
- Modify: `frontend/src/components/Settings/Settings.tsx`

- [ ] **Step 1: 添加三个 toggle 开关**

在 Settings.tsx 中从 `useAppStore` 解构新的三个字段和 setter：

```ts
pixelAnimationsEnabled, setPixelAnimationsEnabled,
soundEnabled, setSoundEnabled,
crtScanlines, setCrtScanlines,
```

在 `autoCopySelect` toggle section 之后（约 line 240），添加三个新的 `<section>` toggle blocks，遵循现有的 `autoCopySelect` toggle 模式：

1. **游戏化动效 toggle** — `pixelAnimationsEnabled` / `setPixelAnimationsEnabled`，标签 `t('settings.pixelAnimations')`，hint `t('settings.pixelAnimationsHint')`
2. **8-bit 音效 toggle** — `soundEnabled` / `setSoundEnabled`，标签 `t('settings.sound')`，hint `t('settings.soundHint')`
3. **CRT 扫描线 toggle** — `crtScanlines` / `setCrtScanlines`，标签 `t('settings.crtScanlines')`，hint `t('settings.crtScanlinesHint')`

每个 toggle 遵循现有模式：`<section>` + `<h3>` 标签 + `<button>` 切换 + 8px 圆点指示器 + ON/OFF 文本 + `<p>` hint。

**注意**：toggle 按钮的圆点指示器保持 `borderRadius: '50%'`（圆形），这是状态指示器而非 UI 控件边框，不受像素风零圆角规则约束。

- [ ] **Step 2: 添加 i18n 翻译**

在 `frontend/src/locales/en/translation.json` 和 `frontend/src/locales/zh/translation.json` 中的 `settings` 对象添加：

**English:**
```json
"pixelAnimations": "Pixel Animations",
"pixelAnimationsHint": "Mario-style bounce, coin pop, and stomp effects on interactions",
"sound": "8-bit Sound",
"soundHint": "Retro square wave sound effects on success and delete actions",
"crtScanlines": "CRT Scanlines",
"crtScanlinesHint": "Subtle scanline overlay for retro terminal feel"
```

**中文:**
```json
"pixelAnimations": "像素动效",
"pixelAnimationsHint": "交互时的马里奥弹跳、金币飞升和踩扁消除效果",
"sound": "8-bit 音效",
"soundHint": "成功和删除操作时的复古方波音效",
"crtScanlines": "CRT 扫描线",
"crtScanlinesHint": "微弱的扫描线覆盖层，营造复古终端氛围"
```

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/Settings/Settings.tsx frontend/src/locales/
git commit -m "feat: 设置面板添加像素动效/音效/CRT 扫描线 toggle 开关"
```

---

### Task 6: 业务组件动效埋点

**Files:**
- Modify: `frontend/src/components/FileManager/FileManager.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

- [ ] **Step 1: FileManager 文件删除 — stomp + stomp 音效**

在 FileManager.tsx 的文件删除回调中，导入 `triggerStomp` 和 `play8BitSound`，在删除操作执行前对目标行元素调用 `triggerStomp(rowEl, () => { /* 执行实际删除 */ })`，同时调用 `play8BitSound('stomp')`。

具体实现需要根据删除回调的代码结构来定，关键是：
1. 获取被删除行的 DOM 元素引用
2. 调用 `triggerStomp(el, actualDeleteCallback)` — 动画结束后才执行真正的删除
3. 调用 `play8BitSound('stomp')`

- [ ] **Step 2: FileManager 文件上传成功 — coin-pop + coin 音效**

在文件上传成功的回调中，导入 `triggerScorePop` 和 `play8BitSound`：
```ts
triggerScorePop(uploadAreaEl, '✓')
play8BitSound('coin')
```

- [ ] **Step 3: Sidebar 新建 workspace — mario-jump**

在新建 workspace 按钮的 onClick 中，导入 `triggerBump`：
```ts
triggerBump(buttonEl)
```

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/
git commit -m "feat: 业务组件添加游戏化动效埋点"
```

---

### Task 7: 验证与修复

- [ ] **Step 1: 启动开发服务器并测试**

Run: `./dev.sh start`

在浏览器中：
1. 打开设置面板，确认三个 toggle 开关正常显示和切换
2. 开启「像素动效」后，点击文件管理器按钮检查弹跳效果
3. 开启「8-bit 音效」后，执行操作检查音效
4. 开启「CRT 扫描线」后，确认全屏扫描线覆盖层出现
5. 关闭各开关后，确认效果消失
6. 刷新页面后，开关状态应保持（localStorage 持久化）

- [ ] **Step 2: 修复发现的问题并提交**

```bash
git add -A
git commit -m "fix: 阶段 2 游戏化动效验证修复"
```
