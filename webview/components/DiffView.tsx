import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DiffLine, diffGaps, lineKey, parseDiff } from '../../src/diff-parser'
import { ChangedFile, DiffResult } from '../../src/protocol'
import { escapeHtml, highlightLines, languageForPath } from '../highlight'
import { Icon, IconButton, Loading, PathLabel, Placeholder, Stats } from './Common'

export interface DiffOptions {
  split: boolean
  hideWhitespace: boolean
}

export type DiffState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; result: DiffResult }

/** Lines picked for the next commit, GitHub Desktop style. */
export interface LineSelection {
  excluded: ReadonlySet<string>
  /** Includes (true) or excludes (false) the given line keys. */
  onChange: (keys: string[], include: boolean) => void
}

/** Full text of the new version of the file, used to expand context. */
export interface ContextSource {
  /** Undefined until requested, null when it is not available. */
  lines: string[] | null | undefined
  request: () => void
}

interface DiffViewProps {
  file: ChangedFile | null
  /** Shown when no file is selected, instead of the default hint. */
  emptyText?: string
  state: DiffState | null
  options: DiffOptions
  /** GitHub patches can't be re-requested without whitespace. */
  whitespaceSupported: boolean
  onOptionsChange: (options: DiffOptions) => void
  onOpenInEditor: () => void
  selection?: LineSelection
  /** Shown instead of enabling line selection, e.g. while whitespace is hidden. */
  selectionNote?: string
  context?: ContextSource
  /** Reverts the given lines in the working tree (Changes tab only). */
  onDiscard?: (keys: string[]) => void
}

/** Rendering every line of a huge diff locks up the webview; show this many rows first. */
const InitialRowLimit = 3000
const ExpandStep = 20

export function DiffView(props: DiffViewProps) {
  if (!props.file) {
    return (
      <div className="diff-view">
        <Placeholder icon="diff">{props.emptyText ?? 'Select a file to see its changes'}</Placeholder>
      </div>
    )
  }
  return (
    <div className="diff-view">
      <DiffHeader {...props} file={props.file} />
      {props.selectionNote ? <div className="diff-note">{props.selectionNote}</div> : null}
      <div className="diff-body">
        <DiffBody {...props} file={props.file} />
      </div>
    </div>
  )
}

