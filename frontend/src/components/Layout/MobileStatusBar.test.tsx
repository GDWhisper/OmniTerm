import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { MobileStatusBar } from './MobileStatusBar'

describe('MobileStatusBar', () => {
  it('renders online status and session name', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <MobileStatusBar connected sessionName="api-server" onSessionClick={vi.fn()} onNewSession={vi.fn()} />
      </I18nextProvider>
    )
    await vi.waitFor(() => {
      expect(container.textContent).toContain('api-server')
    })
    // Check status dot exists
    expect(container.querySelector('span')?.textContent).toContain('●')
    root.unmount()
    document.body.removeChild(container)
  })
})
