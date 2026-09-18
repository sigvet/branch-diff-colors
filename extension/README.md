# Branch Diff Colors

Colors files (and their parent folders) in the VS Code Explorer that **differ
from a chosen base branch** — committed or not — the same way Git's built-in
`gitDecoration.*` colors mark modified/untracked files. Uses VS Code's
`FileDecorationProvider` API, so it's a real Explorer badge + text color, not
a separate panel.

It also drives the editor's quick-diff gutter (the colored bars next to line
numbers), diffed against your chosen branch instead of just Git's HEAD/index,
using the same highlight color as the Explorer badge.

## What it does
- Runs `git diff --name-only <base>...HEAD` to find every file that differs
  from your chosen base branch via committed history.
- Colors and badges (`B` by default) those files — and any parent folder that
  contains one — in the normal Explorer tree, just like Git badges folders
  containing uncommitted changes.
- Draws colored gutter bars in the editor for changed lines, diffed against
  the base branch, in the same color as the Explorer badge.
- Defers to more important signals: if a file has errors/warnings, or has its
  own uncommitted changes, this extension only adds the `B` badge — it won't
  override the color VS Code/Git already show for those.
- Refreshes automatically when you switch branches, commit, or save a file.
- Lets you change the base branch and the highlight color from the Command
  Palette — no manual settings.json editing required (though you can still
  edit it directly if you prefer).

## Try it without installing (Extension Development Host)
1. Open the `extension/` folder in VS Code.
2. Run `npm install` then `npm run compile`.
3. Press `F5`. This opens a second VS Code window ("Extension Development
   Host") with the extension active.
4. Open a git repo folder in that second window. Files differing from `main`
   should now show the badge/color.

## Install it for real (build a .vsix)
```bash
cd extension
npm install
npx @vscode/vsce package
code --install-extension branch-diff-colors-*.vsix
```

Or grab a prebuilt `.vsix` from the [Releases page](../../releases) of this
repo and run:
```bash
code --install-extension branch-diff-colors-<version>.vsix
```

## Commands (Ctrl/Cmd+Shift+P)
- **Branch Diff Colors: Set Base Branch to Compare Against** — type any
  branch name (`main`, `develop`, `origin/main`, etc). Saved per workspace.
- **Branch Diff Colors: Change Highlight Color** — type a hex color
  (e.g. `#e784bf`). Writes it into your user settings and keeps the gutter
  bars in sync — no manual JSON editing needed.
- **Branch Diff Colors: Refresh** — force a re-scan if it ever looks stale.

## Changing the color manually (optional)
The command above does this for you, but you can also edit it directly in
`settings.json`, exactly like the built-in git colors:

```json
"workbench.colorCustomizations": {
  "branchDiff.changedResourceForeground": "#e784bf",
  "editorGutter.addedBackground": "#e784bf",
  "editorGutter.addedSecondaryBackground": "#e784bf",
  "editorGutter.modifiedBackground": "#e784bf",
  "editorGutter.modifiedSecondaryBackground": "#e784bf",
  "editorGutter.deletedBackground": "#e784bf",
  "editorGutter.deletedSecondaryBackground": "#e784bf"
}
```

The default is `#e784bf` in dark themes and `#590d44` in light themes.

## Settings
| Setting | Default | Description |
|---|---|---|
| `branchDiffColors.baseBranch` | `"main"` | Branch to diff against. |
| `branchDiffColors.badge` | `"B"` | 1–2 character badge shown on decorated files. |
| `branchDiffColors.includeUncommitted` | `false` | Also highlight uncommitted/untracked changes, not just committed diffs from the base branch. |

## Quick-diff gutter bars
Git's own extension already registers a quick-diff provider for every file,
so VS Code may only show one set of gutter bars by default. Right-click the
gutter in an open file → **Quick Diff** submenu → make sure **Branch Diff
Colors** is checked (you can toggle Git's off there too if you only want the
branch-diff bars).

## Known limitations
- Assumes a single-root workspace and diffs against `workspaceFolders[0]`.
- Comparisons use `git diff --name-only <base>...HEAD` (merge-base diff), so
  it shows files that differ due to your branch's own commits — not every
  file `main` has ever touched.
- No icon-level or full row-background coloring, since that's the limit of
  VS Code's `FileDecorationProvider` API — there's no API for that.
