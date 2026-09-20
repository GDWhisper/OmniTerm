import { useState } from 'react'
import { READER_FONT } from '../../utils/fonts'

const RING_SIZE = 15
const RING_STROKE = 2.5

function formatTokens(n: number): string {
  const fmt = (v: number) => {
    const rounded = Math.round(v * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (n >= 1e6) return `${fmt(n / 1e6)}M`
  if (n >= 1e3) return `${fmt(n / 1e3)}k`
  return String(n)
}

/** 上下文占用圆环。配色针对深棕木底徽章（`.title-bar-badge`）：轨道用半透明
 *  黑、进度用米色，超 80% 换浅红——原配置栏的 `--bg-surface`/`--accent` 在
 *  木底上对比度不足。 */
function UsageRing({ pct }: { pct: number }) {
  const r = (RING_SIZE - RING_STROKE) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      style={{ transform: 'rotate(-90deg)', display: 'block' }}
      aria-hidden="true"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke={pct > 80 ? '#FF9E94' : '#FAF2DE'}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped / 100)}
        style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease' }}
      />
    </svg>
  )
}

/**
 * 会话用量指示（上下文占用圆环 + 百分比 + 费用），渲染在聊天面板标题栏的状态
 * 徽章位（LIVE/DEAD 旁边）——用量是会话级状态，不属于底部的配置控制区。
 *
 * 木底外观依赖外层 `.panel-title-bar`（选择器 `.panel-title-bar
 * .title-bar-badge` 才生效），因此本组件只在标题栏内使用。
 *
 * `compact`（移动端）：只留圆环 + 百分比。费用文本约 40px，在 360px 宽的标题栏
 * 里会把模式徽章和 LIVE 徽章挤变形，代价大于收益；桌面端展示完整。
 */
export function UsageIndicator({
  usage,
  compact = false,
}: {
  usage: Record<string, unknown>
  compact?: boolean
}) {
  const [hover, setHover] = useState(false)
  const used = typeof usage['used'] === 'number' ? usage['used'] : null
  const size = typeof usage['size'] === 'number' ? usage['size'] : null
  const pct = used !== null && size !== null && size > 0 ? (used / size) * 100 : null
  const costObj = usage['cost']
  const cost = costObj && typeof costObj === 'object' && typeof (costObj as Record<string, unknown>)['amount'] === 'number'
    ? (costObj as Record<string, unknown>)['amount'] as number
    : null

  if (pct === null && cost === null) return null

  return (
    <span
      className="title-bar-badge"
      // position:relative 让明细浮层以徽章为锚；向下展开——标题栏贴在面板顶缘，
      // 向上弹出会被面板的 overflow clip 裁掉。
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: READER_FONT,
        fontSize: 10,
        letterSpacing: '0.02em',
        cursor: 'default',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {pct !== null && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <UsageRing pct={pct} />
          {Math.round(pct)}%
        </span>
      )}
      {cost !== null && !compact && <span style={{ opacity: 0.75 }}>${cost.toFixed(4)}</span>}
      {used !== null && size !== null && (
        <span
          className="pixel-float"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            marginTop: 6,
            padding: '3px 8px',
            fontSize: 11,
            whiteSpace: 'nowrap',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            opacity: hover ? 1 : 0,
            transform: hover
              ? 'translateX(-50%) translateY(0)'
              : 'translateX(-50%) translateY(-3px)',
            transition: 'opacity 0.15s ease, transform 0.15s ease',
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          {formatTokens(used)} / {formatTokens(size)}
        </span>
      )}
    </span>
  )
}
