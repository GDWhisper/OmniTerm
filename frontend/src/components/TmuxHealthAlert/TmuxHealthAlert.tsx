import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '../../api/client'
import type { TmuxHealth } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'

/**
 * TmuxHealthAlert — tmux server 聋 server（deaf server）全局告警 + 「重建
 * tmux server」按钮 + 孤儿控制客户端堆积风险提示。
 *
 * 背景见 docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md（P1-1/P1-2、
 * D3）：tmux server 可能冻结成 `server_exit=1` 的半死态，新 tmux 命令全部报
 * `server exited unexpectedly` 且无人值守时无限期持续，由本组件提供用户侧
 * 告警与内建自愈入口（后端重探针 + 单飞保证幂等）。
 *
 * UI 形态选型：**横幅**（持久告警卡）——复用 Sidebar 重复项目横幅
 * （`Sidebar.tsx` dup-banner）的「⚠ + 文案 + 行动按钮」横幅交互模式，浮层
 * 视觉走 ui-style-guide §6.1 `.pixel-float`、按钮走 §3.2 `.btn-pixel-primary`。
 * 刻意不选 Toast（§7.3 约 4s 自动消失，承载不了持续性故障 + 操作按钮）与
 * sidebar 状态位（§4.1 明确「不可点击」，且侧栏可折叠成 40px rail，全局可见
 * 性不足）。挂载层级学 `ToastContainer`（App 级浮层，桌面/移动/侧栏折叠均
 * 可见）。
 *
 * 轮询：自持单一轮询链（`TMUX_HEALTH_POLL_MS`）查 `GET /tmux/health`，组织
 * 方式沿用 UpdateBadge / ExternalSessionsSection 的自持轮询（inFlight 防重
 * 入 + cleanup 清定时器）。既有轮询链各查不同端点（5s `/health` 连接探测、
 * 3s 会话轮询、10s external 轮询），无可复用数据源，故新建这一条，不并行
 * 造第二条。
 *
 * 四态表现（后端分类函数是唯一真源，前端只按 state 消费）：
 * - `deaf` 且 `consecutive_deaf >= DEAF_CONFIRM_THRESHOLD` ⇒ 告警 + 重建按钮
 * - `orphan_count > orphan_warn_threshold` ⇒ 风险提示文案（无操作按钮）
 * - `other` ⇒ 至多轻量提示（后端不自动处理，前端也不触发自愈）
 * - `healthy` / `no_server` ⇒ 静默
 */

/** 前端健康轮询周期（10s 量级）。与后端探测周期（probe_interval_secs）解耦：
 *  只消费后端已确认的状态，不在此重复探测语义。 */
export const TMUX_HEALTH_POLL_MS = 10_000

/** 后端连续确认阈值（后端 DEAF_CONFIRM_COUNT）：连续确认聋签名 ≥3 次才告警，
 *  防止单次探测抖动误报「自愈入口」这种高危动作的诱因。 */
export const DEAF_CONFIRM_THRESHOLD = 3

/** ApiError body 的 `error` 字段（业务错误码 / 后端错误串），非字符串返回 null。 */
function errorField(e: ApiError): string | null {
  const body = e.body as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : null
}

