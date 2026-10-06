# 构建与协议 — 调试模式

覆盖：构建期字节契约（.gitattributes/checksum）、批量枚举 per-item 容错、三态布尔序列化、wire-format 抓帧、热路径 spawn 成本、渠道字节差异探针、Windows spawn 裸命令名（PATHEXT）、warn 被读成失败、通用名 env 被进程树继承劫持（含 RUST_LOG 日志劫持零日志）、自替换后 current_exe 失效（/proc/self/exe，含 npm reify retire+delete 与 restart_command argv[0] 归一）。

---

## 模式 1：构建期字节契约（checksum / include_str 类资产）

**构建-字节**：`sqlx::migrate!` 的 checksum 是**编译时对文件原始字节的哈希**——任何「构建环境」与「权威源码」之间的字节差异（最典型换行符）都会在运行时炸成 migration 已修改错误。跨平台发布构建，文本类构建期资产必须显式声明换行符（`.gitattributes` `eol=lf`），不能依赖 git 默认行为：GitHub Actions `windows-latest` runner 默认 `core.autocrlf=true` checkout 时把无属性文本文件 LF→CRLF，crates.io 的 `.crate` 不经 autocrlf 保持 LF——同一源码两种渠道二进制内嵌字节可以不同。**「为什么 A 渠道正常、B 渠道报错」是构建产物差异的探针**：同库同版本不同渠道行为不一致 → 差异在产物二进制内嵌的构建期内容，优先对比构建环境而非 debug 业务代码。

**适用**：参与编译期内容哈希（`include_str!`/embed/宏）或脚本逐字节比较的文件；发布流程涉及多个构建环境。

**案例证据**：
- 2026-08-04 Windows npm 包 `omniterm start` 报 migration 已修改，cargo 版正常；`git log` 干净但字节不同。修复：`.gitattributes` `migrations/*.sql text eol=lf` + `git add --renormalize` + 重发布。

---

## 模式 2：批量枚举中单条目错误用 `?` 传播 = 一颗老鼠屎坏一锅粥

**协议-容错**：列目录/批量 stat/递归扫描这类「尽力而为」语义的接口，per-item 错误应跳过（可选记日志），只有容器级错误（read_dir 本身失败）才值得让整个请求失败。写 `?` 前先问：这个错误影响整个操作还是当前条目？「metadata 一定成功」是 Unix 惯性假设，Windows 上不成立（用户主目录天然含 ACL deny 的遗留 junction）。同一模块内已有正确容错先例时先对齐再造新逻辑。

**适用**：任何批量枚举/扫描 API；跨平台路径遍历。

**案例证据**：
- 2026-07-29 Windows 主目录存在 ACL deny 的遗留 junction，`metadata` 失败经 `?` 传播 → 整个目录列表 500。修复：per-entry 失败 `continue` 跳过，`next_entry()?` 改 `while let Ok(Some(_))`。

---

## 模式 3：三态布尔序列化（skip_serializing_if 吞 false + 事件驱动被轮询覆盖）

**协议-序列化**：`skip_serializing_if = "is_false"` 会把「显式 false 有语义」的布尔字段抹掉，而轮询整体替换会把「字段缺失」当成「非 false」。**布尔字段若承担「三态语义」（true/false/缺失等价于某态），绝不可 skip**；skip 只适合「字段缺省 = false」的纯可选标注。两个写同一字段的真相源必须语义等价：事件驱动状态（精准瞬间）会被「整体替换」的轮询写方在响应缺字段时冲掉。事件驱动状态要么收敛进不被整体替换的独立 store，要么保证每个写方响应字段完整。

**适用**：布尔存活/启用字段 + 轮询 + 事件驱动的双写方组合；serde 序列化配置。

**案例证据**：
- 2026-08-04 ACP released 态（`acp_process_alive=false`）被 3s 轮询整体替换 sessions 时因 skip_serializing_if 缺失 → 恢复按钮闪断。修复：移除 skip_serializing_if 恒序列化。

---

## 模式 4：wire-format 不匹配时 fallback 路径无声吞掉真实数据

**协议-抓帧**：解析器只认一种 wire format，匹配不上就返回 null 落到 fallback，帧确实在来但被无声归到 fallback。诊断三步走不跳步：① 抓原始帧（console.info dump 真实 payload）；② 对比 wire format 与解析代码期望形状；③ 在边缘把 vendor 特有形状 normalize 成 canonical，下游解析器只处理 canonical。**跳第 1 步直接看代码会原地打转**——代码本身是"对的"（符合 crate 默认），问题在协议另一端。厂商差异放模块顶层 adapter 表（追加新 agent 是表加行不是分支丛林）。

