# OmniTerm

> *一个浏览器标签页，看住并驱动你所有的 AI 编码助手。*

[![License](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE)

**Claude Code · Codex · Gemini · OpenCode · Qwen Code · Kiro** ……

![screenshot](pic/overview.png)

> [English](README_En.md)

## 你是不是也这样？

同时开着好几个 AI 编码助手——Claude Code 在这个终端，Codex 在那个窗口，Gemini 又开了一个。你只能来回切，挨个去看：哪个跑完了？哪个卡在等你点确认？哪个早就报错退出了？

**OmniTerm 把它们全收进一个浏览器标签页。** 每个助手一张卡片，实时告诉你它在干嘛；需要你时，标签页一闪、提示音一响，你立刻就知道。大多数时候，你只管看着它们干活。

## 你能用它做什么

**一眼看全所有助手** — 运行中、等待输入、已完成，每个助手实时状态一目了然，不用再逐个窗口翻。

**像聊天一样驱动助手** — 选一个助手直接开聊（走 [ACP 协议](https://agentclientprotocol.com/)）：它的回复变成清晰的文本、工具调用卡片、可折叠的思考过程，而不是一堵终端文字墙。Claude Code、Codex、Gemini、OpenCode、Qwen Code、Kiro 都有一键预设。

**该出手时就出手** — 助手要执行工具，就地批准或拒绝；想换模型、调思考强度，会话中途随手切。

**需要你时立刻提醒** — 权限请求、等待输入，标签页闪烁 + 提示音 + 侧边栏徽标三管齐下，切到别的页面也不会漏。

**随时介入** — 内置终端（xterm.js）和文件浏览器，想看代码、改文件、敲命令随时上手，还支持手机软键盘。

**省心省内存** — 会话用完一键释放、记录还在、随时恢复；空闲的自动回收，不占地方。

**懂你的项目** — 自动识别 git worktree 按分支分组，文件浏览器跟随当前目录，13 种语言语法高亮。

## 快速开始

```bash
cargo install omniterm        # 或见下方其他方式
omniterm                      # 打开 http://localhost:9077
```

浏览器里设个初始密码、添加项目目录，就能开会话了——选中助手走聊天模式，留空就是普通终端。

<details>
<summary>其他安装方式（Shell 脚本 / PowerShell / Docker）</summary>

**前置**：tmux 可选（仅普通终端模式需要，聊天模式无需）。Windows 用 [psmux](https://github.com/psmux/psmux) 替代。

```bash
# Shell 脚本（Linux/macOS）—— 缺 tmux 会自动装
curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash
```

```powershell
# PowerShell（Windows）—— 需自备 psmux 或 tmux
irm https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.ps1 | iex
```

```bash
# Docker —— 已内置 tmux
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/GDWhisper/omniterm
```

</details>

---

## 开发者信息

单文件部署：Rust 后端内嵌前端与 SQLite，一条命令启动。

| 层 | 技术 |
|---|------|
| 后端 | Rust + Axum + SQLite |
| 前端 | React 19 + Tailwind CSS 4 + xterm.js |
| 助手协议 | [ACP](https://agentclientprotocol.com/) 客户端 + tmux control mode |
| 终端桥接 | portable-pty + WebSocket |

**参与贡献** — ⭐ 点个 Star；🐛 [Issues](https://github.com/GDWhisper/OmniTerm/issues) 提 Bug 或建议。

**许可证** — FSL-1.1-MIT © [GDWhisper](https://github.com/GDWhisper)
