import * as path from 'path'
import * as vscode from 'vscode'
import { GitHubClient } from './github'
import { getWorkingChanges } from './git'
import {
  checkoutPullRequestWithProgress,
  deleteBranchInteractive,
  DesktopViewPanel,
  discardChanges,
  gitErrorText,
  openDiffInEditor,
  openFileAtRevision,
  openWorkingFile,
  PanelDeps,
  RevisionScheme,
  revisionContentProvider,
  renameBranchInteractive,
  ViewType,
} from './panel'
import { ChangedFile, DiffSource } from './protocol'
import { RepoRegistry } from './repos'

/** Payload attached to list items through `data-vscode-context` in the webview. */
interface WebviewContextArgs {
  root?: string
  sha?: string
  url?: string
  path?: string
  diff?: string
  /** JSON array of the selected files (just the clicked one when a single row is selected). */
  files?: string
  number?: number
  branch?: string
}

export async function activate(context: vscode.ExtensionContext) {
  const repos = new RepoRegistry()
  const github = new GitHubClient(context)
  context.subscriptions.push(repos)
  const deps: PanelDeps = { extensionUri: context.extensionUri, repos, github }

  // Register the serializer before anything async so restored tabs are not lost.
  let ready: Promise<void> | undefined
  const whenReady = () => (ready ??= repos.initialize())
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(ViewType, {
      async deserializeWebviewPanel(panel, state) {
        await whenReady()
        DesktopViewPanel.revive(deps, panel, state as { root?: string } | undefined)
      },
    })
  )
  await whenReady()

  const pickRepository = async (): Promise<string | undefined> => {
    const roots = repos.roots
    if (roots.length === 0) {
      void vscode.window.showInformationMessage('Desktop View: no git repositories found in this workspace.')
      return undefined
    }
    if (roots.length === 1) {
      return roots[0]
    }
    const active = repos.activeRoot
    const items = roots.map(root => ({
      label: path.basename(root),
      description: root === active ? 'active editor' : undefined,
      detail: root,
      root,
    }))
    items.sort((a, b) => (a.root === active ? -1 : b.root === active ? 1 : 0))
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a repository to open' })
    return picked?.root
  }

  const command = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  command('desktopView.open', async () => {
    const root = await pickRepository()
    if (root) {
      DesktopViewPanel.open(deps, root)
    }
  })
  command('desktopView.openCurrent', async () => {
    const root = repos.activeRoot ?? (await pickRepository())
    if (root) {
      DesktopViewPanel.open(deps, root)
    }
  })
  command('desktopView.openScmRepository', (sourceControl?: { rootUri?: vscode.Uri }) => {
    const root = sourceControl?.rootUri?.fsPath ?? repos.activeRoot
    if (root) {
      DesktopViewPanel.open(deps, root)
    }
  })
  command('desktopView.signInGitHub', () => github.refreshSession(true))

  // Context menu entries contributed to `webview/context`.
  command('desktopView.ctx.copySha', (a: WebviewContextArgs) => a.sha && vscode.env.clipboard.writeText(a.sha))
  const contextFiles = (a: WebviewContextArgs): ChangedFile[] => (a.files ? JSON.parse(a.files) : [])
  command('desktopView.ctx.copyPath', (a: WebviewContextArgs) => {
    const paths = a.files ? contextFiles(a).map(f => f.path) : a.path ? [a.path] : []
    return paths.length > 0 && vscode.env.clipboard.writeText(paths.join('\n'))
  })
  command('desktopView.ctx.openCommitOnGitHub', (a: WebviewContextArgs) => a.url && vscode.env.openExternal(vscode.Uri.parse(a.url)))
  command('desktopView.ctx.openPullRequestOnGitHub', (a: WebviewContextArgs) => a.url && vscode.env.openExternal(vscode.Uri.parse(a.url)))
  command('desktopView.ctx.openFile', (a: WebviewContextArgs) => {
    if (a.root && a.path) {
      return openWorkingFile(a.root, a.path)
    }
  })
  command('desktopView.ctx.openFileAtRevision', async (a: WebviewContextArgs) => {
    if (a.root && a.diff) {
      const { source, file } = JSON.parse(a.diff) as { source: DiffSource; file: ChangedFile }
      try {
        await openFileAtRevision(deps, a.root, source, file)
      } catch (e) {
        void vscode.window.showErrorMessage(gitErrorText(e))
      }
    }
  })
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(RevisionScheme, revisionContentProvider))
  command('desktopView.ctx.revealInExplorer', (a: WebviewContextArgs) => {
    if (a.root && a.path) {
      return vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(a.root, a.path)))
    }
  })
  command('desktopView.ctx.openDiffInEditor', (a: WebviewContextArgs) => {
    if (a.root && a.diff) {
      const { source, file } = JSON.parse(a.diff) as { source: DiffSource; file: ChangedFile }
      return openDiffInEditor(deps, a.root, source, file)
    }
  })

  command('desktopView.ctx.discard', async (a: WebviewContextArgs) => {
    if (a.root && a.diff) {
      const { file } = JSON.parse(a.diff) as { file: ChangedFile }
      await discardChanges(a.root, [file])
    }
  })
  command('desktopView.ctx.discardSelected', async (a: WebviewContextArgs) => {
    if (a.root) {
      await discardChanges(a.root, contextFiles(a))
    }
  })
  const setIncluded = (include: boolean) => (a: WebviewContextArgs) => {
    if (a.root) {
      DesktopViewPanel.setIncluded(a.root, contextFiles(a).map(f => f.path), include)
    }
  }
  command('desktopView.ctx.includeSelected', setIncluded(true))
  command('desktopView.ctx.excludeSelected', setIncluded(false))
  command('desktopView.ctx.discardAll', async (a: WebviewContextArgs) => {
    if (a.root) {
      await discardChanges(a.root, await getWorkingChanges(a.root))
    }
  })
  command('desktopView.ctx.checkoutPullRequest', async (a: WebviewContextArgs) => {
    if (a.root && a.number !== undefined) {
      try {
        await checkoutPullRequestWithProgress(deps, a.root, a.number)
      } catch (e) {
        void vscode.window.showErrorMessage(gitErrorText(e))
      }
    }
  })
  const branchCommand = (id: string, fn: (root: string, branch: string) => Promise<boolean>) =>
    command(id, async (a: WebviewContextArgs) => {
      if (a.root && a.branch) {
        try {
          if (await fn(a.root, a.branch)) {
            await DesktopViewPanel.refreshBranches(a.root)
          }
        } catch (e) {
          void vscode.window.showErrorMessage(gitErrorText(e))
        }
      }
    })
  branchCommand('desktopView.ctx.renameBranch', renameBranchInteractive)
  branchCommand('desktopView.ctx.deleteBranch', deleteBranchInteractive)
  command('desktopView.ctx.copyBranchName', (a: WebviewContextArgs) => a.branch && vscode.env.clipboard.writeText(a.branch))

  // Status bar shortcut, like the "current repository" button in GitHub Desktop.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.text = '$(git-commit) Desktop View'
  status.tooltip = 'Open the repository in Desktop View (Ctrl+Alt+H)'
  status.command = 'desktopView.openCurrent'
  const updateStatus = () => (repos.roots.length > 0 ? status.show() : status.hide())
  updateStatus()
  context.subscriptions.push(status, repos.onDidChangeRepos(updateStatus))
}

export function deactivate() {}
