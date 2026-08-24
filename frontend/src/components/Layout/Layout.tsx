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
import { hapticTap } from '../../utils/haptics'
import { nextSessionId } from '../../utils/sessionNav'

/**
 * Pick the right pane for the active session: ChatView for ACP-backed
 * sessions, Terminal for tmux (and the null-session empty state). The
 * wrapper key in the callers forces a remount on VIEW-TYPE transitions
 * (tmux↔acp↔none), while same-kind switches (tmux→tmux, acp→acp) keep the
 * view mounted — useTerminal/useAcpChat reconnect in place. Keying on the
 * session id instead would destroy and recreate the xterm on every switch,
 * flashing a blank screen for ~250ms (see docs/dev/debug-guide.md).
 */
function SessionView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  // 归档会话不在任何项目切片里（默认列表服务端已排除），只读查看时从
  // archivedSessions 兜底解析，否则会卡在下方 loading 占位。
  const archivedSessions = useAppStore((s) => s.archivedSessions)
  const activeSession = activeSessionId
    ? (Object.values(sessions).flat().find((s) => s.id === activeSessionId) ??
      archivedSessions.find((s) => s.id === activeSessionId))
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
  const sessions = useAppStore((s) => s.sessions)
  const activeExternalSession = useAppStore((s) => s.activeExternalSession)
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
            <SessionView key={sessionViewKey(sessions, activeSessionId, activeExternalSession)} />
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
// Panes sit side by side in a 300%-wide strip; each pane is 1/3 of the strip
// (= one viewport). Neighbors stay visible while dragging, so a swipe is one
// continuous motion instead of "blank gap then content swap".
const PANE_WIDTH_PCT = 100 / 3
const stripTransform = (idx: number) => `translateX(${-idx * PANE_WIDTH_PCT}%)`
const PANE_STYLE: React.CSSProperties = { width: `${PANE_WIDTH_PCT}%`, height: '100%', overflow: 'hidden', flexShrink: 0 }

/**
 * View-kind key for <SessionView>: 'empty' | 'tmux' | 'acp' | 'external'.
 * Only view-kind transitions remount; same-kind session switches reconnect
 * in place (useTerminal / useAcpChat), avoiding the xterm destroy+recreate
 * flash on every tmux session switch.
 */
