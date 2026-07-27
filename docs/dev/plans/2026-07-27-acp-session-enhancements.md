# ACP 会话功能增强计划

> 状态：进行中 — F01 已完成（2026-07-27），其余待实施
> 触发条件：2026-07-27 功能审查，对比业界主流产品（Cursor / Cline / Aider / Copilot Chat / Claude Code）识别出高中优先级缺口
> 关联：`docs/dev/plans/2026-07-20-acp-quality-gap.md`（测试基建）、`docs/architecture/frontend-patterns.md`（新组件模式）

---

## 1. 背景

当前 ACP 会话已覆盖完整生命周期（create / release / restore）、结构化流式渲染（text / thought / tool / plan / todo）、权限审批、配置下拉、斜杠命令、N=1 消息队列、用量环、终端活动流、跨厂商协议适配。核心通路成熟，但对比业界标配功能仍有明显缺口，集中在三个方向：

1. **审批信息密度不足** — permission banner 只有 toolName + allow/reject，用户盲批
2. **输入能力单一** — 只支持纯文本 prompt，无图片/文件附件、无 @ 引用
3. **会话操控原始** — 消息不可编辑/重生成、无搜索、无导出、标题无意义

---

## 2. 范围与优先级

### 2.1 P0 — 核心体验补齐（预计 6 天）

| 序号 | 功能 | 要点 | 预估 |
|------|------|------|------|
| F01 | Permission banner diff 预览 | 审批时展示文件变更内容，复用现有 DiffView；不新增拦截层，仅增强已有 permission 流程的信息密度 | 1.5d |
| F02 | 消息编辑与重新生成 | 用户消息可编辑后重发；assistant 回复可 cancel + 重发上一条触发重生成 | 2d |
| F03 | 图片附件 | ChatInput 支持粘贴/拖拽图片，prompt 组装加入 `ContentBlock::Image`（base64）；后端 `send_prompt` 扩展为多 content block | 2.5d |

**小计：6d**

### 2.2 P1 — 上下文增强（预计 5 天）

| 序号 | 功能 | 要点 | 预估 |
|------|------|------|------|
| F04 | @ 引用文件/符号 | 输入框 `@` 触发自动补全（复用 FileManager 文件树 + 后端符号搜索）；选中后注入文件内容或路径引用到 prompt | 3d |
| F05 | 检查点 / 回滚 | agent 工具调用（write/edit/delete）前自动 `git stash create` 快照；ChatView 显示检查点时间线；一键 `git stash apply` 回滚。提供全局开关，默认开启 | 2d |

**小计：5d**

### 2.3 P2 — 质量-of-life（预计 3.5 天）

| 序号 | 功能 | 要点 | 预估 |
|------|------|------|------|
| F06 | 会话内搜索 | Ctrl+F 唤起搜索栏，匹配消息文本，高亮 + 跳转 | 1d |
| F07 | 浏览器桌面通知 | attention 事件（done / error / decision）触发 `Notification` API；设置面板开关 | 0.5d |
| F08 | 会话导出 Markdown | ChatView 工具栏按钮，将结构化 blocks 序列化为 Markdown 下载 | 0.5d |
| F09 | 自动会话标题 | 首次 prompt_done 后取用户消息前 40 字符作为 session name（调 rename API）；可选手动覆盖 | 0.5d |
| F10 | 上下文窗口组成可视化 | 用量环 hover 展示分类占比（system / history / tool output）；依赖 agent 是否上报细分 usage，不支持时降级为当前总量展示 | 1d |

**小计：3.5d**

---

## 3. 设计决策

### 3.1 F01 Permission diff 预览 — 增强而非拦截

- **原则**：agent 走 `RequestPermissionRequest` 时增强展示；agent 在 yolo/auto mode 下不发 permission request，OmniTerm 不干预
- **数据来源**：permission request 的 `tool_name` + `tool_input` 中通常包含 `path` / `content` / `diff` 字段；前端解析后渲染
- **渲染**：`tool_input` 含 diff → 复用 `DiffView`；含完整 content → 代码高亮预览；无内容 → 保持当前纯文本 banner
- **不新增后端拦截**：不在 `WriteTextFileRequest` handler 里加审批逻辑

### 3.2 F02 消息编辑与重新生成 — UI 层语义

ACP 协议无"编辑历史消息"概念，实际语义：

- **编辑用户消息**：进入编辑态 → 修改文本 → 作为**新 prompt** 发送（等同于用户重新输入）；原消息保留但标记 `edited`
- **重新生成**：cancel 当前 in-flight → 取最后一条用户消息文本 → 重新 `send_prompt`；assistant 回复追加而非替换（保留历史）
- 不实现"分支对话"（复杂度过高，不在本轮范围）

### 3.3 F03 图片附件 — base64 内联

- ACP `ContentBlock::Image` 支持 base64 data URI，无需文件上传 API
- 限制：单张 ≤ 5MB，单次 prompt ≤ 3 张（防止 WS 帧过大）
- 粘贴（`onPaste` clipboardData）+ 拖拽（`onDrop`）两种入口
- 预览缩略图显示在输入框上方，可逐张移除

### 3.4 F04 @ 引用 — 渐进式

