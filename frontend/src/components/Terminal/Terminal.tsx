import { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useTerminal } from '../../hooks/useTerminal'
import { KeyboardIcon } from '../Icons/KeyboardIcon'
import { MobileKeyBar } from './MobileKeyBar'

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

  // MobileKeyBar modifier latch: tracks which modifier (Ctrl/Shift/Alt) is
  // currently active. Lifted here so useTerminal can intercept keyboard input
  // when a modifier is latched.
  const [latchMod, setLatchMod] = useState<string | null>(null)
  const latchModRef = useRef<string | null>(null)
  // Keep ref in sync with state so useTerminal's term.onData closure can read
  // the current latch without stale closures.
  useEffect(() => { latchModRef.current = latchMod }, [latchMod])

  // Called by useTerminal when a latched modifier is consumed by keyboard input
  const consumeLatch = useCallback(() => setLatchMod(null), [])

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
    latchModRef,
    onConsumeLatch: consumeLatch,
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

    // Combo keys: modifier latch from MobileKeyBar (e.g. 'Shift+Tab', 'Ctrl+↑')
    const comboMatch = name.match(/^(Shift|Ctrl|Alt)\+(\S+)$/)
    if (comboMatch) {
      const [, mod, key] = comboMatch
      switch (`${mod}+${key}`) {
        case 'Shift+Tab':
          sendData('\x1b[Z')
          break
        case 'Shift+↑':
          sendData('\x1b[1;2A')
          break
        case 'Shift+↓':
          sendData('\x1b[1;2B')
          break
        case 'Shift+→':
          sendData('\x1b[1;2C')
          break
        case 'Shift+←':
          sendData('\x1b[1;2D')
          break
        case 'Shift+PgUp':
          sendData('\x1b[5;2~')
          break
        case 'Shift+PgDn':
          sendData('\x1b[6;2~')
          break
        case 'Shift+Del':
          sendData('\x1b[3;2~')
          break
        case 'Shift+Home':
          sendData('\x1b[1;2H')
          break
        case 'Shift+End':
          sendData('\x1b[1;2F')
          break
        case 'Ctrl+↑':
          sendData('\x1b[1;5A')
          break
        case 'Ctrl+↓':
          sendData('\x1b[1;5B')
          break
        case 'Ctrl+→':
          sendData('\x1b[1;5C')
          break
        case 'Ctrl+←':
          sendData('\x1b[1;5D')
          break
        case 'Ctrl+Tab':
          sendData('\t')
          break
        case 'Ctrl+PgUp':
          sendData('\x1b[5;5~')
          break
        case 'Ctrl+PgDn':
          sendData('\x1b[6;5~')
          break
        case 'Ctrl+Del':
          sendData('\x1b[3;5~')
          break
        case 'Ctrl+Home':
          sendData('\x1b[1;5H')
          break
        case 'Ctrl+End':
          sendData('\x1b[1;5F')
          break
        case 'Alt+Tab':
          sendData('\x1b\t')
          break
        case 'Alt+↑':
          sendData('\x1b[1;3A')
          break
        case 'Alt+↓':
          sendData('\x1b[1;3B')
          break
        case 'Alt+→':
          sendData('\x1b[1;3C')
          break
        case 'Alt+←':
          sendData('\x1b[1;3D')
          break
        case 'Alt+Esc':
          sendData('\x1b\x1b')
          break
        case 'Alt+PgUp':
          sendData('\x1b[5;3~')
          break
        case 'Alt+PgDn':
          sendData('\x1b[6;3~')
          break
        case 'Alt+Del':
          sendData('\x1b[3;3~')
          break
        case 'Alt+Home':
          sendData('\x1b[1;3H')
          break
        case 'Alt+End':
          sendData('\x1b[1;3F')
          break
      }
      return
    }

    switch (name) {
      case 'Esc':
        sendData('\x1b')
        if (scrollMode) exitScrollMode?.()
        break
      case 'Tab':
        sendData('\t')
        break
      case 'PgUp':
        sendData('\x1b[5~')
        break
      case 'PgDn':
        sendData('\x1b[6~')
        break
      case 'Del':
        sendData('\x1b[3~')
        break
      case 'Home':
        sendData('\x1b[H')
        break
      case 'End':
        sendData('\x1b[F')
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
          latchMod={latchMod}
          onSetLatchMod={setLatchMod}
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