**适用**：任何外部协议联调（ACP/MCP/LSP）；`wire format 永远是协议联调的第一个未知量，抓帧是唯一真相源`。

**案例证据**：
- 2026-07-19 crate 默认外部标签枚举 vs codebuddy 扁平判别字段，`extractTextChunk` 落 fallback → `[update]` 芯片刷屏。修复：`SESSION_UPDATE_ADAPTERS` 表 normalize + `classifySessionUpdate` 动作标签。

---

## 模式 5：热路径上每连接串行 spawn 子进程先量化成本

**协议-性能**：Windows 进程 spawn ~30-50ms，是 Linux 习惯（fork+exec ~1-5ms）的盲区；同一代码在 Linux 上「免费」的每请求子进程调用在 Windows 上变成可感知延迟。幂等的、目标状态持久的副作用 → 「成功一次后缓存跳过 + fire-and-forget」模式（三问：目标状态是否持久？失败能否下次重试？调用方真需要等结果吗？）。「只在某平台慢」的体感问题用临时探针把链路各段耗时分解成数字表，区分可消除开销与固有成本。

**适用**：热路径（连接建立/切换/每请求）上的子进程调用；Windows 体感延迟。

**案例证据**：
- 2026-07-29 Windows+psmux 切换会话横幅停留：每次 WS 连接串行 await escape-time 一次性命令 ~40ms。修复：static AtomicBool 成功后缓存跳过 + `tokio::spawn` fire-and-forget。

---

## 模式 6：渠道字节差异探针（跨平台构建）

**构建-探针**：同一数据库、同一版本、不同安装渠道行为不一致 → 差异不在代码逻辑、不在数据，而在两个产物二进制内嵌的构建期内容（换行符/embed）。对比渠道时先确认是否同 commit，再对比构建环境（OS/git 配置/打包方式）。验证产物实际内容用 `strings 二进制 | grep 文案` 而非假设二进制包含某提交。

**适用**：cargo install vs npm 平台包 vs 源码构建等多渠道；运行日志缺失 ≠ 路径没走（先核对二进制是否含该日志的提交，再查日志级别过滤）。

**案例证据**：
- 2026-08-04 migration checksum 两渠道不一致（见模式 1）。
- 2026-08-06 preview 日志无 replay 诊断行，实为运行二进制（17:01 构建）早于诊断日志提交。修复过程用 `strings` 验证二进制内容。

---

## 模式 7：Windows spawn 裸命令名 —— 存在性检查通过 ≠ 能 spawn（PATHEXT 盲区）

**协议-平台**：`std::process::Command::new("npm")` 在 Windows 上**只**按 PATH 补 `.exe`，**不读 `PATHEXT`**；而 npm/yarn/pnpm/tsc 这类 Node 工具在 Windows 只落 `npm.cmd`/`npm.ps1`，于是 spawn 直接返回 `NotFound: program not found`。危险的是「前置存在性检查用 `which`、spawn 用裸名」的组合：`which` crate 遵循 PATHEXT 能解析到 `npm.cmd`，检查通过 → 友好提示分支被跳过 → 用户只看到裸的 `program not found`。**规律：谁做存在性检查，就必须把它解析出的绝对路径交给 spawn**，两条不同的解析规则各查一遍必然在某平台错位。std ≥1.77.2 对 `.bat`/`.cmd` 结尾的 program 会自动用 cmd.exe 包装并做 CVE-2024-24576 参数转义，所以传绝对路径是安全且够用的（无需自己拼 `cmd /C`）。

**适用**：任何 spawn 外部 CLI（包管理器/git/node 工具链）的代码；Linux 上「裸名能跑」是最强的假阴性来源，本地测不出来。

**案例证据**：
- 2026-08-08 Windows `omniterm update` 报 `failed to run npm / Caused by: program not found`：`which::which("npm")` 解析到 `npm.cmd` 通过前置检查，`Command::new("npm")` 找不到 `npm.exe`。修复：抽 `resolve_program()` 统一 `which` 解析为绝对路径后 spawn（`delegate` / `delegate_captured` 共用）。同源旁证：`npm-package/shim.js` 早已用 `shell: process.platform === 'win32'` 绕过同一坑。

---

## 模式 8：warn 级日志被读成失败 —— 判定成败只认退出码

