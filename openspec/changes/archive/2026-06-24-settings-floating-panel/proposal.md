## Why

Settings 面板当前嵌套在 Sidebar 内部（`position: absolute` 相对于 Sidebar 容器），导致两个问题：
1. **宽度被 Sidebar 约束** — 展开状态下 popup 宽度 = Sidebar 宽度（用户可拖拽调整，通常 200-300px），内容被挤压
2. **内部按钮变形** — 三按钮行（浅色/深色/跟随系统）在窄容器中 `flex-1` 分配的空间不足，图标和文字被压缩、换行

用户期望的是一个真正浮动的独立设置窗口，拥有自适应的合理宽度，不被任何面板宽度绑架。

## What Changes

- 将 `SettingsPopup` 从 Sidebar 内部提取为 Layout 级别的浮动层
- Popup 使用 `position: fixed`（而非 `absolute`），以视口为定位基准
- 宽度自适应内容（~320-360px），不再跟随 Sidebar 宽度
- 定位改为相对于设置按钮（⚙）弹出，使用锚点计算而非 Sidebar 内部布局
- 保持 click-outside-to-close 和 Escape 关闭行为

## Capabilities

### New Capabilities
- `settings-floating-panel`: 将设置面板改造为基于视口的独立浮动窗口，拥有自适应宽度和相对于触发按钮的定位逻辑

### Modified Capabilities

（无现有 spec 需要修改）

## Impact

- `frontend/src/components/Settings/SettingsPopup.tsx` — 重写定位逻辑，从 `absolute` 改为 `fixed`
- `frontend/src/components/Sidebar/Sidebar.tsx` — 移除内部 `<SettingsPopup />` 渲染
- `frontend/src/components/Layout/Layout.tsx` — 在 Layout 顶层渲染 `<SettingsPopup />`
- `frontend/src/stores/appStore.ts` — 可能需要存储触发按钮位置信息（或通过 DOM 查询）
- 无 API / 后端变更
