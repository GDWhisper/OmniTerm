import type { SessionUpdateAction } from '../stores/chatStore'

// --- ACP 实时帧缓冲（liveBuffer）的限界与合并 ---
//
// 背景（2026-10-10 用户报告「长时间离开浏览器后 omniterm 假死」）：
// `useAcpChat` 把 WS 到达的 `session_update` 动作攒进缓冲、每动画帧 flush 一次，
// 把「每 chunk 一次重渲染」降为「每帧最多一次」。**隐藏页/后台标签不派发 rAF，
// 而 WS 消息照常投递**——于是离开浏览器多久，缓冲就累积多久，且此前无任何上限。
// 回来时第一个 rAF 一次性提交上万条 action：`applyActionsToMessages` 对每个 action
// 都做一次 `[...messages]` 全量浅拷贝，成本 O(actions × messages)，主线程阻塞数秒。
//
// 三条契约（docs/dev/performance-and-safety.md §P1）：
//   ① 上限维度匹配增长维度 —— 条数与字节两条同时守（单条大小由 agent 决定，
//      只限条数等于没限：80 个 30KB chunk 合并后仍是 1 条、2.4MB）；
//   ② 超限策略 = 立即 flush（内容零丢失，只是提前提交），**不静默丢弃**；
//   ③ 单测守住：条数/字节各触发一次越界 + 合并守恒（见 liveBuffer.test.ts）。

/** 缓冲的动作条数上限。 */
export const LIVE_BUFFER_MAX_ACTIONS = 2000

/** 缓冲的 UTF-8 字节上限（2 MiB）。
 *
 *  取值依据：与后端 `GET /messages` 单页字节预算同量级（2MiB）——一页就是一次
 *  hydrate / 聚焦补拉的传输单位，实时缓冲与其对齐可避免「补拉一页比整个缓冲还大」
 *  的倒挂。留余量给单条肥 action（越界即 flush，峰值 = 一条）。 */
export const LIVE_BUFFER_MAX_BYTES = 2 * 1024 * 1024

/** rAF 停摆（页面隐藏/后台标签）时的兜底 flush 间隔。 */
export const LIVE_BUFFER_FLUSH_FALLBACK_MS = 1000

/** 复用的编码器：UTF-8 字节数是上限的真实维度（UTF-16 长度会把 CJK 少算 2/3）。 */
const byteEncoder = new TextEncoder()

const utf8Len = (s: string): number => byteEncoder.encode(s).length

/**
 * 动作的字节代价。用序列化长度而非手写字段清单：累积结构里每个 action 的体积
 * 都由 agent 输出决定（正文 chunk、工具 content 都无上界），逐个字段列白名单
 * 必然漏——漏一个就是一个新的无界维度。序列化还顺带覆盖了结构体字段本身。
 */
const actionBytes = (action: SessionUpdateAction): number =>
  utf8Len(JSON.stringify(action))

/**
 * 相邻且同类才可无损合并：`appendProseToMessages` 对连续同 kind 的追加与
 * 一次性追加拼接串完全等价（都落到同一条 streaming assistant 消息上）。
 * 不可合并返回 null。
 *
 * 一并返回**字节增量**而非让调用方重算整条 action：精确值要对合并后的整条
 * 重新 `JSON.stringify` + 编码，而每个流式 chunk 都重编码一遍已累积正文，
 * 正是 `performance-and-safety.md` §P2 批评的 O(n²)（单测里 80 个 30KB chunk
 * 因此跑了 500ms）。增量取本 chunk 的 UTF-8 长度：JSON 外壳（~35B）只在该
 * action 首次入队时计一次，故计数与真实序列化长度只差一个常量，对预算无影响
 * （预算要的是「不随离开时长无界增长」，不是字节级精确）。
 */
const mergeProse = (
  prev: SessionUpdateAction,
  next: SessionUpdateAction,
): { action: SessionUpdateAction & { text: string }; addedBytes: number } | null => {
  if (prev.kind === 'appendText' && next.kind === 'appendText') {
    return {
      action: { kind: 'appendText', text: prev.text + next.text },
      addedBytes: utf8Len(next.text),
    }
  }
  if (prev.kind === 'appendThought' && next.kind === 'appendThought') {
    return {
      action: { kind: 'appendThought', text: prev.text + next.text },
      addedBytes: utf8Len(next.text),
    }
  }
  return null
}

/**
 * 有界的实时动作缓冲。`push` 返回 true = 已越过预算，调用方应立即 `take()` 并提交
 * （`useAcpChat` 的 `flushLiveBuffer`）。
 *
 * 峰值说明：单条 action 自身就可能超字节预算（agent 一次推来数十 MB 正文）。
 * 此时仍整条入队并请求 flush —— 峰值 = 一条 action 的大小。
 *
 * **为什么不像后端 `MAX_FRAME_BYTES` 那样「先裁再入」**（`2026-08-10-acp-session-reliability.md`
 * Phase 2 实施说明第 3 条的原则，前端 live 缓冲是已知的偏离，已在该计划留勘误）：
 *   ① 那条裁的是**累积器窗口**（落库 / 快照路径），裁剪后可用中段省略标记保住语义；
 *      live 缓冲里的 prose 是**用户正在看的那条消息**，裁它会让屏幕上的正文永久缺一段，
 *      且没有可恢复的副本（DB 侧由后端 `MAX_TEXT_BYTES` 独立限界，两边裁不同位置只会更乱）。
 *   ② `JSON.parse` 在进入本缓冲之前就已分配了数倍内存，此处裁剪省不下峰值。
 * 明示的取舍：live 单帧体积**没有**应用层防线（仅 axum 传输层默认 64MiB 帧帽）。
 * 若将来要补，正确位置是后端 live 转发侧（`ws/acp.rs::forward_session_update`），
 * 而不是前端缓冲——见该计划勘误。
 */
export class LiveBuffer {
  private actions: SessionUpdateAction[] = []
  private bytes = 0

  get length(): number {
    return this.actions.length
  }

  get byteLength(): number {
    return this.bytes
  }

  isEmpty(): boolean {
    return this.actions.length === 0
  }

  /** 入队一条动作；相邻同类 prose 无损合并。返回 true 表示已越界，需立即 flush。 */
  push(action: SessionUpdateAction): boolean {
    const last = this.actions[this.actions.length - 1]
    const merged = last === undefined ? null : mergeProse(last, action)
    if (merged !== null) {
      this.actions[this.actions.length - 1] = merged.action
      this.bytes += merged.addedBytes
    } else {
      this.actions.push(action)
      this.bytes += actionBytes(action)
    }
    return this.overBudget()
  }

  /** 取出全部积压动作并复位计数；空缓冲返回空数组。 */
  take(): SessionUpdateAction[] {
    if (this.actions.length === 0) return []
    const batch = this.actions
    this.actions = []
    this.bytes = 0
    return batch
  }

  private overBudget(): boolean {
    return (
      this.actions.length >= LIVE_BUFFER_MAX_ACTIONS ||
      this.bytes >= LIVE_BUFFER_MAX_BYTES
    )
  }
}
