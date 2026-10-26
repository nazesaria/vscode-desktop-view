import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildDiscardPatch, buildPartialPatch, DiffHunk, parseDiff, selectableKeys } from '../src/diff-parser'
import {
  BranchInfo,
  ChangedFile,
  CommitEntry,
  CommitSummary,
  DiffSource,
  HostToWebview,
  PullRequestSummary,
  RepoInfo,
  SyncAction,
  SyncStatus,
} from '../src/protocol'
import { CommitBox, UndoBar } from './components/CommitBox'
import { Avatar, Icon, Loading, Placeholder, Resizer } from './components/Common'
import { ContextSource, DiffOptions, DiffState, DiffView, LineSelection } from './components/DiffView'
import { CheckState, FileChecks, FileList } from './components/FileList'
import {
  commitAvatar,
  CommitHeader,
  MultiCommitHeader,
  PullRequestHeader,
  PullRequestStateBadge,
} from './components/Headers'
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

/** Lines left out of the next commit for one file, valid for the diff text they were picked on. */
interface LineExclusion {
  diffText: string
  excluded: Set<string>
}

/** Statuses whose diff can be committed line by line (a patch against HEAD applies cleanly). */
const LineSelectableStatuses = new Set(['modified', 'untracked', 'added'])
/** Statuses whose diff hides unchanged lines that can be expanded. */
const ExpandableStatuses = new Set(['modified', 'renamed', 'typechange', 'copied'])

