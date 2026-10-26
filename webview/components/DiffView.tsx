import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DiffLine, parseDiff, toSplitRows } from '../../src/diff-parser'
import { ChangedFile, DiffResult } from '../../src/protocol'
import { highlightLine, languageForPath } from '../highlight'
import { IconButton, Loading, PathLabel, Placeholder, Stats } from './Common'

export interface DiffOptions {
  split: boolean
  hideWhitespace: boolean
}

export type DiffState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; result: DiffResult }

interface DiffViewProps {
  file: ChangedFile | null
  state: DiffState | null
  options: DiffOptions
  /** GitHub patches can't be re-requested without whitespace. */
  whitespaceSupported: boolean
  onOptionsChange: (options: DiffOptions) => void
  onOpenInEditor: () => void
}

/** Rendering every line of a huge diff locks up the webview; show this many first. */
const InitialLineLimit = 3000

export function DiffView(props: DiffViewProps) {
  if (!props.file) {
    return (
      <div className="diff-view">
        <Placeholder icon="diff">Select a file to see its changes</Placeholder>
      </div>
    )
  }
  return (
    <div className="diff-view">
      <DiffHeader {...props} file={props.file} />
      <div className="diff-body">
        <DiffBody file={props.file} state={props.state} split={props.options.split} />
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

function DiffBody(props: { file: ChangedFile; state: DiffState | null; split: boolean }) {
  const { state } = props
  const [showAll, setShowAll] = useState(false)
  useEffect(() => setShowAll(false), [props.file.path, state])

  const parsed = useMemo(
    () => (state?.status === 'loaded' && !state.result.binary ? parseDiff(state.result.text) : null),
    [state]
  )
  const language = useMemo(() => languageForPath(props.file.path), [props.file.path])

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

  const totalLines = parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
  const limit = showAll ? Infinity : InitialLineLimit
  const truncated = totalLines > limit

  return (
    <>
      {props.split ? (
        <SplitTable hunks={parsed.hunks} language={language} limit={limit} />
      ) : (
        <UnifiedTable hunks={parsed.hunks} language={language} limit={limit} />
      )}
      {truncated ? (
        <div className="diff-truncated">
          Showing {InitialLineLimit} of {totalLines} lines.{' '}
          <button className="link-button" onClick={() => setShowAll(true)}>
            Show the full diff
          </button>
        </div>
      ) : null}
    </>
  )
}

const markers: Record<string, string> = { add: '+', delete: '-', context: ' ' }

function Code(props: { line: DiffLine; language?: string; className?: string }) {
  const html = useMemo(() => highlightLine(props.line.text, props.language), [props.line, props.language])
  // A zero-width space keeps empty lines at full height.
  return <td className={`code ${props.className ?? ''}`} dangerouslySetInnerHTML={{ __html: html || '\u200b' }} />
}

function UnifiedTable(props: { hunks: ReturnType<typeof parseDiff>['hunks']; language?: string; limit: number }) {
  const rows: React.ReactNode[] = []
  let count = 0
  outer: for (const [h, hunk] of props.hunks.entries()) {
    for (const [i, line] of hunk.lines.entries()) {
      if (count++ >= props.limit) {
        break outer
      }
      const key = `${h}:${i}`
      if (line.kind === 'hunk') {
        rows.push(
          <tr key={key} className="line hunk">
            <td className="ln" colSpan={2}>
              <span className="codicon codicon-fold" />
            </td>
            <td className="code hunk-text" colSpan={2}>
              {line.text}
            </td>
          </tr>
        )
      } else if (line.kind === 'noNewline') {
        rows.push(
          <tr key={key} className="line no-newline">
            <td className="ln" />
            <td className="ln" />
            <td className="marker" />
            <td className="code">No newline at end of file</td>
          </tr>
        )
      } else {
        rows.push(
          <tr key={key} className={`line ${line.kind}`}>
            <td className="ln">{line.oldLine ?? ''}</td>
            <td className="ln">{line.newLine ?? ''}</td>
            <td className="marker">{markers[line.kind]}</td>
            <Code line={line} language={props.language} />
          </tr>
        )
      }
    }
  }
  return (
    <table className="diff-table unified">
      <tbody>{rows}</tbody>
    </table>
  )
}

function SplitTable(props: { hunks: ReturnType<typeof parseDiff>['hunks']; language?: string; limit: number }) {
  const rows = useMemo(() => toSplitRows(props.hunks), [props.hunks])
  return (
    <table className="diff-table split">
      <colgroup>
        <col className="col-ln" />
        <col className="col-code" />
        <col className="col-ln" />
        <col className="col-code" />
      </colgroup>
      <tbody>
        {rows.slice(0, props.limit).map((row, i) =>
          row.kind === 'hunk' ? (
            <tr key={i} className="line hunk">
              <td className="ln">
                <span className="codicon codicon-fold" />
              </td>
              <td className="code hunk-text" colSpan={3}>
                {row.hunkText}
              </td>
            </tr>
          ) : (
            <tr key={i} className="line">
              <SplitSide line={row.left} side="left" language={props.language} />
              <SplitSide line={row.right} side="right" language={props.language} />
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

function SplitSide(props: { line: DiffLine | null; side: 'left' | 'right'; language?: string }) {
  const { line } = props
  if (!line) {
    return (
      <>
        <td className="ln empty" />
        <td className="code empty" />
      </>
    )
  }
  const number = props.side === 'left' ? line.oldLine : line.newLine
  return (
    <>
      <td className={`ln ${line.kind}`}>{number ?? ''}</td>
      <Code line={line} language={props.language} className={line.kind} />
    </>
  )
}
