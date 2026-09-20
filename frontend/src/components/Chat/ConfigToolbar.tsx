import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigOption } from '../../stores/chatStore'
import { OverlayScroll } from '../Common/OverlayScroll'
import { READER_FONT } from '../../utils/fonts'
import { useAppStore } from '../../stores/appStore'
import { IconSettings, IconX } from '../FileManager/icons'

const CATEGORY_LABELS: Record<string, string> = {
  mode: 'Mode',
  model: 'Model',
  model_config: 'Config',
  thought_level: 'Thinking',
}

const CATEGORY_ORDER = ['mode', 'model', 'thought_level', 'model_config']

/** 移动端行内保留的类别（按优先级）：权限模式 > 模型 > 思考等级。其余全部
 *  收纳进「高级」面板——窄屏下配置项 wrap 成多行会挤占聊天视口。桌面端有横向
 *  空间，不切分、整行渲染（与切分前行为一致）。 */
const PRIMARY_CATEGORIES = ['mode', 'model', 'thought_level']

/** 移动端配置控件的触摸目标高度（原始按钮约 20px，低于可点性下限）。 */
const MOBILE_CONTROL_HEIGHT = 30

/** 「高级」面板内容区最大高度：选项多时不向上顶穿聊天视口。 */
const ADVANCED_MAX_HEIGHT = 320

/** 按类别优先级把配置项切成「行内主位」与「收纳」两组。
 *
 * 主位只收 PRIMARY_CATEGORIES 内的类别、每类至多第一个（调用方传入的
 * `sorted` 已按 CATEGORY_ORDER 排好），因此行内永远是 权限/模型/思考 的当前
 * 值；其余（模型参数、布尔开关、未知类别、同名类别第二项）全部收纳。
 *
 * 兜底：agent 只发非主位类别（例如清一色模型参数）时，若主位为空，配置栏会
 * 只剩一个「高级」按钮，失去「一眼看到当前配置」的意义——此时提升排序第一项。
 */
function splitPrimaryOptions(options: ConfigOption[]): {
  primary: ConfigOption[]
  advanced: ConfigOption[]
} {
  const primary: ConfigOption[] = []
  const advanced: ConfigOption[] = []
  const taken = new Set<string>()
  for (const opt of options) {
    if (!taken.has(opt.category) && PRIMARY_CATEGORIES.includes(opt.category)) {
      taken.add(opt.category)
      primary.push(opt)
    } else {
      advanced.push(opt)
    }
  }
  if (primary.length === 0 && options.length > 0) {
    return { primary: [options[0]], advanced: options.slice(1) }
  }
  return { primary, advanced }
}

function ConfigDropdown({
  option,
  onSelect,
  readOnly = false,
  compact = false,
}: {
  option: ConfigOption
  onSelect: (configId: string, value: string) => void
  readOnly?: boolean
  /** 移动端紧凑态：去掉类别前缀、固定触摸目标高度、当前值超宽省略。 */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    // 搜索框不自动聚焦（移动端聚焦会立刻弹软键盘挡住选项列表），Esc 因此在
    // document 层兜底：有搜索词先清空，无搜索词才关闭。
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (search) {
        setSearch('')
      } else {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, search])

  const current = option.options.find((o) => o.value === option.currentValue)
  const label = CATEGORY_LABELS[option.category] ?? option.name

  const filtered = option.options.filter((o) =>
    o.name.toLowerCase().includes(search.toLowerCase()),
  )
  const showSearch = option.options.length > 8

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        // 紧凑态允许压缩：值名再长也先保证「高级」按钮不被挤出屏幕。
        flexShrink: compact ? 1 : 0,
        minWidth: 0,
        maxWidth: compact ? 148 : undefined,
      }}
    >
      <button
        disabled={readOnly}
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: compact ? '0 8px' : '2px 8px',
          height: compact ? MOBILE_CONTROL_HEIGHT : undefined,
          maxWidth: '100%',
          fontSize: 11,
          fontFamily: READER_FONT,
          background: open ? 'var(--bg-surface)' : 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          color: 'var(--text-secondary)',
          cursor: readOnly ? 'not-allowed' : 'pointer',
          whiteSpace: compact ? undefined : 'nowrap',
        }}
      >
        {!compact && <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{label}:</span>}
        <span
          style={{
            fontWeight: 600,
            color: 'var(--text-primary)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current?.name ?? option.currentValue}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
          {open ? '▾' : '▴'}
        </span>
      </button>
      {open && (
        <OverlayScroll
          className="pixel-float"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 2,
            minWidth: 160,
            background: 'var(--bg-elevated)',
            zIndex: 100,
          }}
          contentStyle={{ flex: '0 0 auto', maxHeight: 240, padding: '4px 0' }}
        >
          {showSearch && (
            <div style={{ padding: '4px 6px 2px' }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                style={{
                  width: '100%',
                  padding: '4px 6px',
                  fontSize: 11,
                  fontFamily: READER_FONT,
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          {filtered.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onSelect(option.id, opt.value)
                setOpen(false)
                setSearch('')
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 10px',
                fontSize: 11,
                fontFamily: READER_FONT,
                border: 'none',
                background: opt.value === option.currentValue ? 'var(--accent-14)' : 'transparent',
                color: opt.value === option.currentValue ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: opt.value === option.currentValue ? 600 : 400,
              }}
            >
              {opt.name}
            </button>
          ))}
          {search && filtered.length === 0 && (
            <div
              style={{
                padding: '12px 10px',
                fontSize: 11,
                color: 'var(--text-faint)',
                textAlign: 'center',
              }}
            >
              No matches
            </div>
          )}
        </OverlayScroll>
      )}
    </div>
  )
}

