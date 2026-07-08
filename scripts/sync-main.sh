#!/usr/bin/env bash
# sync-main.sh — 将 dev 同步到 main（黑名单排除开发文档 + 修复分支配置）
# 用法: ./scripts/sync-main.sh [commit-message]
#
# 流程:
# 1. 检查 dev 是否已推送到 origin
# 2. 切换到 main
# 3. 合并 dev（保留个体 commit 历史）
# 4. 删除黑名单文件（静默处理冲突）
# 5. 修复分支专属配置（Cargo.toml, Dockerfile 等）
# 6. 重新生成 Cargo.lock
# 7. 提交

set -euo pipefail

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
  echo "❌ 请在 main worktree 执行此脚本（当前在 $CURRENT_BRANCH）"
  echo "   cd /home/pax/coding/OmniTerm && ./scripts/sync-main.sh"
  exit 1
fi

# 检查 dev 是否已推送到 origin
echo "🔍 检查 dev 分支状态..."
git fetch origin dev
DEV_LOCAL=$(git rev-parse dev 2>/dev/null || echo "")
DEV_REMOTE=$(git rev-parse origin/dev 2>/dev/null || echo "")
if [ "$DEV_LOCAL" != "$DEV_REMOTE" ] && [ -n "$DEV_LOCAL" ]; then
  echo "⚠️  dev 分支有未推送的提交，请先执行："
  echo "   git push origin dev"
  exit 1
fi

# 拉取最新
echo "📥 拉取 dev 最新..."
git fetch origin dev

# 合并 dev（--no-commit，手动处理冲突）
echo "🔀 合并 dev..."
if ! git merge --no-commit origin/dev; then
  # 检查是否有冲突
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  
  if [ -n "$CONFLICTS" ]; then
    # 对黑名单文件，直接删除（接受 main 的删除）- 静默处理
    for item in "${BLACKLIST[@]}"; do
      if echo "$CONFLICTS" | grep -q "^$item"; then
        git rm -rf "$item" 2>/dev/null || true
      fi
    done
    
    # 对非黑名单文件，接受 dev 的版本
    REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    if [ -n "$REMAINING" ]; then
      echo "   接受 dev 版本: $REMAINING"
      for file in $REMAINING; do
        git checkout origin/dev -- "$file" 2>/dev/null || true
      done
    fi
  else
    echo "❌ 合并失败，请检查"
    git merge --abort 2>/dev/null || true
    exit 1
  fi
fi

# 删除黑名单文件（可能还有残留）
echo "🗑️  清理黑名单文件..."
for item in "${BLACKLIST[@]}"; do
  if [ -e "$item" ]; then
    git rm -rf "$item" 2>/dev/null || true
  fi
done

# 修复分支专属配置
echo "🔧 修复分支专属配置..."

# Cargo.toml: name
sed -i 's/^name = "omniterm-dev"/name = "omniterm"/' Cargo.toml

# Dockerfile
sed -i 's/ARG BRANCH_BINARY_NAME=omniterm-dev/ARG BRANCH_BINARY_NAME=omniterm/' Dockerfile
sed -i 's/ARG BRANCH_BINARY_NAME=omniterm-main/ARG BRANCH_BINARY_NAME=omniterm/' Dockerfile

# docker-compose.yml
sed -i 's/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm-dev}/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm}/' docker-compose.yml
sed -i 's/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm-main}/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm}/' docker-compose.yml

# 重新生成 Cargo.lock（修复包名）
echo "📦 重新生成 Cargo.lock..."
cargo generate-lockfile 2>/dev/null || true

# 检查是否有变更
if git diff --quiet && git diff --cached --quiet; then
  echo "✅ 无变更，跳过提交"
  exit 0
fi

# 提交
git add -A
MSG="${1:-chore: sync main from dev}"
git commit --no-verify -m "$MSG"
echo ""
echo "✅ main 已同步: $MSG"
echo ""
echo "下一步:"
echo "  git push origin main"
echo "  git push public main:main"
