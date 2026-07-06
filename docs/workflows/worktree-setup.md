# Git Worktree Setup

## File Convention

`CLAUDE.md` 是 `AGENTS.md` 的符号链接（`CLAUDE.md → AGENTS.md`），两个名称指向同一份规范文件，实文件为 `AGENTS.md`。

## Worktree Directories

三个 worktree 共享 `.git` 对象，各自独立工作：

| 目录 | 默认分支 | 用途 |
|------|----------|------|
| `~/coding/OmniTerm` | `main` | 发布前哨站（可 checkout release 进行发布操作） |
| `~/coding/OmniTerm-dev` | `dev` | 日常开发 |
| `~/coding/OmniTerm-debug` | `debug` | 紧急修复 |

## 新 Worktree 初始化

```bash
# 1. 添加 worktree
git worktree add ~/coding/OmniTerm-<branch> <branch>

# 2. 复制分支配置模板
cp branch.config.example .env.local

# 3. 编辑 .env.local，填入该分支的端口/域名/版本/二进制名
#    参考 docs/workflows/branch-workflows.md「分支身份约定」表

# 4. 启动验证
./dev.sh start
```

`branch.config.example` 缺失时直接创建 `.env.local`（参考其他 worktree 的 `.env.local` 和 `docs/workflows/branch-workflows.md` 表）。

## Remote Repos

- **私有仓**（`origin`）：存放所有分支（main/dev/debug/release），完整开发历史
- **公开仓**（`public`）：只推送 `release` 分支（干净代码），用于对外发布

```bash
git remote add origin git@github.com:yourname/OmniTerm-private.git
git remote add public git@github.com:yourname/OmniTerm.git
```

## Release Branch Publish Flow

```bash
cd ~/coding/OmniTerm          # main worktree
git checkout release
git merge main --no-commit     # 合并 main 最新代码

# 排除开发相关文件
git reset HEAD \
  CLAUDE.md AGENTS.md \
  .pi/ .qoder/ .codegraph/ \
  openspec/ \
  docs/superpowers/ docs/dev/plans/ docs/reference/requirements.md \
  .dev/ omniterm.db.bak \
  dev.sh PROGRESS.md CHANGELOG.md
git checkout -- \
  CLAUDE.md AGENTS.md \
  .pi/ .qoder/ .codegraph/ \
  openspec/ \
  docs/superpowers/ docs/dev/plans/ docs/reference/requirements.md \
  .dev/ omniterm.db.bak \
  dev.sh PROGRESS.md CHANGELOG.md

git commit -m "release: v1.x.x"
git push public release:main   # 推送到公开仓
```

详见 `docs/workflows/release-guide.md`。
