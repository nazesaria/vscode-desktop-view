# Desktop View

GitHub Desktop's layout inside VS Code: browse the history, the local changes
and the pull requests of every git repository in the workspace.

- **History**: commit list → files changed → diff, with "Select branch to compare" (behind / ahead).
- **Changes**: working tree changes (staged + unstaged, against `HEAD`) → diff. View only.
- **Pull Requests**: open / closed PRs from the repository's GitHub remote → files changed → diff,
  for the whole PR or a single commit of it.

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

## GitHub

Pull requests use the GitHub account VS Code is signed in to (the built-in GitHub
authentication, `repo` scope). Public repositories work without signing in.

## Development

```sh
npm install
npm run build      # or: npm run watch
npm test           # parsers + git integration tests against a temporary repository
npm run package    # produces desktop-view.vsix
```

Press F5 with this folder open to launch an Extension Development Host.