export function TmuxHealthAlert() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  const [health, setHealth] = useState<TmuxHealth | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  // 防双击的第二道防线：rebuilding state 的翻转是异步的，快速连点可能在重渲染
  // 禁用按钮之前连发两次 POST（后端单飞是兜底，前端不指望它挡正常双击）。
  const rebuildingRef = useRef(false)

  // 立即刷新 health（重建成功 / not_deaf 后不等下一轮轮询，让告警即时收敛）。
  const refreshHealth = async () => {
    try {
      setHealth(await api.tmuxHealth())
    } catch {
      // 静默：下一轮轮询会再试
    }
  }

  const handleRebuild = async () => {
    if (rebuildingRef.current) return
    rebuildingRef.current = true
    setRebuilding(true)
    let shouldRefresh = false
    try {
      await api.tmuxRebuild()
      addToast('success', t('tmuxHealth.rebuildSuccess'))
      shouldRefresh = true
    } catch (e) {
      const code = e instanceof ApiError ? errorField(e) : null
      if (e instanceof ApiError && e.status === 409 && code === 'not_deaf') {
        // 重探针未确认聋：server 已恢复 / 已自动重建。提示即可，
        // 刻意不自动重试——下一发很可能命中健康新 server。
        addToast('info', t('tmuxHealth.rebuildNotDeaf'))
        shouldRefresh = true
      } else if (e instanceof ApiError && e.status === 409 && code === 'heal_in_progress') {
        // 后端单飞互斥：另一触发已在重建。同样不重试轰炸。
        addToast('info', t('tmuxHealth.rebuildRunning'))
      } else {
        // 500 / 网络失败等。后端 detail 已结构化落日志；这里带上 error 串
        // 便于用户回报，其余走本地化文案。
        addToast(
          'error',
          code ? `${t('tmuxHealth.rebuildFailed')}: ${code}` : t('tmuxHealth.rebuildFailed'),
        )
      }
    } finally {
      rebuildingRef.current = false
      setRebuilding(false)
    }
    if (shouldRefresh) await refreshHealth()
  }

  // ── 单一轮询链 ──
  useEffect(() => {
    let disposed = false
    let inFlight = false
    const check = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const fresh = await api.tmuxHealth()
        if (!disposed) setHealth(fresh)
      } catch {
        // 静默：连接状态由 Sidebar 的 LINK/LOST 状态位表达，轮询失败不弹 toast
      } finally {
        inFlight = false
      }
    }
    void check()
    const id = window.setInterval(check, TMUX_HEALTH_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(id)
    }
  }, [])

  const deafAlert = health?.state === 'deaf' && health.consecutive_deaf >= DEAF_CONFIRM_THRESHOLD
  // 真值守卫而非 `!== null`：后端契约漂移 / mock 未就绪时 health 可能是
  // undefined（工程准则 8——缺省字段显式兜底），此时不应抛错也不应提示。
  const orphanRisk = health ? health.orphan_count > health.orphan_warn_threshold : false
  const otherHint = health?.state === 'other'
  if (!deafAlert && !orphanRisk && !otherHint) return null

  return (
    <div
      data-testid="tmux-health-alert"
      className="pixel-float"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        width: 'min(460px, calc(100vw - 24px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 14px',
        background: 'var(--bg-elevated)',
        borderColor: deafAlert ? 'var(--danger)' : 'var(--warning)',
        overflowWrap: 'anywhere',
      }}
    >
      {deafAlert && (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span aria-hidden style={{ color: 'var(--danger)', fontSize: 14, lineHeight: '18px', flexShrink: 0 }}>
            ⚠
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--danger)' }}>
              {t('tmuxHealth.deafTitle')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('tmuxHealth.deafBody')}
            </div>
          </div>
          <button
            data-testid="tmux-rebuild-btn"
            className="btn-pixel btn-pixel-primary"
            style={{ flexShrink: 0, fontSize: 12, padding: '5px 10px' }}
            disabled={rebuilding}
            onClick={() => void handleRebuild()}
          >
            {rebuilding ? t('tmuxHealth.rebuilding') : t('tmuxHealth.rebuild')}
          </button>
        </div>
      )}

      {orphanRisk && health && (
        <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span aria-hidden style={{ color: 'var(--warning)', fontSize: 14, lineHeight: '18px', flexShrink: 0 }}>
            ⚠
          </span>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('tmuxHealth.orphanRisk', {
              count: health.orphan_count,
              threshold: health.orphan_warn_threshold,
            })}
          </div>
        </div>
      )}

      {otherHint && (
        <div role="status" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {t('tmuxHealth.otherHint')}
        </div>
      )}
    </div>
  )
}
