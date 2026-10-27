import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import {
  BranchCompareMode,
  BranchInfo,
  ChangedFile,
  CommitSummary,
  DiffResult,
  FileStatus,
  GitHubRepoRef,
  SyncStatus,
} from './protocol'

/** The hash of git's empty tree, used as the base for root commits. */
export const EmptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Diffs bigger than this are not sent to the webview. */
const MaxDiffBytes = 5 * 1024 * 1024

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message)
  }
}

export interface GitOptions {
  okExitCodes?: ReadonlyArray<number>
  env?: Record<string, string>
  /** Written to stdin. */
  input?: string
}

export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const okExitCodes = options.okExitCodes ?? [0]
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // Paths are passed verbatim; never let git expand them as globs.
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--literal-pathspecs', ...args],
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        if (code !== null && okExitCodes.includes(code)) {
          resolve(stdout)
        } else {
          const msg = (stderr || error?.message || 'git failed').trim()
          reject(new GitError(`git ${args[0]}: ${msg}`, code, stderr))
        }
      }
    )
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

export async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const name = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    return name || null
  } catch {
    return null
  }
}

export async function getHeadSha(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// History

const LogFormat = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join('%x1f') + '%x1e'

export function parseLog(output: string): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const record of output.split('\x1e')) {
    const trimmed = record.replace(/^\n/, '')
    if (trimmed.length === 0) {
      continue
    }
    const [sha, shortSha, parents, authorName, authorEmail, at, refs, summary, body] =
      trimmed.split('\x1f')
    commits.push({
      sha,
      shortSha,
      parents: parents ? parents.split(' ') : [],
      authorName,
      authorEmail,
      date: Number(at) * 1000,
      refs: parseRefs(refs ?? ''),
      summary: summary ?? '',
      body: (body ?? '').trim(),
    })
  }
  return commits
}

function parseRefs(decoration: string): string[] {
  return decoration
    .split(', ')
    .map(r => r.replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .filter(r => r.length > 0 && r !== 'HEAD' && r !== 'grafted' && !r.endsWith('/HEAD'))
}

export async function getHistory(
  root: string,
  skip: number,
  limit: number,
  compare?: { branch: string; mode: BranchCompareMode }
): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
  if (!(await hasHead(root))) {
    return { commits: [], hasMore: false }
  }
  const range = compare
    ? compare.mode === 'behind'
      ? `HEAD..${compare.branch}`
      : `${compare.branch}..HEAD`
    : 'HEAD'
  // Ask for one extra commit to know whether there is another page.
  const output = await git(root, [
    'log',
    `--format=${LogFormat}`,
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    '--decorate=short',
    range,
    '--',
  ])
  const commits = parseLog(output)
  const hasMore = commits.length > limit
  const unpushed = await getUnpushedShas(root)
  for (const commit of commits) {
    if (unpushed.has(commit.sha)) {
      commit.unpushed = true
    }
  }
  return { commits: commits.slice(0, limit), hasMore }
}

/**
 * Commits on HEAD that the remote does not have yet: those ahead of the
 * upstream, or for an unpublished branch those on no remote branch at all.
 */
export async function getUnpushedShas(root: string): Promise<Set<string>> {
  if (!(await git(root, ['remote'])).trim()) {
    return new Set()
  }
  let range: string[]
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}'])
    range = ['@{upstream}..HEAD']
  } catch {
    range = ['HEAD', '--not', '--remotes']
  }
  try {
    const output = await git(root, ['rev-list', '--max-count=5000', ...range])
    return new Set(output.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

export async function getBranches(root: string): Promise<string[]> {
  const output = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ])
  return output
    .split('\n')
    .filter(ref => ref.length > 0 && !ref.endsWith('/HEAD'))
    .map(ref => ref.replace(/^refs\/(heads|remotes)\//, ''))
}

// ---------------------------------------------------------------------------
// Changed files

function mapStatusLetter(letter: string): FileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const parts = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]
    if (!status) {
      continue
    }
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      files.push({ status: mapStatusLetter(status), oldPath, path })
    } else {
      files.push({ status: mapStatusLetter(status), path: parts[i++] })
    }
  }
  return files
}

