# Branch Workflows

## Development Conventions

1. **开发/debug 后必须提交 git** — 每完成一个功能点或修复一个 bug 后，立即 `git commit`
2. **CHANGELOG 只写用户确认的内容** — 只有经过用户确认的新功能和修复才写入 `CHANGELOG.md`
3. **提交前缀规范**：
   - 功能/修复：`feat:` / `fix:`
   - 开发文档/配置：`docs:` / `chore:` — 合入 release 时会被过滤

---

## 各分支工作流

### debug 分支

1. **拉取最新 dev**：`cd ~/coding/OmniTerm-debug && git merge dev`
2. **原子化提交**：核心修复 → `fix:`，本地定制 → `chore: 本地调试配置` 单独提交
3. **只做修复，不加功能**
4. **独立验证**：在 debug 专属端口（19777/19778）启动服务测试
5. **合入 dev**：切换到 `~/coding/OmniTerm-dev` 执行 `git merge debug`

### dev 分支（主开发分支，最活跃）

- **作用**：日常功能开发 + bug 修复的主战场，所有代码改动先在此完成
- **工作目录**：`~/coding/OmniTerm-dev`
- **启动**：`./dev.sh start`（后端 9777 + 前端 9778）
- **提交规范**：功能/修复用 `feat:` / `fix:`，开发文档/配置用 `docs:` / `chore:`
- **合入来源**：定期从 `debug` 合并修复（`git merge debug`）
- **合出目标**：功能稳定后合并到 `main` 进入发布前哨

### main 分支（发布前哨站）

- **作用**：以用户视角体验即将发布的新版本，冻结后不再加功能
- **启动**：`cd ~/coding/OmniTerm && ./dev.sh start`（后端 9075 + 前端 9076）
- **文档**：保留 AGENTS.md、dev.sh、docs/ 等开发文件
- **排除**：main 不含 npm/、install.sh、.github/workflows/release.yml（这些是 release 专属）

### release 分支

- **作用**：干净的公开代码，剔除所有开发文件
- **发布**：tag push → CI 自动构建多平台 binary + GitHub Release + npm + Docker
- 详见 `docs/release-plan.md`（dev 分支）

---

## 多 Agent 协作安全守则

- **撤销已推送提交**：必须用 `git revert`，严禁 `git reset --hard` 或 `--force`
- **禁止**从 debug/dev 直接 `git push origin debug:dev` 覆盖其他分支
- **冲突处理**：发生在哪个工作树，就在哪个工作树解决
