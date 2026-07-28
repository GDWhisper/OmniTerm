export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'meta'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  oldPath: string
  newPath: string
  binary: boolean
  hunks: DiffHunk[]
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

function stripPathPrefix(p: string): string {
  if (p === '/dev/null') return p
  return p.replace(/^[ab]\//, '')
}

/** Parse `git diff` unified output (possibly multi-file) for display.
 *  The raw patch stays the single source of truth (ADR-3) — this only
 *  splits it into lines with computed line numbers, never re-diffs. */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { oldPath: '', newPath: '', binary: false, hunks: [] }
      files.push(current)
      hunk = null
      continue
    }
    if (!current) {
      // Tolerate patches without a `diff --git` preamble (defensive; git
      // always emits it, but a truncated patch may start mid-file).
      if (line.startsWith('--- ') || line.startsWith('@@')) {
        current = { oldPath: '', newPath: '', binary: false, hunks: [] }
        files.push(current)
      } else {
        continue
      }
    }
    if (line.startsWith('--- ')) {
      current.oldPath = stripPathPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      current.newPath = stripPathPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true
      continue
    }
    const m = line.match(HUNK_RE)
    if (m) {
      oldNo = parseInt(m[1])
      newNo = parseInt(m[2])
      hunk = { header: line, lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      hunk.lines.push({ type: 'meta', text: line, oldNo: null, newNo: null })
    }
  }

  return files
}
