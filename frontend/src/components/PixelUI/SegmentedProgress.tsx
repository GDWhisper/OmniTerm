import type { FC } from 'react'

interface SegmentedProgressProps {
  label: string
  value: number
  max: number
  filledColor?: string
  emptyColor?: string
  className?: string
}

export const SegmentedProgress: FC<SegmentedProgressProps> = ({
  label,
  value,
  max,
  filledColor,
  emptyColor,
  className,
}) => {
  const safeMax = Math.max(max, 1)
  const clampedValue = Math.min(Math.max(value, 0), safeMax)

  return (
    <div className={`progress-segmented ${className ?? ''}`}>
      <div className="progress-segmented-label">
        <span>{label}</span>
        <span>{clampedValue}/{safeMax}</span>
      </div>
      <div
        className="progress-segmented-bar"
        role="progressbar"
        aria-valuenow={clampedValue}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-label={label}
      >
        {Array.from({ length: safeMax }).map((_, i) => {
          const isFilled = i < clampedValue
          return (
            <div
              key={i}
              className={`progress-segmented-segment ${isFilled ? 'filled' : ''}`}
              style={
                isFilled
                  ? filledColor ? { background: filledColor } : undefined
                  : emptyColor ? { background: emptyColor } : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}
