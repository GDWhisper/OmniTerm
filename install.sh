#!/usr/bin/env bash
set -euo pipefail

# ── OmniTerm install script ──────────────────────────────────────
# curl -fsSL https://raw.githubusercontent.com/pax/OmniTerm/release/install.sh | bash

REPO="pax/OmniTerm"
BIN_NAME="omniterm"
INSTALL_DIR="${OMNITERM_INSTALL_DIR:-/usr/local/bin}"
VERSION="${OMNITERM_VERSION:-latest}"

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[omniterm]${NC} $*"; }
warn()  { echo -e "${YELLOW}[omniterm]${NC} $*"; }
error() { echo -e "${RED}[omniterm]${NC} $*" >&2; }

# ── Platform detection ───────────────────────────────────────────
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux)  os="linux" ;;
        Darwin) os="macos" ;;
        *)
            error "Unsupported OS: $(uname -s). omniterm requires Linux or macOS."
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x86_64" ;;
        aarch64|arm64) arch="aarch64" ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    PLATFORM="${os}-${arch}"
    ASSET="omniterm-${PLATFORM}"
}

# ── Download URL ─────────────────────────────────────────────────
get_download_url() {
    if [ "$VERSION" = "latest" ]; then
        local api_url="https://api.github.com/repos/${REPO}/releases/latest"
        DOWNLOAD_URL=$(curl -fsSL "$api_url" | grep "browser_download_url" | grep "$ASSET" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
        if [ -z "$DOWNLOAD_URL" ]; then
            error "Could not find release asset: $ASSET"
            error "Check https://github.com/${REPO}/releases for available binaries."
            exit 1
        fi
    else
        DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
    fi
}

# ── Install tmux if missing ──────────────────────────────────────
ensure_tmux() {
    if command -v tmux &>/dev/null; then
        return
    fi

    warn "tmux is required but not installed. Attempting automatic install..."

    if [ "$(uname -s)" = "Darwin" ]; then
        if command -v brew &>/dev/null; then
            info "Installing tmux via Homebrew..."
            brew install tmux
        else
            warn "Homebrew not found. Please install tmux manually:"
            warn "  brew install tmux"
            return
        fi
    else
        # Linux — try common package managers
        if command -v apt-get &>/dev/null; then
            info "Installing tmux via apt..."
            sudo apt-get update -qq && sudo apt-get install -y tmux
        elif command -v pacman &>/dev/null; then
            info "Installing tmux via pacman..."
            sudo pacman -S --noconfirm tmux
        elif command -v yum &>/dev/null; then
            info "Installing tmux via yum..."
            sudo yum install -y tmux
        elif command -v apk &>/dev/null; then
            info "Installing tmux via apk..."
            sudo apk add tmux
        else
            warn "Could not detect package manager. Please install tmux manually:"
            warn "  sudo apt install tmux  (Debian/Ubuntu)"
            warn "  sudo pacman -S tmux    (Arch)"
            warn "  brew install tmux      (macOS)"
            return
        fi
    fi

    if command -v tmux &>/dev/null; then
        info "tmux installed successfully"
    else
        warn "tmux installation may have failed. omniterm requires tmux to function."
    fi
}

# ── Main ─────────────────────────────────────────────────────────
main() {
    detect_platform
    get_download_url

    local dest="${INSTALL_DIR}/${BIN_NAME}"

    # Check if already installed and up-to-date
    if [ -x "$dest" ] && [ "$VERSION" = "latest" ]; then
        info "omniterm is already installed at $dest"
        info "Run 'omniterm --version' to check, or re-run with OMNITERM_VERSION=X.Y.Z to force."
        ensure_tmux
        exit 0
    fi

    info "Downloading omniterm ($PLATFORM)..."
    info "  $DOWNLOAD_URL"

    local tmpfile
    tmpfile=$(mktemp)
    trap 'rm -f "$tmpfile"' EXIT

    if curl -fsSL --progress-bar -o "$tmpfile" "$DOWNLOAD_URL"; then
        info "Download complete"
    else
        error "Download failed"
        exit 1
    fi

    # Install
    if [ -w "$INSTALL_DIR" ]; then
        mv "$tmpfile" "$dest"
    else
        info "Installing to $dest (requires sudo)..."
        sudo mv "$tmpfile" "$dest"
    fi
    chmod +x "$dest"

    # Verify
    if "$dest" --version &>/dev/null; then
        info "omniterm installed successfully!"
        "$dest" --version
    else
        error "Installation verification failed"
        exit 1
    fi

    ensure_tmux

    echo ""
    info "Run 'omniterm' to start, then open http://localhost:9077"
}

main
