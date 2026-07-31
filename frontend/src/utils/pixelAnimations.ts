const THROTTLE_MS = 500
const lastTriggered = new WeakMap<HTMLElement, number>()

function isThrottled(el: HTMLElement): boolean {
  const now = Date.now()
  const last = lastTriggered.get(el) ?? 0
  if (now - last < THROTTLE_MS) return true
  lastTriggered.set(el, now)
  return false
}

function isAnimationsEnabled(): boolean {
  return localStorage.getItem('omniterm_pixel_animations') === 'true'
}

export function triggerBump(el: HTMLElement): void {
  if (!isAnimationsEnabled()) return
  if (isThrottled(el)) return
  el.classList.remove('pixel-bump')
  void el.offsetWidth
  el.classList.add('pixel-bump')
  el.addEventListener('animationend', () => el.classList.remove('pixel-bump'), { once: true })
}
