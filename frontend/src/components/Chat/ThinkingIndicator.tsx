import { memo, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'
import { THINKING_EFFECT_RENDERERS } from '../../utils/thinkingEffects'

/** 自适应帧率上限（高刷屏压到 90fps，削减无谓 layout 抖动；低刷屏跟着屏走）。 */
const MAX_FPS = 90

/**
 * Terminal-style status line shown at the bottom of the message stream for the
 * whole duration the agent is busy (`sending` === true, i.e. from prompt send
 * until `prompt_done`). Mimics a terminal's live last line so long-running
 * agent tasks (tool calls, waiting, thinking) never leave the view silent.
 *
 * 动画形态与显隐由设置（外观 → 等待动画）决定：`thinkingEffectId` 选样式
 * （乱码流 / 经典转圈 / 盲文点阵，注册表见 `utils/thinkingEffects.ts`），
 * `thinkingEffectEnabled` 为 false 时整体不渲染。该开关与「像素动效」开关
 * 无关——本指示器是状态指示器，两套开关互不联动。
 *
 * 帧文本直写 DOM（不进 React state）：thinking 阶段高频 appendThought 重渲染
 * 时，setInterval 宏任务会被密集渲染推迟，rAF 与渲染同调度且本函数零 React
 * 开销。切换特效会重启循环并重新计时（乱码流长度从头开始），属预期行为。
 */
export const ThinkingIndicator = memo(function ThinkingIndicator() {
  const enabled = useAppStore((s) => s.thinkingEffectEnabled)
  const effectId = useAppStore((s) => s.thinkingEffectId)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const startTimeRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const render = THINKING_EFFECT_RENDERERS[effectId]
    startTimeRef.current = Date.now()
    // 自适应帧率上限：rAF 回调频率本身等于浏览器实际刷新率，无需主动检测。
    let raf = 0
    let lastDraw = 0
    let minInterval = 1000 / MAX_FPS
    let lastTs = 0
    let lastText = ''
    const tick = (ts: number) => {
      // 首帧 + 顺带用两次 rAF 间隔推算刷新率（零额外测量成本）。
      if (lastTs > 0) {
        const interval = ts - lastTs
        if (interval > 0 && interval < minInterval) {
          minInterval = Math.max(1000 / MAX_FPS, 1000 / Math.round(1000 / interval))
        }
      }
      lastTs = ts
      if (textRef.current && ts - lastDraw >= minInterval) {
        lastDraw = ts
        const next = render(Date.now() - startTimeRef.current)
        // 转圈/盲文按节拍变化：多数 rAF 帧的输出与上帧相同，无变化即跳过 DOM 写。
        if (next !== lastText) {
          lastText = next
          textRef.current.textContent = next
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled, effectId])

  if (!enabled) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 12px 6px',
        fontFamily: 'var(--pixel-font-static)',
        fontSize: '0.923em',
        lineHeight: '20px',
        color: 'var(--text-faint)',
        letterSpacing: 'var(--pixel-tracking-sm)',
        userSelect: 'none',
      }}
    >
      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>▌</span>
      <span ref={textRef} style={{ fontFamily: READER_FONT, letterSpacing: 0 }} />
    </div>
  )
})
