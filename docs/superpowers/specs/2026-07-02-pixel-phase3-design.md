# OmniTerm 像素风格改造 · 阶段 3 设计文档

> 日期：2026-07-02
> 状态：待实施
> 阶段：Phase 3 — 全游戏 UI 改造（承接 Phase 1 视觉重构 + Phase 2 动效音效）
> 前置 spec：`docs/superpowers/specs/2026-07-01-pixel-style-redesign-design.md`

---

## 1. 概述

OmniTerm 的 Phase 1 + Phase 2 已完成色板替换、硬阴影、CRT 扫描线、马里奥动效和 8-bit 音效，但用户反馈整体仍像"换了配色"，缺乏真正的游戏感。

Phase 3 将 OmniTerm 从"现代 Web UI + 像素滤镜"升级为**全游戏 UI 终端工具**，采用：

- **羊皮纸 A2 亮色主题**（主）+ 保留 Phase 1 深空灰暗色主题作为夜间模式
- **Stardew Valley × Celeste × Undertale 混搭调性**：温暖装饰 + 彩色标题条 + 分段 XP 条 + RPG 对话框 toast
- **像素终端图标 + Press Start 2P 像素字 logo**
- **15 项游戏化视觉元素**（成就弹窗除外）

### 1.1 设计目标

1. **游戏感强**：一眼看出"这是一个游戏风格的工具"，不是"现代 Web 加了像素滤镜"
2. **不牺牲可用性**：终端、文件管理、会话切换等核心操作依然高效
3. **用户可控**：每个游戏化元素独立 toggle，可单独关闭
4. **长时间使用不腻**：羊皮纸暖色 + 深色终端，对比度适中

### 1.2 不变更项

- 三栏布局结构（Sidebar / Terminal / FileManager）不变
- 组件 DOM 结构不变
- Tailwind CSS 工具类使用方式不变
- Phase 1/2 已实现的马里奥动效 + 8-bit 音效保留并扩展

---

## 2. 色板

### 2.1 亮色主题（主）— 羊皮纸 A2

底色 `#F5ECD8`（中度淡化羊皮纸），暖度保留但不抢。

#### 背景色阶

| Token | 值 | 用途 |
|---|---|---|
| `--bg-base-light` | `#F5ECD8` | 最底层背景 |
| `--bg-elevated-light` | `#EBE0C4` | 面板/卡片背景 |
| `--bg-surface-light` | `#FDF8EA` | 输入框、高亮背景 |

#### 文本色阶

| Token | 值 | 用途 |
|---|---|---|
| `--text-primary-light` | `#3A2E1F` | 主文本（对比度 ~11:1） |
| `--text-secondary-light` | `#6B5D45` | 次要文本 |
| `--text-faint-light` | `#A89474` | 占位/禁用 |

#### 强调色

| Token | 值 | 语义 |
|---|---|---|
| `--wood-dark` | `#8B5A2B` | 标题牌、按钮主色（木棕色） |
| `--wood-shadow` | `#3A2E1F` | 硬阴影、厚边框 |
| `--accent-light` | `#58A6FF` | 主交互（保留 cyan） |
| `--accent-pink-light` | `#F778BA` | 选中/重要标记 |
| `--success-light` | `#5A8F3A` | 成功/运行中 |
| `--warning-light` | `#D4A05A` | 警告 |
| `--danger-light` | `#C85A3A` | 危险 |
| `--gold-light` | `#FFCB6B` | 装饰/高亮（羊皮纸金） |

#### 边框与阴影

| Token | 值 | 用途 |
|---|---|---|
| `--border-subtle-light` | `#D4C4A0` | 面板内分隔线 |
| `--border-strong-light` | `#3A2E1F` | 面板外边框 |
| `--pixel-shadow-light` | `#8B7755` | 像素硬阴影 |

### 2.2 暗色主题（夜间模式）

保留 Phase 1 定义的 `--bg-base: #12141A` 深空灰 + pastel neon 色板，作为夜间模式。不再单独设计新色值，仅确保 Phase 3 的游戏 UI 元素（标题牌、进度条、对话框）在暗色下有对应的木棕/暗金变体。

### 2.3 终端区域

**亮色主题下，终端区域依然使用深色 `#12141A` 背景 + Phase 1 pastel neon ANSI 色板**。xterm 终端深色看代码最舒服，不与羊皮纸底色冲突。终端面板外框为木棕色 `#8B5A2B`。

---

## 3. Logo

### 3.1 像素终端图标

