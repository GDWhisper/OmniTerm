import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { php } from '@codemirror/lang-php'

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
  { tag: tags.number, color: '#f59e0b' },
  { tag: tags.bool, color: '#f59e0b' },
  { tag: tags.null, color: '#f59e0b' },
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
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(245, 158, 11, 0.4)',
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

/** Detect language from file extension */
function getLanguageExtension(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true })
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return javascript({ jsx: true, typescript: true })
    case 'py':
    case 'pyw':
      return python()
    case 'rs':
      return rust()
    case 'json':
    case 'jsonl':
      return json()
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'md':
    case 'markdown':
      return markdown()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'sql':
      return sql()
    case 'go':
      return go()
    case 'java':
      return java()
    case 'c':
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'hxx':
      return cpp()
    case 'php':
      return php()
    default:
      return [] // no language support — plain text
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
        getLanguageExtension(fileName),
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

  // Create the editor instance
  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: content,
      extensions: createExtensions(editable),
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [content, editable, createExtensions])

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
