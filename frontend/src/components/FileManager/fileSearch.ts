/**
 * 抽屉文件编辑器内搜索的匹配计算（纯函数：无 React / CodeMirror 依赖）。
 *
 * FileEditor 把「查询串 → 匹配区间」这一步收敛到这里，组件只负责把结果
 * 搬进 CodeMirror 装饰。三条真实边界在此一次性处理：
 *
 * 1. 正则非法：用户输入到一半的模式（如 "("）随时编译失败——不当错误，
 *    只停掉高亮（invalid），等用户补完自然恢复。
 * 2. 零长匹配：`a*` / `^` 这类模式 exec 会返回空串，不手动前移 lastIndex
 *    就是死循环（UI 直接卡死）。
 * 3. 匹配数无界：装饰集合随匹配数线性增长，超大文件 + 短查询可产出数十万
 *    条装饰拖垮渲染（§P1）——达到 MAX_SEARCH_MATCHES 即截断。
 */

/** 单次搜索返回的匹配区间数上限，超出即截断（面板显示 "N+"） */
export const MAX_SEARCH_MATCHES = 10000

export interface SearchMatch {
  /** 匹配起点（doc 字符偏移） */
  from: number
  /** 匹配终点（doc 字符偏移，开区间） */
  to: number
}

export interface SearchOptions {
  query: string
  caseSensitive: boolean
  regex: boolean
}

export interface SearchResult {
  matches: SearchMatch[]
  /** 正则模式非法（编译失败） */
  invalid: boolean
  /** 匹配数达到 MAX_SEARCH_MATCHES 被截断 */
  truncated: boolean
}

const EMPTY: SearchResult = { matches: [], invalid: false, truncated: false }

export function computeMatches(doc: string, options: SearchOptions): SearchResult {
  const { query, caseSensitive, regex } = options
  if (query === '') return EMPTY

  if (regex) {
    let re: RegExp
    try {
      // 必须带 g：非全局正则 exec 永远返回第一个匹配且不前进 lastIndex → 死循环
      re = new RegExp(query, `${caseSensitive ? '' : 'i'}g`)
    } catch {
      return { matches: [], invalid: true, truncated: false }
    }
    const matches: SearchMatch[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(doc)) !== null) {
      if (m[0].length === 0) {
        // 零长匹配：跳过并强制前移一位；零宽区间也无法高亮
        re.lastIndex += 1
        continue
      }
      matches.push({ from: m.index, to: m.index + m[0].length })
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return { matches, invalid: false, truncated: true }
      }
    }
    return { matches, invalid: false, truncated: false }
  }

  const haystack = caseSensitive ? doc : doc.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: SearchMatch[] = []
  let from = haystack.indexOf(needle)
  while (from !== -1) {
    matches.push({ from, to: from + needle.length })
    if (matches.length >= MAX_SEARCH_MATCHES) {
      return { matches, invalid: false, truncated: true }
    }
    // 步进至少 1 字符（空 query 已在入口拦掉，这里是防御性下限）
    from = haystack.indexOf(needle, from + Math.max(1, needle.length))
  }
  return { matches, invalid: false, truncated: false }
}
