/**
 * ACP 思考块展示行为的单一真源：**收起态档位**与**完成后自动折叠**两项设置。
 *
 * 一、收起态档位（「展开思考」开关关闭时才有语义）。思考块默认收起，此时
 * 有两种降级档位：
 * - `hide`：完全不显示思考内容（只有可点击展开的标题行）——历史行为；
 * - `brief`：在标题行内嵌**一行**流式思考原文，随 chunk 自然增长。
 *
 * 二、完成后自动折叠（对齐 ZCode：运行中展开观看 → 完成后回到摘要）。布尔
 * 设置，默认开：流式结束后把展开中的思考块折成「思考 · 持续了 N 秒」。
 *
 * 收敛到本文件的有：档位枚举与选项数组（顺序即设置面板按钮顺序）、两项
 * 设置的 localStorage 存档键与读取，以及「显示简要」的单行取行规则。
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

/**
 * 「思考完成后自动折叠」存档键。
 *
 * 与档位键分开存：两者语义独立——档位管「收起时显示什么」，本项管「流式结束
 * 后要不要从展开态折回来」，互不复位（和「展开思考」开关三者都独立）。
 */
export const THINKING_AUTO_COLLAPSE_STORAGE_KEY = 'omniterm_thinking_autocollapse'

/**
 * 默认**开启**（用户 2026-10-14 选定）。
 *
 * 流式结束后自动把展开中的思考块折成「思考 · 持续了 N 秒」是 ZCode 的既有
 * 行为；不自动折会让长串思考过程永久摊开在聊天流里。关掉它的用户仍可用
 * 「展开思考」开关得到旧的「始终展开」行为。
 */
export const DEFAULT_THINKING_AUTO_COLLAPSE = true

/**
 * 读取「完成后自动折叠」开关。
 *
 * 判 `!== 'false'` 而非 `=== 'true'`：默认值为 true，故只有**显式存过
 * 'false'** 才关。存档损坏 / 被写进任意脏值时一律回落默认（开）——宁可
 * 多折一次让用户点开，也不要因为一个脏值把功能静默关掉。
 */
export function readThinkingAutoCollapse(storage: Storage = localStorage): boolean {
  return storage.getItem(THINKING_AUTO_COLLAPSE_STORAGE_KEY) !== 'false'
}

/** 空白的最大码位：空格 / 制表 / 换行 / 回车及其他 C0 控制符（`'!'` = 33 起为可见字符）。 */
const SPACE_CODE = 32

/**
 * 「显示简要」的单行预览源：思考文本里**最后一个非空行**。
 *
 * 流式期间它正是正在生长的那一行，故预览随 chunk 自然增长——**不做任何总结、
 * 不改写、不截断字符**（用户明确要求「不总结、正常流式输出」）；单行收口由
 * 调用方负责：视口 `overflow: hidden` 并把 `scrollLeft` 推到末尾，让最新 token
 * 始终可见（早前用 `text-overflow: ellipsis`，会冻结旧前缀、把新内容裁掉）。
 *
 * 从尾部反向定位而非整篇 `split('\n')`：思考文本随 turn 累积可达数万字符，
 * 而 chunk 是逐词到达的，整篇 split 会把每次追加都变成 O(整篇)。先剥掉末尾
 * 空白（含 agent 分段用的连续空行），剩下的最后一个字符必然属于有效行，
 * 因此一次 `lastIndexOf` 定位即可，无需再向前逐行试错。
 *
 * 返回 `null` 表示全文皆空白——调用方据此不渲染预览行。
 */
export interface ThinkingStreamingSummary {
  /**
   * 该行首字符在原文中的偏移量，字符串化后供 React 当 key。
   *
   * 取偏移而非行号：行号要从头数换行符，O(整篇)；偏移由 `lastIndexOf` 直接
   * 给出，O(行长)。语义上也正好——同一行在流式生长期间偏移不变（不重挂载、
   * 不重放动画），换行时偏移改变（触发一次纵向滚入动画）。
   */
  key: string
  /** 该行去首尾空白后的文本。 */
  text: string
}

export function resolveThinkingStreamingSummary(text: string): ThinkingStreamingSummary | null {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) <= SPACE_CODE) end--
  if (end === 0) return null
  const start = text.lastIndexOf('\n', end - 1) + 1
  // 行首只可能是缩进空白（换行符已被 lastIndexOf 吃掉），trim 掉即可。
  // 这里不需要再判空：末尾空白已剥，text[end-1] 必为非空白，故 start < end
  // 且切片里至少含一个非空白字符（写空值分支会成死代码）。
  return { key: String(start), text: text.slice(start, end).trim() }
}
