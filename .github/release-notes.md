# OmniTerm v0.2.8 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- ACP 会话底部配置（mode / model / thinking / config 选择器）持久化记忆：改过的配置在进程回收、后端重启、新会话后自动恢复，前端零改动
- 非 git 仓库项目创建 worktree 时引导初始化 git（含 .gitignore 缺失警告，避免误提交大文件/敏感文件）

## 重要修复

- 修复移动端 tmux 终端右侧竖向黑条与行尾换行字符截断，分辨率自适应方案让末列在任何视口宽/字体下都稳定渲染
- 修复长 ACP 任务 CPU 脉冲/内存暴涨/DB 膨胀：帧累积改有界窗口，杜绝 O(n²) 全量序列化
- 修复 ACP 会话回收/释放/删除时子进程残留：统一强制 kill，Sidebar 状态与实际进程保持一致
- 修复移动端滚动模式状态漂移：滚动按钮高亮与 tmux 实际状态同步，退出滚动不再向 shell 注入字符
- ACP 流式输出期间 markdown 降级纯文本渲染，显著降低流式阶段 CPU 占用

## 工程改进

- Sidebar.tsx 从 2,618 行拆分为 14 个自持状态的子组件/模块，目录浏览逻辑收敛为共享 hook，行为零变化

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.7...v0.2.8
