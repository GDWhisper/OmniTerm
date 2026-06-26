## Why

上一变更 `tmux-hook-based-agent-state` 实现了 hook 驱动的 agent 状态监控全链路：后端自动检测 agent CLI、注入 hook、实时推送，前端通知系统（声音/badge/标签页闪烁）。但**启用方式存在体验断层**——用户需要在创建 session 时手动填写 CLI 命令（`claude`、`codex`）才能触发注入，这对普通用户来说认知成本过高，且创建后无法随时启用。

当前 `hook-enable` API 已经就绪（设置 `hook_enabled=true` 即可），但前端没有任何入口引导用户使用。一个 session 里跑了 Claude Code，OmniTerm 完全有能力检测到，却没有任何提示告诉用户"一键开启监控就能获得这些好处"。

## What Changes

- **移除** Sidebar 创建 session 弹窗中的 `command` 输入框（`CreateSession.command` 字段保留在 API 层，仅供高级/脚本调用）
- **新增** session 行上的 Agent 检测提示 — 后端在 session 列表轮询时扫描进程树，发现 agent CLI 进程后，前端在对应 session 行显示检测横幅
- **新增** 一键「启用监控」按钮 — 已检测到 agent 的 session 行上出现醒目的启用按钮，点击即调 `hook-enable`，注入 hook，开启实时推送 + 通知
- **新增** 功能说明 Tooltip — 启用按钮旁有简短说明：「开启后可获得实时状态通知、决策提醒音、侧边栏标记」
- **新增** 首次使用引导 — 第一个 agent session 被检测到时，弹出轻量提示横幅，说明 Agent 监控功能的存在和价值

## Capabilities

### New Capabilities
- `agent-process-detection`: 后端定期扫描 session 进程树，检测运行的 agent CLI（Claude Code / Codex），将检测结果注入 session 列表 API 响应
- `one-click-hook-enable`: 前端一键启用 hook 监控的交互流程——检测提示 → 一键启用 → 确认反馈

### Modified Capabilities
<!-- 无已有 spec 需要修改 -->

## Impact

- **Backend**: `src/tmux/mod.rs` 新增 `detect_agent_process()` 扫描 session 进程树；`src/api/sessions.rs` 的 session 列表响应新增 `agent_detected: Option<String>` 字段
- **Frontend**: Sidebar session 行新增检测提示横幅 + 启用按钮 + Tooltip；新增首次使用引导弹窗/横幅；创建 session 弹窗移除 `command` 输入框
- **Breaking**: 无。`CreateSession.command` 字段保留，仅前端 UI 移除
