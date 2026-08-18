# 权限请求超时回收时以 SYSTEM 消息告知用户

> 状态：已实施（2026-08-18）
> 触发条件：修改 `src/acp/reaper.rs`、`src/acp/client.rs`（system 通知通道）、`src/ws/acp.rs`（system_message 帧）、`chat_messages.role` 语义（migration `20260818_chat_message_role_system.sql`）任一项前必读
> 关联：`docs/architecture/backend.md`（ACP 生命周期 / blocks 两态 / 权限审批帧协议）、`docs/dev/plans/2026-08-10-acp-session-reliability.md`（幽灵行问题由此计划派生排查发现）、`docs/dev/debug-guide.md`
> 背景来源：正式版会话 codebuddy_0818-1141 排查——agent 发出 Bash 权限请求后 30 分钟无人审批，reaper 按安全策略 cancel + kill 回收进程，但用户完全不知情（权限弹窗只推送给对应会话的 WS 客户端，切去其他会话即看不到），agent 静默消失。

## 决策

**安全策略不变**（30 分钟权限超时仍 cancel + kill 进程），只增加「告知」：回收前在聊天会话写入并广播一条 `role='system'` 的消息，说明回收原因。

- **为什么不做自动 Allow / 自动 Always Allow**：用户明确否决（保留原安全策略）。
- **为什么不做 sidebar 全局横幅 / 浏览器 Notification**：用户本轮只要求聊天内 SYSTEM 告知；横幅/通知留作后续需求。
- **为什么 role 存 DB 而非仅实时广播**：刷新后 hydrate 也要能看到（持久化）；WS 广播只服务在线连接，断线期间产生的告知由 DB 落库 + hydrate 兜底。

## 实施要点（已落地）

| 项 | 内容 |
|---|---|
| migration | `migrations/20260818_chat_message_role_system.sql`：SQLite 不支持改 CHECK 约束，重建 `chat_messages` 表（列/外键/默认值逐字保留，含 `idx_chat_messages_session` 索引），CHECK 放宽为 `role IN ('user','assistant','system')` |
| 广播通道 | `AcpClient` 新增 `system_notice_tx: broadcast::Sender<String>`（容量 8，仿 crash_tx 模式）+ `system_notice_subscribe()` + `notify_system_message(label)`；两处构造（spawn_and_connect / spawn_and_load）都初始化 |
| reaper | `run_reaper` 签名加 `db: SqlitePool`（main.rs 注入 `state.db`）；`perm_stale` 回收分支在 cancel 前：① `insert_message(role="system")` 落库（blocks 为 `[{type:'system',label}]`）② `notify_system_message` 广播 ③ 原 cancel + shutdown。idle 回收分支不加（用户完全不用） |
| WS 帧 | `AcpServerMessage` 新增 `SystemMessage { label }`（`{"type":"system_message"}`）；`spawn_system_notice_task` 仿 `spawn_crash_task`，在新建 client 与重连 client 两处订阅 |
| 前端 | `ServerFrame` 加 `system_message`；`dispatchFrame` case 调 `pushSystemEvent(sid, label)`（不入 `HYDRATE_GATED_FRAMES`）；`toChatMessages` role cast 放宽为 `ChatMessage['role']`（hydrate 的 system 行走 `SystemBlockView` 渲染） |
| 文案 | `PERMISSION_TIMEOUT_NOTICE`：「权限请求 30 分钟未获响应，系统已自动取消该请求并回收会话（agent 已终止）。可重新打开会话继续。」`SystemBlockView` 未命中 i18n key 时原样显示，故中文直接可读 |

## 验证

- [x] `cargo test system_role_message`：migration 后 `insert_message(role='system')` 成功且 `list_messages_page` 可回读
- [x] `cargo check` / 前端 `tsc --noEmit` 通过
- [x] `pnpm vitest` chatStore：57 全过（新增 `pushSystemEvent` 两测 + 更新 system 不回写注释）
- [x] `cargo clippy --all-targets` / `cargo fmt --check`（见提交前门禁）
- [ ] 手动回归（dev 环境）：临时调小 `REQUIRES_ACTION_RECYCLE_SECS` 触发权限超时 → 聊天流出现 SYSTEM 消息 + 刷新后仍在

## 不纳入范围

- **幽灵行修复**（RAW 残留 + hydrate/replay 竞态 INSERT 重复消息，`2026-08-10-acp-session-reliability.md` Phase 1 勘误预测的 text 语义漂移已在 codebuddy 实测复现）：另立计划
- sidebar 全局横幅 / 浏览器 Notification / 超时阈值配置化：需求未确认，不做

## 风险与文档闭环

| 风险 | 缓解 |
|---|---|
| migration 重建表丢数据 | 单测验证 system 插入 + 既有 user/assistant 数据可读；列/索引逐字对照原 DDL |
| 广播时序（shutdown 前广播，WS 可能 Lagged） | 容量 8 足够；丢帧时 DB 已落库，hydrate 兜底 |

- `CHANGELOG.md` ✅（Fixed 条目）
- `docs/architecture/backend.md` ✅（permission 回收行为 + blocks 两态补 system 行）
- 本文件即为计划文档
