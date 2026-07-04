#!/bin/bash
# 检查 AGENTS.md 文档索引中引用的所有文件是否存在且被 git 跟踪
# 用法: ./scripts/check-doc-index.sh
set -euo pipefail

echo "=== 文档索引完整性检查 ==="
missing=0
while IFS='|' read -r _ doc trigger _; do
  doc=$(echo "$doc" | xargs)
  [[ "$doc" != \`docs/* ]] && continue
  doc="${doc//\`/}"
  if [[ ! -f "$doc" ]]; then
    echo "❌ 缺失: $doc"
    missing=1
  elif ! git ls-files --error-unmatch "$doc" &>/dev/null; then
    echo "⚠️  未跟踪: $doc (存在但未 git add)"
    missing=1
  fi
done < <(sed -n '/^| `docs\//,/^$/p' AGENTS.md | head -n -1)

if [[ $missing -eq 0 ]]; then
  echo "✅ 全部通过"
else
  echo ""
  echo "请先 git add 缺失文件后再提交。"
  exit 1
fi
