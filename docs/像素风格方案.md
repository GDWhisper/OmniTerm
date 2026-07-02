# OmniTerm 像素风格方案

> 护眼像素风视觉方案 + 游戏化正反馈动效的完整设计方案

---

## 一、护眼像素风视觉方案

"霓虹（高饱和、强发光）"与"护眼（低对比、柔和）"在人机工程学中天生是矛盾的。传统的赛博朋克霓虹风如果长时间注视，会导致严重的**光晕效应（Halation）**和**视网膜疲劳**。

既然你的 UI 控件已经由 SVG 绘制且不想改变布局，我们可以通过 **"色彩降维（柔和霓虹）"** + **"CSS/SVG 属性像素化"** 的纯代码手段，在不重构 DOM 的前提下，将其改造为 **"护眼版科幻像素风"**。

以下是具体的改良方案：

---

### 色彩重构：从"刺眼赛博"到"深空柔和霓虹"

放弃纯黑底色和纯色发光。我们要使用 **"深空灰底色 + 粉彩霓虹（Pastel Neon） + 硬边缘"** 的组合。

#### 1. 护眼量化色板 (CSS Variables)

将以下变量替换你现有的颜色。这套色板将对比度控制在舒适的 `8:1` 左右，去除了刺眼的纯白和纯黑。

```css
:root {
  /* 1. 背景层 (拒绝纯黑 #000，使用带微弱蓝紫倾向的深灰，降低眩光) */
  --bg-deep-space:  #12141A; /* 最底层背景 (极深空灰) */
  --bg-panel:       #1B1E26; /* 面板/卡片背景 (深灰) */
  --bg-elevated:    #242832; /* 悬浮/输入框背景 (中深灰) */

  /* 2. 文本层 (拒绝纯白 #FFF，使用柔和浅灰) */
  --text-primary:   #D1D5DB; /* 主文本 (柔和灰白，对比度约 11:1) */
  --text-secondary: #8B949E; /* 次要文本/注释 (对比度约 5:1) */

  /* 3. 护眼霓虹色 (降低饱和度 S，提高明度 L，去除外发光) */
  --neon-cyan:      #58A6FF; /* 主色调：柔和星蓝 (替代刺眼的 #00FFFF) */
  --neon-pink:      #F778BA; /* 强调色：柔和霓虹粉 (替代刺眼的 #FF00FF) */
  --neon-green:     #7EE787; /* 成功/运行：柔和荧光绿 (替代刺眼的 #00FF00) */
  --neon-orange:    #FFA657; /* 警告：柔和琥珀橙 */
  --neon-red:       #FF7B72; /* 错误：柔和珊瑚红 */

  /* 4. 像素硬阴影色 (用于替代模糊的 box-shadow) */
  --pixel-shadow:   #090A0D; /* 极暗阴影，用于制造像素立体感 */
}
```

#### 2. 去除"发光 (Glow)"，改用"像素描边"

传统的霓虹靠 `box-shadow: 0 0 10px #0ff` 发光，这极度伤眼。
**改良方案：** 去掉所有 blur（模糊）阴影，改为 **1px 或 2px 的纯色实线描边**。这在视觉上依然有"霓虹灯管"的暗示，但边缘锐利，不产生光晕。

---

### SVG 像素化魔法（不改布局的纯代码改造）

既然控件是 SVG，我们可以通过 CSS 和 SVG 原生属性，强制矢量图形呈现"像素画（Pixel Art）"的阶梯状边缘，而**不需要你重新绘制像素图**。

#### 1. 全局 SVG 像素化渲染

在你的全局 CSS 中，强制所有 SVG 关闭抗锯齿（Anti-aliasing），让斜线和曲线自动变成像素阶梯。

```css
/* 强制 SVG 像素化渲染 */
svg, svg * {
  shape-rendering: crispEdges !important; /* 核心属性：关闭抗锯齿，边缘锐利化 */
  image-rendering: pixelated !important;  /* 针对 SVG 内的 image 标签 */
}
```

#### 2. SVG 描边（Stroke）的像素化修正

如果你的 SVG 按钮有描边，必须将线条端点和转角改为"直角"，模拟像素画笔。

```css
/* 针对 SVG 路径的像素化描边 */
svg path, svg rect, svg circle, svg line {
  stroke-linecap: square !important;   /* 端点平直，而非圆形 */
  stroke-linejoin: miter !important;   /* 转角锐利直角，而非圆角 */
  /* 确保 stroke-width 是偶数（如 2px, 4px），避免在像素网格上发虚 */
}
```

#### 3. 终极像素化滤镜（可选，针对复杂 SVG）

如果某些 SVG 形状太复杂，`crispEdges` 效果不好，可以使用 CSS 的"缩放欺骗法"将其强行像素化：

