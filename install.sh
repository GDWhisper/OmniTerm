#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) err "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  linux)  PLATFORM="linux-${ARCH}" ;;
  darwin) PLATFORM="macos-${ARCH}" ;;
  *)      err "Unsupported OS: $OS (only Linux/macOS supported)"; exit 1 ;;
esac

BINARY_NAME="omniterm-${PLATFORM}"
INSTALL_PATH="/usr/local/bin/omniterm"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     OmniTerm Installer              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""
info "Platform: $PLATFORM"

info "Checking latest version..."
LATEST=$(curl -fsSL https://api.github.com/repos/pax/OmniTerm/releases/latest 2>/dev/null || echo "")
if [[ -z "$LATEST" ]]; then
  err "Failed to fetch latest release from GitHub"
  exit 1
fi

VERSION=$(echo "$LATEST" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
if [[ -z "$VERSION" ]]; then
  err "Failed to parse version from GitHub API"
  exit 1
fi
ok "Latest: $VERSION"

if [[ -f "$INSTALL_PATH" ]]; then
  CURRENT=$("$INSTALL_PATH" --version 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
  if [[ "$CURRENT" == "${VERSION#v}" ]]; then
    ok "Already up to date (v$CURRENT)"
    exit 0
  fi
  info "Upgrading: $CURRENT → ${VERSION#v}"
fi

DOWNLOAD_URL="https://github.com/pax/OmniTerm/releases/download/${VERSION}/${BINARY_NAME}"
info "Downloading: $DOWNLOAD_URL"
TMPFILE=$(mktemp)

if command -v curl &>/dev/null; then
  curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$TMPFILE" || { err "Download failed"; rm -f "$TMPFILE"; exit 1; }
elif command -v wget &>/dev/null; then
  wget -q --show-progress "$DOWNLOAD_URL" -O "$TMPFILE" || { err "Download failed"; rm -f "$TMPFILE"; exit 1; }
else
  err "curl or wget required"
  exit 1
fi
ok "Downloaded $(du -h "$TMPFILE" | cut -f1)"

info "Installing to $INSTALL_PATH"
chmod +x "$TMPFILE"

if [[ -w "$(dirname "$INSTALL_PATH")" ]]; then
  mv "$TMPFILE" "$INSTALL_PATH"
else
  warn "sudo required to write $INSTALL_PATH"
  sudo mv "$TMPFILE" "$INSTALL_PATH"
  sudo chmod +x "$INSTALL_PATH"
fi

if "$INSTALL_PATH" --version &>/dev/null; then
  INSTALLED_VER=$("$INSTALL_PATH" --version | head -1)
  ok "Installed: $INSTALLED_VER"
else
  err "Verification failed"
  exit 1
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  OmniTerm installed successfully!   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Run:  ${CYAN}omniterm${NC}"
echo -e "  Open: ${CYAN}http://localhost:9077${NC}"
echo ""
