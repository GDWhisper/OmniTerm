# 浏览器桌面通知（ACP attention 事件 → Notification API）

> 状态：**已归档（2026-10-21）**——已实施（2026-10-21），实施记录、实施偏差与验收对照见本文 §0
> 触发条件：改 `frontend/src/components/Attention/AttentionProvider.tsx`、`frontend/src/utils/desktopNotification.ts`、`useAcpChat` 的 attention 触发点、动 Settings 通知开关，或新增浏览器通知能力前**必读**
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md` F07（本文是它的落地计划）、`docs/dev/plans/backlog/improvement-directions-remaining.md` X01（本文承担 X01 的「浏览器通道」半边）、`docs/dev/performance-and-safety.md` §S3

## 0. 实施记录（2026-10-21）

### 0.1 落地文件

| 文件 | 作用 |
|---|---|
| `frontend/src/utils/desktopNotification.ts` | 能力探测（D3）+ 发送（D9 失败降级）+ 跨标签页去重（D5 BroadcastChannel 声明-裁决）+ 开关就绪判定（D7 用） |
| `frontend/src/components/Attention/AttentionProvider.tsx` | 唯一触发点接线（D1）：`fire` 内按 D6/D7 决定发桌面通知 or 响 ping；文案组装（会话名 + 事件类型，D2） |
| `frontend/src/components/Settings/DesktopNotificationSection.tsx` | 设置项：开关（用户意图）+ 能力/权限态行（现实）+ 被拒时的「重新请求」（D4） |
| `frontend/src/stores/appStore.ts` | `desktopNotificationEnabled` + setter（localStorage `omniterm_desktop_notification`，D8） |
| `frontend/src/utils/sessionLookup.ts` | `findSessionById`（通知标题要会话显示名；顺手把 Layout/ChatView 里重复的 `Object.values(sessions).flat().find(...)` 收敛为单一真源，禁 Copy-Paste 红线） |
| `frontend/src/locales/{zh,en}/translation.json` | 设置项文案 + 通知正文（`notification.body` / `notification.event.*`） |

### 0.2 实施偏差

1. **D6 判据补「标签页隐藏」豁免**（唯一的实质性偏差）。
   D6 字面判据是 `activeSessionKeyRef.current !== sessionKey`（与既有 ping 同源）。实施时
   发现该判据在主场景里会**误杀**：ACP 的 WS 是**按会话**建的（`/api/v1/ws/acp/{sid}`，
   切换会话即拆除，见 `hooks/useAcpChat.ts` 的 effect 依赖 `[sessionId]`），故 ACP 回合的
   done / decision 事件**只在用户正看着该会话时到达**；而「用户正看着会话」又恰被 D6
   字面判据挡掉——功能等于在主场景永不触发（只有终端侧 agent 轮询路径能触发）。
   故判据改为「**用户是否在眼前**」：① 非当前会话；② 当前会话但 `document.hidden`
   （他已切到别的应用/窗口，标题闪的目标签栏在别的窗口里根本看不见）。
   `document.hidden` 正是本仓既有的「用户不在眼前」信号（tab 标题闪烁用的就是它），
   与 D6 的**意图**（「不打扰用户正看着的会话」）一致，只是把「正看着」从
   「会话是当前会话」修正为「人还在屏幕前」。D7 的 ping 抑制口径同步按此判据执行。
2. **设置项独立成文件**（计划 Phase 3 写的是「`Settings.tsx`（新 `DesktopNotificationSection`）」）：
   `Settings.tsx` 已 1043 行，且本区块需要「开关 + 能力态行 + 重新请求按钮」三层结构，
   `toggleRow.tsx` 的 `ToggleRow` 组件（label+hint+on/off）承载不了 → 独立文件，
   视觉规格照 `SoundSection` 的同款按钮（`btnBase` + 状态点）。
3. **新增「通知」分类页**（`settings.category.notifications`）：桌面通知与「音频」是两种
   提醒通道（自己的 ping vs OS 通知），混在一页会让人以为音效开关管着桌面通知；
   `audio` 分类已有单 section 先例（`SoundSection`），新增一个单 section 分类同理。
4. **开关语义 = 用户意图**（与「权限」分开陈述）：权限被拒时开关**不弹回 OFF**，
   状态行以危险色如实写「浏览器已拒绝」+ 给「重新请求」入口。理由：把开关强行弹回
   OFF 只会让用户更困惑（他确实想要），而「静默无效」由状态行明确挡住。
5. **去重表容量上限**（64 条 + 过期清理）：计划未提，但 `docs/dev/performance-and-safety.md`
   §P1「一切 push/append/collect 必须有显式上限」——长跑标签页不能无界累积。
6. **点击的可见反馈不等权限结果（`requesting` 中间态 + 意图同步落账）**。D4 的语义是
   「开关=用户意图、状态行=现实」，但实施稿把**全部**可见效果押在
   `await Notification.requestPermission()` 之后：浏览器压制权限弹窗时该 promise
   **永不结算**（既不负 resolve 也不 reject——已知案例：Firefox 弹窗拦截吞权限弹窗、
   企业策略/隐私模式压制），点击表现为「毫无反应」：开关不翻、状态行不动、意图不记录。
   2026-10-25 用户实测（远程 https 环境）命中此路径。修复：意图先同步落账（点击即翻转），
   请求期间状态行显示「等待中」并附弹窗未出现时的排查指引（弹窗拦截/隐私模式/站点设置），
   开关在请求期间**不禁用**——否则 promise 挂起时用户连「关闭再开重试」都被锁死。
   回归测试见 `DesktopNotificationSection.test.tsx` 两条永不结算用例。

### 0.3 验收对照

- [x] 打开开关 → 浏览器弹权限框 → 允许后，agent 回合结束（done）弹出系统通知，**标题含会话名、不含 agent 正文**（D2）
      —— Chromium 实测：标题 = 会话显示名，正文 = `OmniTerm · Finished`；组件测试断言正文不含 agent 正文
- [x] error / decision（需要审批）两类事件同样有通知
      —— 三个触发点共用同一条 `fire` 路径（`useAcpChat.ts` 的 `prompt_done` / `prompt_error` / `permission_request`），组件测试覆盖 done/error
- [x] 用户正盯着该会话时**不弹**通知（D6）
      —— 组件测试：会话可见时零通知、零 ping；**标签页隐藏时**按 §0.2-1 发通知（用户已离开屏幕）
- [x] 桌面通知已启用时**不再叠加** OmniTerm 自己的 ping 声（D7）
      —— 组件测试：已启用+已授权 → `playPing` 未被调用；未启用/未授权 → ping 照旧
- [x] 两个标签页同时打开同一会话，一次事件**只弹一条**（D5）
      —— 单测用第二个 `BroadcastChannel` 发更早的声明，本标签页据此静默（先到者发、后到者静默）
- [x] 权限被拒 → UI 如实显示「浏览器已拒绝」+ 重新请求入口；**不静默无效**（D4）
      —— 设置面板组件测试 + Chromium 实测（能力态行显示 Granted / 未授权 / 已拒绝三态）
- [x] 非 secure context（局域网 IP + http）→ 开关置灰并**写明原因**（D3）
      —— 判据以 `'Notification' in window` 为主（非安全上下文根本不暴露构造器），
        `isSecureContext === false` 只用于把原因写成人话（单元测试覆盖两条路径）
- [x] 发送抛错不影响 turn 收尾，且日志可查（D9）
      —— `console.warn` + 返回 false，调用方不感知
- [x] 刷新页面后开关态保持（localStorage，D8）
- [x] `cd frontend && pnpm lint` / `pnpm exec tsc -b` / `pnpm test` 零新增警告

**真实浏览器端到端**（Chromium + Playwright）：设置 → 通知页 → 开关置 ON（用户手势内
请求权限，能力态显示 Granted）→ 制造一次真实 agent 事件（改 tmux session 的
`@omniterm_agent` 选项 → 侧栏轮询判定为新事件 → `fire('done')`）→ 浏览器
`Notification` 构造调用：`{title: "lt_790ea5bf", body: "OmniTerm · Finished"}` ✓


## 1. 背景

原计划 F07「浏览器桌面通知 — attention 事件（done / error / decision）触发 `Notification` API；设置面板开关」自 2026-07-27 挂起，未实施。

2026-10-21 可行性审查结论：**事件源与站内通知链路已全部就绪，缺的只有浏览器通道本身**——

- `useAcpChat.ts` 三个触发点已在调站内通知总线：`fire(sid, sid, 'error')`（:1090）、`fire(sid, sid, 'done')`（:1093）、`fire(sid, sid, 'decision')`（:1266）。
- `AttentionProvider` 已有三态（decision / done / error）+ `playPing` + `document.hidden` 时 tab 标题闪 🔔。
- **缺口**：`rg "new Notification" frontend/src` **零命中**；Settings 无通知开关。

产品定位契合：OmniTerm 是「一个浏览器标签页观察并驱动多个 AI coding agent」——用户会在 agent 跑长任务时切走，桌面通知正是这个场景的缺失闭环。

**但有一个硬约束**（见 D3）：`Notification` API 只在 secure context 可用，而 OmniTerm 的主部署形态（`--host 0.0.0.0` / Docker `9077:9077` 暴露到全网卡）以明文 http 访问局域网 IP 时**不是** secure context。**不做能力探测就会做成「用户以为开了、其实完全没生效」**——这是本项最大的交付风险。

## 2. 范围与优先级

| 优先级 | 项 | 目标 | 预估 |
|---|---|---|---|
| P0 | ① 能力探测与降级 | 三态能力判定 + **不可用时如实说明原因** | 小 |
| P0 | ② 发送通道 | attention 事件 → `new Notification(...)` | 小 |
| P0 | ③ 权限请求 | 必须在用户手势内请求；拒绝态可重试 | 小 |
| P1 | ④ 设置开关 | 开关 + 当前权限态展示 | 小 |
| P1 | ⑤ 多标签页去重 | 同一会话事件在多标签页只弹一次 | 中 |

### 不纳入范围

| 排除项 | 理由 |
|---|---|
| **webhook / 服务端推送** | 需落 settings URL，而 `src/api/settings.rs` 每 key 一对 handler（样板 ≥4 处，X11 未做）→ 违反反 Copy-Paste 红线。**留待 X11 之后**，本文不碰后端 |
| 通知里带 agent 回复正文 | OS 通知在锁屏/任务栏明文显示，agent 正文可能含代码、路径、密钥（§S3 精神） |
| 自建通知中心 / 站内通知列表 | 站内通知（侧栏红点 + 声音 + 标题闪）已覆盖；再造通知中心是重复造轮子 |
| 终端（pty/tmux）侧通知 | 依赖「静默判定」（feed 热路径无 `last_output_at`），且会碰 §P4 热路径红线；X01 已记为独立缺口 |
| `Notification` 之外的其他通道（Web Push / Service Worker） | 需新依赖 + HTTPS（X04 未做），且 secure context 前提与 D3 同源 |
| 通知点击后跳转会话 | `notification.onclick` 可行，但多标签页下「哪个标签页跳」语义含混（与 D5 同一问题域），本次只做去重不做跳转 |

## 3. 设计决策（ADR）

| # | 决策 | 理由 | 否决项 | 翻盘条件 |
|---|------|------|--------|----------|
| **D1** | 复用 `AttentionProvider.fire` 作为**唯一触发源**，不新建通知总线 | 事件源已就绪（三态齐备），X01 明确写「站内部分几乎零成本，**勿再造通知中心**」 | 新建 WS 帧 / 新事件类型（重复） | — |
| **D2** | 通知内容**只含会话名 + 事件类型**，不含 agent 回复正文 | OS 通知明文显示在锁屏；正文可能含代码/路径/凭据（§S3） | 带正文摘要（泄密面，且各 agent 正文长度不可控） | 出现明确的「只看标题不够用」诉求 → 增补「用户手动开启的详细模式」 |
| **D3** | **能力探测三态**：`supported` / `blocked`（环境不支持）/ `denied`（用户拒绝）。判据以 **`'Notification' in window`** 为主，`window.isSecureContext === false` 仅用于**解释原因**，不作为独立否决 | 浏览器里 `Notification` 构造器存在 ⇔ 该环境真能发通知；`isSecureContext` 只解释「为什么没有」。两者混用会在 jsdom（`isSecureContext` 为 `undefined`）与真实浏览器间产生不一致判定 | 只查 `isSecureContext`（非 localhost 部署全判不可用）／只查 `Notification`（用户看不懂为什么按钮灰着） | 引入 Service Worker / Web Push 通道 → 探测维度重估 |
| **D4** | 权限请求**只在用户手势内**发起（设置面板的开关点击即是手势），拒绝后提供「重新请求」入口 | 浏览器只在用户交互上下文里允许弹权限框；`denied` 态下再调 `requestPermission()` 静默失败，用户会以为按钮坏了 | 自动在启动时请求（无手势，浏览器直接忽略） | 浏览器放开自动请求（不会发生） |
| **D5** | **多标签页去重**：`BroadcastChannel('omniterm-notify')` 上「先到者发、后到者静默」，按 `(sessionId, reason)` 在短窗口内去重 | 同一会话可能在多个标签页各持一条 WS（X15 已修 slot 泄漏，但多标签页同时打开同一会话仍可能），不去重会连弹多条。选 BroadcastChannel 而非选主选举：实现量小一个量级，残余竞态窗口在亚秒级 | 选主选举（leader election，复杂度显著更高，收益仅是消除亚秒级重复）／`localStorage` 锁（跨标签页写竞争，需处理时钟与清理） | 实测同一事件在多标签页重复弹出率不可接受 → 升级为选主 |
| **D6** | 只对「**用户当前不在看的会话**」发桌面通知（与既有 `playPing` 的判定同源：`activeSessionKeyRef.current !== sessionKey`） | 用户正盯着这个会话时，通知是噪音；判定口径已有现成实现，不另立 | 也给当前会话发（重复提醒）／只看 `document.hidden`（同标签页切到别的会话时反而收不到） | 出现「用户盯着会话但没注意到已完成」的实证 → 再议 |
| **D7** | 桌面通知**已启用且权限已授予**时**跳过** `playPing`（避免双响）；未启用/未授权时维持现状铃声 | OS 通知自带系统音效，叠加 OmniTerm 自己的 ping 会双响。判定同源 D6 | 两边都响（双响）／桌面通知不响（用户可能没注意到） | 平台实测通知默认静音 → 改回双响 |
| **D8** | 开关存 **localStorage**（键名 `omniterm_desktop_notification`），**不落 settings 表** | 绕开 X11（settings 共享读写助手）前置；且浏览器通知权限本身是**浏览器级**状态、跨设备也无法共享，落库没有语义优势。范式照 `utils/thinkingCollapsed.ts` 的既有做法 | 落 settings（要 X11 前置 + 跨设备语义本就不成立） | 需要「在 A 设备开、B 设备也开」的跨设备语义 → 才需要落库（届时先做 X11） |
| **D9** | 发送失败（构造器抛错 / 权限被撤销）**记日志 + 静默跳过**，不打断 turn 收尾 | 通知是旁路能力，失败绝不能影响主链路（§S2 的反向：这里不是吞异常，而是「非关键旁路的显式降级」，必须有日志可查） | 失败时弹 toast（打断用户）／失败时抛错（污染主链路） | 出现「通知静默失效且无人察觉」的事故 → 升级为一次性 toast 提示 |
| **D10** | 本期**不做**通知点击跳转（D6 同源问题域），只做去重 | 「哪个标签页跳」在多标签页下语义含混，且跳转还需与 X15 的 slot 生命周期对齐 | 跳转（复杂度与边界都超出本项收益） | X15 之后多标签页模型稳定 → 再评估 |

## 4. 实施分期

### Phase 1 — 能力探测与发送通道（纯前端，可单测）

| 改动 | 文件 |
|---|---|
| 能力探测：`detectNotificationCapability()` → `supported` / `blocked` / `denied` / `default`（D3） | `frontend/src/utils/desktopNotification.ts`（新） |
| 发送：`sendDesktopNotification({title, body})`，含 D9 的失败降级 | 同上 |
| 多标签页去重：BroadcastChannel 广播 + 短窗口去重（D5） | 同上 |
| 开关读写：localStorage（D8） | `frontend/src/utils/desktopNotification.ts` 或既有 store（按既有约定优先 store） |

### Phase 2 — 接入 attention 事件源

| 改动 | 文件 |
|---|---|
| `AttentionProvider.fire` 内：能力允许 + 非当前会话（D6）→ 发桌面通知；已授权时跳过 `playPing`（D7） | `frontend/src/components/Attention/AttentionProvider.tsx` |
| 通知文案：`会话名 + 事件类型`（D2），会话名取 `sessionDisplayName()` 单一真源 | 同上 / `utils/desktopNotification.ts` |
| i18n 两份同步（zh/en） | `frontend/src/locales/{zh,en}/translation.json` |

### Phase 3 — 设置开关

| 改动 | 文件 |
|---|---|
| 新增 `DesktopNotificationSection`：ToggleRow（开/关）+ **当前能力/权限态行**（不可用时写明原因，如「当前以 http 访问非本机地址，浏览器不提供桌面通知」）+ 权限被拒时的「重新请求」按钮（D4） | `frontend/src/components/Settings/Settings.tsx`（新 `DesktopNotificationSection`，照 `toggleRow.tsx` 的 `ToggleRow` 范式） |
| 单测：能力态 → UI 文案映射 | `frontend/src/components/Settings/DesktopNotificationSection.test.tsx`（新） |

### Phase 4 — 测试与边界

| 项 | 要点 |
|---|---|
| jsdom 无 `Notification` 实现 | 测试须 `vi.stubGlobal('Notification', MockNotification)`；`window.isSecureContext` 在 jsdom 是 `undefined`（实测），故 D3 的判据以 `'Notification' in window` 为主、`isSecureContext` 只用于解释原因——**这条判据顺序不可颠倒**，否则 jsdom 与真实浏览器判定不一致 |
| 权限被拒 | `Notification.permission === 'denied'` → 不发送，UI 显示「重新请求」（浏览器在 denied 后不再弹框，须引导用户去站点设置） |
| 多标签页去重 | 单测：同 `(sessionId, reason)` 在窗口内第二次发送被抑制 |
| 当前会话不通知 | 单测：`activeSessionKeyRef` 命中时既不发通知也不跳过 playPing |
| 非 secure context | 单测：`isSecureContext === false` 且有 `Notification` → 仍判 `supported`，但 UI 附说明 |

## 5. 验收标准

> 实施后的逐条对照见 §0.3（原验收清单已逐条勾验并附证据，此处不再重复）。
>
> 原始清单（2026-10-21 计划稿）：打开开关 → 浏览器弹权限框 → 允许后 agent turn
> 结束弹出系统通知（标题含会话名、不含 agent 正文）；error / decision 同样有通知；
> 用户正盯着该会话时不弹；桌面通知已启用时不叠加 ping；多标签页只弹一条；权限被拒
> 如实显示 + 重新请求入口；非 secure context 开关置灰并写明原因；发送抛错不影响
> turn 收尾且日志可查；刷新后开关态保持；lint / tsc / test 零新增警告。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **secure context 缺失**（主部署形态） | 用户开了开关但永远收不到 | D3 能力探测 + UI 明写原因；不假装可用 |
| 浏览器/系统级通知被静音或免打扰 | 用户仍以为没工作 | 通知正文前缀写明「OmniTerm」，便于辨认来源 |
| 多标签页重复弹出 | 打扰 | D5 BroadcastChannel 去重 |
| 权限弹框被浏览器静默拒绝 | 开关显示已开但无通知 | 每次发送前读 `Notification.permission`（不缓存），权限被撤销时即时降级 |
| 用户看到的是 agent 敏感内容 | 泄密 | D2 只发会话名 + 事件类型 |
| 与 X15（slot 泄漏）叠加放大 | 多连接 → 多通知 | D5 按 sessionId 去重，与连接数解耦 |

## 7. 文档闭环

实施完成后需更新：

- `docs/architecture/frontend.md` — `utils/` 补 `desktopNotification.ts` / `sessionLookup.ts`；`Attention/` 目录说明补桌面通知通道与能力探测口径 ✅
- `docs/visual-design/ui-style-guide.md` — §8 Settings Toggles 表补桌面通知开关（localStorage 键与默认态）✅
- `docs/dev/plans/backlog/improvement-directions-remaining.md` — X01 标注「浏览器通道已落地」，剩余缺口收敛为 webhook / pty 侧静默判定（并注明依赖 X11）✅
- `docs/dev/plans/2026-07-27-acp-session-enhancements.md` — F07 标注已实施 + 指向本文 ✅
- `docs/reference/requirements.md` —「通知功能 ⚪」条目勾上「任务完成 / 意外中断」两小项（pty 侧检测仍未做）✅
- `CHANGELOG.md` — **需加条目** ✅
