import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore, type Agent } from '../../stores/agentStore'
import type { AgentEnvVar, CreateAgent, UpdateAgent } from '../../api/client'
import { READER_FONT } from '../../utils/fonts'
import { AGENT_PRESETS } from './presets'

/**
 * Agent CRUD panel rendered inside the Settings popup under the "Agents"
 * tab (P3-18). The list is small in practice (a handful of configured
 * agents), so we keep everything inline: an editable form for the selected
 * agent plus a "New" button that switches the form into create mode.
 *
 * Phase 4 may split this into its own modal to make room for richer
 * editing (drag-drop env rows, command autocomplete, etc.).
 */

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
  fontFamily: READER_FONT,
}

const inputClass = 'w-full px-2 py-1.5 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

const btnBase: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: READER_FONT,
  color: 'var(--text-muted)',
  fontSize: 11,
  padding: '4px 10px',
}

type FormState = {
  id: string
  display_name: string
  command: string
  args_text: string
  env: AgentEnvVar[]
  isNew: boolean
}

function emptyForm(): FormState {
  return {
    id: '',
    display_name: '',
    command: '',
    args_text: '',
    env: [],
    isNew: true,
  }
}

function formFromAgent(a: Agent): FormState {
  return {
    id: a.id,
    display_name: a.display_name,
    command: a.command,
    args_text: a.args.join(' '),
    env: a.env.map((e) => ({ ...e })),
    isNew: false,
  }
}

