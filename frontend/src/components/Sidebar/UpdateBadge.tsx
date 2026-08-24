import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiError, api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'
import { OverlayScroll } from '../Common/OverlayScroll'
import { GAP } from '../constants/popup'
import { GITHUB_REPO_URL } from '../../version'

const POPUP_WIDTH = 280
// 倒计时秒数：与后端 RELAUNCH_DELAY 对齐（更新响应返回后 3s 触发 exec）
const RESTART_COUNTDOWN = 3
// 倒计时结束后等待「断连→恢复」的兜底窗口：超过仍未见断连视为自动重启失败，
// 回到手动重启提示（exec 失败时旧进程仍在服务，页面不会断连）
const RESTART_WATCH_TIMEOUT_MS = 60_000

interface VersionInfo {
  current: string
  latest: string
  channel: 'npm' | 'cargo' | 'github_release'
  container: boolean
}

type UpdatePhase = 'idle' | 'updating' | 'done'

export function UpdateBadge() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [open, setOpen] = useState(false)
  // Lifted above the panel so "updated, restart pending" survives close/reopen.
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  // 后端返回 auto_restart 后，倒计时与断连监测独立于面板开关继续运行
  const [autoRestart, setAutoRestart] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [restartFailed, setRestartFailed] = useState(false)

  useEffect(() => {
    api
      .versionCheck()
      .then((r) => {
        if (r.update_available) setInfo(r)
      })
      .catch(() => {})
  }, [])

  // 倒计时递减：归零后进入断连监测阶段
  useEffect(() => {
    if (phase !== 'done' || !autoRestart || countdown === null || countdown <= 0) return
    const t = window.setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => window.clearTimeout(t)
  }, [phase, autoRestart, countdown])

  // 断连监测：等待「服务不可达 → 恢复」，恢复即整页刷新拿到新版本。
  // 连续失败只靠 sawDown 标记（重启窗口内每次探测间隔 1s，足够区分抖动）；
  // 全程未断连（exec 失败）在超时后回到手动重启提示。
  useEffect(() => {
    if (phase !== 'done' || !autoRestart || countdown === null || countdown > 0) return
    let sawDown = false
    let elapsed = 0
    let inFlight = false
    const timer = window.setInterval(async () => {
      if (inFlight) return
      inFlight = true
      try {
        elapsed += 1000
        if (elapsed > RESTART_WATCH_TIMEOUT_MS) {
          window.clearInterval(timer)
          setRestartFailed(true)
          return
        }
        const res = await fetch('/api/v1/health', { cache: 'no-store' })
        if (sawDown && res.ok) {
          window.clearInterval(timer)
          window.location.reload()
        } else if (!res.ok) {
          sawDown = true
        }
      } catch {
        sawDown = true
      } finally {
        inFlight = false
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase, autoRestart, countdown])

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
        <UpdatePanel
          info={info}
          phase={phase}
          autoRestart={autoRestart}
          countdown={countdown}
          restartFailed={restartFailed}
          setPhase={setPhase}
          setAutoRestart={setAutoRestart}
          setCountdown={setCountdown}
          setRestartFailed={setRestartFailed}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function UpdatePanel({
  info,
  phase,
  autoRestart,
  countdown,
  restartFailed,
  setPhase,
  setAutoRestart,
  setCountdown,
  setRestartFailed,
  onClose,
}: {
  info: VersionInfo
  phase: UpdatePhase
  autoRestart: boolean
  countdown: number | null
  restartFailed: boolean
  setPhase: (p: UpdatePhase) => void
  setAutoRestart: (v: boolean) => void
  setCountdown: (v: number | null) => void
  setRestartFailed: (v: boolean) => void
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
        setAutoRestart(r.auto_restart)
        setRestartFailed(false)
        if (r.auto_restart) setCountdown(RESTART_COUNTDOWN)
        addToast('success', t('update.updated', { version: r.version }))
      })
      .catch((e) => {
        setPhase('idle')
        if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body && (e.body as { error: string }).error === 'container_environment') {
          addToast('error', t('update.dockerHint'))
        }
      })
  }

  // Portal to body: inside the mobile pane strip, `position: fixed` would
  // resolve against the strip's transform containing block and overflow the
  // viewport (same regression class as Modal — see docs/dev/debug-guide.md).
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
          {info.container && phase !== 'done' && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('update.dockerHint')}</div>
          )}
          {info.channel !== 'cargo' && phase !== 'done' && !info.container && (
            <button
              className="btn-pixel btn-pixel-primary"
              disabled={phase === 'updating'}
              onClick={doUpdate}
            >
              {phase === 'updating' ? t('update.updating') : t('update.updateNow')}
            </button>
          )}
          {phase === 'done' && (
            <div style={{ fontSize: 12, color: 'var(--success)' }}>
              {autoRestart && !restartFailed
                ? countdown !== null && countdown > 0
                  ? t('update.autoRestarting', { seconds: countdown })
                  : t('update.restarting')
                : t('update.restartHint')}
            </div>
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
