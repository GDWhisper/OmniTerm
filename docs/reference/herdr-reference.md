# herdr 借鉴清单

> 调研日期：2026-07-26。仓库：`/home/pax/coding/research/herdr`（[github.com/ogulcancelik/herdr](https://github.com/ogulcancelik/herdr)，v0.7.5，Apache-2.0，可安全参考与移植思路）。
>
> herdr 是单二进制 Rust 的 "agent multiplexer"（终端里的 tmux-like，专为 AI coding agents 设计），daemon/client 架构 + 自研双 socket 协议。与 OmniTerm 领域高度重合：它在本地终端解决的问题，正是 OmniTerm 在 Web 端要解决的问题。

## 架构速览

- Server 常驻持有所有 PTY/终端状态/agent 状态；client 只是渲染层（与 tmux 同构）
- 双 socket：`herdr.sock`（逐行 JSON API，给脚本/agent 用）+ `herdr-client.sock`（bincode 二进制帧，attach 客户端用）
- VT 解析 vendor 了 Ghostty 的 `libghostty-vt`（Zig + FFI）；PTY 用 patched `portable-pty`
- 模块：`src/detect`（agent 检测）、`src/integration`（per-agent hook 安装器）、`src/persist`（持久化）、`src/api`（JSON API）、`src/pty`（PTY actor）

OmniTerm 用 tmux 做 server 层 + xterm.js 做渲染，架构层不需要照搬；价值集中在下面的功能设计。

## 借鉴项总表

| # | 优先级 | 借鉴项 | herdr 出处 | OmniTerm 落地方式 |
|---|--------|--------|-----------|------------------|
| 1 | P0 ✅ | TOML manifest 屏幕规则引擎（agent 状态检测） | `src/detect/manifest.rs`、`src/detect/manifests/*.toml` | **已落地 2026-07-26**：`src/tmux/agent_detect.rs` + `src/tmux/manifests/*.toml` |
| 2 | P0 ✅ | 检测防抖状态机 | `src/pane/agent_detection.rs`、`src/pane.rs:604-900` | **已落地 2026-07-26**：`src/tmux/agent_watch.rs`（idle 两连确认 + window_activity 跳扫描） |
| 3 | P0 ✅ | "done = idle + 未查看" + 聚合 rollup | `src/workspace/aggregate.rs:83-110` | **已落地 2026-07-26**：`frontend/src/utils/agentAggregate.ts`（blocked>done>working）+ Sidebar |
| 4 | P1 | 前台进程组识别 + wrapper 穿透 | `src/detect/mod.rs:210-608` | `#{pane_pid}` → 前台进程组 → agent 种类识别（2026-07-26 已落地轻量版：tpgid 前台进程 + basename 匹配，见 `process_info::foreground_pid`；wrapper 穿透/打分未做） |
| 5 | P1 | 官方 hooks 集成 + 单一状态权威仲裁 | `src/integration/`、`src/terminal/state.rs:1-30` | Claude Code hooks POST 到 Axum，hook 完整才做权威 |
| 6 | P1 | agent session id 持久化 + `--resume` 自动恢复 | `src/agent_resume.rs`、`src/persist/` | 重启后自动 `claude --resume <id>` / `codex resume <id>` |
| 7 | P2 | snapshot + 事件增量的客户端同步模型 | `src/api/`（`session.snapshot` + event hub） | WS 初始快照 + 事件增量维护前端 store |
| 8 | P2 | `prompt+wait` 原子 API + wait pin 占用者 | `src/api/wait.rs` | agent 编排 API 的反竞态设计 |
| 9 | P2 | pane 环境变量注入 + SKILL.md | `src/integration/env.rs`、根目录 `SKILL.md` | 注入 `OMNITERM_PANE_ID`/API URL 让 agent 反向控制 |
| 10 | P3 | manifest 远程热更新 + 本地覆盖目录 | `src/detect/manifest_update.rs` | agent CLI 改 UI 不用等发版 |
| 11 | P3 | 检测逻辑纯函数化 + 屏幕快照 fixture 测试 | `src/pane/agent_detection.rs:329-556`、`tests/` | 录真实 capture-pane 文本当回归 fixture |
| 12 | P3 | 屏幕历史持久化默认关闭（输出可能含密钥） | `docs/.../session-state.mdx` | OmniTerm 若做 scrollback 持久化需同样 opt-in |

## 详细说明

### 1-5. Agent 状态检测体系（herdr 最大亮点）

三层信号 + 单一权威仲裁，不是单一手段：

**第一层：前台进程识别**（pane 里跑的是哪个 agent，共 21 种）
- Linux 解析 `/proc/<pid>/stat` 的 tpgid 找前台进程组，组内按优先级打分匹配
- Wrapper 穿透：识别 `node /path/bin/codex`、`bun ~/.bun/bin/omp`、symlink argv0（canonicalize）、Nix `.codex-wrapped`；排除 `bash -c "sleep 60" /tmp/codex` 误报
- 沙箱逃生门：`HERDR_AGENT=<agent>` 环境变量强制指定

**第二层：TOML manifest 屏幕规则引擎**（判 idle/working/blocked 的主体机制）
- 每个 agent 一个 TOML 规则文件，`include_str!` 编译进二进制，19 个 manifest
- 规则结构：`state` + `priority`（高者胜）+ `region` + `contains`/`regex` + 嵌套布尔门 `all`/`any`/`not` + `visible_idle|blocker|working` 强证据标志
- **region 系统是精髓**：`bottom_non_empty_lines(N)`、`prompt_box_body`（TUI 输入框边框内正文）、`after_last_horizontal_rule`、`osc_title`/`osc_progress`（OSC 0/2 标题 + OSC 9;4 进度作为独立证据源——如 Claude 的盲文 spinner 标题 → working）
- 检测文本 = **活动屏底部 N 行**，与用户回滚 viewport 无关（OmniTerm 对应：`tmux capture-pane -p` 不带 `-S`）
- **blocked 检测刻意保守**：已识别 agent 无规则命中回退 idle，宁漏报不误报
- 规则引擎有资源上限（≤128 规则/manifest、gate 深度 ≤8）
- 可解释性：`herdr agent explain` 输出命中规则、证据、region 预览、fallback 原因——调试规则的关键

**第三层：官方 lifecycle hooks（权威信号）**
- hook 事件覆盖完整生命周期的 agent（Pi/OMP/OpenCode/Kimi 等）：hook 是唯一状态权威，屏幕检测完全关闭
- Claude/Codex hook 不完整（漏 Esc 中断、权限批准结果）：**刻意不做状态权威**，只提供 session 身份用于恢复
- 仲裁原则写在 `src/terminal/state.rs` 头部注释：避免两个真相源打架
- Claude hook 脚本坑位（`src/integration/assets/claude/herdr-agent-state.sh:52-57`）：SubagentStop 可能在主轮结束后才到，绝不能复活 idle pane；子 agent 事件直接忽略

**防抖状态机**（`src/pane/agent_detection.rs`）
- 300ms tick（待确认 idle 时提速 100ms）
- working → idle 需连续 3 次确认（上限 700ms）吸收渲染间隙假 idle；屏上出现可见 idle chrome（❯ 提示框）立即放行
- agent 启动 3 秒宽限期，防启动画面闪烁误判
- PTY 内容序号（AtomicU64）未变 + idle 时跳过整个屏幕扫描
- agent 切换时清空 OSC 状态；进程退出强制 idle

**"done" 状态与聚合**
- 内部只有 Idle/Working/Blocked/Unknown；"done" 是 UI 概念 = Idle + `seen == false`
- 聚合优先级：`Blocked(4) > Done(3) > Working(2) > Idle已看(1) > Unknown(0)`，逐级 rollup 到 tab/workspace

### 6. Agent 原生会话恢复（用户价值极高）

- hook 上报的 session id 持久化到 `session.json`，重启后对 claude pane 自动 `claude --resume <id>`、codex 执行 `codex resume <id>`（15 个 agent 的恢复命令表见其 docs session-state.mdx）
- **进程死了但对话没丢**——OmniTerm 场景：tmux server 重启 / 机器重启后恢复 agent 对话
- session id 来源：Claude hooks 的 `session_id` 字段或 `~/.claude/projects/`
- 快照写入：tmp+rename 原子写 + 手动解析 symlink（照顾 stow 用户）

### 7-9. Socket API 设计

- 逐行 JSON，socket 0600 权限即认证；全协议 derive `schemars::JsonSchema` 自动导出 JSON Schema，agent 可自举学习协议
- 全局事件环形缓冲（512 条 + 单调 sequence），`events.subscribe`/`events.wait` 断点续读
- `session.snapshot` 客户端 bootstrap 快照 + 之后事件增量——对 OmniTerm 就是 WS 初始快照 + 增量事件的前端同步模型
- **反竞态**：`agent.wait --until done|blocked` 会 pin 住被等待 pane 的占用者（agent 被换掉不能冒充满足等待）；`agent.prompt` 内嵌 wait 对象，一个请求完成"发 prompt + 等结果"
- 每个 pane 注入 `HERDR_ENV=1`、`HERDR_PANE_ID`、`HERDR_SOCKET_PATH` 等——pane 里的 agent 天然知道"我是谁、怎么回连"
- 随二进制分发 `SKILL.md` 教 AI agent 使用 API

### 10. Manifest 远程热更新

- 从 `https://herdr.dev/agent-detection/index.toml` 拉取（系统 curl，限 256KB）
- 本地覆盖目录 `~/.config/herdr/agent-detection/<agent>.toml` 永远优先
- 解决 "agent CLI 改 UI 不用等发版" 的问题

### 11. 测试策略

- 检测防抖逻辑全部拆成 `decide_*` 纯函数单测；仲裁逻辑文件一半篇幅是测试
- 真实端到端：在 PTY 里 spawn 真二进制打真 socket，配 PID 注册表 + watchdog 防泄漏
- **OmniTerm 最应照搬**：录一批 Claude/Codex 的真实 capture-pane 文本当 fixture，规则改动跑回归

### 12. 安全考量

- 屏幕历史回放（scrollback 持久化）默认关闭且 opt-in，理由：**输出可能含密钥**
- socket 文件 identity（dev+ino）防误删他人 socket；事件 hub 有界防内存膨胀

## 与 OmniTerm 需求的映射

- 检测体系（#1-5）对应 requirements.md 中 agent 状态感知方向，是 OmniTerm 区别于普通 web terminal 的核心能力
- 移植路径：`tmux display -p '#{pane_pid}'` 找前台进程组 → `tmux capture-pane -p` 底部快照 → TOML 规则引擎 + 防抖 → Sidebar 状态徽标（Blocked > Done > Working 聚合）
- `#{pane_title}` 可拿到 OSC 标题，作为廉价 working 信号（Claude spinner 标题）
- P1 hooks：Claude Code hooks（Notification/Stop/PermissionRequest）POST 到 Axum 端点
