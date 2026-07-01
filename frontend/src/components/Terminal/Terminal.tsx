import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useTerminal } from '../../hooks/useTerminal'
import { KeyboardIcon } from '../Icons/KeyboardIcon'
import { MobileKeyBar } from './MobileKeyBar'
import { useToastStore } from '../../stores/toastStore'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

export function Terminal() {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeExternalSession = useAppStore((s) => s.activeExternalSession)
  const isMobile = useAppStore((s) => s.isMobile)
  const fontSize = useAppStore((s) => s.fontSize)
  const mobileFontSize = useAppStore((s) => s.mobileFontSize)
  const effectiveFontSize = isMobile ? mobileFontSize : fontSize
  const addToast = useToastStore((s) => s.addToast)

  const {
    initTerminal,
    terminal,
    sendData,
    scrollMode,
    setScrollMode,
    sendScrollKeys,
    exitScrollMode,
  } = useTerminal({
    sessionId: activeSessionId,
    externalSessionName: activeExternalSession,
    fontSize: effectiveFontSize,
  })

  const hasSession = !!(activeSessionId || activeExternalSession)

  // Initialize terminal on mount or when transitioning from empty state → active session.
  // Session switches (A→B) keep hasSession === true so the effect does not fire —
  // useTerminal handles WS reconnection internally.
  useEffect(() => {
    if (hasSession && containerRef.current) {
      const cleanup = initTerminal(containerRef.current)
      return cleanup
    }
  }, [hasSession, initTerminal])

  const handleKey = (name: string) => {
    if (!sendData) return
    switch (name) {
      case 'Ctrl':
        // Mobile keybar doesn't have a persistent combo mode; instead we send
        // the most common Ctrl sequence directly. A future iteration can add
        // a combo latch if needed.
        sendData('\x00')
        break
      case 'Esc':
        sendData('\x1b')
        if (scrollMode) exitScrollMode?.()
        break
      case 'Tab':
        sendData('\t')
        break
      case '←':
        sendData('\x1b[D')
        break
      case '→':
        sendData('\x1b[C')
        break
      case '↑':
        if (isMobile && scrollMode && sendScrollKeys) {
          sendScrollKeys('up')
        } else {
          sendData('\x1b[A')
        }
        break
      case '↓':
        if (isMobile && scrollMode && sendScrollKeys) {
          sendScrollKeys('down')
        } else {
          sendData('\x1b[B')
        }
        break
      case '复制': {
        const selection = terminal?.getSelection() || ''
        if (selection) {
          navigator.clipboard.writeText(selection).then(
            () => addToast('success', t('terminal.copySuccess')),
            () => {},
          )
        }
        break
      }
      case '粘贴':
        navigator.clipboard.readText().then((text) => sendData(text)).catch(() => {})
        break
    }
  }

  if (!activeSessionId && !activeExternalSession) {
    return (
      <div
        className="h-full flex items-center justify-center"
        style={{ background: 'var(--bg-base)', color: 'var(--text-faint)', fontFamily: FONT }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginBottom: 16,
              color: 'var(--accent)',
              filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))',
            }}
          >
            <KeyboardIcon size={40} />
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>{t('terminal.noSession')}</div>
          <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text-dim)' }}>
            {t('terminal.hint')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
      <div ref={containerRef} className="h-full w-full p-1" style={{ flex: 1, minHeight: 0 }} />
      {isMobile && (
        <MobileKeyBar
          onKey={handleKey}
          scrollMode={scrollMode ?? false}
          onToggleScrollMode={() => {
            if (scrollMode) {
              exitScrollMode?.()
            } else {
              setScrollMode?.(true)
            }
          }}
        />
      )}
    </div>
  )
}
