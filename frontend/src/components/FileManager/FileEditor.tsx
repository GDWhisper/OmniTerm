import { useEffect, useRef, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { READER_FONT } from '../../utils/fonts'
import { IconSearch, IconArrowUp, IconArrowDown, IconX } from './icons'
import { computeMatches, type SearchMatch } from './fileSearch'
interface FileEditorProps {
  /** File content */
  content: string
  /** Whether the editor is editable (false = read-only preview) */
  editable: boolean
  /** File name (used for language detection) */
  fileName: string
  /** Called when content changes in edit mode */
  onChange?: (content: string) => void
  /** Called when Ctrl+S / Cmd+S is pressed */
  onSave?: () => void
  /**
   * 搜索面板开合（受控）。触发按钮在 FileDrawer 顶栏，编辑器内的 Ctrl/Cmd+F
   * 也走同一条通道打开；查询串与匹配区间由本组件自持（卸载即重置）。
   */
  searchOpen?: boolean
  /** 搜索面板开合变更（顶栏按钮 / Esc / Ctrl+F 关闭时回调） */
  onSearchOpenChange?: (open: boolean) => void
}

/** OmniTerm-themed syntax highlighting — uses CSS vars for theme support */
const omnitermHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--success)' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: 'var(--accent-bright)' },
  { tag: tags.number, color: 'var(--warning)' },
  { tag: tags.bool, color: 'var(--warning)' },
  { tag: tags.null, color: 'var(--warning)' },
  { tag: tags.operator, color: 'var(--text-muted)' },
  { tag: tags.className, color: 'var(--accent-bright)' },
  { tag: tags.typeName, color: 'var(--accent-bright)' },
  { tag: tags.propertyName, color: 'var(--text-primary)' },
  { tag: tags.definition(tags.variableName), color: 'var(--accent-bright)' },
  { tag: tags.variableName, color: 'var(--text-primary)' },
  { tag: tags.punctuation, color: 'var(--text-muted)' },
  { tag: tags.bracket, color: 'var(--text-muted)' },
  { tag: tags.tagName, color: 'var(--accent)' },
  { tag: tags.attributeName, color: 'var(--accent-bright)' },
  { tag: tags.attributeValue, color: 'var(--success)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: 'bold' },
  { tag: tags.meta, color: 'var(--text-faint)' },
])

/** OmniTerm editor theme — uses CSS vars for theme support */
const omnitermTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontFamily: READER_FONT,
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-14)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--bg-elevated)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-dim)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-muted)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border-strong)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--accent-14)',
    outline: '1px solid var(--accent-10)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(255, 166, 87, 0.2)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(255, 166, 87, 0.4)',
  },
  // Scrollbar styling (matches FileManager scrollbar exactly)
  '& .cm-scroller::-webkit-scrollbar': {
    width: '8px',
    height: '8px',
  },
  '& .cm-scroller::-webkit-scrollbar-track': {
    background: 'var(--scrollbar-track)',
  },
  '& .cm-scroller::-webkit-scrollbar-thumb': {
    background: 'var(--scrollbar-thumb)',
    borderRadius: '2px',
  },
  '& .cm-scroller::-webkit-scrollbar-thumb:hover': {
    background: 'var(--accent)',
  },
  '& .cm-scroller': {
    scrollbarColor: 'var(--scrollbar-thumb) var(--scrollbar-track)',
    scrollbarWidth: 'thin',
  },
})

type LangLoader = () => Promise<Extension>

/**
 * 搜索高亮装饰：类名复用上方 omnitermTheme 里已定义配色的
 * `.cm-searchMatch` / `.cm-searchMatch-selected`（选中档提亮一档）。
 * 匹配计算在 React 侧（fileSearch.ts 纯函数），结果经 effect 灌进这个字段。
 */
const searchMatchMark = Decoration.mark({ class: 'cm-searchMatch' })
const searchMatchSelectedMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' })

const setSearchDecorations = StateEffect.define<DecorationSet>()

