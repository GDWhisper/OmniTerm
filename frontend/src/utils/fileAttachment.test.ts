import { describe, it, expect } from 'vitest'
import { processFile, formatFileSize, FileAttachmentError } from './fileAttachment'

describe('processFile', () => {
  it('returns name, mime, size and base64 payload unchanged', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' })
    const att = await processFile(file)
    expect(att.name).toBe('a.pdf')
    expect(att.mimeType).toBe('application/pdf')
    expect(att.size).toBe(3)
    expect(att.data).toBe(btoa('\x01\x02\x03'))
    expect(att.id).toBeTruthy()
  })

  it('keeps an empty file payload as an empty string', async () => {
    // 空文件合法：payload 为空串，正则式解析会误伤，indexOf 切分不会。
    const file = new File([], 'empty.txt', { type: 'text/plain' })
    const att = await processFile(file)
    expect(att.data).toBe('')
    expect(att.size).toBe(0)
  })

  it('falls back to the file type when the data URL carries no mime', async () => {
    // FileReader 的 data URL 以 Blob.type 为准；type 为空时回退到 octet-stream。
    const file = new File([new Uint8Array(2)], 'blob.bin', { type: '' })
    const att = await processFile(file)
    expect(att.mimeType).toBe('application/octet-stream')
  })

  it('throws read_failed when the file cannot be read', async () => {
    // 非 Blob 输入让 FileReader 同步抛错 → readAsDataUrl reject → read_failed。
    const bogus = { name: 'x', size: 0, type: '' } as unknown as File
    await expect(processFile(bogus)).rejects.toMatchObject({ code: 'read_failed' })
    await expect(processFile(bogus)).rejects.toBeInstanceOf(FileAttachmentError)
  })
})

describe('formatFileSize', () => {
  it('formats bytes, KB and MB with 1024 steps', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })

  it('handles non-finite and negative input defensively', () => {
    expect(formatFileSize(-5)).toBe('0 B')
    expect(formatFileSize(Number.NaN)).toBe('0 B')
  })
})
