import { useTranslation } from 'react-i18next'
import type { Session } from '../../api/client'
import { ContextMenu, type ContextMenuPoint } from '../Common/ContextMenu'
import { IconDownload, IconListChecks, IconPencil } from '../FileManager/icons'

export interface SessionContextMenuState extends ContextMenuPoint {
  session: Session
}

/**
 * 会话行上下文菜单（桌面右键 / 移动端长按共用）。状态由 Sidebar 持有并
 * 提升为单实例——菜单项「批量操作」需要进入选择模式并预选当前会话，
 * 属于 Sidebar 级状态。
 */
export function SessionContextMenu(props: {
  /** null = 不渲染菜单。 */
  menu: SessionContextMenuState | null
  onClose: () => void
  onBatchMode: (session: Session) => void
  onRename: (session: Session) => void
  /** 导出该会话为 Markdown 文件（仅 ACP 会话有聊天历史可导）。 */
  onExport: (session: Session) => void
}) {
  const { t } = useTranslation()
  const { menu, onClose } = props

  if (!menu) return null

  // 导出只对 ACP 会话开放：终端（tmux/pty）会话没有 chat_messages，
  // 导出必然是空文件——与其给一个点不出结果的菜单项，不如不显示。
  const exportable = menu.session.runtime_kind === 'acp'

  return (
    <ContextMenu
      point={{ x: menu.x, y: menu.y }}
      onClose={onClose}
      items={[
        {
          id: 'batch',
          icon: <IconListChecks width={14} height={14} />,
          label: t('sidebar.batchMode'),
          run: () => props.onBatchMode(menu.session),
        },
        {
          id: 'rename',
          icon: <IconPencil width={14} height={14} />,
          label: t('sidebar.rename'),
          run: () => props.onRename(menu.session),
        },
        ...(exportable
          ? [
              {
                id: 'export',
                icon: <IconDownload width={14} height={14} />,
                label: t('chat.export.label'),
                run: () => props.onExport(menu.session),
              },
            ]
          : []),
      ]}
    />
  )
}
