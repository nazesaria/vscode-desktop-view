import React from 'react'
import { ChangedFile, DiffSource } from '../../src/protocol'
import { List } from './List'
import { PathLabel, StatusIcon } from './Common'

interface FileListProps {
  root: string
  files: ReadonlyArray<ChangedFile>
  source: DiffSource
  selectedPath: string | null
  onSelect: (file: ChangedFile) => void
  onOpenDiff: (file: ChangedFile) => void
  header?: React.ReactNode
}

export function FileList(props: FileListProps) {
  const local = props.source.kind === 'commit' || props.source.kind === 'working'
  return (
    <div className="file-list">
      <div className="pane-header">
        {props.header ?? `${props.files.length} changed file${props.files.length === 1 ? '' : 's'}`}
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
        getContext={f => {
          const { patch, ...file } = f
          return {
            webviewSection: 'file',
            root: props.root,
            path: f.path,
            desktopViewLocalFile: local && f.status !== 'deleted',
            diff: JSON.stringify({ source: props.source, file }),
          }
        }}
        renderItem={f => (
          <>
            <PathLabel file={f} />
            <StatusIcon status={f.status} />
          </>
        )}
      />
    </div>
  )
}
