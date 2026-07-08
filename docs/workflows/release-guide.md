# OmniTerm 发布指南

## 架构速览

```
GDWhisper/OmniTerm-dev (私有)              GDWhisper/OmniTerm (公共)
├── dev (开发前沿)                          └── main ← sync from dev
├── preview (私人稳定分支)                       └── vX.Y.Z tag → CI 触发
└── main (发布分支，sync 到 public)
```

- **私有仓**：完整开发历史，包含所有 dev 文件
- **公共仓**：干净发布代码（排除开发文档），`main` 即最新 release
- **CI**：在公共仓运行（tag 触发）

---

## 发布步骤

### Step 1：版本号 + 变更

```bash
# 在 dev worktree 执行
cd /home/pax/coding/OmniTerm-dev

# 更新版本号
./scripts/bump-version.sh 0.2.0

# 更新 CHANGELOG（将 [Unreleased] 改为 [0.2.0]）
# 提交版本号变更
git add -A && git commit -m "chore: bump to 0.2.0"
```

### Step 2：同步 dev → main

使用 sync 脚本自动排除开发文档：

```bash
# 在 dev worktree 执行
./scripts/sync-main.sh "release: v0.2.0"
```

脚本会：
1. 切换到 main 分支
2. 合并 dev（不提交）
3. 删除黑名单文件（docs/、openspec/、.superpowers/、.pi/、.qoder/、AGENTS.md、CLAUDE.md、PROGRESS.md）
4. 提交

### Step 3：打 Tag 并推送

```bash
cd /home/pax/coding/OmniTerm

# 打 tag
git tag v0.2.0

# 推送 main 到 public 仓
git push public main:main

# 推送 tag 触发 CI
git push public v0.2.0

# 推送 main 到私有仓（保持同步）
git push origin main
```

### Step 4：npm 发布

CI 不自动发 npm。手动执行：

```bash
npm login --registry https://registry.npmjs.org/
cd npm-package
npm publish --registry https://registry.npmjs.org/ --otp=<6位数字>
```

### Step 5：验证

| 方式 | 验证命令 |
|------|---------|
| GitHub Release | 打开 `https://github.com/GDWhisper/OmniTerm/releases` 确认 binary 已上传 |
| npm | `npm install -g @gdwhisper/omniterm && omniterm --version` |
| Shell | `curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh \| bash` |
| Docker | `docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.0` |

---

## 黑名单说明

sync 脚本自动排除以下文件（开发文档不进入公开仓）：

```
docs/
openspec/
.superpowers/
.pi/
.qoder/
AGENTS.md
CLAUDE.md
PROGRESS.md
```

如需维护公开版 AGENTS.md，创建 `scripts/public-agents.md` 并修改 sync 脚本添加替换逻辑。

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

### 公共仓 tag 误推送到私有仓

每次推 tag 前先确认 remote：
```bash
git remote -v
# public → https://github.com/GDWhisper/OmniTerm.git
# origin → https://github.com/GDWhisper/OmniTerm-dev.git
```

### sync 脚本冲突

如果 sync 脚本遇到合并冲突：
1. 脚本会自动 abort 并报错
2. 手动解决冲突后重新执行
3. 或者检查 dev 是否有未提交的变更

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
