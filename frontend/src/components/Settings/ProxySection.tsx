import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError, type ProxyPortMode, type ProxySettings } from '../../api/client'
import { PROXY_MAX_PORT, PROXY_MIN_PORT, setProxyEnabled } from '../../utils/proxyUrl'
import { READER_FONT } from '../../utils/fonts'
import { SectionTitle, ToggleRow } from './toggleRow'
import { btnBase } from './settingsStyles'

/* ── 端口转发代理安全（P4） ─────────────────────────────────────────
 *
 * 全局开关 + 端口策略（default / allowlist）+ 放行清单。配置一次性提交，
 * 避免开关/清单分步生效；后端是校验与硬边界的唯一真源，前端只做基础范围
 * 与重复检查，黑名单/自身端口由 400 兜底并内联展示。
 */

/** 与后端 `MAX_PROXY_ALLOWED_PORTS` 对齐。 */
const MAX_ALLOWED_PORTS = 64

interface Draft {
  enabled: boolean
  mode: ProxyPortMode
  /** 输入框保留字符串，保存时再解析；空行忽略。 */
  ports: string[]
}

function toDraft(settings: ProxySettings): Draft {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    ports: settings.allowed_ports.map(String),
  }
}

function parsePorts(ports: string[]): number[] | null {
  const values: number[] = []
  for (const raw of ports) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!/^\d+$/.test(trimmed)) return null
    const port = Number(trimmed)
    if (port < PROXY_MIN_PORT || port > PROXY_MAX_PORT) return null
    values.push(port)
  }
  return [...new Set(values)].sort((a, b) => a - b)
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '5px 8px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 0,
  color: 'var(--text-primary)',
  fontFamily: READER_FONT,
  fontSize: 12,
  outline: 'none',
}

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-faint)',
  lineHeight: 1.5,
}

const activeButtonStyle: React.CSSProperties = {
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-10)',
}

export function ProxySection() {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<ProxySettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .getProxySettings()
      .then((res) => {
        if (!alive) return
        setLoaded(res)
        setDraft(toDraft(res))
      })
      .catch(() => {
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  if (loadFailed) {
    return (
      <section className="space-y-2">
        <SectionTitle>{t('settings.proxy.title')}</SectionTitle>
        <p style={{ ...hintStyle, color: 'var(--danger)' }}>{t('settings.proxy.loadFailed')}</p>
      </section>
    )
  }
  if (!draft || !loaded) return null

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setSaved(false)
    setSaveError(null)
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(loaded))

  const handleSave = async () => {
    const ports = parsePorts(draft.ports)
    if (ports === null) {
      setSaveError(t('settings.proxy.invalidPort'))
      return
    }
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const res = await api.setProxySettings({
        enabled: draft.enabled,
        mode: draft.mode,
        allowed_ports: ports,
      })
      setLoaded(res)
      setDraft(toDraft(res))
      setProxyEnabled(res.enabled)
      setSaved(true)
    } catch (e) {
      setSaveError(
        e instanceof ApiError && e.status === 400
          ? t('settings.proxy.invalidPort')
          : t('settings.proxy.saveFailed'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3">
      <ToggleRow
        labelKey="settings.proxy.title"
        hintKey={
          draft.enabled ? 'settings.proxy.enabledHintOn' : 'settings.proxy.enabledHintOff'
        }
        value={draft.enabled}
        onToggle={() => update({ enabled: !draft.enabled })}
        dangerHint={!draft.enabled}
      />

      <div className="space-y-2">
        <SectionTitle>{t('settings.proxy.mode')}</SectionTitle>
        <div className="flex gap-2">
          <button
            type="button"
            style={{
              ...btnBase,
              fontSize: 12,
              padding: '5px 8px',
              ...(draft.mode === 'default' ? activeButtonStyle : {}),
            }}
            onClick={() => update({ mode: 'default' })}
          >
            {t('settings.proxy.modeDefault')}
          </button>
          <button
            type="button"
            style={{
              ...btnBase,
              fontSize: 12,
              padding: '5px 8px',
              ...(draft.mode === 'allowlist' ? activeButtonStyle : {}),
            }}
            onClick={() => update({ mode: 'allowlist' })}
          >
            {t('settings.proxy.modeAllowlist')}
          </button>
        </div>
        <p style={hintStyle}>
          {t(
            draft.mode === 'default'
              ? 'settings.proxy.modeDefaultHint'
              : 'settings.proxy.modeAllowlistHint',
          )}
        </p>
      </div>

      {draft.mode === 'allowlist' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('settings.proxy.allowedPorts')}
            </label>
            <button
              type="button"
              style={btnBase}
              disabled={draft.ports.length >= MAX_ALLOWED_PORTS}
              onClick={() => update({ ports: [...draft.ports, ''] })}
            >
              + {t('settings.proxy.addPort')}
            </button>
          </div>
          {draft.ports.map((port, index) => (
            <div key={index} className="flex gap-1.5 items-center">
              <input
                style={inputStyle}
                inputMode="numeric"
                value={port}
                placeholder="3000"
                aria-label={t('settings.proxy.allowedPorts')}
                onChange={(e) => {
                  const ports = [...draft.ports]
                  ports[index] = e.target.value
                  update({ ports })
                }}
              />
              <button
                type="button"
                style={btnBase}
                onClick={() => update({ ports: draft.ports.filter((_, i) => i !== index) })}
              >
                ×
              </button>
            </div>
          ))}
          <p style={hintStyle}>{t('settings.proxy.allowedPortsHint')}</p>
          {draft.ports.every((p) => !p.trim()) && (
            <p style={{ ...hintStyle, color: 'var(--warning)' }}>
              {t('settings.proxy.emptyAllowlistWarning')}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          style={{ ...btnBase, fontSize: 12, padding: '5px 12px' }}
          disabled={!dirty || saving}
          onClick={handleSave}
        >
          {saving ? t('settings.loading') : t('settings.proxy.save')}
        </button>
        {saved && (
          <span style={{ ...hintStyle, color: 'var(--success)' }}>{t('settings.proxy.saved')}</span>
        )}
        {saveError && (
          <span style={{ ...hintStyle, color: 'var(--danger)' }}>{saveError}</span>
        )}
      </div>
    </section>
  )
}
