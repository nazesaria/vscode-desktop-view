import * as vscode from 'vscode'
import { ChangedFile, CommitSummary, FileStatus, GitHubRepoRef, PullRequestSummary } from './protocol'

const ApiBase = 'https://api.github.com'
const Scopes = ['repo']

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/**
 * Talks to the GitHub REST API using the GitHub account VS Code is already
 * signed in to (the built-in "github" authentication provider).
 */
export class GitHubClient {
  private readonly onDidChangeAuthEmitter = new vscode.EventEmitter<boolean>()
  readonly onDidChangeAuth = this.onDidChangeAuthEmitter.event
  private token: string | undefined
  private readonly prCache = new Map<string, { updatedAt: number; commits: CommitSummary[]; files: ChangedFile[] }>()

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      this.onDidChangeAuthEmitter,
      vscode.authentication.onDidChangeSessions(async e => {
        if (e.provider.id === 'github') {
          await this.refreshSession(false)
        }
      })
    )
  }

  get signedIn(): boolean {
    return this.token !== undefined
  }

  /** Looks up an existing session; with `interactive` it prompts the user to sign in. */
  async refreshSession(interactive: boolean): Promise<boolean> {
    const before = this.token
    try {
      const session = await vscode.authentication.getSession(
        'github',
        Scopes,
        interactive ? { createIfNone: true } : { silent: true }
      )
      this.token = session?.accessToken
    } catch {
      this.token = undefined
    }
    if (before !== this.token) {
      this.prCache.clear()
      this.onDidChangeAuthEmitter.fire(this.signedIn)
    }
    return this.signedIn
  }

  private async request<T>(path: string): Promise<{ data: T; hasNext: boolean }> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vscode-desktop-view',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    const response = await fetch(`${ApiBase}${path}`, { headers })
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`
      try {
        const body = (await response.json()) as { message?: string }
        if (body.message) {
          message = body.message
        }
      } catch {
        // keep the status text
      }
      if (response.status === 404 && !this.token) {
        message = 'Repository not found. If it is private, sign in to GitHub.'
      }
      throw new GitHubApiError(message, response.status)
    }
    const link = response.headers.get('link') ?? ''
    return { data: (await response.json()) as T, hasNext: /rel="next"/.test(link) }
  }

  private async requestAll<T>(path: string, maxPages: number): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?'
    const items: T[] = []
    for (let page = 1; page <= maxPages; page++) {
      const { data, hasNext } = await this.request<T[]>(`${path}${sep}per_page=100&page=${page}`)
      items.push(...data)
      if (!hasNext) {
        break
      }
    }
    return items
  }

  async listPullRequests(
    repo: GitHubRepoRef,
    state: 'open' | 'closed',
    page: number
  ): Promise<{ items: PullRequestSummary[]; hasMore: boolean }> {
    const { data, hasNext } = await this.request<ApiPullRequest[]>(
      `/repos/${repo.owner}/${repo.name}/pulls?state=${state}&sort=updated&direction=desc&per_page=50&page=${page}`
    )
    return { items: data.map(toPullRequest), hasMore: hasNext }
  }

  async getPullRequest(
    repo: GitHubRepoRef,
    number: number
  ): Promise<{ pr: PullRequestSummary; commits: CommitSummary[]; files: ChangedFile[] }> {
    const base = `/repos/${repo.owner}/${repo.name}/pulls/${number}`
    const { data } = await this.request<ApiPullRequest>(base)
    const pr = toPullRequest(data)
    const key = `${repo.owner}/${repo.name}#${number}`
    const cached = this.prCache.get(key)
    if (cached && cached.updatedAt === pr.updatedAt) {
      return { pr, commits: cached.commits, files: cached.files }
    }
    // GitHub caps these endpoints at 250 commits and 3000 files.
    const [apiCommits, apiFiles] = await Promise.all([
      this.requestAll<ApiCommit>(`${base}/commits`, 3),
      this.requestAll<ApiFile>(`${base}/files`, 30),
    ])
    const commits = apiCommits.map(toCommit).reverse()
    const files = apiFiles.map(toChangedFile)
    this.prCache.set(key, { updatedAt: pr.updatedAt, commits, files })
    return { pr, commits, files }
  }

  /** Raw file contents at a commit, or null when GitHub has none (deleted, binary, too big). */
  async getFileContent(repo: GitHubRepoRef, ref: string, path: string): Promise<string | null> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vscode-desktop-view',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await fetch(
      `${ApiBase}/repos/${repo.owner}/${repo.name}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      { headers }
    )
    if (!response.ok) {
      return null
    }
    const text = await response.text()
    return text.includes('\0') ? null : text
  }

  async getCommitFiles(repo: GitHubRepoRef, sha: string): Promise<ChangedFile[]> {
    const { data } = await this.request<{ files?: ApiFile[] }>(
      `/repos/${repo.owner}/${repo.name}/commits/${sha}`
    )
    return (data.files ?? []).map(toChangedFile)
  }
}

// ---------------------------------------------------------------------------
// API shapes (only the fields we read)

interface ApiUser {
  login: string
  avatar_url: string
}

interface ApiPullRequest {
  number: number
  title: string
  body: string | null
  user: ApiUser | null
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  head: { ref: string; sha: string; label: string; repo: { full_name: string } | null }
  base: { ref: string; sha: string; repo: { full_name: string } }
  created_at: string
  updated_at: string
  html_url: string
  additions?: number
  deletions?: number
  changed_files?: number
}

interface ApiCommit {
  sha: string
  commit: {
    message: string
    author: { name: string; email: string; date: string } | null
  }
  author: ApiUser | null
  parents: { sha: string }[]
}

interface ApiFile {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

function toPullRequest(pr: ApiPullRequest): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? 'ghost',
    avatarUrl: pr.user?.avatar_url ?? '',
    state: pr.merged_at ? 'merged' : pr.state,
    draft: pr.draft === true,
    headRef: pr.head.label || pr.head.ref,
    headBranch: pr.head.ref,
    // A deleted fork has no repo; its branch can only be reached through refs/pull.
    fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
    baseRef: pr.base.ref,
    headSha: pr.head.sha,
    createdAt: Date.parse(pr.created_at),
    updatedAt: Date.parse(pr.updated_at),
    url: pr.html_url,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  }
}

function toCommit(c: ApiCommit): CommitSummary {
  const [summary, ...rest] = c.commit.message.split('\n')
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    summary,
    body: rest.join('\n').trim(),
    authorName: c.commit.author?.name ?? c.author?.login ?? 'unknown',
    authorEmail: c.commit.author?.email ?? '',
    date: c.commit.author ? Date.parse(c.commit.author.date) : 0,
    parents: c.parents.map(p => p.sha),
    refs: [],
    avatarUrl: c.author?.avatar_url,
  }
}

function toChangedFile(f: ApiFile): ChangedFile {
  const statusMap: Record<string, FileStatus> = {
    added: 'added',
    removed: 'deleted',
    modified: 'modified',
    renamed: 'renamed',
    copied: 'copied',
    changed: 'modified',
    unchanged: 'modified',
  }
  return {
    path: f.filename,
    oldPath: f.previous_filename,
    status: statusMap[f.status] ?? 'modified',
    additions: f.additions,
    deletions: f.deletions,
    // GitHub omits the patch for binary files and for very large diffs.
    patch: f.patch,
  }
}
