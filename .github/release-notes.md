# OmniTerm v0.2.5 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 新增 oh-my-pi（omp acp）与 qoder / qoder cn 内置 ACP 预设，`--acp` 模式下可直接选用
- GIT 面板 diff 抽屉新增「在编辑器中打开」：diff 标题栏铅笔按钮一键跳转文件编辑器
- ACP 聊天气泡 hover 显示消息系统时间（当天 `HH:mm`，跨天 `MM-DD HH:mm`，跨年完整日期）
- 聊天气泡标识行（USER/agent 名）视觉增强，与气泡区隔更明显

## 重要修复

- 修复切换 tmux 会话时终端闪烁（~250ms 黑屏/重绘抖动）
- 修复 ACP 会话取消后 agent 尾部输出不落库（刷新后取消前最后一段缺失）
- 修复移动端 ACP 会话底部不可见、切换会话时输入区被裁切
- 修复 ACP 恢复会话期间 WS 断线导致聊天界面永久冻结
- 修复 agent 输出结束后前端仍显示「运行中」、收不到结束信号
- 修复 ACP 权限审批在别处应答后其余连接 banner 不消失
- 修复 thinking / 工具调用块大量流式更新时滚动条不锚定底部

## 工程改进

- Claude / Codex 预设改用社区 ACP 适配器（`@agentclientprotocol/*-acp`）
- README 默认改回英文，中文版移至 `README_ZH.md` 并中英同步润色
- 文件抽屉默认高度改为视口 50%；FileDrawer/GitDrawer 共享骨架抽取为 DrawerShell
- 清理确定的死代码（GitBranchIcon 组件、pixelAnimations、3 个未使用依赖）

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.4...v0.2.5
