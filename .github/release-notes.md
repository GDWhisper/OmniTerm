# OmniTerm v0.2.4 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- ACP 会话消息后端权威持久化：agent 流式输出期间刷新页面 / 切换设备不再丢失进行中对话，重连后从数据库无缝续接
- 认证安全加固：随机 JWT 密钥、登出/改密即吊销全部已签发 token、登录失败限流；新增「密码验证」总开关（默认关闭，可自行开启）
- 移动端交互优化：终端触摸拖动滚动、标签页跟手滑动切换、触觉反馈开关、横屏自动隐藏虚拟键栏、长按终端粘贴菜单
- 设置新增「会话」分类（思考/工具调用自动展开开关）与「tmux mouse mode」开关；聊天气泡显示 agent 实际名称

## 重要修复

- 修复移动端软键盘收起后整页底部被裁切、弹窗错位被裁出屏幕的问题
- 根治 tmux status bar 内容间歇泄漏进终端 scrollback（xterm scrollback 归零）
- 修复 ACP 长会话恢复后聊天记录被清空（后端并发重放 + 前端双缓冲原子提交）
- 修复 ACP 审批 60 秒无人响应即被自动取消的协议违规
- 修复移动端虚拟键栏按键大小不一，改为等宽均分 + 9 列网格对齐

## 工程改进

- ACP 消息持久化 Phase 1：`chat_messages` 流式落库原语 + turn 内单调 seq + `turn_snapshot`/`turn_state` 重连对账
- `session_update` broadcast 容量 256→4096，进一步压低慢消费者丢帧概率

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`omniterm update`、`npm update -g @gdwhisper/omniterm` 或 `cargo install omniterm`

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.3...v0.2.4
