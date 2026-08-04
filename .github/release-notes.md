# OmniTerm v0.2.9 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 设置 → 会话新增「自动断连/释放超时」调节：ACP 空闲回收、tmux 失焦断连、tmux 空闲断连三个超时均可按分钟滑块调整（1–60 分钟），运行时热更新无需重启
- ACP 会话「发送即自动恢复」：进程被回收/释放/后端重启后，无需先点「恢复会话」，直接发送消息即自动拉起 agent 并重放历史

## 重要修复

- 修复 npm Windows 二进制启动报 `migration was previously applied but has been modified`：强制 migration 文件 LF 换行，消除 Windows CI checksum 与 crates.io 包不一致

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.8...v0.2.9