```css
.pixelate-svg {
  /* 将元素缩小到 10%，使用像素渲染，再放大回 100% */
  /* 注意：这会让 SVG 看起来像 8-bit 游戏，非常硬核 */
  transform: scale(0.1); 
  image-rendering: pixelated;
  /* 需要配合外层容器放大 10 倍来抵消，或者使用 SVG filter */
}
```

*更优雅的 SVG Filter 像素化方案（直接加在 SVG 代码内）：*

```xml
<filter id="pixelate">
  <feFlood x="2" y="2" height="1" width="1"/>
  <feComposite width="4" height="4"/>
  <feTile result="a"/>
  <feComposite in="SourceGraphic" in2="a" operator="in"/>
  <feMorphology operator="dilate" radius="2"/>
</filter>
<!-- 在你的 SVG 形状上应用：<rect filter="url(#pixelate)" ... /> -->
```

---

### UI 控件与排版的"科幻像素"改良

在不改变 Flex/Grid 布局的情况下，通过 CSS 改变控件的"质感"。

#### 1. 抛弃圆角与模糊阴影，使用"硬阴影 (Hard Shadow)"

像素风没有圆角，也没有模糊阴影。将现有的按钮/面板 CSS 修改如下：

```css
.neo-pixel-btn {
  border-radius: 0 !important; /* 强制去除所有圆角 */
  border: 2px solid var(--neon-cyan); /* 霓虹灯管描边 */
  background-color: var(--bg-panel);
  color: var(--text-primary);
  
  /* 核心：像素硬阴影，制造 8-bit 立体感 */
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow); 
  
  transition: transform 0.1s, box-shadow 0.1s;
}

.neo-pixel-btn:active {
  /* 按下时，阴影消失，按钮位移，模拟物理像素按键 */
  transform: translate(4px, 4px);
  box-shadow: 0px 0px 0px 0px var(--pixel-shadow);
}
```

#### 2. 字体搭配（极其关键的护眼点）

**千万不要全局使用像素字体！** 像素字体在长时间阅读代码或长文本时是反人类的。

- **标题 / 按钮 / 状态标签（展示区）：** 使用像素字体，注入灵魂。
  - 英文推荐：`VT323`, `Press Start 2P`, `Silkscreen`
  - 中文推荐：`Zpix` (最完美的开源中文像素字体) 或 `Fusion Pixel`。
- **代码区 / 长文本 / 输入框（阅读区）：** 必须使用**现代等宽字体**，保证护眼和可读性。
  - 推荐：`JetBrains Mono`, `Fira Code` (开启连字)。

```css
/* 展示型像素字体 */
.font-pixel {
  font-family: 'Zpix', 'VT323', 'Press Start 2P', monospace;
  letter-spacing: 1px; /* 像素字体稍微增加字间距更易读 */
  text-transform: uppercase; /* 英文全大写更有科幻感 */
}

/* 阅读型等宽字体 (代码/正文) */
.font-reader {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 14px;
  line-height: 1.6; /* 护眼行高 */
}
```

---

### 氛围增强与终极护眼机制

#### 1. 添加极微弱的 CRT 扫描线（不影响阅读）

在 UI 的最顶层（`z-index: 9999`）覆盖一个全屏的 div，用 CSS 绘制极细的扫描线，增加复古科幻终端的感觉。

```css
.crt-overlay {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none; /* 绝对关键：不阻挡鼠标点击 */
  z-index: 9999;
  
  /* 扫描线：2px 高，透明度极低 (2%)，几乎不干扰阅读 */
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.02) 0px,
    rgba(0, 0, 0, 0.02) 1px,
    transparent 1px,
    transparent 2px
  );
}
```

#### 2. "低功耗模式"（终极护眼开关）

作为一个工具，提供一个"低功耗模式 (Low Power Mode)"开关。开启后，通过 CSS 滤镜瞬间降低整体对比度和饱和度，适合深夜爆肝。

```css
/* 在 body 上添加 .low-power 类即可触发 */
body.low-power {
  /* 降低整体饱和度，并稍微降低亮度 */
  filter: saturate(0.6) brightness(0.85); 
}
```

---

### 改造 Checklist

1.  [ ] 替换 CSS 变量，使用**深空灰底色**和**粉彩霓虹色**。
2.  [ ] 全局移除 `box-shadow` 中的 `blur` (模糊值)，改为 **4px 硬阴影**。
3.  [ ] 全局移除 `border-radius` (圆角)，改为 **0**。
4.  [ ] 给所有 SVG 添加 `shape-rendering: crispEdges` 和 `stroke-linejoin: miter`。
5.  [ ] 将 SVG 的"外发光"特效改为 **2px 的纯色实线描边**。
6.  [ ] 引入 **Zpix / VT323** 用于标题和按钮，保留 **JetBrains Mono** 用于代码和正文。
7.  [ ] 加上 `pointer-events: none` 的 **CRT 扫描线遮罩**。

