# OmniTerm v0.2.14 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 自管 pty 会话引擎（Phase 2）落地：WS 断开不杀进程、重连自动补屏、后端重启后按最后 cwd 重建会话并回放历史
- Agent 预设新增 CodeBuddy：`codebuddy --acp` 一键以 ACP 模式启动 CodeBuddy Code
- ACP agent 的 API key 改为从 `~/.omniterm/api_keys.toml` 统一读取，正式版（systemd / docker）不再依赖 shell 环境透传

## 重要修复

- 修复正式版在某些终端里 `omniterm start` 必然报 `Address already in use`：后端不再读取会被开发环境劫持的通用名环境变量（只认 `OMNITERM_*` 前缀）
- 修复开启密码验证时被立即踢回登录页，改为在设置界面就地设置密码
- 修复文件拖拽悬浮预览不贴鼠标（界面缩放 ≠ 100% 时越拖越远）
- 修复「新建项目」弹窗第二次打开起目录浏览区持续显示空目录
- ACP 聊天正文 `text` 列收口为有界（1 MiB），超大 turn 不再 O(n²) 写放大

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.13...v0.2.14
