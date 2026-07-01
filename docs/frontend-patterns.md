# Frontend Patterns

记录 OmniTerm 前端开发中复用的设计模式与约定。每个 pattern 是
「数据如何从代码外部流入组件」「组件如何对外暴露接口」的契约。

新增组件或拆分数据前先扫一眼本文档，避免重复发明。

## 数据/渲染分离 (data.ts convention)

**适用场景**：组件需要渲染一份**纯静态或低频变更**的展示数据
（命令表、配置模板、术语对照表、快捷键清单等），且后续 Agent 或
开发者可能频繁增删条目。

**约定**：

- 数据放在同目录下的 `data.ts`，导出**类型化常量**
  （如 `export const SECTIONS: CheatsheetSection[]`）
- 数据条目中**可读部分**用 i18n key 引用
  （`titleKey` / `labelKey` / `hintKey`），ASCII 字面量
  （如 tmux 快捷键本身）直接放数据里
- 组件文件只负责 `useTranslation()` 渲染，**不内联数据**
- `data.ts` 顶部 JSDoc 写明「加/改数据改本文件 + 两个
  `frontend/src/locales/{en,zh}/translation.json`」

**已有案例**：

- `frontend/src/components/TmuxCheatsheet/data.ts` — tmux 速查命令表
  （拆自 `TmuxCheatsheet.tsx`，4 个 sections / 17 个 items）

**收益**：

- Agent 改命令不用动 `.tsx`，零 React 上下文
- TS 类型校验（`titleKey: string` 等）保证结构合法
- 后续如需按模式切换（例：tmux vs modern keybinding），
  在 data.ts 加第二份常量 + 组件里 `SECTIONS_MAP[mode]` 即可

**代价**：

- i18n key 写错不会编译失败，UI 上会显示原始 key 兜底
  （build-time i18n key 校验是未来工作）
- `cmd` 字符串目前是英文硬编码；如需本地化按键需额外搬进 i18n

## Sidebar 底部按钮弹出面板 (sidebar-popup convention)

**适用场景**：Sidebar 底部状态栏新增按钮 → 点击弹出 fixed 面板。
需要移动端/桌面端两套定位、视口边界保护、Esc/外部点击关闭。

**契约**：

- 触发按钮加 `data-toggle="<name>"` 属性，供 Popup 用 `document.querySelector` 定位
- Popup 文件命名 `<Feature>Popup.tsx`，内部组件为 `<Feature>`（纯内容，不关心弹出逻辑）
- Store 里一对 toggle：`settingsOpen` / `tmuxCheatsheetOpen`，互斥（开 A 关 B）
- 定位逻辑：
  - Desktop: `pos.top` 为空时 `bottom` 吸按钮上方（`innerHeight - rect.top + GAP`）；
    渲染后用 `getBoundingClientRect().top < 0` 检测溢出，翻转到按钮下方
  - Mobile: 全宽 bottom sheet，`bottom` 锚定在 `MobileNav + SidebarBottomBar` 之上，
    无 `top`，用 `maxHeight` 限高
- **滚动**：移动端用双层容器——外层 `overflow: hidden` + 显式 `height` 裁切 `borderRadius` 圆弧，内层 `height: 100%, overflowY: auto` 负责滚动。外层必须设与 `maxHeight` 等值的显式 `height`，否则内层 `height: 100%` 解析为 auto 导致滚动失效。桌面端单层即可（`borderRadius: 10` 圆弧浅）。两层各加 `padding: 4`
- 移动端定位常量统一在 `frontend/src/components/constants/popup.ts`：`MOBILE_NAV_HEIGHT`、`SIDEBAR_BOTTOM_BAR_HEIGHT`、`MOBILE_STATUS_BAR_RESERVE`、`GAP`
- **关闭**：`mousedown` 外部点击 + `Escape` 键，`onMouseDown` stopPropagation 阻止冒泡到关闭逻辑
- 边框效果（`borderRadius` / `boxShadow` / `animation`）都在外层 div inline style

**已有案例**：

- `frontend/src/components/Settings/SettingsPopup.tsx` + `Settings.tsx` — 设置面板（theme / language / fontSize / 开关）
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx` + `TmuxCheatsheet.tsx` — tmux 快捷键速查

**复制清单**（新增一个 sidebar 弹出面板时）：

| 文件 | 做什么 |
|------|--------|
| `frontend/src/components/<Feature>/<Feature>.tsx` | 纯内容组件，用 `useTranslation()` 渲染 |
| `frontend/src/components/<Feature>/<Feature>Popup.tsx` | 照搬 SettingsPopup 骨架：`data-toggle` query、pos calc、overflowY auto、外部点击/Escape 关闭、移动端 bottom sheet。从 `../constants/popup` import 常量 |
| `frontend/src/stores/appStore.ts` | 加 `xxxOpen: false` + `toggleXxx()`（互斥逻辑照抄 `toggleSettings`） |
| `frontend/src/components/Layout/Layout.tsx` | 按钮加 `data-toggle="xxx"`，Desktop + Mobile 双路径条件渲染 `<XxxPopup />` |
| `frontend/src/locales/{en,zh}/translation.json` | 加 i18n key |
