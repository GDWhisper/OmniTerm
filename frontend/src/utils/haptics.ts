/** Short vibration confirming virtual-key / gesture interactions.
 *  iOS Safari does not implement the Vibration API — the optional call is a
 *  silent no-op there. Termius uses 10ms, Blink Shell 15ms. */
export const HAPTIC_TAP_MS = 10

export function hapticTap(durationMs: number = HAPTIC_TAP_MS): void {
  try {
    navigator.vibrate?.(durationMs)
  } catch {
    /* never break interaction on haptic failure */
  }
}