- **Phase A**（本轮）：`@` 触发文件路径补全（复用 FileManager 已有的文件列表 API），选中后在 prompt 文本中插入 `@path/to/file` 标记；发送时后端读取文件内容拼入 prompt context
- **Phase B**（后续）：符号级补全（函数/结构体），需后端新增符号搜索 API
- 补全 UI 复用 ChatInput 已有的斜杠命令弹窗模式（OverlayScroll + 键盘导航）

### 3.5 F05 检查点 / 回滚 — git stash 方案

- **触发时机**：WS handler 收到 `ToolCall` / `ToolCallUpdate`（kind = write / edit / delete）时，在执行前调用 `git stash create`（不修改工作区，只生成 commit hash）
- **存储**：session 级检查点列表存内存（`Vec<Checkpoint>`），含 timestamp + stash hash + 触发工具描述
- **回滚**：`git stash apply <hash>` + `git stash drop <hash>`
- **开关**：Settings 面板全局开关 `enableCheckpoints`，默认 true；非 git 仓库自动禁用
- **不自动清理**：session 释放时检查点列表丢弃，stash 条目保留（用户可手动 `git stash list` 管理）

### 3.6 F10 上下文组成 — 降级策略

- ACP `UsageUpdate` 当前只有 `input_tokens` / `output_tokens` / `cost` 等总量字段
- 部分 agent（如 codebuddy）在 `_meta` 中上报细分数据；不支持的 agent 降级为总量展示
- 不为了可视化而向 agent 发额外请求

---

## 4. 实施计划

### Phase 1 — P0 核心体验（Day 1~6）

| 天 | 任务 | 产出 |
|----|------|------|
| D1 | F01: permission request 解析 + DiffView 集成 | PermissionBanner 支持 diff/content 预览 |
| D2 上午 | F01: 多 vendor permission 格式适配 + 测试 | 覆盖 codebuddy / ccb / opencode 的 tool_input 差异 |
| D2 下午 | F02: 消息编辑 UI + 重发逻辑 | ChatMessage 编辑态、edited 标记 |
| D3 | F02: 重新生成 + cancel 联动 + 队列兼容 | regenerate 按钮、与 N=1 队列的交互 |
| D4 | F03: 后端 send_prompt 多 content block | `PromptRequest` 支持 `Vec<ContentBlock>` |
| D5 | F03: 前端粘贴/拖拽/预览/移除 | ChatInput 附件区 |
| D6 | F03: 联调 + 边界（超大图片、非图片文件、WS 帧限制） | 完整可用 |

### Phase 2 — P1 上下文增强（Day 7~11）

| 天 | 任务 | 产出 |
|----|------|------|
| D7 | F04: @ 补全 UI（复用斜杠命令弹窗模式） | 输入框 @ 触发文件列表 |
| D8 | F04: 后端文件内容注入 + prompt 组装 | @ 引用端到端可用 |
| D9 | F04: 边界（二进制文件、大文件截断、权限） | 健壮性 |
| D10 | F05: git stash 检查点后端（stash create / apply / drop） | 检查点 API |
| D11 | F05: 前端时间线 UI + 回滚交互 + 设置开关 | 检查点端到端可用 |

### Phase 3 — P2 质量-of-life（Day 12~14.5）

| 天 | 任务 | 产出 |
|----|------|------|
| D12 上午 | F06: 会话内搜索 | Ctrl+F 搜索栏 |
| D12 下午 | F07: 桌面通知 + F09: 自动标题 | 两个小功能 |
| D13 上午 | F08: Markdown 导出 | 下载按钮 |
| D13 下午 | F10: 上下文组成可视化 | 用量环增强 |
| D14 | 缓冲 / 联调 / 手工回归 | 全量验收 |

---

## 5. 验收标准

1. Permission banner 在 agent 走 permission 流程时展示 diff/内容预览；yolo mode 下无额外拦截
2. 用户消息可编辑重发，assistant 回复可重新生成，与 N=1 队列无冲突
3. 图片可粘贴/拖拽入 prompt，agent 正确接收 image content block
4. @ 文件引用补全可用，大文件/二进制有合理降级
5. 检查点在 git 仓库中自动创建，回滚后工作区恢复正确；非 git 仓库不报错
6. Ctrl+F 搜索、桌面通知、Markdown 导出、自动标题、用量组成各功能独立可用
7. 所有新功能不破坏现有 tmux 会话流程
8. `cargo clippy` / `tsc --noEmit` 零新增警告

---

## 6. 不纳入范围

- **对话分支 / 多版本回复**：复杂度过高，需重新设计消息模型，不在本轮
- **符号级 @ 补全（Phase B）**：需后端新增索引，留给后续迭代
- **多 agent 协同**：架构层面变动大，单独立项
- **LaTeX / Mermaid 渲染**：受众窄，触发再加
- **消息级 token 统计**：依赖 agent 上报粒度，当前协议不支持

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 各 agent permission request 的 `tool_input` 格式不统一 | F01 diff 预览可能部分 agent 无数据 | 降级为纯文本 banner（现状），逐 vendor 适配 |
| 图片 base64 导致 WS 帧过大 | 连接断开或延迟 | 前端压缩 + 5MB 硬限 + 3 张上限 |
| `git stash create` 在 dirty worktree 上的行为 | 检查点可能包含用户未提交的改动 | 文档说明 + 仅 stash create（不改工作区） |
| 重新生成与 N=1 队列的竞态 | 队列消息可能在 regenerate 期间被 drain | regenerate 期间暂停 queue drain，完成后再恢复 |
