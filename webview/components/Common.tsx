import React, { useState } from 'react'
import { ChangedFile, FileStatus } from '../../src/protocol'
import { splitPath } from '../format'

/** Vertical drag handle between two panes. */
export function Resizer(props: { width: number; min: number; max: number; onResize: (width: number) => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = props.width
    const move = (ev: MouseEvent) => {
      const width = Math.min(props.max, Math.max(props.min, startWidth + ev.clientX - startX))
      props.onResize(width)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="resizer" onMouseDown={onMouseDown} />
}

export function Avatar(props: { url?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const size = props.size ?? 16
  if (props.url && !failed) {
    return (
      <img
        className="avatar"
        src={props.url}
        width={size}
        height={size}
        alt=""
        title={props.name}
        onError={() => setFailed(true)}
      />
    )
  }
  // Initials on a stable colour, for authors without a GitHub avatar.
  let hash = 0
  for (const c of props.name) {
    hash = (hash * 31 + c.charCodeAt(0)) | 0
  }
  const initials = props.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
  return (
    <span
      className="avatar avatar-initials"
      title={props.name}
      style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${Math.abs(hash) % 360} 45% 40%)` }}
    >
      {initials || '?'}
    </span>
  )
}

const statusIcons: Record<FileStatus, { icon: string; label: string }> = {
  added: { icon: 'diff-added', label: 'Added' },
  untracked: { icon: 'diff-added', label: 'Untracked' },
  modified: { icon: 'diff-modified', label: 'Modified' },
  typechange: { icon: 'diff-modified', label: 'Type changed' },
  deleted: { icon: 'diff-removed', label: 'Deleted' },
  renamed: { icon: 'diff-renamed', label: 'Renamed' },
  copied: { icon: 'diff-renamed', label: 'Copied' },
  conflicted: { icon: 'warning', label: 'Conflicted' },
}

export function StatusIcon(props: { status: FileStatus }) {
  const { icon, label } = statusIcons[props.status]
  return <span className={`codicon codicon-${icon} status-icon status-${props.status}`} title={label} />
}

export function PathLabel(props: { file: ChangedFile }) {
  const { dir, name } = splitPath(props.file.path)
  const title = props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path
  return (
    <span className="path-label" title={title}>
      {props.file.oldPath && props.file.oldPath !== props.file.path ? (
        <span className="path-dir">{props.file.oldPath} → </span>
      ) : null}
      <span className="path-dir">{dir}</span>
      <span className="path-name">{name}</span>
    </span>
  )
}

export function Stats(props: { additions?: number; deletions?: number }) {
  if (props.additions === undefined && props.deletions === undefined) {
    return null
  }
  return (
    <span className="stats">
      <span className="stats-add">+{props.additions ?? 0}</span>
      <span className="stats-del">-{props.deletions ?? 0}</span>
    </span>
  )
}

export function Icon(props: { name: string; title?: string; className?: string }) {
  return <span className={`codicon codicon-${props.name} ${props.className ?? ''}`} title={props.title} />
}

export function IconButton(props: {
  icon: string
  title: string
  onClick: (e: React.MouseEvent) => void
  active?: boolean
}) {
  return (
    <button
      className={`icon-button ${props.active ? 'active' : ''}`}
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  )
}

export function Loading(props: { text?: string }) {
  return (
    <div className="placeholder">
      <Icon name="loading" className="codicon-modifier-spin" /> {props.text ?? 'Loading…'}
    </div>
  )
}

export function Placeholder(props: { icon?: string; children: React.ReactNode }) {
  return (
    <div className="placeholder">
      {props.icon ? <Icon name={props.icon} className="placeholder-icon" /> : null}
      <div>{props.children}</div>
    </div>
  )
}
