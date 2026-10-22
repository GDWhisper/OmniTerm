import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatHoverTime } from '../../utils/formatTime'
import {
  searchSessionMessages,
  splitSnippet,
  type ChatSearchHit,
  type ChatSearchResponse,
} from '../../utils/chatSearch'

/**
 * 聊天面板内的会话内搜索条（F06）。
 *
 * 形态：**内联展开的浮层面板**（标题栏右侧，延迟展开），不是弹窗——聊天面板
 * 没有 header 插槽，弹窗会遮住消息且与 Modal 基座的 focus trap 欠账纠缠
 * （计划 D10）。视觉走 `.pixel-float`（2px 边框 + 4px 硬阴影，§6.1）。
 *
 * 交互口径：
 * - 输入 200ms 防抖（D12）：外部输入速率不受控，入口设防线。
 * - ↑↓ 选结果、Enter 跳转、Esc 关闭；IME 组合中不抢键（候选词确认不能被打断）。
 * - 结果行展示「时刻 + 命中片段」，命中词高亮（D13）。
 * - 状态行如实展示扫描预算的账（被截断 / 命中过多 / 关键词被丢）——**静默截断
 *   会让用户以为搜全了，比搜不到更糟**（计划 D4）。
 */

interface ChatSearchBarProps {
  sessionId: string
  /** 外部请求聚焦的信号（连续 Ctrl+F = 聚焦并全选，FileEditor 同款口径）。 */
  focusRequest?: number
  /** 命中被选中（回车 / 点击）：定位与高亮由 ChatView 负责。 */
  onJump: (hit: ChatSearchHit) => void
  /** 关闭搜索条（Esc / 关闭按钮）。 */
  onClose: () => void
}

/** 输入防抖（D12）：照 ChatInput 的 @ 引用搜索口径。 */
const SEARCH_DEBOUNCE_MS = 200

export function ChatSearchBar({ sessionId, focusRequest = 0, onJump, onClose }: ChatSearchBarProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ChatSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 打开即聚焦（Ctrl+F 之后可以直接打字）。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 再次请求聚焦（Ctrl+F 在搜索条已开着时再按）：聚焦并全选，键入直接替换旧查询。
  useEffect(() => {
    if (focusRequest === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  // 检索：查询词变化 → 防抖后发请求；新查询取消上一次在途请求（后到的旧响应
  // 不能覆盖新结果）。会话切换时组件会被 ChatView 收起，这里带上 sessionId
  // 作依赖即可让查询在换会话后重新发起。
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      abortRef.current?.abort()
      setResult(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = window.setTimeout(() => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      void searchSessionMessages(sessionId, q, controller.signal).then((res) => {
        if (controller.signal.aborted) return
        setResult(res)
        setSelected(0)
        setLoading(false)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, sessionId])

  // 卸载时取消在途请求（会话切换 / 关闭搜索条）。
  useEffect(() => () => abortRef.current?.abort(), [])

  const terms = useMemo(() => query.trim().split(/\s+/).filter(Boolean), [query])
  const hits = result?.hits ?? []

  const statusText = (() => {
    if (loading) return t('chat.search.searching')
    if (!query.trim()) return t('chat.search.hint')
    if (!result) return t('chat.search.failed')
    if (result.matchCount === 0) return t('chat.search.noResults')
    const parts = [t('chat.search.matchCount', { count: result.matchCount })]
    if (result.moreMatches) parts.push(t('chat.search.moreMatches', { count: hits.length }))
    if (result.truncated) parts.push(t('chat.search.truncated', { rows: result.scannedRows }))
    if (result.termsTruncated) parts.push(t('chat.search.termsTruncated'))
    return parts.join(' · ')
  })()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 输入法组合中（如中文候选词）：Enter / ↑↓ / Esc 归 IME 消费。
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(0, hits.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[selected]
      if (hit) onJump(hit)
    }
  }

  return (
    <div className="chat-search pixel-float">
      <div className="chat-search-input-row">
        <span className="chat-search-icon" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className="chat-search-input"
          placeholder={t('chat.search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="chat-search-close"
          onClick={onClose}
          title={t('chat.search.close')}
          aria-label={t('chat.search.close')}
        >
          ✕
        </button>
      </div>
      {hits.length > 0 && (
        <div className="chat-search-results">
          {hits.map((hit, index) => (
            <button
              type="button"
              key={hit.id}
              className={`chat-search-hit${index === selected ? ' is-selected' : ''}`}
              onClick={() => onJump(hit)}
              onMouseEnter={() => setSelected(index)}
            >
              <span className="chat-search-hit-time">
                {formatHoverTime(new Date(hit.createdAt).getTime())}
              </span>
              <span className="chat-search-hit-snippet">
                {splitSnippet(hit.snippet, terms).map((seg, i) =>
                  seg.hit ? (
                    <mark key={i} className="chat-search-mark">
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-search-status">{statusText}</div>
    </div>
  )
}
