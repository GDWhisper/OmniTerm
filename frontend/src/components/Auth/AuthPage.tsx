import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { api, DEFAULT_USERNAME } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'
import { PixelButton } from '../PixelUI/PixelButton'

interface Props {
  needsSetup: boolean
}

/** 后端 `normalize_username` 的字符数上限（按 Unicode 码点计，非 UTF-16 码元）。 */
const MAX_USERNAME_CHARS = 32
/** Cc 类控制字符（C0 + DEL + C1），与后端 `char::is_control()` 同一集合。 */
// eslint-disable-next-line no-control-regex -- 判据就是要匹配控制字符本身
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/

export function AuthPage({ needsSetup }: Props) {
  const { t } = useTranslation()
  const setAuthState = useAppStore((s) => s.setAuthState)
  // Setup prefills the backend's default username (`admin`, D1); login leaves
  // it empty with a placeholder hint so existing installs know what to type.
  const [username, setUsername] = useState(needsSetup ? DEFAULT_USERNAME : '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const name = username.trim()
      if (!name || !password || submitting) return

      // 与后端 normalize_username 同一契约（1..=32 码点、禁控制字符）：本地先拦，
      // 免得明知 400 还打一次请求。空/全空白走上面的守卫（按钮同为 disabled），
      // 不按非法报错——后端 setup 对空串回退 admin，是兼容契约。
      if (Array.from(name).length > MAX_USERNAME_CHARS || CONTROL_CHARS_RE.test(name)) {
        setError(t('auth.invalidUsername'))
        return
      }

      setSubmitting(true)
      setError('')

      try {
        if (needsSetup) {
          await api.setup(name, password)
          setAuthState('authenticated')
        } else {
          await api.login(name, password)
          setAuthState('authenticated')
        }
      } catch (err: unknown) {
        // 用户名非法时后端返回的是**裸 400**（无 JSON body）：必须按状态码映射，
        // 否则会退化成「密码错误」误导用户（与 AuthSection 的处理一致）。
        if ((err as { status?: number })?.status === 400) {
          setError(t('auth.invalidUsername'))
          return
        }
        const body = (err as { body?: { error?: string } })?.body
        setError(body?.error || t('auth.wrongPassword'))
      } finally {
        setSubmitting(false)
      }
    },
    [username, password, submitting, needsSetup, setAuthState, t],
  )

  const title = needsSetup ? t('auth.setPassword') : t('auth.login')

  return (
    <div style={wrapperStyle}>
      <div className="corner-nails pixel-float" style={panelStyle}>
        <span className="nail-bl" />
        <span className="nail-br" />
        <div className="panel-title-bar" style={titleBarStyle}>
          <span style={{ fontFamily: READER_FONT, fontSize: 12 }}>{title}</span>
        </div>
        <form onSubmit={onSubmit} style={formStyle}>
          <label style={labelStyle} htmlFor="auth-username">
            {t('auth.username')}
          </label>
          <input
            id="auth-username"
            type="text"
            autoFocus={!needsSetup}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setError('')
            }}
            placeholder={needsSetup ? undefined : t('auth.usernamePlaceholderDefault')}
            style={inputStyle}
            disabled={submitting}
            autoComplete="username"
          />
          <label style={labelStyle} htmlFor="auth-password">
            {t('auth.password')}
          </label>
          <input
            id="auth-password"
            type="password"
            autoFocus={needsSetup}
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
          <PixelButton
            variant="primary"
            type="submit"
            disabled={!username.trim() || !password || submitting}
            style={{ marginTop: 4 }}
          >
            {submitting ? '...' : title}
          </PixelButton>
        </form>
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
