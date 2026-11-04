# Desktop View

GitHub Desktop's layout inside VS Code: browse the history, the local changes
and the pull requests of every git repository in the workspace.

- **History**: commit list → files changed → diff, with "Select branch to compare" (behind / ahead).
  Shift/Ctrl+click selects several adjacent commits and shows their combined diff.
- **Changes**: working tree changes against `HEAD` → diff, with GitHub Desktop's commit flow:
  checkboxes pick the files, clicking (or dragging over) the diff gutter picks single lines,
  the hunk checkbox picks a whole hunk. Summary + description → **Commit**, then **Undo** while unpushed.
  Right-click a file (or the header) to discard changes; the current contents go to the trash.
  Right-click a line or hunk in the diff to discard just that part.
  Several files can be selected (Shift/Ctrl+click) and discarded or included at once.
- **Branches and sync**: the "Current branch" dropdown switches, creates, renames and deletes branches;
  the sync button fetches, pulls, pushes or publishes the branch through VS Code's git
  (same credentials). Commits not pushed yet are marked with ↑ in History.
- **Pull Requests**: open / closed PRs from the repository's GitHub remote → files changed → diff,
  for the whole PR or a single commit of it. **Checkout** fetches the PR into a local branch
  (the head branch, or `pr/<number>` for forks).

Diffs expand context from the arrows on each hunk header. Ctrl+F searches inside the tab.

## Install

Download the `.vsix` from the [latest release](https://github.com/nazesaria/vscode-desktop-view/releases/latest), then either:

- **Extensions** view → `…` menu → **Install from VSIX...**, or
- `code --install-extension desktop-view-<version>.vsix`

Each repository opens in its own editor tab. Open one with:

- `Ctrl+Alt+H` / **Desktop View: Open Current Repository**
- **Desktop View: Open Repository...**
- the button in the Source Control view title, or on each repository in it
- the **Desktop View** status bar item
- the **Desktop View** icon in the activity bar, which lists the repositories

Inside a tab, the "Current repository" dropdown switches repository (Ctrl+Click or the split icon opens it in a new tab).

## Interaction

- Arrow keys / Home / End / PageUp / PageDown move through any list; Enter or double-click on a file opens the diff in VS Code's editor.
- Right-click commits, files and pull requests for copy / open actions, including opening the file
  as it is on disk or as it was in that commit or pull request.
- The gear above the diff switches unified ↔ split and hides whitespace changes (local diffs only).
- Pane widths, the active tab and diff options are remembered per tab.
- Colors follow GitHub Desktop's palette by default; set `desktopView.colors` to `theme` to use your VS Code theme instead.

## How commits are made

Like GitHub Desktop, the checkboxes decide what is committed, not the git index: the commit is
built in a temporary index seeded from `HEAD`, so whatever else you staged elsewhere stays staged
and uncommitted. Hooks run as usual. Undo is a `git reset --soft HEAD^`, offered only when the
commit is not on any remote branch.

## GitHub

Pull requests use the GitHub account VS Code is signed in to (the built-in GitHub
authentication, `repo` scope). Public repositories work without signing in.

## Development

```sh
npm install
npm run build      # or: npm run watch
npm test           # parsers + git integration tests (commit, undo, discard, PR checkout) on temporary repositories
npm run package    # produces desktop-view-<version>.vsix
```

Press F5 with this folder open to launch an Extension Development Host.

## Not affiliated

An independent project, not made or endorsed by GitHub. It only borrows GitHub Desktop's layout and colors.

Icons are [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft (CC BY 4.0).
