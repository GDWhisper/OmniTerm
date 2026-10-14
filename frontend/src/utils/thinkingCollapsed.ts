/**
 * ACP 思考块**收起态**展示的单一真源。
 *
 * 「展开思考」开关关闭时，思考块默认收起。此时有两种降级档位：
 * - `hide`：完全不显示思考内容（只有可点击展开的标题行）——历史行为；
 * - `brief`：在标题行下追加**一行**流式思考原文，随 chunk 自然增长。
 *
 * 收敛到本文件的有三样：档位枚举与选项数组（顺序即设置面板按钮顺序）、
 * localStorage 存档键与白名单读取，以及「显示简要」的单行取行规则。
 * 消费方是 `components/Chat/ChatMessage.tsx` 的 `ThoughtBlockView` 与
 * `components/Settings/Settings.tsx` 的会话区，两边不得各写一份。
 *
 * 新增档位 = ① 本文件 `ThinkingCollapsedMode` 联合类型加一项、
 * `THINKING_COLLAPSED_MODES` 加一条；② 两个 translation.json 加
 * `settings.thinkingCollapsed<Id>` 展示名 key。其余零改动。
 */

export type ThinkingCollapsedMode = 'hide' | 'brief'

export interface ThinkingCollapsedOption {
  id: ThinkingCollapsedMode
  labelKey: string
}

/** 选项数组，顺序即设置面板展示顺序（默认「完全隐藏」排最前）。 */
export const THINKING_COLLAPSED_MODES: readonly ThinkingCollapsedOption[] = [
  { id: 'hide', labelKey: 'settings.thinkingCollapsedHide' },
  { id: 'brief', labelKey: 'settings.thinkingCollapsedBrief' },
]

/** 默认档位：完全隐藏——与加此设置前的行为一致，老用户无感迁移。 */
export const DEFAULT_THINKING_COLLAPSED_MODE: ThinkingCollapsedMode = 'hide'

/** 档位存档键。 */
export const THINKING_COLLAPSED_STORAGE_KEY = 'omniterm_thinking_collapsed'

/** 严格白名单：存档值损坏时回落 null，绝不把脏值当档位提交。 */
export function parseThinkingCollapsedMode(raw: string | null): ThinkingCollapsedMode | null {
  return raw === 'hide' || raw === 'brief' ? raw : null
}

/** 读取档位：白名单校验后回落默认（完全隐藏）。 */
export function readThinkingCollapsedMode(storage: Storage = localStorage): ThinkingCollapsedMode {
  return parseThinkingCollapsedMode(storage.getItem(THINKING_COLLAPSED_STORAGE_KEY)) ?? DEFAULT_THINKING_COLLAPSED_MODE
}

/** 空白的最大码位：空格 / 制表 / 换行 / 回车及其他 C0 控制符（`'!'` = 33 起为可见字符）。 */
const SPACE_CODE = 32

/**
 * 「显示简要」的单行预览源：思考文本里**最后一个非空行**。
 *
 * 流式期间它正是正在生长的那一行，故预览随 chunk 自然增长——**不做任何总结、
 * 不改写、不截断字符**（用户明确要求「不总结、正常流式输出」）；单行收口由
 * 调用方的 CSS（`white-space: nowrap` + `text-overflow: ellipsis`）负责。
 *
 * 从尾部反向定位而非整篇 `split('\n')`：思考文本随 turn 累积可达数万字符，
 * 而 chunk 是逐词到达的，整篇 split 会把每次追加都变成 O(整篇)。先剥掉末尾
 * 空白（含 agent 分段用的连续空行），剩下的最后一个字符必然属于有效行，
 * 因此一次 `lastIndexOf` 定位即可，无需再向前逐行试错。
 */
export function thinkingPreviewLine(text: string): string {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) <= SPACE_CODE) end--
  if (end === 0) return ''
  const start = text.lastIndexOf('\n', end - 1) + 1
  // 行首只可能是缩进空白（换行符已被 lastIndexOf 吃掉），trim 掉即可。
  return text.slice(start, end).trim()
}
