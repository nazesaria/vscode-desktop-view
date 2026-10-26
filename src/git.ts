import { execFile } from 'child_process'
import {
  BranchCompareMode,
  ChangedFile,
  CommitSummary,
  DiffResult,
  FileStatus,
  GitHubRepoRef,
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

export function git(
  cwd: string,
  args: string[],
  okExitCodes: ReadonlyArray<number> = [0]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
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
  return { commits: commits.slice(0, limit), hasMore }
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

export async function getCommitFiles(root: string, sha: string): Promise<ChangedFile[]> {
  const base = await commitBase(root, sha)
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
  hideWhitespace: boolean
): Promise<DiffResult> {
  const base = await commitBase(root, sha)
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
      [0, 1]
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
      candidates.set(remote, ref)
    }
  }
  // Pull requests normally target upstream in fork setups.
  return candidates.get('upstream') ?? candidates.get('origin') ?? candidates.values().next().value ?? null
}