/** 只承载装饰集合的 StateField：随文档变更 map 位置，由 setSearchDecorations 整体替换 */
const searchDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, tr) => {
    let next = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSearchDecorations)) next = effect.value
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const langLoaders: Record<string, LangLoader> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  mts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  cts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  pyw: () => import('@codemirror/lang-python').then((m) => m.python()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  jsonl: () => import('@codemirror/lang-json').then((m) => m.json()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  less: () => import('@codemirror/lang-css').then((m) => m.css()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cxx: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hxx: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
}

/** Detect language from file extension and load it on demand */
async function getLanguageExtension(fileName: string): Promise<Extension> {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const loader = langLoaders[ext]
  if (!loader) return []
  try {
    return await loader()
  } catch {
    return []
  }
}

export function FileEditor({ content, editable, fileName, onChange, onSave, searchOpen = false, onSearchOpenChange }: FileEditorProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editableCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const currentFilePathRef = useRef(fileName)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchOpenRef = useRef(searchOpen)
  const onSearchOpenChangeRef = useRef(onSearchOpenChange)

  // 搜索状态：查询串在 React（受控输入），匹配区间经 effect 同步进 CodeMirror 装饰
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [invalidRegex, setInvalidRegex] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [current, setCurrent] = useState(0)
  // 文档版本号：编辑会让所有匹配区间失效，靠它触发重算（updateListener 里自增）
  const [docVersion, setDocVersion] = useState(0)
  // 已滚动定位到的匹配下标：区分「用户翻匹配」与「打字引起的重算」，避免打字被滚动打断
  const scrolledIndexRef = useRef(-1)
  // 上一次参与计算的查询参数：查询串本身变化时回到第一个匹配
  const lastParamsRef = useRef({ query: '', caseSensitive: false, useRegex: false })

  // Keep refs up to date without causing re-renders
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  searchOpenRef.current = searchOpen
  onSearchOpenChangeRef.current = onSearchOpenChange

  const createExtensions = useCallback(
    (isEditable: boolean) => {
      const extensions = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        foldGutter(),
        omnitermTheme,
        syntaxHighlighting(omnitermHighlight),
        searchDecorationField,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editableCompartment.current.of(EditorView.editable.of(isEditable)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString())
            // 面板开着时编辑会让全部匹配区间失效：自增版本号触发重算（关闭时不白算）
            if (searchOpenRef.current) setDocVersion((v) => v + 1)
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current?.()
              return true
            },
          },
          {
            // Esc 收起搜索面板并把焦点还给编辑器（面板开着才有语义）
            key: 'Escape',
            run: () => {
              if (!searchOpenRef.current) return false
              onSearchOpenChangeRef.current?.(false)
              viewRef.current?.focus()
              return true
            },
          },
        ]),
      ]

      return extensions
    },
    [fileName],
  )

  // Create the editor instance; reconfigure in-place on mode toggle (preserves scroll).
  // Cleanup preserves the view on same-file re-runs (React Strict Mode) — only destroys
  // on file change. This ensures the reconfigure path sees the existing view.
  useEffect(() => {
    if (!containerRef.current) return

    const fileChanged = currentFilePathRef.current !== fileName
    currentFilePathRef.current = fileName

    if (fileChanged) {
      // File changed — destroy old view, fall through to create a new one
      viewRef.current?.destroy()
      viewRef.current = null
    }

    if (viewRef.current) {
      // Same file, mode toggle — reconfigure compartment in-place (preserves scroll)
      const view = viewRef.current
      const savedScroll = view.scrollDOM.scrollTop
      view.dispatch({
        effects: editableCompartment.current.reconfigure(EditorView.editable.of(editable)),
      })
      // Restore scroll in case the browser auto-scrolled on contenteditable change
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = savedScroll
      })
      return
    }

    // New file or first mount — create the editor
    let view: EditorView | null = null
    let cancelled = false

    const init = async () => {
      const langExt = await getLanguageExtension(fileName)
      if (cancelled || !containerRef.current) return

      const state = EditorState.create({
        doc: content,
        extensions: [...createExtensions(editable), langExt],
      })

      view = new EditorView({
        state,
        parent: containerRef.current,
      })

      viewRef.current = view
      // 搜索面板可能在视图创建前就已打开（点得比语言加载还快）：推版本号
      // 让搜索 effect 补跑一次，否则面板开着但没有任何高亮
      setDocVersion((v) => v + 1)
    }

    init()

    return () => {
      cancelled = true
      // Only destroy on file change or unmount — NOT on same-file re-runs (Strict Mode).
      // Leave viewRef.current intact so the next setup reconfigures instead of recreating.
      if (fileChanged) {
        view?.destroy()
        viewRef.current = null
      }
    }
  }, [editable, createExtensions, fileName]) // NOTE: content intentionally omitted — editor manages its own state

  // Sync external content changes into the editor (e.g. file reload, mode toggle, save).
  // Internal edits (typing) are no-ops because the editor's doc already matches the prop.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentDoc = view.state.doc.toString()
    if (content !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      })
    }
  }, [content])

  // Ctrl/Cmd+F 在编辑器容器捕获阶段拦截：CodeMirror 的 contenteditable 会放行
  // 浏览器内置查找（整页搜索、不认折行、焦点跑到终端里去），这里换成打开抽屉内
  // 搜索面板。捕获阶段 + 挂在容器上 = 焦点在编辑器或面板输入框里都能拦到。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      e.stopPropagation()
      if (searchOpenRef.current) {
        // 已开着：不关，聚焦并全选（连续 Ctrl+F = 改查下一项）
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      } else {
        onSearchOpenChangeRef.current?.(true)
      }
    }
    container.addEventListener('keydown', onKeyDown, true)
    return () => container.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 面板打开即聚焦输入框并全选：Ctrl+F 之后的键入直接替换旧查询
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
  }, [searchOpen])

  // 查询 / 开关 / 文档版本变化 → 重算匹配 → 灌装饰；查询串本身变化时回到第一个匹配
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    if (!searchOpen || query === '') {
      view.dispatch({ effects: setSearchDecorations.of(Decoration.none) })
      scrolledIndexRef.current = -1
      setMatches([])
      setInvalidRegex(false)
      setTruncated(false)
      setCurrent(0)
      return
    }

    const params = { query, caseSensitive, useRegex }
    const paramsChanged =
      lastParamsRef.current.query !== query ||
      lastParamsRef.current.caseSensitive !== caseSensitive ||
      lastParamsRef.current.useRegex !== useRegex
    lastParamsRef.current = params

    const result = computeMatches(view.state.doc.toString(), {
      query,
      caseSensitive,
      regex: useRegex,
    })
    const index = result.matches.length === 0
      ? 0
      : paramsChanged ? 0 : Math.min(current, result.matches.length - 1)
    view.dispatch({
      effects: setSearchDecorations.of(
        Decoration.set(
          result.matches.map((m, i) =>
            (i === index ? searchMatchSelectedMark : searchMatchMark).range(m.from, m.to),
          ),
          true,
        ),
      ),
    })

    // 只在「翻匹配 / 查询变化」时滚动定位：打字引起的重算不抢用户光标位置
    if (result.matches.length > 0 && scrolledIndexRef.current !== index) {
      scrolledIndexRef.current = index
      view.dispatch({ effects: EditorView.scrollIntoView(result.matches[index].from) })
    }

    setMatches(result.matches)
    setInvalidRegex(result.invalid)
    setTruncated(result.truncated)
    if (index !== current) setCurrent(index)
  }, [query, caseSensitive, useRegex, searchOpen, docVersion, current])

  // 上一个 / 下一个匹配（回车在输入框里同一通道，面板按钮共用）
  const goToMatch = (delta: number) => {
    if (matches.length === 0) return
    const base = Math.min(Math.max(current, 0), matches.length - 1)
    setCurrent((base + delta + matches.length) % matches.length)
  }

  const closeSearch = () => {
    onSearchOpenChange?.(false)
    viewRef.current?.focus()
  }

  const searchCountLabel = query === ''
    ? ''
    : invalidRegex
      ? t('drawer.searchInvalidRegex')
      : matches.length === 0
        ? t('drawer.searchNoResults')
        : t('drawer.searchCount', {
            current: current + 1,
            total: truncated ? `${matches.length}+` : matches.length,
          })

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {searchOpen && (
        <div className="fm-editor-search pixel-float">
          <span className="fm-editor-search-icon">
            <IconSearch width={13} height={13} />
          </span>
          <input
            ref={searchInputRef}
            className="fm-editor-search-input"
            placeholder={t('drawer.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                goToMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={`fm-editor-search-toggle${caseSensitive ? ' active' : ''}`}
            onClick={() => setCaseSensitive((v) => !v)}
            // 工具栏按钮不抢输入框焦点：点完继续打字（鼠标焦点被 preventDefault 吃掉，Tab 仍可达）
            onMouseDown={(e) => e.preventDefault()}
            title={t('drawer.searchCaseSensitive')}
            aria-label={t('drawer.searchCaseSensitive')}
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
          <button
            type="button"
            className={`fm-editor-search-toggle${useRegex ? ' active' : ''}`}
            onClick={() => setUseRegex((v) => !v)}
            onMouseDown={(e) => e.preventDefault()}
            title={t('drawer.searchRegex')}
            aria-label={t('drawer.searchRegex')}
            aria-pressed={useRegex}
          >
            .*
          </button>
          <span className="fm-editor-search-count">{searchCountLabel}</span>
          <button
            type="button"
            className="fm-editor-search-btn"
            onClick={() => goToMatch(-1)}
            onMouseDown={(e) => e.preventDefault()}
            disabled={matches.length === 0}
            title={t('drawer.searchPrev')}
            aria-label={t('drawer.searchPrev')}
          >
            <IconArrowUp width={13} height={13} />
          </button>
          <button
            type="button"
            className="fm-editor-search-btn"
            onClick={() => goToMatch(1)}
            onMouseDown={(e) => e.preventDefault()}
            disabled={matches.length === 0}
            title={t('drawer.searchNext')}
            aria-label={t('drawer.searchNext')}
          >
            <IconArrowDown width={13} height={13} />
          </button>
          <button
            type="button"
            className="fm-editor-search-btn"
            onClick={closeSearch}
            onMouseDown={(e) => e.preventDefault()}
            title={t('drawer.searchClose')}
            aria-label={t('drawer.searchClose')}
          >
            <IconX width={13} height={13} />
          </button>
        </div>
      )}
    </div>
  )
}
