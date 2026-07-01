# Agent Edit Manual

为有**特殊维护约定**的组件提供文件级索引——agent 接到具体修改任务时，
能快速定位要改的文件、避免漏改。

> **Agent 触发条件**：接到「加命令 / 改配置 / 修 bug / 加翻译」等具体修改
> 任务时，**先在本表搜目标组件**，列出涉及的所有文件再动手。
>
> 「一般组件」（无特殊约定）**不收录**——按 `docs/architecture-frontend.md`
> 的 Source Tree 走即可。

## 已收录组件

| 组件 | 收录原因 |
|------|---------|
| [Settings](#settings) | Sidebar 弹出面板模板，移动/桌面双布局，i18n 多 section |
| [TmuxCheatsheet](#tmuxcheatsheet) | 数据/视图分离 (data.ts + 两个 translation.json) |

> 看到没有收录的组件？如果它符合下方「收录标准」，按其格式追加 entry。

## 收录标准

组件满足以下任一条件时进表：

- 数据/视图分离（数据在 `data.ts` / JSON，组件只渲染）
- 修改要联改多个文件（i18n、store、backend 路由等）
- 有不直观的状态机、生命周期约定
- 维护指引只在某个文件顶部 JSDoc 里，不进表 agent 会漏

不符合的不要进——保持本表「**有约定才收录**」的纯粹性。

---

## Settings

Sidebar 底部齿轮按钮 → 弹出设置面板。**移动端双层容器修复已落地：外层 `overflow:hidden` + 显式 `height` 裁切 `borderRadius` 圆弧，内层 `overflowY:auto` 滚动。**

- `frontend/src/components/Settings/Settings.tsx` — **纯内容**：theme / language / fontSize / 开关。改这里动设置项
- `frontend/src/components/Settings/SettingsPopup.tsx` — **弹出层骨架**：定位、滚动、关闭逻辑。一般不改；改这里意味着动弹出行为。从 `../constants/popup` import 定位常量
- `frontend/src/components/constants/popup.ts` — 移动端定位常量（`MOBILE_NAV_HEIGHT`、`SIDEBAR_BOTTOM_BAR_HEIGHT`、`MOBILE_STATUS_BAR_RESERVE`、`GAP`），SettingsPopup 与 TmuxCheatsheetPopup 共享
- `frontend/src/stores/appStore.ts` — `settingsOpen` + `toggleSettings()`（与 `tmuxCheatsheetOpen` 互斥）
- `frontend/src/components/Layout/Layout.tsx` — 触发按钮 `data-toggle="settings"` + Desktop/Mobile 双路径条件渲染 `<SettingsPopup />`
- `frontend/src/locales/{en,zh}/translation.json` — 改这里：增/删/改 `settings.*` i18n key

**加一个设置项的标准路径**：`Settings.tsx` 加 section（参考现有 `theme` / `fontSize` / `autoCopySelect` 结构）+ 两个 translation.json 加 key。如需新 store 状态 → `appStore.ts`。

**复制为新弹窗**：见 `docs/frontend-patterns.md`「Sidebar 底部按钮弹出面板」契约。

---

## TmuxCheatsheet

Sidebar 底部书本图标按钮 → 弹出 tmux 速查面板。**已完成数据/视图分离**。

- `frontend/src/components/TmuxCheatsheet/data.ts` — **改这里**：增/删/改命令 (`SECTIONS` 数组)。维护指引见本文件顶部 JSDoc
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheet.tsx` — 一般不改；改这里意味着动渲染层
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx` — 一般不改；改这里意味着动弹出层行为（位置、Esc/外部点击、视口翻转）
- `frontend/src/locales/en/translation.json` — 改这里：增/删/改英文 i18n key（`tmuxCheatsheet.*` 命名空间）
- `frontend/src/locales/zh/translation.json` — 改这里：增/删/改中文 i18n key

**加一条命令的标准路径**：`data.ts` 的 `SECTIONS` 数组加项 + 两个 translation.json 各加一条 `tmuxCheatsheet.<key>`。
