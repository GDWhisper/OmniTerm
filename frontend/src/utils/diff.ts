// 粗判文本是否形如 unified diff：前 20 行内 ≥3 行以 diff 标记开头。
export function looksLikeDiff(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 3) return false
  let diffLines = 0
  for (const l of lines.slice(0, 20)) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@') || l.startsWith('+') || l.startsWith('-')) {
      diffLines++
    }
  }
  return diffLines >= 3
}
