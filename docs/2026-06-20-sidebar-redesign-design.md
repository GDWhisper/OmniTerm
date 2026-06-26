# Sidebar 重设计 — 科技感 Violet

**日期**: 2026-06-20
**状态**: 已确认
**文件**: `frontend/src/components/Sidebar/Sidebar.tsx`
**样式**: `frontend/src/index.css`

## 设计方向

- **风格**: 科技感（Warp / Fig terminal 风格）
- **主色**: Violet #a78bfa（高亮、边框发光、选中态）
- **状态色**: Green #4ade80（运行中，带发光效果）
- **主题行为**: Sidebar 始终深色，不跟随全局 light/dark 主题

## 配色系统

| 用途 | 颜色 | 说明 |
|------|------|------|
| 背景 | `#0a0a0f` | 近黑色 |
| 边框 | `#1e293b` | slate-800 |
| 主色 | `#a78bfa` | violet-400，用于高亮、发光、选中 |
| 活跃文字 | `#e2e8f0` | slate-200 |
| 次要文字 | `#64748b` | slate-500，非活跃项 |
| 禁用文字 | `#334155` | slate-700，路径等辅助信息 |
| Section 标签 | `#a78bfa` | 与主色一致，大写 |
| 运行中状态 | `#4ade80` | green-400，带 box-shadow 发光 |
| 空闲状态 | `#475569` | slate-600 |
| 危险操作 | `#ef4444` | red-500，删除按钮 hover |

## 字体

- **字体族**: `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace`
- **Section 标签**: `9px`, `uppercase`, `letter-spacing: 2px`
- **正文**: `11-12px`
- **Header**: `14px`, `font-weight: 700`，渐变文字

## 布局结构

```
┌─────────────────────────────┐
│ ● OmniTerm         [v1] [+] │  ← Header：发光点 + 渐变文字 + 版本 + 创建
├─────────────────────────────┤
│ WORKSPACES                2 │  ← Section 标签
│                             │
│ │ ▸ my-project       ~/dev │  ← 活跃 workspace：左竖线发光 + 渐变背景
│ │   SESSIONS           [+]  │  ← Session 子标签
│ │   ● dev-server     [RUN] ✕│  ← 活跃 session：绿发光 + RUN 标签 + 删除
│ │   ○ build              ✕ │  ← 空闲 session：灰点 + 删除
│                             │
│   ▸ dotfiles         ~/dot ✕│  ← 非活跃 workspace：dim 样式
│                             │
├─────────────────────────────┤
│ ● Connected          [⚙]   │  ← 底部状态栏
└─────────────────────────────┘
```

## 按钮设计（纯图标，无文字）

所有按钮统一 `transition: all 0.15s ease` 过渡动画。

| 按钮 | 位置 | 默认样式 | Hover 样式 |
|------|------|---------|-----------|
| `+` 创建 workspace | Header 右侧 | 24×24 方块，实心 `bg-[#a78bfa]`，深色图标 `text-[#0a0a0f]`，`box-shadow: 0 0 12px rgba(167,139,250,0.3)` | `bg-[#c4b5fd]`（violet-300），阴影扩大到 `0 0 16px` |
| `+` 创建 session | Sessions 标签右侧 | 20×20 方块，`border: 1px solid #a78bfa`，`text-[#a78bfa]`，透明底 | `bg-[rgba(167,139,250,0.15)]`，阴影 `0 0 8px rgba(167,139,250,0.2)` |
| `✕` 删除 | 每项右侧 | 18×18 方块，`border: 1px solid #334155`，`text-[#64748b]`，始终可见 | `border-color: #ef4444`，`text-[#ef4444]`，`bg-[rgba(239,68,68,0.1)]`，`box-shadow: 0 0 6px rgba(239,68,68,0.3)` |
| `⚙` 设置 | 底部状态栏右侧 | 22×22 方块，`border: 1px solid #334155`，`text-[#64748b]` | `border-color: #a78bfa`，`text-[#a78bfa]`，`bg-[rgba(167,139,250,0.1)]` |

## 交互行为

- **Workspace 点击**: 切换展开/折叠（展开显示其 sessions）
- **Session 点击**: 激活该 session（连接终端）
- **RUN 标签**: 显示在 session 右侧，反映当前 session 状态。数据来源：如果 hook-status API 已有集成则使用，否则暂时所有 session 统一显示绿色点 + RUN 标签（纯视觉，不新增 API 轮询）
- **删除按钮**: 始终可见（不再仅 hover 显示），点击弹出确认对话框
- **创建按钮**: 点击弹出创建模态框（现有 Modal 组件样式同步更新为深色科技风）

## 模态框更新

创建 workspace / session 的 Modal 同步为深色科技风格：

- 背景: `#111827` (gray-900)
- 边框: `1px solid #1e293b`
- 输入框: 深色底 `#1e293b`，紫色 focus 边框
- 按钮: 主按钮紫色实心，取消按钮描边

## 实现约束

- Sidebar 组件添加 `font-family` 内联样式或 CSS class，不依赖 Google Fonts 外部加载
- Sidebar 容器移除 `dark:` 前缀条件，固定使用深色值
- 不引入新的 npm 依赖（图标用 Unicode / CSS 绘制，不加 lucide-react）
- 保持现有功能逻辑不变（CRUD、WebSocket、Modal 等）
- 底部状态栏为新增元素，显示连接状态 + 设置入口

## 不涉及的范围

- 不改变 Layout.tsx 的三栏布局结构
- 不改变拖拽调整宽度逻辑
- 不改变移动端 Sidebar 行为
- 不添加新的 API 调用
- 不改变数据模型
