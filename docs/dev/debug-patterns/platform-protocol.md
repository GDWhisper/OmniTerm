# 构建与协议 — 调试模式

覆盖：构建期字节契约（.gitattributes/checksum）、批量枚举 per-item 容错、三态布尔序列化、wire-format 抓帧、热路径 spawn 成本、渠道字节差异探针、Windows spawn 裸命令名（PATHEXT）。

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

## 未入库记录（无理论，仅存案例）

以下记录提取不出可复用规律，按「无理论不入库」纪律不设模式，仅留案例供追溯（git 可查详情）：

- **2026-06-26 Agent hook 检测 Windows 路径空格**：`split_whitespace()` 在 `C:\Program Files\...` 的空格处截断，只取到 `C:\Program`。规避：测试用例改用无空格路径（用户经 PATH 裸名调用，不涉空格）。——这是规避而非根因修复，与 `terminal-pty.md` 模式 3「跨进程命令解析」同族，若未来要做引号感知解析再补模式。
