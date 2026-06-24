# Settings 弹窗设计

**日期**: 2026-06-24
**状态**: 待实现
**范围**: 桌面端 Settings 从全屏面板改为 Sidebar 浮层弹窗

## 动机

当前 Settings 组件替换终端区域渲染，用户打开设置时看不到终端。改为 Sidebar 内的浮层弹窗，保持终端可见，体验更轻量。

## 当前实现

- `Layout.tsx:134` — `{settingsOpen ? <Settings /> : <Terminal />}` 三元切换
- `Sidebar.tsx:442-459` — 齿轮按钮调用 `toggleSettings()`
- `Sidebar.tsx:201-202` — 收起状态点击齿轮同时展开 Sidebar + 打开 Settings
- `Settings.tsx` — `h-full overflow-y-auto` 全高组件，无关闭按钮
- `appStore.ts:57,109` — `settingsOpen: boolean` + `toggleSettings()`

## 目标行为

### 打开/关闭

| 触发 | 行为 |
|------|------|
| 点击齿轮按钮 | 打开弹窗（已打开则关闭） |
| 点击弹窗外任意区域 | 关闭弹窗 |
| 按 Escape | 关闭弹窗 |

### 两种 Sidebar 状态的弹窗定位

| 状态 | 定位 | 宽度 | 锚点 |
|------|------|------|------|
| **展开** | Sidebar 内 absolute，底部状态栏上方 | = Sidebar 当前宽度 | `bottom: 状态栏高度, left: 0` |
| **收起** | 浮层，从 Sidebar 右侧弹出 | 固定 280px | `bottom: 0, left: 100%` |

两种状态都是浮层（absolute 定位），统一行为。

### 移动端

不变。移动端仍使用底部 tab 切换全屏 Settings 页面（`MobileContent` 中的 `activeTab === 'settings'` 分支）。

## 视觉设计

- **背景色**: `#0f1729`（与 Sidebar 面板色一致，略深于 `#0a0a0f`）
- **边框**: `1px solid #1e293b`
- **圆角**: `8px`
- **阴影**: `0 -4px 20px rgba(0,0,0,0.5)`（向上浮出的阴影感）
- **最大高度**: 展开状态 `calc(100% - 状态栏高度 - 8px)`，收起状态 `400px`
- **内容溢出**: 内部 `overflow-y-auto` 滚动
- **动效**: 从底部向上滑入 `150ms ease-out`

## 改动文件

### 1. `Sidebar.tsx` — 主要改动

新增 `SettingsPopup` 内联组件（或独立文件），在 Sidebar 渲染树中插入：

```
<div className="relative h-full flex flex-col">
  {/* Header */}
  {/* Content (workspace/session list) */}

  {/* Settings Popup — 浮层 */}
  {settingsOpen && <SettingsPopup />}

  {/* Bottom status bar */}
</div>
```

`SettingsPopup` 逻辑：
- **展开状态**: `position: absolute; bottom: <状态栏高度>; left: 0; width: 100%`
- **收起状态**: `position: absolute; bottom: 0; left: 100%; width: 280px`（`left: 100%` 使其紧贴 Sidebar 右边缘）
- **点击外部关闭**: `useEffect` 监听 `document.addEventListener('mousedown', ...)`，判断点击目标不在弹窗内则 `toggleSettings()`
- **Escape 关闭**: `useEffect` 监听 `keydown`，`e.key === 'Escape'` 时关闭
- **事件冒泡防护**: 弹窗自身的 `mousedown` 调用 `e.stopPropagation()` 防止被外部监听误关

收起状态齿轮按钮逻辑变更：
- 当前: `onClick={() => { toggleSidebarCollapsed(); toggleSettings() }}`
- 改为: `onClick={() => { toggleSettings() }}`（不再展开 Sidebar，弹窗直接浮出）

### 2. `Settings.tsx` — 适配弹窗容器

- 移除外层 `h-full`，改为自适应高度
- 保留 `overflow-y-auto`（弹窗容器限制了最大高度，内部仍需滚动）
- 保留 `max-w-lg mx-auto` 的内容居中（弹窗宽度受限后居中效果更好）
- 背景色改为与弹窗容器一致（避免双层背景色差）

### 3. `Layout.tsx` — 移除 Settings 条件渲染

```tsx
// 改前
<div className="flex-1 min-w-0">
  {settingsOpen ? <Settings /> : <Terminal key={activeSessionId ?? 'empty'} />}
</div>

// 改后
<div className="flex-1 min-w-0">
  <Terminal key={activeSessionId ?? 'empty'} />
</div>
```

移除 `Settings` 的 import（如果不再被 Layout 直接使用）。移动端 `MobileContent` 中的 Settings 引用保持不变。

### 4. `appStore.ts` — 不变

`settingsOpen` / `toggleSettings()` 逻辑保持原样。

## 不做的事

- 不改移动端行为
- 不加键盘快捷键打开 Settings
- 不改 Settings 内容本身（主题/语言/字体/关于）
- 不加弹窗标题栏或关闭按钮（点击外部/Escape/齿轮即可关闭）
