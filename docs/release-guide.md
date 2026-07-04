# OmniTerm 发布指南

> 每次发布照此执行。

## 架构速览

```
GDWhisper/OmniTerm-dev (私有)              GDWhisper/OmniTerm (公共)
├── main (开发)                            └── main ← release 分支内容
└── release (本地临时，不推送)                  └── vX.Y.Z tag → CI 触发
```

- **私有仓**：完整开发历史，含所有 dev 文件
- **公共仓**：线性历史，`main` 即最新 release
- **提交风格**：公共仓 commit message 简洁为上（`v0.1.2`），内部细节留在私有仓
- **CI**：在公共仓运行（tag 触发），自动：编译 3 平台 binary、创建 GitHub Release、crates.io 发布、Docker 推送

---

## 发布步骤

### Step 1：版本号 + 变更

```bash
# 更新版本号（Cargo.toml + .env.local）
./scripts/bump-version.sh 0.2.0

# 更新 CHANGELOG（[Unreleased] → [0.2.0]）

# 撰写 RELEASE_NOTES.md（用户视角，简洁，无文件路径/时间戳）
# 参考: bash scripts/extract-release-notes.sh 0.2.0 | less
```

### Step 2：构建 Release 分支

```bash
./scripts/sync-release.sh 0.2.0
```

黑名单制，自动排除 dev 文件，复制 RELEASE_NOTES.md。

> 补丁（加截图/修 README）：直接在 `release` 分支上改，追加 commit。

### Step 3：打 Tag 并推送

```bash
git tag -f v0.2.0 release
git push public release:main
git push public v0.2.0
git checkout main
git push origin main
```

### Step 4：验证

CI 自动完成：binary 编译上传、GitHub Release（从 `RELEASE_NOTES.md` 读取）、crates.io 发布、Docker 推送。

| 方式 | 验证命令 |
|------|---------|
| GitHub Release | 打开 https://github.com/GDWhisper/OmniTerm/releases |
| Shell | `curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh \| bash` |
| Cargo | `cargo install omniterm` |
| Docker | `docker run -p 9077:9077 ghcr.io/GDWhisper/omniterm:v0.2.0` |

---

## 前置条件

### GitHub Secrets（公共仓）

| Secret | 说明 |
|--------|------|
| `CARGO_REGISTRY_TOKEN` | crates.io token（scope: publish-update） |
| `GITHUB_TOKEN` | 自动提供，无需手动配置 |

---

## 常见问题

### CI frontend 失败：`No pnpm version is specified`

确认 `.github/workflows/release.yml` 有 `version: 10`。

### CI frontend 失败：`ERR_PNPM_OUTDATED_LOCKFILE`

CI 使用 `--no-frozen-lockfile`。

### CI Docker 失败：OOM

Docker 使用 `Dockerfile.release`（COPY 预编译 binary，不重新编译）。

### macOS x86_64 构建

已移除。当前平台：`linux-x86_64`、`linux-aarch64`、`macos-aarch64`。

### 公共仓 tag 误推私有仓

```bash
git remote -v
# public → https://github.com/GDWhisper/OmniTerm.git
# origin → https://github.com/GDWhisper/OmniTerm-dev.git
```

---

## 文件清单

| 目录/文件 | 说明 |
|-----------|------|
| `src/` | Rust 后端源码 |
| `frontend/` | React 前端源码 |
| `tests/` | 集成测试 |
| `migrations/` | SQLite 迁移 |
| `Cargo.toml`, `Cargo.lock` | Rust 项目配置 |
| `build.rs` | 编译时检查前端 dist |
| `Dockerfile` | 多阶段构建 |
| `Dockerfile.release` | CI 轻量 Docker（复用预编译 binary） |
| `docker-compose.yml` | Docker Compose |
| `README.md`, `README_zh.md`, `LICENSE` | 文档 |
| `RELEASE_NOTES.md` | 用户视角 Release Notes（手写，CI 读取） |
| `pic/` | 预览截图 |
| `install.sh` | Shell 安装脚本 |
| `scripts/bump-version.sh` | 版本号脚本 |
| `.github/workflows/release.yml` | CI 流水线 |
| `.gitignore` | Git 忽略规则 |

**排除**：`AGENTS.md`、`CHANGELOG.md`、`CLAUDE.md`、`dev.sh`、`.pi/`、`.qoder/`、`.codegraph/`、`docs/`、`openspec/`、`npm-package/`、`capture.png`、`branch.config.example`、`scripts/hooks/`、`scripts/check-doc-index.sh`、`scripts/extract-release-notes.sh`

---

## 平台映射表

| 用户环境 | binary 文件名 |
|----------|--------------|
| Linux x86_64 | `omniterm-linux-x86_64` |
| Linux aarch64 | `omniterm-linux-aarch64` |
| macOS Apple Silicon | `omniterm-macos-aarch64` |
| macOS Intel | 不支持 |
| Windows | 不支持 |
