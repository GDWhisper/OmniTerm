#!/usr/bin/env bash
# sync-release.sh — 从 main 分支同步到 release 分支（黑名单制）
#
# 理念：只维护「排除什么」，不维护「包含什么」。
#       加新源码目录/文件时零维护成本。
#
# 用法:
#   ./scripts/sync-release.sh 0.2.0          # 新版本发布
#   ./scripts/sync-release.sh 0.2.0 --dry    # 预览模式（不提交）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "用法: $0 <version> [--dry]"
    echo "示例: $0 0.2.0"
    exit 1
fi

DRY_RUN=false
if [[ "${2:-}" == "--dry" ]]; then
    DRY_RUN=true
fi

# ── 黑名单：这些文件/目录不进入公开仓 ──────────────────────────
# 格式：每行一个路径（相对于项目根），支持目录和文件
# 新增排除项只需追加一行，无需改动脚本逻辑
EXCLUDE=(
    # 开发文档
    AGENTS.md
    CHANGELOG.md
    CLAUDE.md
    dev.sh
    # 工具配置
    .pi/
    .qoder/
    .codegraph/
    # 内部文档
    docs/
    openspec/
    # 旧截图
    capture.png
    # 示例配置
    branch.config.example
    # pre-commit hooks（不对外发布）
    scripts/hooks/
    scripts/check-doc-index.sh
    scripts/extract-release-notes.sh
    # 本地环境（gitignored，以防万一）
    .env.local
)

# ── 可选保留的文件（白名单覆盖黑名单）──────────────────────────
# 黑名单排除后，再把以下文件加回来
KEEP=(
    # 无 — 如有需要在此添加
)

# ── 步骤 1: 获取当前状态 ───────────────────────────────────────
echo "=== sync-release v$VERSION ==="

# 确保在 main 上有最新代码
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "错误: 请在 main 分支上运行此脚本（当前: $CURRENT_BRANCH）"
    exit 1
fi

if ! git diff-index --quiet HEAD --; then
    echo "错误: 工作区有未提交的改动，请先 commit 或 stash"
    exit 1
fi

# 检查 public remote
if ! git remote get-url public &>/dev/null; then
    echo "错误: 未配置 public remote"
    echo "  git remote add public https://github.com/GDWhisper/OmniTerm.git"
    exit 1
fi

# ── 步骤 2: 拉取公共仓最新 ─────────────────────────────────────
echo "[1/7] 拉取公共仓最新 main ..."
git fetch public main --quiet

# ── 步骤 3: 构建 release 分支 ──────────────────────────────────
echo "[2/7] 构建 release 分支（基于 public/main）..."

# 获取当前 Cargo.toml 的 package name（开发仓用 omniterm-main）
DEV_BIN_NAME=$(cargo metadata --format-version=1 --no-deps 2>/dev/null | \
    jq -r '.packages[0].targets[] | select(.kind[0]=="bin") | .name' 2>/dev/null || \
    grep '^name' Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')

git checkout -fB release public/main --quiet
git rm -rf --cached --quiet . 2>/dev/null || true

echo "  开发仓 binary 名: $DEV_BIN_NAME"

# ── 步骤 4: 全量复制 main → release ────────────────────────────
echo "[3/7] 复制 main 文件到 release ..."
git checkout main --quiet -- .

# ── 步骤 4: 复制 RELEASE_NOTES.md ──────────────────────────────
echo "[4/7] 复制 RELEASE_NOTES.md ..."
if [[ ! -f "$ROOT/RELEASE_NOTES.md" ]]; then
    echo "错误: RELEASE_NOTES.md 不存在，请先手写用户视角的 Release Notes"
    echo "提示: 从 CHANGELOG 提取详情作为参考：bash scripts/extract-release-notes.sh $VERSION"
    exit 1
fi
git add -f RELEASE_NOTES.md

# ── 步骤 5: 应用黑名单 ─────────────────────────────────────────
echo "[5/7] 应用黑名单（排除 ${#EXCLUDE[@]} 项）..."
for item in "${EXCLUDE[@]}"; do
    # 移除末尾 / 以兼容 git ls-files 的目录匹配
    clean_item="${item%/}"
    if git ls-files --error-unmatch "$clean_item" &>/dev/null; then
        git rm -rf --cached --quiet "$clean_item" 2>/dev/null || true
    fi
    # 也从工作区删除（处理 untracked 文件和目录）
    rm -rf "$item" 2>/dev/null || true
done

# 应用白名单覆盖
for item in "${KEEP[@]}"; do
    git checkout main --quiet -- "$item" 2>/dev/null || true
done

# ── 步骤 6: 修正 binary 名 ─────────────────────────────────────
echo "[6/7] 修正 binary 名（$DEV_BIN_NAME → omniterm）..."
if [[ "$DEV_BIN_NAME" != "omniterm" ]]; then
    sed -i "s/name = \"$DEV_BIN_NAME\"/name = \"omniterm\"/" Cargo.toml
    sed -i "s/ARG BRANCH_BINARY_NAME=$DEV_BIN_NAME/ARG BRANCH_BINARY_NAME=omniterm/" Dockerfile 2>/dev/null || true
    sed -i "s/BRANCH_BINARY_NAME: \${BRANCH_BINARY_NAME:-$DEV_BIN_NAME}/BRANCH_BINARY_NAME: \${BRANCH_BINARY_NAME:-omniterm}/" docker-compose.yml 2>/dev/null || true
    git add Cargo.toml Dockerfile docker-compose.yml 2>/dev/null || true
fi

# ── 步骤 7: 安全检查 ───────────────────────────────────────────
echo "[7/7] 安全检查..."

# 检查是否有 dev 文件残留
LEAKED=$(git diff --cached --name-only | grep -E '^(AGENTS|CHANGELOG|CLAUDE|dev\.sh|\.pi/|\.qoder/|\.codegraph/|docs/|openspec/|branch\.config|\.env\.local)' || true)
if [[ -n "$LEAKED" ]]; then
    echo "警告: 以下 dev 文件未被黑名单捕获:"
    echo "$LEAKED"
    echo "请将它们添加到 scripts/sync-release.sh 的 EXCLUDE 数组中"
fi

# 统计变更
ADDED=$(git diff --cached --diff-filter=A --name-only | wc -l)
MODIFIED=$(git diff --cached --diff-filter=M --name-only | wc -l)
DELETED=$(git diff --cached --diff-filter=D --name-only | wc -l)
echo "  Added: $ADDED  Modified: $MODIFIED  Deleted: $DELETED"

# ── 提交 ────────────────────────────────────────────────────────
if $DRY_RUN; then
    echo ""
    echo "=== DRY RUN — 未提交。查看暂存区: git diff --cached --stat ==="
    git diff --cached --stat
    exit 0
fi

git commit -m "v$VERSION" --quiet
echo ""
echo "=== release 分支已构建 ==="
echo ""
echo "下一步:"
echo "  git tag -f v$VERSION release"
echo "  git push public release:main"
echo "  git push public v$VERSION"
echo "  git checkout main"
