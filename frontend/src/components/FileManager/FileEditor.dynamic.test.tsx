import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { FileEditor } from './FileEditor'

const SUPPORTED_FILES = [
  'app.js',
  'app.ts',
  'script.py',
  'data.json',
  'page.html',
  'style.css',
  'readme.md',
  'config.yaml',
  'query.sql',
  'main.go',
  'Main.java',
  'lib.cpp',
  'index.php',
]

function renderEditor(fileName: string, content: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<FileEditor content={content} editable={false} fileName={fileName} />)
  return { container, root }
}

describe('FileEditor dynamic language loading', () => {
  it.each(SUPPORTED_FILES)('renders editor for %s', async (fileName) => {
    const { container, root } = renderEditor(fileName, `// sample content for ${fileName}`)

    await vi.waitFor(
      () => {
        expect(container.querySelector('.cm-editor')).toBeTruthy()
      },
      { timeout: 3000 },
    )

    root.unmount()
    document.body.removeChild(container)
  })
})
