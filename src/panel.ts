import * as path from 'path'
import * as vscode from 'vscode'
import {
  canUndoLastCommit,
  checkoutBranch,
  checkoutPullRequest,
  commitBase,
  commitChanges,
  commitExists,
  createBranch,
  deleteBranch,
  discardPatch,
  EmptyTreeSha,
  Fetcher,
  getBranches,
  getCommitDiff,
  getCommitFiles,
  getCurrentBranch,
  getFileContent,
  getHeadSha,
  getHistory,
  getSyncStatus,
  getWorkingChanges,
  getWorkingDiff,
  git,
  listBranches,
  mergeBase,
  renameBranch,
  restoreToHead,
  undoLastCommit,
  validateBranchName,
} from './git'
import { GitHubClient } from './github'
import { ChangedFile, DiffSource, HostToWebview, RepoInfo, SyncAction, SyncStatus, WebviewToHost } from './protocol'
import { RepoRegistry } from './repos'

export const ViewType = 'desktopView'

export interface PanelDeps {
  extensionUri: vscode.Uri
  repos: RepoRegistry
  github: GitHubClient
}

interface PersistedState {
  root?: string
}

/** One editor tab showing one repository. */
export class DesktopViewPanel implements vscode.Disposable {
  private static readonly panels = new Set<DesktopViewPanel>()

  static open(deps: PanelDeps, root: string) {
    const existing = [...DesktopViewPanel.panels].find(p => p.root === root)
    if (existing) {
      existing.panel.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(ViewType, path.basename(root), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist')],
    })
    new DesktopViewPanel(panel, deps, root)
  }

  static revive(deps: PanelDeps, panel: vscode.WebviewPanel, state: PersistedState | undefined) {
    const root = state?.root && deps.repos.roots.includes(state.root) ? state.root : deps.repos.activeRoot
    if (!root) {
      panel.webview.html = '<body>No git repository in this workspace.</body>'
      return
    }
    new DesktopViewPanel(panel, deps, root)
  }

  /** Sends a fresh branch list to the panels showing `root`, after a rename or delete. */
  static async refreshBranches(root: string) {
    for (const panel of DesktopViewPanel.panels) {
      if (panel.root === root) {
        panel.post({ type: 'branchList', branches: await listBranches(root) })
      }
    }
  }

  static setIncluded(root: string, paths: string[], include: boolean) {
    for (const panel of DesktopViewPanel.panels) {
      if (panel.root === root) {
        panel.post({ type: 'setIncluded', paths, include })
      }
    }
  }