- **尺寸**：16×16 sprite，渲染到 48×48（侧边栏）/ 96×96（启动屏）/ 16×16（favicon）
- **构成**：
  - 深棕 `#3A2E1F` 厚外框（2px 粗）
  - 深色屏幕 `#12141A`
  - 绿色 `#7EE787` `>` prompt 光标（像素化）
  - 蓝色 `#58A6FF` `_` 输入光标
  - 支架 + 底座 = 经典 CRT monitor 剪影
- **渲染规则**：`image-rendering: pixelated; shape-rendering: crispEdges;`
- **存放位置**：`frontend/src/components/Icons/OmniTermLogo.tsx`（React 组件）+ `frontend/public/favicon.svg`（静态）

### 3.2 像素字文字

- **字体**：`Press Start 2P`（Google Fonts 免费，经典 8-bit 像素字）
- **字号**：17px（侧边栏）/ 32px（启动屏）
- **字色**：`#FAF2DE`（羊皮纸白）在 `#8B5A2B` 木棕标题牌上
- **letter-spacing**：1px
- **text-transform**：uppercase
- **版本号副文本**：紧贴文字底部，11px，VT323，`#FFCB6B` 金色

### 3.3 侧边栏 Logo 标题牌布局

```
┌─────────────────────────────┐
│ [48x48 图标]  OMNITERM       │
│               v0.2.0 · LV.07 │
└─────────────────────────────┘
```

padding: 14px 10px，背景 `#8B5A2B`，下边框 `2px solid #3A2E1F`

---

## 4. 字体系统

### 4.1 三层字体栈

| 用途 | 字体栈 | CSS 类 |
|---|---|---|
| Logo / 标题牌文字 | `'Press Start 2P', 'VT323', monospace` | `.font-logo` |
| 标题 / 按钮 / 状态标签（展示区） | `'VT323', 'Press Start 2P', monospace` | `.font-pixel` |
| 代码 / 正文 / 输入框（阅读区） | `'JetBrains Mono', 'Fira Code', monospace` | `.font-reader` |

### 4.2 字号阶梯

| 场景 | 字体 | 字号 | letter-spacing |
|---|---|---|---|
| Logo 文字 | `.font-logo` | 17px | 1px |
| 启动屏标题 | `.font-logo` | 32px | 2px |
| 标题牌标题 | `.font-pixel` | 13px | 3px |
| 按钮文字 | `.font-pixel` | 13-14px | 2px |
| 列表项 | `.font-pixel` | 15px | 2px |
| 正文/输入 | `.font-reader` | 11-14px | 0 |

---

## 5. UI 元素规则

### 5.1 标题牌（面板顶栏）

每个面板（Sidebar / Terminal / FileManager / Settings）顶部都有木棕色标题牌：

```css
.panel-title-bar {
  padding: 5px 10px;
  background: var(--wood-dark);
  color: #FAF2DE;
  font-family: var(--font-pixel);
  font-size: 13px;
  letter-spacing: 3px;
  text-transform: uppercase;
  border-bottom: 2px solid var(--wood-shadow);
}
```

标题牌内容：
- 左侧装饰符号：`◆` 或 sprite 图标
- 中间标题文本
- 右侧可选状态徽章（如 terminal 的 `● LIVE`）

### 5.2 游戏风按钮

**Primary 按钮**（木棕填充）：
```css
.btn-primary {
  background: var(--wood-dark);
  color: #FAF2DE;
  border: 2px solid var(--wood-shadow);
  padding: 6px 12px;
  font-family: var(--font-pixel);
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  box-shadow: 3px 3px 0 var(--pixel-shadow-light);
}
.btn-primary:hover { background: #A06A3B; }
.btn-primary:active {
  transform: translate(3px, 3px);
  box-shadow: none;
}
```

**Secondary 按钮**（羊皮纸底 + 木棕描边）：
```css
.btn-secondary {
  background: var(--bg-elevated-light);
  color: var(--wood-dark);
  border: 2px solid var(--wood-dark);
  box-shadow: 2px 2px 0 var(--pixel-shadow-light);
}
```

**Accent 按钮**（蓝色填充，用于"+ NEW"等重要操作）：
```css
.btn-accent {
  background: var(--accent-light);
  color: var(--wood-shadow);
  border: none;
  box-shadow: 0 3px 0 var(--wood-shadow);
}
```

### 5.3 分段式进度条

用分段方块表示数值（替代连续进度条）：

```html
<div class="progress-segmented">
  <div class="label">SESSIONS</div>
  <div class="bar">
    <div class="segment filled"></div>  <!-- repeat N times -->
    <div class="segment empty"></div>
  </div>
</div>
```

