# 浏览器桌面通知（ACP attention 事件 → Notification API）

> 状态：**设计稿**（2026-10-21）
> 触发条件：改 `frontend/src/components/Attention/AttentionProvider.tsx`、`useAcpChat` 的 attention 触发点、动 Settings 通知开关，或新增浏览器通知能力前**必读**
> 关联：`docs/dev/plans/2026-07-27-acp-session-enhancements.md` F07（本文是它的落地计划）、`docs/dev/plans/backlog/improvement-directions-remaining.md` X01（本文承担 X01 的「浏览器通道」半边）、`docs/dev/performance-and-safety.md` §S3

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

- [ ] 打开开关 → 浏览器弹权限框 → 允许后，agent turn 结束（done）弹出系统通知，**标题含会话名、不含 agent 正文**（D2）
- [ ] error / decision（需要审批）两类事件同样有通知
- [ ] 用户正盯着该会话时**不弹**通知（D6）
- [ ] 桌面通知已启用时**不再叠加** OmniTerm 自己的 ping 声（D7）
- [ ] 两个标签页同时打开同一会话，一次事件**只弹一条**（D5）
- [ ] 权限被拒 → UI 如实显示「浏览器已拒绝」+ 重新请求入口；**不静默无效**（D4）
- [ ] 非 secure context（局域网 IP + http）→ 开关置灰并**写明原因**（D3）
- [ ] 发送抛错不影响 turn 收尾，且日志可查（D9）
- [ ] 刷新页面后开关态保持（localStorage，D8）
- [ ] `cd frontend && pnpm lint` / `pnpm exec tsc -b` / `pnpm test` 零新增警告

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

- `docs/architecture/frontend.md` — `utils/` 补 `desktopNotification.ts`；`Attention/` 目录说明补桌面通知通道与能力探测口径
- `docs/dev/plans/backlog/improvement-directions-remaining.md` — X01 标注「浏览器通道已落地」，剩余缺口收敛为 webhook / pty 侧静默判定（并注明依赖 X11）
- `docs/dev/plans/2026-07-27-acp-session-enhancements.md` — F07 标注已实施 + 指向本文
- `CHANGELOG.md` — **需加条目**
- 注：`docs/reference/requirements.md`「通知功能 ⚪」条目可一并勾上「任务完成 / 意外中断」两小项（pty 侧检测仍未做）
