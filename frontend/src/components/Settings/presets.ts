import type { CreateAgent } from '../../api/client'

/**
 * 预设 Agent 模板（静态、低频变更）。
 *
 * 数据来源：复用 `/home/pax/coding/research/obsidian-agent-client`
 * 的 ACP 客户端预设，包含两部分：
 *   1. `src/plugin.ts` 的 `DEFAULT_SETTINGS` 内置客户端
 *      （Claude / Codex / Gemini）；
 *   2. `docs/agent-setup/custom-agents.md` 额外推荐的自定义 agent 示例
 *      （OpenCode / Qwen Code / Kiro）。
 * 仅映射 OmniTerm 支持的字段（display_name / command / args / env）。
 * 原项目带有 `apiKeySecretId`（指向 Obsidian 密钥存储），OmniTerm 无该
 * 体系，凭据由 agent 进程自身负责（见 api/client.ts `Agent` 注释），故不映射。
 *
 * 增/改预设改本文件即可；说明文案（参考说明）走两个
 * `frontend/src/locales/{en,zh}/translation.json` 的 `settings.agents.preset.*` key。
 */

export interface AgentPreset extends CreateAgent {
  /** 面板展示用的简短标签（i18n key） */
  labelKey: string
  /** 一键填入后的提示文案（i18n key） */
  hintKey: string
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    labelKey: 'settings.agents.preset.claude.label',
    hintKey: 'settings.agents.preset.claude.hint',
    display_name: 'Claude Code',
    command: 'claude-agent-acp',
    args: [],
    env: [],
  },
  {
    labelKey: 'settings.agents.preset.codex.label',
    hintKey: 'settings.agents.preset.codex.hint',
    display_name: 'Codex',
    command: 'codex-acp',
    args: [],
    env: [],
  },
  {
    labelKey: 'settings.agents.preset.gemini.label',
    hintKey: 'settings.agents.preset.gemini.hint',
    display_name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: [],
  },
  {
    labelKey: 'settings.agents.preset.opencode.label',
    hintKey: 'settings.agents.preset.opencode.hint',
    display_name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    env: [],
  },
  {
    labelKey: 'settings.agents.preset.qwen.label',
    hintKey: 'settings.agents.preset.qwen.hint',
    display_name: 'Qwen Code',
    command: 'qwen',
    args: ['--experimental-acp'],
    env: [],
  },
  {
    labelKey: 'settings.agents.preset.kiro.label',
    hintKey: 'settings.agents.preset.kiro.hint',
    display_name: 'Kiro',
    command: 'kiro-cli',
    args: ['acp'],
    env: [],
  },
]
