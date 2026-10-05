# OmniTerm v0.2.27 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 设置 → 会话「权限请求超时」滑块新增「总是」（自动推进模式下权限请求一出现即自动放行）与 30 秒档位，时长单位由分钟改为秒（`permTimeout.ts` 统一口径）
- ACP 会话失焦（切标签 / 切窗口）后回来自动补拉最新消息，不再停留在旧对话
- ACP 聊天「上次输入」卡片与「回到底部」按钮在用户滑动消息区时淡出，腾出阅读带、静止后恢复可点

## 重要修复

- 修复移动端 ACP 会话切后台回来总是停在旧消息、须手动刷新（移动浏览器冻结页不补派 `onclose` 的双兜底）
- 修复 ACP 聊天里 agent 的 markdown 输出在聊天气泡里「挤成一团」（补齐段落 / 标题 / 列表 / 引用排版）
- 修复 ACP 流式读数：工具执行静默段不再计入 tps 分母，速度读数不再虚低
- 修复 release 二进制在含 `frontend/dist` 的目录启动时被静默改用文件系统旧前端、导致「重启后页面版本号仍是旧版」

## 工程改进

- ACP Rust SDK 升级 `agent-client-protocol` 1.3.0 → 2.2.0（零源码改动），补 ACP 协议链路测试（fake agent 用例 6 → 16）
- 前端 logo 像素资产收敛为单一真源 + 生成 / 校验脚本，移除 logo 底部支架底座

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.26...v0.2.27
