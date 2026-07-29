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

## 发布前必须确认

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

## ⚠️ 强制发布顺序（crates.io 不可逆，必须先验证 CI）

**Cargo (crates.io) 发布不可逆——一旦 `cargo publish` 成功，无法删除，只能发新版本覆盖。**

**铁律：`cargo publish` 必须排在「GitHub Release CI 完全通过」之后，绝不可抢跑。**

```
正确顺序：
  Step 1~4  →  bump / changelog / sync / release-notes 推送
  Step 5    →  git tag + 推送（触发 release.yml CI）
  ↓ 等待 release.yml 全绿（含 backend matrix 多平台编译 + frontend + docker）
  Step 8    →  cargo publish --allow-dirty   ← 仅在此之后执行
  Step 10   →  验证

错误顺序（本次 0.2.0 踩坑）：
  ✗ tag 推送后立刻 cargo publish，此时 release.yml 仍在跑 / ci.yml 已红
  → 不可逆的 crate 已上线，但 GitHub Release 可能失败，造成「crates 有、GitHub 没有」的不一致
```

**判定「CI 完全通过」的标准：**
- `gh run list --branch main` 中本次 tag 对应的 `Release` (release.yml) run 全部 job 绿
- `gh run list` 中 push `main` 触发的 `CI` (ci.yml) run 也需绿（quality gate，非发布直接产物但反映 main 健康度）
- 任一红灯 → **暂停 cargo publish**，先修 CI 再继续
- **audit job 已是阻塞门禁**（2026-07-29 起移除 continue-on-error）：cargo-deny 对新发布的 RUSTSEC 公告会突然红灯。处置：确认公告影响后，短期在 `deny.toml` 的 `[advisories]` `ignore` 列表登记 id（附理由注释）解锁发布，长期升级依赖修复

**配套约束：** `ci.yml` 的 rust job 与 `build.rs` 契约必须对齐（`build.rs` 校验 `frontend/dist/index.html` 存在，故 rust job 必须先 `pnpm build` 再 `cargo check`，不能只 `mkdir -p frontend/dist` 空占位）。sync 脚本与 release.yml 已 build 前端，ci.yml 若不一致会导致 push main 即红，进而阻塞发布判定。

---

## 发布步骤

### Step 1：版本号 + 变更

```bash
# 在 dev worktree 执行
cd /home/pax/coding/OmniTerm-dev

# 更新版本号（脚本同步 Cargo.toml + Cargo.lock + frontend/package.json + npm-package/package.json）
./scripts/bump-version.sh 0.2.0

# 更新 CHANGELOG（将 [Unreleased] 改为 [0.2.0]）
# 提交版本号变更（确认 Cargo.lock 的版本行也在本次提交内——历史上曾漏掉导致 lock 落后两个版本）
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

**注意：禁止在编译失败时打 tag 推送，否则会触发失败的 CI 并浪费资源。**

### Step 4：发布前检查清单

**编译通过不等于发布就绪。** 逐项确认：

#### 验证完整性
- [ ] **目标平台编译** — 不只是本地平台，CI 会构建的所有平台都要验证（Linux/macOS/Windows）
- [ ] **测试通过** — `cargo test` + `pnpm test`（CI 会跑测试，失败会阻塞发布）
- [ ] **前端构建** — `cd frontend && pnpm build`（TypeScript 类型检查 + 打包）

#### 元数据完整性
- [ ] **Cargo.toml** — `name`、`version`、`description`、`license`、`include` 是否完整。这些字段曾在 FSL 改许可的提交里被整体覆盖丢失（`913f2b8` 加过又掉），**每次发布前必须逐项核对**，`include` 的 canonical 值：
  ```toml
  include = ["src/**", "frontend/dist/**", "migrations/**", "/build.rs", "/README.md", "/LICENSE.md"]
  ```
  ⚠️ 根级文件（`build.rs`/`README.md`/`LICENSE.md`）**必须加 `/` 前缀锚定到包根**——裸写会按 gitignore 语法在任意层级匹配，把 `frontend/node_modules` 下约 1080 个同名文件打进 crate（实测 2.6M/1168 文件 → 锚定后 988K/88 文件）。
- [ ] **crate 包内容验证** — `cargo package --allow-dirty` 后检查 `tar tzf target/package/omniterm-<ver>.crate`：`grep -c node_modules` 必须为 0，且含 `frontend/dist/`、`migrations/`、根级 `build.rs`/`README.md`/`LICENSE.md`。**不可逆发布前必做**。
- [ ] **README 中英文同步** — `README.md`（中文，默认）与 `README_En.md`（英文）内容对应，改了一边必须改另一边
- [ ] **CHANGELOG** — 版本号、日期、内容是否准确
- [ ] **Release Notes** — `.github/release-notes.md` 已基于模板生成并填好亮点（见下方「准备 Release Notes」步骤），否则 CI 发布会因 `body_path` 缺失文件失败

#### 变更影响分析
- [ ] **新增字段/类型** — 检查所有引用点：测试 mock、序列化/反序列化、前端类型定义
- [ ] **API 变更** — 后端改了接口，前端是否同步更新
- [ ] **平台特定代码** — 新增 `#[cfg(unix)]` 代码，是否有对应的 `#[cfg(windows)]` 实现

