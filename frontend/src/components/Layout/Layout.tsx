import { useRef, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, type AppState } from '../../stores/appStore'
import { Sidebar } from '../Sidebar/Sidebar'
import { Terminal } from '../Terminal/Terminal'
import { ChatView } from '../Chat/ChatView'
import { AcpConnectionManager } from '../Chat/AcpConnectionManager'
import { RightPanel } from '../RightPanel/RightPanel'
import { SettingsPopup } from '../Settings/SettingsPopup'
import { TmuxCheatsheetPopup } from '../TmuxCheatsheet/TmuxCheatsheetPopup'
import { MobileNav } from './MobileNav'
import { MobileStatusBar } from './MobileStatusBar'
import { useKeyboardHeight } from '../../hooks/useMediaQuery'

/**
 * Pick the right pane for the active session: ChatView for ACP-backed
 * sessions, Terminal for tmux (and the null-session empty state). The
 * wrapper key in the callers forces a full remount when the active
 * session changes, so each view's WebSocket lifecycle resets cleanly.
 */
function SessionView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession = activeSessionId
    ? Object.values(sessions).flat().find((s) => s.id === activeSessionId)
    : null

  if (activeSession?.runtime_kind === 'acp') return <ChatView />

  // If we know a session is active but haven't received its row yet, don't
  // render Terminal — doing so would open a tmux WS to a session that may
  // actually be ACP-backed. Wait one render cycle for loadSessions().
  if (activeSessionId && !activeSession) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-faint)',
          fontFamily: 'var(--reader-font, ui-monospace, monospace)',
          fontSize: 13,
        }}
      >
        loading session…
      </div>
    )
  }

  return <Terminal />
}

export function Layout() {
  const [isDragging, setIsDragging] = useState(false)
  const {
    isMobile,
    sidebarOpen,
    sidebarCollapsed,
    settingsOpen,
    tmuxCheatsheetOpen,
    fileManagerOpen,
    fileManagerCollapsed,
    sidebarWidth,
    fileManagerWidth,
    activeSessionId,
    setSidebarWidth,
    setFileManagerWidth,
    crtScanlines,
    uiZoom,
  } = useAppStore()

  const layoutRef = useRef<HTMLDivElement>(null)

  // Shared drag-teardown: remove all mouse+touch listeners and reset body styles
  const cleanUpDrag = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setIsDragging(false)
  }, [])

  // Drag resize handlers (mouse + touch)
  const handleSidebarDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const startX = clientX
      const startWidth = sidebarWidth
      const maxSidebar = Math.floor(window.innerWidth / 3)
      setIsDragging(true)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        ev.preventDefault()
        const mvX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
        const delta = mvX - startX
        const newWidth = Math.max(140, Math.min(maxSidebar, startWidth + delta))
        setSidebarWidth(newWidth)
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
        cleanUpDrag()
        localStorage.setItem('omniterm_sidebar_width', String(useAppStore.getState().sidebarWidth))
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove, { passive: false })
      document.addEventListener('touchend', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth, setSidebarWidth, cleanUpDrag]
  )

  const handleFileManagerDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const startX = clientX
      const startWidth = fileManagerWidth
      const maxFileManager = Math.floor(window.innerWidth / 2)
      setIsDragging(true)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        ev.preventDefault()
        const mvX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
        const delta = startX - mvX
        const newWidth = Math.max(240, Math.min(maxFileManager, startWidth + delta))
        setFileManagerWidth(newWidth)
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
        cleanUpDrag()
        localStorage.setItem('omniterm_fm_width', String(useAppStore.getState().fileManagerWidth))
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove, { passive: false })
      document.addEventListener('touchend', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [fileManagerWidth, setFileManagerWidth, cleanUpDrag]
  )

  return (
    <>
      {/* Persistent ACP connections — rendered once outside the layout branch
          so WS connections survive mobile↔desktop switches. */}
      <AcpConnectionManager />
      {isMobile ? <MobileLayout /> : <DesktopLayout
        isDragging={isDragging}
        layoutRef={layoutRef}
        sidebarOpen={sidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        fileManagerOpen={fileManagerOpen}
        fileManagerCollapsed={fileManagerCollapsed}
        fileManagerWidth={fileManagerWidth}
        activeSessionId={activeSessionId}
        crtScanlines={crtScanlines}
        uiZoom={uiZoom}
        settingsOpen={settingsOpen}
        tmuxCheatsheetOpen={tmuxCheatsheetOpen}
        onSidebarDrag={handleSidebarDrag}
        onFileManagerDrag={handleFileManagerDrag}
      />}
    </>
  )
}

