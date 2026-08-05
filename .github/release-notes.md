# OmniTerm v0.2.10 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 新增 Pty 原生运行时（runtime_kind=pty）：会话可直接由后端通过 portable-pty 创建，不依赖 tmux，为无 tmux 环境提供全新终端通道
- 文件管理「跳过越界确认」：写操作越界时确认框提供「跳过」选项直接放行，受信操作无需逐次确认
- 新增 `omniterm start --debug`：无需配置 `RUST_LOG` 即可开启调试日志，正式版默认不再刷屏

## 重要修复

- 修复 ACP「发送即自动恢复」在进程刚释放后无效：连接活性误判导致自动恢复分支永不触发，现与手动「恢复会话」行为一致
- 修复 `sanitize_path_new` 多层缺失目录拼接反序：`a/b/c` 曾错误解析成 `a/c/b`，影响多层新目录的 mkdir/嵌套写入/越界移动
- 修复正式版默认输出 DEBUG 日志：日志级别尊重 `RUST_LOG`，未设置时默认 `omniterm=info`

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.9...v0.2.10