这套方案完全不需要你修改现有的 HTML 结构和 SVG 路径，只需在 CSS 和 SVG 属性层进行"降维打击"，就能得到一个既有 8-bit 科幻硬核感，又能让开发者连续盯 8 小时不流泪的顶级工具 UI。

---

## 二、游戏化正反馈动效方案

将《超级马里奥》等经典游戏的"正反馈动效（Juiciness/Game Feel）"融入 IDE，是一个极其高级且能大幅提升开发者"心流（Flow）"体验的设计思路。

但在工具类 UI 中，绝对不能直接照搬游戏的夸张动效（如满屏烟花、剧烈震动），否则会严重干扰编码注意力。我们需要提取马里奥正反馈的核心物理法则，将其"降维"并映射到 IDE 的高频操作中。

马里奥正反馈的核心在于：挤压与拉伸（Squash & Stretch）、清晰的物理弹跳（Y轴位移）、离散的粒子消散、以及即时的状态跃迁。

### 游戏感映射原则

Agent 在编写正反馈动效时，必须遵循以下映射逻辑，确保"有游戏感但不幼稚/不干扰"：

- **拒绝水平震动 (No Horizontal Shake)**：屏幕或控件的左右抖动会引起视觉不适。所有物理反馈仅限 Y 轴（垂直）弹跳或 Z 轴（缩放）挤压。
- **离散物理引擎 (Discrete Physics)**：继续使用 `steps()` 函数。马里奥的弹跳不是平滑的贝塞尔曲线，而是清晰的帧动画。
- **奖励克制 (Restrained Rewards)**：粒子爆炸和数字飞升特效，仅在"正向结果确认"（如：保存成功、编译通过、AI 生成完毕、消除报错）时触发，日常点击按钮不触发。

### 核心游戏感动效库

#### "顶砖块"物理微弹跳（The "Block Bump" Micro-Jump）

**适用场景：** 核心按钮点击、成功提交 (Commit)、展开关键面板。

**视觉感受：** 模拟马里奥顶砖块或角色起跳瞬间的"挤压与拉伸"，赋予 UI 控件极强的物理重量感和弹性。

```css
/* 定义阶梯状的挤压与拉伸关键帧 */
@keyframes mario-jump {
  0%   { transform: translateY(0) scale(1, 1); }
  /* 起跳前：下蹲挤压 (变扁) */
  20%  { transform: translateY(2px) scale(1.1, 0.9); } 
  /* 腾空：拉伸 (变长) */
  50%  { transform: translateY(-8px) scale(0.95, 1.05); } 
  /* 落地：再次挤压 */
  80%  { transform: translateY(0) scale(1.05, 0.95); } 
  100% { transform: translateY(0) scale(1, 1); }
}

.btn-primary.success-action {
  /* 触发弹跳，使用 steps(6) 模拟 8-bit 动画帧率 */
  animation: mario-jump 0.4s steps(6, end) forwards;
}
```

#### "吃金币"得分飞升（The "Coin" Score Pop）

**适用场景：** 代码编译成功、Lint 检查通过 0 Error、AI 成功生成代码、关闭一个报错提示。

**视觉感受：** 模拟吃金币后 +100 分数向上弹跳并消散的爽快感。利用伪元素生成像素化的反馈符号。

```css
.score-pop-container {
  position: relative;
  display: inline-block;
}

/* 触发正向反馈时，添加此类 */
.score-pop-container.is-rewarded::after {
  content: '+1 ✓'; /* 可以是 +1, ✓, 或像素图标 */
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  
  /* 样式：使用护眼的荧光绿，像素字体 */
  font-family: 'VT323', 'Zpix', monospace;
  font-size: 16px;
  color: var(--neon-green);
  text-shadow: 2px 2px 0px var(--pixel-shadow); /* 像素硬阴影 */
  pointer-events: none;
  
  /* 动效：向上弹跳并阶梯式消散 */
  animation: coin-pop 0.6s steps(5, end) forwards;
}

@keyframes coin-pop {
  0%   { transform: translateX(-50%) translateY(0) scale(0.5); opacity: 1; }
  50%  { transform: translateX(-50%) translateY(-20px) scale(1.2); opacity: 1; }
  100% { transform: translateX(-50%) translateY(-30px) scale(1); opacity: 0; }
}
```

#### "踩栗子"消除反馈（The "Stomp" Squash & Vanish）

**适用场景：** 删除冗余代码、关闭报错弹窗、清除终端日志、标记任务完成。

**视觉感受：** 模拟马里奥踩扁敌人。元素不是平滑淡出，而是瞬间被"压扁"成一条线，然后伴随几个像素碎块消失。

