import { describe, it, expect } from 'vitest'
import {
  processImageFile,
  dataUrlToAttachment,
  approxBase64Bytes,
  isAcceptedImageMime,
  extractImageFiles,
  ImageAttachmentError,
  MAX_IMAGE_BYTES,
} from './imageAttachment'

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFile(bytes: Uint8Array<ArrayBuffer>, name = 'a.png'): File {
  return new File([bytes], name, { type: 'image/png' })
}

describe('isAcceptedImageMime', () => {
  it('accepts png/jpeg/webp/gif and rejects others', () => {
    expect(isAcceptedImageMime('image/png')).toBe(true)
    expect(isAcceptedImageMime('image/jpeg')).toBe(true)
    expect(isAcceptedImageMime('image/webp')).toBe(true)
    expect(isAcceptedImageMime('image/gif')).toBe(true)
    expect(isAcceptedImageMime('image/svg+xml')).toBe(false)
    expect(isAcceptedImageMime('application/pdf')).toBe(false)
    expect(isAcceptedImageMime('')).toBe(false)
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

describe('approxBase64Bytes', () => {
  it('estimates decoded size at 3/4 of base64 length', () => {
    expect(approxBase64Bytes('')).toBe(0)
    expect(approxBase64Bytes('AAAA')).toBe(3)
    expect(approxBase64Bytes(TINY_PNG_BASE64)).toBe(Math.floor(TINY_PNG_BASE64.length * 0.75))
  })
})

describe('processImageFile', () => {
  it('rejects unsupported mime types', async () => {
    const file = new File([new Uint8Array(10)], 'a.svg', { type: 'image/svg+xml' })
    await expect(processImageFile(file)).rejects.toMatchObject({ code: 'unsupported_type' })
    await expect(processImageFile(file)).rejects.toBeInstanceOf(ImageAttachmentError)
  })

  it('passes a small png through unchanged (no re-encode)', async () => {
    const raw = Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0))
    const att = await processImageFile(pngFile(raw))
    expect(att.mimeType).toBe('image/png')
    expect(att.data).toBe(TINY_PNG_BASE64)
    expect(att.id).toBeTruthy()
  })

  it('rejects images still over the 5MB hard limit', async () => {
    // jsdom 无 createImageBitmap，降采样路径回退到原样直传，> 5MB 必拒。
    const big = pngFile(new Uint8Array(MAX_IMAGE_BYTES + 1024 * 1024))
    await expect(processImageFile(big)).rejects.toMatchObject({ code: 'too_large' })
  })
})

describe('extractImageFiles', () => {
  const makeItem = (kind: string, type: string, file: File | null) =>
    ({ kind, type, getAsFile: () => file }) as unknown as DataTransferItem

  it('returns only accepted image files', () => {
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
