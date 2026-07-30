import { useRef, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, MIN_SIDEBAR_WIDTH, type AppState } from '../../stores/appStore'
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
import { decideSwipeAxis, applyEdgeResistance, resolveSwipeCommit } from '../../utils/swipe'

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
  const sidebarRef = useRef<HTMLDivElement>(null)
  const fileManagerRef = useRef<HTMLDivElement>(null)

  // Shared drag-teardown: remove all mouse+touch listeners and reset body styles
  const cleanUpDrag = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setIsDragging(false)
  }, [])

  // Drag resize — direct DOM updates during drag, sync to store on mouseup.
  // Bypasses React re-render on every mousemove for smooth 60fps resize.
  const handleSidebarDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const startX = clientX
      let curWidth = sidebarWidth
      const maxSidebar = Math.floor(window.innerWidth / 3)
      setIsDragging(true)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        ev.preventDefault()
        const mvX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
        curWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebar, sidebarWidth + mvX - startX))
        if (sidebarRef.current) sidebarRef.current.style.width = `${curWidth}px`
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
        setSidebarWidth(curWidth)
        localStorage.setItem('omniterm_sidebar_width', String(curWidth))
        cleanUpDrag()
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
      let curWidth = fileManagerWidth
      const maxFileManager = Math.floor(window.innerWidth / 2)
      setIsDragging(true)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        ev.preventDefault()
        const mvX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
        curWidth = Math.max(240, Math.min(maxFileManager, fileManagerWidth + startX - mvX))
        if (fileManagerRef.current) fileManagerRef.current.style.width = `${curWidth}px`
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
        setFileManagerWidth(curWidth)
        localStorage.setItem('omniterm_fm_width', String(curWidth))
        cleanUpDrag()
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
        sidebarRef={sidebarRef}
        fileManagerRef={fileManagerRef}
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
  sidebarRef: React.RefObject<HTMLDivElement | null>
  fileManagerRef: React.RefObject<HTMLDivElement | null>
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
  sidebarRef,
  fileManagerRef,
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
              ref={sidebarRef}
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
              ref={fileManagerRef}
              className="flex-shrink-0 overflow-hidden"
              style={{
                width: fileManagerCollapsed ? 40 : fileManagerWidth,
                background: 'var(--bg-base)',
                borderLeft: '1px solid var(--border-subtle)',
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

const TAB_ORDER: AppState['activeTab'][] = ['sessions', 'terminal', 'files']
const SWIPE_SETTLE_MS = 160

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

  const contentRef = useRef<HTMLDivElement>(null)
  const swipeCommitRef = useRef(false)
  const settlingRef = useRef(false)
  const dragRef = useRef<{ startX: number; startY: number; dx: number; axis: 'x' | 'y' | null } | null>(null)

  const settleTransform = useCallback((x: number, onDone: () => void) => {
    const el = contentRef.current
    if (!el) { onDone(); return }
    settlingRef.current = true
    el.style.transition = `transform ${SWIPE_SETTLE_MS}ms ease-out`
    el.style.transform = `translateX(${x}px)`
    window.setTimeout(() => {
      el.style.transition = ''
      el.style.transform = ''
      settlingRef.current = false
      onDone()
    }, SWIPE_SETTLE_MS)
  }, [])

  const onSwipeStart = useCallback((e: React.TouchEvent) => {
    if (settlingRef.current) return
    // Terminal area: horizontal drag is text selection (plan D2/D3).
    if ((e.target as HTMLElement).closest('.xterm')) return
    const touch = e.touches[0]
    dragRef.current = { startX: touch.clientX, startY: touch.clientY, dx: 0, axis: null }
  }, [])

  const onSwipeMove = useCallback((e: React.TouchEvent) => {
    const drag = dragRef.current
    if (!drag || !contentRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY
    if (!drag.axis) {
      drag.axis = decideSwipeAxis(dx, dy)
      if (drag.axis === 'y') dragRef.current = null // hand back to list scroll
      return
    }
    const idx = TAB_ORDER.indexOf(activeTab)
    const damped = applyEdgeResistance(dx, idx > 0, idx < TAB_ORDER.length - 1)
    drag.dx = damped
    contentRef.current.style.transform = `translateX(${damped}px)`
  }, [activeTab])

  const onSwipeEnd = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.axis !== 'x' || !contentRef.current) return
    const idx = TAB_ORDER.indexOf(activeTab)
    const canPrev = idx > 0
    const canNext = idx < TAB_ORDER.length - 1
    const commit = resolveSwipeCommit(drag.dx, canPrev, canNext)
    if (!commit) {
      settleTransform(0, () => {})
      return
    }
    const width = contentRef.current.clientWidth
    const target = commit === 'next' ? TAB_ORDER[idx + 1] : TAB_ORDER[idx - 1]
    settleTransform(commit === 'next' ? -width : width, () => {
      swipeCommitRef.current = true // MobileContent skips its slide animations (D4)
      setActiveTab(target)
    })
  }, [activeTab, setActiveTab, settleTransform])

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
          ref={contentRef}
          className="flex-1 overflow-hidden"
          style={{ touchAction: 'pan-y' }}
          onTouchStart={mobileGestureEnabled ? onSwipeStart : undefined}
          onTouchMove={mobileGestureEnabled ? onSwipeMove : undefined}
          onTouchEnd={mobileGestureEnabled ? onSwipeEnd : undefined}
          onTouchCancel={mobileGestureEnabled ? onSwipeEnd : undefined}
        >
          <MobileContent swipeCommitRef={swipeCommitRef} />
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

function MobileContent({ swipeCommitRef }: { swipeCommitRef: React.MutableRefObject<boolean> }) {
  const activeTab = useAppStore((s) => s.activeTab)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const [displayedTab, setDisplayedTab] = useState(activeTab)
  const [animState, setAnimState] = useState<'idle' | 'exiting'>('idle')

  useEffect(() => {
    if (activeTab === displayedTab) return

    // Swipe commit: the finger already conveyed direction/distance — switch
    // instantly instead of replaying slide animations (would double-translate).
    if (swipeCommitRef.current) {
      swipeCommitRef.current = false
      setDisplayedTab(activeTab)
      setAnimState('idle')
      return
    }

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
  }, [activeTab, displayedTab, swipeCommitRef])

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
