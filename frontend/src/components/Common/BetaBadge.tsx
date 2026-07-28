/**
 * BETA徽标 — 用于标记尚处于测试阶段的功能。
 *
 * 使用方式：
 * ```tsx
 * <SectionTitle>
 *   {t('some.label')}
 *   <BetaBadge />
 * </SectionTitle>
 * ```
 */
export function BetaBadge() {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        color: 'var(--accent)',
        background: 'var(--accent-10)',
        border: '1px solid var(--accent)',
        borderRadius: 0,
        padding: '1px 4px',
        verticalAlign: 'middle',
        letterSpacing: '0.3px',
      }}
    >
      BETA
    </span>
  )
}
