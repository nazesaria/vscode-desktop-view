import React, { useEffect, useRef, useState } from 'react'
import { BranchInfo, RepoInfo, SyncAction, SyncStatus } from '../../src/protocol'
import { relativeTime } from '../format'
import { post } from '../vscode-api'
import { Icon, IconButton, useMinuteTick } from './Common'

function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return { open, setOpen, ref }
}

interface ToolbarProps {
  repos: RepoInfo[]
  current: RepoInfo
  onRefresh: () => void
  branches: BranchInfo[] | null
  sync: SyncStatus | null
  syncing: SyncAction | null
}

/** The top bar of GitHub Desktop: current repository, current branch and push/pull. */
export function Toolbar(props: ToolbarProps) {
  const { open, setOpen, ref } = usePopover()
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const filtered = props.repos.filter(r =>
    `${r.name} ${r.qualifier ?? ''}`.toLowerCase().includes(filter.toLowerCase())
  )

  const choose = (repo: RepoInfo, newTab: boolean) => {
    setOpen(false)
    setFilter('')
    if (repo.root === props.current.root) {
      return
    }
    post(newTab ? { type: 'openRepoInNewTab', root: repo.root } : { type: 'switchRepo', root: repo.root })
  }

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setActive(Math.min(filtered.length - 1, active + 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setActive(Math.max(0, active - 1))
      e.preventDefault()
    } else if (e.key === 'Enter' && filtered[active]) {
      choose(filtered[active], e.ctrlKey || e.metaKey)
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-dropdown" ref={ref}>
        <button className={`toolbar-button ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
          <Icon name="repo" className="toolbar-icon" />
          <span className="toolbar-text">
            <span className="toolbar-label">Current repository</span>
            <span className="toolbar-value">
              {props.current.name}
              {props.current.qualifier ? <span className="repo-qualifier"> · {props.current.qualifier}</span> : null}
            </span>
          </span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} className="toolbar-chevron" />
        </button>
        {open ? (
          <div className="popover repo-popover">
            <input
              autoFocus
              className="filter-input"
              placeholder="Filter repositories"
              value={filter}
              onChange={e => {
                setFilter(e.target.value)
                setActive(0)
              }}
              onKeyDown={onFilterKey}
            />
            <div className="repo-list">
              {filtered.map((repo, i) => (
                <div
                  key={repo.root}
                  className={`repo-row ${repo.root === props.current.root ? 'current' : ''} ${i === active ? 'active' : ''}`}
                  onClick={e => choose(repo, e.ctrlKey || e.metaKey)}
                  onMouseEnter={() => setActive(i)}
                  title={repo.root}
                >
                  <Icon name={repo.github ? 'github' : 'repo'} />
                  <span className="repo-name">
                    {repo.name}
                    {repo.qualifier ? <span className="repo-qualifier"> · {repo.qualifier}</span> : null}
                  </span>
                  {repo.branch ? <span className="repo-branch">{repo.branch}</span> : null}
                  {repo.root !== props.current.root ? (
                    <IconButton
                      icon="split-horizontal"
                      title="Open in a new tab (Ctrl+Click)"
                      onClick={e => {
                        e.stopPropagation()
                        choose(repo, true)
                      }}
                    />
                  ) : null}
                </div>
              ))}
              {filtered.length === 0 ? <div className="list-empty">No repositories match</div> : null}
            </div>
          </div>
        ) : null}
      </div>
      <BranchDropdown root={props.current.root} current={props.current.branch} branches={props.branches} />
      <SyncButton status={props.sync} syncing={props.syncing} />
      <span className="spacer" />
      <IconButton icon="terminal" title="Open in Terminal" onClick={() => post({ type: 'openTerminal' })} />
      <IconButton icon="refresh" title="Refresh" onClick={props.onRefresh} />
    </div>
  )
}

/** "Current branch": filter, switch, create; right click a branch to rename or delete it. */
function BranchDropdown(props: { root: string; current: string | null; branches: BranchInfo[] | null }) {
  const { open, setOpen, ref } = usePopover()
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)

  const all = props.branches ?? []
  const localNames = new Set(all.filter(b => !b.remote).map(b => b.name))
  const upstreams = new Set(all.flatMap(b => (b.upstream ? [b.upstream] : [])))
  const matches = (b: BranchInfo) => b.name.toLowerCase().includes(filter.toLowerCase())
  const local = all.filter(b => !b.remote && matches(b))
  // Like Desktop, a remote branch that already has a local counterpart is listed once, as the local one.
  const remote = all.filter(
    b => b.remote && matches(b) && !upstreams.has(b.name) && !localNames.has(b.name.slice(b.name.indexOf('/') + 1))
  )
  const options = [...local, ...remote].slice(0, 300)

  const toggle = () => {
    if (!open) {
      post({ type: 'loadBranchList' })
      setFilter('')
      setActive(0)
    }
    setOpen(!open)
  }
  const choose = (branch: BranchInfo) => {
    setOpen(false)
    if (branch.remote || branch.name !== props.current) {
      post({ type: 'checkoutBranch', branch })
    }
  }
  const createBranch = () => {
    setOpen(false)
    post({ type: 'createBranch' })
  }

  const row = (b: BranchInfo, i: number) => (
    <div
      key={b.name}
      className={`branch-row ${i === active ? 'active' : ''} ${b.name === props.current && !b.remote ? 'current' : ''}`}
      onClick={() => choose(b)}
      onMouseEnter={() => setActive(i)}
      title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
      data-vscode-context={JSON.stringify({
        webviewSection: 'branch',
        root: props.root,
        branch: b.name,
        desktopViewRemoteBranch: b.remote,
        desktopViewCurrentBranch: !b.remote && b.name === props.current,
        preventDefaultContextMenuItems: true,
      })}
    >
      <Icon name={b.name === props.current && !b.remote ? 'check' : b.remote ? 'cloud' : 'git-branch'} />
      <span className="switcher-name">{b.name}</span>
      {b.date ? <span className="switcher-date">{relativeTime(b.date)}</span> : null}
    </div>
  )

  return (
    <div className="toolbar-dropdown" ref={ref}>
      <button className={`toolbar-button ${open ? 'open' : ''}`} onClick={toggle}>
        <Icon name="git-branch" className="toolbar-icon" />
        <span className="toolbar-text">
          <span className="toolbar-label">Current branch</span>
          <span className="toolbar-value">{props.current ?? '(detached HEAD)'}</span>
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="toolbar-chevron" />
      </button>
      {open ? (
        <div className="popover branch-switcher">
          <div className="popover-row">
            <input
              autoFocus
              className="filter-input"
              placeholder="Filter branches"
              value={filter}
              onChange={e => {
                setFilter(e.target.value)
                setActive(0)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  setActive(Math.min(options.length - 1, active + 1))
                  e.preventDefault()
                } else if (e.key === 'ArrowUp') {
                  setActive(Math.max(0, active - 1))
                  e.preventDefault()
                } else if (e.key === 'Enter' && options[active]) {
                  choose(options[active])
                }
              }}
            />
            <button className="primary-button" onClick={createBranch}>
              New branch
            </button>
          </div>
          <div className="repo-list">
            {props.branches === null ? <div className="list-empty">Loading branches…</div> : null}
            {local.length > 0 ? <div className="popover-title">Local</div> : null}
            {local.map((b, i) => row(b, i))}
            {remote.length > 0 ? <div className="popover-title">Remote</div> : null}
            {remote.slice(0, Math.max(0, 300 - local.length)).map((b, i) => row(b, local.length + i))}
            {props.branches !== null && options.length === 0 ? (
              <div className="list-empty">No branches match</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const SyncingLabels: Record<SyncAction, string> = {
  fetch: 'Fetching',
  pull: 'Pulling',
  push: 'Pushing',
  publish: 'Publishing',
}

/** GitHub Desktop's third button: Fetch, Pull or Push depending on the branch state. */
function SyncButton(props: { status: SyncStatus | null; syncing: SyncAction | null }) {
  useMinuteTick()
  const { open, setOpen, ref } = usePopover()
  const { status, syncing } = props
  if (!status) {
    return null
  }
  const remote = status.remote ?? 'origin'
  const fetched = status.lastFetched ? `Last fetched: ${relativeTime(status.lastFetched)}` : 'Never fetched'

  let action: SyncAction | null
  let icon: string
  let label: string
  let description = fetched
  if (!status.remote) {
    action = null
    icon = 'cloud-upload'
    label = 'No remote'
    description = 'Add a remote to publish this repository'
  } else if (status.branch && !status.upstream) {
    action = 'publish'
    icon = 'cloud-upload'
    label = 'Publish branch'
    description = `Publish this branch to ${remote}`
  } else if (status.behind > 0) {
    action = 'pull'
    icon = 'arrow-down'
    label = `Pull ${remote}`
  } else if (status.ahead > 0) {
    action = 'push'
    icon = 'arrow-up'
    label = `Push ${remote}`
  } else {
    action = 'fetch'
    icon = 'sync'
    label = `Fetch ${remote}`
  }
  if (syncing) {
    icon = 'sync~spin'
    label = `${SyncingLabels[syncing]} ${syncing === 'publish' ? 'branch' : remote}`
  }

  const run = (a: SyncAction) => {
    setOpen(false)
    post({ type: 'sync', action: a })
  }
  const menuItem = (a: SyncAction, text: string, enabled: boolean) => (
    <button className="menu-item" disabled={!enabled} onClick={() => run(a)}>
      {text}
    </button>
  )

  return (
    <div className="toolbar-dropdown sync" ref={ref}>
      <button
        className="toolbar-button"
        disabled={action === null || syncing !== null}
        onClick={() => action && run(action)}
        title={status.upstream ? `${status.branch} → ${status.upstream}` : undefined}
      >
        <Icon name={icon} className="toolbar-icon" />
        <span className="toolbar-text">
          <span className="toolbar-value">{label}</span>
          <span className="toolbar-label">{description}</span>
        </span>
        {!syncing && status.behind > 0 ? (
          <span className="sync-count">
            {status.behind}
            <Icon name="arrow-small-down" />
          </span>
        ) : null}
        {!syncing && status.ahead > 0 ? (
          <span className="sync-count">
            {status.ahead}
            <Icon name="arrow-small-up" />
          </span>
        ) : null}
      </button>
      {status.remote ? (
        <button
          className={`toolbar-button sync-more ${open ? 'open' : ''}`}
          disabled={syncing !== null}
          title="More sync actions"
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'chevron-up' : 'chevron-down'} />
        </button>
      ) : null}
      {open ? (
        <div className="popover sync-menu">
          {menuItem('fetch', `Fetch ${remote}`, true)}
          {menuItem('pull', `Pull ${remote}`, status.upstream !== null)}
          {status.upstream === null && status.branch
            ? menuItem('publish', `Publish branch to ${remote}`, true)
            : menuItem('push', `Push ${remote}`, status.upstream !== null)}
        </div>
      ) : null}
    </div>
  )
}

/** The "Select branch to compare…" box above the history list. */
export function BranchCompare(props: {
  branches: string[] | null
  currentBranch: string | null
  value: string | null
  mode: 'behind' | 'ahead'
  onOpen: () => void
  onChange: (branch: string | null) => void
  onModeChange: (mode: 'behind' | 'ahead') => void
}) {
  const { open, setOpen, ref } = usePopover()
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const options = (props.branches ?? [])
    .filter(b => b !== props.currentBranch)
    .filter(b => b.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 200)

  const pick = (branch: string) => {
    props.onChange(branch)
    setFilter('')
    setOpen(false)
  }

  return (
    <div className="branch-compare" ref={ref}>
      <div className="compare-input">
        <Icon name="git-branch" />
        <input
          placeholder="Select branch to compare…"
          value={open ? filter : props.value ?? ''}
          onFocus={() => {
            props.onOpen()
            setOpen(true)
          }}
          onChange={e => {
            setFilter(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              setActive(Math.min(options.length - 1, active + 1))
              e.preventDefault()
            } else if (e.key === 'ArrowUp') {
              setActive(Math.max(0, active - 1))
              e.preventDefault()
            } else if (e.key === 'Enter' && options[active]) {
              pick(options[active])
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setOpen(false)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {props.value ? <IconButton icon="close" title="Clear comparison" onClick={() => props.onChange(null)} /> : null}
      </div>
      {open ? (
        <div className="popover branch-popover">
          {props.branches === null ? <div className="list-empty">Loading branches…</div> : null}
          {options.map((b, i) => (
            <div
              key={b}
              className={`branch-row ${i === active ? 'active' : ''}`}
              onMouseDown={e => {
                e.preventDefault()
                pick(b)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Icon name="git-branch" /> {b}
            </div>
          ))}
          {props.branches !== null && options.length === 0 ? <div className="list-empty">No branches match</div> : null}
        </div>
      ) : null}
      {props.value ? (
        <div className="segmented">
          <button className={props.mode === 'behind' ? 'active' : ''} onClick={() => props.onModeChange('behind')}>
            Behind
          </button>
          <button className={props.mode === 'ahead' ? 'active' : ''} onClick={() => props.onModeChange('ahead')}>
            Ahead
          </button>
        </div>
      ) : null}
    </div>
  )
}