/** Parses `git diff --numstat -z` output into a map keyed by the new path. */
export function parseNumstat(
  output: string
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const parts = output.split('\0')
  for (let i = 0; i < parts.length; ) {
    const entry = parts[i++]
    if (!entry) {
      continue
    }
    const [added, deleted, path] = entry.split('\t')
    let newPath = path
    if (path === '') {
      // Rename: the old and new paths follow as separate NUL-terminated fields.
      i++
      newPath = parts[i++]
    }
    const binary = added === '-'
    result.set(newPath, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return result
}

async function commitBase(root: string, sha: string): Promise<string> {
  const line = (await git(root, ['rev-list', '--parents', '-n', '1', sha])).trim()
  const parents = line.split(' ').slice(1)
  return parents.length > 0 ? parents[0] : EmptyTreeSha
}

/**
 * Files changed by a commit, or by a range of commits when `oldestSha` is
 * given (from the oldest commit's parent up to `sha`).
 */
export async function getCommitFiles(root: string, sha: string, oldestSha?: string): Promise<ChangedFile[]> {
  const base = await commitBase(root, oldestSha ?? sha)
  const [nameStatus, numstat] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '-M', base, sha]),
    git(root, ['diff', '--numstat', '-z', '-M', base, sha]),
  ])
  const stats = parseNumstat(numstat)
  return parseNameStatus(nameStatus).map(f => ({ ...f, ...stats.get(f.path) }))
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parseStatus(output: string): ChangedFile[] {
  const parts = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; ) {
    const entry = parts[i++]
    if (!entry) {
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    if (x === '?' && y === '?') {
      files.push({ status: 'untracked', path })
      continue
    }
    if (x === '!' && y === '!') {
      continue
    }
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    if (x === 'R' || x === 'C') {
      const oldPath = parts[i++]
      files.push({ status: conflicted ? 'conflicted' : mapStatusLetter(x), path, oldPath })
      continue
    }
    const letter = x !== ' ' ? x : y
    files.push({ status: conflicted ? 'conflicted' : mapStatusLetter(letter), path })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function getWorkingChanges(root: string): Promise<ChangedFile[]> {
  const output = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parseStatus(output)
}

// ---------------------------------------------------------------------------
// Diffs

function diffArgs(context: number, hideWhitespace: boolean): string[] {
  const args = ['diff', '--no-ext-diff', '--no-color', '-M', `-U${context}`]
  if (hideWhitespace) {
    args.push('-w')
  }
  return args
}

function pathspec(file: ChangedFile): string[] {
  return file.oldPath && file.oldPath !== file.path ? ['--', file.oldPath, file.path] : ['--', file.path]
}

function toResult(text: string): DiffResult {
  if (text.length > MaxDiffBytes) {
    return { text: '', binary: false, tooLarge: true }
  }
  const binary = /^Binary files .* differ$/m.test(text) || text.includes('\nGIT binary patch')
  return { text, binary }
}

export async function getCommitDiff(
  root: string,
  sha: string,
  file: ChangedFile,
  context: number,
  hideWhitespace: boolean,
  oldestSha?: string
): Promise<DiffResult> {
  const base = await commitBase(root, oldestSha ?? sha)
  const text = await git(root, [...diffArgs(context, hideWhitespace), base, sha, ...pathspec(file)])
  return toResult(text)
}

export async function getWorkingDiff(
  root: string,
  file: ChangedFile,
  context: number,
  hideWhitespace: boolean
): Promise<DiffResult> {
  if (file.status === 'untracked') {
    const text = await git(
      root,
      [...diffArgs(context, hideWhitespace), '--no-index', '--', '/dev/null', file.path],
      { okExitCodes: [0, 1] }
    )
    return toResult(text)
  }
  // Like GitHub Desktop, show staged and unstaged changes together: HEAD vs working tree.
  const base = (await hasHead(root)) ? 'HEAD' : EmptyTreeSha
  const text = await git(root, [...diffArgs(context, hideWhitespace), base, ...pathspec(file)])
  return toResult(text)
}

export async function commitExists(root: string, sha: string): Promise<boolean> {
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(root, ['merge-base', a, b])).trim() || null
  } catch {
    return null
  }
}

