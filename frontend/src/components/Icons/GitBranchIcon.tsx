import type { SVGProps } from 'react'
import { IconGitBranch } from '../FileManager/icons'

export interface GitBranchIconProps extends SVGProps<SVGSVGElement> {
  size?: number
  color?: string
}

/** Git branch icon — mimics the classic git branch shape */
export function GitBranchIcon({ size, color, ...props }: GitBranchIconProps) {
  return (
    <IconGitBranch
      width={size ?? props.width}
      height={size ?? props.height}
      stroke={color ?? props.stroke}
      {...props}
    />
  )
}