  private readonly disposables: vscode.Disposable[] = []
  private lastHead: string | null | undefined
  private lastBranch: string | null | undefined
  private refreshTimer: NodeJS.Timeout | undefined

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PanelDeps,
    private root: string
  ) {
    DesktopViewPanel.panels.add(this)
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'dist', 'icon.svg')
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist')],
    }
    panel.webview.html = this.renderHtml()
    this.updateTitle()

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m)),
      deps.repos.onDidChangeRepos(() => this.sendRepos()),
      deps.repos.onDidChangeRepoState(root => {
        if (root === this.root) {
          this.scheduleRefresh()
        }
      }),
      deps.github.onDidChangeAuth(signedIn => this.post({ type: 'githubAuth', signedIn })),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('desktopView.colors')) {
          this.post({ type: 'palette', palette: this.config().palette })
        }
      })
    )
  }

  get repositoryRoot() {
    return this.root
  }

  private updateTitle() {
    this.panel.title = path.basename(this.root)
  }

  private post(message: HostToWebview) {
    void this.panel.webview.postMessage(message)
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(async () => {
      const [head, branch] = await Promise.all([getHeadSha(this.root), getCurrentBranch(this.root)])
      const headChanged = head !== this.lastHead
      // Switching to a branch at the same commit changes the branch but not HEAD's sha.
      const branchChanged = branch !== this.lastBranch
      this.lastHead = head
      this.lastBranch = branch
      this.post({ type: 'repoChanged', headChanged, head })
      if (headChanged || branchChanged) {
        await this.sendRepos()
      }
      await this.sendSyncStatus()
    }, 400)
  }

  private async sendSyncStatus() {
    this.post({ type: 'syncStatus', status: await getSyncStatus(this.root) })
  }

  private async rememberHead() {
    ;[this.lastHead, this.lastBranch] = await Promise.all([getHeadSha(this.root), getCurrentBranch(this.root)])
  }

  private async sendRepos() {
    const repos = await this.deps.repos.describeAll()
    const current = repos.find(r => r.root === this.root) ?? (await this.deps.repos.describe(this.root))
    this.post({ type: 'repos', repos, current })
  }

  private async currentRepo(): Promise<RepoInfo> {
    return this.deps.repos.describe(this.root)
  }

  private config() {
    const c = vscode.workspace.getConfiguration('desktopView')
    return {
      pageSize: Math.max(10, c.get<number>('historyPageSize', 100)),
      context: Math.max(0, c.get<number>('diffContextLines', 3)),
      palette: c.get<'desktop' | 'theme'>('colors', 'desktop'),
    }
  }

  private async handle(message: WebviewToHost) {
    try {
      await this.dispatch(message)
    } catch (e) {
      const requestId = message.type === 'loadDiff' ? message.requestId : undefined
      this.post({
        type: 'error',
        scope: message.type,
        message: gitErrorText(e),
        requestId,
      })
    }
  }

  private async dispatch(message: WebviewToHost) {
    const root = this.root
    switch (message.type) {
      case 'ready': {
        await this.rememberHead()
        const repos = await this.deps.repos.describeAll()
        const current = repos.find(r => r.root === root) ?? (await this.currentRepo())
        this.post({ type: 'init', repos, current, pageSize: this.config().pageSize })
        await this.sendSyncStatus()
        if (current.github) {
          await this.deps.github.refreshSession(false)
        }
        this.post({ type: 'githubAuth', signedIn: this.deps.github.signedIn })
        return
      }
      case 'switchRepo': {
        const other = [...DesktopViewPanel.panels].find(p => p !== this && p.root === message.root)
        if (other) {
          other.panel.reveal()
          return
        }
        this.root = message.root
        await this.rememberHead()
        this.updateTitle()
        const repos = await this.deps.repos.describeAll()
        const current = repos.find(r => r.root === this.root) ?? (await this.currentRepo())
        this.post({ type: 'init', repos, current, pageSize: this.config().pageSize })
        await this.sendSyncStatus()
        return
      }
      case 'openRepoInNewTab':
        DesktopViewPanel.open(this.deps, message.root)
        return
      case 'loadHistory': {
        const { pageSize } = this.config()
        const { commits, hasMore } = await getHistory(root, message.skip, pageSize, message.compare)
        const compareKey = message.compare ? `${message.compare.mode}:${message.compare.branch}` : ''
        this.post({ type: 'history', skip: message.skip, commits, hasMore, compareKey })
        return
      }
      case 'loadBranches': {
        const [branches, current] = await Promise.all([getBranches(root), this.currentRepo()])
        this.post({ type: 'branches', branches, current: current.branch })
        return
      }
      case 'loadCommitFiles': {
        const files = await getCommitFiles(root, message.sha, message.oldestSha)
        this.post({ type: 'commitFiles', sha: message.sha, oldestSha: message.oldestSha, files })
        return
      }
      case 'loadChanges': {
        const files = await getWorkingChanges(root)
        this.post({ type: 'changes', files })
        return
      }
      case 'loadDiff': {
        const { source, file, hideWhitespace } = message.request
        const { context } = this.config()
        let result
        if (source.kind === 'commit') {
          result = await getCommitDiff(root, source.sha, file, context, hideWhitespace, source.oldestSha)
        } else if (source.kind === 'working') {
          result = await getWorkingDiff(root, file, context, hideWhitespace)
        } else {
          // The webview renders pull request diffs straight from the GitHub patch.
          throw new Error('Pull request diffs are not loaded through git')
        }
        this.post({ type: 'diff', requestId: message.requestId, result })
        return
      }
      case 'loadPullRequests': {
        const repo = await this.currentRepo()
        if (!repo.github) {
          this.post({ type: 'pullRequests', state: message.state, page: message.page, items: [], hasMore: false })
          return
        }
        const { items, hasMore } = await this.deps.github.listPullRequests(repo.github, message.state, message.page)
        this.post({ type: 'pullRequests', state: message.state, page: message.page, items, hasMore })
        return
      }
      case 'loadPullRequest': {
        const repo = await this.currentRepo()
        if (!repo.github) {
          return
        }
        const { pr, commits, files } = await this.deps.github.getPullRequest(repo.github, message.number)
        this.post({ type: 'pullRequest', number: message.number, pr, commits, files })
        return
      }
      case 'loadPullRequestCommitFiles': {
        const repo = await this.currentRepo()
        if (!repo.github) {
          return
        }
        const files = await this.deps.github.getCommitFiles(repo.github, message.sha)
        this.post({ type: 'pullRequestCommitFiles', number: message.number, sha: message.sha, files })
        return
      }
      case 'signInGitHub': {
        await this.deps.github.refreshSession(true)
        return
      }
      case 'loadFileContent': {
        let text: string | null = null
        try {
          text = await getFileContent(root, message.ref, message.path)
        } catch {
          // Not available locally (e.g. a pull request that was never fetched).
          const repo = await this.currentRepo()
          if (repo.github && message.ref) {
            text = await this.deps.github.getFileContent(repo.github, message.ref, message.path)
          }
        }
        this.post({ type: 'fileContent', requestId: message.requestId, text })
        return
      }
      case 'commit': {
        try {
          const text = message.description.trim()
            ? `${message.summary.trim()}\n\n${message.description.trim()}\n`
            : `${message.summary.trim()}\n`
          const sha = await commitChanges(root, text, message.entries)
          this.post({ type: 'committed', sha, summary: message.summary.trim(), canUndo: await canUndoLastCommit(root) })
        } finally {
          this.post({ type: 'commitDone' })
          this.scheduleRefresh()
        }
        return
      }
      case 'undoLastCommit': {
        const { summary, description } = await undoLastCommit(root)
        this.post({ type: 'undone', summary, description })
        this.scheduleRefresh()
        return
      }
      case 'discard':
        if (await discardChanges(root, message.files)) {
          this.scheduleRefresh()
        }
        return
      case 'checkoutPullRequest':
        await checkoutPullRequestWithProgress(this.deps, root, message.number)
        this.scheduleRefresh()
        return
      case 'discardLines':
        if (await discardLines(root, message.path, message.patch, message.lineCount)) {
          this.scheduleRefresh()
        }
        return
      case 'loadBranchList':
        this.post({ type: 'branchList', branches: await listBranches(root) })
        return
      case 'checkoutBranch':
        await checkoutBranch(root, message.branch)
        this.scheduleRefresh()
        return
      case 'createBranch':
        if (await createBranchInteractive(root)) {
          this.scheduleRefresh()
        }
        return
      case 'loadSyncStatus':
        await this.sendSyncStatus()
        return
      case 'sync':
        this.post({ type: 'syncing', action: message.action })
        try {
          await runSync(this.deps, root, message.action, await getSyncStatus(root))
        } catch (e) {
          void vscode.window.showErrorMessage(gitErrorText(e))
        } finally {
          this.post({ type: 'syncing', action: null })
          await this.sendSyncStatus()
          this.scheduleRefresh()
        }
        return
      case 'openDiffInEditor':
        await openDiffInEditor(this.deps, root, message.source, message.file)
        return
      case 'openFile':
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, message.path)))
        return
      case 'openExternal':
        await vscode.env.openExternal(vscode.Uri.parse(message.url))
        return
      case 'copy':
        await vscode.env.clipboard.writeText(message.text)
        vscode.window.setStatusBarMessage('Copied to clipboard', 2000)
        return
    }
  }

  private renderHtml(): string {
    const webview = this.panel.webview
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'))
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'codicon.css'))
    const nonce = makeNonce()
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codicons}" rel="stylesheet">
<link href="${style}" rel="stylesheet">
</head>
<body data-palette="${this.config().palette}" data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="root"></div>
<script nonce="${nonce}">window.__DESKTOP_VIEW_LOCALE__ = ${JSON.stringify(vscode.env.language)};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }

  dispose() {
    DesktopViewPanel.panels.delete(this)
    clearTimeout(this.refreshTimer)
    this.disposables.forEach(d => d.dispose())
    this.disposables.length = 0
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) {
    nonce += chars[Math.floor(Math.random() * chars.length)]
  }
  return nonce
}

