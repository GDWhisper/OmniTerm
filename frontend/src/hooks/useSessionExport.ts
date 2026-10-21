import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '../api/client'
import { useAgentStore } from '../stores/agentStore'
import { useToastStore } from '../stores/toastStore'
import { decodeStoredBlocks } from './useAcpChat'
import { toChatMessages } from '../utils/storedMessages'
import { sessionToMarkdown } from '../utils/sessionMarkdown'
import { sessionMarkdownLabels } from '../utils/markdownI18n'
import { downloadMarkdown, exportFileName, fetchAllMessages } from '../utils/sessionExport'
import { sessionDisplayName } from '../utils/sessionDisplayName'

/**
 * 会话导出 Markdown（F08）的**编排**。
 *
 * 为什么是 hook 而不是 util：本编排需要三样东西——界面语言（`t`，产出导出件
 * 文案与 toast）、agent 注册表（产出导出件的 agent 名与会话显示名）、以及
 * toast 出口。把这三样塞进 util 会让 util 依赖 react-i18next 与 store，
 * 破坏「utils = 共享纯函数」的分层（口径同 `utils/sessionDisplayName.ts`：
 * 由调用方传入本地化文案）。放在 hook 里则由组件（Sidebar）注入上下文。
 *
 * 入口：**侧栏会话右键 / 长按菜单**的「导出为 Markdown」项
 * （`components/Sidebar/SessionContextMenu.tsx`）。导出的是**指定会话**的历史，
 * 与当前打开哪个会话无关——所以它不需要聊天面板在场。
 *
 * 取数独立于 store（计划 D2）：循环 `?before=<cursor>` 拉全量，导出件必须是
 * 全量会话，否则用户拿到的是「看起来完整、其实缺了前半段」的文件。
 */
export function useSessionExport() {
  const { t } = useTranslation()
  const agents = useAgentStore((s) => s.agents)
  const agentsLoaded = useAgentStore((s) => s.loaded)
  const loadAgents = useAgentStore((s) => s.loadAgents)

  // agent 注册表必须到位：导出件里的 agent 名、以及**未命名会话的显示名**
  // （默认名 `${agent}_${MMdd-HHmm}` 是展示期现算的，见 utils/sessionDisplayName.ts）
  // 都查它。别的面板（ChatView / 设置 / agent 选择器）也会加载它，但导出入口
  // 在侧栏——聊天面板没开过时它可能还没加载，故这里自己兜一份。
  useEffect(() => {
    if (!agentsLoaded) void loadAgents()
  }, [agentsLoaded, loadAgents])

  const exportSession = useCallback(
    async (session: Session) => {
      const toast = useToastStore.getState().addToast
      try {
        const { rows, truncated } = await fetchAllMessages(session.id)
        const messages = toChatMessages(rows, decodeStoredBlocks)
        const displayName = sessionDisplayName(session, agents, t('sidebar.unnamed'))
        const agentName = agents.find((a) => a.id === session.agent_id)?.display_name
        const result = sessionToMarkdown(messages, {
          agentName,
          sessionName: displayName,
          historyTruncated: truncated,
          labels: sessionMarkdownLabels(t),
        })
        downloadMarkdown(exportFileName(displayName), result.markdown)
        toast('success', t('chat.export.done', { count: result.includedMessages }))
        if (result.omittedMessages > 0) {
          toast('warning', t('chat.export.truncated', { count: result.omittedMessages }))
        }
        if (truncated) {
          // 拉取阶段就停了 = 更早的历史没拉全，导出件本身不完整——必须说清楚。
          toast('warning', t('chat.export.truncatedPages'))
        }
      } catch {
        toast('error', t('chat.export.failed'))
      }
    },
    [agents, t],
  )

  return { exportSession }
}