const RING_SIZE = 15
const RING_STROKE = 2.5

function formatTokens(n: number): string {
  const fmt = (v: number) => {
    const rounded = Math.round(v * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (n >= 1e6) return `${fmt(n / 1e6)}M`
  if (n >= 1e3) return `${fmt(n / 1e3)}k`
  return String(n)
}

function UsageRing({ pct }: { pct: number }) {
  const r = (RING_SIZE - RING_STROKE) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      style={{ transform: 'rotate(-90deg)', display: 'block' }}
      aria-hidden="true"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke="var(--bg-surface)"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke={pct > 80 ? 'var(--danger, #FF7B72)' : 'var(--accent)'}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped / 100)}
        style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease' }}
      />
    </svg>
  )
}

function UsageIndicator({ usage }: { usage: Record<string, unknown> }) {
  const [hover, setHover] = useState(false)
  const used = typeof usage['used'] === 'number' ? usage['used'] : null
  const size = typeof usage['size'] === 'number' ? usage['size'] : null
  const pct = used !== null && size !== null && size > 0 ? (used / size) * 100 : null
  const costObj = usage['cost']
  const cost = costObj && typeof costObj === 'object' && typeof (costObj as Record<string, unknown>)['amount'] === 'number'
    ? (costObj as Record<string, unknown>)['amount'] as number
    : null

  if (pct === null && cost === null) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        color: 'var(--text-faint)',
        fontFamily: READER_FONT,
      }}
    >
      {pct !== null && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{ position: 'relative', display: 'inline-flex', padding: 2 }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            <UsageRing pct={pct} />
            {used !== null && size !== null && (
              <span
                className="pixel-float"
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  marginBottom: 6,
                  padding: '3px 8px',
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  opacity: hover ? 1 : 0,
                  transform: hover
                    ? 'translateX(-50%) translateY(0)'
                    : 'translateX(-50%) translateY(3px)',
                  transition: 'opacity 0.15s ease, transform 0.15s ease',
                  pointerEvents: 'none',
                  zIndex: 100,
                }}
              >
                {formatTokens(used)} / {formatTokens(size)}
              </span>
            )}
          </span>
          {Math.round(pct)}%
        </span>
      )}
      {cost !== null && <span>${cost.toFixed(4)}</span>}
    </div>
  )
}

/** 「高级」收纳入口（仅移动端渲染）。数字角标让用户不点开也知道里面有货。 */
function AdvancedTrigger({
  count,
  open,
  disabled,
  onToggle,
}: {
  count: number
  open: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t('chat.config.advancedWithCount', { count })}
      className="pixel-press"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: MOBILE_CONTROL_HEIGHT,
        padding: '0 8px',
        fontSize: 11,
        fontFamily: READER_FONT,
        background: open ? 'var(--accent)' : 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        color: open ? '#fff' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0,
      }}
    >
      <IconSettings width={13} height={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span style={{ fontWeight: 600 }}>{t('chat.config.advanced')}</span>
      <span style={{ color: open ? '#fff' : 'var(--text-faint)' }}>{count}</span>
    </button>
  )
}

/** 收纳面板：每个配置项一行，行内展开选项列表（正常文档流，不用二级浮层——
 *  选项列表原本是向上弹出的绝对定位浮层，嵌进滚动面板会被裁切或产生二级滚动）。
 *  点选立即生效并收起该行，作为「已设置」的反馈。
 *
 *  定位：`left/right: 0` 相对的是**配置栏根容器**（见 ConfigToolbar 的
 *  `position: relative`），因此面板与配置栏等宽——不能把面板放在触发器自己的
 *  定位容器里，那样 `left/right: 0` 只会等于按钮宽度。 */
