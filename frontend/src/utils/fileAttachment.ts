// 文件附件处理：从选择器/相册入口拿到的 File → base64 附件。
//
// 管道原则（与 imageAttachment 同一套）：不做内容层限制——张数、单个体积、MIME
// 白名单一律没有。文件原样 base64 随 prompt 帧发给后端转交 agent，发多大、发几个
// 由用户决定（唯一的硬约束是 WebSocket 管道口径，由后端显式报错，见 src/ws/acp.rs）。
//
// 与图片的差异：文件不生成缩略图（没有可渲染的等价物），保留 name/size 元数据供
// 附件区 chip 与历史气泡展示；落库只存元数据，内容不落盘。

import { readAsDataUrl } from './readFile'

export interface FileAttachment {
  /** 本地唯一 id，供 chip 列表 key/移除用。 */
  id: string
  /** 文件名（picker 给的是 basename）。 */
  name: string
  mimeType: string
  /** 原始字节数，随附件元数据落库供展示。 */
  size: number
  /** Base64 数据（不含 data URI 前缀），随 prompt 帧发给后端。 */
  data: string
}

export type FileProcessError = 'read_failed'

export class FileAttachmentError extends Error {
  readonly code: FileProcessError
  constructor(code: FileProcessError) {
    super(code)
    this.code = code
  }
}

/**
 * 处理一个选择器选中的文件：原样读取为 base64。
 *
 * 解析用 indexOf 切分而非正则：空文件（payload 为空串）与未知 MIME（header 为
 * `data:;base64`）都是合法输入，正则要求非空会误伤。失败抛
 * `FileAttachmentError`（调用方转为内联错误提示）。
 */
export async function processFile(file: File): Promise<FileAttachment> {
  const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const dataUrl = await readAsDataUrl(file).catch(() => null)
  const comma = dataUrl ? dataUrl.indexOf(',') : -1
  if (!dataUrl || comma < 0) {
    throw new FileAttachmentError('read_failed')
  }
  const header = dataUrl.slice(5, comma) // 去掉 `data:` 前缀
  const mimeType = header.replace(/;base64$/i, '') || file.type || 'application/octet-stream'

  return {
    id,
    name: file.name,
    mimeType,
    size: file.size,
    data: dataUrl.slice(comma + 1),
  }
}

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** 文件大小展示（附件 chip / 历史气泡）。以 1024 进制，保留一位小数。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0
    ? `${Math.round(value)} ${FILE_SIZE_UNITS[unit]}`
    : `${value.toFixed(1)} ${FILE_SIZE_UNITS[unit]}`
}
