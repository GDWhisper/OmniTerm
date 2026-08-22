# Giant Component 跟踪

> 大型组件的拆分/重构需求。不设截止时间，触发再处理。

---

## FileManager.tsx — 1197 行（2026-08-23 复核）

- 位置已移至 `frontend/src/components/FileManager/FileManager.tsx`（同目录另有 FileDrawer/FileEditor/FilePreview/icons/useFileDrag）
- 职责：文件列表展示、排序、列宽拖动、下载模式、右键菜单、目录导航
- 上次评估：07-30 列宽拖动修复，有 5 个子组件（`FileListHeader` / `FileRow` / `BreadcrumbNav` / `DownloadBar` / `ContextMenu`）
- 触发条件：新增第三个列拖动类型或修改排序逻辑时，考虑按以下方向：
  - 提取 `FileTable`（纯渲染 + 列宽管理）
  - 提取 `FileActionsBar`（下载/删除/新建等操作工具栏）
  - 提取 `FileBreadcrumb`（已有，但混在主体里）

## useAcpChat.ts — 1223 行（hook，2026-08-23 复核）

- 源自已关闭的 `docs/dev/plans/2026-07-20-acp-quality-gap.md` 附录 A（当时 449 行）
- **触发条件已多次满足仍未拆分**：期间新增过 replay/replay_end 帧、ghost message 门控/hydrate 收敛等协议帧改动，行数涨近 3 倍；WS 生命周期 + 协议解析 + store 分发仍耦合在同一 hook
- 已有部分缓解：hook 级测试存在（`useAcpChat.ghost/midturn.test.tsx`、`useAcpChat.permission.test.ts`），重构有回归保护
- 触发条件：下次修改 WS 重连/协议帧/store 分发任一层时，按附录 A 目标结构拆分（orchestrator + useAcpConnection/useAcpProtocol/useAcpDispatch）

## 死代码清理

| 文件 | 符号 | 建议 |
|------|------|------|
| `src/models/user.rs` | `User` struct | 确认未使用后删除 |
| `src/auth/mod.rs` | `verify_token` / `RequireAuth` | 确认已废弃后删除 |
| `src/tmux/agent_state.rs` | `AGENT_OPTION` / `agent_value` / `clean_token` | 确认已搬至更稳定位置后删除 |
| `src/ws/terminal.rs` | `ServerControl::Pong/Exit/AgentState` | 确认这些变体是否计划外使用 |
