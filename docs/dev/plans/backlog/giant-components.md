# Giant Component 跟踪

> 大型组件的拆分/重构需求。不设截止时间，触发再处理。

---

## FileManager.tsx — 1061 行

- 职责：文件列表展示、排序、列宽拖动、下载模式、右键菜单、目录导航
- 上次评估：07-30 列宽拖动修复，有 5 个子组件（`FileListHeader` / `FileRow` / `BreadcrumbNav` / `DownloadBar` / `ContextMenu`）
- 触发条件：新增第三个列拖动类型或修改排序逻辑时，考虑按以下方向：
  - 提取 `FileTable`（纯渲染 + 列宽管理）
  - 提取 `FileActionsBar`（下载/删除/新建等操作工具栏）
  - 提取 `FileBreadcrumb`（已有，但混在主体里）

## useAcpChat.ts — 449 行（hook）

- 见 `docs/dev/plans/2026-07-20-acp-quality-gap.md` 附录 A

## 死代码清理

| 文件 | 符号 | 建议 |
|------|------|------|
| `src/models/user.rs` | `User` struct | 确认未使用后删除 |
| `src/auth/mod.rs` | `verify_token` / `RequireAuth` | 确认已废弃后删除 |
| `src/tmux/agent_state.rs` | `AGENT_OPTION` / `agent_value` / `clean_token` | 确认已搬至更稳定位置后删除 |
| `src/ws/terminal.rs` | `ServerControl::Pong/Exit/AgentState` | 确认这些变体是否计划外使用 |
