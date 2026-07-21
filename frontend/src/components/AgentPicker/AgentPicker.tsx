import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'

interface AgentPickerProps {
  /** Selected agent id, or null for the tmux runtime (no agent). */
  value: string | null
  onChange: (agentId: string | null) => void
  /** Label for the "no agent" option (caller translates via i18n). */
  noneLabel?: string
  className?: string
  style?: React.CSSProperties
}

/**
 * Minimal agent selector for the create-session modal. P3-17: just a
 * <select> listing configured agents plus a "None (tmux)" option. Phase 4
 * will grow this into a richer card picker with agent previews.
 */
export function AgentPicker({
  value,
  onChange,
  noneLabel = 'None (tmux shell)',
  className,
  style,
}: AgentPickerProps) {
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
      <option value="">{noneLabel}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.display_name}
        </option>
      ))}
    </select>
  )
}