function DiffHeader(props: DiffViewProps & { file: ChangedFile }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const { options, onOptionsChange } = props
  return (
    <div className="pane-header diff-header">
      <PathLabel file={props.file} />
      <Stats additions={props.file.additions} deletions={props.file.deletions} />
      <span className="spacer" />
      <IconButton icon="go-to-file" title="Open diff in VS Code editor" onClick={props.onOpenInEditor} />
      <div className="menu-anchor" ref={menuRef}>
        <IconButton icon="settings-gear" title="Diff options" onClick={() => setMenuOpen(!menuOpen)} active={menuOpen} />
        {menuOpen ? (
          <div className="popover diff-options">
            <div className="popover-title">Diff display</div>
            <label>
              <input type="radio" checked={!options.split} onChange={() => onOptionsChange({ ...options, split: false })} />
              Unified
            </label>
            <label>
              <input type="radio" checked={options.split} onChange={() => onOptionsChange({ ...options, split: true })} />
              Split
            </label>
            <div className="popover-title">Whitespace</div>
            <label className={props.whitespaceSupported ? '' : 'disabled'}>
              <input
                type="checkbox"
                disabled={!props.whitespaceSupported}
                checked={options.hideWhitespace}
                onChange={e => onOptionsChange({ ...options, hideWhitespace: e.target.checked })}
              />
              Hide whitespace changes
            </label>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row model shared by the unified and split renderings

type Row =
  /** Hunk header; also where the hidden lines above the hunk can be expanded. */
  | { kind: 'hunk'; hunk: number; text: string; gap: number; hidden: number; canExpandDown: boolean }
  | { kind: 'line'; hunk: number; line: DiffLine; key: string }
  /** An unchanged line revealed by expanding context. */
  | { kind: 'revealed'; oldLine: number; newLine: number }
  /** Expander below the last hunk. */
  | { kind: 'tail'; gap: number }

type ExpandDirection = 'up' | 'down' | 'all'

function DiffBody(props: DiffViewProps & { file: ChangedFile }) {
  const { state, selection, context } = props
  const [showAll, setShowAll] = useState(false)
  // Revealed lines per gap: `top` right after the previous hunk, `bottom` right before the next.
  const [expanded, setExpanded] = useState<Record<number, { top: number; bottom: number }>>({})
  const pending = useRef<{ gap: number; direction: ExpandDirection } | null>(null)

  useEffect(() => {
    setShowAll(false)
    setExpanded({})
    pending.current = null
  }, [props.file.path, state])

  const parsed = useMemo(
    () => (state?.status === 'loaded' && !state.result.binary ? parseDiff(state.result.text) : null),
    [state]
  )
  const language = useMemo(() => languageForPath(props.file.path), [props.file.path])
  const contentLines = context?.lines ?? null
  const canExpand = context !== undefined && context.lines !== null
  const hunks = parsed?.hunks ?? []
  const gaps = useMemo(
    () => diffGaps(hunks, contentLines ? contentLines.length : Number.POSITIVE_INFINITY),
    [parsed, contentLines]
  )

  const gapSize = (g: number) => gaps[g].newLast - gaps[g].newFirst + 1
  const expand = (gap: number, direction: ExpandDirection) => {
    if (!contentLines) {
      // Fetch the file first; the expansion is applied once it arrives.
      pending.current = { gap, direction }
      context?.request()
      return
    }
    setExpanded(prev => {
      const current = prev[gap] ?? { top: 0, bottom: 0 }
      const hidden = gapSize(gap) - current.top - current.bottom
      const step = Math.min(ExpandStep, hidden)
      const next =
        direction === 'all'
          ? { ...current, bottom: current.bottom + hidden }
          : direction === 'up'
            ? { ...current, bottom: current.bottom + step }
            : { ...current, top: current.top + step }
      return { ...prev, [gap]: next }
    })
  }
  useEffect(() => {
    if (contentLines && pending.current) {
      const { gap, direction } = pending.current
      pending.current = null
      expand(gap, direction)
    }
  }, [contentLines])

  const rows = useMemo(() => {
    const result: Row[] = []
    const reveal = (from: number, to: number, delta: number) => {
      for (let n = from; n <= to; n++) {
        result.push({ kind: 'revealed', newLine: n, oldLine: n - delta })
      }
    }
    hunks.forEach((hunk, h) => {
      const gap = gaps[h]
      const { top, bottom } = expanded[h] ?? { top: 0, bottom: 0 }
      const size = gapSize(h)
      if (contentLines) {
        reveal(gap.newFirst, gap.newFirst + top - 1, gap.delta)
      }
      const hidden = size - top - bottom
      // Once everything above a hunk is revealed, drop its header so the file reads continuously.
      if (!(size > 0 && hidden === 0)) {
        result.push({ kind: 'hunk', hunk: h, text: hunk.header, gap: h, hidden, canExpandDown: h > 0 })
      }
      if (contentLines) {
        reveal(gap.newLast - bottom + 1, gap.newLast, gap.delta)
      }
      hunk.lines.forEach((line, i) => {
        if (line.kind !== 'hunk') {
          result.push({ kind: 'line', hunk: h, line, key: lineKey(h, i) })
        }
      })
    })
    if (hunks.length > 0) {
      const last = hunks.length
      const { top } = expanded[last] ?? { top: 0, bottom: 0 }
      if (contentLines) {
        reveal(gaps[last].newFirst, Math.min(gaps[last].newLast, gaps[last].newFirst + top - 1), gaps[last].delta)
      }
      if (canExpand && gapSize(last) - top > 0) {
        result.push({ kind: 'tail', gap: last })
      }
    }
    return result
  }, [parsed, gaps, expanded, contentLines, canExpand])

  const html = useMemo(() => {
    const byLine = new Map<DiffLine, string>()
    const fileHtml = contentLines ? highlightLines(contentLines, language) : null
    for (const hunk of hunks) {
      const oldSide = hunk.lines.filter(l => l.kind === 'context' || l.kind === 'delete')
      const newSide = hunk.lines.filter(l => l.kind === 'context' || l.kind === 'add')
      highlightLines(oldSide.map(l => l.text), language).forEach((h, i) => byLine.set(oldSide[i], h))
      highlightLines(newSide.map(l => l.text), language).forEach((h, i) => byLine.set(newSide[i], h))
      if (fileHtml && contentLines) {
        // Highlighting the whole file gets constructs that start outside the hunk right.
        for (const line of newSide) {
          const n = line.newLine! - 1
          if (contentLines[n] === line.text) {
            byLine.set(line, fileHtml[n])
          }
        }
      }
    }
    return { byLine, fileHtml }
  }, [parsed, language, contentLines])

  // Right click on a changed line or hunk header: discard it, like GitHub Desktop.
  const [menu, setMenu] = useState<{ x: number; y: number; line: string | null; hunk: number } | null>(null)
  useEffect(() => setMenu(null), [state])
  const hunkKeys = (h: number) =>
    hunks[h].lines
      .map((l, i) => (l.kind === 'add' || l.kind === 'delete' ? lineKey(h, i) : null))
      .filter((k): k is string => k !== null)
  const contextMenuFor = (hunk: number, line: string | null) =>
    props.onDiscard
      ? {
          onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, line, hunk })
          },
        }
      : {}

  // Drag across gutters to select or deselect several lines, like GitHub Desktop.
  const drag = useRef<boolean | null>(null)
  useEffect(() => {
    const up = () => (drag.current = null)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])
  const gutterHandlers = (key: string) =>
    selection
      ? {
          onMouseDown: (e: React.MouseEvent) => {
            if (e.button !== 0) {
              return
            }
            e.preventDefault()
            const include = selection.excluded.has(key)
            drag.current = include
            selection.onChange([key], include)
          },
          onMouseEnter: () => {
            if (drag.current !== null && selection.excluded.has(key) === drag.current) {
              selection.onChange([key], drag.current)
            }
          },
        }
      : {}
  const toggleHunk = (h: number) => {
    if (!selection) {
      return
    }
    const keys = hunkKeys(h)
    selection.onChange(keys, keys.some(k => selection.excluded.has(k)))
  }

  if (!state || state.status === 'loading') {
    return <Loading />
  }
  if (state.status === 'error') {
    return <Placeholder icon="error">{state.message}</Placeholder>
  }
  const { result } = state
  if (result.message) {
    return <Placeholder icon="info">{result.message}</Placeholder>
  }
  if (result.tooLarge) {
    return <Placeholder icon="warning">The diff is too large to be displayed.</Placeholder>
  }
  if (result.binary || parsed?.binary) {
    return <Placeholder icon="file-binary">This binary file has changed.</Placeholder>
  }
  if (!parsed || parsed.hunks.length === 0) {
    return (
      <Placeholder icon="info">
        {props.file.status === 'renamed' ? 'The file was renamed without changes.' : 'No content changes to show.'}
      </Placeholder>
    )
  }

  const visible = showAll ? rows : rows.slice(0, InitialRowLimit)
  const tools: RowTools = {
    html,
    contentLines,
    canExpand,
    expand,
    selection,
    gutterHandlers,
    contextMenuFor,
    toggleHunk,
    hunkState: (h: number) => {
      if (!selection) {
        return null
      }
      const keys = hunkKeys(h)
      const excluded = keys.filter(k => selection.excluded.has(k)).length
      return excluded === 0 ? 'checked' : excluded === keys.length ? 'unchecked' : 'mixed'
    },
  }

  return (
    <>
      {props.options.split ? <SplitTable rows={visible} tools={tools} /> : <UnifiedTable rows={visible} tools={tools} />}
      {rows.length > visible.length ? (
        <div className="diff-truncated">
          Showing {visible.length} of {rows.length} lines.{' '}
          <button className="link-button" onClick={() => setShowAll(true)}>
            Show the full diff
          </button>
        </div>
      ) : null}
      {menu && props.onDiscard ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.line ? (
            <button className="menu-item" onClick={() => (setMenu(null), props.onDiscard!([menu.line!]))}>
              Discard {lineKindLabel(hunks, menu.line)}
            </button>
          ) : null}
          <button className="menu-item" onClick={() => (setMenu(null), props.onDiscard!(hunkKeys(menu.hunk)))}>
            Discard hunk
          </button>
        </ContextMenu>
      ) : null}
    </>
  )
}

