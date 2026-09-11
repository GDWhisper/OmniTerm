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

### 前端依赖安装：仓库根 `pnpm install`（2026-09-12 起有仓库级 workspace）

```bash
pnpm install    # 仓库根执行，无需任何额外参数
```

仓库根的 `pnpm-workspace.yaml`（packages: frontend）把 workspace 锚定在本仓库内，pnpm 从任何子目录向上找 workspace 都会**先命中这里**，够不着 `~/` 的全局工具 workspace。node_modules 布局为「根 `node_modules/.pnpm` 虚拟 store + `frontend/node_modules` 符号链接」，包文件经全局内容寻址 store 硬链接共享，多 worktree 不重复占磁盘。

**历史坑（仅未同步 2026-09-12 提交的老 worktree 仍适用）**：`~/` 下存在 `pnpm-workspace.yaml` + `package.json`（全局 CLI 工具 pi 系列的安装位置），仓库没有自己的 workspace 文件时 pnpm 会向上递归命中它并当作 workspace root——本项目的依赖一个也不装，却按 home 的 lockfile 重排 `~/node_modules`（实测输出过 `-69` 个包的移除）；pnpm ≥12 还会在跑脚本前的自动依赖校验里直接报 `ERR_PNPM_IGNORED_BUILDS`（ignored builds 从警告升级为硬错误），`dev.sh` 拉前端即失败。老 worktree 装依赖仍需 `cd frontend && pnpm install --ignore-workspace`。

**老 worktree 迁移到 workspace 布局（合并本提交后一次性）**：

```bash
git pull                        # 拿到根 pnpm-workspace.yaml 与移到根的 pnpm-lock.yaml
rm -rf frontend/node_modules    # 旧布局的虚拟 store 由根级取代，先清掉免交互确认
pnpm install                    # 仓库根执行；只重建硬链接不重新下载（约 4s）
```

其他已踩过的坑：

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