/** Opens the file's change in VS Code's native diff editor. */
export async function openDiffInEditor(deps: PanelDeps, root: string, source: DiffSource, file: ChangedFile) {
  const newUri = vscode.Uri.file(path.join(root, file.path))
  const oldUri = vscode.Uri.file(path.join(root, file.oldPath ?? file.path))
  const gitUri = (uri: vscode.Uri, ref: string) => deps.repos.toGitUri(uri, ref)
  const title = (suffix: string) => `${path.basename(file.path)} (${suffix})`

  let left: vscode.Uri | undefined
  let right: vscode.Uri | undefined
  let label: string

  if (source.kind === 'working') {
    left = file.status === 'untracked' || file.status === 'added' ? gitUri(oldUri, EmptyTreeSha) : gitUri(oldUri, 'HEAD')
    right = newUri
    label = title('Working Tree')
  } else {
    let base: string | null
    let head: string
    if (source.kind === 'commit' || source.kind === 'prCommit') {
      head = source.sha
      if (!(await commitExists(root, head))) {
        void vscode.window.showWarningMessage(
          `Commit ${head.slice(0, 7)} is not available locally. Fetch it first to open it in the editor.`
        )
        return
      }
      base = await commitBase(root, source.kind === 'commit' ? source.oldestSha ?? head : head)
      label = title(source.kind === 'commit' && source.oldestSha ? `${source.oldestSha.slice(0, 7)}..${head.slice(0, 7)}` : head.slice(0, 7))
    } else {
      const repo = await deps.repos.describe(root)
      if (!repo.github) {
        return
      }
      const { pr } = await deps.github.getPullRequest(repo.github, source.number)
      head = pr.headSha
      if (!(await commitExists(root, head))) {
        void vscode.window.showWarningMessage(
          `The head of PR #${pr.number} is not available locally. Run "git fetch origin pull/${pr.number}/head" to open it in the editor.`
        )
        return
      }
      base = null
      for (const ref of [`upstream/${pr.baseRef}`, `origin/${pr.baseRef}`, pr.baseRef]) {
        base = await mergeBase(root, ref, head)
        if (base) {
          break
        }
      }
      label = title(`#${pr.number}`)
    }
    if (!base) {
      void vscode.window.showWarningMessage('Could not find the base commit for this diff.')
      return
    }
    left = gitUri(oldUri, file.status === 'added' ? EmptyTreeSha : base)
    right = gitUri(newUri, file.status === 'deleted' ? EmptyTreeSha : head)
  }

  if (!left || !right) {
    void vscode.window.showWarningMessage('The built-in Git extension is required to open diffs in the editor.')
    return
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, label, { preview: true })
}

