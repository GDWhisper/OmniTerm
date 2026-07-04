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

# 2. .env.local（frontend 从 import.meta.env.VITE_APP_VERSION 读取）
if grep -q '^BRANCH_VERSION=' "$ROOT/.env.local" 2>/dev/null; then
    sed -i "s/^BRANCH_VERSION=.*/BRANCH_VERSION=$NEW_VERSION/" "$ROOT/.env.local"
else
    echo "BRANCH_VERSION=$NEW_VERSION" >> "$ROOT/.env.local"
fi

# 3. 重建 frontend（让 UI 版本号跟上后端）
#    vite.config.ts 从 process.env.BRANCH_VERSION 注入 VITE_APP_VERSION，
#    必须 source .env.local 后再 build，否则 UI 仍嵌入旧版本号
if [[ -d "$ROOT/frontend" ]]; then
    if command -v pnpm &>/dev/null; then
        echo ""
        echo "[3/3] 重建 frontend（嵌入新版本号 $NEW_VERSION）..."
        set -a
        # shellcheck disable=SC1091
        source "$ROOT/.env.local"
        set +a
        (cd "$ROOT/frontend" && pnpm run build)
    else
        echo ""
        echo "警告: pnpm 未安装，跳过 frontend 重建。安装 pnpm 后重跑此脚本。"
        echo "      https://get.pnpm.io/install.sh"
    fi
fi

echo ""
echo "版本号已更新为 $NEW_VERSION:"
echo "  Cargo.toml         → version = \"$NEW_VERSION\""
echo "  .env.local         → BRANCH_VERSION=$NEW_VERSION"
if [[ -d "$ROOT/frontend" ]] && command -v pnpm &>/dev/null; then
    echo "  frontend/dist      → 已重建（UI 嵌入版本 $NEW_VERSION）"
fi
echo ""
echo "下一步:"
echo "  1. 编辑 CHANGELOG.md，加 0.1.x 条目"
echo "  2. 编辑 RELEASE_NOTES.md（用户视角的发布说明）"
echo "  3. git commit + ./scripts/sync-release.sh $NEW_VERSION"
echo "  4. git tag v$NEW_VERSION && git push public v$NEW_VERSION  （触发 CI）"
