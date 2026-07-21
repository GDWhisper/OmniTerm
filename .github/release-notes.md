# OmniTerm v0.1.9 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **ACP 智能体聊天视图**：富文本渲染助手回合 —— Markdown、思考块、工具调用卡片（运行中/完成/失败三态）、计划块，流式光标跟随文本块
- **Agent 配置管理**：侧边栏「新建会话」接入 Agent 选择器，Settings 新增 AGENTS 面板支持新建/编辑/删除 agent 配置，含 Claude/Codex/Gemini/OpenCode/Qwen/Kiro 预设模板与连接测试
- **ACP 会话配置工具栏**：mode / model / thinking 选择器 + 上下文用量环形图，切换即时生效（乐观更新，跨 agent 普适）
- **ACP 会话持久化与恢复**：基于 `session/load` 协议恢复历史会话，聊天消息落库并在挂载时回填；进程释放后可「恢复会话」重新拉起
- **斜杠命令自动补全**：透传 agent 提供的 description / hint，下拉框命令名旁展示描述

## 重要修复

- **inotify 泄漏根治**：修复 `/api/v1/files/watch` 的 watcher 不释放导致 fd 长期增长撑满系统上限（曾 5 天累积 1320 个）
- **ACP 子进程泄漏根治**：新增优雅退出钩子回收子进程、空闲回收看护任务（reaper）、会话「释放」按钮与 WS 事件驱动的进程存活指示灯
- **ACP 权限审批失效**：兼容 agent 返回 camelCase / snake_case 两种 `optionId` 命名，点击 Allow 不再发空值导致 60s 超时回退 deny
- **配置切换跨 agent 同步**：消费 `set_config_option` 响应与合成的 `ConfigOptionUpdate` 广播，非 codebuddy agent 也能刷新配置 UI
- **重连按钮概率性失效**：防止终端实例并发重复创建，断连后稳定显示重连
- **ACP 断开/释放后即时恢复**：无需刷新页面即可显示「恢复会话」按钮，Sidebar 区分运行中/已释放会话

## 工程改进

- **许可证变更**：由 Apache-2.0 更换为 FSL-1.1-MIT
- **侧边栏图标体系**：PNG 像素图标统一替换为线性描边 SVG（复用 FileManager 风格，hover 变色、修复误用图标）

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.1.8...v0.1.9
