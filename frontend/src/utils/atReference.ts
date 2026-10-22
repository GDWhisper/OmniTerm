/**
 * `@path` 文件引用的纯函数逻辑（ChatInput @ 补全弹窗用）。
 * 与后端 ws/acp.rs 的 extract_at_paths 语义对齐：
 * `@` 前必须是行首或空白（排除 email 等误报），token 内不含空白和 `@`。
 */

/** 与后端 `src/ws/acp.rs` 的 `MAX_AT_REFERENCES` 对齐。 */
export const MAX_AT_REFERENCES = 8

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

/** token 内不能出现空白或 `@`（与后端 extract_at_paths 的 `[^\s@]+` 对齐）。 */
export function isAtReferenceSafePath(path: string): boolean {
  return path.length > 0 && !/[\s@]/.test(path)
}

/**
 * 在 `[start, end)` 处插入一个或多个 `@path` token，返回新文本与光标位。
 *
 * `@` 前必须是行首或空白（后端正则 `(?:^|\s)@`），因此光标落在一个词中间时
 * 自动补前导空格；token 之间与末尾各留一个空格，方便继续输入。
 */
export function insertAtReferences(
  text: string,
  start: number,
  end: number,
  paths: readonly string[],
): { text: string; cursor: number } {
  if (paths.length === 0) return { text, cursor: start }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const inserted = paths.map((p) => `@${p}`).join(' ') + ' '
  return {
    text: before + lead + inserted + after,
    cursor: before.length + lead.length + inserted.length,
  }
}

/** 用选中的 path 替换正在输入的 `@` token，返回新文本与新光标位。 */
export function replaceAtToken(
  text: string,
  start: number,
  cursorPos: number,
  path: string,
): { text: string; cursor: number } {
  return insertAtReferences(text, start, cursorPos, [path])
}
