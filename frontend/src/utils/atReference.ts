/**
 * `@path` 文件引用的纯函数逻辑（ChatInput @ 补全弹窗用）。
 * 与后端 ws/acp.rs 的 extract_at_paths 语义对齐：
 * `@` 前必须是行首或空白（排除 email 等误报），token 内不含空白和 `@`。
 */

export interface AtToken {
  /** `@` 字符在 text 中的下标。 */
  start: number
  /** `@` 之后、光标之前的查询串（可为空）。 */
  query: string
}

/** 找光标位置正在输入的 `@` token；没有则返回 null。 */
export function findAtToken(text: string, cursorPos: number): AtToken | null {
  const before = text.slice(0, cursorPos)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  // `@` 前必须是行首或空白
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // token 中断条件：出现空白或另一个 @
  if (/[\s@]/.test(query)) return null
  return { start: at, query }
}

/** 用选中的 path 替换正在输入的 `@` token，返回新文本与新光标位。 */
export function replaceAtToken(
  text: string,
  start: number,
  cursorPos: number,
  path: string,
): { text: string; cursor: number } {
  const inserted = `@${path} `
  const next = text.slice(0, start) + inserted + text.slice(cursorPos)
  return { text: next, cursor: start + inserted.length }
}
