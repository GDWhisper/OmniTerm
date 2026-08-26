# OmniTerm v0.2.18 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **文件管理器「在此打开终端」**：FileManager 工具栏新增按钮，在文件管理器当前目录下直接新建 pty 终端会话并激活，浏览目录后一键切换操作，无需手动开终端再 cd。

## 重要修复

- **修复 pty 终端快速输入丢行**：连按回车丢多行、切换会话才补全的问题——前端改为按序渲染全部积压 diff 帧（有界队列 + resync 重同步握手兜底），连按 100 次回车可见屏无缺行。
- **修复 pty 终端输出「不实时」**：cell_frame 编码改为收到输出事件即推送（此前 33ms 定时器盲区把快速输入攒进同一帧、行突然出现），回车→上屏延迟从 ~11ms 降到 ~3.7ms。

## 工程改进

- **数据库默认隔离加固**：开发构建（debug / `target/` 产物）不传 `--db` 时默认连 `omniterm-dev.db`，杜绝开发二进制裸跑静默污染正式版数据库。

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.17...v0.2.18