**协议-语义**：代跑外部工具时，**唯一的成败真相是退出码**，stderr 上的 `warn` / 堆栈 / `EPERM` 字样都不是。危险在于 CLI 直通 stdio 时，这些 warn 会原样打到用户眼前，而用户（和读日志的 agent）会把它读成失败 → 埋头修一个不存在的 bug。**代跑的工具已知会在正常路径上吐 warn 时，调用方有义务补一句消歧义提示**，而不是把解释成本留给用户。读报错时先找「最终状态行」（如 npm 的 `changed N packages`）再下结论。

**适用**：任何 spawn 包管理器/构建工具并透传输出的代码；用户报「报错了」但贴的日志里存在成功标志时。

**案例证据**：
- 2026-08-11 Windows 服务器运行中执行 `npm install -g @gdwhisper/omniterm@latest` 输出一屏 `npm warn cleanup ... EPERM ... unlink omniterm.exe`，被读成升级失败；实际末尾 `changed 2 packages in 2s` 且退出码 0。机制：npm 先 rename 旧包目录为 `.omniterm-<hash>`（retire）→ 新包就位 → 删 retire 目录时因运行中的 exe 而 unlink 失败（Windows 允许 rename 含运行中 exe 的目录，不允许 unlink）。修复：CLI 在 `cfg!(windows)` 下补消歧义提示，不改判定逻辑。

---

## 模式 9：通用名环境变量被进程树继承劫持 —— 配置来源必须能被"外人"命中才算安全

**部署-配置来源**：进程树继承环境是单向传染的：开发服务器 export 的部署变量会进入它派生的每一个用户终端，用户在这些终端里跑的**同名不同实例**二进制会静默读到开发配置。通用变量名（`BIND_ADDR` / `BACKEND_PORT` / `DATABASE_URL` / `JWT_SECRET`）是这类劫持的必然入口——`DATABASE_URL` 更是用户自己项目里最常见的变量之一。**规律：面向用户分发的二进制，其配置 env 一律加产品前缀（`OMNITERM_*`）；开发/部署脚本给自家后端传配置优先用命令行参数，能不 export 就不 export。**「CLI 优先级高于 env」的补丁不解决问题：用户按默认用法（不带参数）启动时仍被劫持。弃用旧名后加一条启动 warn 提示改名，比静默忽略（数据库路径悄悄换掉）安全。

**派生边界的同族投影**：同一机制还以「宿主 → 派生 agent」方向发作——宿主进程树的会话运行态指针（服务端口、内部服务 URL、网关凭据）会被 spawn 的外部 agent 与派生终端全盘继承。宿主必须在**所有派生点**统一剥离（清理清单收敛为单一真源，勿各自维护），不能依赖对端容错。

**适用**：任何既在开发环境里跑、又对外发布可执行文件的项目；任何 spawn 外部 agent/子进程的宿主。症状是「同一份正式版在 A 终端能起、在 B 终端起不来」或「只有某个 agent 卡、其他 agent 正常」。**弯路**：报错是 `Address already in use`，第一反应是查端口占用/僵尸进程/PID 文件，实际端口值本身来自继承的环境——先 `printenv | grep -E '<全部候选变量名>'` 打印**用户实际 shell** 的环境，再看代码优先级链。

