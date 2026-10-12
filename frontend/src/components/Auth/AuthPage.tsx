import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api, DEFAULT_USERNAME } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'
import { isValidUsernameShape, MIN_PASSWORD_LEN } from '../../utils/authConstraints'
import { PixelButton } from '../PixelUI/PixelButton'

interface Props {
  needsSetup: boolean
}

export function AuthPage({ needsSetup }: Props) {
  const { t } = useTranslation()
  const setAuthState = useAppStore((s) => s.setAuthState)
  // Setup prefills the backend's default username (`admin`, D1); login leaves
  // it empty with a placeholder hint so existing installs know what to type.
  const [username, setUsername] = useState(needsSetup ? DEFAULT_USERNAME : '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 双提交硬守卫：state 更新要等重渲染才进闭包，极快的两次 submit 都能看到
  // submitting=false；ref 在首次提交的同步段立即置位，第二次直接拦下。
  const inFlightRef = useRef(false)

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const name = username.trim()
      if (!name || !password || submitting || inFlightRef.current) return

      // 与后端 normalize_username 同一契约（1..=32 码点、禁控制字符）：本地先拦，
      // 免得明知 400 还打一次请求。空/全空白走上面的守卫（按钮同为 disabled），
      // 不按非法报错——后端 setup 对空串回退 admin，是兼容契约。
      if (!isValidUsernameShape(name)) {
        setError(t('auth.invalidUsername'))
        return
      }

      // 设置密码时与 AuthSection 的 setup / 改密同一下限；登录不校验长度
      // （既有短密码不受新策略影响，输错自然 401）。
      if (needsSetup && password.length < MIN_PASSWORD_LEN) {
        setError(t('auth.passwordTooShort'))
        return
      }

      inFlightRef.current = true
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
        // 按状态码映射（与 AuthSection 的 400/401/429 处理一致）：用户名非法的**裸 400**
        //（无 JSON body）不能退化成「密码错误」；429（限流）要点明稍后重试；409（另一
        // 标签页已完成 setup）、5xx、无 status 的网络异常同样不能，它们不是密码问题。
        const status = (err as { status?: number })?.status
        const body = (err as { body?: { error?: string } })?.body
        if (status === 400) {
          setError(t('auth.invalidUsername'))
        } else if (status === 401) {
          setError(body?.error || t('auth.wrongPassword'))
        } else if (status === 429) {
          // LoginGuard 限流（5 次失败 / 5 分钟），后端为裸状态码、无 JSON body
          setError(t('auth.rateLimited'))
        } else {
          setError(body?.error || t('auth.loginFailed'))
        }
      } finally {
        inFlightRef.current = false
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
