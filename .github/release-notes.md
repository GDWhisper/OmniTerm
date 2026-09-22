# OmniTerm v0.2.24 更新摘要

> 本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。

## 新功能

- **权限请求超时行为可配**（设置 → 会话「权限请求超时」）：一直等待（banner 挂到你回来，不作废回合）/ 自动推进（到点代替你应答全部未决审批让 agent 继续，可选项优先选 allow）/ 超时中止（默认，原 cancel + kill 行为）三选一，分钟数可调；三种模式到点都会在聊天流落一条**带详情的告知消息**——请求的工具名、内容预览、当时的完整可选项、自动模式实际选中了哪项，修掉「回来后不知道自己错过了什么选项」
- **「在此打开终端」可一键独立建项目**：确认弹窗展示的目录在侧栏没有同根项目时，新增「创建新项目并打开终端」按钮，以该目录本身为根建项目并开终端，不必退回侧栏走新建流程

## 重要修复

- **恢复 ACP 会话后后端 CPU 空转烧满一核（根因修复）**：futures 0.3.33 的 `FuturesUnordered` waker 缺陷（rust-lang/futures-rs#3032）作用在 agent 连接的 pidfd 等待路径上，形成紧密空转循环；升级 futures 套件至 0.3.34 根治，与此前的 teardown killpg 止血构成双层防线
- **ACP turn 定稿命令不再静默丢失**：定稿信号曾与可丢的防抖信号共用一条饱和即丢的通道，高帧率下会话级记账与消息行定稿（耗时、状态）同时丢失且无日志、DB 与界面静默分叉；现改走独立可靠通道，回归测试钉住「通道塞满时仍恰好送达一次」
- **tmux 控制连接子进程不再留僵尸**：tmux 会话被外部 kill 时子进程自行退出、无人收割，在系统留 defunct 进程（现场实测最久 10 天）；现改为常驻收割任务独占句柄，自然退出 / 强杀 / 被 drop 的孤儿都恰好 `wait()` 一次
- **ACP 气泡三项读数缺陷**：工具时长跨 WS 重连保留（此前每次重连清空、实测两个 bash 调用只报「工具约 <1秒」）、工具调用期间 t/s 不再逐渐跌落、元信息行中文单位不再被拆行
- **移动端 ACP 聊天切面板后丢贴底**：切到 sidebar/files 再切回时视口停在半空、流式输出不再跟随（容器尺寸变化此前既不触发滚动事件也不重测贴底态）；现补内容高度与 ResizeObserver 两条重钉路径
- **ACP 探针超时不残留 pid 自报文件**（RAII 守卫随连接任务终结统一清理）

## 工程改进

- **ACP 全部 per-连接任务日志补 session_id 归属**：多会话并发时 replay / 丢帧 / 关闭原因可归因到具体会话；新增 fake agent 回归测试（6 用例）钉住 teardown 契约——含 shutdown 对存活 agent 750ms 内完成进程组击杀
- **rustls 升级至 0.23.45**：修复 RUSTSEC-2026-0285（TLS 1.3 握手消息可在错误状态下被接受，中危；握手转写仍被认证，无法被网络位置攻击者利用），同时恢复 CI audit 门禁绿灯

## 安装与升级

- 新用户：使用 `install.sh`（Linux / macOS）或 `install.ps1`（Windows）一键安装
- 升级：`cargo install omniterm` 或从 Releases 下载对应平台 binary 覆盖
- Docker：`docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.24`
- npm：`npm install -g @gdwhisper/omniterm`（升级后如终端显示异常，请强刷浏览器）

**Full Changelog**: https://github.com/GDWhisper/OmniTerm/compare/v0.2.23...v0.2.24
