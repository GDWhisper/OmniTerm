import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language'
import { tags } from '@lezer/highlight'
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
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
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

export function FileEditor({ content, editable, fileName, onChange, onSave }: FileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editableCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)

  // Keep refs up to date without causing re-renders
  onChangeRef.current = onChange
  onSaveRef.current = onSave

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
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editableCompartment.current.of(EditorView.editable.of(isEditable)),
        EditorView.lineWrapping,
      ]

      if (isEditable) {
        extensions.push(
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current?.(update.state.doc.toString())
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
          ]),
        )
      }

      return extensions
    },
    [fileName],
  )

  // Create the editor instance (mount once; editable/extensions trigger full recreation)
  useEffect(() => {
    if (!containerRef.current) return

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
    }

    init()

    return () => {
      cancelled = true
      view?.destroy()
      viewRef.current = null
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

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        overflow: 'hidden',
      }}
    />
  )
}