function sessionViewKey(
  sessions: AppState['sessions'],
  activeSessionId: string | null,
  activeExternalSession: string | null,
): string {
  if (activeExternalSession) return 'external'
  const active = activeSessionId
    ? Object.values(sessions).flat().find((s) => s.id === activeSessionId)
    : null
  return active?.runtime_kind ?? 'empty'
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
    projects,
    activeExternalSession,
    activateSession,
  } = useAppStore()
  const { vvHeight, vvOffsetTop } = useKeyboardHeight()

  const stripRef = useRef<HTMLDivElement>(null)
  const settlingRef = useRef(false)
  const prevIdxRef = useRef<number | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; dx: number; axis: 'x' | 'y' | null } | null>(null)

  const tabIdx = TAB_ORDER.indexOf(activeTab)

  // Single animation path for both swipe commits and nav taps: whenever the
  // active tab changes, glide the strip from wherever it is (base position or
  // mid-drag offset) to the new base — one continuous motion, no double slide.
  useEffect(() => {
    const el = stripRef.current
    if (!el || prevIdxRef.current === tabIdx) return
    const first = prevIdxRef.current === null
    prevIdxRef.current = tabIdx
    if (first) {
      el.style.transform = stripTransform(tabIdx)
      return
    }
    settlingRef.current = true
    el.style.transition = `transform ${SWIPE_SETTLE_MS}ms ease-out`
    el.style.transform = stripTransform(tabIdx)
    const timer = window.setTimeout(() => {
      el.style.transition = ''
      settlingRef.current = false
    }, SWIPE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [tabIdx])

  const onSwipeStart = useCallback((e: React.TouchEvent) => {
    if (settlingRef.current) return
    // Terminal area: horizontal drag is text selection (plan D2/D3).
    if ((e.target as HTMLElement).closest('.xterm')) return
    const touch = e.touches[0]
    dragRef.current = { startX: touch.clientX, startY: touch.clientY, dx: 0, axis: null }
  }, [])

  const onSwipeMove = useCallback((e: React.TouchEvent) => {
    const drag = dragRef.current
    if (!drag || !stripRef.current) return
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
    stripRef.current.style.transition = 'none'
    stripRef.current.style.transform = `translateX(calc(${-idx * PANE_WIDTH_PCT}% + ${damped}px))`
  }, [activeTab])

  const onSwipeEnd = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.axis !== 'x' || !stripRef.current) return
    const idx = TAB_ORDER.indexOf(activeTab)
    const canPrev = idx > 0
    const canNext = idx < TAB_ORDER.length - 1
    const commit = resolveSwipeCommit(drag.dx, canPrev, canNext)
    if (!commit) {
      // Snap back to the current pane
      const el = stripRef.current
      settlingRef.current = true
      el.style.transition = `transform ${SWIPE_SETTLE_MS}ms ease-out`
      el.style.transform = stripTransform(idx)
      window.setTimeout(() => {
        el.style.transition = ''
        settlingRef.current = false
      }, SWIPE_SETTLE_MS)
      return
    }
    hapticTap()
    // Tab-change effect glides the strip from the dragged offset to the target
    setActiveTab(commit === 'next' ? TAB_ORDER[idx + 1] : TAB_ORDER[idx - 1])
  }, [activeTab, setActiveTab])

  const handleSwipeSession = useCallback((dir: 'prev' | 'next') => {
    if (activeExternalSession) return // external tmux sessions have no DB ordering
    const orderedIds = projects.flatMap((p) => sessions[p.id] ?? []).map((s) => s.id)
    const nextId = nextSessionId(orderedIds, activeSessionId, dir)
    if (!nextId) return
    hapticTap()
    activateSession(nextId)
  }, [projects, sessions, activeSessionId, activeExternalSession, activateSession])

  const activeSession = Object.values(sessions).flat().find((s) => s.id === activeSessionId)
  const activeSessionName = activeSession?.name || activeSessionId || t('sidebar.noSessions')

  return (
    <>
      <div
        className="flex flex-col"
        // translateY tracks the visual-viewport pan (keyboard revealing the
        // focused input) so the layout always fills the visible region;
        // divided by zoom like the height since both resolve pre-zoom.
        style={{ zoom: uiZoom / 100, height: `${vvHeight / (uiZoom / 100)}px`, transform: vvOffsetTop ? `translateY(${vvOffsetTop / (uiZoom / 100)}px)` : undefined, background: 'var(--bg-base)', color: 'var(--text-primary)', overflow: 'clip', overscrollBehavior: 'none' } as React.CSSProperties}
      >
        <MobileStatusBar
          connected={connected}
          sessionName={activeSessionName}
          onSessionClick={() => setActiveTab('sessions')}
          onNewSession={() => setActiveTab('sessions')}
          onSwipeSession={handleSwipeSession}
        />
        <div
          className="flex-1 overflow-hidden"
          // `minHeight: 0` 是 flex 子项的关键（缺省 `min-height: auto`）：
          // ACP 会话的长消息列表 min-content 高度很大（数千 px），flex 无法
          // 把容器压到剩余空间（753px），整个 strip 连同 MobileNav 被顶出
          // 844px 的根容器并被 clip 静默裁掉——底部输入区/导航全部不可见。
          // tmux 会话不触发是因为 xterm 内容有限高（min-content 小）。
          // `overflow: clip` (unlike `hidden`) makes this a non-scroll-container:
          // when the keyboard opens on a focused ACP chat input, the browser's
          // scrollIntoView would otherwise set scrollLeft and silently shift the
          // strip out of sync with activeTab. onScroll reset covers browsers
          // that reject `clip` (falls back to the overflow-hidden class).
          style={{ touchAction: 'pan-y', overflow: 'clip', minHeight: 0 }}
          onScroll={(e) => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0 }}
          onTouchStart={mobileGestureEnabled ? onSwipeStart : undefined}
          onTouchMove={mobileGestureEnabled ? onSwipeMove : undefined}
          onTouchEnd={mobileGestureEnabled ? onSwipeEnd : undefined}
          onTouchCancel={mobileGestureEnabled ? onSwipeEnd : undefined}
        >
          <div ref={stripRef} style={{ display: 'flex', width: '300%', height: '100%', willChange: 'transform' }}>
            <div style={PANE_STYLE}><Sidebar /></div>
            <div style={PANE_STYLE}><SessionView key={sessionViewKey(sessions, activeSessionId, activeExternalSession)} /></div>
            <div style={PANE_STYLE}><RightPanel /></div>
          </div>
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