#### 环境差异意识
- [ ] **Shell 行为** — CI 的 Windows runner 默认用 PowerShell，bash 语法需要 `shell: bash`
- [ ] **编译环境** — 本地 Linux 无法验证 Windows 编译，需要用户在 Windows 上验证
- [ ] **依赖版本** — CI 环境可能与本地不同，锁定版本或使用 `--no-frozen-lockfile`

**核心原则：本地能验证的尽量本地验证，本地无法验证的明确标记并交给用户验证。**

### Step 5：用户确认

**在执行任何发布操作前，必须向用户确认：**

```
即将发布 v0.2.0：
- 版本号：0.2.0
- CHANGELOG：已更新
- 主要变更：[列出主要功能/修复]

确认发布？
```

**等待用户明确确认后才能继续。**

### Step 6：准备 Release Notes（必做，否则 CI 失败）

`release.yml` 使用 `body_path: .github/release-notes.md` 发布说明，不再自动生成。打 tag **之前**必须先在 main worktree 生成该文件，否则 CI 会因文件缺失报错。

**做法：**

1. 在 main worktree 复制模板：
   ```bash
   cd /home/pax/coding/OmniTerm   # main worktree
   cp .github/release-notes-template.md .github/release-notes.md
   ```
2. 填亮点（agent 基于 CHANGELOG 手动总结，不照搬原文）：
   - `{{VERSION}}` → 本次版本号（如 `0.1.9`）
   - `{{PREV}}` → 上一版本号（如 `0.1.8`，用于 Full Changelog 对比链接）
   - `## 新功能` / `## 重要修复` / `## 工程改进` 三段各填 1~4 条一句话亮点，聚焦用户可见价值；无内容的可删段
3. 提交并推送到 public main（CI 拉取的就是 public main）：
   ```bash
   git add .github/release-notes.md
   git commit -m "docs: release notes for vX.Y.Z"
   git push public main:main
   ```
4. 再执行 Step 7 打 tag（tag 触发 CI，CI 读取已推送的 `release-notes.md`）

> 模板结构见 `.github/release-notes-template.md`，仅定骨架，内容由发布 agent 总结。

### Step 7：打 Tag 并推送

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

### Step 8：Cargo 发布（crates.io）

> **前置条件（铁律）**：必须已确认上方「强制发布顺序」——GitHub Release CI（release.yml）完全通过、且 push main 的 CI（ci.yml）全绿后，才执行本步。crates.io 不可逆，抢跑后果见上方说明。

**发布前先验证包内容（不可逆，必做）：**

```bash
cd /home/pax/coding/OmniTerm

# 打包并检查内容：node_modules 必须为 0，且含 frontend/dist、根级文件
cargo package --allow-dirty
tar tzf target/package/omniterm-<ver>.crate | grep -c node_modules   # 期望输出 0
tar tzf target/package/omniterm-<ver>.crate | grep -E "frontend/dist|migrations/|build.rs|README.md|LICENSE.md" | head
```