function lineKindLabel(hunks: ReturnType<typeof parseDiff>['hunks'], key: string): string {
  const [h, i] = key.split(':').map(Number)
  return hunks[h]?.lines[i]?.kind === 'add' ? 'added line' : 'removed line'
}

function ContextMenu(props: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: props.x, top: props.y })
  useEffect(() => {
    // Keep the menu inside the window.
    const el = ref.current
    if (el) {
      setPos({
        left: Math.min(props.x, window.innerWidth - el.offsetWidth - 4),
        top: Math.min(props.y, window.innerHeight - el.offsetHeight - 4),
      })
    }
    const close = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) {
        props.onClose()
      }
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    window.addEventListener('wheel', close)
    window.addEventListener('blur', props.onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('wheel', close)
      window.removeEventListener('blur', props.onClose)
    }
  }, [props.x, props.y])
  return (
    <div ref={ref} className="popover context-menu" style={pos} role="menu">
      {props.children}
    </div>
  )
}

interface RowTools {
  html: { byLine: Map<DiffLine, string>; fileHtml: string[] | null }
  contentLines: string[] | null
  canExpand: boolean
  expand: (gap: number, direction: ExpandDirection) => void
  selection: LineSelection | undefined
  gutterHandlers: (key: string) => object
  contextMenuFor: (hunk: number, line: string | null) => object
  toggleHunk: (hunk: number) => void
  hunkState: (hunk: number) => 'checked' | 'unchecked' | 'mixed' | null
}

