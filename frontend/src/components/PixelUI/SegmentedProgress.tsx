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
}) => (
  <div className={`progress-segmented ${className ?? ''}`}>
    <div className="progress-segmented-label">
      <span>{label}</span>
      <span>{value}/{max}</span>
    </div>
    <div className="progress-segmented-bar">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className={`progress-segmented-segment ${i < value ? 'filled' : ''}`}
          style={
            i < value
              ? filledColor ? { background: filledColor } : undefined
              : emptyColor ? { background: emptyColor } : undefined
          }
        />
      ))}
    </div>
  </div>
)
