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

export function triggerScorePop(el: HTMLElement, text = '+1 ✓'): void {
  if (!isAnimationsEnabled()) return
  if (isThrottled(el)) return

  const pop = document.createElement('span')
  pop.className = 'pixel-coin-pop'
  pop.textContent = text
  el.style.position = 'relative'
  el.appendChild(pop)
  pop.addEventListener('animationend', () => pop.remove(), { once: true })
}

export function triggerStomp(el: HTMLElement, onDone?: () => void): void {
  if (!isAnimationsEnabled()) {
    onDone?.()
    return
  }
  el.classList.add('pixel-stomp')
  el.addEventListener('animationend', () => {
    el.classList.remove('pixel-stomp')
    onDone?.()
  }, { once: true })
}

export function addStarman(el: HTMLElement): void {
  if (!isAnimationsEnabled()) return
  el.classList.add('pixel-starman')
}

export function removeStarman(el: HTMLElement): void {
  el.classList.remove('pixel-starman')
}
