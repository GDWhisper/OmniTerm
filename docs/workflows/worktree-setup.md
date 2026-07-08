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