**案例证据**：
- 2026-08-11 npm 正式版 `omniterm start` 报 `Address already in use`（os error 98）。根因：用户 shell 是开发实例派生的终端，继承了 dev.sh export 的 `BIND_ADDR=127.0.0.1:9075` / `BACKEND_PORT=9075`，正式版被劫持去绑开发实例已占的端口；`env -u BIND_ADDR -u BACKEND_PORT` 后立即正常启动到 9077。修复：后端 env 全部改 `OMNITERM_*` 前缀并删掉 `BIND_ADDR` 兜底，dev.sh/dev.ps1 改传 `-H/-p/--db`，旧名仅保留启动 warn。
- 2026-09-07 正式版 daemon 日志自启动起零写入（只剩 panic 与启动 banner），一键升级 exec 失败的 error 也消失，排查无从下手。根因：`RUST_LOG` 同为通用名——daemon 从 dev shell 继承了旧仓库双 crate 名 directive `RUST_LOG=omniterm_main=info,omniterm_server=info`，而现行 crate 名是 `omniterm`，EnvFilter 无 catch-all，本 crate 全部日志被过滤。自查手段：`cat /proc/<pid>/environ | tr '\0' '\n' | grep RUST_LOG`。修复：`main.rs` 检测 directive 未覆盖 `omniterm*` 时追加 `omniterm=info` 保底（`rust_log_covers_omniterm`）；自重启链的关键诊断改 `eprintln` 绕过 EnvFilter。**logging 配置的劫持面与端口/数据库一致，只是症状是「没日志」而非「报错」。**
- 2026-10-06 正式版 OmniTerm（从一个 codebuddy 会话的终端启动）派生 codebuddy 卡死，两个入口实测：新建 ACP 会话 `session/new` 永久挂起（120s+ 无响应）；OmniTerm 终端里跑 `codebuddy` TUI 空白卡死（对照：干净环境 TUI 正常渲染）。根因：`SERVER__PORT` 等父会话指针变量随进程树继承到每个新 spawn 的 codebuddy 子进程，新进程启动期直接 `listen` 继承端口 → `EADDRINUSE` 未处理异常 → 启动流程中断（裸探针：不清理 120s 无响应 / 只清此项 84ms 成功 / 干净环境注入被占端口 100% 复现）。取证捷径：对端自己的日志（`~/.codebuddy/logs/<date>/*.log`）有 `unhandledRejection listen EADDRINUSE`，宿主日志完全看不到；静态佐证：codebuddy 自身 spawn 子进程时也删同组变量（对端承认不该传子进程，只是没覆盖「宿主继承」入向）。修复：清理清单收敛为 `pty_io::startup_leak_env_vars` 单一真源（SSH 残留 + `SERVER__PORT` / `SERVER__HOST` / `CODEBUDDY_SERVICE_PROXY_URL` / `CODEBUDDY_GATEWAY_AUTH`），覆盖 pty / tmux / ACP 终端 / ACP agent spawn 全部派生点。

---

## 模式 10：自替换运行中二进制后重新解析 current_exe() —— Linux 的 /proc/self/exe 失效盲区

**平台-自更新**：Unix 自更新用 rename 覆盖运行中的二进制后，当前进程仍映射**旧 inode**，此时禁止用 `std::env::current_exe()` 重新解析 exec 目标：Linux 上 readlink("/proc/self/exe") 跟随 inode，返回带 ` (deleted)` 后缀的失效路径，exec 报 ENOENT——自动重启静默流产、旧进程继续服务，症状是「承诺了重启却没切换、刷新永远旧版」。正确目标是**替换前**捕获的规范化路径：rename 后该路径恰好指向新二进制。警惕平台掩盖：macOS 的 `_NSGetExecutablePath` 返回启动路径字符串，同名路径替换后已指向新二进制，巧合可用——「开发机（mac）通过、生产（Linux）失效」的不对称只能在目标平台做字节级复现实验抓现行（/tmp 编两个版本小程序：V1 睡眠中被 V2 rename 覆盖，分别 exec `current_exe()` 与捕获路径，一行输出定案），不能靠读代码推断。与 AGENTS.md §8 同族：不得把单一平台的行为当作约定的全部事实。

**适用**：任何 exec 自身完成自更新/热重启的代码；症状「升级成功 + 承诺自动重启但版本不切换」、日志只有孤零零一条 exec 错误。**弯路**：报错是 `No such file or directory`，第一反应去查路径拼写/权限，实际路径字面完全正确——失效的是路径背后的 inode 归属，先 `readlink /proc/<pid>/exe` 看有没有 ` (deleted)` 后缀。

**推论（retire 型 vs rename-in-place 型）**：「替换前捕获的路径替换后直通新二进制」只对 **github_release 的 rename-in-place** 恒成立；**npm reify 的 retire 是「旧路径先死、原路径重生」**——capture 时进程已被 retire 过（前一次升级/手动 `npm install` 后没重启就再升级），`/proc/self/exe` 已是 staging 死路径，canonicalize ENOENT 后连 ` (deleted)` 字面后缀一起带回，npm 把新包装回原路径也救不活它。修法不是放弃捕获路径，而是按 staging 命名形状（`node_modules` 树内 `.owner-<hash>` 组件替换回 `owner`）把死路径复活为 live 安装路径，capture 与 exec 前各复活一道，复活不了再报错——平台/包管理器语义差异（AGENTS §8）再次表现为「同一份代码在不同 install 历史上行为不同」。

