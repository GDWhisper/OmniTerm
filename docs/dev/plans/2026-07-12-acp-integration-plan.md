# OmniTerm ACP 接入指导方案

> ⚠️ **这是初步指导方案，不可以作为最终方案执行。** 执行 agent 必须根据项目真实实际情况详细分析后再动手。本文件只提供方向性建议，不包含具体代码实现。

---

## 参考项目

| 用途 | 路径 |
|------|------|
| ACP Client 参考实现 | `/home/pax/coding/research/obsidian-agent-client` |
| ACP 协议文档与 schema | `/home/pax/coding/research/obsidian-agent-client/documentation/app-server-schemas/typescript/v2/` |
| ACP TypeScript SDK | `/home/pax/coding/research/typescript-sdk` |

> 注意：obsidian-agent-client 为 AGPL 许可证，仅作为功能设计参考，不直接复用代码。

---

## 明确排除范围

**会话桥接（ACP ↔ tmux 互转）不在本次任何阶段内。** 无论后续是否有空有精力，本次改造不承诺、不设计、不预埋该能力。两种 runtime 作为独立会话类型存在，不试图建立实时映射。

---

## 核心定位

- **ACP 是默认 agent 运行时**，新用户开箱即用
- **tmux 是可选 fallback**，保留完整功能，但不再强制依赖
- **Terminal 面板双 mode**：Chat（默认） / Tmux（高级），对应不同的 session 类型

---

## 架构分层方向

```
┌─────────────────────────────────────────┐
│            前端 UI 层                     │
│    (聊天视图 / 终端视图 / 文件浏览器)       │
├─────────────────────────────────────────┤
│          会话抽象层                       │
│   统一 Session 模型，区分 runtime 类型    │
├──────────┬──────────────┬───────────────┤
│ Tmux    │   ACP        │   (Future)    │
│ Runtime │   Runtime    │  其他运行时    │
├──────────┴──────────────┴───────────────┤
│          后端服务层                       │
│   API / WebSocket / 文件系统 / 鉴权       │
└─────────────────────────────────────────┘
```

**关键原则**：前端按 `runtime_kind` 选择渲染模式，不追求同一 session 的双视图切换。

---

## 阶段划分

### Phase 1：启动解耦（1-2 周）

**目标**：无 tmux 环境服务可正常启动

- `check_multiplexer()` 从 fatal 降级为 warning
- `AppState.activity_monitor` 改为 `Option`，无 tmux 时置空
- tmux 相关模块改为惰性初始化

**验证标准**：
- `tmux kill-server` 后服务仍可启动
- 前端可正常加载
- API 健康检查通过

**不做**：不碰 Session 模型，不碰 WebSocket，不碰前端

---

### Phase 2：Session 模型扩展（1-2 周）

**目标**：一个 Session 可以属于 tmux 或 ACP

- Session 新增 `runtime_kind` 字段：`tmux` | `acp`
- 新增 `runtime_id`：tmux session name 或 ACP session id
- 创建 session 时支持选择 runtime，默认 `acp`
- API 保持向后兼容：不传则默认 `acp`

**验证标准**：
- 创建 ACP session 后 DB 记录 `runtime_kind=acp`
- 创建 tmux session 后 DB 记录 `runtime_kind=tmux`
- 现有 tmux session 通过 migration 默认填充为 `tmux`

**不做**：不改前端，不改 WebSocket，tmux 逻辑不动

---

### Phase 3：ACP Runtime 接入（2-3 周）

**目标**：后端能通过 ACP 驱动 agent，事件流统一

- 新增 ACP 运行时模块，职责：
  - 管理 ACP adapter 进程生命周期
  - ndJSON 流解析
  - 权限请求队列
- WebSocket 新增 `/ws/agent/{session_id}`，专供 ACP 事件
- 前端按 `runtime_kind` 决定连接路径：
  - `tmux` → `/ws/terminal/{session_id}`（现有）
  - `acp` → `/ws/agent/{session_id}`（新增）

**验证标准**：
- ACP session 能收到 `session/update` 事件
- tool call 事件可见
- 权限请求能到达前端
- 前端能发送 prompt 并收到响应

