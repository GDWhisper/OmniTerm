import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'

/**
 * agent 上报的文件路径 → 点击在 FileManager 抽屉里打开。
 *
 * **数据来源是协议权威值**（ACP `ToolCallLocation.path`，见
 * `useAcpChat.ts` 的 `extractLocations`），不是从正文里猜出来的文件名，
 * 所以这里不做存在性校验：路径无效 / 是目录 / 越界时由 FileDrawer 展示
 * 后端返回的错误，不会静默失败。
 *
 * **性能契约**：不接收回调 props、不订阅 store，点击时才用
 * `useAppStore.getState()` 一次性读取。因此
 * - 不改变 `ChatMessageView` 的 props 签名，其 memo 契约
 *   （见 `ChatMessage.tsx` 的 docstring）完全不受影响；
 * - 不新增订阅，流式渲染期零新增重渲染成本。
 *
 * 用 props 透传 `onOpenFile` 会引入一个新的 useCallback 依赖，
 * 一旦引用漂移就让全部历史消息在流式期间逐帧重渲染 ——
 * `ChatView.tsx` 顶部的注释记录过这个坑。
 */
export function FileLocationLink({ path }: { path: string }) {
  const { t } = useTranslation()

  const open = () => {
    const { activeSessionId, revealFileInDrawer } = useAppStore.getState()
    // 聊天视图存在即有 activeSessionId；防御性兜底，不做 UI 反馈。
    if (!activeSessionId) return
    revealFileInDrawer(activeSessionId, path)
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
