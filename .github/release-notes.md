# OmniTerm v0.2.21 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 重要修复

- **TUI（Antigravity CLI 等）延迟刷新状态后 logo/版面两行变形错位**：编码侧把 TAB cell 归一化为空格，避免透传给 xterm.js 时被解释为 HT 跳位导致行整体右移与行尾 wrap
- **Emoji 像素方块 Logo（⬛⬜等）整体压扁错位**：前端加载 Unicode11Addon 激活 `'11'` 宽表，列宽与后端 alacritty 完全对齐，消除宽字符逐列累积偏移
- **pty 终端光标在打字间歇闪跳右下角**：渲染帧行内容后按 terminal 实例回写最近一次真实 cursor，抵消全帧重画对终端光标位置的视觉污染
- **pty 会话 mid-stream 状态行残留偏移**：直写 error/exit 状态行后立即触发 resync 重同步，全帧重画抵消换行滚动的副作用
- **终端会话不再继承宿主 SSH 泄漏变量**：后端派生的本地终端、tmux client 及命令源头剥离 `SSH_CLIENT` / `SSH_CONNECTION` / `SSH_TTY`，彻底解决 agy 等 CLI 被误判为 SSH 远程会话而要求重复登录的问题
- **npm 渠道一键升级自动重启静默失败与日志劫持**：自重启链增加存在性预检与规范化路径回退，`RUST_LOG` 增加底层保底指令消除日志盲区

## 工程改进

- **pty 增量同步加固（周期全帧对账 + 帧序号断链检测）**：live 帧携带递增 `seq` 并在断链时主动发 `resync`，服务端每秒按连接强制下一帧全帧，丢帧或基线失配可见延迟收敛至 ≤1s，增量镜像具备完全自愈能力
- **ACP 图片附件管道无限制与缩略图轻量化**：移除数量、尺寸上限与 MIME 类型限制；落库与气泡渲染统一改用前端轻量缩略图（约 30~40KB），大幅降低数据库膨胀与高分辨率位图的显存开销
- **侧栏项目卡片「创建 worktree」图标调整**：操作图标由加号（`IconPlus`）改为 Git 分支样式（`IconGitBranch`），使仓库级分支与会话级新建（+）在视觉语义上清晰区分

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖
- Docker：`docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.21`
- npm：`npm install -g @gdwhisper/omniterm`（升级后如终端显示异常，请强刷浏览器）

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.20...v0.2.21
