# OmniTerm v0.2.6 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- ACP agent 命令解析：PATH 优先 + 私有目录回退 + 首次使用自动 npm install（lazy install），消除 npx 启动延迟
- Agent 表单新增 npm 包名字段（高级选项），预设 agent 的依赖包可查看/修改
- 内置 ACP 预设新增 Pi（`pi --acp`）
- README 安装方式区块默认展开，不再折叠

## 重要修复

- 修复 ACP 会话 agent 已输出结论但前端永久卡在运行中（turn 结束信号丢失）：订阅时序修正 + reaper 卡死兜底
- 修复 resolve 对用户自定义 command 误触发 npm 查找：仅预设 agent 走解析，手填 command 直接透传

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.5...v0.2.6
