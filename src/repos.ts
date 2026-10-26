import * as path from 'path'
import * as vscode from 'vscode'
import { getCurrentBranch, getGitHubRepo, git } from './git'
import { RepoInfo } from './protocol'

// Minimal slice of the built-in git extension API (extensions/git/src/api/git.d.ts).
interface GitRepositoryState {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined
  readonly onDidChange: vscode.Event<void>
}
interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: GitRepositoryState
}
interface GitAPI {
  readonly state: 'uninitialized' | 'initialized'
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>
  readonly repositories: GitRepository[]
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  readonly onDidCloseRepository: vscode.Event<GitRepository>
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
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
    const root = repo.rootUri.fsPath
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
    const root = repo.rootUri.fsPath
    this.repoListeners.get(root)?.dispose()
    this.repoListeners.delete(root)
    this.onDidChangeReposEmitter.fire()
  }

  private async scanWorkspaceFolders() {
    this.fallbackRoots.clear()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const top = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim()
        if (top) {
          this.fallbackRoots.add(path.resolve(top))
        }
      } catch {
        // not a repository
      }
    }
  }

  get roots(): string[] {
    const all = new Set<string>(this.fallbackRoots)
    for (const repo of this.api?.repositories ?? []) {
      all.add(repo.rootUri.fsPath)
    }
    return [...all].sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  }

  /** The repository containing the active editor, else the first one. */
  get activeRoot(): string | undefined {
    const roots = this.roots
    const active = vscode.window.activeTextEditor?.document.uri
    if (active?.scheme === 'file') {
      const match = roots
        .filter(r => active.fsPath === r || active.fsPath.startsWith(r + path.sep))
        .sort((a, b) => b.length - a.length)[0]
      if (match) {
        return match
      }
    }
    return roots[0]
  }

  headSha(root: string): string | undefined {
    return this.api?.repositories.find(r => r.rootUri.fsPath === root)?.state.HEAD?.commit
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
