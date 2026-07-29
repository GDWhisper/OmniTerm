# OmniTerm v0.2.2 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 重要修复

本版本集中修复 Windows 平台可用性问题：

- 修复 Windows 上终端会话只显示「已附加」、完全无法输入的问题（psmux 链式命令不进入交互 attach）
- 大幅降低 Windows 会话切换延迟（escape-time 设置改为一次性缓存 + 异步执行）
- 修复侧边栏展开项目明显卡顿：前端展开不再被网络请求阻塞，后端 git 探测并发化
- 修复 Windows 工作区路径显示异常（`/g:/Codes` 多前导斜杠）及路径尾部斜杠被 bidi 重排到开头的显示错误
- 修复浏览 Windows 用户主目录返回 500：不可读条目（ACL 拒绝的遗留 junction）现被跳过
- 修复 `dev.ps1` stop/restart 永久挂死及进程树杀不干净的问题

## 工程改进

- Windows 上创建会话弹窗的终端类型按平台显示为「psmux」，避免与 tmux 混淆

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：从 Releases 下载对应平台 binary 覆盖，或运行 `omniterm update` 一键升级

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.1...v0.2.2