**案例证据**：
- 2026-08-31 远程 Linux 正式版一键升级提示自动重启却从不切换，刷新仍旧版。根因：`update::relaunch()` 在自替换后重新解析 `current_exe()` 拿到 ` (deleted)` 路径 exec ENOENT（此前一轮修复只堵了 ACP 回收挂起路径，此路径仍在）。修复：`relaunch(exe)` 改用替换前 `current_exe_channel()` 捕获的路径。
- 2026-09-07 npm 渠道（v0.2.19）一键升级后自动重启仍静默失败：失败日志被 RUST_LOG 劫持吞掉（见模式 9 第 2 例），证据只能从 `hexdump` 残留里找。根因链：npm 渠道 daemon 的 exe 在 node_modules 包目录里，升级时 npm reify **先 retire（rename）旧包目录、删 retire 目录**（Linux unlink 运行中 exe 成功）——捕获路径随旧 inode 一起消失，exec ENOENT。修复（v0.2.20）：npm 渠道 exec 目标仍取替换前捕获路径——npm 就位新包后**在同一路径重建包目录**，旧包路径恰好指向新二进制；`relaunch()` 加存在性预检把死路径转成明确报错；`current_exe_channel()` canonicalize 失败回退原始路径（死路径仍可判渠道，保住 `/system/version` 的 restart_command 链路）；`restart_command` 把含 `node_modules` 的 argv[0] 归一为 PATH 上的 shim `omniterm`（npm 渠道回显的原生二进制路径升级后必然失效，照抄重启命令会 `no such file`）。**npm reify 的 retire+delete 与 github_release 的 rename-in-place 语义不同：前者旧路径先死后生，后者旧路径直通新二进制——exec 目标规则按渠道分别成立。**
- 2026-09-27 正式版 v0.2.25 连点两次「立即重启」都不切换（daemon 日志两条 `manual-relaunch failed`，exec 目标 `…/@gdwhisper/.omniterm-K1Ah91fh/…/bin/omniterm (deleted)`）：进程中至少经历过一次「升级后未重启」，capture 时 `/proc/self/exe` 已是 retire staging 死路径——v0.2.20 的「取替换前捕获路径」在这一形态下拿到的是死路径。修复：`revive_dead_exe` 按 staging 形状复活（`src/update.rs`，4 单测），捕获与 exec 前各一道。

---

## 模式 11：按"包名/argv0"推导实例身份 —— 名字统一后回退路径静默指向正式版实例

**配置-实例身份**：实例身份（数据库/密钥/端口）只能由**显式配置**（`--db` / `BRANCH_BINARY_NAME` / `DATABASE_URL`）决定。任何"未配置时按包名或 argv0 推导"的回退，都必须在**名字统一类重构**（如全分支统一 `[package] name`）后重新验证：统一的收益（merge 不覆盖、渠道一致）恰好使这类推导退化为常量，而那个常量通常就是正式版实例名。放大器（本案例真正危险的一跳）：**测试/工具自身会执行迁移**（`sqlx::migrate!`）——此时"本地 `cargo test`"等价于"拿当前分支的迁移集去升级正式版库"，且对被测代码完全静默：迁移结果不出现在测试输出里，只出现在下一次正式版启动失败时。**规律：会写库的测试，其库回退只能指向开发实例（或直接 skip），并在注释里写明"禁止按包名推导"；"禁止静默连正式版库"同样适用于测试代码。**（交叉引用：AGENTS.md §配置统一管理、本文件模式 9。）

**适用**：多 worktree/多实例共享一个数据目录（`~/.<产品>/<实例>.db`）的项目，尤其测试会建表/迁移的。**弯路**：故障现象是正式版启动报 `migration X was previously applied but is missing`，第一反应查正式版二进制版本、用户手动裸跑、进程串库（历史事故都是这些），实际写入者是一次普通的本地 `cargo test`。取证要对齐"库内 `_sqlx_migrations.installed_on` 时刻"与"各候选进程的启动记录"（构建产物 `.incremental/` 目录 mtime、会话记录里的 `cargo test` 启动时间），而不是只查正式版一侧。

