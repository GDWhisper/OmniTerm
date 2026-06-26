# OmniTerm

**Web-based tmux terminal manager.** Manage tmux sessions, browse files, and edit code — all from a browser.

Three-panel layout: Sidebar | Terminal | File Manager. Built with Rust (Axum) + React.

## Features

-   **Terminal** — Full PTY-backed terminal via WebSocket, supports resize, IME composition, copy-on-select
-   **File Manager** — dufs-inspired browser with upload, download, preview, create, rename, delete, search
-   **Git Worktree Discovery** — Auto-discovers worktrees in your projects, manage sessions per worktree
-   **Dark / Light Themes** — System-following or manual toggle, warm & cool tones
-   **Mobile Responsive** — Tab-based layout with bottom navigation for phones & tablets

## Install

### npm (recommended)

```bash
npm install -g omniterm
omniterm
# Open http://localhost:9077
```

### Shell script (no Node.js required)

```bash
curl -fsSL https://raw.githubusercontent.com/pax/OmniTerm/release/install.sh | bash
omniterm
```

### Docker

```bash
docker run -d -p 9077:9077 -v omniterm-data:/app/data ghcr.io/pax/omniterm
# Open http://localhost:9077
```

### Cargo (Rust users)

```bash
cargo install omniterm
omniterm
```

## Quick Start

```bash
omniterm                          # Start on default port 9077
omniterm -p 8080                  # Custom port
omniterm --port 8080
```

Open your browser to the printed address, create a password on first visit, then add your first project.

## CLI Reference

```
omniterm [OPTIONS]

Options:
  -p, --port <PORT>              监听端口 (default: 9077) [env: OMNITERM_PORT]
      --db <DB>                  数据库连接 [env: DATABASE_URL]
      --jwt-secret <KEY>         JWT 签名密钥 [env: JWT_SECRET]
  -V, --version                  版本号
  -h, --help                     帮助
```

## Prerequisites

-   **tmux** — Required. Install via your package manager:
    -   Ubuntu/Debian: `sudo apt install tmux`
    -   macOS: `brew install tmux`
    -   Docker image includes tmux automatically.

## Update

| Install method | Update command |
|---|---|
| npm | `npm update -g omniterm` |
| Shell script | Re-run `curl ... \| bash` |
| Docker | `docker pull ghcr.io/pax/omniterm` |
| Cargo | `cargo install --force omniterm` |

## License

MIT — see [LICENSE](LICENSE).
