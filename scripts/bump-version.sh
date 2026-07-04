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

# 1. Cargo.toml
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$ROOT/Cargo.toml"

# 2. npm-package/package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$ROOT/npm-package/package.json"

# 3. .env.local（frontend 从 import.meta.env.VITE_APP_VERSION 读取）
if grep -q '^BRANCH_VERSION=' "$ROOT/.env.local" 2>/dev/null; then
    sed -i "s/^BRANCH_VERSION=.*/BRANCH_VERSION=$NEW_VERSION/" "$ROOT/.env.local"
else
    echo "BRANCH_VERSION=$NEW_VERSION" >> "$ROOT/.env.local"
fi

echo "版本号已更新为 $NEW_VERSION:"
echo "  Cargo.toml                → version = \"$NEW_VERSION\""
echo "  npm-package/package.json  → version = \"$NEW_VERSION\""
echo "  .env.local                → BRANCH_VERSION=$NEW_VERSION"
echo ""
echo "核实:"
grep '^version' "$ROOT/Cargo.toml"
grep '"version"' "$ROOT/npm-package/package.json" | head -1
grep '^BRANCH_VERSION' "$ROOT/.env.local" 2>/dev/null || echo "  (BRANCH_VERSION not found in .env.local)"
