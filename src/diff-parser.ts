// Parser for the unified diff format, modelled on GitHub Desktop's
// app/src/lib/diff-parser.ts but reduced to what the viewer needs.
// It accepts full `git diff` output or bare hunks (as returned by the
// GitHub API `patch` field).

export type DiffLineKind = 'context' | 'add' | 'delete' | 'hunk' | 'noNewline'

export interface DiffLine {
  kind: DiffLineKind
  /** Line content without the +/-/space prefix. */
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  binary: boolean
  additions: number
  deletions: number
}

const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], binary: false, additions: 0, deletions: 0 }
  const lines = text.split('\n')
  // A trailing newline produces one empty element that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    const header = hunkHeaderRe.exec(line)
    if (header) {
      hunk = {
        header: line,
        oldStart: +header[1],
        oldCount: header[2] === undefined ? 1 : +header[2],
        newStart: +header[3],
        newCount: header[4] === undefined ? 1 : +header[4],
        lines: [{ kind: 'hunk', text: line, oldLine: null, newLine: null }],
      }
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      result.hunks.push(hunk)
      continue
    }

    if (hunk === null) {
      // File header section (diff --git, index, ---/+++, mode lines...).
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        result.binary = true
      }
      continue
    }

    const prefix = line[0]
    const body = line.slice(1)
    if (prefix === '+') {
      hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine: newLine++ })
      result.additions++
    } else if (prefix === '-') {
      hunk.lines.push({ kind: 'delete', text: body, oldLine: oldLine++, newLine: null })
      result.deletions++
    } else if (prefix === ' ' || line === '') {
      hunk.lines.push({ kind: 'context', text: body, oldLine: oldLine++, newLine: newLine++ })
    } else if (prefix === '\\') {
      hunk.lines.push({ kind: 'noNewline', text: line, oldLine: null, newLine: null })
    } else if (line.startsWith('diff --git ')) {
      // Start of the next file in a multi-file diff; the viewer only asks for
      // one file at a time so we stop here.
      break
    }
  }

  return result
}

/**
 * Pairs deleted and added lines inside each change block so a split view can
 * render them side by side.
 */
export interface SplitRow {
  kind: 'hunk' | 'line'
  hunkText?: string
  left: DiffLine | null
  right: DiffLine | null
}

export function toSplitRows(hunks: ReadonlyArray<DiffHunk>): SplitRow[] {
  const rows: SplitRow[] = []
  for (const hunk of hunks) {
    let deletes: DiffLine[] = []
    let adds: DiffLine[] = []
    const flush = () => {
      const n = Math.max(deletes.length, adds.length)
      for (let i = 0; i < n; i++) {
        rows.push({ kind: 'line', left: deletes[i] ?? null, right: adds[i] ?? null })
      }
      deletes = []
      adds = []
    }
    for (const line of hunk.lines) {
      switch (line.kind) {
        case 'hunk':
          flush()
          rows.push({ kind: 'hunk', hunkText: line.text, left: null, right: null })
          break
        case 'delete':
          if (adds.length > 0) {
            flush()
          }
          deletes.push(line)
          break
        case 'add':
          adds.push(line)
          break
        case 'context':
          flush()
          rows.push({ kind: 'line', left: line, right: line })
          break
        case 'noNewline':
          flush()
          break
      }
    }
    flush()
  }
  return rows
}
