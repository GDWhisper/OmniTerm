import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { revealReportedPath } from '../../utils/reportedPath'

/**
 * agent 上报的文件路径 → 点击在 FileManager 抽屉里打开或导航到目录。
 *
 * **数据来源是协议权威值**（ACP `ToolCallLocation.path`，见
 * `useAcpChat.ts` 的 `extractLocations`）。
 *
 * **性能契约**：不接收回调 props、不订阅 store，点击时才用
 * `useAppStore.getState()` 一次性读取（收敛在 `revealReportedPath`）。
 */
export function FileLocationLink({ path }: { path: string }) {
  const { t } = useTranslation()

  const open = () => {
    // 聊天视图存在即有 activeSessionId；防御性兜底，不做 UI 反馈。
    revealReportedPath(path)
  }

  return (
    <button
      onClick={open}
      title={t('chat.msg.openFile')}
      style={{
        display: 'block',
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        // Markdown 里的链接同色（Markdown.tsx 的 `a` 渲染器），聊天内
        // 「可点击文本」统一用 accent。
        color: 'var(--accent)',
        fontFamily: READER_FONT,
        fontSize: 'inherit',
        lineHeight: 1.5,
        textAlign: 'left',
        wordBreak: 'break-all',
      }}
      // hover 态直接改 style（同 FilePreview 的下载按钮），不引入 state,
      // 避免每次 hover 触发重渲染。
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'underline'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
    >
      ▸ {path}
    </button>
  )
}
