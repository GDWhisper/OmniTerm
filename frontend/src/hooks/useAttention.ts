import { createContext, useContext } from 'react'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'

export const AttentionContext = createContext<AttentionContextValue | null>(null)

export function useAttention(): AttentionContextValue {
  const ctx = useContext(AttentionContext)
  if (!ctx) {
    throw new Error('useAttention must be used within an AttentionProvider')
  }
  return ctx
}

export type { AttentionReason, AttentionAlert, AttentionContextValue } from '../components/Attention/AttentionProvider'
