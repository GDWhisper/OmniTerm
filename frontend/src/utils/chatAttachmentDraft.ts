/**
 * 未发送附件（图片 / 文件）的会话草稿缓存（单一真源）。
 *
 * 文字草稿进 sessionStorage（`chatDraft.ts`），附件不能照搬：base64 原图可达
 * MiB 级，sessionStorage 只有约 5MB 配额，写入会静默失败并连带挤掉其他草稿。
 * 故放模块作用域——切会话回来即恢复，刷新页面即清（与 chatStore 同生命周期）。
 *
 * `ChatView` 以 `key={activeSessionId}` 重挂载 `ChatInput`，组件本地 state 会随
 * 卸载丢失；`ChatInput` 在挂载时读取本缓存、随后写穿。
 *
 * 有界（performance-and-safety §P1）：最多跟踪 `maxSessions` 个会话、总计
 * `maxBytes`。插入序即新鲜度，`get` / `save` 都会刷新；超限淘汰最久未用者。
 * 单个草稿自身超过总预算时不缓存（留在当前会话的组件 state 里，切走即丢，
 * 与改动前一致），替换已有草稿时旧条目同时移除。
 */

import type { ImageAttachment } from './imageAttachment'
import type { FileAttachment } from './fileAttachment'

export interface AttachmentDraft {
  images: ImageAttachment[]
  files: FileAttachment[]
}

export interface AttachmentDraftLimits {
  maxSessions: number
  maxBytes: number
}

export interface AttachmentDraftCache {
  get(sessionId: string): AttachmentDraft | null
  save(sessionId: string, draft: AttachmentDraft): void
  clear(sessionId: string): void
  clearAll(): void
}

const DEFAULT_LIMITS: AttachmentDraftLimits = {
  // 同时挂起附件草稿的会话数。用户在多个会话间来回比较时够用，又不至于让
  // 关掉的会话无限占用内存。
  maxSessions: 8,
  // 总预算约三倍单条 WS 消息上限（12MiB）；base64 ASCII 字符数即字节数。
  maxBytes: 32 * 1024 * 1024,
}

function draftBytes(draft: AttachmentDraft): number {
  let bytes = 0
  for (const image of draft.images) {
    bytes += image.data.length + (image.thumb?.data.length ?? 0)
  }
  for (const file of draft.files) {
    bytes += file.data.length
  }
  return bytes
}

/** 独立的缓存实例：生产用下面的单例，测试用小限额构造以跑满淘汰路径。 */
export function createAttachmentDraftCache(limits: AttachmentDraftLimits): AttachmentDraftCache {
  const bySession = new Map<string, AttachmentDraft>()
  let totalBytes = 0

  const evictOldest = () => {
    const oldest = bySession.keys().next().value
    if (oldest === undefined) return
    const draft = bySession.get(oldest)
    bySession.delete(oldest)
    if (draft) totalBytes -= draftBytes(draft)
  }

  return {
    get(sessionId) {
      const draft = bySession.get(sessionId)
      if (!draft) return null
      // 刷新新鲜度：Map 插入序即 LRU 顺序。
      bySession.delete(sessionId)
      bySession.set(sessionId, draft)
      return { images: draft.images.slice(), files: draft.files.slice() }
    },

    save(sessionId, draft) {
      if (!sessionId) return
      const previous = bySession.get(sessionId)
      if (previous) {
        bySession.delete(sessionId)
        totalBytes -= draftBytes(previous)
      }

      const images = draft.images.slice()
      const files = draft.files.slice()
      if (images.length === 0 && files.length === 0) return

      const bytes = draftBytes({ images, files })
      if (bytes > limits.maxBytes) return

      while (bySession.size >= limits.maxSessions) evictOldest()
      while (totalBytes + bytes > limits.maxBytes && bySession.size > 0) evictOldest()

      bySession.set(sessionId, { images, files })
      totalBytes += bytes
    },

    clear(sessionId) {
      const draft = bySession.get(sessionId)
      if (!draft) return
      bySession.delete(sessionId)
      totalBytes -= draftBytes(draft)
    },

    clearAll() {
      bySession.clear()
      totalBytes = 0
    },
  }
}

const cache = createAttachmentDraftCache(DEFAULT_LIMITS)

/** 读取会话的附件草稿；无草稿返回 null。调用方拿到的是数组副本。 */
export function getAttachmentDraft(sessionId: string): AttachmentDraft | null {
  return cache.get(sessionId)
}

/** 写穿会话的附件草稿；空草稿等同清除。 */
export function saveAttachmentDraft(sessionId: string, draft: AttachmentDraft): void {
  cache.save(sessionId, draft)
}

/** 发送成功 / 用户显式清空后移除该会话的附件草稿。 */
export function clearAttachmentDraft(sessionId: string): void {
  cache.clear(sessionId)
}

/** 测试隔离：清空全部草稿（生产路径不调用）。 */
export function clearAllAttachmentDrafts(): void {
  cache.clearAll()
}
