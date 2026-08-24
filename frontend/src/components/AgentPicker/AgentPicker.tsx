import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'

interface AgentPickerProps {
  value: string | null
  onChange: (agentId: string | null) => void
  className?: string
  style?: React.CSSProperties
}

export function AgentPicker({
  value,
  onChange,
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
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.display_name}
        </option>
      ))}
    </select>
  )
}
