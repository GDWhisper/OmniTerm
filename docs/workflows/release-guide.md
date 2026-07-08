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

## ⚠️ 发布前必须确认

**发布是不可逆操作**，特别是：
- **Cargo (crates.io)**：一旦发布，**无法删除**，只能发布新版本覆盖
- **npm**：发布后 72 小时内可删除，之后无法删除
- **GitHub Release**：可删除但会影响用户
- **Docker**：可删除但会影响用户

**发布前必须与用户确认以下信息：**

1. 版本号是否正确？（检查 CHANGELOG）
2. CHANGELOG 是否已更新？
3. 是否有未完成的 TODO/已知问题？
4. 发布时间是否合适？

**禁止未经用户确认就执行发布操作。**

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
2. 合并 dev（保留个体 commit）
3. 删除黑名单文件（docs/、openspec/、.superpowers/、.pi/、.qoder/、AGENTS.md、CLAUDE.md、PROGRESS.md）
4. 修复分支专属配置（Cargo.toml, Dockerfile 等）
5. **运行编译验证**（cargo check + pnpm build）
6. 提交

### Step 3：编译验证

**在打 tag 之前，必须验证代码能编译通过：**

#### Linux 验证（自动）

sync-main.sh 会自动运行：
- 后端：`cargo check`
- 前端：`pnpm build`

#### Windows 验证（手动）

**Linux 无法交叉编译 Windows MSVC 目标**，需要在 Windows 上验证：

```powershell
# 在 Windows 上 clone 公开仓
git clone https://github.com/GDWhisper/OmniTerm.git
cd OmniTerm
git checkout main

# 验证编译
cargo check
```

**验证流程：**
1. 用户在 Windows 上执行 `cargo check`
2. 用户将结果告知 agent（成功/失败 + 错误信息）
3. 如果失败，agent 修复后重新 sync + 推送
4. 用户再次验证，直到通过

**⚠️ 禁止在编译失败时打 tag 推送，否则会触发失败的 CI 并浪费资源。**

### Step 4：发布前检查清单

**编译通过不等于发布就绪。** 逐项确认：

#### 验证完整性
- [ ] **目标平台编译** — 不只是本地平台，CI 会构建的所有平台都要验证（Linux/macOS/Windows）
- [ ] **测试通过** — `cargo test` + `pnpm test`（CI 会跑测试，失败会阻塞发布）
- [ ] **前端构建** — `cd frontend && pnpm build`（TypeScript 类型检查 + 打包）

#### 元数据完整性
- [ ] **Cargo.toml** — `name`、`version`、`description`、`license`、`include` 是否完整
- [ ] **README 中英文同步** — 改了英文必须改中文，反之亦然
- [ ] **CHANGELOG** — 版本号、日期、内容是否准确

#### 变更影响分析
- [ ] **新增字段/类型** — 检查所有引用点：测试 mock、序列化/反序列化、前端类型定义
- [ ] **API 变更** — 后端改了接口，前端是否同步更新
- [ ] **平台特定代码** — 新增 `#[cfg(unix)]` 代码，是否有对应的 `#[cfg(windows)]` 实现

#### 环境差异意识
- [ ] **Shell 行为** — CI 的 Windows runner 默认用 PowerShell，bash 语法需要 `shell: bash`
- [ ] **编译环境** — 本地 Linux 无法验证 Windows 编译，需要用户在 Windows 上验证
- [ ] **依赖版本** — CI 环境可能与本地不同，锁定版本或使用 `--no-frozen-lockfile`

**核心原则：本地能验证的尽量本地验证，本地无法验证的明确标记并交给用户验证。**

### Step 4：用户确认

**在执行任何发布操作前，必须向用户确认：**

```
即将发布 v0.2.0：
- 版本号：0.2.0
- CHANGELOG：已更新
- 主要变更：[列出主要功能/修复]

确认发布？
```

**等待用户明确确认后才能继续。**

### Step 5：打 Tag 并推送

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

### Step 6：Cargo 发布（crates.io）

```bash
cd /home/pax/coding/OmniTerm

# 登录 crates.io（如果未登录）
cargo login <your-crate-token>

# 发布
cargo publish
```

**⚠️ Cargo 发布不可逆：**
- 发布后无法删除，只能发布新版本
- 如果发现问题，只能通过发布新版本修复
- 确保版本号正确、代码无误后再发布

### Step 7：npm 发布

CI 不自动发 npm。手动执行：

```bash
npm login --registry https://registry.npmjs.org/
cd npm-package
npm publish --registry https://registry.npmjs.org/ --otp=<6位数字>
```

### Step 8：验证

| 方式 | 验证命令 |
|------|---------|
| GitHub Release | 打开 `https://github.com/GDWhisper/OmniTerm/releases` 确认 binary 已上传 |
| crates.io | `cargo install omniterm && omniterm --version` |
| npm | `npm install -g @gdwhisper/omniterm && omniterm --version` |
| Shell | `curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh \| bash` |
| Docker | `docker run -p 9077:9077 ghcr.io/GDWhisper/OmniTerm:v0.2.0` |

---

## 同步 vs 发布（两个独立操作）

| 操作 | 命令 | 说明 |
|------|------|------|
| 同步 main | `./scripts/sync-main.sh` | 日常操作，只更新 main 代码，不打 tag |
| 发布新版本 | `./scripts/sync-main.sh` + `git tag` + `git push public` + `cargo publish` + `npm publish` | 正式发布，需要用户确认 |

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

### Cargo publish 失败

常见原因：
- 版本号未更新（Cargo.toml 中 version 与已发布版本重复）
- 依赖问题（运行 `cargo publish --dry-run` 检查）
- 元数据缺失（Cargo.toml 缺少 `description`、`license`、`include` 等字段）
- 前端资源未包含（检查 `include` 是否包含 `frontend/dist/**`）

如果版本号错误，只能发布新版本修复（无法删除已发布版本）。

---

## 踩坑方法论

### 1. 验证范围 = 发布范围

**本地能验证的 ≠ CI 会验证的。** CI 会构建多个平台、运行测试、检查 lint。本地验证只是子集。

**做法：**
- 发布前查看 CI workflow，列出所有验证步骤
- 本地能跑的全部跑一遍
- 本地跑不了的（如 Windows 编译），明确交给用户验证

### 2. 变更影响 = 所有引用点

**改了类型/接口，不只是改定义处。** 测试 mock、序列化、前端类型定义都是引用点。

**做法：**
- 改了 struct/interface，搜索所有使用点
- 特别关注：测试文件、mock 数据、序列化/反序列化
- 新增字段要有默认值或可选，避免破坏现有代码

### 3. 发布产物 = 代码 + 元数据 + 文档

**代码编译通过不等于发布就绪。** Cargo.toml、README、CHANGELOG 都是发布产物的一部分。

**做法：**
- Cargo.toml 检查：name、version、description、license、include
- README 检查：中英文同步、安装方式准确
- CHANGELOG 检查：版本号、日期、内容完整

### 4. 环境差异 = 提前识别

**本地环境 ≠ CI 环境。** Shell 行为、平台 API、依赖版本都可能不同。

**做法：**
- CI 用什么 shell，本地就用什么 shell 测试
- 平台特定代码用 `#[cfg]` 保护，并提供替代实现
- 依赖版本锁定或明确使用 `--no-frozen-lockfile`

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
