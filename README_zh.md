# OmniTerm

> *一个面板，掌控所有 AI 编码助手。*

[![License](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE)

![screenshot](pic/overview.png)

> [English](README.md)

## 这是什么？

AI 时代的 IDE，核心不应该是一个巨型编辑器——而是一个能监控和调度 AI 助手的工作台。OmniTerm 就是这样一个工作台。

打开一个浏览器标签页，所有正在运行的 AI 编码助手——Claude Code、Codex 等——一目了然：运行中、等待输入、已完成。不用再逐个 SSH 进 tmux 窗格查看。内置终端和文件浏览器随时可以介入，但大多数时候，你只需要看着它们工作。

底层基于 tmux，但你完全不需要关心这个。

## 功能特性

- **AI 助手监控** — 识别 Claude Code、Codex 等 CLI 助手。每个窗格实时显示状态：运行中、等待输入、已完成。助手需要关注时，浏览器标签页闪烁并发出提示音。
- **文件浏览器** — 浏览、上传、下载、预览文件。支持 13 种语言语法高亮。跟随终端当前工作目录。内置终端基于 xterm.js，完整键盘映射和移动端软键盘。
- **Git Worktree 感知** — 自动发现项目下所有 git worktree，按分支分组会话。终端和文件浏览器跟随选中分支。
- **单文件部署** — Rust 后端内嵌前端与 SQLite。支持 cargo、shell 脚本或 Docker 安装。一条命令启动。

## 快速开始

### 环境要求

系统需安装 tmux。安装脚本会尝试自动安装（支持 apt、brew、pacman、yum）。Docker 镜像已内置。

**Windows**：安装 [psmux](https://github.com/psmux/psmux) — 基于 ConPTY 的原生 Windows tmux 替代方案：
```powershell
winget install psmux    # 推荐
# 或: scoop install psmux
# 或: cargo install psmux
```

### 安装

```bash
# cargo（推荐）
cargo install omniterm
```
<small>需要 Rust 工具链；从源码编译（约 30 秒至 3 分钟，视机器性能而定）。tmux 需单独安装。</small>

```bash
# Shell 脚本（Linux/macOS）
curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash
```
<small>下载预编译二进制。若缺失 tmux 会自动安装。</small>

```bash
# PowerShell（Windows）
irm https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.ps1 | iex
```
<small>下载预编译二进制。需要 psmux 或 tmux（不包含在包内）。</small>

```bash
# Docker
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/GDWhisper/omniterm
```
<small>预构建镜像，已包含 tmux。需要 Docker 运行时。</small>

```bash
omniterm                 # 默认端口: http://localhost:9077
omniterm -p 8080         # 自定义端口
```

<small>
所有方式均需要终端多路复用器：Linux 和 macOS 上为 tmux，Windows 上为 psmux 或 tmux。
</small>


浏览器打开后，设置初始密码，添加项目目录，AI 助手会自动出现在侧边栏，附带实时状态标记。

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Rust + Axum + SQLite |
| 前端 | React 19 + Tailwind CSS 4 + xterm.js |
| 终端桥接 | portable-pty + WebSocket |
| 助手检测 | tmux control mode + 内容钩子 |
| 分发 | cargo、shell 脚本、Docker |

## 参与贡献

- ⭐ 给项目点个 Star
- 🐛 [Issues](https://github.com/GDWhisper/OmniTerm/issues) — 提交 Bug 或建议

## 许可证

FSL-1.1-MIT © [GDWhisper](https://github.com/GDWhisper)
