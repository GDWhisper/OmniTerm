import { useAppStore } from '../stores/appStore'

/** Short vibration confirming virtual-key / gesture interactions.
 *  iOS Safari does not implement the Vibration API — the optional call is a
 *  silent no-op there. Termius uses 10ms, Blink Shell 15ms. */
export const HAPTIC_TAP_MS = 10

export function hapticTap(durationMs: number = HAPTIC_TAP_MS): void {
  // Gated here so every call site respects Settings > Mobile > Haptics.
  if (!useAppStore.getState().mobileHapticEnabled) return
  try {
    navigator.vibrate?.(durationMs)
  } catch {
    /* never break interaction on haptic failure */
  }
}
