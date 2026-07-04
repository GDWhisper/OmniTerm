#!/usr/bin/env bash
# 从 CHANGELOG.md 提取当前版本的 Release Notes
# 用法: ./scripts/extract-release-notes.sh [version]
# 不传参数时从 Cargo.toml 读取版本号
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGELOG="$ROOT/CHANGELOG.md"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    VERSION=$(grep '^version' "$ROOT/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
fi

if [[ ! -f "$CHANGELOG" ]]; then
    echo "错误: CHANGELOG.md 不存在" >&2
    exit 1
fi

# 提取当前版本的所有条目（从 ## [VERSION] 到下一个 ## [...] 或 ---）
# 跳过第一行 header，转换 ### 为 ##（GitHub 不支持 h3）
awk -v ver="$VERSION" '
    BEGIN { in_section = 0 }
    /^## \['"$VERSION"'\]/ { in_section = 1; next }
    /^## \[/ && in_section { exit }
    /^---/ && in_section { exit }
    in_section {
        # Convert ### to ## for GitHub markdown
        sub(/^### /, "## ")
        print
    }
' "$CHANGELOG"

# 如果没输出，说明没找到该版本
if [[ -z "$(awk -v ver="$VERSION" '/^## \['"$VERSION"'\]/ { print "FOUND"; exit }' "$CHANGELOG")" ]]; then
    echo "错误: CHANGELOG.md 中未找到版本 $VERSION" >&2
    exit 1
fi
