let audioCtx: AudioContext | null = null

function getContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function isSoundEnabled(): boolean {
  return localStorage.getItem('omniterm_sound_enabled') === 'true'
}

const VOLUME = 0.1

function playTone(frequency: number, duration: number, startTime: number, type: OscillatorType = 'square'): void {
  const ctx = getContext()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, startTime)
  gain.gain.setValueAtTime(VOLUME, startTime)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

export function play8BitSound(type: 'coin' | 'stomp'): void {
  if (!isSoundEnabled()) return
  const ctx = getContext()
  const now = ctx.currentTime

  if (type === 'coin') {
    playTone(800, 0.05, now)
    playTone(1200, 0.05, now + 0.05)
  } else {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(400, now)
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.1)
    gain.gain.setValueAtTime(VOLUME, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.1)
  }
}
