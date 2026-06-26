# 需求清单

> 此文档仅在人工明确要求时更新，记录产品功能需求和待办事项。

**优先级说明：**
- 🔴 **高** — 近期重点实现
- 🟡 **中** — 正常排期
- 🔵 **低** — 锦上添花，不着急
- ⚪ **未明确** — 待讨论

---

## 使用指南 🔴

- [ ] **Sidebar 新增使用指南入口** — 在 Sidebar 设置齿轮旁边新增一个书本样式的图标按钮，点击后弹出 tmux 常用命令速查面板，帮助未接触过 tmux 的用户快速上手。

## 快捷键设置 🟡

- [ ] **插件化快捷键模式** — 通过 tmux 插件生态（如 tmux-sensible, tmux-pain-control 等）实现快捷键定制，OmniTerm 提供 UI 开关和插件管理，不重复造轮子。底层拦截代码已就绪（appStore.keybindingMode + useTerminal handler），等插件系统就绪后激活。

## 改动记录 ⚪

- [ ] **新增改动记录栏** — 在界面中新增一个「改动记录」面板，记录本次会话中改动过的文件和新增的文件，按时间倒序排列，支持点击文件名直接打开文件预览。

## Sidebar 便条 🔵

- [ ] **收起 Sidebar 后显示快捷便条** — 当 Sidebar 收起时，为每个项目、工作区、会话生成小便条（图标/缩略图），方便用户一键展开对应内容。
  - ⚠️ 待打磨：交互形式、视觉样式、信息密度需要进一步设计

## 通知功能 ⚪

- [ ] **任务状态通知** — 当终端任务发生以下情况时，向用户发送通知：
  - 任务完成
  - 任务意外中断（异常退出）
  - 任务死循环（长时间无输出或 CPU 占用异常）
  - ⚠️ 待定：具体检测方式（轮询 tmux pane 状态 / hook / 资源监控）
- [ ] **Sidebar 会话异常标记** — 与通知联动，当会话中的任务出现异常（中断、死循环等）时，在 Sidebar 对应会话项上显示醒目的视觉标记（如警告图标 / 颜色变化），方便用户快速定位问题会话。

## Agent 状态监控与通知 🔵

> 2026-06-26 讨论结论：监控/通知通道方案尚未确定，当前实现已注释下线，待方案明确后重启。

当用户在 tmux session 中运行 Claude Code / Codex 等 AI Agent 时，OmniTerm 希望可以实时感知其状态（running / waiting / idle / error）并通过 Sidebar badge、声音、标签页闪烁等方式通知用户。已讨论的技术方案包括：

### 方案 1：Agent Hook + tmux option（当前已实现但下线）
- **原理**：创建 session 时通过 `CreateSession.command` 或 wrapper 以带 hook 参数的方式启动 agent；agent 在生命周期事件触发时执行 `tmux set-option @omniterm_agent <state>`；后端轮询读取该 option。
- **优点**：状态准确、实时、实现简单。
- **缺点**：强依赖用户以特定方式启动 agent，限制用户自由；对已经手动启动的 agent 无法事后启用监控。

### 方案 2：tmux Control Mode 实时解析 pane 输出
- **原理**：Backend 为每个受监控 session 挂一个 `tmux -C attach-session` 长连接，监听 `%output` 等事件，实时重建 pane 内容并做启发式状态判断（spinner → running、prompt → waiting、shell prompt 回来 → done）。
- **优点**：不需要 agent 配合，用户可自由启动 agent。
- **缺点**：仍然是启发式识别，准确率依赖输出模式；多语言场景下识别难度高；需要维护长连接和重连逻辑。

### 方案 3：Agent Wrapper + OSC 9 主动上报
- **原理**：用 wrapper（或 PATH 拦截）启动 agent，将 agent 的 hook 输出从 `tmux set-option` 改为打印 OSC 9 转义序列（如 `\033]9;omniterm:<state>:...\033\\`）；Backend 通过 control mode / pipe-pane / capture-pane 捕获 pane 输出并解析 OSC 9。
- **优点**：通道通用、可跨终端、不依赖 tmux option。
- **缺点**：仍需要 wrapper/agent 配合；PATH 拦截侵入用户环境；OSC 9 解析需要处理转义序列边界。

### 方案 4：PTY Wrapper 全量 I/O 拦截
- **原理**：在 tmux 与 shell 之间插入一个 PTY wrapper，拦截所有输入输出，自主判断 agent 状态并注入上报标记。
- **优点**：不需要 agent 任何配合，用户完全自由。
- **缺点**：工程量大，相当于实现一个迷你 terminal multiplexer；维护成本高。

### 待定决策
- 是否需要支持「手动启动的 agent」事后监控？
- 是否接受 PATH wrapper / 启动参数等侵入式方案？
- 在准确率和用户自由度之间如何取舍？

**下一步动作**：待产品决策后，选择上述方案之一或组合方案进行实现。

## Multiplexer 引擎 ⚪

- [ ] **rmux 双引擎支持** — 新增 rmux 作为 tmux 的替代 multiplexer 引擎，逐步过渡为主引擎，tmux 降级为 fallback。
  - 项目地址：https://github.com/Helvesec/rmux
  - 需要抽象出统一的引擎接口（trait），tmux 和 rmux 各自实现
  - 配置项切换引擎选择
  - 后续计划：rmux → 主引擎，tmux → fallback
