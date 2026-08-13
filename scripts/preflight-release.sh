#!/usr/bin/env bash
# preflight-release.sh — 发布前渠道可发布性预检（必须在打 tag / 建 GitHub Release 之前运行）
#
# 用法: ./scripts/preflight-release.sh <version>
#   例: ./scripts/preflight-release.sh 0.2.15
#
# 检查项（任一失败即退出码 1，禁止继续发布）:
#  1. 版本号格式合法（X.Y.Z 或带 pre-release 后缀，如 0.2.14-fix）
#  2. Cargo.toml / frontend/package.json / npm-package/package.json 版本一致且等于目标版本
#  3. crates.io 上该版本未被发布（crates.io 不可逆，重复发布只能换新版本号）
#  4. npm 5 个包（主包 + 4 平台包）该版本可发布：
#     未发布（OK）/ 已发布（警告，CI 幂等检查会跳过）/ 版本号被烧（失败，曾发布后删除，immutable 无法重发）
#  5. Cargo.toml 无 git/path 依赖（cargo package 要求依赖可从 registry 解析）
#  6. Cargo.toml 元数据完整性（include 含 frontend/dist/migrations/根级文件，license/description 存在）
#  7. migrations/*.sql 全为 LF 且 .gitattributes 已强制 eol=lf（Windows npm 包 checksum 契约）
#
# 网络要求: 需访问 crates.io API 与 npm registry。crates.io 检查依赖 crates.io 反爬（带 UA）。

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "用法: $0 <version>"
    echo "示例: $0 0.2.15"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
WARN=0

ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; WARN=$((WARN + 1)); }
fail() { printf '  ❌ %s\n' "$*"; FAIL=$((FAIL + 1)); }

# ── 1. 版本号格式 ────────────────────────────────────────────────
echo "== 1. 版本号格式 =="
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
    ok "版本号 $VERSION 格式合法"
else
    fail "版本号 $VERSION 格式非法（应为 X.Y.Z 或带 pre-release 后缀）"
fi

# ── 2. 三处版本号一致 ────────────────────────────────────────────
echo "== 2. 版本号一致性 =="
check_version_field() {
    local file="$1" pattern="$2"
    if [[ ! -f "$file" ]]; then fail "缺少文件 $file"; return; fi
    local cur
    cur=$(grep -E "$pattern" "$file" | head -1 | sed -E 's/.*([0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?).*/\1/')
    if [[ -z "$cur" ]]; then fail "$file 读不到版本号"; return; fi
    if [[ "$cur" == "$VERSION" ]]; then
        ok "$(basename "$file") = $VERSION"
    else
        fail "$(basename "$file") = $cur（应为 $VERSION，先用 bump-version.sh 统一）"
    fi
}
check_version_field "$ROOT/Cargo.toml" '^version[[:space:]]*='
check_version_field "$ROOT/frontend/package.json" '"version"[[:space:]]*:'
check_version_field "$ROOT/npm-package/package.json" '"version"[[:space:]]*:'

# ── 3. crates.io 未发布 ──────────────────────────────────────────
echo "== 3. crates.io 可发布性 =="
if curl -fsSL -m 15 -A "omniterm-preflight" "https://crates.io/api/v1/crates/omniterm/$VERSION" -o /dev/null 2>/dev/null; then
    fail "crates.io 已有 omniterm $VERSION，无法重复发布（不可逆，须 bump 新版本）"
else
    ok "crates.io 无 omniterm $VERSION，可发布"
fi

# ── 4. npm 5 包可发布性 ──────────────────────────────────────────
echo "== 4. npm 渠道可发布性（主包 + 4 平台包） =="
NPM_PKGS=("omniterm" "omniterm-linux-x64" "omniterm-linux-arm64" "omniterm-darwin-arm64" "omniterm-win32-x64")
for pkg in "${NPM_PKGS[@]}"; do
    json=$(curl -fsSL -m 15 "https://registry.npmjs.org/@gdwhisper%2F$pkg" 2>/dev/null) || {
        fail "查询 @gdwhisper/$pkg 失败（网络或包不存在）"
        continue
    }
    in_versions=$(printf '%s' "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('$VERSION' in d.get('versions', {}))")
    in_time=$(printf '%s' "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('$VERSION' in d.get('time', {}))")
    if [[ "$in_versions" == "True" ]]; then
        warn "@gdwhisper/$pkg@$VERSION 已发布（CI 幂等检查会跳过，正常）"
    elif [[ "$in_time" == "True" ]]; then
        fail "@gdwhisper/$pkg@$VERSION 版本号被烧（曾发布后删除，npm immutable 无法重发），须 bump 新版本号"
    else
        ok "@gdwhisper/$pkg@$VERSION 可发布"
    fi
done

# ── 5. 依赖来源（git/path 依赖会阻塞 cargo package） ──────────────
echo "== 5. 依赖来源 =="
if grep -nE '^\s*[a-z0-9_-]+\s*=\s*\{[^}]*(git|path)\s*=' "$ROOT/Cargo.toml"; then
    fail "Cargo.toml 存在 git/path 依赖（cargo package/publish 要求依赖可从 registry 解析）"
else
    ok "无 git/path 依赖"
fi

# ── 6. Cargo.toml 元数据完整性 ───────────────────────────────────
echo "== 6. Cargo.toml 元数据 =="
INCLUDE=$(awk '/^include[[:space:]]*=/,/\]/' "$ROOT/Cargo.toml" | tr -d ' \n')
for needle in "src/**" "frontend/dist/**" "migrations/**" "/build.rs" "/README.md" "/LICENSE.md"; do
    if [[ "$INCLUDE" == *"$needle"* ]]; then
        ok "include 含 $needle"
    else
        fail "include 缺 $needle"
    fi
done
grep -q '^license[[:space:]]*=' "$ROOT/Cargo.toml" && ok "license 字段存在" || fail "缺 license 字段"
grep -q '^description[[:space:]]*=' "$ROOT/Cargo.toml" && ok "description 字段存在" || fail "缺 description 字段"

# ── 7. migrations 换行符（Windows npm 包 checksum 契约） ──────────
echo "== 7. migrations 换行符 =="
if grep -rl $'\r' "$ROOT/migrations/" >/dev/null 2>&1; then
    fail "migrations/ 含 CRLF（Windows CI 转 CRLF 致 checksum 不一致，须转回 LF）"
else
    ok "migrations 全为 LF"
fi
if git -C "$ROOT" show HEAD:.gitattributes 2>/dev/null | grep -q 'migrations/\*\.sql.*eol=lf'; then
    ok ".gitattributes 已提交（migrations/*.sql eol=lf）"
else
    fail ".gitattributes 缺 migrations eol=lf 规则"
fi

# ── 汇总 ─────────────────────────────────────────────────────────
echo ""
echo "══ 预检汇总 ══"
printf '  失败: %d   警告: %d\n' "$FAIL" "$WARN"
if [[ "$FAIL" -gt 0 ]]; then
    echo "❌ 存在阻塞项，禁止打 tag / 建 Release，先修复再重跑"
    exit 1
fi
echo "✅ 预检通过，可继续发布"
exit 0