/**
 * Discards local changes after confirmation. Current contents go to the trash
 * first (like GitHub Desktop), so a mistaken discard can be recovered.
 * Returns whether anything was discarded.
 */
export async function discardChanges(root: string, files: ReadonlyArray<ChangedFile>): Promise<boolean> {
  const discardable = files.filter(f => f.status !== 'conflicted')
  if (discardable.length === 0) {
    void vscode.window.showWarningMessage('Conflicted files cannot be discarded here. Resolve the conflict first.')
    return false
  }
  const names = discardable.map(f => f.path)
  const detail =
    (names.length <= 10 ? names.join('\n') : `${names.slice(0, 10).join('\n')}\n…and ${names.length - 10} more`) +
    '\n\nThe current contents will be moved to the trash.'
  const choice = await vscode.window.showWarningMessage(
    discardable.length === 1
      ? `Discard all changes to ${path.basename(discardable[0].path)}?`
      : `Discard changes to ${discardable.length} files?`,
    { modal: true, detail },
    'Discard Changes'
  )
  if (choice !== 'Discard Changes') {
    return false
  }

  const trashed: ChangedFile[] = []
  try {
    for (const file of discardable) {
      if (file.status !== 'deleted') {
        await vscode.workspace.fs.delete(vscode.Uri.file(path.join(root, file.path)), { useTrash: true })
      }
      trashed.push(file)
    }
  } finally {
    // Even after a failure, restore what was already trashed so tracked files don't look deleted.
    await restoreToHead(root, trashed)
  }
  return true
}

/** Errors from VS Code's git API carry git's output in `stderr`. */
export function gitErrorText(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.trim()) {
    return stderr.trim()
  }
  return e instanceof Error ? e.message : String(e)
}

/** Fetches through VS Code's git extension when available, so its credential prompts and GitHub sign-in apply. */
function fetcher(deps: PanelDeps, root: string): Fetcher | undefined {
  const repo = deps.repos.repository(root)
  return repo ? (remote, refspec) => repo.fetch({ remote, ref: refspec }) : undefined
}

