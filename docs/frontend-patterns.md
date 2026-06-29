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