export { commitBase }

// ---------------------------------------------------------------------------
// Remotes

export function parseGitHubRemote(url: string): GitHubRepoRef | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return m ? { owner: m[1], name: m[2] } : null
}

export async function getGitHubRepo(root: string): Promise<GitHubRepoRef | null> {
  let output: string
  try {
    output = await git(root, ['remote', '-v'])
  } catch {
    return null
  }
  const candidates = new Map<string, GitHubRepoRef>()
  for (const line of output.split('\n')) {
    const [remote, url] = line.split(/\s+/)
    const ref = url ? parseGitHubRemote(url) : null
    if (ref && !candidates.has(remote)) {
      candidates.set(remote, { ...ref, remote })
    }
  }
  // Pull requests normally target upstream in fork setups.
  return candidates.get('upstream') ?? candidates.get('origin') ?? candidates.values().next().value ?? null
}

// ---------------------------------------------------------------------------
// Committing

export interface CommitEntry {
  file: ChangedFile
  /** When present, only this patch (against HEAD) is committed for the file. */
  patch?: string
}

async function absoluteGitDir(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
}

/**
 * Commits exactly the given files (or parts of files), the way GitHub Desktop
 * does: whatever else is staged stays staged and is not committed.
 *
 * The commit is built in a temporary index seeded from HEAD, so the user's
 * index is never left half-modified if something fails. Hooks run as usual.
 */