/** Runs the push/pull button's action. */
export async function runSync(deps: PanelDeps, root: string, action: SyncAction, status: SyncStatus) {
  const { remote, branch } = status
  if (!remote) {
    throw new Error('This repository has no remote to sync with.')
  }
  const repo = deps.repos.repository(root)
  switch (action) {
    case 'fetch':
      return repo ? repo.fetch({ remote }) : git(root, ['fetch', '--quiet', remote])
    case 'pull':
      return repo ? repo.pull() : git(root, ['pull', '--quiet'])
    case 'push':
      return repo ? repo.push() : git(root, ['push', '--quiet'])
    case 'publish':
      if (!branch) {
        throw new Error('Check out a branch before publishing.')
      }
      return repo ? repo.push(remote, branch, true) : git(root, ['push', '--quiet', '--set-upstream', remote, branch])
  }
}

/** Reverts the selected lines of a file after confirmation. Returns whether it did. */
export async function discardLines(root: string, filePath: string, patch: string, lineCount: number): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Discard ${lineCount === 1 ? 'the selected line' : `${lineCount} selected lines`} in ${path.basename(filePath)}?`,
    { modal: true, detail: 'The lines go back to their committed version. This cannot be undone here.' },
    'Discard Lines'
  )
  if (choice !== 'Discard Lines') {
    return false
  }
  await discardPatch(root, patch)
  return true
}

/** Branch names cannot contain spaces; GitHub Desktop turns them into dashes as you type. */
function sanitizeBranchName(name: string): string {
  return name.trim().replace(/\s+/g, '-')
}

export async function createBranchInteractive(root: string): Promise<boolean> {
  const current = await getCurrentBranch(root)
  const input = await vscode.window.showInputBox({
    title: 'Create a branch',
    prompt: current ? `The branch starts from "${current}". Uncommitted changes come along.` : undefined,
    placeHolder: 'Branch name',
    validateInput: async value => {
      if (!value.trim()) {
        return null
      }
      const name = sanitizeBranchName(value)
      const error = await validateBranchName(root, name)
      if (error) {
        return error
      }
      return name !== value ? { message: `Will be created as ${name}`, severity: vscode.InputBoxValidationSeverity.Info } : null
    },
  })
  const name = input === undefined ? '' : sanitizeBranchName(input)
  if (!name) {
    return false
  }
  const error = await validateBranchName(root, name)
  if (error) {
    throw new Error(error)
  }
  await createBranch(root, name)
  return true
}

export async function renameBranchInteractive(root: string, branch: string): Promise<boolean> {
  const input = await vscode.window.showInputBox({
    title: `Rename branch ${branch}`,
    value: branch,
    validateInput: async value => {
      const name = sanitizeBranchName(value)
      return name === branch ? null : validateBranchName(root, name)
    },
  })
  const name = input === undefined ? '' : sanitizeBranchName(input)
  if (!name || name === branch) {
    return false
  }
  await renameBranch(root, branch, name)
  return true
}

/** Deletes a local branch, asking again before throwing away unmerged commits. */
export async function deleteBranchInteractive(root: string, branch: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Delete branch ${branch}?`,
    { modal: true, detail: 'Only the local branch is deleted; the remote branch, if any, is kept.' },
    'Delete'
  )
  if (choice !== 'Delete') {
    return false
  }
  try {
    await deleteBranch(root, branch, false)
  } catch (e) {
    if (!/not fully merged/.test(gitErrorText(e))) {
      throw e
    }
    const force = await vscode.window.showWarningMessage(
      `${branch} has commits that are not merged into the current branch or its upstream.`,
      { modal: true, detail: 'Deleting it may lose those commits.' },
      'Delete Anyway'
    )
    if (force !== 'Delete Anyway') {
      return false
    }
    await deleteBranch(root, branch, true)
  }
  return true
}

export async function checkoutPullRequestWithProgress(deps: PanelDeps, root: string, number: number) {
  const repo = await deps.repos.describe(root)
  if (!repo.github) {
    return
  }
  const { pr } = await deps.github.getPullRequest(repo.github, number)
  const branch = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking out pull request #${number}…` },
    () =>
      checkoutPullRequest(
        root,
        repo.github!.remote ?? 'origin',
        { number, headBranch: pr.headBranch, fromFork: pr.fromFork },
        fetcher(deps, root)
      )
  )
  vscode.window.setStatusBarMessage(`Checked out ${branch}`, 4000)
}