function AdvancedPanel({
  options,
  onSelect,
  onClose,
}: {
  options: ConfigOption[]
  onSelect: (configId: string, value: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div
      className="pixel-float"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 4,
        background: 'var(--bg-elevated)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div className="panel-title-bar" style={{ fontSize: 12, flexShrink: 0 }}>
        <span>◆</span>
        <span>{t('chat.config.advancedTitle')}</span>
        <span className="title-bar-spacer" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('drawer.close')}
          title={t('drawer.close')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: '#FAF2DE',
            cursor: 'pointer',
          }}
        >
          <IconX width={13} height={13} />
        </button>
      </div>
      <OverlayScroll contentStyle={{ flex: '0 0 auto', maxHeight: ADVANCED_MAX_HEIGHT }}>
        {options.map((opt, i) => (
          <AdvancedRow
            key={opt.id}
            option={opt}
            divider={i > 0}
            expanded={expandedId === opt.id}
            onToggle={() => setExpandedId((cur) => (cur === opt.id ? null : opt.id))}
            onSelect={onSelect}
          />
        ))}
      </OverlayScroll>
    </div>
  )
}

/** 移动端「高级」收纳入口 + 面板（自带开合状态）。
 *
 * 结构与 ConfigDropdown 同构：触发器与面板在同一个 ref 容器里，点触发器不算
 * 「外部点击」，否则会出现 mousedown 先关闭、click 又打开的双击假象。容器本身
 * **不设 position**，让面板的 `left/right: 0` 落到配置栏根容器上（等宽展开）。 */
function AdvancedMenu({
  options,
  onSelect,
  disabled,
}: {
  options: ConfigOption[]
  onSelect: (configId: string, value: string) => void
  disabled: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  // 关闭契约与 ConfigDropdown 一致：外部 mousedown + Esc。
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} style={{ display: 'flex', flexShrink: 0 }}>
      <AdvancedTrigger
        count={options.length}
        open={open}
        disabled={disabled}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <AdvancedPanel options={options} onSelect={onSelect} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

function AdvancedRow({
  option,
  divider,
  expanded,
  onToggle,
  onSelect,
}: {
  option: ConfigOption
  divider: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: (configId: string, value: string) => void
}) {
  const current = option.options.find((o) => o.value === option.currentValue)
  // 面板里并列多项，用配置项自身的名字（如 "Brave Mode"）而非类别通名
  // （"Config"）——否则多个同类配置项在面板里长得一模一样。
  const label = option.name || CATEGORY_LABELS[option.category] || option.id

  return (
    <div style={{ borderTop: divider ? '1px solid var(--border-subtle)' : 'none' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: MOBILE_CONTROL_HEIGHT,
          padding: '6px 10px',
          background: expanded ? 'var(--bg-surface)' : 'transparent',
          border: 'none',
          fontFamily: READER_FONT,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>{label}</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current?.name ?? option.currentValue}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
          {expanded ? '▴' : '▾'}
        </span>
      </button>
      {expanded &&
        option.options.map((opt) => {
          const selected = opt.value === option.currentValue
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onSelect(option.id, opt.value)
                onToggle()
              }}
              style={{
                display: 'block',
                width: '100%',
                minHeight: MOBILE_CONTROL_HEIGHT,
                padding: '6px 10px 6px 22px',
                fontSize: 12,
                fontFamily: READER_FONT,
                border: 'none',
                textAlign: 'left',
                background: selected ? 'var(--accent-14)' : 'transparent',
                color: selected ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: selected ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {opt.name}
            </button>
          )
        })}
    </div>
  )
}

export function ConfigToolbar({
  configOptions,
  usage,
  onSetConfigOption,
  readOnly = false,
}: {
  configOptions: ConfigOption[]
  usage: Record<string, unknown> | null
  onSetConfigOption: (configId: string, value: string) => void
  /** 只读置灰态：configOptions 来自已结束会话的快照（无活 agent），仅作展示。
   *  样式与活跃态一致、整体 opacity 0.5（ui-style-guide Disabled 约定）。 */
  readOnly?: boolean
}) {
  const { t } = useTranslation()
  const isMobile = useAppStore((s) => s.isMobile)

  if (configOptions.length === 0 && !usage) return null

  const sorted = [...configOptions].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category)
    const bi = CATEGORY_ORDER.indexOf(b.category)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
  const { primary, advanced } = splitPrimaryOptions(sorted)
  // 仅移动端切分；桌面端整行渲染，行为与切分前一致。收纳项为空（配置 ≤3 项
  // 或全在主位）时不出现「高级」入口。
  const showAdvanced = isMobile && advanced.length > 0

  return (
    <div
      title={readOnly ? t('chat.config.readOnlyTitle') : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        flexWrap: 'wrap',
        opacity: readOnly ? 0.5 : 1,
        // 高级面板的定位锚：面板绝对定位于配置栏上方并与配置栏等宽。
        position: 'relative',
      }}
    >
      {primary.map((opt) => (
        <ConfigDropdown
          key={opt.id}
          option={opt}
          onSelect={onSetConfigOption}
          readOnly={readOnly}
          compact={isMobile}
        />
      ))}
      {showAdvanced && (
        <AdvancedMenu options={advanced} onSelect={onSetConfigOption} disabled={readOnly} />
      )}
      {usage && (
        <div style={{ marginLeft: 'auto' }}>
          <UsageIndicator usage={usage} />
        </div>
      )}
    </div>
  )
}
