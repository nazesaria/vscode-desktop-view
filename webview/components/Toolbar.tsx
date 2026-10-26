import React, { useEffect, useRef, useState } from 'react'
import { RepoInfo } from '../../src/protocol'
import { post } from '../vscode-api'
import { Icon, IconButton } from './Common'

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

/** The top bar of GitHub Desktop: current repository and current branch. */
export function Toolbar(props: { repos: RepoInfo[]; current: RepoInfo; onRefresh: () => void }) {
  const { open, setOpen, ref } = usePopover()
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const filtered = props.repos.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()))

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
            <span className="toolbar-value">{props.current.name}</span>
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
                  <span className="repo-name">{repo.name}</span>
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
      <div className="toolbar-button static">
        <Icon name="git-branch" className="toolbar-icon" />
        <span className="toolbar-text">
          <span className="toolbar-label">Current branch</span>
          <span className="toolbar-value">{props.current.branch ?? '(detached HEAD)'}</span>
        </span>
      </div>
      <span className="spacer" />
      <IconButton icon="refresh" title="Refresh" onClick={props.onRefresh} />
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