```bash
# 登录 crates.io（如果未登录）
cargo login <your-crate-token>

# 发布（frontend/dist 在 .gitignore 中，必须 --allow-dirty）
cargo publish --allow-dirty
```

**注意：Cargo 发布不可逆：**
- 发布后无法删除，只能发布新版本
- 如果发现问题，只能通过发布新版本修复
- 确保版本号正确、代码无误、包内容验证通过后再发布

### Step 9：npm 发布

CI 不自动发 npm。手动执行：

```bash
# 先核对版本号（bump-version.sh 已同步 npm-package/package.json；
# 历史上曾长期漏更，npm 停在 0.1.4 而项目已 0.2.1）
grep '"version"' npm-package/package.json
npm view @gdwhisper/omniterm versions   # 确认目标版本未被占用

npm login --registry https://registry.npmjs.org/
cd npm-package
npm publish --registry https://registry.npmjs.org/ --otp=<6位数字>
```

### Step 10：验证

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

### main 独有提交被 sync 静默覆盖（配置漂移）

发布相关配置（release.yml、模板等）若直接提交在 main 上而未回流 dev，会造成 dev/main 漂移：`sync-main.sh` 对合并冲突的非黑名单文件**无条件接受 dev 版本**，main 独有改动会被静默回退。实例：release-notes 机制（`body_path` + 模板）曾只提交在 main（`1b43016`），dev 的 release.yml 长期停留旧版 `generate_release_notes`，2026-07-29 才在 dev 重放对齐。

**守则：**
- 所有代码/CI 配置改动**一律先改 dev**，经 `sync-main.sh` 流向 main；main 上只允许发布时产生的内容（如 `release-notes.md`）
- 若历史上已有 main 独有改动，在 dev **重放等价改动**（复制文件/手动改），禁止 main→dev 反向合并（见 `branch-workflows.md` 同步规则）
- 发布前对比：`git -C <main-worktree> log --oneline main --not origin/dev -- .github/ scripts/` 检查 main 是否有未回流的配置提交

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

### main worktree 残留未完成合并（MERGE_HEAD）

`sync-main.sh` 若曾被中断（如编译失败 / 手动 Ctrl-C），main worktree 会留下 `MERGE_HEAD`，导致后续 `git merge --ff-only` 报「尚未结束您的合并」。

**做法：**
- sync 前先检查：`git -C <main-worktree> status` 看是否有 `MERGE_HEAD` 或 `You have unmerged paths`
- 有残留则先 `git merge --abort`，再用 `git reset --hard origin/main` 把本地 main 对齐远端
- 不要带着半截合并直接跑 sync，否则会污染 main

### public/main 落后于本地 main（non-fast-forward）

`main` 本应由 `sync-main.sh` 从 dev 单向同步，但历史上若有人在 public 仓 main 手动提交过，public/main 会领先本地 main 一个旧提交，push 被拒 `non-fast-forward`。

**根因：** public 仓 main 与同步源（dev）出现分叉；旧提交（如旧版 README 重写）的内容已被 0.1.8 完全覆盖，属历史遗留。

**做法：**
- 先 `git fetch public main`，用 `git log --oneline public/main --not HEAD` 确认 public 独有提交是什么
- 确认本地 main 已包含等价/更新内容后，用 `git push --force-with-lease public main:main` 安全覆盖（`--force-with-lease` 仅在 public/main 未被他人意外改动时才成功，比 `--force` 安全）
- **禁止**在 public 独有提交含有效改动时用强推——务必先 diff 确认其内容已被覆盖

### CHANGELOG 顶部堆积的 `[Unreleased]` 区块

若日常开发把改动随手写进顶部 `[Unreleased]` 而不随版本归档，多个版本后会混成一段时间线矛盾、跨版本的大块（如 06-23 ~ 07-13 混在一起），直接发布会污染新版本条目。

**做法：**
- 发布前用 `git log v<上一版本>..dev --oneline` 取得**权威的本次改动清单**，不依赖 CHANGELOG 里的 `[Unreleased]`
- 以该清单重写顶部 `[X.Y.Z] - YYYY-MM-DD` 条目，删除陈旧的 `[Unreleased]` 堆积块
- 落实「每次发版即时归档」习惯：发版时把 `[Unreleased]` 的内容移到对应版本号下，避免再次堆积

