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
  /** The line ended in CRLF; kept so generated patches apply byte for byte. */
  cr?: boolean
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
    const cr = raw.endsWith('\r')
    const line = cr ? raw.slice(0, -1) : raw

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
      hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine: newLine++, cr })
      result.additions++
    } else if (prefix === '-') {
      hunk.lines.push({ kind: 'delete', text: body, oldLine: oldLine++, newLine: null, cr })
      result.deletions++
    } else if (prefix === ' ' || line === '') {
      hunk.lines.push({ kind: 'context', text: body, oldLine: oldLine++, newLine: newLine++, cr })
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

// ---------------------------------------------------------------------------
// Partial selection

/** Identifies a line of a parsed diff: `${hunkIndex}:${lineIndex}`. */
export function lineKey(hunk: number, line: number): string {
  return `${hunk}:${line}`
}

/** Keys of every add/delete line, i.e. the lines a user can include or exclude. */
export function selectableKeys(hunks: ReadonlyArray<DiffHunk>): string[] {
  const keys: string[] = []
  hunks.forEach((hunk, h) =>
    hunk.lines.forEach((line, i) => {
      if (line.kind === 'add' || line.kind === 'delete') {
        keys.push(lineKey(h, i))
      }
    })
  )
  return keys
}

/**
 * Builds a patch, applicable to the old side of the diff (the index seeded
 * from HEAD), that contains only the selected changes. Like GitHub Desktop:
 * an excluded addition is dropped and an excluded deletion becomes context.
 * Returns null when nothing is selected.
 */
export function buildPartialPatch(
  path: string,
  hunks: ReadonlyArray<DiffHunk>,
  excluded: ReadonlySet<string>,
  newFile: boolean
): string | null {
  const out: string[] = []
  let offset = 0
  let any = false

  hunks.forEach((hunk, h) => {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let changed = false
    let lastEmitted = false
    hunk.lines.forEach((line, i) => {
      const eol = line.cr ? '\r' : ''
      const selected = !excluded.has(lineKey(h, i))
      switch (line.kind) {
        case 'context':
          body.push(` ${line.text}${eol}`)
          oldCount++
          newCount++
          lastEmitted = true
          break
        case 'add':
          lastEmitted = selected
          if (selected) {
            body.push(`+${line.text}${eol}`)
            newCount++
            changed = true
          }
          break
        case 'delete':
          lastEmitted = true
          if (selected) {
            body.push(`-${line.text}${eol}`)
            changed = true
          } else {
            body.push(` ${line.text}${eol}`)
            newCount++
          }
          oldCount++
          break
        case 'noNewline':
          if (lastEmitted) {
            body.push(line.text)
          }
          break
      }
    })
    if (!changed) {
      return
    }
    any = true
    // Excluded deletions become context, so the old side is never shortened.
    const { oldFirst } = hunkRange(hunk)
    const newFirst = oldFirst + offset
    const newStart = newCount === 0 ? newFirst - 1 : newFirst
    out.push(`@@ -${hunk.oldStart},${oldCount} +${newStart},${newCount} @@`, ...body)
    offset += newCount - oldCount
  })

  if (!any) {
    return null
  }
  const header = newFile
    ? [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`]
    : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`]
  return [...header, ...out].join('\n') + '\n'
}

/**
 * Builds a patch whose new side is the current working tree file and which,
 * applied in reverse, reverts only the given lines. The mirror image of
 * buildPartialPatch: an unselected addition stays as context (it is in the
 * file) and an unselected deletion is dropped (it is not).
 * Returns null when no add/delete line is selected.
 */
export function buildDiscardPatch(
  path: string,
  hunks: ReadonlyArray<DiffHunk>,
  selected: ReadonlySet<string>
): string | null {
  const out: string[] = []
  let offset = 0
  let any = false

  hunks.forEach((hunk, h) => {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let changed = false
    let lastEmitted = false
    hunk.lines.forEach((line, i) => {
      const eol = line.cr ? '\r' : ''
      const chosen = selected.has(lineKey(h, i))
      switch (line.kind) {
        case 'context':
          body.push(` ${line.text}${eol}`)
          oldCount++
          newCount++
          lastEmitted = true
          break
        case 'add':
          lastEmitted = true
          if (chosen) {
            body.push(`+${line.text}${eol}`)
            changed = true
          } else {
            body.push(` ${line.text}${eol}`)
            oldCount++
          }
          newCount++
          break
        case 'delete':
          lastEmitted = chosen
          if (chosen) {
            body.push(`-${line.text}${eol}`)
            oldCount++
            changed = true
          }
          break
        case 'noNewline':
          if (lastEmitted) {
            body.push(line.text)
          }
          break
      }
    })
    if (!changed) {
      return
    }
    any = true
    // The new side is the working tree as diffed, so its coordinates are unchanged.
    const { newFirst } = hunkRange(hunk)
    const oldFirst = newFirst - offset
    const oldStart = oldCount === 0 ? oldFirst - 1 : oldFirst
    out.push(`@@ -${oldStart},${oldCount} +${hunk.newStart},${newCount} @@`, ...body)
    offset += newCount - oldCount
  })

  if (!any) {
    return null
  }
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...out].join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Context expansion

/** First and last line numbers a hunk covers on each side (last < first when empty). */
export function hunkRange(hunk: DiffHunk) {
  const oldFirst = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart
  const newFirst = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart
  return {
    oldFirst,
    oldLast: oldFirst + hunk.oldCount - 1,
    newFirst,
    newLast: newFirst + hunk.newCount - 1,
  }
}

/**
 * The unchanged lines hidden before each hunk (index i) and after the last
 * one (index hunks.length), as new-side line ranges. `delta` maps a new line
 * number to the old one: old = new - delta.
 */
export interface DiffGap {
  newFirst: number
  newLast: number
  delta: number
}

export function diffGaps(hunks: ReadonlyArray<DiffHunk>, newLineCount: number): DiffGap[] {
  const gaps: DiffGap[] = []
  let prevNewLast = 0
  let prevOldLast = 0
  for (const hunk of hunks) {
    const r = hunkRange(hunk)
    gaps.push({ newFirst: prevNewLast + 1, newLast: r.newFirst - 1, delta: r.newFirst - r.oldFirst })
    prevNewLast = r.newLast
    prevOldLast = r.oldLast
  }
  gaps.push({ newFirst: prevNewLast + 1, newLast: newLineCount, delta: prevNewLast - prevOldLast })
  return gaps
}
