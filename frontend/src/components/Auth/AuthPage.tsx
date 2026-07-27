import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'

interface Props {
  needsSetup: boolean
}

export function AuthPage({ needsSetup }: Props) {
  const { t } = useTranslation()
  const setAuthState = useAppStore((s) => s.setAuthState)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!password || submitting) return

      setSubmitting(true)
      setError('')

      try {
        if (needsSetup) {
          await api.setup(password)
          setAuthState('authenticated')
        } else {
          await api.login(password)
          setAuthState('authenticated')
        }
      } catch (err: unknown) {
        const body = (err as { body?: { error?: string } })?.body
        setError(body?.error || t('auth.wrongPassword'))
      } finally {
        setSubmitting(false)
      }
    },
    [password, submitting, needsSetup, setAuthState, t],
  )

  const title = needsSetup ? t('auth.setPassword') : t('auth.login')

  return (
    <div style={wrapperStyle}>
      <div style={panelStyle}>
        <div className="corner-nails" style={panelStyle}>
          <div className="panel-title-bar" style={titleBarStyle}>
            <span style={{ fontFamily: READER_FONT, fontSize: 12 }}>{title}</span>
          </div>
          <form onSubmit={onSubmit} style={formStyle}>
            <label style={labelStyle} htmlFor="auth-password">
              {t('auth.password')}
            </label>
            <input
              id="auth-password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError('')
              }}
              style={inputStyle}
              disabled={submitting}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
            />
            {error && <p style={errorStyle}>{error}</p>}
            <button type="submit" disabled={!password || submitting} style={btnStyle} className="pixel-button">
              {submitting ? '...' : title}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  background: 'var(--bg-base)',
  padding: 16,
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  boxShadow: '4px 4px 0 0 var(--pixel-shadow)',
}

const titleBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '6px 12px',
}

const formStyle: React.CSSProperties = {
  padding: '16px 20px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const labelStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  fontFamily: READER_FONT,
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 0,
  color: 'var(--text-primary)',
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: READER_FONT,
  outline: 'none',
  width: 260,
}

const errorStyle: React.CSSProperties = {
  color: 'var(--danger)',
  fontSize: 12,
  fontFamily: READER_FONT,
  margin: 0,
}

const btnStyle: React.CSSProperties = {
  marginTop: 4,
  fontFamily: READER_FONT,
  fontSize: 13,
}