- 每段宽度 `flex: 1`，gap 2px，高度 8px
- `filled` = `#5A8F3A`（绿），`empty` = `#D4C4A0`（浅棕）
- 标签字体：11px `.font-pixel`，letter-spacing 2px

### 5.4 选中项闪烁光标

当前选中列表项左侧显示 `▶` 粉色闪烁光标：

```css
.selected-item::before {
  content: '▶';
  color: var(--accent-pink-light);
  font-size: 16px;
  animation: blink-cursor 1s steps(1) infinite;
}
@keyframes blink-cursor {
  50% { opacity: 0; }
}
```

### 5.5 角钉装饰

Modal / 浮动层 / RPG 对话框的四角添加金色小方块：

```css
.corner-nails::before,
.corner-nails::after,
.corner-nails > .nail-bl,
.corner-nails > .nail-br {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--gold-light);
}
.corner-nails::before { top: -3px; left: -3px; }
.corner-nails::after { top: -3px; right: -3px; }
/* BL/BR 用子元素或额外 div */
```

### 5.6 终端像素边框

终端面板外框加木棕色像素边框：

```css
.terminal-panel {
  background: var(--bg-elevated-light);
  border: 2px solid var(--wood-shadow);
  box-shadow: 3px 3px 0 var(--pixel-shadow-light);
}
.terminal-panel .xterm-viewport {
  background: #12141A;  /* 深色保留 */
}
```

### 5.7 羊皮纸背景纹理

底色 `#F5ECD8` 上叠加极弱的点阵纹理（不影响阅读）：

```css
body.light {
  background:
    radial-gradient(circle at 1px 1px, rgba(139, 90, 43, 0.04) 1px, transparent 0) 0 0 / 8px 8px,
    #F5ECD8;
}
```

---

## 6. 游戏化元素清单（15 项）

### 6.1 P0 · 必须做

| # | 元素 | 描述 | 实现方式 |
|---|---|---|---|
| 1 | 像素字体 · 全局 | Press Start 2P + VT323，三层字体栈 | CSS + Google Fonts |
| 2 | 标题牌 | 面板顶栏木棕色 + 像素字 | CSS 类 `.panel-title-bar` |
| 3 | 游戏风按钮 | Primary/Secondary/Accent 三种 + 硬阴影 + active 位移 | CSS 类 `.btn-*` |
| 4 | 分段式进度条 | HP/XP 风格方块条 | React 组件 `SegmentedProgress` |
| 5 | Sprite 图标集 | folder / file / status 等常用图标像素化 | SVG sprite + React 组件 |
| 6 | 终端像素边框 | 终端面板加木棕厚边框 | CSS 覆盖 xterm wrapper |

### 6.2 P1 · 强烈建议

| # | 元素 | 描述 | 实现方式 |
|---|---|---|---|
| 7 | RPG 对话框 toast | Undertale 风带角钉的对话框，用于关键通知 | React 组件 `DialogueToast` |
| 8 | 角钉装饰 | Modal / 浮动层四角金色方块 | CSS 类 `.corner-nails` |
| 9 | 选中项闪烁光标 | 列表选中项左侧粉色 `▶` 闪烁 | CSS 伪类 |
| 10 | 像素风 toast | 常规 toast 通知用像素边框 + 星号前缀 `★ FILE SAVED` | 覆盖现有 Toast 组件 |

### 6.3 P2 · 锦上添花

| # | 元素 | 描述 | 实现方式 |
|---|---|---|---|
| 11 | 像素 logo | 16×16 终端图标 + Press Start 2P 文字（§3） | `OmniTermLogo` 组件 + favicon.svg |
| 12 | CRT 扫描线开关 | 已有（Phase 2），保持 toggle | — |
| 13 | 羊皮纸背景纹理 | §5.7 点阵纹理 | CSS body |
| 14 | 过场动效 | workspace 切换时的淡入/翻页 | CSS transitions + React |
| 15 | 8-bit 音效开关 | 已有（Phase 2），保持 toggle | — |

### 6.4 明确不做

| # | 元素 | 原因 |
|---|---|---|
| 16 | 成就弹窗 | 用户拒绝 |
| — | 吉祥物 | 用户明确不要 |

---

## 7. Sprite 图标规范

### 7.1 通用规则

- 所有 sprite 使用 16×16 viewBox，渲染时保持整数倍放大（16/32/48/64）
- `image-rendering: pixelated; shape-rendering: crispEdges;`
- 色值优先使用 CSS 变量（支持主题切换）
- 几何构成（粗线条、大块）优先于具象描绘

