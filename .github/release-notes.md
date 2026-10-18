# OmniTerm v0.3.2 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- 新建项目弹窗的路径输入框右侧新增文件夹图标，点击调起系统原生目录选择器（Windows 资源管理器 / macOS Finder / Linux zenity），鼠标点选目录后自动回填——不用再手敲绝对路径；仅本机访问可用，远程访问会提示改用弹窗内目录浏览器。

## 重要修复

- 修复右下角 toast 提示被弹窗半透蒙版遮住的问题（新建项目弹窗触发报错时提示看不清）。
- 修复 ACP 会话中系统告知（权限超时、自动审批等 SYSTEM 消息）在刷新 / 重新打开后整批置底：现在按 turn 内的真实顺序内联到对应位置，mid-turn 告知还会随过程容器一起折叠。
- 修复 ACP 进行中 turn 的时间 / tok/s 读数在同一条消息被切成多个气泡时重复显示。
- npm 渠道一键升级：镜像逐包同步滞后导致装不上新版的静默失败，现在会自动改用官方源重试一次。

## 工程改进

- ACP mid-turn 系统告知收进过程容器、随工作块一起折叠：结论之前的只读 system 块并入收纳行，聊天区不再被零散告知行打散。

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.3.1...v0.3.2
