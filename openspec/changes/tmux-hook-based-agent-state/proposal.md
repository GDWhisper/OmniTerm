## Why

OmniTerm 目前通过抓取 tmux pane 文本、用启发式正则匹配来推测 agent 状态。这套方案根本缺陷在于：依赖 pane 缓冲区中恰好出现的文本，大量漏报误报，且需要额外的 `capture-pane` 子进程调用。

tmuxes 已经证明了正确做法——利用 agent CLI 的生命周期 hook，在每次状态变化时直接写入 tmux session option，服务端读 session 列表时顺手拿到状态。但这只是**精度**问题的解决。

tmuxes 在**体验**层面仍然有短板：5 秒轮询意味着 agent 等你做决策时，你可能要等 5 秒才知道。OmniTerm 已经有活跃的终端 WebSocket 连接，完全可以在精度对标 tmuxes 的基础上，在实时性上**超越**它——做到亚秒级状态推送 + 完整的通知体验（声音、badge、标签页闪烁），而不是"够用就行"。

## What Changes

- **删除**启发式 `scan_agent_state()` pane 内容扫描器，替换为 session-option 读取
- **新增** agent CLI 检测 + 自动 hook 配置注入（Claude Code `--settings` / Codex `-c`）
- **新增**前端 Attention 通知系统：声音 ping、侧边栏 badge（决策/完成/错误）、浏览器标签页闪烁
- **新增**智能 diff 逻辑：对比轮询间的 agent event nonce 检测状态转换，对短暂 permission prompt 去抖（2 周期确认）
- **新增**终端 WebSocket 通道内实时推送 agent 状态（活跃 session 1s 延迟 vs tmuxes 的 5s）
- **保留** `hook-enable` / `hook-disable` 端点，用于手动注入 hook 到已有 session
- **保留**启发式扫描器作为 fallback（option 为空时回退），暂不删除

## Capabilities

### New Capabilities
- `agent-hook-registration`: Agent CLI 检测、hook 配置注入、session option 状态读写、attention 通知系统。对标并超越 tmuxes。

### Modified Capabilities
<!-- 无已有 spec 需要修改 -->

## Impact

- **Backend**: `src/tmux/hooks.rs` 完全重写；`src/tmux/mod.rs` — `list_sessions` 格式串加 `#{@omniterm_agent}`、新增 `get_agent_option`；`src/ws/terminal.rs` — WS 内嵌 agent 状态轮询 + 推送；`src/api/hooks.rs` — 重构为先读 option、fallback 扫描
- **Database**: `sessions.hook_enabled` 语义从"启用监控"改为"hook 已注入"；无需 schema 变更
- **Frontend**: 新建 `AttentionProvider` + `useAttention` hook（对标 tmuxes 的 `attention.tsx`）；`Sidebar` / `SessionRow` 集成 badge 和通知；`useTerminal` hook 接收 WS 推送的 agent 状态
- **Breaking**: 无。API 端点响应格式向后兼容
