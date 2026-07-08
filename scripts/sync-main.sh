#!/usr/bin/env bash
# sync-main.sh — 将 dev 同步到 main（黑名单排除开发文档）
# 用法: ./scripts/sync-main.sh [commit-message]
#
# 流程:
# 1. 切换到 main
# 2. 合并 dev（不提交）
# 3. 删除黑名单文件
# 4. 提交

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 黑名单（相对于仓库根目录）
BLACKLIST=(
  "docs"
  "openspec"
  ".superpowers"
  ".pi"
  ".qoder"
  "AGENTS.md"
  "CLAUDE.md"
  "PROGRESS.md"
)

# 检查当前状态
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ 工作区不干净，请先提交或 stash"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "⚠️  当前在 $CURRENT_BRANCH，切换到 main..."
  git checkout main
fi

# 拉取最新
echo "📥 拉取 dev 最新..."
git fetch origin dev

# 合并 dev（不提交）
echo "🔀 合并 dev..."
if ! git merge --no-commit origin/dev; then
  echo "❌ 合并冲突，请手动解决后重试"
  git merge --abort 2>/dev/null || true
  exit 1
fi

# 删除黑名单文件
echo "🗑️  删除黑名单文件..."
for item in "${BLACKLIST[@]}"; do
  if [ -e "$item" ]; then
    git rm -rf "$item" 2>/dev/null || true
    echo "   删除: $item"
  fi
done

# 检查是否有变更
if git diff --cached --quiet; then
  echo "✅ 无变更，跳过提交"
  git merge --abort 2>/dev/null || true
  exit 0
fi

# 提交
MSG="${1:-chore: sync main from dev}"
git commit -m "$MSG"
echo "✅ main 已同步: $MSG"
echo ""
echo "下一步:"
echo "  git push origin main"
echo "  git push public main:main"