### 7.2 初始 sprite 清单

| Sprite | 用途 | 主色 |
|---|---|---|
| `folder` | 文件夹（关闭/打开） | `#8B5A2B` + `#A06A3B` |
| `file` | 普通文件 | `#A89474` + `#FAF2DE` |
| `file-code` | 代码文件 | `#58A6FF` |
| `file-md` | Markdown | `#79C0FF` |
| `file-config` | TOML/JSON/YAML | `#FFA657` |
| `status-running` | 运行中（绿色方块组） | `#7EE787` |
| `status-stopped` | 已停止（灰色方块组） | `#A89474` |
| `git-branch` | Git 分支 | `#F778BA` |
| `terminal-icon` | Logo 用终端 | `#3A2E1F` + `#7EE787` + `#58A6FF` |

### 7.3 存放位置

`frontend/src/components/Icons/PixelSprites.tsx` — 导出所有 sprite 为 React 组件

---

## 8. 组件改造清单

### 8.1 现有组件修改

| 文件 | 修改内容 |
|---|---|
| `components/Sidebar/Sidebar.tsx` | Logo 标题牌 + workspaces/sessions 标题牌 + 选中项闪烁光标 + 分段 XP 条 + sprite folder 图标 |
| `components/Terminal/Terminal.tsx` | 终端像素边框 + 标题牌 |
| `components/FileManager/FileManager.tsx` | 标题牌 + sprite 图标 + 像素 toast |
| `components/FileManager/FileDrawer.tsx` | 标题牌 |
| `components/FileManager/FilePreview.tsx` | 标题牌 |
| `components/Settings/Settings.tsx` | 标题牌 + 像素风 toggle |
| `components/Modal/Modal.tsx` | 角钉装饰 + 像素边框 |
| `components/Modal/ConfirmDialog.tsx` | 角钉装饰 + 像素边框 |
| `components/Toast/Toast.tsx` | 像素风 toast 样式 |
| `components/Layout/Layout.tsx` | Logo 标题牌位置调整 + 过场动效 |
| `components/Layout/MobileLayout.tsx` | 同上 |
| `index.css` | 新增所有像素字体类、标题牌、按钮、进度条、角钉、背景纹理 |
| `index.html` | 引入 Press Start 2P 字体 |

### 8.2 新增组件

| 文件 | 用途 |
|---|---|
| `components/Icons/OmniTermLogo.tsx` | Logo 终端图标 sprite |
| `components/Icons/PixelSprites.tsx` | 所有 sprite 图标集合 |
| `components/UI/SegmentedProgress.tsx` | 分段进度条 |
| `components/UI/DialogueToast.tsx` | RPG 对话框 toast |
| `components/UI/PixelButton.tsx` | 三种游戏风按钮 |

---

## 9. 设置面板开关

新增 4 个 toggle（扩展 Phase 2 的 3 个开关）：

| 开关 | localStorage key | 默认值 | 控制范围 |
|---|---|---|---|
| 像素化 UI | `omniterm_pixel_ui` | `true` | 标题牌/按钮/进度条/角钉/闪烁光标 |
| 像素字体 | `omniterm_pixel_font` | `true` | Press Start 2P + VT323 启用 |
| 羊皮纸纹理 | `omniterm_parchment_texture` | `true` | 背景点阵纹理 |
| 过场动效 | `omniterm_transitions` | `true` | workspace 切换淡入 |

**保留 Phase 2 的开关**：
- `pixelAnimationsEnabled`（马里奥动效）
- `soundEnabled`（8-bit 音效）
- `crtScanlines`（CRT 扫描线）

**关闭像素化 UI 时**：所有面板回退到 Phase 1 的纯色板 + 硬阴影状态，无标题牌、无角钉、无进度条。

---

## 10. 主题切换

### 10.1 亮色为主，暗色为夜间模式

- **默认主题**：亮色（羊皮纸 A2）
- **切换入口**：设置面板 toggle，localStorage 持久化
- **Phase 1 暗色保留**：作为"夜间模式"使用，所有游戏 UI 元素在暗色下有对应木棕/暗金变体

### 10.2 暗色主题下的游戏 UI 适配

| 元素 | 亮色值 | 暗色值 |
|---|---|---|
| 标题牌背景 | `#8B5A2B` | `#2A2520` |
| 标题牌文字 | `#FAF2DE` | `#E6DFD0` |
| 硬阴影 | `#8B7755` | `#090A0D` |
| 装饰金 | `#FFCB6B` | `#8B7755` |
| 边框 | `#3A2E1F` | `#484F58` |