### crates.io 前端资源未入库（`--allow-dirty`）

`frontend/dist` 在 `.gitignore` 中，但 `Cargo.toml` 的 `include` 显式含 `frontend/dist/**`。`cargo publish` 默认拒绝 dirty tree（未提交文件），直接 publish 会失败。

**做法：**
- publish 前确认 `cargo publish --dry-run` 已把 `frontend/dist/**` 打进包
- 用 `cargo publish --allow-dirty` 放行（dist 是构建产物，本就不入库，属既定方案）
- `include` 的 canonical 值（含根级文件，`/` 前缀锚定到包根）：
  ```toml
  include = ["src/**", "frontend/dist/**", "migrations/**", "/build.rs", "/README.md", "/LICENSE.md"]
  ```
  缺 `frontend/dist/**`、`migrations/**`、`src/**` 会导致 `cargo install` 后前端 / 迁移缺失。

**⚠️ node_modules 误打包陷阱（0.1.9 实测）：** `include` 里裸写 `README.md` / `LICENSE.md`（无 `/` 前缀）会按 gitignore 语法在**任意层级**匹配，把 `frontend/node_modules` 下约 1080 个同名文件打进 crate（2.6M/1168 文件）。根级文件**必须加 `/` 前缀**锚定。发布前用 `tar tzf target/package/omniterm-<ver>.crate | grep -c node_modules` 验证为 0。

### GitHub Release notes 缺少用户友好总结

`release.yml` 用 `body_path: .github/release-notes.md` 读取发布说明。若打 tag 前没生成该文件（见 Step 6），CI 会失败；若只是内容敷衍，Release 页就只剩骨架无亮点。

**做法：**
- 打 tag **前**先按 Step 6 用 `.github/release-notes-template.md` 生成并填好亮点，推送到 public main
- 已发布但内容不理想，用 `gh release edit vX.Y.Z --notes-file notes.md` 补救（新功能 / 重要修复 / 工程改进 / 安装升级指引）

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
- Cargo.toml 检查：name、version、description、license、repository、readme、include（含 `/LICENSE.md`）
- README 检查：README.md（中文，默认）与 README_En.md（英文）内容同步、安装方式准确
- LICENSE.md 检查：与 Cargo.toml `license` 字段一致（当前 FSL-1.1-MIT）
- CHANGELOG 检查：版本号、日期、内容完整

### 4. 环境差异 = 提前识别

**本地环境 ≠ CI 环境。** Shell 行为、平台 API、依赖版本都可能不同。

**做法：**
- CI 用什么 shell，本地就用什么 shell 测试
- 平台特定代码用 `#[cfg]` 保护，并提供替代实现
- 依赖版本锁定或明确使用 `--no-frozen-lockfile`

### 5. 发布前清理 = 发布产物的一部分

**CHANGELOG 与 git 历史是发布产物的真相源，不是草稿纸。** 顶部 `[Unreleased]` 堆积、main worktree 残留合并、public/main 分叉，都会在发布时突然爆雷。

**做法：**
- 发布前固定三查：`git status`（无残留合并 / 干净树）→ `git fetch` 对比 main 与 public/main（无意外分叉）→ `git log v<上一版本>..dev`（本次改动权威清单）
- CHANGELOG 以 git log 为准重写，不信任历史 `[Unreleased]` 区块
- 把「清理」当作发布步骤而非事后补救，写进发布检查清单

---

## 平台映射表

install.sh 和 install.js 中 OS/架构 → binary 文件名映射：

| 用户环境 | binary 文件名 |
|----------|--------------|
| Linux x86_64 | `omniterm-linux-x86_64` |
| Linux aarch64 | `omniterm-linux-aarch64` |
| macOS Apple Silicon | `omniterm-macos-aarch64` |
| macOS Intel | 不支持（提示用户换 Apple Silicon） |
| Windows | 不支持（依赖 tmux） |
