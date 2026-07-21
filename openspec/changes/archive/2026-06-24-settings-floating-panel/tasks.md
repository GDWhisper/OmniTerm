## 1. 重构 SettingsPopup 定位逻辑

- [x] 1.1 重写 `SettingsPopup.tsx`：将 `position: absolute` 改为 `position: fixed`，通过 `document.querySelector('[data-settings-toggle]')` 获取 ⚙ 按钮的 `getBoundingClientRect()` 计算弹出位置（bottom: viewportHeight - buttonTop + 8, right: viewportWidth - buttonRight）
- [x] 1.2 添加视口边界保护：如果 popup 高度导致超出视口顶部，改为 `top: 8px` 向下弹出
- [x] 1.3 设置固定宽度 340px，移除展开/折叠态的分支宽度逻辑

## 2. 迁移渲染位置

- [x] 2.1 从 `Sidebar.tsx` 移除 `<SettingsPopup />` 渲染（展开态和折叠态两处）
- [x] 2.2 在 `Layout.tsx` 的 desktop return 中添加 `<SettingsPopup />`，作为 flex 容器之外的兄弟元素（`position: fixed` 自行定位）
- [x] 2.3 保留 `Sidebar.tsx` 中 ⚙ 按钮的 `data-settings-toggle` 属性不变

## 3. 验证与清理

- [x] 3.1 验证展开态 Sidebar：popup 340px 宽、按钮不变形、click-outside 关闭正常
- [x] 3.2 验证折叠态 Sidebar：popup 从折叠栏右侧弹出、340px 宽
- [x] 3.3 验证 Escape 关闭、⚙ 按钮 toggle 行为
- [x] 3.4 验证移动端不受影响（MobileContent 中 `<Settings />` 独立渲染）
