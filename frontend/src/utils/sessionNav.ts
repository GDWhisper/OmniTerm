/** Session cycling order for the mobile status-bar swipe. The caller
 *  flattens sessions in sidebar display order (projects.flatMap); this
 *  function only owns the wrap-around arithmetic. */
export function nextSessionId(
  orderedIds: string[],
  activeId: string | null,
  dir: 'prev' | 'next',
): string | null {
  if (orderedIds.length < 2) return null
  const idx = orderedIds.findIndex((id) => id === activeId)
  if (idx === -1) return orderedIds[0]
  const step = dir === 'next' ? 1 : orderedIds.length - 1
  return orderedIds[(idx + step) % orderedIds.length]
}
