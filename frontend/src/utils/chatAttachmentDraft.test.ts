import { describe, expect, it } from 'vitest'
import { createAttachmentDraftCache } from './chatAttachmentDraft'
import type { ImageAttachment } from './imageAttachment'
import type { FileAttachment } from './fileAttachment'

function image(id: string, bytes: number, thumbBytes = 0): ImageAttachment {
  const att: ImageAttachment = { id, mimeType: 'image/png', data: 'x'.repeat(bytes) }
  if (thumbBytes > 0) att.thumb = { mimeType: 'image/jpeg', data: 't'.repeat(thumbBytes) }
  return att
}

function file(id: string, bytes: number): FileAttachment {
  return { id, name: `${id}.bin`, mimeType: 'application/octet-stream', size: bytes, data: 'f'.repeat(bytes) }
}

/** 小限额构造：让淘汰 / 超预算路径在 KB 级数据上可测。 */
function tinyCache(maxSessions = 2, maxBytes = 100) {
  return createAttachmentDraftCache({ maxSessions, maxBytes })
}

describe('attachment draft cache', () => {
  it('round-trips images and files per session', () => {
    const cache = tinyCache()
    cache.save('s1', { images: [image('i1', 10, 3)], files: [file('f1', 5)] })

    const draft = cache.get('s1')
    expect(draft?.images).toHaveLength(1)
    expect(draft?.images[0].id).toBe('i1')
    expect(draft?.files[0].name).toBe('f1.bin')
    expect(cache.get('s2')).toBeNull()
  })

  it('treats an empty draft as removal', () => {
    const cache = tinyCache()
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    cache.save('s1', { images: [], files: [] })
    expect(cache.get('s1')).toBeNull()
  })

  it('evicts the least recently used session at the count limit', () => {
    const cache = tinyCache(2)
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    cache.save('s2', { images: [image('i2', 10)], files: [] })
    cache.save('s3', { images: [image('i3', 10)], files: [] })

    expect(cache.get('s1')).toBeNull()
    expect(cache.get('s2')).not.toBeNull()
    expect(cache.get('s3')).not.toBeNull()
  })

  it('refreshes recency on read', () => {
    const cache = tinyCache(2)
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    cache.save('s2', { images: [image('i2', 10)], files: [] })
    cache.get('s1')
    cache.save('s3', { images: [image('i3', 10)], files: [] })

    expect(cache.get('s1')).not.toBeNull()
    expect(cache.get('s2')).toBeNull()
  })

  it('refreshes recency on overwrite', () => {
    const cache = tinyCache(2)
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    cache.save('s2', { images: [image('i2', 10)], files: [] })
    cache.save('s1', { images: [image('i1b', 10)], files: [] })
    cache.save('s3', { images: [image('i3', 10)], files: [] })

    expect(cache.get('s2')).toBeNull()
    expect(cache.get('s1')?.images[0].id).toBe('i1b')
  })

  it('does not cache a draft larger than the total byte budget', () => {
    const cache = tinyCache(2, 100)
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    // 替换同一个会话时旧条目也必须移除 —— 否则“超预算”反而留下陈旧附件。
    cache.save('s1', { images: [image('i2', 101)], files: [] })

    expect(cache.get('s1')).toBeNull()
  })

  it('evicts older sessions when the byte budget is exceeded', () => {
    const cache = tinyCache(10, 100)
    cache.save('s1', { images: [image('i1', 60)], files: [] })
    cache.save('s2', { images: [image('i2', 60)], files: [] })

    expect(cache.get('s1')).toBeNull()
    expect(cache.get('s2')).not.toBeNull()
  })

  it('counts thumbnails and file bodies in the byte budget', () => {
    const cache = tinyCache(10, 100)
    cache.save('s1', { images: [image('i1', 10, 50)], files: [file('f1', 50)] })
    cache.save('s2', { images: [image('i2', 10)], files: [] })

    // s1 = 10 + 50 + 50 = 110 > 100: 自身即被拒绝，而非留下半份。
    expect(cache.get('s1')).toBeNull()
    expect(cache.get('s2')).not.toBeNull()
  })

  it('clear removes only the target session', () => {
    const cache = tinyCache()
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    cache.save('s2', { images: [image('i2', 10)], files: [] })
    cache.clear('s1')

    expect(cache.get('s1')).toBeNull()
    expect(cache.get('s2')).not.toBeNull()
  })

  it('returns array copies so callers cannot mutate the cached draft', () => {
    const cache = tinyCache()
    cache.save('s1', { images: [image('i1', 10)], files: [] })
    const draft = cache.get('s1')!
    draft.images.length = 0

    expect(cache.get('s1')?.images).toHaveLength(1)
  })
})
