# OmniTerm 发布指南

> 基于 v0.1.0 实际发布流程总结。以后每次发布照此执行。

## 架构速览

```
GDWhisper/OmniTerm-dev (私有)              GDWhisper/OmniTerm (公共)
├── main (开发)                            └── main ← release 分支内容
└── release (本地临时，不推送)                  └── vX.Y.Z tag → CI 触发
```

- **私有仓**：完整开发历史，包含所有 dev 文件
- **公共仓**：单 commit，干净发布，`main` 即最新 release
- **CI**：在公共仓运行（tag 触发）

---

## 发布步骤

### Step 1：版本号 + 变更

```bash
# 更新版本号
./scripts/bump-version.sh 0.2.0

# 更新 npm-package/install.js 中的 VERSION 常量
# 检查 README 是否需要更新
# 更新 CHANGELOG（将 [Unreleased] 改为 [0.2.0]）
```

### Step 2：构建 Release 分支

Release 分支基于上一版本的 release commit **增量提交**，维持线性历史，无需 force push。

> **两种场景：**
> - **新版本**（v0.1.0→v0.1.1）：执行下方全量重建流程
> - **当前版本补丁**（加截图/修 README 等小改动）：直接在 `release` 分支上改，追加 commit，无需重建

全量重建流程：

```bash
# 拉取公共仓最新 main
git fetch public main

# 重置 release 到公共仓 main（上一版本 release commit）
git checkout -fB release public/main
git rm -rf --cached .

# 复制当前 main 的发布文件
git checkout main -- \
  src/ frontend/ tests/ migrations/ \
  pic/ \
  Cargo.toml Cargo.lock \
  Dockerfile Dockerfile.release docker-compose.yml \
  README.md README_zh.md LICENSE \
  install.sh npm-package/ \
  scripts/bump-version.sh \
  .github/ .gitignore

# 修正 Cargo.toml：开发仓用 omniterm-main，发布仓用 omniterm
sed -i 's/name = "omniterm-main"/name = "omniterm"/' Cargo.toml

# 修正 Dockerfile：默认 binary 名
sed -i 's/ARG BRANCH_BINARY_NAME=omniterm-main/ARG BRANCH_BINARY_NAME=omniterm/' Dockerfile

# 修正 docker-compose
sed -i 's/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm-main}/BRANCH_BINARY_NAME: ${BRANCH_BINARY_NAME:-omniterm}/' docker-compose.yml

# 确认无 dev 文件残留
git diff --cached --name-only | grep -E '^(\.pi/|\.qoder/|\.codegraph/|AGENTS|CHANGELOG|CLAUDE|dev\.sh|docs/|openspec/|branch\.config)' | wc -l
# 输出应为 0

# 生成 Release Notes（从 CHANGELOG 提取）
bash scripts/extract-release-notes.sh "$NEW_VERSION" > RELEASE_NOTES.md
git add RELEASE_NOTES.md

git commit -m "v0.2.0"
```

### Step 3：打 Tag 并推送

```bash
git tag -f v0.2.0 release

# 先取消旧版本 tag（如果存在）
git push public :v0.2.0 2>/dev/null

# 推送 release → public/main（增量，无需 -f），tag → CI 触发
git push public release:main
git push public v0.2.0

# 切回 main，推私有仓
git checkout -f main
git push origin main
```

### Step 4：验证

CI 自动完成：Release 创建（Release Notes 从 CHANGELOG 提取）、binary 上传、npm publish、Docker 推送。

| 方式 | 验证命令 |
|------|---------|
| GitHub Release | 打开 `https://github.com/GDWhisper/OmniTerm/releases` 确认 binary 已上传 |
| npm | `npm install -g @gdwhisper/omniterm && omniterm --version` |
| Shell | `curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh \| bash` |
| Docker | `docker run -p 9077:9077 ghcr.io/GDWhisper/omniterm:v0.2.0` |

---

## 常见问题

### CI frontend 失败：`No pnpm version is specified`

CI 中 `pnpm/action-setup@v4` 的 `version` 字段缺失。确认 `.github/workflows/release.yml` 中有：
```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 10
```

### CI frontend 失败：`ERR_PNPM_OUTDATED_LOCKFILE`

`pnpm-lock.yaml` 和 `package.json` 不一致时，CI 使用 `--no-frozen-lockfile` 避免此问题。本地 pnpm 10 存在 bug 不会自动更新锁文件，如遇此问题需手动修复锁文件或删掉 node_modules 重装。

### CI Docker 失败：`cargo build --release` OOM

Docker 不再从源码编译，改为复用 CI 已构建的 `linux-x86_64` binary。Dockerfile 在 CI 中使用 `Dockerfile.release`（仅 13 行，只 COPY 不编译）。

### npm publish 403：`You do not have permission to publish "omniterm"`

包名已被占用。当前使用 scoped 包 `@gdwhisper/omniterm`。

### macOS x86_64 构建太慢

已从 CI 矩阵移除。当前构建平台：`linux-x86_64`、`linux-aarch64`、`macos-aarch64`。

### 公共仓 tag 误推送到私有仓

每次推 tag 前先确认 remote：
```bash
git remote -v
# public → https://github.com/GDWhisper/OmniTerm.git
# origin → https://github.com/GDWhisper/OmniTerm-dev.git
```

---

## 文件清单（发布仓包含）

| 目录/文件 | 说明 |
|-----------|------|
| `src/` | Rust 后端源码 |
| `frontend/` | React 前端源码 |
| `tests/` | 集成测试 |
| `migrations/` | SQLite 迁移 |
| `Cargo.toml`, `Cargo.lock` | Rust 项目配置（name=`omniterm`） |
| `Dockerfile` | 开发用多阶段构建 |
| `Dockerfile.release` | CI 用轻量 Docker（复用预构建 binary） |
| `docker-compose.yml` | Docker Compose 部署 |
| `README.md`, `README_zh.md`, `LICENSE` | 文档 |
| `RELEASE_NOTES.md` | Release Notes（CI 自动读取） |
| `pic/` | 预览截图 |
| `install.sh` | Shell 安装脚本 |
| `npm-package/` | npm 包文件 |
| `scripts/bump-version.sh` | 版本号脚本 |
| `.github/workflows/release.yml` | CI 流水线 |
| `.gitignore` | Git 忽略规则 |

**明确排除**：`AGENTS.md`、`CHANGELOG.md`、`CLAUDE.md`、`dev.sh`、`.pi/`、`.qoder/`、`.codegraph/`、`openspec/`、`docs/`（内部文档）、`capture.png`（旧截图）、`branch.config.example`、`scripts/hooks/`、`scripts/check-doc-index.sh`

---

## 平台映射表

install.sh 和 install.js 中 OS/架构 → binary 文件名映射：

| 用户环境 | binary 文件名 |
|----------|--------------|
| Linux x86_64 | `omniterm-linux-x86_64` |
| Linux aarch64 | `omniterm-linux-aarch64` |
| macOS Apple Silicon | `omniterm-macos-aarch64` |
| macOS Intel | ❌ 不支持（提示用户换 Apple Silicon） |
| Windows | ❌ 不支持（依赖 tmux） |
