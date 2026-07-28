# OmniTerm v0.2.0 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **一键自更新**：新增 `omniterm update` 子命令与 Sidebar 新版本提醒 badge，检测到 GitHub 有新 release 时显示像素风 `NEW` 徽标，点击弹出升级面板，支持 GitHub Release / npm / cargo 多渠道自替换（sha256 校验 + 原子改名，杜绝半更新状态）
- **一键创建 git worktree**：Sidebar 项目行新增 `+` 按钮，弹窗填入分支名/目标路径/基准分支即可创建，后端 `POST /projects/{id}/worktrees` 执行 `git worktree add -b`
- **ACP 聊天能力增强**：输入框 `@` 引用文件（自动注入上下文，agent 未声明时降级内联）、已发送长消息可折叠、用户消息可编辑重发 / 最后一条助手消息可重新生成、支持粘贴拖拽图片附件（PNG/JPEG/WebP/GIF）
- **ACP 权限审批 diff 预览**：permission request 现解析工具调用数据，含 diff 复用彩色渲染、文本/入参降级只读预览，告别盲批
- **右侧栏 Git 管理面板**：FILES | GIT 标签路由，支持分支切换/新建、FETCH/PULL/PUSH、stage/unstage/discard、自研 unified diff 渲染与提交框
- **设置增强**：Settings 新增修改密码、逐项音效开关 + 试听、外观「像素字体（BETA）」开关
- **后台运行与绑定**：`omniterm start --daemonize`（Unix 守护进程化）、`--host` 指定监听地址

## 重要修复

- **根治 ACP agent 子进程孤儿**：修复 `omniterm stop` 时 `AcpSupervisor::shutdown_all` 因 WS 仍持有引用导致 `try_unwrap` 失败、清理被静默跳过，agent 进程残留占内存的问题
- **数据重置后持续 404**：修复服务端数据重置/删除后，localStorage 旧 project/workspace/session ID 永不清理导致文件列表等请求持续 404
- **终端 ESC 中止 agent TUI 延迟**：tmux `escape-time` 由 500ms 降为 10ms，快速连按 ESC 不再被合并为 Alt+ESC
- **终端缩放选区偏移 / 测试契约不符**：修复非 100% 缩放下 xterm 鼠标选取位置偏移；修正 `fs::sanitize_path` 测试预期与实现契约不符阻塞 CI 的问题

## 工程改进

- **UI 立体语言统一**：ACP 聊天列套用终端同款像素木框，所有浮层（Modal/Popup/Toast）从软阴影圆角改为像素硬阴影，清理残留模糊 glow
- **像素字距收归 token**：新增 `--pixel-tracking-sm/md/lg` 统一管理并整体收紧 0.5px，替换散落的硬编码字距
- **前端类型安全**：启用 TypeScript `strict: true` 并零错落地

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：从 Releases 下载对应平台 binary 覆盖，或运行 `omniterm update` 一键升级

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.1.9...v0.2.0
