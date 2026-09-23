# OmniTerm v0.2.25 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **tmux 假死告警横幅 + 一键重建**：后端周期探测 tmux server 健康（连续 3 次确认假死才告警，防抖动误报），假死时顶部出现告警横幅与「重建 tmux server」按钮，点击即自动恢复（重建前再次确认确实假死才动手；重建会强制结束假死 server，其中的 tmux 会话会丢失，横幅文案已明示）

## 重要修复

- **tmux server 假死防护成套落地**（对应 2026-09-22 事故：tmux server 被历史残留的失控控制连接冻结成「半死」，所有新命令报 `server exited unexpectedly`，无人值守下无限期持续）：
  - 后端无论以何种方式消亡，其遗留的 tmux 控制连接由内核自动结束，不再无人认领地堆积（Linux；其它平台由启动对账兜底）
  - 后端每次启动扫描并清掉历史实例残留的失控控制连接，发信号前严格校验进程身份，PID 被复用时安全跳过、绝不误杀
  - `omniterm stop` 与 `dev.sh` 停止服务发信号前补进程归属校验，封掉 PID 复用误杀盲区
  - 孤儿控制连接堆积超警戒线时给出「已进入一 SIGTERM 就假死的高危状态」先兆警告
- **pty 会话滚轮在 opencode 等 TUI 中恢复**：TUI 启动时发的鼠标上报模式序列被 cell_frame 架构吞掉，前端滚轮既不编码上报也不本地滚动、完全失效（tmux 会话正常）；现补鼠标上报模式中继，会话切换后首帧自愈，TUI 恢复自身视口滚动
- **文件管理器一级目录可继续上翻**：在 `/home` 等一级目录点「上一级」↑ 此前静默失效（误判「没有父目录」），面包屑开头的 `/` 也从不可点击改为可点击的根段，顺带收敛 6 处路径拼接的 `//` 双斜杠隐患

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖
- Docker：`docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.25`
- npm：`npm install -g @gdwhisper/omniterm`（升级后如终端显示异常，请强刷浏览器）

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.24...v0.2.25
