import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TOAST_AUTO_DISMISS_MS, useToastStore, type ToastType } from '../../stores/toastStore'

const prefixMap: Record<ToastType, string> = {
  info: '★',
  success: '★',
  error: '✕',
  warning: '★',
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  // z-index 必须严格高于 Modal 蒙版层（z-50）：Modal 经 createPortal 挂到
  // document.body 末尾，与 toast 同为 z-50 时 DOM 顺序后者居上，蒙版会把 toast
  // 整块盖住（用户实测：新建项目弹窗触发报错时右下角提示被半透蒙版遮住看不清）。
  // 仍远低于 CRT 扫描线（9999）与 tmux 健康告警横幅（10000），不抢它们的层级。
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
      ))}
    </div>
  )
}

interface ToastItemProps {
  toast: { id: number; type: ToastType; message: string }
  onDismiss: (id: number) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const { t } = useTranslation()
  const [paused, setPaused] = useState(false)
  const remainingRef = useRef(TOAST_AUTO_DISMISS_MS)

  useEffect(() => {
    if (paused) return
    const startedAt = Date.now()
    const timer = setTimeout(() => onDismiss(toast.id), Math.max(0, remainingRef.current))
    return () => {
      clearTimeout(timer)
      remainingRef.current -= Date.now() - startedAt
    }
  }, [paused, toast.id, onDismiss])

  return (
    <div
      className={`flex items-start gap-2 animate-slide-in toast-pixel toast-${toast.type}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* 报错信息常常很长且带无空格的长 token（路径/URL），需允许任意处换行；
          文字可选中是复制报错的前提，故整条 toast 不挂 onClick 关闭。 */}
      <span className="flex-1 select-text cursor-text" style={{ overflowWrap: 'anywhere' }}>
        {prefixMap[toast.type]} {toast.message}
      </span>
      <button
        type="button"
        className="flex-shrink-0 opacity-60 hover:opacity-100"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('toast.dismiss')}
      >
        ✕
      </button>
    </div>
  )
}
