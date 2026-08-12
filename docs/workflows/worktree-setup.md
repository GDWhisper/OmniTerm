# Git Worktree Setup

## File Convention

`CLAUDE.md` 是 `AGENTS.md` 的符号链接（`CLAUDE.md → AGENTS.md`），两个名称指向同一份规范文件，实文件为 `AGENTS.md`。

## Worktree Directories

三个 worktree 共享 `.git` 对象，各自独立工作：

| 目录 | 默认分支 | 用途 |
|------|----------|------|
| `~/coding/OmniTerm-dev` | `dev` | 开发前沿 |
| `~/coding/OmniTerm-preview` | `preview` | 私人稳定分支（日常工具） |
| `~/coding/OmniTerm-debug` | `debug` | 紧急修复 |
| `~/coding/OmniTerm` | `main` | 发布分支（非 worktree，仅用于 sync 发布） |

## 新 Worktree 初始化

```bash
# 1. 添加 worktree
git worktree add ~/coding/OmniTerm-<branch> <branch>

# 2. 复制分支配置模板
cp branch.config.example .env.local

# 3. 编辑 .env.local，填入该分支的端口/域名/版本/二进制名
#    参考 docs/workflows/branch-workflows.md「分支身份约定」表

# 4. 更新 Cargo.toml 的 package name
#    与 .env.local 中 BRANCH_BINARY_NAME 保持一致

# 5. 启动验证
./dev.sh start
```

`branch.config.example` 缺失时直接创建 `.env.local`（参考其他 worktree 的 `.env.local` 和 `docs/workflows/branch-workflows.md` 表）。

### 前端依赖安装：`pnpm` 必须带 `--ignore-workspace`

```bash
cd frontend && pnpm install --ignore-workspace
```

**不带这个参数会误操作你的 home workspace。** `~/` 下存在 `pnpm-workspace.yaml` + `package.json`（全局 CLI 工具的安装位置），pnpm 会从 `frontend/` 向上递归找到它并当作 workspace root；而本项目并不在其 `packages` 列表里，于是：本项目的依赖一个也不装，却会按 home 的 lockfile 重排 `~/node_modules`（实测输出过 `-69` 个包的移除）。

另外两个已踩过的坑：

- **`pnpm` 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`**：切换安装模式时它要重建 `node_modules` 但无法交互确认。先 `mv node_modules node_modules.bak` 再装（比 `CI=true` 直接 rm 可逆）；**备份目录不在 `.gitignore` 里**，装完记得删，否则 `git add -A` 会把它整个提交进去。
- **验证类型检查只能用 `pnpm exec tsc -b`**：根 `tsconfig.json` 是 references 空壳，裸 `tsc --noEmit` 不检查任何文件、总是假绿（同 `scripts/hooks/pre-commit:23-24`）。写验证命令时也别把它接管道，`$?` 拿到的是末端（如 `tail`）的退出码。

## Remote Repos

- **私有仓**（`origin`）：存放所有分支（main/dev/preview/debug），完整开发历史
- **公开仓**（`public`）：只推送 `main` 分支（干净代码），用于对外发布

```bash
git remote add origin git@github.com:yourname/OmniTerm-private.git
git remote add public git@github.com:yourname/OmniTerm.git
```

## 分支同步

- **dev → preview**：全量合并
- **dev → main**：使用 `./scripts/sync-main.sh`（自动排除黑名单 + 修复分支配置）

详见 `docs/workflows/branch-workflows.md` 和 `docs/workflows/release-guide.md`。