function splitContent(text: string): string[] {
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function withoutPatch(file: ChangedFile): ChangedFile {
  const { patch, ...rest } = file
  return rest
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
  const [branchList, setBranchList] = useState<BranchInfo[] | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncing, setSyncing] = useState<SyncAction | null>(null)

  // Changes
  const [changes, setChanges] = useState<ChangedFile[] | null>(null)
  const [changePath, setChangePath] = useState<string | null>(null)
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set())
  const [lineExclusions, setLineExclusions] = useState<ReadonlyMap<string, LineExclusion>>(new Map())
  const [summary, setSummaryValue] = useState(persisted.commitSummary ?? '')
  const [description, setDescriptionValue] = useState(persisted.commitDescription ?? '')
  const [committing, setCommitting] = useState(false)
  const [lastCommit, setLastCommit] = useState<{ sha: string; summary: string } | null>(null)

  // History
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [compareBranch, setCompareBranch] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState<'behind' | 'ahead'>('behind')
  const [branches, setBranches] = useState<string[] | null>(null)
  /** Focused commit; with several selected, `selectedShas` holds all of them in list order. */
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedShas, setSelectedShas] = useState<string[]>([])
  const [commitFiles, setCommitFiles] = useState<{ sha: string; oldestSha?: string; files: ChangedFile[] } | null>(null)
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
  const [contextLines, setContextLines] = useState<{ key: string; lines: string[] | null } | null>(null)
  const contentRequest = useRef({ id: 0, key: '' })

  // Latest values for the message handler, which is registered once.
  const live = useRef({
    compareKey: '',
    selectedSha,
    selectedShas,
    commitKey: '',
    selectedPr,
    prCommit,
    tab,
    prState,
    commits,
    lastCommitSha: null as string | null,
  })
  live.current = {
    ...live.current,
    compareKey: compareBranch ? `${compareMode}:${compareBranch}` : '',
    selectedSha,
    selectedShas,
    selectedPr,
    prCommit,
    tab,
    prState,
    commits,
    lastCommitSha: lastCommit?.sha ?? null,
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
  const setSummary = (value: string) => {
    setSummaryValue(value)
    saveState({ commitSummary: value })
  }
  const setDescription = (value: string) => {
    setDescriptionValue(value)
    saveState({ commitDescription: value })
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
    setBranchList(null)
    setSyncStatus(null)
    setSyncing(null)
    setChanges(null)
    setChangePath(null)
    setCommits([])
    setHistoryHasMore(false)
    setCompareBranch(null)
    setBranches(null)
    setSelectedSha(null)
    setSelectedShas([])
    setCommitFiles(null)
    setCommitFilePath(null)
    setExcludedFiles(new Set())
    setLineExclusions(new Map())
    setLastCommit(null)
    setContextLines(null)
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
          if (loadState().root !== m.current.root) {
            // Commit message drafts belong to the repository they were written for.
            setSummary('')
            setDescription('')
          }
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
        case 'branchList':
          setBranchList(m.branches)
          return
        case 'syncStatus':
          setSyncStatus(m.status)
          return
        case 'syncing':
          setSyncing(m.action)
          if (m.action === 'push' || m.action === 'publish') {
            // A pushed commit can no longer be undone.
            setLastCommit(null)
          }
          return
        case 'commitFiles':
          if (`${m.sha}:${m.oldestSha ?? ''}` === live.current.commitKey) {
            setCommitFiles({ sha: m.sha, oldestSha: m.oldestSha, files: m.files })
          }
          return
        case 'fileContent':
          if (m.requestId === contentRequest.current.id) {
            setContextLines({ key: contentRequest.current.key, lines: m.text === null ? null : splitContent(m.text) })
          }
          return
        case 'committed':
          setSummary('')
          setDescription('')
          setExcludedFiles(new Set())
          setLineExclusions(new Map())
          setLastCommit(m.canUndo ? { sha: m.sha, summary: m.summary } : null)
          return
        case 'commitDone':
          setCommitting(false)
          return
        case 'undone':
          setSummary(m.summary)
          setDescription(m.description)
          setLastCommit(null)
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
          if (live.current.lastCommitSha && m.head !== live.current.lastCommitSha) {
            setLastCommit(null)
          }
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
    if (commit.sha === live.current.selectedSha && live.current.selectedShas.length <= 1) {
      return
    }
    live.current.selectedSha = commit.sha
    live.current.selectedShas = [commit.sha]
    live.current.commitKey = `${commit.sha}:`
    setSelectedSha(commit.sha)
    setSelectedShas([commit.sha])
    setCommitFiles(null)
    post({ type: 'loadCommitFiles', sha: commit.sha })
  }

  /** Newest and oldest of the selection, or null when the selected commits are not adjacent. */
  function commitRange(shas: ReadonlyArray<string>): { newest: string; oldest: string } | null {
    const indexes = shas.map(sha => commits.findIndex(c => c.sha === sha)).sort((a, b) => a - b)
    if (indexes.length === 0 || indexes[0] < 0 || indexes[indexes.length - 1] - indexes[0] !== indexes.length - 1) {
      return null
    }
    return { newest: commits[indexes[0]].sha, oldest: commits[indexes[indexes.length - 1]].sha }
  }

  function selectCommits(items: CommitSummary[], focus: CommitSummary) {
    if (items.length === 1) {
      selectCommit(items[0])
      return
    }
    const shas = items.map(c => c.sha)
    live.current.selectedSha = focus.sha
    live.current.selectedShas = shas
    setSelectedSha(focus.sha)
    setSelectedShas(shas)
    setCommitFiles(null)
    const range = commitRange(shas)
    live.current.commitKey = range ? `${range.newest}:${range.oldest}` : ''
    if (range) {
      post({ type: 'loadCommitFiles', sha: range.newest, oldestSha: range.oldest })
    }
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
    setSelectedShas([])
    live.current.selectedSha = null
    live.current.selectedShas = []
    live.current.compareKey = branch ? `${mode}:${branch}` : ''
    loadHistory(0, branch ? { branch, mode } : null)
  }

  const refresh = () => {
    post({ type: 'loadChanges' })
    post({ type: 'loadSyncStatus' })
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
      const range = selectedShas.length > 1 ? commitRange(selectedShas) : null
      const sha = range ? range.newest : selectedSha
      if (!sha || (selectedShas.length > 1 && !range)) {
        return null
      }
      const matches = commitFiles?.sha === sha && commitFiles.oldestSha === range?.oldest
      const file = matches ? commitFiles?.files.find(f => f.path === commitFilePath) : undefined
      return file ? { source: { kind: 'commit', sha, oldestSha: range?.oldest }, file } : null
    }
    const file = prFiles?.find(f => f.path === prFilePath)
    if (!file || selectedPr === null) {
      return null
    }
    return {
      source: prCommit ? { kind: 'prCommit', number: selectedPr, sha: prCommit } : { kind: 'pr', number: selectedPr },
      file,
    }
  }, [tab, changes, changePath, commitFiles, selectedSha, selectedShas, commitFilePath, prFiles, prFilePath, selectedPr, prCommit])

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

  // ---------------------------------------------------------------------------
  // Commit selection (Changes tab)

  const workingDiff = useMemo(() => {
    if (tab !== 'changes' || !target || diff?.status !== 'loaded') {
      return null
    }
    const { result } = diff
    if (result.binary || result.tooLarge || result.message) {
      return null
    }
    const hunks = parseDiff(result.text).hunks
    return { path: target.file.path, text: result.text, hunks, keys: selectableKeys(hunks) }
  }, [diff, tab])

  // Line picks are only valid for the diff they were made on; drop them when the file changes.
  useEffect(() => {
    const entry = workingDiff && lineExclusions.get(workingDiff.path)
    if (workingDiff && entry && entry.diffText !== workingDiff.text) {
      const next = new Map(lineExclusions)
      next.delete(workingDiff.path)
      setLineExclusions(next)
    }
  }, [workingDiff])

  const checkState = (file: ChangedFile): CheckState => {
    if (excludedFiles.has(file.path)) {
      return 'unchecked'
    }
    return (lineExclusions.get(file.path)?.excluded.size ?? 0) > 0 ? 'mixed' : 'checked'
  }

  const setFileIncluded = (paths: string[], include: boolean) => {
    const files = new Set(excludedFiles)
    const lines = new Map(lineExclusions)
    for (const path of paths) {
      lines.delete(path)
      if (include) {
        files.delete(path)
      } else {
        files.add(path)
      }
    }
    setExcludedFiles(files)
    setLineExclusions(lines)
  }

  const fileChecks: FileChecks | undefined = changes
    ? {
        stateOf: checkState,
        onToggle: f => setFileIncluded([f.path], checkState(f) === 'unchecked'),
        allState: changes.every(f => checkState(f) === 'checked')
          ? 'checked'
          : changes.every(f => checkState(f) === 'unchecked')
            ? 'unchecked'
            : 'mixed',
        onToggleAll: () =>
          setFileIncluded(
            changes.map(f => f.path),
            !changes.every(f => checkState(f) === 'checked')
          ),
      }
    : undefined

  const lineSelectable =
    workingDiff !== null &&
    target !== null &&
    LineSelectableStatuses.has(target.file.status) &&
    !diffOptions.hideWhitespace &&
    workingDiff.keys.length > 0

  const lineSelection: LineSelection | undefined =
    lineSelectable && workingDiff
      ? {
          excluded: excludedFiles.has(workingDiff.path)
            ? new Set(workingDiff.keys)
            : lineExclusions.get(workingDiff.path)?.excluded ?? new Set(),
          onChange: (keys, include) => {
            const path = workingDiff.path
            const current = excludedFiles.has(path)
              ? new Set(workingDiff.keys)
              : new Set(lineExclusions.get(path)?.excluded ?? [])
            keys.forEach(k => (include ? current.delete(k) : current.add(k)))
            if (current.size === 0 || current.size === workingDiff.keys.length) {
              setFileIncluded([path], current.size === 0)
              return
            }
            const files = new Set(excludedFiles)
            files.delete(path)
            setExcludedFiles(files)
            setLineExclusions(new Map(lineExclusions).set(path, { diffText: workingDiff.text, excluded: current }))
          },
        }
      : undefined

  const discardLines =
    lineSelectable && workingDiff
      ? (keys: string[]) => {
          const patch = buildDiscardPatch(workingDiff.path, workingDiff.hunks, new Set(keys))
          if (patch) {
            post({ type: 'discardLines', path: workingDiff.path, patch, lineCount: keys.length })
          }
        }
      : undefined

  const includedFiles = (changes ?? []).filter(f => checkState(f) !== 'unchecked')

  const commit = () => {
    const entries: CommitEntry[] = []
    for (const file of includedFiles) {
      const lines = lineExclusions.get(file.path)
      if (lines && lines.excluded.size > 0) {
        const hunks: DiffHunk[] = parseDiff(lines.diffText).hunks
        const newFile = file.status === 'untracked' || file.status === 'added'
        const patch = buildPartialPatch(file.path, hunks, lines.excluded, newFile)
        if (patch) {
          entries.push({ file: withoutPatch(file), patch })
        }
      } else {
        entries.push({ file: withoutPatch(file) })
      }
    }
    setCommitting(true)
    post({ type: 'commit', summary, description, entries })
  }

  // ---------------------------------------------------------------------------
  // Context expansion

  const contextKey = `${targetKey}:${diffRefresh}`
  const contextRef = !target
    ? null
    : target.source.kind === 'working'
      ? null
      : target.source.kind === 'pr'
        ? prDetail?.pr.headSha ?? null
        : target.source.sha
  const contextSource: ContextSource | undefined =
    target && ExpandableStatuses.has(target.file.status) && (target.source.kind === 'working' || contextRef)
      ? {
          lines: contextLines?.key === contextKey ? contextLines.lines : undefined,
          request: () => {
            const id = ++contentRequest.current.id
            contentRequest.current.key = contextKey
            post({ type: 'loadFileContent', requestId: id, ref: contextRef, path: target.file.path })
          },
        }
      : undefined

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
      selection={lineSelection}
      onDiscard={discardLines}
      selectionNote={
        tab === 'changes' && diffOptions.hideWhitespace
          ? 'Lines cannot be selected or discarded while whitespace changes are hidden.'
          : undefined
      }
      context={contextSource}
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
  const selectedCommits = commits.filter(c => selectedShas.includes(c.sha))
  const selectedRange = selectedShas.length > 1 ? commitRange(selectedShas) : null
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
      <Toolbar
        repos={repos}
        current={repo}
        onRefresh={refresh}
        branches={branchList}
        sync={syncStatus}
        syncing={syncing}
      />
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
              <>
                <FileList
                  root={repo.root}
                  files={changes}
                  source={{ kind: 'working' }}
                  selectedPath={changePath}
                  onSelect={f => setChangePath(f.path)}
                  onOpenDiff={() => openInEditor()}
                  header={`${changes.length} changed file${changes.length === 1 ? '' : 's'}`}
                  checks={fileChecks}
                />
                {lastCommit ? <UndoBar summary={lastCommit.summary} onUndo={() => post({ type: 'undoLastCommit' })} /> : null}
                <CommitBox
                  summary={summary}
                  description={description}
                  onSummaryChange={setSummary}
                  onDescriptionChange={setDescription}
                  branch={repo.branch}
                  fileCount={includedFiles.length}
                  busy={committing}
                  onCommit={commit}
                />
              </>
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
                multiSelectedKeys={selectedShas}
                onMultiSelect={selectCommits}
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
                  getContext={p => ({ webviewSection: 'pullRequest', url: p.url, root: repo.root, number: p.number })}
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
            selectedShas.length > 1 ? (
              selectedRange ? (
                withFiles(
                  <MultiCommitHeader commits={selectedCommits} files={commitFiles?.files ?? null} repo={repo} contiguous />,
                  commitFiles ? (
                    <FileList
                      root={repo.root}
                      files={commitFiles.files}
                      source={{ kind: 'commit', sha: selectedRange.newest, oldestSha: selectedRange.oldest }}
                      selectedPath={commitFilePath}
                      onSelect={f => setCommitFilePath(f.path)}
                      onOpenDiff={() => openInEditor()}
                    />
                  ) : (
                    <Loading />
                  )
                )
              ) : (
                <Placeholder icon="git-compare">
                  {selectedShas.length} commits selected. Select adjacent commits to see their combined changes.
                </Placeholder>
              )
            ) : selectedCommit ? (
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
                <PullRequestHeader pr={prDetail.pr} commitCount={prDetail.commits.length} currentBranch={repo.branch} />,
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
