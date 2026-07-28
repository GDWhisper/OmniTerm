import { useEffect, useState } from 'react'
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
      {open && <UpdatePanel info={info} onClose={() => setOpen(false)} />}
    </>
  )
}

function UpdatePanel({ info, onClose }: { info: VersionInfo; onClose: () => void }) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const [phase, setPhase] = useState<UpdatePhase>('idle')
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

  return (
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
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          <div style={{ fontFamily: 'var(--pixel-font-static)', color: 'var(--gold-light, #FFCB6B)' }}>
            v{info.current} → v{info.latest}
          </div>
          <div>
            {t('update.commandHint')}{' '}
            <code style={{ color: 'var(--accent)', userSelect: 'all' }}>omniterm update</code>
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
            <div style={{ color: 'var(--success, #5A8F3A)' }}>{t('update.restartHint')}</div>
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
    </div>
  )
}