interface DesktopLayoutProps {
  isDragging: boolean
  layoutRef: React.RefObject<HTMLDivElement | null>
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  sidebarWidth: number
  fileManagerOpen: boolean
  fileManagerCollapsed: boolean
  fileManagerWidth: number
  activeSessionId: string | null
  crtScanlines: boolean
  uiZoom: number
  settingsOpen: boolean
  tmuxCheatsheetOpen: boolean
  onSidebarDrag: (e: React.MouseEvent | React.TouchEvent) => void
  onFileManagerDrag: (e: React.MouseEvent | React.TouchEvent) => void
}

function DesktopLayout({
  isDragging,
  layoutRef,
  sidebarOpen,
  sidebarCollapsed,
  sidebarWidth,
  fileManagerOpen,
  fileManagerCollapsed,
  fileManagerWidth,
  activeSessionId,
  crtScanlines,
  uiZoom,
  settingsOpen,
  tmuxCheatsheetOpen,
  onSidebarDrag,
  onFileManagerDrag,
}: DesktopLayoutProps) {
  return (
    <>
      <div
        ref={layoutRef}
        className="flex"
        style={{ zoom: uiZoom / 100, height: `calc(100dvh / ${uiZoom / 100})`, background: 'var(--bg-base)', color: 'var(--text-primary)' } as React.CSSProperties}
      >
        <div
          className="flex"
          style={{ width: '100%', height: '100%', minWidth: 0 }}
        >
          {sidebarOpen && (
            <div
              className="flex-shrink-0"
              style={{
                width: sidebarCollapsed ? 40 : sidebarWidth,
                overflow: 'hidden',
                background: 'var(--bg-base)',
                borderRight: '1px solid var(--border-subtle)',
                transition: isDragging ? 'none' : 'width 0.2s ease',
              }}
            >
              <Sidebar />
            </div>
          )}

          {sidebarOpen && !sidebarCollapsed && (
            <div
              className="omniterm-drag-bar omniterm-drag-bar-v"
              onMouseDown={onSidebarDrag}
              onTouchStart={onSidebarDrag}
            />
          )}

          <div className="flex-1 min-w-0">
            <SessionView key={activeSessionId ?? 'empty'} />
          </div>

          {fileManagerOpen && !fileManagerCollapsed && (
            <div
              className="omniterm-drag-bar omniterm-drag-bar-v"
              onMouseDown={onFileManagerDrag}
              onTouchStart={onFileManagerDrag}
            />
          )}

          {fileManagerOpen && (
            <div
              className="flex-shrink-0 overflow-hidden"
              style={{
                width: fileManagerCollapsed ? 40 : fileManagerWidth,
                background: 'var(--bg-base)',
                borderLeft: fileManagerCollapsed ? '1px solid var(--border-subtle)' : undefined,
                transition: isDragging ? 'none' : 'width 0.2s ease',
              }}
            >
              <RightPanel />
            </div>
          )}
        </div>
      </div>

      {settingsOpen && <SettingsPopup />}
      {tmuxCheatsheetOpen && <TmuxCheatsheetPopup />}
      {crtScanlines && <div className="crt-overlay" />}
    </>
  )
}

