import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'

const sectionTitleStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

const inputStyle: React.CSSProperties = {
  fontFamily: READER_FONT,
  fontSize: 12,
  padding: '5px 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: 0,
  background: 'transparent',
  color: 'var(--text)',
  width: '100%',
  outline: 'none',
}

const btnStyle: React.CSSProperties = {
  fontFamily: READER_FONT,
  fontSize: 12,
  padding: '5px 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: 0,
  background: 'transparent',
  cursor: 'pointer',
}

export function AuthSection() {
  const { t } = useTranslation()
  const setAuthState = useAppStore((s) => s.setAuthState)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch {
      // ignore network errors, still log out locally
    }
    setAuthState('unauthenticated')
  }

  const handleChangePw = async () => {
    setMsg(null)

    if (!currentPw || !newPw) {
      setMsg({ type: 'err', text: t('auth.fillAllFields') })
      return
    }
    if (newPw !== confirmPw) {
      setMsg({ type: 'err', text: t('auth.passwordMismatch') })
      return
    }
    if (newPw.length < 4) {
      setMsg({ type: 'err', text: t('auth.passwordTooShort') })
      return
    }

    setLoading(true)
    try {
      await api.changePassword(currentPw, newPw)
      setMsg({ type: 'ok', text: t('auth.passwordChanged') })
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 401) {
        setMsg({ type: 'err', text: t('auth.wrongPassword') })
      } else {
        setMsg({ type: 'err', text: t('auth.changePasswordFailed') })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="space-y-2">
      {/* ── Logout ── */}
      <h3 style={sectionTitleStyle}>{t('auth.loggedIn')}</h3>
      <button
        onClick={handleLogout}
        style={{ ...btnStyle, color: 'var(--danger)' }}
      >
        {t('auth.logout')}
      </button>

      {/* ── Change password ── */}
      <h3 style={{ ...sectionTitleStyle, marginTop: 16 }}>{t('auth.changePassword')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          type="password"
          placeholder={t('auth.currentPassword')}
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
          style={inputStyle}
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder={t('auth.newPassword')}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          style={inputStyle}
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder={t('auth.confirmNewPassword')}
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          style={inputStyle}
          autoComplete="new-password"
        />
        <button
          onClick={handleChangePw}
          disabled={loading}
          style={{
            ...btnStyle,
            color: loading ? 'var(--text-dim)' : 'var(--accent)',
            borderColor: loading ? 'var(--border)' : 'var(--accent)',
          }}
        >
          {loading ? '…' : t('auth.changePassword')}
        </button>
      </div>

      {msg && (
        <p style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: msg.type === 'ok' ? 'var(--success)' : 'var(--danger)',
        }}>
          {msg.text}
        </p>
      )}
    </section>
  )
}
