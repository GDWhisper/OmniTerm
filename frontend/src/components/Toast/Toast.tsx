import { useToastStore, type ToastType } from '../../stores/toastStore'

const prefixMap: Record<ToastType, string> = {
  info: '★',
  success: '★',
  error: '✕',
  warning: '★',
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-4 py-3 text-sm animate-slide-in toast-pixel toast-${t.type}`}
          onClick={() => removeToast(t.id)}
        >
          <span className="flex-1">{prefixMap[t.type]} {t.message}</span>
          <button className="flex-shrink-0 opacity-60 hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  )
}
