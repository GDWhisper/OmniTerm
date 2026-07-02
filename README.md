# OmniTerm · 万千智能体汇于一端

> **一个浏览器页面，看清你所有的 tmux 会话和 AI 编码智能体——不再 SSH 进去一个个翻。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 💡 为什么要有这个？

我用 tmux 管理十几个项目窗口，每个窗口里跑着 Claude Code、Codex 或其他 AI agent。问题来了——

*   **痛点**：Agent 跑完了没有？哪个窗口在报错？你只能 `tmux a` 一个个切进去看。吃饭时想瞄一眼进度，得掏出手机 SSH，在 80×24 的终端里挣扎。
*   **初衷**：我希望有一个「仪表盘」——打开浏览器就能看到所有会话，一眼分辨哪个 agent 在运行、哪个在等回复、哪个已经完成。手机也能看。
*   **愿景**：OmniTerm 不只管理 tmux，它理解你跑的是什么。你的 coding agent、你的长期服务、你的临时实验——全在一个页面里，随时随地。

---

## ✨ 核心亮点

-   **🤖 AI Agent 感知** — 自动识别 Claude Code、Codex 等 agent CLI，实时显示 ⏳运行中 / ⚠️等待输入 / ✅已完成 状态。Agent 叫你时，浏览器标签闪烁 + 声音提醒。

-   **📂 文件浏览器 + 代码编辑器** — 内置 dufs 风格的文件管理：上传、下载、预览、搜索。编辑器带语法高亮（13 种语言），跟随终端当前目录自动切换。

-   **🌿 Git Worktree 感知** — 自动发现项目下所有 git worktree，按分支分组管理会话。切分支时，终端和文件管理器自动跟随。

-   **📱 移动端可用** — 手机上浏览器打开就是完整界面。专门设计的移动键盘：Ctrl/Alt/Shift 粘滞修饰键，PgUp/PgDn/Home/End 齐全。靠在沙发上也能盯 agent 进度。

-   **⚡ 零依赖二进制** — Rust 编译为单个可执行文件，前端和数据库迁移都嵌入其中。`npm install -g omniterm` 或直接下载 binary，一条命令跑起来。

---

## 🎯 它适合谁？

-   你是 **AI 辅助开发者**，同时开着多个 Claude Code / Codex 会话 → OmniTerm 帮你一眼看清所有 agent 的状态，不会错过"该回复了"的信号。
-   你是 **后端 / SRE**，在服务器上用 tmux 跑着多个长期服务 → 浏览器打开就能看日志、查文件，不用每次都 SSH。
-   你是 **多项目并行的人**，用 git worktree 同时开发多个分支 → OmniTerm 自动按分支整理会话，不怕搞混。

---

## 🚀 快速体验

### 安装（选一种即可）

**npm（推荐）**

```bash
npm install -g omniterm
omniterm
```

**Shell 脚本（无需 Node.js）**

```bash
curl -fsSL https://raw.githubusercontent.com/pax/OmniTerm/release/install.sh | bash
omniterm
```

**Docker**

```bash
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/pax/omniterm
```

**Cargo（Rust 用户）**

```bash
cargo install omniterm
omniterm
```

### 开始使用

```bash
omniterm                 # 默认 http://localhost:9077
omniterm -p 8080         # 自定义端口
```

浏览器打开 → 首次设置密码 → 添加你的第一个项目 → 所有 tmux 会话自动出现在侧边栏。

### 前置要求

-   **tmux** — 系统必须安装。安装脚本会自动帮你装（支持 apt / brew / pacman / yum），Docker 镜像已内置。

---

## 🛠️ 技术架构（给想深挖的人）

| 层 | 技术选型 | 作用 |
|---|---|---|
| 后端 | Rust + Axum + SQLite | HTTP/WebSocket 服务、tmux 控制、文件操作 |
| 前端 | React 19 + Tailwind 4 + xterm.js | 三栏布局（侧栏｜终端｜文件管理） |
| 终端 | portable-pty + WebSocket | PTY 桥接，支持 resize、复制即选中 |
| Agent 感知 | tmux control mode + hooks | 实时监控 pane 内容，检测 agent CLI |
| 分发 | npm / install.sh / Docker / crates.io | 四种安装方式，binary 自包含 |

---

## 🗺️ 接下来的计划

-   **近期 (v0.2.x)**：会话搜索与过滤、多用户支持、终端标签页
-   **中期**：插件系统、自定义 agent hook 配置、图表化 agent 活动历史
-   **远期**：团队协作功能、agent 指令模板库

---

## 🤝 参与贡献

如果这个项目对你有用：

-   ⭐ **Star** 是最好的鼓励
-   🐛 [Issue](https://github.com/pax/OmniTerm/issues) — 遇到 Bug 或有想法，欢迎提交
-   🔧 [PR](https://github.com/pax/OmniTerm/pulls) — 代码贡献请先开 issue 讨论
-   📖 想了解架构？看看 [`docs/architecture-backend.md`](https://github.com/pax/OmniTerm/blob/main/docs/architecture-backend.md)

---

## 📄 开源协议

MIT © [pax](https://github.com/pax) — 随意使用、修改、分发。保留署名即可。
