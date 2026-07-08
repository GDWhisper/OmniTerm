import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

describe('Terminal mobile', () => {
  it('renders empty state when no active session', async () => {
    i18n.changeLanguage('zh')
    useAppStore.setState({ isMobile: true, activeSessionId: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <AttentionProvider>
          <Terminal />
        </AttentionProvider>
      </I18nextProvider>
    )
    await vi.waitFor(() => {
      expect(container.textContent).toContain('选择或创建一个会话')
    })
    root.unmount()
    document.body.removeChild(container)
  })
})
