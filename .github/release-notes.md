# OmniTerm v0.2.22 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **侧栏会话上下文菜单与批量操作**：会话行支持右键（桌面）/ 长按（移动端）弹出上下文菜单，统一收敛重命名并新增多选模式；底部状态栏切换为批量操作栏，支持批量**归档 / 释放进程 / 删除**，支持终端与 ACP 会话混选并带二次确认与跳过提示
- **ACP 聊天输入框「+」附件抽屉**：新增「相册」与「文件」抽屉卡片，移动端与桌面端均可便捷选择图片及任意文件附件；基于 base64 管道内联映射，不设张数与体积限制，落库仅存轻量元数据
- **ACP 消息实时 tps（token/s）读数**：流式生成期间在元信息行实时显示当前生成速度（tps），定稿后换算该轮平均 tps，由模块级 turnClock 直写 DOM，零额外 React 重绘开销
- **聊天区新消息置底提示条**：用户上翻历史离开底部后，当有新消息、流式扩写或工具推进时在底部居中弹出悬浮胶囊，点击一键回底并恢复自动跟随滚动

## 重要修复

- **ACP 思考流（thinking）分段破碎修复**：改进 prose 区域合并逻辑为区域同类累积，解决部分 ACP agent（如 codebuddy）在思考流与正文交错下发时一段思考被切碎成十几个折叠块的问题
- **移动端与交互细节优化**：移动端输入框水印去除了桌面键位提示；ACP 配置下拉菜单搜索框取消自动聚焦，避免移动端意外唤起软键盘，Esc 键由 document 事件全局兜底关闭

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖
- Docker：`docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.22`
- npm：`npm install -g @gdwhisper/omniterm`（升级后如终端显示异常，请强刷浏览器）

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.21...v0.2.22
