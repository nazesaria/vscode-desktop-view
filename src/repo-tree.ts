import * as path from 'path'
import * as vscode from 'vscode'
import { getCurrentBranch } from './git'
import { repositoryQualifiers } from './repo-names'
import { RepoRegistry } from './repos'

export const RepositoriesViewId = 'desktopView.repositories'

/** Repository list behind the activity bar icon; clicking one opens its tab. */
export class RepositoryTree implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event
  private readonly disposables: vscode.Disposable[]
  private branches = new Map<string, string | null>()
  private refreshTimer: NodeJS.Timeout | undefined

  constructor(private readonly repos: RepoRegistry) {
    this.disposables = [
      repos.onDidChangeRepos(() => this.refresh()),
      // Fires on every status change, in bursts; only the branch is shown.
      repos.onDidChangeRepoState(() => this.refresh()),
    ]
  }

  refresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => this.onDidChangeTreeDataEmitter.fire(), 300)
  }

  async getChildren(element?: string): Promise<string[]> {
    if (element) {
      return []
    }
    const roots = this.repos.roots
    this.branches = new Map(await Promise.all(roots.map(async root => [root, await getCurrentBranch(root)] as const)))
    return roots
  }

  getTreeItem(root: string): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(root))
    item.id = root
    item.iconPath = new vscode.ThemeIcon('repo')
    item.description =
      [this.branches.get(root), repositoryQualifiers(this.repos.roots).get(root)].filter(Boolean).join(' · ') || undefined
    item.tooltip = root
    item.command = {
      command: 'desktopView.openScmRepository',
      title: 'Open in Desktop View',
      arguments: [{ rootUri: vscode.Uri.file(root) }],
    }
    return item
  }

  dispose() {
    clearTimeout(this.refreshTimer)
    this.disposables.forEach(d => d.dispose())
    this.onDidChangeTreeDataEmitter.dispose()
  }
}
