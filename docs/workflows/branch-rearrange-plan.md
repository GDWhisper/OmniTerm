# 分支重排计划（初步方案 · DRAFT）

> ⚠️ **本文件为初步方案，未经用户确认，禁止 LLM 直接据此动手实施。**
> 任何落地动作（改名、改 Cargo.toml / .env.local / Dockerfile / AGENTS.md / CI 等）
> **必须先就下方「待用户确认决策点」逐条与用户对齐**，得到明确答复后方可执行。
> 本计划只做现状梳理 + 方向提案，不承诺实现细节。

---

## 0. 用户倾向（记录用户原始设想，非定稿）

> 以下为用户在提出本任务时表述的**倾向性方向**，供方案讨论参考。
> 仍属初步方案范畴，**不授权 LLM 直接实施**，最终以第 3 节决策点确认为准。

用户的设想（原话大意）：

- **`main` 应作为发布分支**——这样更符合 LLM 的使用习惯，避免反复把分支名搞乱。
- 把**当前的 `release` 代码转为 `main`**（即 main 直接承载干净发布版 `omniterm`）。
- 把**当前的 `main` 转为 `preview`**（体验分支），用户在 `preview` 上体验新版本。
- **后续发布流程改为：合并到 `main` 上发布**（不再走独立的 release 分支）。
- **体验则在 `preview` 上进行**，`preview` 使用带后缀的开发名（而非干净名 `omniterm`）。

对应到根因（见第 1 节）：该设想与现状高度吻合——`main` 的 Cargo.toml 已是干净名
`omniterm`，只是文档与分支语义尚未对齐。把 main 确立为发布分支几乎是「顺势确认」，
迁移成本最低。

待澄清点（用户未明确，需后续确认）：
- `preview` 是**重命名现有 `dev`** 还是**新建分支**；其固定包名用 `omniterm-preview` 还是 `omniterm-dev`。
- 原 `dev` 的代码/历史如何安置（并入 preview？保留？）。
- `release` 分支废弃后，public 仓推送（`git push public ...:main`）改由谁承担。

---

## 1. 背景与根因

### 1.1 触发

- 执行 `dev → main` 合并时，发现 `Cargo.lock` / `Cargo.toml` 包名与文档约定严重错位，
  且 `main` / `dev` / `release` 三套分支身份的包名在历次 merge / sync 中反复翻转。
- 用户判断：**根因是分支语义设计本身容易让 LLM（及人工）在 sync 时把分支名搞乱**，
  提议改为「`main` 作为发布分支，`preview`（或保留 `dev`）作为体验分支」的更清晰模型。

### 1.2 现状实测（2026-07-07，基于 git 实际取值）

**Cargo.toml `[package] name`**

| 分支 | Cargo.toml `name` | version |
|------|-------------------|---------|
| `main`   | `omniterm`      | 0.1.6 |
| `dev`    | `omniterm-main` | 0.1.0 |
| `release`| `omniterm`      | 0.1.6 |
| `debug`  | `omniterm-server` | 0.0.1 |

**`.env.local`（`BRANCH_BINARY_NAME` 等）**

| worktree | `BRANCH_BINARY_NAME` | 与 Cargo.toml 对比 |
|----------|----------------------|--------------------|
| `main`   | （无 `.env.local`）  | Cargo.toml = `omniterm` |
| `dev`    | `omniterm-dev`       | Cargo.toml = `omniterm-main` ⚠️ **矛盾** |
| `debug`  | （缺 `BRANCH_BINARY_NAME`） | Cargo.toml = `omniterm-server` |

### 1.3 矛盾点（即「LLM 把分支搞乱」的确凿证据）

1. **`dev` 自相矛盾**：`.env.local` 声称 `omniterm-dev`，但 `Cargo.toml` 实际是
   `omniterm-main`。两者按 AGENTS.md 硬性规则本应一致（改 `BRANCH_BINARY_NAME`
   须同步改 `Cargo.toml`）。说明某次 `main → dev` sync 把 `main` 的旧名
   `omniterm-main` 覆盖进了 dev 的 Cargo.toml，且未被察觉。
2. **`main` 已实质是发布分支，但文档未跟上**：`main` 的 Cargo.toml 已是干净名
   `omniterm`（来自 `721f1e6 feat: crates.io 发布支持`），与 `release` 同名同版本。
   文档却仍写「main = `omniterm-main` 发布前哨」，约定与现实脱节。
3. **`debug` 停留在最老命名** `omniterm-server`，且 `.env.local` 缺关键变量。
4. **命名规则本身自相矛盾**：文档第 38 行写「二进制名 = `omniterm-<branch>`，
   release 例外为干净 `omniterm`」，但 `main` 既非 release 却也已用干净名 `omniterm`，
   导致 `main` 与 `release` 同名——这正是 sync 时互相覆盖、翻转的根源。

### 1.4 翻转历史（节选，证明是反复来回而非单次失误）

