#!/usr/bin/env bash
# sync-main.sh — 将 dev 同步到 main（黑名单排除开发文档 + 修复分支配置）
# 用法: ./scripts/sync-main.sh [commit-message]
#
# 流程:
# 1. 切换到 main
# 2. 合并 dev（保留个体 commit 历史）
# 3. 删除黑名单文件
# 4. 修复分支专属配置（Cargo.toml, Dockerfile 等）
# 5. 提交

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

# 拉取最新
echo "📥 拉取 dev 最新..."
git fetch origin dev

# 合并 dev（--no-commit，手动处理冲突）
echo "🔀 合并 dev..."
if ! git merge --no-commit origin/dev; then
  # 检查是否有冲突
  echo "⚠️  检查冲突文件..."
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  
  if [ -n "$CONFLICTS" ]; then
    # 对黑名单文件，直接删除（接受 main 的删除）
    for item in "${BLACKLIST[@]}"; do
      if echo "$CONFLICTS" | grep -q "^$item"; then
        echo "   删除黑名单冲突: $item"
        git rm -rf "$item" 2>/dev/null || true
      fi
    done
    
    # 对非黑名单文件，接受 dev 的版本
    REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    if [ -n "$REMAINING" ]; then
      echo "   接受 dev 版本:"
      for file in $REMAINING; do
        echo "     $file"
        git checkout origin/dev -- "$file" 2>/dev/null || true
      done
    fi
  else
    echo "❌ 合并失败，请检查"
    git merge --abort 2>/dev/null || true
    exit 1
  fi
fi

# 删除黑名单文件
echo "🗑️  删除黑名单文件..."
for item in "${BLACKLIST[@]}"; do
  if [ -e "$item" ]; then
    git rm -rf "$item" 2>/dev/null || true
    echo "   删除: $item"
  fi
done

# 修复分支专属配置
echo "🔧 修复分支专属配置..."

# Cargo.toml: name, version, description 等
sed -i 's/^name = "omniterm-dev"/name = "omniterm"/' Cargo.toml
# 注意：version 由 bump-version.sh 管理，这里不修改
# 其他字段（description, repository 等）如果被 dev 覆盖，需要手动恢复

# Dockerfile
sed -i 's/ARG BRANCH_BINARY_NAME=omniterm-dev/ARG BRANCH_BINARY_NAME=omniterm/' Dockerfile
sed -i 's/ARG BRANCH_BINARY_NAME=omniterm-main/ARG BRANCH_BINARY_NAME=omniterm/' Dockerfile

# docker-compose.yml
sed -i 's/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm-dev}/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm}/' docker-compose.yml
sed -i 's/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm-main}/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm}/' docker-compose.yml

# 检查是否有变更
if git diff --quiet && git diff --cached --quiet; then
  echo "✅ 无变更，跳过提交"
  exit 0
fi

# 提交
git add -A
MSG="${1:-chore: sync main from dev}"
git commit -m "$MSG"
echo ""
echo "✅ main 已同步: $MSG"
echo ""
echo "下一步:"
echo "  git push origin main"
echo "  git push public main:main"
