## Context

当前 `SettingsPopup` 渲染在 `Sidebar` 组件内部（`Sidebar.tsx:203` 和 `Sidebar.tsx:430`），使用 `position: absolute` 相对于 Sidebar 的 `relative` 容器定位。

问题：
- 展开态：popup `width: 100%` = Sidebar 宽度（用户可拖拽 140px ~ screenWidth/3），内容被挤压
- 折叠态：popup `left: '100%', width: 280`，相对合理但仍锚定在 Sidebar 边缘
- 内部三按钮行（浅色/深色/跟随系统）在窄容器中 `flex-1` 分配空间不足，图标+文字被压缩

相关文件：
- `frontend/src/components/Settings/SettingsPopup.tsx` — 当前 popup 实现
- `frontend/src/components/Settings/Settings.tsx` — 设置内容（自适应，本身无问题）
- `frontend/src/components/Sidebar/Sidebar.tsx` — 渲染 SettingsPopup + ⚙ 按钮
- `frontend/src/components/Layout/Layout.tsx` — 顶层布局
- `frontend/src/stores/appStore.ts` — `settingsOpen` / `toggleSettings` 状态

## Goals / Non-Goals

**Goals:**
- SettingsPopup 成为基于视口的浮动层（`position: fixed`），不受任何面板宽度约束
- 拥有自适应的合理宽度（~340px），确保按钮不变形
- 相对于 ⚙ 触发按钮定位（锚点弹出），而非 Sidebar 内部布局
- 保持 click-outside-to-close、Escape 关闭行为
- 同时支持 Sidebar 展开态和折叠态

**Non-Goals:**
- 不改变 Settings.tsx 内部的内容和样式（已正常）
- 不改变移动端 Settings 渲染（MobileContent 中直接内联 `<Settings />`）
- 不引入 Portal（`createPortal`）— Layout 级别渲染 + `position: fixed` 已足够
- 不添加拖拽移动、调整大小等高级窗口功能

## Decisions

### D1: 渲染位置 — 从 Sidebar 移到 Layout

**选择**：在 `Layout.tsx` 顶层渲染 `<SettingsPopup />`，从 `Sidebar.tsx` 移除。

**理由**：
- Layout 是三栏的根容器，浮动层在此渲染天然脱离任何面板约束
- 避免 Sidebar `overflow: hidden` 裁剪 popup（当前通过 `overflow: visible` hack 绕过）
- 移动端 Settings 已在 `MobileContent` 中独立渲染，不受影响

**替代方案**：
- `createPortal` 到 `document.body`：可行但增加 DOM 层级复杂度，Layout 级别已够用

### D2: 定位策略 — fixed + 锚点计算

**选择**：`position: fixed`，通过 ⚙ 按钮的 `getBoundingClientRect()` 计算弹出位置。

**逻辑**：
```
buttonRect = settingsButton.getBoundingClientRect()
popupStyle = {
  position: 'fixed',
  bottom: window.innerHeight - buttonRect.top + 8,  // 按钮上方 8px 间距
  right: window.innerWidth - buttonRect.right,       // 右对齐按钮
  width: 340,
}
```

**边界保护**：如果计算后 popup 超出视口顶部，改为 `top: 8` 向下弹出。

**理由**：
- `fixed` 以视口为基准，不受任何父容器 `overflow` / `transform` 影响
- 从 ⚙ 按钮弹出符合用户直觉（锚点弹出模式）
- 右对齐确保不超出屏幕右侧

**替代方案**：
- 居中弹出：不符合"从按钮弹出"的直觉
- 固定位置（如右下角）：不如锚点灵活

### D3: 触发按钮引用 — DOM 查询 vs ref 传递

**选择**：通过 `data-settings-toggle` 属性查询 DOM（已有此属性）。

**理由**：
- Sidebar 中 ⚙ 按钮已有 `data-settings-toggle` 属性
- 无需在组件间传递 ref，保持解耦
- SettingsPopup 内部直接 `document.querySelector('[data-settings-toggle]')` 获取按钮位置

### D4: 宽度 — 固定 340px

**选择**：固定宽度 340px，不跟随 Sidebar 或视口变化。

**理由**：
- 340px 足以容纳三按钮行（每个 ~100px + gap）+ 字号滑块 + 内容
- 固定宽度避免 resize 时的重排抖动
- 符合 UI 风格规范中 Modal 的设计语言（`bg-elevated` + `border-strong` + 大圆角 + 阴影）

## Risks / Trade-offs

**[Risk] Sidebar 折叠态 ⚙ 按钮位置变化**
→ 按钮在 Sidebar 底部，折叠/展开时 `getBoundingClientRect()` 结果不同，每次打开时重新计算即可。

**[Risk] 窗口 resize 后 popup 位置偏移**
→ popup 打开时计算一次位置，打开期间不跟踪 resize。用户关闭再打开即可重新定位。可接受。

**[Risk] 移动端不走 SettingsPopup 路径**
→ 移动端 `MobileContent` 直接渲染 `<Settings />`，不受此改动影响。无需特殊处理。
