import type { ReactElement, SVGProps } from 'react'
import type { ChatMessage } from '../../stores/chatStore'
import { extractMessageText } from '../../utils/messageText'
import { IconCopy, IconLink, IconPencil, IconRefresh } from '../FileManager/icons'

/**
 * 气泡动作注册表（D2）。动作的唯一真源：新增一个动作只需在此追加一行数据，
 * 桌面 hover 动作条与移动长按菜单共用同一数组（见 `MessageActionBar`）。
 * frontend-patterns「数据/渲染分离」约定：动作定义与渲染组件分离。
 */

/** 由 ChatView 注入的稳定回调（useCallback / useMemo 聚合），ChatMessageView
 *  memo 契约依赖其引用稳定。startEdit 由 ChatMessage 内部组装（编辑态是组件
 *  内部 state）；canEdit 反映「会话可编辑」能力（inputDisabled 时为 false）。 */
export interface MessageActionHandlers {
  /** 复制正文（D4：成功/失败 toast 由调用方处理）。 */
  copyMessage: (text: string) => void
  /** 引用到输入框：写入 chatStore.pendingInsert 通道（D7），ChatInput 消费。 */
  quoteMessage: (text: string) => void
  /** 进入编辑态（ChatMessage 内部 editing state 持有）。 */
  startEdit: (messageId: string) => void
  /** 重新生成最后一条 assistant（F02 现有语义）。 */
  regenerate: () => void
  /** 会话是否可编辑（inputDisabled 时为 false，edit 动作据此隐藏）。 */
  canEdit: boolean
  /** 是否可重新生成（inputDisabled / sending 时为 false，ChatView 不注入
   *  onRegenerate，动作据此隐藏，避免按钮可见但点击无效）。 */
  canRegenerate: boolean
}

export interface MessageActionContext {
  message: ChatMessage
  isLastAssistant: boolean
  handlers: MessageActionHandlers
}

export interface MessageAction {
  id: string
  Icon: (p: SVGProps<SVGSVGElement>) => ReactElement
  labelKey: string
  visible: (ctx: MessageActionContext) => boolean
  run: (ctx: MessageActionContext) => void
}

/** 消息是否有可复制/可引用的正文（system 返回空；assistant 需含 text 块）。 */
const hasText = (message: ChatMessage): boolean => extractMessageText(message) !== ''

export const messageActions: MessageAction[] = [
  {
    id: 'copy',
    Icon: IconCopy,
    labelKey: 'chat.msg.copy',
    visible: ({ message }) => !message.streaming && hasText(message),
    run: ({ message, handlers }) => {
      const text = extractMessageText(message)
      if (text) handlers.copyMessage(text)
    },
  },
  {
    id: 'quote',
    // 引用到输入框：IconLink 表达「链接到上文」语义（pencil 已被编辑占用）。
    Icon: IconLink,
    labelKey: 'chat.msg.quote',
    // streaming 期间正文仍在增长，引用会拿到半截内容（与复制同理）。
    visible: ({ message }) => !message.streaming && hasText(message),
    run: ({ message, handlers }) => {
      const text = extractMessageText(message)
      if (!text) return
      // 引用块：每行加 `> ` 前缀，保持 Markdown 引用语义；光标落在输入框末尾
      const quoted = text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      handlers.quoteMessage(quoted)
    },
  },
  {
    id: 'edit',
    Icon: IconPencil,
    labelKey: 'chat.msg.edit',
    // 仅 user 消息可编辑重发（F02 现有语义）；undelivered 不可编辑（现有
    // ChatMessage.tsx:565 条件）；streaming 期间无意义；会话不可编辑时隐藏。
    visible: ({ message, handlers }) =>
      handlers.canEdit &&
      message.role === 'user' &&
      !message.undelivered &&
      !message.streaming,
    run: ({ message, handlers }) => handlers.startEdit(message.id),
  },
  {
    id: 'regenerate',
    Icon: IconRefresh,
    labelKey: 'chat.msg.regenerate',
    // 仅最后一条 assistant 可重新生成（现有 ChatMessage.tsx:581 语义）；
    // system 事件标签不可重新生成；sending/不可连接时不注入 onRegenerate，
    // 动作隐藏（避免按钮可见但点击无效）。
    visible: ({ message, isLastAssistant, handlers }) =>
      handlers.canRegenerate &&
      message.role === 'assistant' &&
      isLastAssistant &&
      !message.streaming,
    run: ({ handlers }) => handlers.regenerate(),
  },
]
