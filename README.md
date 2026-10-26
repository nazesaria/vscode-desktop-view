# Desktop View

GitHub Desktop's layout inside VS Code: browse the history, the local changes
and the pull requests of every git repository in the workspace.

- **History**: commit list → files changed → diff, with "Select branch to compare" (behind / ahead).
  Shift/Ctrl+click selects several adjacent commits and shows their combined diff.
- **Changes**: working tree changes against `HEAD` → diff, with GitHub Desktop's commit flow:
  checkboxes pick the files, clicking (or dragging over) the diff gutter picks single lines,
  the hunk checkbox picks a whole hunk. Summary + description → **Commit**, then **Undo** while unpushed.
  Right-click a file (or the header) to discard changes; the current contents go to the trash.
- **Pull Requests**: open / closed PRs from the repository's GitHub remote → files changed → diff,
  for the whole PR or a single commit of it. **Checkout** fetches the PR into a local branch
  (the head branch, or `pr/<number>` for forks).

Diffs expand context from the arrows on each hunk header.

Each repository opens in its own editor tab. Open one with:

- `Ctrl+Alt+H` / **Desktop View: Open Current Repository**
- **Desktop View: Open Repository...**
- the button in the Source Control view title, or on each repository in it
- the **Desktop View** status bar item

Inside a tab, the "Current repository" dropdown switches repository (Ctrl+Click or the split icon opens it in a new tab).

## Interaction

- Arrow keys / Home / End / PageUp / PageDown move through any list; Enter or double-click on a file opens the diff in VS Code's editor.
- Right-click commits, files and pull requests for copy / open actions.
- The gear above the diff switches unified ↔ split and hides whitespace changes (local diffs only).
- Pane widths, the active tab and diff options are remembered per tab.

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
npm run package    # produces desktop-view.vsix
```

Press F5 with this folder open to launch an Extension Development Host.
