// Types shared between the extension host and the webview.

export interface RepoInfo {
  root: string
  name: string
  branch: string | null
  /** owner/name when the repository has a github.com remote. */
  github: GitHubRepoRef | null
}

export interface GitHubRepoRef {
  owner: string
  name: string
  /** Name of the local remote pointing at this repository. */
  remote?: string
}

export interface CommitSummary {
  sha: string
  shortSha: string
  summary: string
  body: string
  authorName: string
  authorEmail: string
  /** Unix epoch in milliseconds. */
  date: number
  parents: string[]
  /** Branch and tag names pointing at this commit. */
  refs: string[]
  avatarUrl?: string
}

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange'

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
  additions?: number
  deletions?: number
  binary?: boolean
  /** Inline patch, only present when the source already provides it (GitHub API). */
  patch?: string
}

export interface PullRequestSummary {
  number: number
  title: string
  body: string
  author: string
  avatarUrl: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  /** Display label of the head, `owner:branch` for forks. */
  headRef: string
  /** Branch name in the head repository. */
  headBranch: string
  fromFork: boolean
  baseRef: string
  headSha: string
  createdAt: number
  updatedAt: number
  url: string
  additions?: number
  deletions?: number
  changedFiles?: number
}

/** Where a diff is coming from. */
export type DiffSource =
  /** A commit, or the range oldestSha^..sha when several commits are selected. */
  | { kind: 'commit'; sha: string; oldestSha?: string }
  | { kind: 'working' }
  | { kind: 'pr'; number: number }
  | { kind: 'prCommit'; number: number; sha: string }

export type BranchCompareMode = 'behind' | 'ahead'

export interface DiffRequest {
  source: DiffSource
  file: ChangedFile
  hideWhitespace: boolean
}

export interface DiffResult {
  /** Raw unified diff text (may be only hunks for GitHub patches). */
  text: string
  binary: boolean
  tooLarge?: boolean
  /** Explanation shown instead of a diff, e.g. when GitHub omits a patch. */
  message?: string
}

// ---------------------------------------------------------------------------
// Messages

/** A file to commit; with `patch`, only those lines (selected in the diff) are committed. */
export interface CommitEntry {
  file: ChangedFile
  patch?: string
}

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'switchRepo'; root: string }
  | { type: 'openRepoInNewTab'; root: string }
  | { type: 'loadHistory'; skip: number; compare?: { branch: string; mode: BranchCompareMode } }
  | { type: 'loadBranches' }
  | { type: 'loadCommitFiles'; sha: string; oldestSha?: string }
  | { type: 'loadChanges' }
  | { type: 'loadDiff'; requestId: number; request: DiffRequest }
  /** Full text of a file, used to expand diff context. `ref` null reads the working tree. */
  | { type: 'loadFileContent'; requestId: number; ref: string | null; path: string }
  | { type: 'commit'; summary: string; description: string; entries: CommitEntry[] }
  | { type: 'discard'; files: ChangedFile[] }
  | { type: 'undoLastCommit' }
  | { type: 'checkoutPullRequest'; number: number }
  | { type: 'loadPullRequests'; state: 'open' | 'closed'; page: number }
  | { type: 'loadPullRequest'; number: number }
  | { type: 'loadPullRequestCommitFiles'; number: number; sha: string }
  | { type: 'signInGitHub' }
  | { type: 'openDiffInEditor'; source: DiffSource; file: ChangedFile }
  | { type: 'openFile'; path: string }
  | { type: 'openExternal'; url: string }
  | { type: 'copy'; text: string }

export type HostToWebview =
  | { type: 'init'; repos: RepoInfo[]; current: RepoInfo; pageSize: number }
  | { type: 'repos'; repos: RepoInfo[]; current: RepoInfo }
  | { type: 'history'; skip: number; commits: CommitSummary[]; hasMore: boolean; compareKey: string }
  | { type: 'branches'; branches: string[]; current: string | null }
  | { type: 'commitFiles'; sha: string; oldestSha?: string; files: ChangedFile[] }
  | { type: 'changes'; files: ChangedFile[] }
  | { type: 'diff'; requestId: number; result: DiffResult }
  | { type: 'fileContent'; requestId: number; text: string | null }
  | { type: 'committed'; sha: string; summary: string; canUndo: boolean }
  | { type: 'undone'; summary: string; description: string }
  /** The commit form should be enabled again (the commit failed or finished). */
  | { type: 'commitDone' }
  | { type: 'pullRequests'; state: 'open' | 'closed'; page: number; items: PullRequestSummary[]; hasMore: boolean }
  | {
      type: 'pullRequest'
      number: number
      pr: PullRequestSummary
      commits: CommitSummary[]
      files: ChangedFile[]
    }
  | { type: 'pullRequestCommitFiles'; number: number; sha: string; files: ChangedFile[] }
  | { type: 'githubAuth'; signedIn: boolean }
  /** Local repository changed on disk (status/HEAD). */
  | { type: 'repoChanged'; headChanged: boolean; head: string | null }
  | { type: 'error'; scope: string; message: string; requestId?: number }
