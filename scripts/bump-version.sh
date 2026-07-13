#!/usr/bin/env bash
# 统一更新 OmniTerm 版本号
# 用法: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
    echo "用法: $0 <version>"
    echo "示例: $0 0.2.0"
    exit 1
fi

# 验证格式
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "错误: 版本号格式无效，应为 X.Y.Z"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Cargo.toml（版本号唯一真相源，git 跟踪，随分支 merge 同步）
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$ROOT/Cargo.toml"

# 2. frontend/package.json（保持与 Cargo.toml 对齐）
PKG="$ROOT/frontend/package.json"
if [[ -f "$PKG" ]]; then
    sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$PKG"
fi

echo "版本号已更新为 $NEW_VERSION:"
echo "  Cargo.toml             → version = \"$NEW_VERSION\""
echo "  frontend/package.json  → \"version\": \"$NEW_VERSION\""
echo ""
echo "核实:"
grep '^version' "$ROOT/Cargo.toml"
grep '"version"' "$PKG" | head -1
