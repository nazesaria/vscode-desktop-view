import React from 'react'
import { Icon } from './Common'

interface CommitBoxProps {
  summary: string
  description: string
  onSummaryChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  branch: string | null
  fileCount: number
  busy: boolean
  onCommit: () => void
}

/** The commit form at the bottom of GitHub Desktop's Changes tab. */
export function CommitBox(props: CommitBoxProps) {
  const canCommit = props.summary.trim().length > 0 && props.fileCount > 0 && !props.busy
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) {
      e.preventDefault()
      props.onCommit()
    }
  }
  const tooLong = props.summary.length > 72
  return (
    <div className="commit-box">
      <div className="commit-summary">
        <input
          placeholder="Summary (required)"
          value={props.summary}
          onChange={e => props.onSummaryChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Commit summary"
        />
        {tooLong ? (
          <Icon name="warning" className="summary-warning" title="Great commit summaries are 72 characters or fewer" />
        ) : null}
      </div>
      <textarea
        placeholder="Description"
        value={props.description}
        onChange={e => props.onDescriptionChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Commit description"
        rows={4}
      />
      <button
        className="primary-button commit-button"
        disabled={!canCommit}
        onClick={props.onCommit}
        title={props.fileCount === 0 ? 'Select at least one file to commit' : 'Commit (Ctrl+Enter)'}
      >
        {props.busy ? (
          'Committing…'
        ) : (
          <>
            Commit {props.fileCount > 0 ? `${props.fileCount} file${props.fileCount === 1 ? '' : 's'} ` : ''}to{' '}
            <strong>{props.branch ?? 'HEAD'}</strong>
          </>
        )}
      </button>
    </div>
  )
}

export function UndoBar(props: { summary: string; onUndo: () => void }) {
  return (
    <div className="undo-bar">
      <div className="undo-text">
        <span className="undo-label">Committed just now</span>
        <span className="ellipsis" title={props.summary}>
          {props.summary}
        </span>
      </div>
      <button className="secondary-button" onClick={props.onUndo}>
        Undo
      </button>
    </div>
  )
}
