/**
 * 浏览器桌面通知（`Notification` API）的能力探测、发送与多标签页去重。
 *
 * 计划：`docs/dev/plans/2026-10-21-browser-desktop-notification.md`（F07，D1–D10）。
 *
 * 四条硬约束（改动前先读，改法与计划冲突时以计划的 ADR 为准）：
 *
 * - **能力判定以 `'Notification' in window` 为主**（D3）：`window.isSecureContext`
 *   只用于**解释原因**，不作独立否决。两者混用会让 jsdom（`isSecureContext` 为
 *   `undefined`）与真实浏览器产生不一致判定。真实浏览器在非安全上下文里**根本不
 *   暴露 `Notification` 构造器**，故 `blocked` 态天然覆盖「局域网 IP + 明文 http」
 *   这个主部署形态的坑——不需要额外用 `isSecureContext` 去否决。
 * - **内容只含会话名 + 事件类型**（D2）：OS 通知在锁屏/任务栏明文显示，agent
 *   正文可能含代码、路径、凭据（`docs/dev/performance-and-safety.md` §S3）。
 * - **多标签页去重**（D5）：`BroadcastChannel` 上「先到者发、后到者静默」。同一声明
 *   键（会话 + 事件类型）在短窗口内只允许一个标签页真的发出通知。
 * - **失败记日志 + 静默跳过**（D9）：通知是旁路能力，构造器抛错绝不能影响 turn
 *   收尾。这不是「吞异常掩盖症状」（§S2）——是显式降级，且日志可查。
 *
 * 本模块**不依赖 react-i18next / store**：文案由调用方组装（会话名 + 事件类型），
 * 开关态由调用方读 store 后传入判定结果。理由同 `utils/sessionDisplayName.ts`。
 */

/** 能力态：环境是否提供通知能力、用户是否已授权。 */
export type DesktopNotificationCapability =
  /** 构造器可用且权限已授予——可以真的发出通知。 */
  | 'supported'
  /** 构造器可用但用户还没表态（浏览器默认态）：下次询问会弹权限框。 */
  | 'default'
  /** 用户已拒绝。 */
  | 'denied'
  /** 环境不提供（含非安全上下文——那里根本没有 `Notification` 构造器）。 */
  | 'blocked'

/** `blocked` 的具体原因：**只用于 UI 如实说明**，不参与能力判定（D3）。 */
export type DesktopNotificationBlockReason =
  /** 非安全上下文：浏览器只在 HTTPS 或本机地址提供桌面通知。 */
  | 'insecure-context'
  /** 浏览器/环境压根没有通知能力。 */
  | 'unsupported'

/**
 * 能力探测（D3）。
 *
 * 判据顺序不可颠倒：先看构造器在不在，再看权限——`isSecureContext` 只用来解释
 * 「为什么没有」，不作独立否决（否则 jsdom 与真实浏览器判定不一致）。
 */
export function detectNotificationCapability(): DesktopNotificationCapability {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'blocked'
  const permission = (window as Window & { Notification?: { permission?: string } }).Notification
    ?.permission
  if (permission === 'granted') return 'supported'
  if (permission === 'denied') return 'denied'
  return 'default'
}

/**
 * `blocked` 的原因（供 UI 如实说明）；非 blocked 态返回 null。
 *
 * `isSecureContext === false` 才是「明文 http 访问非本机地址」这个最常见的坑；
 * `undefined`（jsdom / 老浏览器）不据此下结论。
 */
export function notificationBlockReason(
  capability: DesktopNotificationCapability,
): DesktopNotificationBlockReason | null {
  if (capability !== 'blocked') return null
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure-context'
  return 'unsupported'
}

/**
 * 桌面通知是否「已就绪」= 权限已授予。
 *
 * 用来决定要不要叠加 OmniTerm 自己的 ping 声（D7）：OS 通知自带系统音效，
 * 两边都响就是双响。调用方另需 AND 上「用户已开启开关」——开关是用户意图，
 * 权限是浏览器状态，两者都要。
 */
export function desktopNotificationReady(): boolean {
  return detectNotificationCapability() === 'supported'
}

/* ── 多标签页去重（D5）───────────────────────────────────── */

/** 跨标签页广播频道名（协议的一部分，测试与其它实现要按此名对接）。 */
export const NOTIFY_CHANNEL_NAME = 'omniterm-notify'

/**
 * 声明消息：某个标签页宣布「我要为这个键发通知」。
 *
 * 裁决规则：**最早声明者发送**（先到者发、后到者静默）。同一毫秒内并列时按
 * `id` 字典序决胜——保证恰好一个发送方，不靠运气。
 */
export interface NotifyClaim {
  kind: 'claim'
  /** 去重键：`会话 id + 事件类型`。 */
  key: string
  /** 声明时刻（同一台机器的各标签页共享同一时钟）。 */
  ts: number
  /** 随机 id：并列时的决胜键。 */
  id: string
}

/** 跨标签页裁决等待：给对方广播到达留时间（亚秒级，D5 接受残余竞态窗口）。 */
const CLAIM_WAIT_MS = 120
/** 本地去重窗口：同一键在此窗口内不重复弹。 */
const DEDUP_WINDOW_MS = 2_000
/** 去重表容量上限（长跑不许无界累积——性能红线 P1）。 */
const DEDUP_MAX_ENTRIES = 64