export async function commitChanges(root: string, message: string, entries: ReadonlyArray<CommitEntry>): Promise<string> {
  if (entries.length === 0) {
    throw new Error('Select at least one file to commit.')
  }
  const gitDir = await absoluteGitDir(root)
  const indexFile = path.join(gitDir, `desktop-view-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: indexFile }
  const committedPaths = new Set<string>()
  try {
    if (await hasHead(root)) {
      await git(root, ['read-tree', 'HEAD'], { env })
    } else {
      await git(root, ['read-tree', '--empty'], { env })
    }

    const whole = entries.filter(e => e.patch === undefined)
    const wholePaths = whole.flatMap(e => (e.file.oldPath ? [e.file.oldPath, e.file.path] : [e.file.path]))
    if (wholePaths.length > 0) {
      await git(root, ['add', '-A', '--', ...wholePaths], { env })
    }
    for (const entry of entries) {
      if (entry.patch !== undefined) {
        await git(root, ['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: entry.patch })
      }
    }
    wholePaths.forEach(p => committedPaths.add(p))
    entries.forEach(e => committedPaths.add(e.file.path))

    await git(root, ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { env, input: message })
  } finally {
    await fs.rm(indexFile, { force: true })
    await fs.rm(`${indexFile}.lock`, { force: true })
  }

  // Bring the real index in line with the new HEAD for what was committed.
  await git(root, ['reset', '-q', '--', ...committedPaths], { okExitCodes: [0, 1] })
  return (await git(root, ['rev-parse', 'HEAD'])).trim()
}

/** Whether HEAD can be undone: it has a single parent and no remote branch contains it. */
export async function canUndoLastCommit(root: string): Promise<boolean> {
  try {
    const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1)
    if (parents.length !== 1) {
      return false
    }
    const remotes = await git(root, ['branch', '-r', '--contains', 'HEAD'])
    return remotes.trim().length === 0
  } catch {
    return false
  }
}

/** Like GitHub Desktop's "Undo": soft-resets HEAD and returns the commit message. */
export async function undoLastCommit(root: string): Promise<{ summary: string; description: string }> {
  if (!(await canUndoLastCommit(root))) {
    throw new Error('The last commit cannot be undone: it was already pushed, is a merge or is the first commit.')
  }
  const message = await git(root, ['log', '-1', '--format=%B', 'HEAD'])
  await git(root, ['reset', '--soft', 'HEAD^'])
  const [summary, ...rest] = message.replace(/\s+$/, '').split('\n')
  return { summary, description: rest.join('\n').trim() }
}

// ---------------------------------------------------------------------------
// Discarding

/**
 * Restores tracked files to their HEAD version (index and working tree) and
 * forgets newly added ones. Callers move the current contents to the trash first.
 */
export async function restoreToHead(root: string, files: ReadonlyArray<ChangedFile>): Promise<void> {
  const restore: string[] = []
  const unstage: string[] = []
  for (const file of files) {
    switch (file.status) {
      case 'untracked':
        break
      case 'added':
      case 'copied':
        unstage.push(file.path)
        break
      case 'renamed':
        unstage.push(file.path)
        if (file.oldPath) {
          restore.push(file.oldPath)
        }
        break
      default:
        restore.push(file.path)
    }
  }
  if (unstage.length > 0) {
    await git(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...unstage])
  }
  if (restore.length > 0) {
    await git(root, ['checkout', '-q', 'HEAD', '--', ...restore])
  }
}

/** Reverts, in the working tree only, the changes in a patch made against HEAD. */
export async function discardPatch(root: string, patch: string): Promise<void> {
  await git(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch })
}

// ---------------------------------------------------------------------------
// File contents

const MaxContentBytes = 5 * 1024 * 1024

/** A file's text at `ref`, or in the working tree when `ref` is null. Null for binary or huge files. */
export async function getFileContent(root: string, ref: string | null, filePath: string): Promise<string | null> {
  let text: string
  if (ref === null) {
    const full = path.join(root, filePath)
    const stat = await fs.stat(full)
    if (stat.size > MaxContentBytes) {
      return null
    }
    text = await fs.readFile(full, 'utf8')
  } else {
    text = await git(root, ['show', `${ref}:${filePath}`])
  }
  if (text.length > MaxContentBytes || text.includes('\0')) {
    return null
  }
  return text
}

// ---------------------------------------------------------------------------
// Pull request checkout

export interface PullRequestCheckout {
  number: number
  /** Branch name in the head repository. */
  headBranch: string
  /** True when the PR comes from another repository (a fork). */
  fromFork: boolean
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Fetches `refspec` from `remote`; the extension routes this through VS Code's git so credentials work. */
export type Fetcher = (remote: string, refspec: string) => Promise<void>

const fetchWithGit = (root: string): Fetcher => async (remote, refspec) => {
  await git(root, ['fetch', '--quiet', remote, refspec])
}

/**
 * Fetches a pull request and checks it out. Same-repository PRs get a local
 * branch tracking the remote one; fork PRs land on `pr/<number>`, updated
 * fast-forward only so local commits there are never thrown away.
 */
export async function checkoutPullRequest(
  root: string,
  remote: string,
  pr: PullRequestCheckout,
  fetch: Fetcher = fetchWithGit(root)
): Promise<string> {
  if (!pr.fromFork) {
    await fetch(remote, `+refs/heads/${pr.headBranch}:refs/remotes/${remote}/${pr.headBranch}`)
    if (await branchExists(root, pr.headBranch)) {
      await git(root, ['checkout', '-q', pr.headBranch])
    } else {
      await git(root, ['checkout', '-q', '-b', pr.headBranch, '--track', `${remote}/${pr.headBranch}`])
    }
    return pr.headBranch
  }

  const local = `pr/${pr.number}`
  // Into a private ref rather than FETCH_HEAD, which VS Code's fetch may overwrite with other refs.
  const ref = `refs/desktop-view/pr/${pr.number}`
  await fetch(remote, `+refs/pull/${pr.number}/head:${ref}`)
  try {
    if (await branchExists(root, local)) {
      await git(root, ['checkout', '-q', local])
      await git(root, ['merge', '--ff-only', '-q', ref])
    } else {
      await git(root, ['checkout', '-q', '-b', local, ref])
    }
  } finally {
    await git(root, ['update-ref', '-d', ref])
  }
  return local
}

// ---------------------------------------------------------------------------
// Branches

export async function listBranches(root: string): Promise<BranchInfo[]> {
  const output = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%1f%(upstream:short)%1f%(committerdate:unix)',
    'refs/heads',
    'refs/remotes',
  ])
  return output
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [ref, upstream, date] = line.split('\x1f')
      const remote = ref.startsWith('refs/remotes/')
      return {
        name: ref.replace(/^refs\/(heads|remotes)\//, ''),
        remote,
        upstream: upstream || undefined,
        date: Number(date) * 1000,
      }
    })
    .filter(b => !(b.remote && b.name.endsWith('/HEAD')))
}

/** Null when `name` is a valid new branch name, else why it is not. */
export async function validateBranchName(root: string, name: string): Promise<string | null> {
  if (!name.trim()) {
    return 'Enter a branch name.'
  }
  try {
    await git(root, ['check-ref-format', '--branch', name])
  } catch {
    return `"${name}" is not a valid branch name.`
  }
  if (await branchExists(root, name)) {
    return `A branch named "${name}" already exists.`
  }
  return null
}

/**
 * Switches to a branch. Uncommitted changes come along, as with `git checkout`;
 * git refuses (and nothing changes) when they would be overwritten.
 * A remote branch is checked out as a local branch tracking it.
 */
export async function checkoutBranch(root: string, branch: BranchInfo): Promise<string> {
  if (!branch.remote) {
    await git(root, ['checkout', '-q', branch.name])
    return branch.name
  }
  const local = branch.name.slice(branch.name.indexOf('/') + 1)
  if (await branchExists(root, local)) {
    await git(root, ['checkout', '-q', local])
  } else {
    await git(root, ['checkout', '-q', '-b', local, '--track', branch.name])
  }
  return local
}

/** Creates a branch at HEAD and switches to it, keeping uncommitted changes. */
export async function createBranch(root: string, name: string): Promise<void> {
  if (await hasHead(root)) {
    await git(root, ['checkout', '-q', '-b', name])
  } else {
    await git(root, ['symbolic-ref', 'HEAD', `refs/heads/${name}`])
  }
}

export async function renameBranch(root: string, from: string, to: string): Promise<void> {
  await git(root, ['branch', '-m', from, to])
}

/** Deletes a local branch; without `force`, git refuses when it has unmerged commits. */
export async function deleteBranch(root: string, name: string, force: boolean): Promise<void> {
  await git(root, ['branch', force ? '-D' : '-d', name])
}

// ---------------------------------------------------------------------------
// Sync status

export async function getSyncStatus(root: string): Promise<SyncStatus> {
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean)
  const branch = await getCurrentBranch(root)
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  if (branch) {
    try {
      upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim() || null
    } catch {
      upstream = null
    }
    if (upstream) {
      try {
        const counts = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim()
        ;[ahead, behind] = counts.split(/\s+/).map(Number)
      } catch {
        // The upstream ref is gone (deleted on the remote and pruned).
        upstream = null
      }
    }
  }
  const upstreamRemote = upstream ? remotes.find(r => upstream!.startsWith(`${r}/`)) : undefined
  let lastFetched: number | null = null
  try {
    lastFetched = (await fs.stat(path.join(await absoluteGitDir(root), 'FETCH_HEAD'))).mtimeMs
  } catch {
    lastFetched = null
  }
  return {
    remote: upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null),
    branch,
    upstream,
    ahead,
    behind,
    lastFetched,
  }
}
