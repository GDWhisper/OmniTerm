import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../../stores/agentStore'

interface AgentPickerProps {
  /** Selected agent id, or null for the tmux runtime (no agent). */
  value: string | null
  onChange: (agentId: string | null) => void
  className?: string
  style?: React.CSSProperties
}

/**
 * Minimal agent selector for the create-session modal.
 * Uses <optgroup> to visually separate tmux shell from ACP agents.
 */
export function AgentPicker({
  value,
  onChange,
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
      <optgroup label={t('agentPicker.groupTerminal')}>
        <option value="">{t('agentPicker.none')}</option>
      </optgroup>
      {agents.length > 0 && (
        <optgroup label={t('agentPicker.groupChat')}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
