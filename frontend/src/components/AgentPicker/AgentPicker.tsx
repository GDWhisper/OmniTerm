import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../../stores/agentStore'

interface AgentPickerProps {
  value: string | null
  onChange: (agentId: string | null) => void
  /** 上次成功创建 ACP 会话用过的 agent id，其选项文本追加「上次选择」后缀 */
  lastUsedId?: string | null
  className?: string
  style?: React.CSSProperties
}

export function AgentPicker({
  value,
  onChange,
  lastUsedId,
  className,
  style,
}: AgentPickerProps) {
  const { t } = useTranslation()
  const agents = useAgentStore((s) => s.agents)
  const loaded = useAgentStore((s) => s.loaded)
  const loadAgents = useAgentStore((s) => s.loadAgents)

  useEffect(() => {
    if (!loaded) loadAgents()
  }, [loaded, loadAgents])

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={className}
      style={style}
    >
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.id === lastUsedId
            ? `${a.display_name}${t('agentPicker.lastUsedSuffix')}`
            : a.display_name}
        </option>
      ))}
    </select>
  )
}
