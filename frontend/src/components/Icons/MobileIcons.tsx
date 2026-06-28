import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export function IconSessions(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      {/* 垂直镜像翻转后的阶梯横杠：从长到短自上而下 */}
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="5" y1="8" x2="13" y2="8" />
      <line x1="7" y1="12" x2="13" y2="12" />
    </svg>
  )
}

export function IconTerminal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      {/* 复用 IconWorkbench：终端提示符 */}
      <path d="M3.5 11l3-3-3-3" />
      <line x1="7.5" y1="11" x2="12.5" y2="11" />
    </svg>
  )
}

export function IconFiles(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      {/* 复用 IconFolder */}
      <path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z" />
    </svg>
  )
}
