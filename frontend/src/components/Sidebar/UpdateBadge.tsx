import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'
import { OverlayScroll } from '../Common/OverlayScroll'
import { GAP } from '../constants/popup'
import { GITHUB_REPO_URL } from '../../version'

const POPUP_WIDTH = 280

interface VersionInfo {
  current: string
  latest: string
  channel: 'npm' | 'cargo' | 'github_release'
}

type UpdatePhase = 'idle' | 'updating' | 'done'

export function UpdateBadge() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [open, setOpen] = useState(false)
  // Lifted above the panel so "updated, restart pending" survives close/reopen.
  const [phase, setPhase] = useState<UpdatePhase>('idle')

  useEffect(() => {
    api
      .versionCheck()
      .then((r) => {
        if (r.update_available) setInfo(r)
      })
      .catch(() => {})
  }, [])

  if (!info) return null

  return (
    <>
      <button
        data-toggle="update-badge"
        className="update-badge"
        title={t('update.badgeTooltip', { version: info.latest })}
        onClick={() => setOpen((v) => !v)}
      >
        {t('update.badge')}
      </button>
      {open && (
        <UpdatePanel info={info} phase={phase} setPhase={setPhase} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function UpdatePanel({
  info,
  phase,
  setPhase,
  onClose,
}: {
  info: VersionInfo
  phase: UpdatePhase
  setPhase: (p: UpdatePhase) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const { ref, pos } = useAnchorPopup({
    toggleSelector: '[data-toggle="update-badge"]',
    width: POPUP_WIDTH,
    onClose,
  })

  const doUpdate = () => {
    setPhase('updating')
    api
      .systemUpdate()
      .then((r) => {
        setPhase('done')
        addToast('success', t('update.updated', { version: r.version }))
      })
      .catch(() => setPhase('idle'))
  }

  // Portal to body: inside the mobile pane strip, `position: fixed` would
  // resolve against the strip's transform containing block and overflow the
  // viewport (same regression class as Modal — see debug-log).
  return createPortal(
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="pixel-float"
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        maxHeight: pos.maxHeight,
        width: `min(${POPUP_WIDTH}px, calc(100vw - ${GAP * 2}px))`,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        borderRadius: 2,
        overflow: 'hidden',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{t('update.title')}</span>
      </div>
      <OverlayScroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ flex: '0 0 auto' }}>
        <div
          style={{
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 13,
            color: 'var(--text-primary)',
          }}
        >
          <div style={{ fontFamily: 'var(--pixel-font-static)', letterSpacing: 'var(--pixel-tracking-sm)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>v{info.current}</span>
            <span style={{ color: 'var(--text-faint)' }}> → </span>
            <span style={{ color: 'var(--success)', fontWeight: 700 }}>v{info.latest}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('update.commandHint')}{' '}
            <code
              style={{
                background: 'var(--bg-code-inline)',
                color: 'var(--text-primary)',
                padding: '2px 6px',
                borderRadius: 2,
                userSelect: 'all',
              }}
            >
              omniterm update
            </code>
          </div>
          {info.channel !== 'cargo' && phase !== 'done' && (
            <button
              className="btn-pixel btn-pixel-primary"
              disabled={phase === 'updating'}
              onClick={doUpdate}
            >
              {phase === 'updating' ? t('update.updating') : t('update.updateNow')}
            </button>
          )}
          {phase === 'done' && (
            <div style={{ fontSize: 12, color: 'var(--success)' }}>{t('update.restartHint')}</div>
          )}
          <a
            href={`${GITHUB_REPO_URL}/releases/latest`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            {t('update.viewRelease')}
          </a>
        </div>
      </OverlayScroll>
    </div>,
    document.body,
  )
}
