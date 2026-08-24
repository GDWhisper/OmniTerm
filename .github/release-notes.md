# OmniTerm v0.2.17 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **ACP 会话归档**：对话侧栏会话行新增「归档」操作，释放 agent 子进程并将会话移至底部「已归档」区块（跨项目聚合入口），聊天记录完整保留。支持取消归档恢复或彻底删除。运行中 agent 归档前弹出确认。
- **创建会话支持引擎选择**：创建无 agent 的终端会话时可选择 pty（默认，自管终端）或 tmux（后端重启幸存）。系统无 tmux 时 tmux 选项自动禁用并提示。pty 会话支持直接拖选复制，tmux 会话保留 prefix 键位与 copy-mode。
- **pty 会话 agent 状态实时感知**：内置 agent（Claude/Codex/Qoder）的生命周期状态（thinking/running/idle）通过本地 HTTP 回调即时上报，不再依赖屏幕检测推测。Hook 存活期内状态权威，死后自动降级。

## 重要修复

- **移动端软键盘与底部导航间距**：修复 Android Chrome 软键盘弹出后底部导航与输入法之间出现一段白屏的问题，重新声明 `interactive-widget` 策略修复布局视口计算。
- **pty 会话重连画面花屏/错位**：修复增量绘制型 agent TUI 在重连后转义序列落在错误位置导致花屏，补屏帧改为服务端 VT grid 为真相源的整帧重画方案，同时移除有副作用的 resize nudge。

## 工程改进

- **cell-frame 编码行级 diff（BigWin）**：服务端对 grid 每行做 hash，内容未变的行跳过 JSON 序列化，仅下发变化行索引。前端不再清屏，逐行局部更新。光标四元组 diff 记忆减少写入抖动，DECSCUSR 形状码随帧下发。新增 `engine/metrics.rs` 为可观测 dashboard 提供编码字节数 hook。
- **一键升级后自动重启**：Unix 上更新成功即自动重启生效，前端显示倒计时并刷新页面；Windows 维持手动提示。容器环境自动禁用一键升级。
- **升级通知至少不再跳版本号**——unreleased 条目已整理归档

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.16...v0.2.17
