import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChangedFile,
  CommitSummary,
  DiffSource,
  HostToWebview,
  PullRequestSummary,
  RepoInfo,
} from '../src/protocol'
import { Avatar, Icon, Loading, Placeholder, Resizer } from './components/Common'
import { DiffOptions, DiffState, DiffView } from './components/DiffView'
import { FileList } from './components/FileList'
import { commitAvatar, CommitHeader, PullRequestHeader, PullRequestStateBadge } from './components/Headers'
import { List } from './components/List'
import { BranchCompare, Toolbar } from './components/Toolbar'
import { relativeTime } from './format'
import { loadState, onMessage, post, saveState } from './vscode-api'

type Tab = 'changes' | 'history' | 'prs'

interface PullRequestDetail {
  number: number
  pr: PullRequestSummary
  commits: CommitSummary[]
  files: ChangedFile[]
}

/** The diff the right-hand pane should show, derived from the current selection. */
interface DiffTarget {
  source: DiffSource
  file: ChangedFile
}

export function App() {
  const persisted = useMemo(loadState, [])

  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [repo, setRepo] = useState<RepoInfo | null>(null)
  const [tab, setTabState] = useState<Tab>(persisted.tab ?? 'history')
  const [sidebarWidth, setSidebarWidth] = useState(persisted.sidebarWidth ?? 300)
  const [filesWidth, setFilesWidth] = useState(persisted.filesWidth ?? 260)
  const [diffOptions, setDiffOptionsState] = useState<DiffOptions>({
    split: persisted.split ?? false,
    hideWhitespace: persisted.hideWhitespace ?? false,
  })
  const [error, setError] = useState<string | null>(null)

  // Changes
  const [changes, setChanges] = useState<ChangedFile[] | null>(null)
  const [changePath, setChangePath] = useState<string | null>(null)

  // History
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [compareBranch, setCompareBranch] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState<'behind' | 'ahead'>('behind')
  const [branches, setBranches] = useState<string[] | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<{ sha: string; files: ChangedFile[] } | null>(null)
  const [commitFilePath, setCommitFilePath] = useState<string | null>(null)

  // Pull requests
  const [prState, setPrStateValue] = useState<'open' | 'closed'>(persisted.prState ?? 'open')
  const [prs, setPrs] = useState<PullRequestSummary[]>([])
  const [prsPage, setPrsPage] = useState(0)
  const [prsHasMore, setPrsHasMore] = useState(false)
  const [prsLoading, setPrsLoading] = useState(false)
  const [prsError, setPrsError] = useState<string | null>(null)
  const [prFilter, setPrFilter] = useState('')
  const [selectedPr, setSelectedPr] = useState<number | null>(null)
  const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null)
  const [prDetailError, setPrDetailError] = useState<string | null>(null)
  const [prCommit, setPrCommit] = useState<string | null>(null)
  const [prCommitFiles, setPrCommitFiles] = useState<{ sha: string; files: ChangedFile[] } | null>(null)
  const [prFilePath, setPrFilePath] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(false)

  // Diff
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [diffRefresh, setDiffRefresh] = useState(0)
  const diffRequestId = useRef(0)

  // Latest values for the message handler, which is registered once.
  const live = useRef({ compareKey: '', selectedSha, selectedPr, prCommit, tab, prState, commits })
  live.current = {
    compareKey: compareBranch ? `${compareMode}:${compareBranch}` : '',
    selectedSha,
    selectedPr,
    prCommit,
    tab,
    prState,
    commits,
  }

  const setTab = (t: Tab) => {
    setTabState(t)
    saveState({ tab: t })
  }
  const setDiffOptions = (o: DiffOptions) => {
    setDiffOptionsState(o)
    saveState({ split: o.split, hideWhitespace: o.hideWhitespace })
  }
  const setPrState = (s: 'open' | 'closed') => {
    setPrStateValue(s)
    saveState({ prState: s })
  }

  // ---------------------------------------------------------------------------
  // Loading

  const loadHistory = useCallback((skip: number, compare: { branch: string; mode: 'behind' | 'ahead' } | null) => {
    setHistoryLoading(true)
    setHistoryError(null)
    post({ type: 'loadHistory', skip, compare: compare ?? undefined })
  }, [])

  const loadPullRequests = useCallback((state: 'open' | 'closed', page: number) => {
    setPrsLoading(true)
    setPrsError(null)
    post({ type: 'loadPullRequests', state, page })
  }, [])

  const resetForRepo = () => {
    setChanges(null)
    setChangePath(null)
    setCommits([])
    setHistoryHasMore(false)
    setCompareBranch(null)
    setBranches(null)
    setSelectedSha(null)
    setCommitFiles(null)
    setCommitFilePath(null)
    setPrs([])
    setPrsPage(0)
    setPrsHasMore(false)
    setPrsError(null)
    setSelectedPr(null)
    setPrDetail(null)
    setPrCommit(null)
    setPrCommitFiles(null)
    setPrFilePath(null)
    setDiff(null)
  }

  useEffect(() => {
    const dispose = onMessage((m: HostToWebview) => {
      switch (m.type) {
        case 'init':
          resetForRepo()
          setRepos(m.repos)
          setRepo(m.current)
          saveState({ root: m.current.root })
          post({ type: 'loadChanges' })
          loadHistory(0, null)
          if (m.current.github && live.current.tab === 'prs') {
            loadPullRequests(live.current.prState, 1)
          }
          return
        case 'repos':
          setRepos(m.repos)
          setRepo(m.current)
          return
        case 'changes':
          setChanges(m.files)
          return
        case 'history':
          if (m.compareKey !== live.current.compareKey) {
            return
          }
          setHistoryLoading(false)
          setHistoryHasMore(m.hasMore)
          setCommits(prev => {
            if (m.skip === 0) {
              return m.commits
            }
            const seen = new Set(prev.map(c => c.sha))
            return [...prev, ...m.commits.filter(c => !seen.has(c.sha))]
          })
          return
        case 'branches':
          setBranches(m.branches)
          return
        case 'commitFiles':
          if (m.sha === live.current.selectedSha) {
            setCommitFiles({ sha: m.sha, files: m.files })
          }
          return
        case 'diff':
          if (m.requestId === diffRequestId.current) {
            setDiff({ status: 'loaded', result: m.result })
          }
          return
        case 'pullRequests':
          if (m.state !== live.current.prState) {
            return
          }
          setPrsLoading(false)
          setPrsHasMore(m.hasMore)
          setPrsPage(m.page)
          setPrs(prev => (m.page === 1 ? m.items : [...prev, ...m.items.filter(p => !prev.some(q => q.number === p.number))]))
          return
        case 'pullRequest':
          if (m.number === live.current.selectedPr) {
            setPrDetail({ number: m.number, pr: m.pr, commits: m.commits, files: m.files })
          }
          // Keep the list entry in sync with the freshly loaded details.
          setPrs(prev => prev.map(p => (p.number === m.number ? m.pr : p)))
          return
        case 'pullRequestCommitFiles':
          if (m.number === live.current.selectedPr && m.sha === live.current.prCommit) {
            setPrCommitFiles({ sha: m.sha, files: m.files })
          }
          return
        case 'githubAuth':
          setSignedIn(m.signedIn)
          return
        case 'repoChanged':
          post({ type: 'loadChanges' })
          if (m.headChanged) {
            const key = live.current.compareKey
            const [mode, ...branch] = key.split(':')
            loadHistory(0, key ? { mode: mode as 'behind' | 'ahead', branch: branch.join(':') } : null)
          }
          if (live.current.tab === 'changes') {
            setDiffRefresh(n => n + 1)
          }
          return
        case 'error':
          switch (m.scope) {
            case 'loadDiff':
              if (m.requestId === diffRequestId.current) {
                setDiff({ status: 'error', message: m.message })
              }
              return
            case 'loadHistory':
              setHistoryLoading(false)
              setHistoryError(m.message)
              return
            case 'loadPullRequests':
              setPrsLoading(false)
              setPrsError(m.message)
              return
            case 'loadPullRequest':
              setPrDetailError(m.message)
              return
            default:
              setError(m.message)
          }
      }
    })
    post({ type: 'ready' })
    return dispose
  }, [loadHistory, loadPullRequests])

  // Pull requests load lazily, the first time the tab is shown.
  useEffect(() => {
    if (tab === 'prs' && repo?.github && prs.length === 0 && !prsLoading && !prsError) {
      loadPullRequests(prState, 1)
    }
  }, [tab, repo, prState])

  // Re-fetch the list after signing in, private repositories become visible.
  useEffect(() => {
    if (signedIn && repo?.github && tab === 'prs') {
      loadPullRequests(prState, 1)
      if (selectedPr !== null) {
        post({ type: 'loadPullRequest', number: selectedPr })
      }
    }
  }, [signedIn])

  // Like GitHub Desktop, select the first commit / file automatically.
  useEffect(() => {
    if (tab === 'history' && commits.length > 0 && (selectedSha === null || !commits.some(c => c.sha === selectedSha))) {
      selectCommit(commits[0])
    }
  }, [tab, commits])

  useEffect(() => {
    if (changes && changes.length > 0 && (changePath === null || !changes.some(f => f.path === changePath))) {
      setChangePath(changes[0].path)
    }
  }, [changes])

  useEffect(() => {
    if (commitFiles && commitFiles.files.length > 0 && !commitFiles.files.some(f => f.path === commitFilePath)) {
      setCommitFilePath(commitFiles.files[0].path)
    }
  }, [commitFiles])

  const prFiles = prCommit ? (prCommitFiles?.sha === prCommit ? prCommitFiles.files : null) : prDetail?.files ?? null
  useEffect(() => {
    if (prFiles && prFiles.length > 0 && !prFiles.some(f => f.path === prFilePath)) {
      setPrFilePath(prFiles[0].path)
    }
  }, [prFiles])

  // ---------------------------------------------------------------------------
  // Selection

  function selectCommit(commit: CommitSummary) {
    if (commit.sha === live.current.selectedSha) {
      return
    }
    live.current.selectedSha = commit.sha
    setSelectedSha(commit.sha)
    setCommitFiles(null)
    post({ type: 'loadCommitFiles', sha: commit.sha })
  }

  function selectPullRequest(pr: PullRequestSummary) {
    if (pr.number === live.current.selectedPr) {
      return
    }
    live.current.selectedPr = pr.number
    live.current.prCommit = null
    setSelectedPr(pr.number)
    setPrDetail(null)
    setPrDetailError(null)
    setPrCommit(null)
    setPrCommitFiles(null)
    post({ type: 'loadPullRequest', number: pr.number })
  }

  function selectPrCommit(sha: string | null) {
    live.current.prCommit = sha
    setPrCommit(sha)
    setPrCommitFiles(null)
    if (sha && selectedPr !== null) {
      post({ type: 'loadPullRequestCommitFiles', number: selectedPr, sha })
    }
  }

  function changeCompare(branch: string | null, mode = compareMode) {
    setCompareBranch(branch)
    setCompareMode(mode)
    setCommits([])
    setSelectedSha(null)
    live.current.selectedSha = null
    live.current.compareKey = branch ? `${mode}:${branch}` : ''
    loadHistory(0, branch ? { branch, mode } : null)
  }

  const refresh = () => {
    post({ type: 'loadChanges' })
    changeCompare(compareBranch)
    setBranches(null)
    if (repo?.github && tab === 'prs') {
      loadPullRequests(prState, 1)
      if (selectedPr !== null) {
        post({ type: 'loadPullRequest', number: selectedPr })
      }
    }
    setDiffRefresh(n => n + 1)
  }

  // ---------------------------------------------------------------------------
  // Diff

  const target: DiffTarget | null = useMemo(() => {
    if (tab === 'changes') {
      const file = changes?.find(f => f.path === changePath)
      return file ? { source: { kind: 'working' }, file } : null
    }
    if (tab === 'history') {
      const file = commitFiles?.sha === selectedSha ? commitFiles?.files.find(f => f.path === commitFilePath) : undefined
      return file && selectedSha ? { source: { kind: 'commit', sha: selectedSha }, file } : null
    }
    const file = prFiles?.find(f => f.path === prFilePath)
    if (!file || selectedPr === null) {
      return null
    }
    return {
      source: prCommit ? { kind: 'prCommit', number: selectedPr, sha: prCommit } : { kind: 'pr', number: selectedPr },
      file,
    }
  }, [tab, changes, changePath, commitFiles, selectedSha, commitFilePath, prFiles, prFilePath, selectedPr, prCommit])

  const isLocalSource = target?.source.kind === 'commit' || target?.source.kind === 'working'
  const targetKey = target
    ? JSON.stringify([target.source, target.file.path, target.file.status, isLocalSource && diffOptions.hideWhitespace])
    : ''

  useEffect(() => {
    if (!target) {
      setDiff(null)
      return
    }
    const requestId = ++diffRequestId.current
    if (!isLocalSource) {
      // GitHub already sent the patch along with the file list.
      setDiff({
        status: 'loaded',
        result: target.file.patch
          ? { text: target.file.patch, binary: false }
          : {
              text: '',
              binary: false,
              message:
                target.file.additions || target.file.deletions
                  ? 'GitHub did not return a diff for this file (it is too large or binary).'
                  : 'This file has no content changes (binary, mode or rename only).',
            },
      })
      return
    }
    setDiff({ status: 'loading' })
    const { patch, ...file } = target.file
    post({ type: 'loadDiff', requestId, request: { source: target.source, file, hideWhitespace: diffOptions.hideWhitespace } })
  }, [targetKey, diffRefresh])

  const openInEditor = () => {
    if (target) {
      const { patch, ...file } = target.file
      post({ type: 'openDiffInEditor', source: target.source, file })
    }
  }

  const diffView = (
    <DiffView
      file={target?.file ?? null}
      state={diff}
      options={diffOptions}
      whitespaceSupported={isLocalSource}
      onOptionsChange={setDiffOptions}
      onOpenInEditor={openInEditor}
    />
  )

  // ---------------------------------------------------------------------------
  // Render

  if (!repo) {
    return <Loading text="Loading repository…" />
  }

  const githubCommitUrl = (sha: string) =>
    repo.github ? `https://github.com/${repo.github.owner}/${repo.github.name}/commit/${sha}` : undefined
  const selectedCommit = commits.find(c => c.sha === selectedSha) ?? null
  const filteredPrs = prFilter
    ? prs.filter(p => `${p.title} #${p.number} ${p.author} ${p.headRef}`.toLowerCase().includes(prFilter.toLowerCase()))
    : prs

  const withFiles = (header: React.ReactNode, fileList: React.ReactNode) => (
    <div className="details">
      {header}
      <div className="details-body">
        <div className="files-pane" style={{ width: filesWidth }}>
          {fileList}
        </div>
        <Resizer
          width={filesWidth}
          min={160}
          max={700}
          onResize={w => {
            setFilesWidth(w)
            saveState({ filesWidth: w })
          }}
        />
        {diffView}
      </div>
    </div>
  )

  return (
    <div className="app">
      <Toolbar repos={repos} current={repo} onRefresh={refresh} />
      <div className="main">
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <div className="tabs" role="tablist">
            <button role="tab" className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
              Changes
              {changes && changes.length > 0 ? <span className="count-badge">{changes.length}</span> : null}
            </button>
            <button role="tab" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              History
            </button>
            <button role="tab" className={tab === 'prs' ? 'active' : ''} onClick={() => setTab('prs')}>
              Pull Requests
            </button>
          </div>

          {tab === 'changes' ? (
            changes === null ? (
              <Loading />
            ) : (
              <FileList
                root={repo.root}
                files={changes}
                source={{ kind: 'working' }}
                selectedPath={changePath}
                onSelect={f => setChangePath(f.path)}
                onOpenDiff={() => openInEditor()}
                header={`${changes.length} changed file${changes.length === 1 ? '' : 's'}`}
              />
            )
          ) : null}

          {tab === 'history' ? (
            <>
              <BranchCompare
                branches={branches}
                currentBranch={repo.branch}
                value={compareBranch}
                mode={compareMode}
                onOpen={() => branches === null && post({ type: 'loadBranches' })}
                onChange={b => changeCompare(b)}
                onModeChange={m => changeCompare(compareBranch, m)}
              />
              {historyError ? <div className="inline-error">{historyError}</div> : null}
              <List
                ariaLabel="Commits"
                className="commit-list"
                items={commits}
                getKey={c => c.sha}
                selectedKey={selectedSha}
                onSelect={selectCommit}
                rowClassName="commit-row"
                onEndReached={() => {
                  if (historyHasMore && !historyLoading) {
                    loadHistory(commits.length, compareBranch ? { branch: compareBranch, mode: compareMode } : null)
                  }
                }}
                emptyText={
                  historyLoading ? 'Loading…' : compareBranch ? `No commits ${compareMode} ${compareBranch}` : 'No commits yet'
                }
                getContext={c => ({
                  webviewSection: 'commit',
                  sha: c.sha,
                  url: githubCommitUrl(c.sha),
                  desktopViewGitHub: !!repo.github,
                })}
                renderItem={c => (
                  <>
                    <div className="row-title" title={c.summary}>
                      {c.summary}
                      {c.refs.length > 0 ? <span className="ref-badge small">{c.refs[0]}</span> : null}
                    </div>
                    <div className="row-meta">
                      <Avatar url={commitAvatar(c, repo)} name={c.authorName} />
                      <span className="ellipsis">
                        {c.authorName} • {relativeTime(c.date)}
                      </span>
                    </div>
                  </>
                )}
              />
            </>
          ) : null}

          {tab === 'prs' ? (
            !repo.github ? (
              <Placeholder icon="github">
                This repository has no GitHub remote, so it has no pull requests to show.
              </Placeholder>
            ) : (
              <>
                {!signedIn ? (
                  <div className="signin-banner">
                    <span>Sign in to GitHub to see pull requests of private repositories.</span>
                    <button className="primary-button" onClick={() => post({ type: 'signInGitHub' })}>
                      Sign in
                    </button>
                  </div>
                ) : null}
                <div className="pr-filters">
                  <div className="segmented">
                    <button
                      className={prState === 'open' ? 'active' : ''}
                      onClick={() => {
                        setPrState('open')
                        setPrs([])
                        loadPullRequests('open', 1)
                      }}
                    >
                      Open
                    </button>
                    <button
                      className={prState === 'closed' ? 'active' : ''}
                      onClick={() => {
                        setPrState('closed')
                        setPrs([])
                        loadPullRequests('closed', 1)
                      }}
                    >
                      Closed
                    </button>
                  </div>
                  <input
                    className="filter-input"
                    placeholder="Filter pull requests"
                    value={prFilter}
                    onChange={e => setPrFilter(e.target.value)}
                  />
                </div>
                {prsError ? <div className="inline-error">{prsError}</div> : null}
                <List
                  ariaLabel="Pull requests"
                  className="pr-list"
                  items={filteredPrs}
                  getKey={p => String(p.number)}
                  selectedKey={selectedPr === null ? null : String(selectedPr)}
                  onSelect={selectPullRequest}
                  rowClassName="pr-row"
                  onEndReached={() => {
                    if (prsHasMore && !prsLoading) {
                      loadPullRequests(prState, prsPage + 1)
                    }
                  }}
                  emptyText={prsLoading ? 'Loading…' : prsError ? null : `No ${prState} pull requests`}
                  getContext={p => ({ webviewSection: 'pullRequest', url: p.url })}
                  renderItem={p => (
                    <>
                      <div className="row-title" title={p.title}>
                        <PullRequestStateBadge pr={p} />
                        <span className="ellipsis">{p.title}</span>
                      </div>
                      <div className="row-meta">
                        <Avatar url={p.avatarUrl} name={p.author} />
                        <span className="ellipsis">
                          #{p.number} by {p.author} • {relativeTime(p.updatedAt)}
                        </span>
                      </div>
                    </>
                  )}
                />
              </>
            )
          ) : null}
        </div>

        <Resizer
          width={sidebarWidth}
          min={200}
          max={600}
          onResize={w => {
            setSidebarWidth(w)
            saveState({ sidebarWidth: w })
          }}
        />

        <div className="content">
          {tab === 'changes' ? (
            changes && changes.length === 0 ? (
              <Placeholder icon="check">No local changes</Placeholder>
            ) : (
              diffView
            )
          ) : null}

          {tab === 'history' ? (
            selectedCommit ? (
              withFiles(
                <CommitHeader commit={selectedCommit} files={commitFiles?.files ?? null} repo={repo} />,
                commitFiles ? (
                  <FileList
                    root={repo.root}
                    files={commitFiles.files}
                    source={{ kind: 'commit', sha: selectedCommit.sha }}
                    selectedPath={commitFilePath}
                    onSelect={f => setCommitFilePath(f.path)}
                    onOpenDiff={() => openInEditor()}
                  />
                ) : (
                  <Loading />
                )
              )
            ) : (
              <Placeholder icon="history">{historyLoading ? 'Loading history…' : 'No commit selected'}</Placeholder>
            )
          ) : null}

          {tab === 'prs' && repo.github ? (
            selectedPr === null ? (
              <Placeholder icon="git-pull-request">Select a pull request to see its changes</Placeholder>
            ) : prDetailError ? (
              <Placeholder icon="error">{prDetailError}</Placeholder>
            ) : !prDetail ? (
              <Loading text="Loading pull request…" />
            ) : (
              withFiles(
                <PullRequestHeader pr={prDetail.pr} commitCount={prDetail.commits.length} />,
                <>
                  <div className="pr-commit-select">
                    <select value={prCommit ?? ''} onChange={e => selectPrCommit(e.target.value || null)}>
                      <option value="">
                        All changes ({prDetail.commits.length} commit{prDetail.commits.length === 1 ? '' : 's'})
                      </option>
                      {prDetail.commits.map(c => (
                        <option key={c.sha} value={c.sha}>
                          {c.shortSha} {c.summary}
                        </option>
                      ))}
                    </select>
                  </div>
                  {prFiles ? (
                    <FileList
                      root={repo.root}
                      files={prFiles}
                      source={
                        prCommit ? { kind: 'prCommit', number: prDetail.number, sha: prCommit } : { kind: 'pr', number: prDetail.number }
                      }
                      selectedPath={prFilePath}
                      onSelect={f => setPrFilePath(f.path)}
                      onOpenDiff={() => openInEditor()}
                    />
                  ) : (
                    <Loading />
                  )}
                </>
              )
            )
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="toast" role="alert">
          <Icon name="error" />
          <span className="ellipsis">{error}</span>
          <button className="icon-button" onClick={() => setError(null)} title="Dismiss">
            <Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
