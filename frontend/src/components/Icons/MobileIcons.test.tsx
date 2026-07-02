import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { IconSessions, IconTerminal, IconFiles } from './MobileIcons'

describe('MobileIcons', () => {
  it('IconSessions renders three horizontal lines', () => {
    const html = renderToString(<IconSessions />)
    expect(html).toContain('<line')
    expect(html).toContain('currentColor')
  })

  it('IconTerminal uses prompt shape', () => {
    const html = renderToString(<IconTerminal />)
    expect(html).toContain('<path')
    expect(html).toContain('currentColor')
  })

  it('IconFiles renders folder', () => {
    const html = renderToString(<IconFiles />)
    expect(html).toContain('<path')
    expect(html).toContain('currentColor')
  })
})
