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

## TmuxCheatsheet

Sidebar 底部书本图标按钮 → 弹出 tmux 速查面板。**已完成数据/视图分离**。

- `frontend/src/components/TmuxCheatsheet/data.ts` — **改这里**：增/删/改命令 (`SECTIONS` 数组)。维护指引见本文件顶部 JSDoc
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheet.tsx` — 一般不改；改这里意味着动渲染层
- `frontend/src/components/TmuxCheatsheet/TmuxCheatsheetPopup.tsx` — 一般不改；改这里意味着动弹出层行为（位置、Esc/外部点击、视口翻转）
- `frontend/src/locales/en/translation.json` — 改这里：增/删/改英文 i18n key（`tmuxCheatsheet.*` 命名空间）
- `frontend/src/locales/zh/translation.json` — 改这里：增/删/改中文 i18n key

**加一条命令的标准路径**：`data.ts` 的 `SECTIONS` 数组加项 + 两个 translation.json 各加一条 `tmuxCheatsheet.<key>`。
