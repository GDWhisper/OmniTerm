import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  api, ApiError, type AiCommitModel, type AiCommitProvider,
} from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { READER_FONT } from '../../utils/fonts'
import { SectionTitle } from './toggleRow'
import { btnBase } from './settingsStyles'

const PROVIDERS: { value: AiCommitProvider; labelKey: string }[] = [
  { value: 'off', labelKey: 'settings.aiCommit.off' },
  { value: 'openai', labelKey: 'settings.aiCommit.openai' },
  { value: 'anthropic', labelKey: 'settings.aiCommit.anthropic' },
]

/** Error codes from the AI commit API → localized setting-page copy. */
const AI_ERROR_KEYS: Record<string, string> = {
  ai_auth: 'settings.aiCommit.error.ai_auth',
  ai_key_env_missing: 'settings.aiCommit.error.ai_key_env_missing',
  ai_rate_limited: 'settings.aiCommit.error.ai_rate_limited',
  ai_timeout: 'settings.aiCommit.error.ai_timeout',
  ai_network: 'settings.aiCommit.error.ai_network',
  ai_upstream: 'settings.aiCommit.error.ai_upstream',
  ai_invalid_response: 'settings.aiCommit.error.ai_invalid_response',
  ai_invalid_config: 'settings.aiCommit.error.ai_invalid_config',
  ai_not_configured: 'settings.aiCommit.error.ai_not_configured',
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

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

export function AiCommitSection() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  const [loaded, setLoaded] = useState(false)
  const [provider, setProvider] = useState<AiCommitProvider>('off')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [keySource, setKeySource] = useState<'file' | 'env' | null>(null)
  const [keyEnv, setKeyEnv] = useState<string | null>(null)
  const [keyEnvSet, setKeyEnvSet] = useState<boolean | null>(null)
  const [clearKey, setClearKey] = useState(false)
  const [models, setModels] = useState<AiCommitModel[]>([])
  const [modelsTruncated, setModelsTruncated] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)

  const toastError = (err: unknown) => {
    const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined
    const message = code && AI_ERROR_KEYS[code]
      ? t(AI_ERROR_KEYS[code])
      : err instanceof Error ? err.message : String(err)
    addToast('error', message)
  }

  useEffect(() => {
    let cancelled = false
    api.getAiCommitConfig()
      .then((cfg) => {
        if (cancelled) return
        setProvider(cfg.provider)
        setBaseUrl(cfg.base_url)
        setModel(cfg.model)
        setHasKey(cfg.has_api_key)
        setKeySource(cfg.api_key_source ?? null)
        setKeyEnv(cfg.api_key_env ?? null)
        setKeyEnvSet(cfg.api_key_env_set ?? null)
      })
      .catch(toastError)
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // toastError is recreated per render; config is fetched once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectProvider = (value: AiCommitProvider) => {
    setProvider(value)
    setModels([])
    setModelsTruncated(false)
  }

  const handleLoadModels = async () => {
    if (provider === 'off' || !baseUrl.trim()) return
    setLoadingModels(true)
    try {
      const result = await api.listAiCommitModels({
        provider,
        base_url: baseUrl.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      })
      setModels(result.models)
      setModelsTruncated(result.truncated)
      if (result.models.length === 0) addToast('info', t('settings.aiCommit.noModels'))
    } catch (err) {
      toastError(err)
    } finally {
      setLoadingModels(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const cfg = await api.setAiCommitConfig({
        provider,
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(clearKey ? { clear_api_key: true } : {}),
      })
      setProvider(cfg.provider)
      setBaseUrl(cfg.base_url)
      setModel(cfg.model)
      setHasKey(cfg.has_api_key)
      setKeySource(cfg.api_key_source ?? null)
      setKeyEnv(cfg.api_key_env ?? null)
      setKeyEnvSet(cfg.api_key_env_set ?? null)
      setApiKey('')
      setClearKey(false)
      addToast('success', t('settings.aiCommit.saved'))
    } catch (err) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return (
      <section className="space-y-2">
        <SectionTitle>{t('settings.aiCommit.title')}</SectionTitle>
        <p style={hintStyle}>{t('settings.loading')}</p>
      </section>
    )
  }

  const enabled = provider !== 'off'
  const basePlaceholder = provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1'

  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.aiCommit.title')}</SectionTitle>
      <p style={hintStyle}>{t('settings.aiCommit.privacy')}</p>

      <div className="space-y-1.5">
        <div style={labelStyle}>{t('settings.aiCommit.provider')}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROVIDERS.map((item) => {
            const active = provider === item.value
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => selectProvider(item.value)}
                style={{
                  ...btnBase,
                  fontSize: 12,
                  padding: '5px 9px',
                  ...(active
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' }
                    : {}),
                }}
              >
                {t(item.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      {enabled && (
        <>
          <div className="space-y-1.5">
            <div style={labelStyle}>{t('settings.aiCommit.baseUrl')}</div>
            <input
              style={inputStyle}
              value={baseUrl}
              placeholder={basePlaceholder}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                setModels([])
              }}
            />
            <p style={hintStyle}>{t('settings.aiCommit.baseUrlHint')}</p>
          </div>

          <div className="space-y-1.5">
            <div style={labelStyle}>{t('settings.aiCommit.model')}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={inputStyle}
                list="omniterm-ai-commit-models"
                value={model}
                placeholder={t('settings.aiCommit.modelPlaceholder')}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="omniterm-ai-commit-models">
                {models.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </datalist>
              <button
                type="button"
                style={{ ...btnBase, fontSize: 11, padding: '4px 9px', flexShrink: 0 }}
                disabled={loadingModels || !baseUrl.trim()}
                onClick={handleLoadModels}
              >
                {loadingModels ? t('settings.aiCommit.loadingModels') : t('settings.aiCommit.loadModels')}
              </button>
            </div>
            {modelsTruncated && <p style={hintStyle}>{t('settings.aiCommit.modelsTruncated')}</p>}
            <p style={hintStyle}>{t('settings.aiCommit.modelHint')}</p>
          </div>

          <div className="space-y-1.5">
            <div style={labelStyle}>{t('settings.aiCommit.apiKey')}</div>
            <input
              style={inputStyle}
              type="password"
              value={apiKey}
              autoComplete="off"
              disabled={clearKey}
              placeholder={hasKey
                ? t('settings.aiCommit.keyConfigured')
                : t('settings.aiCommit.keyPlaceholder')}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {keySource === 'env' && keyEnv && (
              <p
                style={{
                  ...hintStyle,
                  color: keyEnvSet ? 'var(--text-faint)' : 'var(--warning)',
                }}
              >
                {keyEnvSet
                  ? t('settings.aiCommit.envVarInUse', { name: keyEnv })
                  : t('settings.aiCommit.envVarMissing', { name: keyEnv })}
              </p>
            )}
            {hasKey && (
              <label className="flex items-center gap-2 select-none" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  className="fm-checkbox"
                  style={{ accentColor: 'var(--danger)', flexShrink: 0 }}
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.target.checked)}
                />
                <span>{t('settings.aiCommit.clearKey')}</span>
              </label>
            )}
            <p style={hintStyle}>{t('settings.aiCommit.keyHint')}</p>
          </div>
        </>
      )}

      <button
        type="button"
        style={{ ...btnBase, fontSize: 12, padding: '5px 12px' }}
        disabled={saving}
        onClick={handleSave}
      >
        {saving ? t('settings.loading') : t('settings.aiCommit.save')}
      </button>
    </section>
  )
}
