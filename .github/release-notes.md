# OmniTerm v0.2.13 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- ACP 聊天中 agent 上报的文件路径可一键点开：工具调用里的文件直接跳转 FileManager 抽屉查看
- ACP 聊天历史游标分页加载：超大会话首屏加载从 15.9MB/843ms 降到 2.1MB/286ms

## 重要修复

- 聊天记录体积从源头收敛：turn 结束自动回写 cooked blocks，不再积累超大历史行（实测最大行曾达 900 万字符）
- 修复聊天历史回写互相污染：同文本历史行不再被同一份 blocks 串位覆盖
- 修复 Windows 上 `omniterm update` 与 Web 端一键升级对 npm 渠道必然失败
- 删除 worktree 时可一并删除其残留分支，不再污染「创建 Worktree」基准分支下拉
- 修复切到 ACP 会话时的卡顿（历史越多越明显）、弹窗内长路径/分支名溢出边框

## 工程改进

- 会话引擎解耦 Phase 1：tmux 模块移入 `src/engine/` 引擎边界、agent 检测体系提为公共模块、`SessionEngine` 抽象落地——为后续 pty 原生会话铺路，本轮行为零变化

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.12...v0.2.13