```css
@keyframes stomp-vanish {
  0%   { transform: scaleY(1); opacity: 1; }
  /* 瞬间压扁 */
  30%  { transform: scaleY(0.1); opacity: 1; } 
  /* 保持压扁状态并下坠消失 */
  100% { transform: scaleY(0.1) translateY(10px); opacity: 0; }
}

.error-item.is-dismissed {
  /* 使用 steps(4) 让压扁和消失的过程有顿挫感 */
  animation: stomp-vanish 0.3s steps(4, end) forwards;
}
```

#### "无敌星"状态跃迁（The "Starman" Power-Up State）

**适用场景：** Agent 正在高速生成代码、系统进入"专注模式/编译中"、连续快速保存成功。

**视觉感受：** 模拟吃到无敌星后的轮廓高频闪烁。注意：为了护眼，不改变元素内部颜色，只改变边框或外发光（硬阴影）的颜色。

```css
@keyframes starman-flash {
  0%, 100% { 
    border-color: var(--neon-cyan); 
    box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
  }
  50% { 
    border-color: var(--neon-pink); 
    /* 阴影也跟随变色，产生像素轮廓闪烁感 */
    box-shadow: 4px 4px 0px 0px var(--neon-pink); 
  }
}

.system-is-powering-up {
  /* 高频闪烁，但限制在特定状态，不引起光敏疲劳 */
  animation: starman-flash 0.4s steps(1, end) infinite; 
}
```

### 听觉正反馈

视觉动效只能提供 50% 的游戏感，另外 50% 来自音效。在 IDE 中加入音效必须极其克制，音量要小，音色要"脆"。

给 Agent 的 JS 实现指令：

1. 请创建一个轻量级的 AudioFeedback 管理类。
2. 使用 Web Audio API 动态合成 8-bit 像素音效（不加载外部 MP3/WAV 文件，保证零延迟和极小体积）。
3. 合成规则：
   - 成功/得分 (Coin)：快速播放两个递增频率的方波 (Square Wave)（如 800Hz 然后 1200Hz，每个持续 50ms）。
   - 消除/踩扁 (Stomp)：播放一个频率快速下降的方波（如 400Hz 降至 100Hz，持续 100ms）。
   - 错误/受伤 (Damage)：播放低频的锯齿波 (Sawtooth Wave) 噪音。
4. 全局控制：必须读取 `localStorage` 中的 `user_pref_sound_enabled`，默认关闭，允许用户在设置中开启。音量默认限制在 0.1 (10%)。

### 执行指引

可直接复制以下 Prompt 让 Agent 开始编写正反馈代码：

> **Task:** 为 IDE 的 UI 控件注入"超级马里奥"风格的游戏化正反馈动效。
>
> **Context:** 这是一个护眼像素风 (Cyber-Pixel) 的 Web IDE。动效必须克制，不能干扰长时间编码。
>
> **Strict Rules:**
> - 所有动效必须使用 CSS `steps()` 函数，保持 8-bit 像素离散感。
> - 物理反馈仅限 Y 轴弹跳或 Z 轴缩放，严禁水平震动 (X轴 translate)。
> - 粒子/数字飞升特效仅在"正向结果确认"（如保存成功、编译通过）时触发。
>
> **Action Items:**
> 1. 编写 CSS `@keyframes mario-jump`（挤压与拉伸弹跳），并应用到 `.btn-primary` 的点击反馈中。
> 2. 编写 CSS `@keyframes coin-pop`（数字向上弹跳消散），提供一个 JS 工具函数 `triggerScorePop(element, text)`，在指定元素上方生成 +1 或 ✓ 的飞升特效。
> 3. 编写 CSS `@keyframes stomp-vanish`（瞬间压扁消失），用于列表项/报错信息的删除动画。
> 4. (可选) 使用 Web Audio API 编写一个 `play8BitSound(type: 'coin' | 'stomp')` 函数，用方波合成极简音效。
>
> 请输出相关的 CSS 和 JS 代码。

### 人类开发者避坑指南

> 💡 关键注意事项

- **防抖与节流 (Debounce/Throttle)：** 如果用户疯狂连按 Ctrl+S 保存，不要每次都触发"吃金币"动效和音效，否则会变成噪音灾难。请在 JS 层做节流（例如 500ms 内只触发一次正向反馈）。
- **尊重"心流"：** 当用户正在连续快速打字时，IDE 应该处于"静默状态"。正反馈动效应主要集中在命令执行后（如运行、编译、提交、AI 交互），而不是每一次键盘敲击。
- **提供"关闭游戏感"的开关：** 在 IDE 的设置中，务必提供一个 `Enable Gamified Animations` (启用游戏化动效) 和 `Enable 8-bit Sounds` (启用 8-bit 音效) 的开关。有些开发者在极度专注时，任何多余的动效都会让他们烦躁。