---

## 11. 动效扩展

### 11.1 过场动效

workspace 切换时：

```css
.workspace-transition {
  animation: workspace-fade 0.3s steps(3) forwards;
}
@keyframes workspace-fade {
  0% { opacity: 0; transform: translateY(4px); }
  100% { opacity: 1; transform: translateY(0); }
}
```

### 11.2 复用 Phase 2 动效

- `pixel-bump`（按钮点击）：应用到所有 `.btn-*` onClick
- `pixel-coin-pop`（成功飞升）：保存/上传/编译成功
- `pixel-stomp`（删除消除）：文件/会话删除
- `pixel-starman`（进行中闪烁）：AI 生成中、编译中

---

## 12. 文件改动总览

### 12.1 新增

- `frontend/src/components/Icons/OmniTermLogo.tsx`
- `frontend/src/components/Icons/PixelSprites.tsx`
- `frontend/src/components/UI/SegmentedProgress.tsx`
- `frontend/src/components/UI/DialogueToast.tsx`
- `frontend/src/components/UI/PixelButton.tsx`

### 12.2 修改

- `frontend/index.html`（引入 Press Start 2P）
- `frontend/src/index.css`（新增像素 UI 类）
- `frontend/src/stores/appStore.ts`（新增 4 个 toggle）
- `frontend/src/components/Settings/Settings.tsx`（新增 4 个 toggle UI + i18n）
- `frontend/src/locales/en/translation.json`（新 i18n）
- `frontend/src/locales/zh/translation.json`（新 i18n）
- `frontend/public/favicon.svg`（替换为像素终端图标）
- 8.1 列出的所有组件

### 12.3 文档更新

- `docs/ui-style-guide.md`（追加 Phase 3 游戏 UI 规则）
- `CHANGELOG.md`（用户确认的新功能）

---

## 13. 自检清单

实施完成后需验证：

- [ ] 亮色主题下三栏整体感觉"像游戏 UI"而非"现代 Web 加滤镜"
- [ ] 暗色主题（夜间模式）下所有游戏 UI 元素有对应适配
- [ ] 终端区域保持深色 `#12141A`，与羊皮纸底色不冲突
- [ ] Logo 像素终端图标 16×16 sprite 在 48×48 渲染下清晰像素化
- [ ] "OmniTerm" 使用 Press Start 2P 17px，底部版本号 VT323 11px
- [ ] 所有标题牌样式一致（木棕 + 像素字 + 3px letter-spacing）
- [ ] 所有按钮有硬阴影 + active 位移
- [ ] 分段进度条在 Sidebar 显示 3/5 sessions 正确
- [ ] 选中项有粉色 `▶` 闪烁光标
- [ ] Modal 四角有金色角钉
- [ ] 关键通知触发 RPG 对话框 toast
- [ ] 常规 toast 使用像素风样式
- [ ] 设置面板 7 个 toggle 全部工作 + localStorage 持久化
- [ ] 关闭"像素化 UI" toggle 后回退到 Phase 1 风格
- [ ] 刷新页面后开关状态保持
- [ ] 移动端（MobileLayout）适配：Logo 标题牌 + 终端边框 + toast
- [ ] favicon.svg 替换为像素终端图标，浏览器标签页清晰可辨

---

## 14. 实施优先级

建议分 3 个 sub-phase 迭代：

### Phase 3a · 基础视觉
1. Press Start 2P 字体引入 + `.font-logo` `.font-pixel` `.font-reader` 类
2. Logo 像素终端图标 + 像素字
3. 标题牌 + 游戏风按钮
4. 羊皮纸背景纹理

### Phase 3b · 游戏 UI 元素
5. Sprite 图标集
6. 分段式进度条
7. 选中项闪烁光标
8. 终端像素边框
9. 角钉装饰

### Phase 3c · 通知 + 动效 + 设置
10. RPG 对话框 toast
11. 像素风 toast
12. 过场动效
13. 设置面板 4 个新 toggle
14. 暗色主题游戏 UI 适配
15. favicon.svg 替换

---

## 15. 非目标

- 不做成就弹窗
- 不做吉祥物
- 不做角色头像 / 任务日志 / 小地图 / 物品栏（scope 外）
- 不引入外部像素画素材库（全部手写 SVG sprite）
- 不重写 Phase 1/2 的色板/动效/音效（仅扩展）
- 不改变 DOM 结构或 Tailwind 用法
