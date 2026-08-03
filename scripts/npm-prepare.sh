#!/usr/bin/env bash
# npm-prepare.sh — 从 GitHub Release 资产 staging npm 包（主包 + 4 个平台子包）
# 用法: ./scripts/npm-prepare.sh <version> <assets-dir> <out-dir>
#   <version>     版本号（不含 v 前缀），如 0.2.2
#   <assets-dir>  已下载的 Release 资产目录（含 omniterm-<platform> / .zip）
#   <out-dir>     staging 输出目录（会被清空重建）
# 纯 staging，不发布——发布由 release.yml 的 npm-publish job 执行。
# 平台分包模型（esbuild 式）：主包 optionalDependencies 精确锁定各平台子包。
set -euo pipefail

VERSION="${1:?need version}"
ASSETS="${2:?need assets dir}"
OUT="${3:?need out dir}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# npm 平台包后缀（process.platform-process.arch）
TARGETS="linux-x64 linux-arm64 darwin-arm64 win32-x64"

# npm 平台名 → CI Release 资产名
asset_for() {
  case "$1" in
    linux-x64)    echo "omniterm-linux-x86_64" ;;
    linux-arm64)  echo "omniterm-linux-aarch64" ;;
    darwin-arm64) echo "omniterm-macos-aarch64" ;;
    win32-x64)    echo "omniterm-windows-x86_64.zip" ;;
    *) echo "unknown target: $1" >&2; exit 1 ;;
  esac
}

rm -rf "$OUT"
mkdir -p "$OUT/platform"

for plat in $TARGETS; do
  asset="$ASSETS/$(asset_for "$plat")"
  [[ -f "$asset" ]] || { echo "❌ 缺少资产: $asset" >&2; exit 1; }

  dir="$OUT/platform/omniterm-$plat"
  mkdir -p "$dir/bin"
  if [[ "$asset" == *.zip ]]; then
    unzip -oq "$asset" -d "$dir/bin"   # zip 内为根级 omniterm.exe
  else
    cp "$asset" "$dir/bin/omniterm"
    chmod 755 "$dir/bin/omniterm"
  fi

  os="${plat%-*}"   # linux / darwin / win32
  cpu="${plat#*-}"  # x64 / arm64
  cat > "$dir/package.json" <<EOF
{
  "name": "@gdwhisper/omniterm-$plat",
  "version": "$VERSION",
  "description": "OmniTerm native binary for $plat",
  "license": "FSL-1.1-MIT",
  "repository": "github:GDWhisper/OmniTerm",
  "publishConfig": { "access": "public" },
  "os": ["$os"],
  "cpu": ["$cpu"]
}
EOF
done

# 主包：copy checked-in package.json + shim.js + postinstall.js，注入 version + optionalDependencies
mkdir -p "$OUT/main"
cp "$ROOT/npm-package/package.json" "$ROOT/npm-package/shim.js" "$ROOT/npm-package/postinstall.js" "$OUT/main/"
node -e '
  const fs = require("fs");
  const [dir, version, targets] = process.argv.slice(1);
  const p = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
  p.version = version;
  p.optionalDependencies = Object.fromEntries(
    targets.split(" ").map((t) => ["@gdwhisper/omniterm-" + t, version])  // 精确锁定
  );
  fs.writeFileSync(dir + "/package.json", JSON.stringify(p, null, 2) + "\n");
' "$OUT/main" "$VERSION" "$TARGETS"

echo "✅ staging 完成: $OUT/platform/* + $OUT/main (version=$VERSION)"
