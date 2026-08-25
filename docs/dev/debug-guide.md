# Debug Guide

调试方法论指导（**guide**，不是 bug 记录 log）。每条模式的目标是**从具体 bug 中提取可复用的调试规律**，而不是记录"问题 → 修复"。没有理论抽象的记录等于没写——修复细节（文件路径、行号、commit、验证命令）在 git 里可查，文档只留规律、弯路与案例证据。

## 使用方式（渐进式披露）

**遇到 bug 时**：

1. **先读本文件的「领域索引」**，按症状关键词定位所属领域。
2. **再按需只读对应的领域文件**（`docs/dev/debug-patterns/<领域>.md`），看是否有已沉淀的模式命中。
3. 命中的模式按「规律 → 适用条件 → 案例证据」逐条对照排查。

领域文件不在这里全文展开——每个领域文件本身就是独立的可加载单元，避免把整个方法论文档一次性塞进上下文。

## 领域索引

| 领域 | 文件 | 覆盖内容（关键词） |
|------|------|------|
| 异步与竞态 | `debug-patterns/async-race.md` | broadcast/mpsc 通道、订阅-快照顺序、完成信号广播、边生产边消费、identity guard、即时 vs 异步竞态窗口 |
| 资源与生命周期 | `debug-patterns/resource-lifecycle.md` | 删记录≠释放运行时资源、删一层≠删邻接资源（worktree remove 不删 branch）、Drop 隐式副作用、对称释放路径、spawn 抽象 cwd、map vs 持久化行、存活多层独立事实、回收编排失败路径、无界累积有界化、后台化进程启动结果握手反馈 |
| React 与前端 | `debug-patterns/frontend-react.md` | key 重挂载、同步→异步破坏 cleanup、依赖数组对象字面量、mousemove setState 重渲染、三态 loading、高频流聚合、StrictMode 异步回调、后端权威状态清除、慢速拖动手势误触、写回定位键权威性（匹配键/匹配路径失控 = 无约束） |
| 布局与 CSS | `debug-patterns/layout-visual.md` | flex 三件套、共享 CSS 类隐性契约、visual viewport 三层模型、containing block、zoom 祖先放大 fixed translate、RTL bidi 隔离、table-layout、white-space、底部不可见分层排查清单 |
| 终端与 PTY | `debug-patterns/terminal-pty.md` | MasterWriter Drop 副作用、字节能到达≠语义能到达、跨进程分隔符选型、平替实现边缘语法、FitAddon 桌面像素常量、escape-time 时序矩阵、增量绘制 diff 流不可字节尾回放（字节流≠屏幕状态）、轮询推送的时延下界、diff 流不可 latest-wins 聚合 |
| 构建与协议 | `debug-patterns/platform-protocol.md` | 构建期字节契约（.gitattributes/checksum）、批量枚举 per-item 容错、三态布尔序列化、wire-format 抓帧、热路径 spawn 成本、渠道字节差异探针、Windows spawn 裸命令名（PATHEXT）、warn 被读成失败、通用名 env 被进程树继承劫持 |
| 通用诊断手法 | `debug-patterns/investigation.md` | 诊断三阶段、分层二分+字节级证据、先写复现测试再定罪、验证脚本先自证、实物验证>代码推测、假设先行验证滞后、tracing directive 陷阱 |
| 已知未解问题 | `debug-patterns/unresolved.md` | 已排除方向记录、待查清单（避免重复排查） |

## 写作规范

每条模式 MUST 包含以下层次（按优先级）：

1. **可复用的规律**（最重要）：从这个 bug 中能提取出的通用规律，用**加粗标题 + 领域标签**单独列出（如 `**竞态-通道类型**`），方便未来 Ctrl+F 查找。标题用「动词短语 + 领域标签」格式。
2. **诊断过程中的弯路**：走了什么弯路、为什么、下次怎么避免。这比修复方法更有价值——别人读到时能直接跳过你踩过的坑。
3. **案例证据**：每条 ≤3 行（症状 / 根因 / 修复各一句），作为规律的例证，不是记录的主体。

如果一条记录只有第 3 层（案例证据），没有前两层，说明写的时候偷懒了。补上再提交。

### 体积纪律

- 每个领域文件 ≤30KB，超限拆出新的领域文件。
- 每条模式的理论 ≤3 条，超过说明该 bug 可能横跨多个领域，拆到对应领域文件。
- **案例只留证据，不留全程**：文件路径、行号、commit hash、验证命令一律不写（git 可查），需要完整根因链时查 `git log`。

### 家族合并纪律

同一症状 / 同一根因家族多次复现时，**追加案例证据行，不新开一条记录**（反例：reaper/自动恢复家族曾在旧文档拆成 5 条）。

### 归并纪律

- 与 `docs/dev/performance-and-safety.md` / `AGENTS.md` §8 已有沉淀的规律，**只留一行交叉引用，不建双份真相源**。
- 新增模式后**必须**在 `debug-guide.md` 领域索引登记一行。

### 无理论不入库

只有症状和修复、提取不出可复用规律的记录，不写入本体系（修复已在 git）。
