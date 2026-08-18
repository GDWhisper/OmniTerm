# OmniTerm v0.2.16 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 重要修复

- 修复 ACP 会话幽灵行：前端离线时 turn 残留原始帧、刷新时重放帧与历史竞态导致重复插入 assistant 消息；现重放帧纳入 hydrate 门控、RAW 残留以带行 id 的 cooked 形态回写收敛。
- 权限请求超时回收时写入并广播 system 消息：30 分钟无人审批被强制回收不再静默消失，聊天会话内明确告知回收原因。
- 修复移动端滑动聊天上下文时长按误触气泡功能菜单：滚动即取消长按计时、滚动停止后冷却期内不启动新长按，避免循环弹菜单。

## 工程改进

- `/files/watch` SSE 事件去抖：后端 100ms 窗口按 `(kind, path)` 去重合并批量下发，前端 500ms 防抖刷新、切到 GIT tab 时断开 SSE 注销 watcher，降低目录树 watch 与全量列表请求放大。

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.15...v0.2.16
