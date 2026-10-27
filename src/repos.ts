import { promises as fs } from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { getCurrentBranch, getGitHubRepo, git, setGitPath } from './git'
import { RepoInfo } from './protocol'

// Minimal slice of the built-in git extension API (extensions/git/src/api/git.d.ts).
interface GitRepositoryState {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined
  readonly onDidChange: vscode.Event<void>
}
export interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: GitRepositoryState
  fetch(options?: { remote?: string; ref?: string }): Promise<void>
  pull(): Promise<void>
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>
}
interface GitAPI {
  readonly git: { readonly path: string }
  readonly state: 'uninitialized' | 'initialized'
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>
  readonly repositories: GitRepository[]
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  readonly onDidCloseRepository: vscode.Event<GitRepository>
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
}

/**
 * One spelling per repository root: VS Code's (on Windows `rev-parse` prints
 * `C:/x` while the git extension's URIs give `c:\x`).
 */
function normalizeRoot(p: string): string {
  return vscode.Uri.file(path.resolve(p)).fsPath
}

function sameFsPath(a: string, b: string): boolean {
  // Windows and macOS file systems are case-insensitive by default.
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

/**
 * Keeps track of the git repositories in the workspace, as discovered by
 * VS Code's built-in git extension, plus the workspace folders themselves
 * as a fallback when that extension is disabled.
 */
export class RepoRegistry implements vscode.Disposable {
  private api: GitAPI | undefined
  private readonly disposables: vscode.Disposable[] = []
  private readonly repoListeners = new Map<string, vscode.Disposable>()
  private readonly fallbackRoots = new Set<string>()
  private readonly githubCache = new Map<string, Promise<RepoInfo['github']>>()

  private readonly onDidChangeReposEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeRepos = this.onDidChangeReposEmitter.event

  /** Fires with the repository root whenever its status or HEAD changes. */
  private readonly onDidChangeRepoStateEmitter = new vscode.EventEmitter<string>()
  readonly onDidChangeRepoState = this.onDidChangeRepoStateEmitter.event

  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git')
    if (extension) {
      try {
        const exports = extension.isActive ? extension.exports : await extension.activate()
        this.api = exports.getAPI(1)
        setGitPath(this.api.git?.path)
      } catch {
        this.api = undefined
      }
    }

    if (this.api) {
      const api = this.api
      this.disposables.push(
        api.onDidOpenRepository(r => this.track(r)),
        api.onDidCloseRepository(r => this.untrack(r)),
        api.onDidChangeState(() => this.onDidChangeReposEmitter.fire())
      )
      api.repositories.forEach(r => this.track(r))
    }

    await this.scanWorkspaceFolders()
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.scanWorkspaceFolders()
        this.onDidChangeReposEmitter.fire()
      })
    )
  }

  private track(repo: GitRepository) {
    const root = normalizeRoot(repo.rootUri.fsPath)
    if (this.repoListeners.has(root)) {
      return
    }
    this.repoListeners.set(
      root,
      repo.state.onDidChange(() => this.onDidChangeRepoStateEmitter.fire(root))
    )
    this.onDidChangeReposEmitter.fire()
  }

  private untrack(repo: GitRepository) {
    const root = normalizeRoot(repo.rootUri.fsPath)
    this.repoListeners.get(root)?.dispose()
    this.repoListeners.delete(root)
    this.onDidChangeReposEmitter.fire()
  }

  private async scanWorkspaceFolders() {
    this.fallbackRoots.clear()
    // Like the git extension, a repository above the workspace folder (e.g. a
    // dotfiles repository in the home directory) only counts when allowed.
    // With "prompt", the git extension asks and, if accepted, reports it itself.
    const parentFolders = vscode.workspace
      .getConfiguration('git')
      .get<'always' | 'never' | 'prompt'>('openRepositoryInParentFolders', 'prompt')
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const top = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim()
        // git prints the resolved path, so compare against the folder's real path (symlinks).
        const folderPath = await fs.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath)
        const isParent = top !== '' && !sameFsPath(normalizeRoot(top), normalizeRoot(folderPath))
        if (top && (!isParent || parentFolders === 'always')) {
          this.fallbackRoots.add(normalizeRoot(top))
        }
      } catch {
        // not a repository
      }
    }
  }

  get roots(): string[] {
    const all = new Set<string>(this.fallbackRoots)
    for (const repo of this.api?.repositories ?? []) {
      all.add(normalizeRoot(repo.rootUri.fsPath))
    }
    return [...all].sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  }

  /** The repository containing the active editor, else the first one. */
  get activeRoot(): string | undefined {
    const roots = this.roots
    const active = vscode.window.activeTextEditor?.document.uri
    if (active?.scheme === 'file') {
      const match = roots
        .filter(r => sameFsPath(active.fsPath, r) || sameFsPath(active.fsPath.slice(0, r.length + 1), r + path.sep))
        .sort((a, b) => b.length - a.length)[0]
      if (match) {
        return match
      }
    }
    return roots[0]
  }

  /** The built-in git extension's repository, whose remote operations use VS Code's credentials. */
  repository(root: string): GitRepository | undefined {
    return this.api?.repositories.find(r => sameFsPath(normalizeRoot(r.rootUri.fsPath), normalizeRoot(root)))
  }

  headSha(root: string): string | undefined {
    return this.repository(root)?.state.HEAD?.commit
  }

  async describe(root: string): Promise<RepoInfo> {
    let github = this.githubCache.get(root)
    if (!github) {
      github = getGitHubRepo(root)
      this.githubCache.set(root, github)
    }
    return {
      root,
      name: path.basename(root),
      branch: await getCurrentBranch(root),
      github: await github,
    }
  }

  async describeAll(): Promise<RepoInfo[]> {
    return Promise.all(this.roots.map(r => this.describe(r)))
  }

  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri | undefined {
    return this.api?.toGitUri(uri, ref)
  }

  dispose() {
    this.disposables.forEach(d => d.dispose())
    this.repoListeners.forEach(d => d.dispose())
    this.onDidChangeReposEmitter.dispose()
    this.onDidChangeRepoStateEmitter.dispose()
  }
}
