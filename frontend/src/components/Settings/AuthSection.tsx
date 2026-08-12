import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { ToggleRow } from './toggleRow'

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
  const authEnabled = useAppStore((s) => s.authEnabled)
  const setAuthEnabled = useAppStore((s) => s.setAuthEnabled)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // Master-switch modals
  const [disableOpen, setDisableOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  /** 'setup' = no password exists yet → ask for new + confirm; 'verify' = one already exists → ask for it. */
  const [enableMode, setEnableMode] = useState<'setup' | 'verify'>('setup')
  const [setupPw, setSetupPw] = useState('')
  const [setupConfirmPw, setSetupConfirmPw] = useState('')
  const [setupMsg, setSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [switchBusy, setSwitchBusy] = useState(false)

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

  /** Toggle pressed: enabling goes through a password form (set-up or verify), disabling through a confirm modal. */
  const handleToggle = async () => {
    if (authEnabled) {
      setDisableOpen(true)
      return
    }
    setSwitchBusy(true)
    try {
      const res = await api.check()
      // Never flip the master switch straight away: with auth off there is no
      // valid session cookie, so the next protected request would 401 and the
      // app would hard-jump to the login page. Ask for the password first.
      setEnableMode(res.needs_setup ? 'setup' : 'verify')
      setSetupMsg(null)
      setSetupPw('')
      setSetupConfirmPw('')
      setSetupOpen(true)
    } catch {
      // silent: modal path re-checks; direct path shows nothing extra
    } finally {
      setSwitchBusy(false)
    }
  }

  const handleConfirmDisable = async () => {
    setSwitchBusy(true)
    try {
      await api.setAuthSettings(false)
      setAuthEnabled(false)
      setDisableOpen(false)
    } catch {
      setMsg({ type: 'err', text: t('auth.disableFailed') })
      setDisableOpen(false)
    } finally {
      setSwitchBusy(false)
    }
  }

  /** Enable when no password exists yet: create the user, flip the switch, then sign the user out so they log in with the new password. */
  const handleSetupEnable = async () => {
    setSetupMsg(null)
    if (setupPw.length < 4) {
      setSetupMsg({ type: 'err', text: t('auth.passwordTooShort') })
      return
    }
    if (setupPw !== setupConfirmPw) {
      setSetupMsg({ type: 'err', text: t('auth.passwordMismatch') })
      return
    }
    setSwitchBusy(true)
    try {
      await api.setup(setupPw) // creates the user + issues a session cookie
      await api.setAuthSettings(true) // flip the master switch
      setAuthEnabled(true)
      setSetupOpen(false)
      setSetupPw('')
      setSetupConfirmPw('')
      // Deliberately re-enter the login flow: the setup cookie must not keep
      // the session open silently, and the user asked for a fresh sign-in.
      await api.logout().catch(() => {})
      setAuthState('unauthenticated')
    } catch {
      setSetupMsg({ type: 'err', text: t('auth.enableFailed') })
    } finally {
      setSwitchBusy(false)
    }
  }

  /** Enable when a password already exists: verify it (fresh cookie), then flip the switch and stay signed in. */
  const handleVerifyEnable = async () => {
    setSetupMsg(null)
    if (!setupPw) {
      setSetupMsg({ type: 'err', text: t('auth.fillAllFields') })
      return
    }
    setSwitchBusy(true)
    try {
      await api.login(setupPw) // verify the current password → new session cookie
      await api.setAuthSettings(true) // flip the master switch
      setAuthEnabled(true)
      setSetupOpen(false)
      setSetupPw('')
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 401) {
        setSetupMsg({ type: 'err', text: t('auth.wrongPassword') })
      } else {
        setSetupMsg({ type: 'err', text: t('auth.enableFailed') })
      }
    } finally {
      setSwitchBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      {/* ── Password verification master switch ── */}
      <ToggleRow
        labelKey="auth.passwordAuth"
        hintKey={authEnabled ? 'auth.passwordAuthHintOn' : 'auth.passwordAuthHintOff'}
        value={authEnabled}
        onToggle={handleToggle}
        dangerHint={!authEnabled}
      />

      {authEnabled && (
        <>
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
        </>
      )}

      {/* ── Disable confirmation modal ── */}
      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title={t('auth.disableAuthTitle')}
      >
        <div className="space-y-4">
          <p style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.6 }}>
            {t('auth.disableAuthText')}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => setDisableOpen(false)}>
              {t('auth.keepEnabled')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleConfirmDisable} disabled={switchBusy}>
              {t('auth.disable')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Enable: set-up new password or verify existing one ── */}
      <Modal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title={enableMode === 'setup' ? t('auth.setPassword') : t('auth.enableAuthTitle')}
      >
        <div className="space-y-4">
          {enableMode === 'setup' ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {t('auth.setupPasswordText')}
              </p>
              <input
                type="password"
                placeholder={t('auth.newPassword')}
                value={setupPw}
                onChange={(e) => setSetupPw(e.target.value)}
                style={inputStyle}
                autoComplete="new-password"
              />
              <input
                type="password"
                placeholder={t('auth.confirmNewPassword')}
                value={setupConfirmPw}
                onChange={(e) => setSetupConfirmPw(e.target.value)}
                style={inputStyle}
                autoComplete="new-password"
              />
            </>
          ) : (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {t('auth.enableAuthCurrentPwText')}
              </p>
              <input
                type="password"
                placeholder={t('auth.currentPassword')}
                value={setupPw}
                onChange={(e) => setSetupPw(e.target.value)}
                style={inputStyle}
                autoComplete="current-password"
              />
            </>
          )}
          {setupMsg && (
            <p style={{ fontSize: 11, color: 'var(--danger)', lineHeight: 1.5 }}>
              {setupMsg.text}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => setSetupOpen(false)}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton
              variant="accent"
              onClick={enableMode === 'setup' ? handleSetupEnable : handleVerifyEnable}
              disabled={switchBusy}
            >
              {t('auth.enable')}
            </PixelButton>
          </div>
        </div>
      </Modal>
    </section>
  )
}
