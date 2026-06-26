## Context

上一变更 `tmux-hook-based-agent-state` 已实现完整的 hook 驱动 agent 监控链路：
- 后端：session option 读写、agent CLI 检测与 hook 注入、WebSocket 实时推送
- 前端：AttentionProvider 通知系统、侧边栏 badge、声音 + 标签页闪烁
- API：`hook-enable` / `hook-disable` / `hook-status` 端点就绪

当前问题：用户必须通过 `CreateSession.command` 字段手动指定 CLI 命令才能触发 hook 注入，且创建后无 UI 入口随时启用。该字段仅 API 可用，前端未暴露，导致整套监控系统对普通用户不可见。

本变更将「agent 检测」从 session 创建时移到**运行时**，让 OmniTerm 主动发现 agent 进程并引导用户一键启用。

## Goals / Non-Goals

**Goals:**
- 后端在 session 列表轮询时自动扫描进程树，发现 agent CLI
- 前端 Sidebar 在检测到 agent 的 session 行上显示一键启用按钮 + 功能说明
- 首次使用时显示引导横幅，降低认知门槛
- 移除创建弹窗中的 `command` 输入框（保留 API 字段）

**Non-Goals:**
- 不改变 hook-enable/hook-disable/hook-status API 契约
- 不改变 WebSocket agent poll task 逻辑
- 不支持 Claude Code / Codex 以外的 agent 检测（复用 `agent_hooks::detect_agent_kind` 逻辑）
- 不在移动端做差异处理

## Decisions

### Decision 1: 进程树扫描方式 — `tmux list-panes -t <session> -F '#{pane_pid}'` + `/proc/<pid>/cmdline`

**方案**：通过 `tmux list-panes` 获取 session 下所有 pane 的 PID，然后读取 `/proc/<pid>/cmdline`（或 `ps -p <pid> -o comm=`）获取进程名，与已知 agent CLI 名匹配。

**Rationale**：
- `tmux` 是已有依赖，不引入新工具
- `/proc/<pid>/cmdline` 是 Linux 标准接口，零依赖
- 比 `capture-pane` 轻量（不抓取终端文本内容）
- 比 `pgrep` / `ps aux` 精准（限定在 tmux session 进程树内）

**Alternatives considered**:
- `pgrep -P <tmux_pid>` → 需要 tmux server PID，跨 session 隔离不精确
- 扫描 `/proc/*/cmdline` 全局 → 无法关联到具体 session
- 解析 `pstree` → 格式不稳定，不可靠

### Decision 2: 扫描触发时机 — 嵌在 session 列表 API 响应中（3s 轮询频率对齐）

每次 `GET /projects/{pid}/sessions` 被调用时，对 `hook_enabled=false` 的 session 执行进程树扫描。扫描结果缓存在响应中，不做单独缓存层。

**Rationale**：Sidebar 已有 3s 轮询周期，复用此周期扫描进程树。首次检测延迟 ≤3s，可接受。

### Decision 3: 前端组件结构 — 扩展现有 SessionRow，不拆出新组件

`agent_detected` 信息通过 session 对象字段传入，Sidebar 渲染 session 行时判断：
- `agent_detected && !hook_enabled` → 显示启用按钮 + Tooltip
- 否则 → 不显示

启用按钮点击后调 `api.hookEnable(sessionId)`，成功后刷新 session 列表。

### Decision 4: 首次使用引导 — localStorage 标记

**方案**：`localStorage.setItem('omniterm_onboarding_agent_done', 'true')`。首次检测到 `agent_detected` 时检查此标记，不存在则显示引导横幅。

**Rationale**：比后端持久化简单，无需 DB 变更。引导横幅仅在 Sidebar 顶部显示，不阻塞操作。

### Decision 5: 创建弹窗简化 — 只删 UI，不动 API

前端移除 `command` 输入框。`CreateSession.command` 字段在 Rust 模型和 API 中保留不动，高级用户仍可通过直接调 API 或未来脚本使用。

## Risks / Trade-offs

- **[进程树扫描性能]**: 每个 session 多一次 `tmux list-panes` + N 次 `/proc` 读取（N = pane 数）。→ Mitigation: 仅在 `hook_enabled=false` 时扫描；已启用 hook 的 session 跳过（已有 option 数据）；单个 session 扫描耗时 <50ms，3s 轮询周期内可完成
- **[macOS 兼容]**: `/proc/<pid>/cmdline` 是 Linux 特有。macOS 需用 `ps -p <pid> -o comm=` 或 `proc_pidpath`。→ Mitigation: 第一版 Linux only，后续补 macOS 支持（OmniTerm 当前主要运行环境即为 Linux）
- **[误报]**: 用户 session 中运行了名为 `claude` 的超短脚本（非 Claude Code）。→ Mitigation: `detect_agent_kind` 仅匹配精确的 CLI 名，误报概率极低。且启用按钮仅为**引导**，用户主动点击才注入 hook
- **[引导横幅频率]**: 用户频繁清理 localStorage 会反复看到引导。→ Mitigation: 引导横幅为轻量提示，关闭后不再显示，不影响核心操作

## Open Questions

1. **macOS 兼容性**：是否需要第一版就支持？当前 OmniTerm 实际部署环境全是 Linux，建议后续单独处理。
2. **引导横幅的视觉设计**：是否复用现有 Modal 组件还是用更轻量的内联横幅？倾向内联横幅（不打断操作），风格参考浏览器 "检测到新功能" 提示条。