**不做**：不抽象 Tmux 和 ACP 的公共接口，两条路径独立存在

---

### Phase 4：前端 Chat 视图（2-3 周）

**目标**：Terminal 面板支持双 mode，对应不同的 session 类型

- Terminal 区域增加 mode switcher：Chat | Tmux
- Chat mode：
  - 消息气泡（user / assistant / system）
  - tool call 卡片（展开/折叠，显示参数和结果）
  - plan 面板（可折叠）
  - 权限确认按钮
  - 运行状态指示器（running / waiting / finished）
- Tmux mode：
  - 保留现有 xterm.js + binary stream
  - 切换时保持同一 session，只是视图不同

**验证标准**：
- ACP session 默认显示 Chat 视图，消息流正常渲染
- tmux session 默认显示 Tmux 视图，xterm.js 正常工作
- 用户在 ACP session 的 Chat 视图和 tmux session 的 Tmux 视图之间切换，各自状态保持
- 同一 runtime 内切换 session 行为正常

**明确不做**：
- 不做 ACP session 和 tmux session 之间的会话桥接
- 不做"把正在运行的 ACP agent 迁移到 tmux pane"
- 不做"把 tmux session 的历史输出同步到 ACP session"

---

### Phase 5：统一与打磨（1-2 周）

**目标**：双路径稳定共存，文档完善

- 统一状态指示逻辑：tmux 的 agent_state 和 ACP 的 session/update 映射到同一套前端 badge
- CWD 同步：ACP 下沿用 project path，tmux 下继续用 pane_cwd
- 迁移文档：tmux 老用户如何切换到 ACP
- 性能：ACP adapter 进程池化管理，避免频繁 spawn

**验证标准**：
- tmux 老用户打开应用，行为无感知变化
- 新用户默认看到 Chat 视图，无需配置
- 双路径同时运行稳定

**不做**：不碰会话桥接，不碰远程 agent

---

## 关键决策点

| 决策 | 建议 |
|------|------|
| ACP adapter 放哪 | 独立 Node 进程，Rust 通过 HTTP/WS 调用 |
| 权限处理 | ACP 的 request_permission → WebSocket → 前端弹窗 → 回传 decision |
| 终端能力 | ACP 模式下不暴露 terminal/create，保持简单；tmux 模式保留完整终端 |
| 多 agent 切换 | Session 级别选 agent，Runtime 级别选协议，两层独立 |

---

## 明确不做的事

1. **不强制迁移**：现有 tmux 用户零影响
2. **不做全量抽象**：Phase 1-3 让两条路径独立存在，Phase 5 再考虑统一
3. **不碰文件浏览器**：Phase 1-4 文件浏览继续走现有 Rust/WebSocket
4. **不替换 tmux hook**：tmux 的 agent_hooks 机制完整保留
5. **不做远程 agent**：ACP 只走本地 stdio adapter
6. **不做会话桥接**：ACP 和 tmux 作为独立会话类型，不建立实时映射，不在本次任何阶段内

---

## 风险与边界

| 风险 | 边界 |
|------|------|
| ACP 成熟度 | Zed ACP 协议仍在演进，adapter 兼容性需评估 |
| 权限模型差异 | tmux 是"全权"，ACP 是"逐操作授权"，前端需要新交互模式 |
| 终端能力降级 | ACP 模式下不暴露 terminal/create，保持简单 |
| 用户认知成本 | 从"一个 tmux session = 一个 agent"变成"runtime 抽象"，需要文档 |
| 会话桥接 | **本次不做**，后续单独评估 |

---

## 后续可选增强（不在本次范围）

- 会话桥接：ACP ↔ tmux 互转，需要解决 agent 恢复语义差异
- 远程 agent 支持：ACP over WebSocket 连接远程 adapter
- 统一 Runtime 抽象：Phase 5 之后，如果两条路径都稳定，再考虑抽公共接口
- 会话导入/导出：允许用户手动将 ACP 对话导出到 tmux，或反之

---

## 下一步

需要针对某个 Phase 展开具体实施要点，或先看前端双 mode 的状态机设计。
