import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

/**
 * 自动消失时长。计时由 <ToastItem> 承担（而非这里一次性 setTimeout），
 * 这样 hover / 键盘聚焦时能暂停，用户才有机会选中并复制报错信息。
 */
export const TOAST_AUTO_DISMISS_MS = 4000

/** 同屏上限：超出丢弃最旧的，避免报错风暴把右下角堆满屏幕。 */
const MAX_TOASTS = 5

interface Toast {
  id: number
  type: ToastType
  message: string
}

interface ToastState {
  toasts: Toast[]
  addToast: (type: ToastType, message: string) => void
  removeToast: (id: number) => void
}

let nextId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message) => {
    const id = nextId++
    set((s) => {
      const toasts = [...s.toasts, { id, type, message }]
      return { toasts: toasts.slice(-MAX_TOASTS) }
    })
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
