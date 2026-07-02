import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z" />
    </svg>
  )
}

export function IconFile(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2H5a1 1 0 00-1 1v10a1 1 0 001 1h6a1 1 0 001-1V5L9 2z" />
      <polyline points="9,2 9,5 12,5" />
    </svg>
  )
}

export function IconFilePlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9 2H5a1 1 0 00-1 1v10a1 1 0 001 1h6a1 1 0 001-1V5L9 2z" />
      <polyline points="9,2 9,5 12,5" />
      <line x1="8" y1="9" x2="8" y2="12" />
      <line x1="6.5" y1="10.5" x2="9.5" y2="10.5" />
    </svg>
  )
}

export function IconLink(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 9.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24l-1 1" />
      <path d="M9.5 6.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24l1-1" />
    </svg>
  )
}

export function IconArrowUp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <line x1="8" y1="13" x2="8" y2="3" />
      <polyline points="4,7 8,3 12,7" />
    </svg>
  )
}

export function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 2.5v4h4" />
      <path d="M2.8 6.5A5.5 5.5 0 1 1 3.5 10" />
    </svg>
  )
}

export function IconUpload(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 10V2" />
      <polyline points="5,5 8,2 11,5" />
      <path d="M2.5 10v2.5a1 1 0 001 1h9a1 1 0 001-1V10" />
    </svg>
  )
}

export function IconDownload(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2v8" />
      <polyline points="5,7 8,10 11,7" />
      <path d="M2.5 10v2.5a1 1 0 001 1h9a1 1 0 001-1V10" />
    </svg>
  )
}

export function IconFolderPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z" />
      <line x1="8" y1="7.5" x2="8" y2="10.5" />
      <line x1="6.5" y1="9" x2="9.5" y2="9" />
    </svg>
  )
}

export function IconCopy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1" />
      <path d="M2.5 11V3.5A.5.5 0 013 3h7.5" />
    </svg>
  )
}

export function IconPencil(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M11.5 2.5a1.77 1.77 0 012.5 2.5L5.5 13.5 2 14l.5-3.5L11.5 2.5z" />
    </svg>
  )
}

export function IconTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <polyline points="3,5 4,13 12,13 13,5" />
      <line x1="2" y1="5" x2="14" y2="5" />
      <path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5" />
      <line x1="7" y1="7.5" x2="7" y2="11" />
      <line x1="9" y1="7.5" x2="9" y2="11" />
    </svg>
  )
}

export function IconFolderOpen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 5V3.5A.5.5 0 013.5 3h3l1.5 2h4.5a.5.5 0 01.5.5V7" />
      <path d="M2 7.5l1.5 6h9l1.5-6H2z" />
    </svg>
  )
}

export function IconWarning(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2L1.5 13h13L8 2z" />
      <line x1="8" y1="6" x2="8" y2="9" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 8.5L8 3.5l5 5" />
      <path d="M5 7.5V13h2.5v-3h1v3H11V7.5" />
    </svg>
  )
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="6.5" cy="6.5" r="4" />
      <line x1="9.5" y1="9.5" x2="13" y2="13" />
    </svg>
  )
}

export function IconWorkbench(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 11l3-3-3-3" />
      <line x1="7.5" y1="11" x2="12.5" y2="11" />
    </svg>
  )
}

export function IconEye(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

export function IconEdit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M11.5 2.5a1.77 1.77 0 012.5 2.5L5.5 13.5 2 14l.5-3.5L11.5 2.5z" />
      <line x1="10" y1="4" x2="12" y2="6" />
    </svg>
  )
}

export function IconX(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  )
}
