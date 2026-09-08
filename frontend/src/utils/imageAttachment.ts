// F03 图片附件处理：粘贴/拖拽进来的 File → base64 附件。
//
// 管道原则：不做内容层限制——张数、单张体积、MIME 白名单、对原图的静默重编码
// 一律没有。原图原样随 prompt 帧发给后端转交 agent，发多大、发几张由用户决定
// （唯一的硬约束是 WebSocket 管道口径，由后端显式报错，见 src/ws/acp.rs）。
//
// 唯一的额外产物是缩略图：只用于落库与预览/气泡渲染。这些地方显示尺寸只有几十
// 到几百 px，没必要让浏览器为它解码整张原图的位图（4000×3000 的照片 ≈ 46MB）。

export interface ImageAttachment {
  /** 本地唯一 id，供缩略图列表 key/移除用。 */
  id: string
  /** Base64 数据（不含 data URI 前缀），随 prompt 帧发给后端。 */
  data: string
  mimeType: string
  /**
   * 落库与历史渲染用的缩略图。生成失败时缺省，后端回退存原图。
   * 自带 mimeType：编码格式由生成方决定，接收方不做假设。
   */
  thumb?: ImageThumb
}

export interface ImageThumb {
  data: string
  mimeType: string
}

/** 缩略图目标长边：气泡 240×200，480 在 @2x 屏也够。 */
const THUMB_MAX_DIMENSION = 480
const THUMB_JPEG_QUALITY = 0.7

/** 只判断「是不是图片」，不判断 agent 会不会接受——那是 agent 自己的事。 */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export type ImageProcessError = 'not_image' | 'read_failed'

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

/**
 * 图片 `<img src>`：优先缩略图，没有再退回原图。
 * 渲染侧一律走这里，避免在几十 px 的显示尺寸上解码整张原图。
 */
export function imageSrc(image: {
  mimeType: string
  data: string
  thumb?: ImageThumb
}): string {
  const src = image.thumb ?? image
  return `data:${src.mimeType};base64,${src.data}`
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function drawToJpeg(source: ImageBitmap, maxDimension: number, quality: number): string | null {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * 生成缩略图（仅用于落库与历史渲染）。失败返回 null——缩略图是优化，不是发送的前置条件。
 *
 * 动图（GIF）只能取首帧：canvas 没有帧的概念，历史里的动图会静止。
 */
async function makeThumbnail(file: File): Promise<ImageThumb | null> {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file)
    const dataUrl = drawToJpeg(bitmap, THUMB_MAX_DIMENSION, THUMB_JPEG_QUALITY)
    const parsed = dataUrl ? dataUrlToAttachment(dataUrl, '') : null
    return parsed ? { data: parsed.data, mimeType: parsed.mimeType } : null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

/**
 * 处理一个粘贴/拖拽的文件：原样读取 + 附带生成一份缩略图。
 * 失败抛 `ImageAttachmentError`（调用方转为内联错误提示）。
 */
export async function processImageFile(file: File): Promise<ImageAttachment> {
  if (!isImageMime(file.type)) {
    throw new ImageAttachmentError('not_image')
  }
  const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const dataUrl = await readAsDataUrl(file).catch(() => null)
  const attachment = dataUrl ? dataUrlToAttachment(dataUrl, id) : null
  if (!attachment) {
    throw new ImageAttachmentError('read_failed')
  }
  const thumb = await makeThumbnail(file)
  if (thumb) attachment.thumb = thumb
  return attachment
}

/** 从 paste/drop 事件的 DataTransfer/clipboardData 中提取图片文件。 */
export function extractImageFiles(items: DataTransferItemList | null | undefined): File[] {
  if (!items) return []
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && isImageMime(item.type)) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}