**案例证据**：
- 2026-09-27 `~/.omniterm/omniterm.db` 被两次写入：09:30:12 来自 dev worktree 的 `cargo test`（应用 20260926），16:51:04 来自 auth worktree 的 `cargo test --workspace`（应用 20260927，测试启动时刻 16:51:00 与落库时刻对齐）。根因：`tests/agent_hook_integration.rs` 在 `DATABASE_URL` 未设时用 `env!("CARGO_PKG_NAME")` 拼回退路径，包名全分支统一为 `omniterm` 后恒等于正式版库。后果：正式版 v0.2.25 无法通过迁移校验、无法启动；回滚两迁移后恢复。
- **修复经三轮才收敛（教训：堵住一个通道 ≠ 堵住这一类）**：① `533e4de` 回退改 `omniterm-dev.db`——堵住正式版库，但**分支 worktree** 跑测试会把该分支迁移集写进 dev 库（dev 实例在合入该迁移前 VersionMissing 拒启）；② `073fafa` 回退改为 `DATABASE_URL` → `./.env.local` 的 `BRANCH_BINARY_NAME`（与 `dev.sh` 同真源：在哪个 worktree 跑就写哪个实例库；库名 sanitize 仅 `[A-Za-z0-9_-]`）→ 皆无则 **SKIP**，不再回退任何固定真实库；③ `917389b` 端口与库**同源配对**（`OMNITERM_TEST_PORT` → `.env.local` 的 `BACKEND_PORT` → 9777）+ WS 响应分级 + `BRANCH_BINARY_NAME=omniterm`（正式版 stem）一律 SKIP 的保险。
- **第二个坑：环境错配会让断言恒真假绿**。端口仍写死 9777 时，session 行写 auth 库、握手打到读 dev 库的实例 → 服务端只回 `session not found`、不 attach pane → 「pane 不得出现 0x04」的断言恒真。且该错误帧是 101 升级**之后**下发的，单读握手头根本看不出来。**规律：测试的库与端口必须同源配对；环境不满足前提时必须带原因显式 SKIP，绝不静默通过——不会变红的测试比没有测试更危险。**（CI 无实例时该测试显式 SKIP 属预期语义。）

---

## 模式 12：运行期资源来源按 cwd 相对路径隐式探测 —— release 产物被「恰好存在的本地目录」劫持

**部署-资源来源**：运行期资源（前端静态文件、模板、内置资源）的来源判定禁止用「相对 cwd 的路径是否存在」这类隐式探测——用户在源码目录里启动 release 产物（常见操作）就会命中同名本地目录并**静默切换来源**，症状是「一键更新 + 重启 + 强刷后界面仍是旧版」，全程无任何报错。**规律：release 产物必须默认自包含（编译期内嵌），文件系统来源只认显式配置（专用 env / CLI 参数）或 debug 构建；「目录存在性」只作为来源确定后的校验，不得作为开关本身。** 与模式 9 同族：隐式来源被巧合命中，通道从环境变量换成文件系统；共同教训是**开关的默认态必须是「自包含」，任何「探测到本地东西就用本地」的回退都迟早被一次正常操作触发**。

**区分「后端版本 vs 资源版本」一步定位**：页面版本与后端 health/version 报的版本不一致 ⇒ 资源来源问题，别再怀疑更新/缓存链路（本例先查了 npm 传播、exec 失败、浏览器缓存，全部正常——真正不匹配的是「二进制内嵌前端（新）」与「本地旧 dist（旧）」）。放大器：该场景的「重启」是 exec 自重启（模式 10 的设计），**cwd 不变**——无论重启多少次、强刷多少次都不会变好，必须换 cwd 重新启动。**弯路**：修复时勿把文件系统来源一刀砍掉——显式 env（容器镜像 ENV 注入）与 debug 构建（开发热更新工作流）两类合法来源要保留，否则打碎 Docker 与 dev 脚本。

**适用**：任何「打包内嵌 + 开发期文件系统」双形态应用；症状「升级生效但界面/行为旧」。取证：`readlink /proc/<pid>/cwd` + 启动日志出现「Serving frontend from <本地目录>」即命中文件系统来源。

**案例证据**：
- 正式版（npm 渠道）在源码目录启动并更新到新版，重启 + 强刷后页面版本号仍是旧版——旧版本号来自本地旧 dist（构建期写死进 JS bundle 的常量）；根因是前端来源按 cwd 相对路径命中本地 dist；修复为 release 一律内嵌、文件系统来源仅认显式 env 或 debug 构建。

---

## 未入库记录（无理论，仅存案例）

以下记录提取不出可复用规律，按「无理论不入库」纪律不设模式，仅留案例供追溯（git 可查详情）：

- **2026-06-26 Agent hook 检测 Windows 路径空格**：`split_whitespace()` 在 `C:\Program Files\...` 的空格处截断，只取到 `C:\Program`。规避：测试用例改用无空格路径（用户经 PATH 裸名调用，不涉空格）。——这是规避而非根因修复，与 `terminal-pty.md` 模式 3「跨进程命令解析」同族，若未来要做引号感知解析再补模式。
