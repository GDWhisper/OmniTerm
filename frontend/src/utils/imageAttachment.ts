// F03 图片附件处理：粘贴/拖拽进来的 File → base64 附件。
// 限制（计划 §3.3）：单张 ≤5MB、单次 ≤3 张；过大图片先 canvas 降采样重编码
// JPEG 以缓解 WS 帧压力（tungstenite 默认 16MiB frame 上限，压缩是余量保障）。

export interface ImageAttachment {
  /** 本地唯一 id，供缩略图列表 key/移除用。 */
  id: string
  /** Base64 数据（不含 data URI 前缀），随 prompt 帧发给后端。 */
  data: string
  mimeType: string
}

export const MAX_IMAGE_ATTACHMENTS = 3
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 超过此原始体积才触发降采样重编码（小图保真直传）。 */
const RECOMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024
/** 降采样目标长边（视觉模型常用输入尺寸量级，再大无增益）。 */
const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isAcceptedImageMime(mime: string): boolean {
  return ACCEPTED_MIME.has(mime)
}

export type ImageProcessError = 'unsupported_type' | 'too_large'

export class ImageAttachmentError extends Error {
  readonly code: ImageProcessError
  constructor(code: ImageProcessError) {
    super(code)
    this.code = code
  }
}

export function dataUrlToAttachment(dataUrl: string, id: string): ImageAttachment | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return { id, mimeType: match[1], data: match[2] }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

/** base64 解码后的近似字节数（不必精确，用于 5MB 硬限判断足够）。 */
export function approxBase64Bytes(base64: string): number {
  return Math.floor(base64.length * 0.75)
}

async function downscaleToJpeg(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    return null
  }
}

/**
 * 处理一个粘贴/拖拽的文件：类型校验 → 视体积决定直传或降采样 → 5MB 硬限。
 * 失败抛 `ImageAttachmentError`（调用方转为内联错误提示）。
 *
 * 注意 GIF 不做重编码（canvas 只保留首帧，会破坏动图语义），超限直接拒绝。
 */
export async function processImageFile(file: File): Promise<ImageAttachment> {
  if (!isAcceptedImageMime(file.type)) {
    throw new ImageAttachmentError('unsupported_type')
  }
  const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  let dataUrl: string | null = null
  if (file.size > RECOMPRESS_THRESHOLD_BYTES && file.type !== 'image/gif') {
    dataUrl = await downscaleToJpeg(file)
  }
  if (!dataUrl) {
    dataUrl = await readAsDataUrl(file)
  }
  const attachment = dataUrlToAttachment(dataUrl, id)
  if (!attachment) {
    throw new ImageAttachmentError('unsupported_type')
  }
  if (approxBase64Bytes(attachment.data) > MAX_IMAGE_BYTES) {
    throw new ImageAttachmentError('too_large')
  }
  return attachment
}

/** 从 paste/drop 事件的 DataTransfer/clipboardData 中提取图片文件。 */
export function extractImageFiles(items: DataTransferItemList | null | undefined): File[] {
  if (!items) return []
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && isAcceptedImageMime(item.type)) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}