let channel: BroadcastChannel | null = null
let channelUnavailable = false
/** 每个去重键当前的「最早声明者」（含本标签页自己发的）。 */
const bestClaims = new Map<string, NotifyClaim>()
/** 本标签页已处理过的键 → 时刻（本地短窗口去重）。 */
const recentKeys = new Map<string, number>()

function claimOrder(a: NotifyClaim, b: NotifyClaim): number {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 淘汰过期条目并守住容量上限（Map 保持插入序，淘汰最旧的）。 */
function pruneMaps(): void {
  const now = Date.now()
  for (const [key, ts] of recentKeys) {
    if (now - ts > DEDUP_WINDOW_MS) recentKeys.delete(key)
  }
  for (const [key, claim] of bestClaims) {
    if (now - claim.ts > DEDUP_WINDOW_MS) bestClaims.delete(key)
  }
  while (recentKeys.size > DEDUP_MAX_ENTRIES) {
    const oldest = recentKeys.keys().next().value
    if (oldest === undefined) break
    recentKeys.delete(oldest)
  }
  while (bestClaims.size > DEDUP_MAX_ENTRIES) {
    const oldest = bestClaims.keys().next().value
    if (oldest === undefined) break
    bestClaims.delete(oldest)
  }
}

/** 记录一个声明，保留最早者。 */
function mergeClaim(claim: NotifyClaim): void {
  pruneMaps()
  const current = bestClaims.get(claim.key)
  if (!current || claimOrder(claim, current) < 0) bestClaims.set(claim.key, claim)
}

/** 惰性建立广播频道；环境不支持或构造失败时静默降级为「无跨标签页去重」。 */
function ensureChannel(): BroadcastChannel | null {
  if (channelUnavailable) return null
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') {
    channelUnavailable = true
    return null
  }
  try {
    channel = new BroadcastChannel(NOTIFY_CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent) => {
      const claim = event.data as NotifyClaim | undefined
      if (!claim || claim.kind !== 'claim' || typeof claim.key !== 'string') return
      mergeClaim(claim)
    }
  } catch {
    channelUnavailable = true
    channel = null
  }
  return channel
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomId(): string {
  return Math.random().toString(36).slice(2)
}

/** 桌面通知请求。 */
export interface DesktopNotificationRequest {
  /** 标题：会话显示名（单一真源 `utils/sessionDisplayName.ts`）。 */
  title: string
  /** 正文：仅事件类型，**不含 agent 回复正文**（D2）。 */
  body: string
  /** 去重键：`会话 id + 事件类型`（D5）。 */
  dedupKey: string
}

/**
 * 发一条桌面通知。返回是否真的发出（被去重抑制 / 权限未授予 / 构造失败都是 false）。
 *
 * 跨标签页裁决（D5）：先广播自己的声明，等一小段（`CLAIM_WAIT_MS`）看有没有更早
 * 的声明到达——有就静默（对方已经发了），没有才自己发。单标签页场景恒定发出，
 * 只是晚 `CLAIM_WAIT_MS`（亚秒级，用户不可感知）。
 */
export async function sendDesktopNotification(
  request: DesktopNotificationRequest,
): Promise<boolean> {
  // 权限每次现读、不缓存：用户可能在浏览器里随时撤销（D9 / 风险表「权限被撤销
  // 时即时降级」）。未授予时不构造通知——浏览器会静默忽略，白构造一次没意义。
  if (!desktopNotificationReady()) return false

  pruneMaps()
  const last = recentKeys.get(request.dedupKey)
  if (last !== undefined && Date.now() - last < DEDUP_WINDOW_MS) return false

  const claim: NotifyClaim = {
    kind: 'claim',
    key: request.dedupKey,
    ts: Date.now(),
    id: randomId(),
  }
  const ch = ensureChannel()
  if (ch) {
    mergeClaim(claim)
    try {
      ch.postMessage(claim)
    } catch {
      // 频道已关闭等异常：不影响本标签页自己发通知（去重降级为「仅本标签页」）。
    }
  }

  await delay(CLAIM_WAIT_MS)

  const best = bestClaims.get(request.dedupKey)
  if (best && best.id !== claim.id) return false // 别人先到 → 静默

  recentKeys.set(request.dedupKey, Date.now())
  pruneMaps()

  try {
    new Notification(request.title, { body: request.body })
    return true
  } catch (err) {
    // D9：通知是旁路能力，失败不影响 turn 收尾，但必须留痕可查。
    console.warn('[desktopNotification] 发送失败，已降级（不影响主链路）:', err)
    return false
  }
}

/** 测试用：清空去重状态（模块级状态跨用例残留会让断言互相污染）。 */
export function resetDesktopNotificationState(): void {
  bestClaims.clear()
  recentKeys.clear()
  if (channel) {
    try {
      channel.close()
    } catch {
      // 关闭失败无所谓——下次 ensureChannel 会重建（channel 仍非 null 时复用它）。
    }
    channel = null
  }
  channelUnavailable = false
}
