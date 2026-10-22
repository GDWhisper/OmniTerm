/**
 * UTF-8 字节数的单一真源。
 *
 * 为什么需要它：字符串的 `length` 是 **UTF-16 code unit 数**，中文一个字就占 2，
 * emoji 占 2——用它做体积预算会系统性低估约 1.5–2 倍（导出体积上限因此形同虚设）。
 * `Blob` / `TextEncoder` 用的都是 UTF-8 字节，预算口径必须与之一致。
 *
 * `TextEncoder` 在浏览器与 vitest 的 jsdom 环境均可用（见 utils/liveBuffer.ts
 * 的同款用法），故模块级建一个实例复用——`encode` 每次仍会新建 Uint8Array，
 * 但省不掉那份拷贝，只是省掉编码器本身的构造开销。
 */
const encoder = new TextEncoder()

/** 字符串的 UTF-8 字节数。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}
