import type { FC } from 'react'
import { useEffect, useState } from 'react'

export interface DialogueToastProps {
  message: string
  name?: string
  emotion?: string
  duration?: number
  onDone?: () => void
}

export const DialogueToast: FC<DialogueToastProps> = ({
  message,
  name,
  emotion,
  duration = 4000,
  onDone,
}) => {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const leaveTimer = setTimeout(() => setLeaving(true), duration - 300)
    const doneTimer = setTimeout(() => onDone?.(), duration)
    return () => {
      clearTimeout(leaveTimer)
      clearTimeout(doneTimer)
    }
  }, [duration, onDone])

  const parts = message.split(/(\{name\}|\{emotion\})/)

  return (
    <div
      className="dialogue-toast"
      style={leaving ? { animation: 'dialogue-toast-out 0.3s steps(3) forwards' } : undefined}
      role="status"
      aria-live="polite"
    >
      <span className="nail-bl" />
      <span className="nail-br" />
      <div>
        {parts.map((part, i) => {
          if (part === '{name}') return <span key={i} className="highlight-name">{name ?? ''}</span>
          if (part === '{emotion}') return <span key={i} className="highlight-emotion">{emotion ?? ''}</span>
          return <span key={i}>{part}</span>
        })}
      </div>
      <div className="dialogue-caret">&#x25BC;</div>
    </div>
  )
}