- `18bd4b7` 把 dev 正确设为 `omniterm-dev`
- 此后每次 `main → dev` 的 merge / sync，因彼时 main 是 `omniterm-main`，
  把 dev 又拉回 `omniterm-main`
- `721f1e6` main 改干净名 `omniterm`（crates.io 发布需要），但后续未恢复 `omniterm-main`
- 结果：main 与 dev 的「应有名字」互换，且都与文档不符

---

## 2. 初步方案方向（供讨论，非定稿）

### 2.1 核心思路

让**分支语义与包名一一对应且永不随 sync 翻转**：

- **`main` = 发布分支**：永远使用干净名 `omniterm`，是 crates.io / GitHub Release /
  Docker / npm 的发布源。合并 `preview`（或 `dev`）的新功能进来即代表「要发布」。
- **`preview` = 体验 / 开发分支**（用户当前在 `dev` 上体验）：固定一个带后缀的
  开发名（如 `omniterm-preview` 或保留 `omniterm-dev`），**永不改为 `omniterm`**，
  也**永不借用到 main 的名字**。
- **sync 方向单一化**：功能 `preview → main`（发布）；紧急修复 `debug → preview`。
  不再要求 `main` 反向 sync 回开发分支，从根上消除「名字被带回」的翻转机会。
- **`release` 分支定位待定**（见决策点 3）：要么保留作 public 仓镜像，
  要么废弃（改由 `main` 直推 public）。

### 2.2 预期收益

- 每个分支身份固定唯一，LLM/人工 sync 时不会再把名字搞混
- 包名仅两类：`omniterm`（发布）与 `omniterm-<开发后缀>`（体验），规则简单无特例
- 与「`main` 已是干净名 `omniterm`」的现状天然吻合，迁移成本最低

---

## 3. 待用户确认决策点（必须逐条确认，禁止 LLM 臆测）

> LLM 在实施前，须就以下每一项取得用户明确答复。未确认前不得改动任何文件。

1. **体验分支叫什么？**
   - 选项 A：保留 `dev` 作为 git 分支名，仅赋予「体验分支」语义（最小改动，但名实仍偏）
   - 选项 B：把 `dev` 重命名为 `preview`（语义清晰，但需协调 remote / CI / 所有历史引用）
   - 选项 C：新建 `preview` 分支，保留 `dev` 不动（双分支并存，过渡期）
   - 该分支 Cargo.toml 固定名：`omniterm-dev` 还是 `omniterm-preview`？

2. **`main` 是否正式确立为「唯一发布分支」？**
   - 确认后，`main` 的 `omniterm` 包名即定为长期约定，文档据此重写
   - 是否意味着「发布流程」从 `release` 切到 `main`？（关联决策点 3）

3. **`release` 分支如何处理？**
   - 保留作 public 仓镜像（`git push public release:main` 日常推送仍走它）？
   - 还是废弃，改为 `main` 直推 public？
   - 若保留：`release` 与 `main` 都用 `omniterm` 干净名，二者关系（谁为准）需明确

4. **`debug` 分支怎么办？**
   - 当前 `omniterm-server` 旧名 + 缺 `.env.local` 变量，是否一并纳入重排？
   - 其开发后缀用 `omniterm-debug` 还是保留 server 语义？

5. **同步规则重写**
   - 是否确立「单向 sync：preview→main、debug→preview，禁止 main→开发分支回写」？
   - 这需要在 AGENTS.md / branch-workflows.md 把「双向保留各自值」改为「单向 + 固定身份」

6. **配套文件联动清单（确认方案后由 LLM 逐项核对，非现在执行）**
   - 各 worktree `Cargo.toml` `[package] name` + `[[bin]] name`
   - 各 worktree `.env.local` `BRANCH_BINARY_NAME`（须与 Cargo.toml 一致）
   - `Dockerfile` `ARG` / `CMD`
   - `docker-compose` `ports` / `BIND_ADDR`
   - `dev.sh` 端口 / 分支逻辑
   - `AGENTS.md` 配置统一管理表 + 分支身份约定
   - `branch-workflows.md` 全文
   - `release-guide.md` / `worktree-setup.md` 相关段落
   - CI（`.github/workflows/*`）涉及的分支名与包名

---

## 4. 落地步骤草案（仅框架，确认后细化）

1. 用户确认第 3 节全部决策点
2. LLM 产出**精确改动清单**（逐文件、逐行期望值），再次交用户复核
3. 用户批准后，按「先 dev 身份固化 → 再 main 文档对齐 → 最后 CI/release 联动」顺序执行
4. 每步提交并独立验证 `./dev.sh restart`（依 branch-workflows.md 既有要求）
5. 更新 CHANGELOG / PROGRESS（实质性改动才写）

---

## 5. 本次 `dev → main` 合并的状态说明

- 合并已在冲突中途 **`git merge --abort` 中止**，当前 `main` 工作区干净（HEAD = 86e3105）。
- 中止原因：先解决分支身份根因，避免把错乱的包名进一步合进 main。
- 待分支重排方案确认后，再决定合并时机与方式（可能改为 `preview → main` 的新模型下合并）。
