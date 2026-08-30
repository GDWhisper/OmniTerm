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
  /** 服务端按自身 argv 组装的忠实重启命令（补 -d、带 --db、脱敏 secret） */
  restart_command: string
}

type UpdatePhase = 'idle' | 'updating' | 'done'

export function UpdateBadge() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [open, setOpen] = useState(false)
  // Lifted above the panel so "updated, restart pending" survives close/reopen.
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  // 后端返回 auto_restart 后，倒计时与重启监测独立于面板开关继续运行
  const [autoRestart, setAutoRestart] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [restartFailed, setRestartFailed] = useState(false)
  // 本次升级的目标版本：重启监测以此比对 health 的 version 字段确认「新版已上线」
  const [targetVersion, setTargetVersion] = useState<string | null>(null)

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

  // 重启监测：轮询 health 的 version 字段，等于目标版本即确认「新版已上线」并刷新。
  // 版本比对不要求捕捉断连瞬间——远程接入（隧道拆线）、后台标签节流都可能错过
  // 断连窗口，但只要链路恢复可达就能确认。升级来源是旧版实现（health 无 version
  // 字段）时回退到「断连 → 恢复」状态机。超时未确认（exec 失败等）落到手动重启提示。
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
        if (res.ok) {
          const body = await res.json().catch(() => null)
          const version = body && typeof body.version === 'string' ? body.version : null
          const upOnTarget = version !== null ? version === targetVersion : sawDown
          if (upOnTarget) {
            window.clearInterval(timer)
            window.location.reload()
          }
        } else {
          sawDown = true
        }
      } catch {
        sawDown = true
      } finally {
        inFlight = false
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase, autoRestart, countdown, targetVersion])

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
          targetVersion={targetVersion}
          setPhase={setPhase}
          setAutoRestart={setAutoRestart}
          setCountdown={setCountdown}
          setRestartFailed={setRestartFailed}
          setTargetVersion={setTargetVersion}
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
  targetVersion,
  setPhase,
  setAutoRestart,
  setCountdown,
  setRestartFailed,
  setTargetVersion,
  onClose,
}: {
  info: VersionInfo
  phase: UpdatePhase
  autoRestart: boolean
  countdown: number | null
  restartFailed: boolean
  targetVersion: string | null
  setPhase: (p: UpdatePhase) => void
  setAutoRestart: (v: boolean) => void
  setCountdown: (v: number | null) => void
  setRestartFailed: (v: boolean) => void
  setTargetVersion: (v: string | null) => void
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
        setTargetVersion(r.version)
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
                  : t('update.restarting', { version: targetVersion ?? info.latest })
                : restartFailed
                  ? t('update.restartTimeout', { version: targetVersion ?? info.latest, command: info.restart_command })
                  : t('update.restartHint', { command: info.restart_command })}
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
