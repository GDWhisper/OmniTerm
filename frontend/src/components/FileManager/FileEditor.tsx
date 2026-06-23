import { useEffect, useRef, useCallback } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { oneDark } from '@codemirror/theme-one-dark'
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

/** OmniTerm-themed syntax highlighting that complements one-dark */
const omnitermHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#a78bfa' },
  { tag: tags.string, color: '#4ade80' },
  { tag: tags.comment, color: '#64748b', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#c4b5fd' },
  { tag: tags.number, color: '#f59e0b' },
  { tag: tags.bool, color: '#f59e0b' },
  { tag: tags.null, color: '#f59e0b' },
  { tag: tags.operator, color: '#94a3b8' },
  { tag: tags.className, color: '#c4b5fd' },
  { tag: tags.typeName, color: '#c4b5fd' },
  { tag: tags.propertyName, color: '#e2e8f0' },
  { tag: tags.definition(tags.variableName), color: '#c4b5fd' },
  { tag: tags.variableName, color: '#e2e8f0' },
  { tag: tags.punctuation, color: '#94a3b8' },
  { tag: tags.bracket, color: '#94a3b8' },
  { tag: tags.tagName, color: '#a78bfa' },
  { tag: tags.attributeName, color: '#c4b5fd' },
  { tag: tags.attributeValue, color: '#4ade80' },
  { tag: tags.heading, color: '#a78bfa', fontWeight: 'bold' },
  { tag: tags.meta, color: '#64748b' },
])

/** OmniTerm editor theme (colors from UI style guide) */
const omnitermTheme = EditorView.theme({
  '&': {
    backgroundColor: '#0a0a0f',
    color: '#e2e8f0',
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
  },
  '.cm-content': {
    caretColor: '#a78bfa',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#a78bfa',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(167, 139, 250, 0.2)',
  },
  '.cm-activeLine': {
    backgroundColor: '#111827',
  },
  '.cm-gutters': {
    backgroundColor: '#0a0a0f',
    color: '#475569',
    border: 'none',
    borderRight: '1px solid #1e293b',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#111827',
    color: '#94a3b8',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#1e293b',
    color: '#94a3b8',
    border: '1px solid #334155',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(167, 139, 250, 0.15)',
    outline: '1px solid rgba(167, 139, 250, 0.3)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(245, 158, 11, 0.4)',
  },
  // Scrollbar styling (matches FileManager scrollbar)
  '& .cm-scroller::-webkit-scrollbar': {
    width: '8px',
    height: '8px',
  },
  '& .cm-scroller::-webkit-scrollbar-track': {
    background: '#0a0a0f',
  },
  '& .cm-scroller::-webkit-scrollbar-thumb': {
    background: '#334155',
    borderRadius: '4px',
  },
  '& .cm-scroller::-webkit-scrollbar-thumb:hover': {
    background: '#a78bfa',
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
        oneDark,
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
