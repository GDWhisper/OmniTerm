# OmniTerm v0.2.3 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 恢复 npm 分发渠道：`npm install -g @gdwhisper/omniterm`，采用原生平台分包，安装时只拉取当前平台的 binary

## 重要修复

- 修复登录页主按钮零样式、面板双重边框的问题
- 修复侧栏默认宽度过窄导致分支名 / 会话名被截断不可见
- 修复文件管理器默认列宽溢出导致大小列不可见、日期被裁断
- 修复连接状态徽标中文文案被挤压成竖排堆叠

## 工程改进

- UI 像素风统一：弹窗、Toast、滑杆、徽标等控件硬角化，删除重复局部实现
- 侧栏行内操作按钮改为 hover / 键盘聚焦时显现，降低常驻视觉噪音
- 修复公开仓 CI audit job 恒红（check-doc-index 改为条件执行）

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`omniterm update`、`npm update -g @gdwhisper/omniterm` 或 `cargo install omniterm`

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.2...v0.2.3