function MobileLayout() {
  const { t } = useTranslation()
  const {
    activeTab,
    activeSessionId,
    sessions,
    connected,
    mobileGestureEnabled,
    settingsOpen,
    tmuxCheatsheetOpen,
    setActiveTab,
    crtScanlines,
    uiZoom,
  } = useAppStore()
  const { vvHeight } = useKeyboardHeight()
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    const order: AppState['activeTab'][] = ['sessions', 'terminal', 'files']
    const idx = order.indexOf(activeTab)
    if (idx === -1) return
    const next = direction === 'left' ? idx + 1 : idx - 1
    if (next >= 0 && next < order.length) {
      setActiveTab(order[next])
    }
  }, [activeTab, setActiveTab])

  const activeSession = Object.values(sessions).flat().find((s) => s.id === activeSessionId)
  const activeSessionName = activeSession?.name || activeSessionId || t('sidebar.noSessions')

  return (
    <>
      <div
        className="flex flex-col"
        style={{ zoom: uiZoom / 100, height: `${vvHeight / (uiZoom / 100)}px`, background: 'var(--bg-base)', color: 'var(--text-primary)', overflow: 'hidden', overscrollBehavior: 'none' } as React.CSSProperties}
      >
        <MobileStatusBar
          connected={connected}
          sessionName={activeSessionName}
          onSessionClick={() => setActiveTab('sessions')}
          onNewSession={() => setActiveTab('sessions')}
        />
        <div
          className="flex-1 overflow-hidden"
          onTouchStart={mobileGestureEnabled ? (e) => {
            const touch = e.touches[0]
            touchStart.current = { x: touch.clientX, y: touch.clientY }
          } : undefined}
          onTouchEnd={mobileGestureEnabled ? (e) => {
            if (!touchStart.current) return
            const { x: startX, y: startY } = touchStart.current
            touchStart.current = null
            const touch = e.changedTouches[0]
            const dx = touch.clientX - startX
            const dy = touch.clientY - startY
            const edgeMargin = 24
            if (Math.abs(dx) < Math.abs(dy)) return
            if (Math.abs(dx) < 40) return
            if (startX < edgeMargin || startX > window.innerWidth - edgeMargin) return
            handleSwipe(dx < 0 ? 'left' : 'right')
          } : undefined}
        >
          <MobileContent />
        </div>
        <MobileNav />
      </div>

      {/* Overlays — outside zoom container so popups stay stable during zoom changes */}
      {settingsOpen && <SettingsPopup />}
      {tmuxCheatsheetOpen && <TmuxCheatsheetPopup />}
      {crtScanlines && <div className="crt-overlay" />}
    </>
  )
}

function MobileContent() {
  const activeTab = useAppStore((s) => s.activeTab)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const [displayedTab, setDisplayedTab] = useState(activeTab)
  const [animState, setAnimState] = useState<'idle' | 'exiting'>('idle')

  useEffect(() => {
    if (activeTab === displayedTab) return
    
    // Determine if current content needs exit animation
    const needsExit = displayedTab === 'sessions' || displayedTab === 'files'
    
    if (needsExit) {
      setAnimState('exiting')
      const timer = setTimeout(() => {
        setDisplayedTab(activeTab)
        setAnimState('idle')
      }, 200)
      return () => clearTimeout(timer)
    } else {
      setDisplayedTab(activeTab)
    }
  }, [activeTab, displayedTab])

  const getAnimation = () => {
    if (animState === 'exiting') {
      if (displayedTab === 'sessions') return 'mobileSlideOutLeft 0.2s ease-in forwards'
      if (displayedTab === 'files') return 'mobileSlideOutRight 0.2s ease-in forwards'
    }
    // Enter animations
    if (displayedTab === 'sessions') return 'mobileSlideInLeft 0.25s ease-out'
    if (displayedTab === 'files') return 'mobileSlideInRight 0.25s ease-out'
    return ''
  }

  const wrapperStyle = { height: '100%', animation: getAnimation() || undefined }

  switch (displayedTab) {
    case 'terminal':
      return <SessionView key={activeSessionId ?? 'empty'} />
    case 'files':
      return <div style={wrapperStyle}><RightPanel /></div>
    case 'sessions':
      return <div style={wrapperStyle}><Sidebar /></div>
    default:
      return <SessionView key={activeSessionId ?? 'empty'} />
  }
}
