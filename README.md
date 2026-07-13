# OmniTerm

> *One dashboard for all your AI coding agents.*

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

![screenshot](pic/overview.png)

> [中文](README_zh.md)

## What is it?

In the AI era, an IDE's main body shouldn't be a giant text editor—it should be a place to watch and steer your agents. OmniTerm is that place.

Open one browser tab and see every running AI coding agent—Claude Code, Codex, and others—with live status: running, waiting for input, or finished. No more SSH-ing into tmux panes one by one. A built-in terminal and file browser are there when you need to jump in, but most of the time you're just watching your agents work.

It connects to tmux under the hood. You don't need to think about that.

## Features

- **AI agent monitoring** — recognizes Claude Code, Codex, and similar CLI agents. Each pane gets a live badge: running, waiting for input, or finished. When an agent needs your attention, the browser tab flashes and a notification sounds.
- **File browser** — browse, upload, download, and preview files. Syntax highlighting for 13 languages. Follows the terminal's current working directory. Built-in terminal with xterm.js, full keyboard and mobile soft keyboard.
- **Git worktree awareness** — auto-discovers all git worktrees under a project and groups sessions by branch. Terminal and file browser follow the selected branch.
- **Single binary** — Rust backend with embedded frontend and SQLite. Install via cargo, shell script, or Docker. One command to start.

## Quick start

### Prerequisites

tmux must be installed. The install script attempts to install it automatically (apt, brew, pacman, yum). Docker images bundle it.

**Windows**: Install [psmux](https://github.com/psmux/psmux) — a native Windows tmux replacement built on ConPTY:
```powershell
winget install psmux    # recommended
# or: scoop install psmux
# or: cargo install psmux
```

### Install

```bash
# cargo (recommended)
cargo install omniterm
```
<small>Requires Rust toolchain; compiles from source (~30s–3min depending on machine). tmux must be installed separately.</small>

```bash
# Shell script (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash
```
<small>Downloads pre-built binary. Installs tmux automatically if missing.</small>

```bash
# PowerShell (Windows)
irm https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.ps1 | iex
```
<small>Downloads pre-built binary. Requires psmux or tmux (not bundled).</small>

```bash
# Docker
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/GDWhisper/omniterm
```
<small>Pre-built image; tmux bundled. Requires Docker engine.</small>

```bash
omniterm                 # default: http://localhost:9077
omniterm -p 8080         # custom port
```

<small>
All methods require a terminal multiplexer: tmux on Linux and macOS, psmux or tmux on Windows.
</small>

Open the URL in a browser, set an initial password, add a project directory, and your agents appear in the sidebar with live status badges.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust + Axum + SQLite |
| Frontend | React 19 + Tailwind CSS 4 + xterm.js |
| Terminal bridge | portable-pty + WebSocket |
| Agent detection | tmux control mode + content hooks |
| Distribution | cargo, shell script, Docker |

## Contributing

- ⭐ Star the repo
- 🐛 [Issues](https://github.com/GDWhisper/OmniTerm/issues) for bugs or ideas

## License

Apache-2.0 © [GDWhisper](https://github.com/GDWhisper)