export function AgentSettings() {
  const { t } = useTranslation()
  const agents = useAgentStore((s) => s.agents)
  const loaded = useAgentStore((s) => s.loaded)
  const loadAgents = useAgentStore((s) => s.loadAgents)
  const createAgent = useAgentStore((s) => s.createAgent)
  const updateAgent = useAgentStore((s) => s.updateAgent)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const testAgent = useAgentStore((s) => s.testAgent)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)

  useEffect(() => {
    if (!loaded) loadAgents()
  }, [loaded, loadAgents])

  const selectAgent = (id: string | null) => {
    setSelectedId(id)
    setTestResult(null)
    if (id == null) {
      setForm(emptyForm())
      return
    }
    const a = agents.find((x) => x.id === id)
    if (a) setForm(formFromAgent(a))
  }

  const startNew = () => {
    setSelectedId(null)
    setForm(emptyForm())
    setTestResult(null)
  }

  const applyPreset = (preset: (typeof AGENT_PRESETS)[number]) => {
    setSelectedId(null)
    setTestResult(null)
    setForm({
      id: '',
      display_name: preset.display_name,
      command: preset.command,
      args_text: preset.args.join(' '),
      env: preset.env.map((e) => ({ ...e })),
      isNew: true,
    })
  }

  const addEnvRow = () => {
    setForm((f) => ({ ...f, env: [...f.env, { key: '', value: '' }] }))
  }
  const updateEnv = (i: number, patch: Partial<AgentEnvVar>) => {
    setForm((f) => ({
      ...f,
      env: f.env.map((e, idx) => (idx === i ? { ...e, ...patch } : e)),
    }))
  }
  const removeEnv = (i: number) => {
    setForm((f) => ({ ...f, env: f.env.filter((_, idx) => idx !== i) }))
  }

  const handleSave = async () => {
    const args = form.args_text
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const env = form.env.filter((e) => e.key.trim() !== '')

    const payload: CreateAgent | UpdateAgent = form.isNew
      ? ({
          display_name: form.display_name.trim(),
          command: form.command.trim(),
          args,
          env,
        } satisfies CreateAgent)
      : ({
          display_name: form.display_name.trim() || undefined,
          command: form.command.trim() || undefined,
          args,
          env,
        } satisfies UpdateAgent)

    if (!payload.display_name || !payload.command) return
    setSaving(true)
    try {
      if (form.isNew) {
        const created = await createAgent(payload as CreateAgent)
        setSelectedId(created.id)
        setForm(formFromAgent(created))
      } else {
        const updated = await updateAgent(form.id, payload as UpdateAgent)
        setForm(formFromAgent(updated))
      }
    } catch {
      // api client already toasts
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (form.isNew || !form.id) return
    setSaving(true)
    try {
      await deleteAgent(form.id)
      setSelectedId(null)
      setForm(emptyForm())
    } catch {
      // api client already toasts
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (form.isNew || !form.id) return
    setTesting(true)
    setTestResult(null)
    try {
      await testAgent(form.id)
      setTestResult('ok')
    } catch {
      setTestResult('fail')
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="space-y-3">
      <h3
        style={{
          color: 'var(--text-muted)',
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {t('settings.agents.title')}
      </h3>

      <div className="flex flex-wrap gap-1.5">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => selectAgent(a.id)}
            style={{
              ...btnBase,
              ...(selectedId === a.id
                ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' }
                : {}),
            }}
          >
            {a.display_name}
          </button>
        ))}
        <button
          type="button"
          onClick={startNew}
          style={{
            ...btnBase,
            ...(selectedId == null && form.isNew
              ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' }
              : {}),
          }}
        >
          + {t('settings.agents.new')}
        </button>
      </div>

      <details className="rounded-md px-2.5 py-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <summary className="cursor-pointer select-none text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {t('settings.agents.presetsHint')}
        </summary>
        <div className="flex flex-wrap gap-1.5 pt-2">
          {AGENT_PRESETS.map((p) => (
            <button
              key={p.labelKey}
              type="button"
              onClick={() => applyPreset(p)}
              style={btnBase}
              title={t(p.hintKey)}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>
        <p className="pt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.agents.reference')}
        </p>
      </details>

      <div className="space-y-2 pt-1">
        <Field label={t('settings.agents.displayName')}>
          <input
            className={inputClass}
            style={inputStyle}
            value={form.display_name}
            onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
            placeholder="Claude Code"
          />
        </Field>
        <Field label={t('settings.agents.command')}>
          <input
            className={inputClass}
            style={inputStyle}
            value={form.command}
            onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
            placeholder="claude"
          />
        </Field>
        <Field label={t('settings.agents.args')}>
          <input
            className={inputClass}
            style={inputStyle}
            value={form.args_text}
            onChange={(e) => setForm((f) => ({ ...f, args_text: e.target.value }))}
            placeholder="--dangerously-skip-permissions"
          />
        </Field>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('settings.agents.env')}
            </label>
            <button type="button" onClick={addEnvRow} style={btnBase}>
              + {t('settings.agents.addEnv')}
            </button>
          </div>
          {form.env.map((e, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <input
                className={inputClass}
                style={inputStyle}
                value={e.key}
                placeholder="KEY"
                onChange={(ev) => updateEnv(i, { key: ev.target.value })}
              />
              <input
                className={inputClass}
                style={inputStyle}
                value={e.value}
                placeholder="value"
                onChange={(ev) => updateEnv(i, { value: ev.target.value })}
              />
              <button type="button" onClick={() => removeEnv(i)} style={btnBase}>
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {!form.isNew && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              style={{ ...btnBase, color: 'var(--danger, #c44)' }}
            >
              {t('settings.agents.delete')}
            </button>
          )}
          {!form.isNew && (
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving}
              style={{
                ...btnBase,
                ...(testResult === 'ok'
                  ? { borderColor: 'var(--success, #4a4)', color: 'var(--success, #4a4)' }
                  : testResult === 'fail'
                    ? { borderColor: 'var(--danger, #c44)', color: 'var(--danger, #c44)' }
                    : {}),
              }}
            >
              {testing
                ? t('settings.agents.testing')
                : testResult === 'ok'
                  ? t('settings.agents.testOk')
                  : testResult === 'fail'
                    ? t('settings.agents.testFail')
                    : t('settings.agents.test')}
            </button>
          )}
          <button type="button" onClick={handleSave} disabled={saving} style={btnBase}>
            {saving ? t('settings.agents.saving') : t('settings.agents.save')}
          </button>
        </div>
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
