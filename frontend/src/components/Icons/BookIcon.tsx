import type { SVGProps } from 'react'

export function BookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 3.5a1 1 0 011-1h7a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3.5z" />
      <path d="M5 2.5v12" />
    </svg>
  )
}