const markers: Record<string, string> = { add: '+', delete: '-', context: ' ' }

function codeHtml(tools: RowTools, line: DiffLine): string {
  return tools.html.byLine.get(line) ?? escapeHtml(line.text)
}

function revealedHtml(tools: RowTools, newLine: number): string {
  return tools.html.fileHtml?.[newLine - 1] ?? escapeHtml(tools.contentLines?.[newLine - 1] ?? '')
}

/** A zero-width space keeps empty lines at full height. */
function Code(props: { html: string; className?: string } & React.HTMLAttributes<HTMLTableCellElement>) {
  const { html, className, ...rest } = props
  return <td {...rest} className={`code ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html || '​' }} />
}

function Expanders(props: { row: Extract<Row, { kind: 'hunk' | 'tail' }>; tools: RowTools }) {
  const { row, tools } = props
  if (!tools.canExpand) {
    return <Icon name="fold" />
  }
  if (row.kind === 'tail') {
    return (
      <button className="expand-button-gutter" title="Expand down" onClick={() => tools.expand(row.gap, 'down')}>
        <Icon name="fold-down" />
      </button>
    )
  }
  if (row.hidden <= 0) {
    return <Icon name="fold" />
  }
  if (row.hidden <= ExpandStep) {
    return (
      <button className="expand-button-gutter" title="Expand all hidden lines" onClick={() => tools.expand(row.gap, 'all')}>
        <Icon name="unfold" />
      </button>
    )
  }
  return (
    <span className="expand-buttons">
      {row.canExpandDown ? (
        <button className="expand-button-gutter" title="Expand down" onClick={() => tools.expand(row.gap, 'down')}>
          <Icon name="fold-down" />
        </button>
      ) : null}
      <button className="expand-button-gutter" title="Expand up" onClick={() => tools.expand(row.gap, 'up')}>
        <Icon name="fold-up" />
      </button>
    </span>
  )
}

function HunkCheckbox(props: { hunk: number; tools: RowTools }) {
  const state = props.tools.hunkState(props.hunk)
  if (state === null) {
    return null
  }
  return (
    <input
      type="checkbox"
      className="hunk-check"
      title="Include this hunk in the commit"
      checked={state === 'checked'}
      ref={el => {
        if (el) {
          el.indeterminate = state === 'mixed'
        }
      }}
      onChange={() => props.tools.toggleHunk(props.hunk)}
    />
  )
}

function selectionClass(tools: RowTools, line: DiffLine, key: string): string {
  if (!tools.selection || (line.kind !== 'add' && line.kind !== 'delete')) {
    return ''
  }
  return `selectable ${tools.selection.excluded.has(key) ? 'excluded' : 'included'}`
}

function UnifiedTable(props: { rows: Row[]; tools: RowTools }) {
  const { tools } = props
  return (
    <table className="diff-table unified">
      <tbody>
        {props.rows.map((row, r) => {
          switch (row.kind) {
            case 'hunk':
            case 'tail':
              return (
                <tr key={r} className="line hunk" {...(row.kind === 'hunk' ? tools.contextMenuFor(row.hunk, null) : {})}>
                  <td className="ln expander" colSpan={2}>
                    <Expanders row={row} tools={tools} />
                  </td>
                  <td className="code hunk-text" colSpan={2}>
                    {row.kind === 'hunk' ? (
                      <>
                        <HunkCheckbox hunk={row.hunk} tools={tools} />
                        {row.text}
                      </>
                    ) : null}
                  </td>
                </tr>
              )
            case 'revealed':
              return (
                <tr key={r} className="line context revealed">
                  <td className="ln">{row.oldLine}</td>
                  <td className="ln">{row.newLine}</td>
                  <td className="marker" />
                  <Code html={revealedHtml(tools, row.newLine)} />
                </tr>
              )
            case 'line': {
              const { line, key } = row
              if (line.kind === 'noNewline') {
                return (
                  <tr key={r} className="line no-newline">
                    <td className="ln" />
                    <td className="ln" />
                    <td className="marker" />
                    <td className="code">No newline at end of file</td>
                  </tr>
                )
              }
              const handlers = line.kind === 'context' ? {} : tools.gutterHandlers(key)
              const menu = tools.contextMenuFor(row.hunk, line.kind === 'context' ? null : key)
              return (
                <tr key={r} className={`line ${line.kind} ${selectionClass(tools, line, key)}`} {...menu}>
                  <td className="ln" {...handlers}>
                    {line.oldLine ?? ''}
                  </td>
                  <td className="ln" {...handlers}>
                    {line.newLine ?? ''}
                  </td>
                  <td className="marker" {...handlers}>
                    {markers[line.kind]}
                  </td>
                  <Code html={codeHtml(tools, line)} />
                </tr>
              )
            }
          }
        })}
      </tbody>
    </table>
  )
}

type SplitRow =
  | { kind: 'header'; row: Extract<Row, { kind: 'hunk' | 'tail' }> }
  | { kind: 'pair'; left: Extract<Row, { kind: 'line' }> | null; right: Extract<Row, { kind: 'line' }> | null }
  | { kind: 'revealed'; row: Extract<Row, { kind: 'revealed' }> }

/** Pairs deletions with the additions that follow them so they line up side by side. */
function toSplitRows(rows: Row[]): SplitRow[] {
  const result: SplitRow[] = []
  let deletes: Extract<Row, { kind: 'line' }>[] = []
  let adds: Extract<Row, { kind: 'line' }>[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(deletes.length, adds.length); i++) {
      result.push({ kind: 'pair', left: deletes[i] ?? null, right: adds[i] ?? null })
    }
    deletes = []
    adds = []
  }
  for (const row of rows) {
    if (row.kind === 'line') {
      if (row.line.kind === 'delete') {
        if (adds.length > 0) {
          flush()
        }
        deletes.push(row)
      } else if (row.line.kind === 'add') {
        adds.push(row)
      } else if (row.line.kind === 'context') {
        flush()
        result.push({ kind: 'pair', left: row, right: row })
      }
    } else {
      flush()
      result.push(row.kind === 'revealed' ? { kind: 'revealed', row } : { kind: 'header', row })
    }
  }
  flush()
  return result
}

function SplitTable(props: { rows: Row[]; tools: RowTools }) {
  const { tools } = props
  const rows = useMemo(() => toSplitRows(props.rows), [props.rows])
  return (
    <table className="diff-table split">
      <colgroup>
        <col className="col-ln" />
        <col className="col-code" />
        <col className="col-ln" />
        <col className="col-code" />
      </colgroup>
      <tbody>
        {rows.map((row, i) => {
          if (row.kind === 'header') {
            return (
              <tr
                key={i}
                className="line hunk"
                {...(row.row.kind === 'hunk' ? tools.contextMenuFor(row.row.hunk, null) : {})}
              >
                <td className="ln expander">
                  <Expanders row={row.row} tools={tools} />
                </td>
                <td className="code hunk-text" colSpan={3}>
                  {row.row.kind === 'hunk' ? (
                    <>
                      <HunkCheckbox hunk={row.row.hunk} tools={tools} />
                      {row.row.text}
                    </>
                  ) : null}
                </td>
              </tr>
            )
          }
          if (row.kind === 'revealed') {
            const html = revealedHtml(tools, row.row.newLine)
            return (
              <tr key={i} className="line revealed">
                <td className="ln context">{row.row.oldLine}</td>
                <Code html={html} />
                <td className="ln context">{row.row.newLine}</td>
                <Code html={html} />
              </tr>
            )
          }
          return (
            <tr key={i} className="line">
              <SplitSide row={row.left} side="left" tools={tools} />
              <SplitSide row={row.right} side="right" tools={tools} />
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function SplitSide(props: { row: Extract<Row, { kind: 'line' }> | null; side: 'left' | 'right'; tools: RowTools }) {
  const { row, tools } = props
  if (!row) {
    return (
      <>
        <td className="ln empty" />
        <td className="code empty" />
      </>
    )
  }
  const { line, key } = row
  const number = props.side === 'left' ? line.oldLine : line.newLine
  const selectable = selectionClass(tools, line, key)
  const handlers = line.kind === 'context' ? {} : tools.gutterHandlers(key)
  const menu = tools.contextMenuFor(row.hunk, line.kind === 'context' ? null : key)
  return (
    <>
      <td className={`ln ${line.kind} ${selectable}`} {...handlers} {...menu}>
        {number ?? ''}
      </td>
      <Code html={codeHtml(tools, line)} className={`${line.kind} ${selectable}`} {...menu} />
    </>
  )
}
