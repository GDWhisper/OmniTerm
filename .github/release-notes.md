# OmniTerm v0.3.3 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- GIT 面板能力补齐：分支重命名 / 删除（可同时删除上游远程分支）、STASH 面板（列表、带备注暂存、Apply / Pop / Drop）、HISTORY 提交右键菜单（复制 SHA、cherry-pick、revert、soft/mixed reset），提交框新增 AMEND 与「提交并推送」。
- AI 生成提交信息：设置页可选 OpenAI 兼容或 Anthropic 接口并拉取模型列表，API key 保存在本地受限文件或用 `$ENV_VAR` 引用服务端环境变量；提交框 GENERATE 只发送 staged diff，已有文字时可选择替换或追加。
- ACP 会话浏览位置记忆：切走会话再回来会回到离开前正在读的位置（上翻浏览中），回到底部、发送或重新生成后不再恢复。

## 重要修复

- 修复 ACP 后台任务（Workflow / 后台 Bash）运行期间被空闲回收：现在跟踪任务生命周期，任务未结束不再按 idle 阈值关闭 agent；同时修复手动恢复会话重放被断线打断后不自动续传、恢复期发送 prompt 产生空消息。
- 修复 GitHub API 匿名配额耗尽导致正式版静默收不到更新提醒：主源失败时按安装渠道降级到无配额限制的版本源，npm 一键升级同样可降级继续。
- 修复 ACP 会话切换后的滚动位置错乱（贴底态不复位、加载更早历史时的陈旧锚点串台）。

## 工程改进

- ACP system 告知改为嵌流信息面板（细分隔线 + ※ 标记、两主题均过 AA 的文字色），详情预览使用统一滚动容器。
- ACP 思考块完成态标题统一为「深度思考」，不再显示块内耗时。
- 权限请求超时设为「自动推进 + 总是」时不再发送决策通知（无接收人）。

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.3.2...v0.3.3
