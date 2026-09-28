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

export function IconArchive(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="2.5" width="12" height="3.25" />
      <path d="M3.25 5.75v7a1 1 0 001 1h7.5a1 1 0 001-1v-7" />
      <path d="M6.25 8.5h3.5" />
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

export function IconPhoto(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="5.5" cy="6.5" r="1.25" />
      <path d="M2.5 11.5l3-2.75 2.5 2.25 2-1.75 3.5 3" />
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

export function IconArrowDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <line x1="8" y1="3" x2="8" y2="13" />
      <polyline points="4,9 8,13 12,9" />
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

/**
 * 编辑文件**内容**：文档轮廓 + 折角 + 一支小铅笔。
 *
 * 与 `IconPencil` / `IconEdit` 刻意保持可分辨——那两者是同一支裸铅笔
 * （`IconEdit` 仅多一条 2px 斜线，在 16px 网格下约 1.1px，几乎不可见），
 * 而文件行的「编辑内容」与「重命名」是相邻按钮，同形会让用户只能靠
 * tooltip 区分（已由视觉核对实测确认）。文档矩形提供轮廓级区分。
 *
 * 构图约束（16×16 网格，stroke-width 1.5）：铅笔做小、置于文档右下角外侧，
 * 不与文档的内容行争空间——第一版把铅笔压在文档内部，16px 下糊成一片。
 */
export function IconFileEdit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      {/* 文档轮廓 + 折角 */}
      <path d="M9 2.5H4.75A1.25 1.25 0 003.5 3.75v8.5a1.25 1.25 0 001.25 1.25h6.5a1.25 1.25 0 001.25-1.25V6L9 2.5z" />
      <path d="M8.9 2.7V6h3.3" />
      {/* 内容行（两行即可，第三行的视觉重量留给铅笔） */}
      <path d="M5.4 8.4h3.2" />
      <path d="M5.4 10.6h2" />
      {/* 铅笔：缩小并外移到右下角，笔尖指向文档 */}
      <path d="M10.4 10.9l3-1.1.7.7-2.4 2.4-1.5.2z" />
      <path d="M12 9.8l.7.7" />
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

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <line x1="8" y1="3.5" x2="8" y2="12.5" />
      <line x1="3.5" y1="8" x2="12.5" y2="8" />
    </svg>
  )
}

export function IconPower(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <line x1="8" y1="2.5" x2="8" y2="7.5" />
      <path d="M5.75 5.1a4.5 4.5 0 1 0 4.5 0" />
    </svg>
  )
}

// Lucide 原生 24×24 路径；strokeWidth 2.25 使 16px 显示时等效本文件其余图标的 1.5px 描边
export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} viewBox="0 0 24 24" strokeWidth={2.25} {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function IconGitBranch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} viewBox="0 0 24 24" strokeWidth={2.25} {...props}>
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  )
}
export { IconGitBranch as IconBranch }

/** 批量操作：双行勾选列表（Sidebar 会话右键/长按菜单入口）。 */
export function IconListChecks(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="2.5" width="5" height="5" />
      <path d="M3.25 5l1.25 1.25L6.25 3.75" />
      <line x1="9.5" y1="5" x2="14" y2="5" />
      <rect x="2" y="8.5" width="5" height="5" />
      <path d="M3.25 11l1.25 1.25L6.25 9.75" />
      <line x1="9.5" y1="11" x2="14" y2="11" />
    </svg>
  )
}

