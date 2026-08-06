# OmniTerm v0.2.11 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 重要修复

- 修复工作区内编辑/保存文件仍误弹「文件不在当前工作区内」二次确认：越界判断改基于实际浏览目录，并增加 worktree / git toplevel 回退探测，跨 worktree 浏览与 tmux 临时 cd 不再误报
- 修复文件改名后图片预览显示「加载失败」：drawer 预览路径随改名同步更新，内部改名与 tmux/IDE 外部 `mv` 均覆盖
- 修复已释放会话发送消息报原始库错误 `connection is no longer running`：自动恢复路径只在会话加载成功后发送，进程已释放时给出可操作提示（重新发送即自动恢复）
- 修复 ACP 会话旧通知残留：继续发送新 prompt 后不再反复弹出旧 done/error/decision 提醒

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.10...v0.2.11
