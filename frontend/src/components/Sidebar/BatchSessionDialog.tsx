import { useTranslation } from 'react-i18next'
import { api, type AgentSideDeleteResult, type Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { readDeleteAgentSidePref, writeDeleteAgentSidePref } from '../../utils/deleteAgentSidePref'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import {
  buildAgentSideDeleteCheckbox,
  resolvePendingAgentSide,
  shouldRequestAgentSideDelete,
} from './agentSideDelete'

export type BatchAction = 'archive' | 'release' | 'delete'

export interface BatchTarget {
  action: BatchAction
  sessions: Session[]
}

/**
 * 批量会话操作的二次确认 + 执行。
 *
 * - 归档 / 释放仅作用于 ACP 会话（后端对非 ACP 返回 400）；终端会话被跳过，
 *   有跳过项时在 message 中另起一行提示。
 * - 串行执行、单条失败继续（错误 toast 由 api client 自动弹出），结束按成功
 *   数汇总；副作用逐条复刻单条路径（活跃会话清理 / markEnded /
 *   workspaceSessionMemory），见 DeleteConfirmDialog / releaseSessionNow。
 * - 批量删除额外带「同时永久删除 agent 侧会话记录」勾选框：**逐条**判据（仅
 *   「agent 已知不支持」的不带 `delete_agent_side=true`；进程未驻留由后端临时
 *   拉起补删），所以混合选择也不会对不满足条件的会话盲发。
 * - **不阻塞界面**：确认后立即关弹窗，串行执行在后台继续；每条可能临时拉起
 *   agent（秒级起步），不能把界面扣在模态上。结束按成功数汇总 toast（含 agent
 *   侧 deleted/skipped 计数），再退出选择模式并刷新列表。
 * - **两段式**：第一段（`DELETE /sessions/{id}`）返回 `pending` 的会话（进程不
 *   驻留）在第二段补发 agent 侧删除端点并补报计数——「已删除」先报，agent 侧
 *   结果稍后如实补报（不让秒级的拉起拖住第一段汇总）。
 */
export function BatchSessionDialog(props: {
  /** null = 关闭。 */
  target: BatchTarget | null
  onClose: () => void
  /**
   * 退出选择模式并刷新列表（Sidebar 提供）。调两次：确认瞬间先调一次——
   * 立即退出选择模式，避免执行期间对同一批会话重复下发操作（弹窗已关，
   * 再点删除会 404 报错）；全部执行完再调一次把列表刷新落定。
   */
  onDone: () => Promise<void>
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const workspaceSessionMemory = useAppStore((s) => s.workspaceSessionMemory)
  const clearWorkspaceSession = useAppStore((s) => s.clearWorkspaceSession)
  // 每个会话的能力位（capabilities 帧写入）；整对象订阅后按键取用。
  // 选择器返回 states 引用：帧到达时必然变化，够用且不额外分配。
  const chatStates = useChatStore((s) => s.states)

  const target = props.target
  const action: BatchAction = target?.action ?? 'archive'
  const sessions = target?.sessions ?? []
  // 归档 / 释放池 = ACP 会话（release 对已释放会话幂等返回 200，无需按 alive 过滤）
  const pool = action === 'delete' ? sessions : sessions.filter((s) => s.runtime_kind === 'acp')
  const skipped = sessions.length - pool.length

  // agent 侧删除勾选框：仅批量删除出现，且仅当选中项含 ACP 会话
  const { checkbox, eligibleIds } =
    action === 'delete'
      ? buildAgentSideDeleteCheckbox({
          candidates: pool.map((s) => ({ id: s.id, runtime_kind: s.runtime_kind })),
          capabilityOf: (id) => chatStates[id]?.agentDeleteSupported,
          defaultChecked: readDeleteAgentSidePref(),
          t,
        })
      : { checkbox: undefined, eligibleIds: new Set<string>() }

  const title =
    action === 'archive'
      ? t('sidebar.batchArchiveTitle')
      : action === 'release'
        ? t('sidebar.batchReleaseTitle')
        : t('sidebar.batchDeleteTitle')

  const baseMessage =
    action === 'archive'
      ? t('sidebar.batchArchiveConfirm', { count: pool.length })
      : action === 'release'
        ? t('sidebar.batchReleaseConfirm', { count: pool.length })
        : t('sidebar.batchDeleteConfirm', { count: pool.length })
  // 跳过提示另起一行（ConfirmDialog 的 message 走 whiteSpace: pre-line）
  const message =
    skipped > 0
      ? `${baseMessage}\n${t('sidebar.batchSkipUnsupported', { count: skipped })}`
      : baseMessage

  const handleConfirm = (agentSideChecked: boolean) => {
    if (!target) return
    // 立即关弹窗、不等待请求：批量条目可能各自临时拉起 agent（秒级起步），
    // 串行累加会把界面扣在模态上很久。执行在后台继续，结束按成功数汇总
    // toast（含 agent 侧 deleted/skipped 计数），并再刷新一次列表落定。
    props.onClose()
    // 立即退出选择模式并先刷一次列表：不给「执行期间对同一批再点一次删除」
    // 留重复提交窗口（行会被 3s 轮询 + 完成刷新收走）。
    void props.onDone()
    const ids = new Set(pool.map((s) => s.id))
    // 删除前先清活跃会话：停止 FileManager 等对即将被 kill 的会话的请求
    // （与 DeleteConfirmDialog.handleDeleteSession 同一顺序约定）
    if (action === 'delete' && activeSessionId && ids.has(activeSessionId)) {
      setActiveSession(null)
    }
    void (async () => {
      let succeeded = 0
      // agent 侧删除的如实交代：deleted / skipped 分开计数（不可把跳过报成已删）
      let agentSideDeleted = 0
      let agentSideSkipped = 0
      // 第一段返回 pending 的会话（进程不驻留）：行已删、后端不临时拉起，由第二段
      // 带着会话行上下文补发 agent 侧删除端点
      const pendingAgentSide: Session[] = []
      // 串行执行：避免 SQLite 写竞争与批量杀进程竞态（对齐 DuplicateProjectsDialog 先例）
      for (const session of pool) {
        try {
          if (action === 'archive') {
            await api.archiveSession(session.id)
            if (session.id === activeSessionId) setActiveSession(null)
          } else if (action === 'release') {
            await api.releaseSession(session.id)
            // 释放活跃会话：立即标记结束，使 ChatView 即时显示「恢复会话」
            if (session.id === activeSessionId) useChatStore.getState().markEnded(session.id)
          } else {
            const deleteAgentSide = shouldRequestAgentSideDelete(
              eligibleIds,
              session.id,
              agentSideChecked,
            )
            const res: { agent_side?: AgentSideDeleteResult } = await api.deleteSession(session.id, {
              deleteAgentSide,
            })
            if (deleteAgentSide) {
              if (res?.agent_side === 'deleted') agentSideDeleted += 1
              else if (res?.agent_side === 'pending') pendingAgentSide.push(session)
              else agentSideSkipped += 1
            }
            for (const wsId of Object.keys(workspaceSessionMemory)) {
              if (workspaceSessionMemory[wsId] === session.id) clearWorkspaceSession(wsId)
            }
          }
          succeeded += 1
        } catch {
          // 单条失败继续执行；错误 toast 由 api client 自动弹出
        }
      }
      // 记住用户的选择：仅在勾选框可用时（禁用态是系统限制，不是用户表达）
      if (action === 'delete' && checkbox && !checkbox.disabled) {
        writeDeleteAgentSidePref(agentSideChecked)
      }
      if (succeeded > 0) {
        addToast('success', t('sidebar.batchDone', { count: succeeded }) ?? `Processed ${succeeded} session(s)`)
      }
      // 第二段：补报 agent 侧结果（pending 的逐个临时拉起补删，秒级；第一段的
      // 「已删除」已报出，不让它等这里）。
      for (const session of pendingAgentSide) {
        const outcome = await resolvePendingAgentSide({
          agentId: session.agent_id,
          acpSessionId: session.acp_session_id,
          workspacePath: session.workspace_path,
        })
        if (outcome === 'deleted') agentSideDeleted += 1
        else agentSideSkipped += 1
      }
      if (agentSideDeleted > 0) {
        addToast('success', t('sidebar.agentSideDeletedCount', { count: agentSideDeleted }))
      }
      if (agentSideSkipped > 0) {
        addToast('warning', t('sidebar.agentSideSkippedCount', { count: agentSideSkipped }))
      }
      if (succeeded > 0) {
        await props.onDone()
      }
    })()
  }

  return (
    <ConfirmDialog
      open={!!target}
      onClose={props.onClose}
      onConfirm={() => handleConfirm(false)}
      onConfirmWithChecked={checkbox ? (checked: boolean) => handleConfirm(checked) : undefined}
      title={title}
      message={message}
      checkbox={checkbox}
      confirmText={action === 'release' ? t('sidebar.batchRelease') : action === 'archive' ? t('sidebar.archive') : t('sidebar.delete')}
      destructive={action === 'delete'}
    />
  )
}
