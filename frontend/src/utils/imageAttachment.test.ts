import { describe, it, expect } from 'vitest'
import {
  processImageFile,
  dataUrlToAttachment,
  isImageMime,
  imageSrc,
  extractImageFiles,
  ImageAttachmentError,
} from './imageAttachment'

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFile(bytes: Uint8Array<ArrayBuffer>, name = 'a.png'): File {
  return new File([bytes], name, { type: 'image/png' })
}

describe('isImageMime', () => {
  it('accepts anything under image/* and rejects the rest', () => {
    // 管道原则：只判断「是不是图片」，不判断 agent 会不会接受。
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/jpeg')).toBe(true)
    expect(isImageMime('image/webp')).toBe(true)
    expect(isImageMime('image/gif')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(true)
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime('text/plain')).toBe(false)
    expect(isImageMime('')).toBe(false)
  })
})

describe('dataUrlToAttachment', () => {
  it('parses a valid data URL', () => {
    const att = dataUrlToAttachment(`data:image/png;base64,${TINY_PNG_BASE64}`, 'id1')
    expect(att).not.toBeNull()
    expect(att!.id).toBe('id1')
    expect(att!.mimeType).toBe('image/png')
    expect(att!.data).toBe(TINY_PNG_BASE64)
  })

  it('returns null for non-base64 or malformed URLs', () => {
    expect(dataUrlToAttachment('data:image/png,rawdata', 'x')).toBeNull()
    expect(dataUrlToAttachment('not-a-data-url', 'x')).toBeNull()
    expect(dataUrlToAttachment('data:;base64,', 'x')).toBeNull()
  })
})

describe('imageSrc', () => {
  it('prefers the thumbnail so a 240px bubble does not decode the full image', () => {
    const att = { mimeType: 'image/png', data: TINY_PNG_BASE64, thumb: { data: 'THUMB', mimeType: 'image/jpeg' } }
    expect(imageSrc(att)).toBe('data:image/jpeg;base64,THUMB')
  })

  it('falls back to the original when there is no thumbnail', () => {
    const att = { mimeType: 'image/png', data: TINY_PNG_BASE64 }
    expect(imageSrc(att)).toBe(`data:image/png;base64,${TINY_PNG_BASE64}`)
  })
})

describe('processImageFile', () => {
  it('rejects anything that is not an image', async () => {
    const file = new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' })
    await expect(processImageFile(file)).rejects.toMatchObject({ code: 'not_image' })
    await expect(processImageFile(file)).rejects.toBeInstanceOf(ImageAttachmentError)
  })

  it('passes the original bytes through unchanged (no re-encode, no size cap)', async () => {
    const raw = Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0))
    const att = await processImageFile(pngFile(raw))
    expect(att.mimeType).toBe('image/png')
    expect(att.data).toBe(TINY_PNG_BASE64)
    expect(att.id).toBeTruthy()
    // jsdom 无 createImageBitmap，缩略图生成失败 → 缺省，后端回退存原图。
    expect(att.thumb).toBeUndefined()
  })
})

describe('extractImageFiles', () => {
  const makeItem = (kind: string, type: string, file: File | null) =>
    ({ kind, type, getAsFile: () => file }) as unknown as DataTransferItem

  it('returns only image files', () => {
    const png = pngFile(new Uint8Array(4))
    const items = [
      makeItem('file', 'image/png', png),
      makeItem('file', 'text/plain', new File(['x'], 'a.txt', { type: 'text/plain' })),
      makeItem('string', 'text/plain', null),
    ] as unknown as DataTransferItemList
    expect(extractImageFiles(items)).toEqual([png])
  })

  it('handles null/undefined item lists', () => {
    expect(extractImageFiles(null)).toEqual([])
    expect(extractImageFiles(undefined)).toEqual([])
  })
})
