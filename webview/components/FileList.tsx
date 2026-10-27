import React from 'react'
import { ChangedFile, DiffSource } from '../../src/protocol'
import { List } from './List'
import { PathLabel, StatusIcon } from './Common'

export type CheckState = 'checked' | 'unchecked' | 'mixed'

/** Commit inclusion checkboxes, shown in the Changes tab. */
export interface FileChecks {
  stateOf: (file: ChangedFile) => CheckState
  onToggle: (file: ChangedFile) => void
  allState: CheckState
  onToggleAll: () => void
}

interface FileListProps {
  root: string
  files: ReadonlyArray<ChangedFile>
  source: DiffSource
  selectedPath: string | null
  onSelect: (file: ChangedFile) => void
  onOpenDiff: (file: ChangedFile) => void
  header?: React.ReactNode
  checks?: FileChecks
  /** Enables Ctrl/Shift multi-selection. */
  selectedPaths?: ReadonlyArray<string>
  onMultiSelect?: (files: ChangedFile[], focus: ChangedFile) => void
}

export function Checkbox(props: { state: CheckState; onToggle: () => void; title: string }) {
  return (
    <input
      type="checkbox"
      className="file-check"
      title={props.title}
      checked={props.state === 'checked'}
      ref={el => {
        if (el) {
          el.indeterminate = props.state === 'mixed'
        }
      }}
      // Toggling inclusion should not move the list selection.
      onMouseDown={e => e.stopPropagation()}
      onChange={props.onToggle}
    />
  )
}

export function FileList(props: FileListProps) {
  const { checks } = props
  const local = props.source.kind === 'commit' || props.source.kind === 'working'
  const working = props.source.kind === 'working'
  const count = `${props.files.length} changed file${props.files.length === 1 ? '' : 's'}`
  return (
    <div className="file-list">
      <div
        className={`pane-header ${checks ? 'with-check' : ''}`}
        data-vscode-context={
          working
            ? JSON.stringify({ webviewSection: 'changesHeader', root: props.root, preventDefaultContextMenuItems: true })
            : undefined
        }
      >
        {checks && props.files.length > 0 ? (
          <Checkbox state={checks.allState} onToggle={checks.onToggleAll} title="Include all files in the commit" />
        ) : null}
        <span className="pane-header-text">{props.header ?? count}</span>
      </div>
      <List
        ariaLabel="Changed files"
        items={props.files}
        getKey={f => f.path}
        selectedKey={props.selectedPath}
        onSelect={props.onSelect}
        onActivate={props.onOpenDiff}
        rowClassName="file-row"
        emptyText="No changed files"
        multiSelectedKeys={props.selectedPaths}
        onMultiSelect={props.onMultiSelect}
        getContext={f => {
          const { patch, ...file } = f
          // Right click on one of several selected rows acts on all of them.
          const selected =
            props.selectedPaths && props.selectedPaths.length > 1 && props.selectedPaths.includes(f.path)
              ? props.files.filter(g => props.selectedPaths!.includes(g.path)).map(({ patch, ...g }) => g)
              : null
          return {
            webviewSection: 'file',
            root: props.root,
            path: f.path,
            desktopViewLocalFile: local && f.status !== 'deleted',
            desktopViewWorking: working,
            desktopViewMulti: selected !== null,
            diff: JSON.stringify({ source: props.source, file }),
            files: JSON.stringify(selected ?? [file]),
          }
        }}
        renderItem={f => (
          <>
            {checks ? (
              <Checkbox state={checks.stateOf(f)} onToggle={() => checks.onToggle(f)} title="Include in the commit" />
            ) : null}
            <PathLabel file={f} />
            <StatusIcon status={f.status} />
          </>
        )}
      />
    </div>
  )
}
