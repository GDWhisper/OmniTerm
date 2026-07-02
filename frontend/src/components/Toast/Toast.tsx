import { useToastStore, type ToastType } from '../../stores/toastStore'

const iconMap: Record<ToastType, string> = {
  info: 'ℹ️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
}

const prefixMap: Record<ToastType, string> = {
  info: '★',
  success: '★',
  error: '✕',
  warning: '★',
}

const colorMap: Record<ToastType, string> = {
  info: 'bg-blue-50 dark:bg-blue-900/80 border-blue-200 dark:border-blue-700 text-blue-800 dark:text-blue-200',
  success: 'bg-green-50 dark:bg-green-900/80 border-green-200 dark:border-green-700 text-green-800 dark:text-green-200',
  error: 'bg-red-50 dark:bg-red-900/80 border-red-200 dark:border-red-700 text-red-800 dark:text-red-200',
  warning: 'bg-yellow-50 dark:bg-yellow-900/80 border-yellow-200 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200',
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-4 py-3 rounded-lg border shadow-lg text-sm animate-slide-in toast-pixel toast-${t.type} ${colorMap[t.type]}`}
          onClick={() => removeToast(t.id)}
        >
          <span className="flex-shrink-0">{iconMap[t.type]}</span>
          <span className="flex-1">{prefixMap[t.type]} {t.message}</span>
          <button className="flex-shrink-0 opacity-60 hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  )
}
