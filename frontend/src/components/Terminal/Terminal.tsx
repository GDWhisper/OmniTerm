import { useRef, useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useTerminal } from '../../hooks/useTerminal'
import { useLongPress } from '../../hooks/useLongPress'
import { KeyboardIcon } from '../Icons/KeyboardIcon'
import { MobileKeyBar } from './MobileKeyBar'
import { READER_FONT } from '../../utils/fonts'
import { hapticTap } from '../../utils/haptics'
import { useKeyboardHeight, useIsLandscape } from '../../hooks/useMediaQuery'

/** Heuristic (plan D5): soft keyboards are >=260px tall, browser chrome
 *  shrinkage stays <=110px. Falls back to "closed" on odd WebViews. */
const KEYBOARD_OPEN_MIN_PX = 150

export function Terminal() {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeExternalSession = useAppStore((s) => s.activeExternalSession)
  const terminalDisconnected = useAppStore((s) => s.terminalDisconnected)
  const isMobile = useAppStore((s) => s.isMobile)
  const fontSize = useAppStore((s) => s.fontSize)
  const mobileFontSize = useAppStore((s) => s.mobileFontSize)
  const uiZoom = useAppStore((s) => s.uiZoom)
  // 会话引擎判别（D12 交互分流的依据）：external 会话无 DB id，返回
  // undefined，useTerminal 按 tmux 处理（external 是 tmux 专属能力）。
  // 选择器返回原始值，sessions 轮询整体替换不引发重渲染。
  const runtimeKind = useAppStore((s) => {
    const id = s.activeSessionId
    if (!id) return undefined
    for (const list of Object.values(s.sessions)) {
      const found = list.find((x) => x.id === id)
      if (found) return found.runtime_kind
    }
    return undefined
  })
  // xterm.js mouse-coordinate math does not account for CSS zoom, so text
  // selection drifts when the layout root is zoomed. The container below
  // applies the inverse zoom to bring the xterm subtree back to effective
  // zoom 1, and the font size is multiplied by the zoom factor instead —
  // visual size and the character grid stay identical.
  const zoomFactor = uiZoom / 100
  const effectiveFontSize = (isMobile ? mobileFontSize : fontSize) * zoomFactor

  const isLandscape = useIsLandscape()
  const { vvHeight, initialInnerHeight } = useKeyboardHeight()
  // Keyboard-open heuristic (plan D5, revised): detect the viewport shrinking
  // below its keyboard-free height instead of the innerHeight − vvHeight gap.
  // With `interactive-widget: resizes-content` (Android Chrome 108+) the
  // keyboard shrinks the layout viewport itself, making the gap collapse to 0;
  // iOS keeps resizes-visual where vvHeight still shrinks, so the comparison
  // works on both paths. Address-bar contraction stays ≤ ~110px < 150.
  const keyboardOpen = isMobile && vvHeight < initialInnerHeight - KEYBOARD_OPEN_MIN_PX
  const hideKeyBar = isLandscape && keyboardOpen

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
    sendData,
    scrollMode,
    sendScrollKeys,
    exitScrollMode,
    reconnect,
    refocusTextarea,
  } = useTerminal({
    sessionId: activeSessionId,
    externalSessionName: activeExternalSession,
    runtimeKind,
    fontSize: effectiveFontSize,
    latchModRef,
    onConsumeLatch: consumeLatch,
  })

  const hasSession = !!(activeSessionId || activeExternalSession)

  // Long-press paste menu (plan D6): clipboard read happens only on the
  // menu tap so it carries a user-gesture authorization context.
  const [pasteMenu, setPasteMenu] = useState<{ x: number; y: number } | null>(null)

  const handlePaste = useCallback(async () => {
    setPasteMenu(null)
    try {
      const text = await navigator.clipboard.readText()
      if (text && sendData) sendData(text)
    } catch {
      useToastStore.getState().addToast('error', t('terminal.pasteFailed'))
    }
  }, [sendData, t])

  // 长按手势统一走 useLongPress（D3）：终端 paste 菜单与聊天气泡动作菜单共用。
  const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = useLongPress({
    disabled: !isMobile,
    onLongPress: (p) => {
      hapticTap()
      // Clamp inside viewport: menu is ~120x44px.
      setPasteMenu({
        x: Math.min(p.x, window.innerWidth - 128),
        y: Math.max(8, p.y - 52),
      })
    },
  })

  // Initialize terminal on mount or when transitioning from empty state → active session.
  // Session switches (A→B) keep hasSession === true so the effect does not fire —
  // useTerminal handles WS reconnection internally.
  // When terminalDisconnected is true the terminal was torn down (blur/idle
  // disconnect or ws drop) — we must NOT auto-recreate it here, otherwise the
  // reconnect overlay would be immediately replaced. The user reconnects via
  // the overlay button, which calls initTerminal/connectWs explicitly.
  useEffect(() => {
    if (hasSession && containerRef.current && !terminalDisconnected) {
      const cleanup = initTerminal(containerRef.current)
      return cleanup
    }
  }, [hasSession, terminalDisconnected, initTerminal])

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
        // Exit tmux copy mode if active; exitScrollMode guards on the real
        // tmux state so this is a no-op when not scrolling.
        exitScrollMode?.()
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
      case 'Enter':
        sendData('\r')
        break
      case '^C':
        sendData('\x03')
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
        className="h-full flex flex-col"
        style={{ background: 'var(--bg-base)', color: 'var(--text-faint)', fontFamily: READER_FONT }}
      >
        <div className="panel-title-bar">
          <span>◆</span>
          <span>terminal</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
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
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
      <div className="panel-title-bar">
        <span>◆</span>
        <span>terminal</span>
        <span className="title-bar-spacer" />
        {hasSession && <span className="title-bar-badge">● LIVE</span>}
      </div>
      <div
        className="terminal-panel-pixel"
        style={{ flex: 1, minHeight: 0, position: 'relative' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div
          ref={containerRef}
          style={{
            // Percentage sizes resolve against the parent's visual size, so
            // 100% fills the panel regardless of the inverse zoom.
            zoom: 1 / zoomFactor,
            width: '100%',
            height: '100%',
            padding: 4 * zoomFactor,
          }}
        />
        {hasSession && terminalDisconnected && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(18, 20, 26, 0.85)',
            zIndex: 100,
          }}>
            <button
              onClick={() => reconnect(containerRef.current)}
              style={{
                padding: '8px 16px',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
              }}
            >
              重连
            </button>
          </div>
        )}
      </div>
      {/* Portal to body: inside the mobile pane strip, `position: fixed` would
          resolve against the strip's transform containing block and overflow
          the viewport (same regression class as Modal — see docs/dev/debug-guide.md). */}
      {pasteMenu &&
        createPortal(
          <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={() => setPasteMenu(null)}
            onTouchStart={() => setPasteMenu(null)}
          />
          <div
            className="pixel-float"
            style={{
              position: 'fixed',
              left: pasteMenu.x,
              top: pasteMenu.y,
              zIndex: 200,
              background: 'var(--bg-elevated)',
            }}
          >
            <button
              type="button"
              onClick={handlePaste}
              style={{
                padding: '10px 18px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                fontFamily: READER_FONT,
                fontSize: 13,
              }}
            >
              {t('terminal.paste')}
            </button>
          </div>
          </>,
          document.body,
        )}
      {isMobile && !hideKeyBar && (
        <MobileKeyBar
          latchMod={latchMod}
          onSetLatchMod={setLatchMod}
          onKey={handleKey}
          scrollMode={scrollMode ?? false}
          refocusTextarea={refocusTextarea}
          onToggleScrollMode={() => {
            if (scrollMode) {
              exitScrollMode?.()
            } else {
              // Actually enter tmux copy mode so the first arrow press pages.
              sendScrollKeys?.('up')
            }
          }}
        />
      )}
    </div>
  )
}
