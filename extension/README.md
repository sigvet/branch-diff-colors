# Branch Diff Colors

Colors files (and their parent folders) in the VS Code Explorer that **differ
from a chosen base branch** — committed or not — the same way Git's built-in
`gitDecoration.*` colors mark modified/untracked files. Uses VS Code's
`FileDecorationProvider` API, so it's a real Explorer badge + text color, not
a separate panel.

It also marks changed lines directly in the editor with its own colored
marker in the same highlight color as the Explorer badge — independent of
Git's own gutter, so the two never fight over color.

## What it does

- Runs `git diff --name-only <base>...HEAD` to find every file that differs
  from your chosen base branch via committed history.
- Colors and badges (`B` by default) those files — and any parent folder that
  contains one — in the normal Explorer tree, just like Git badges folders
  containing uncommitted changes.
- Draws a colored marker next to every line that differs due to *committed*
  history between the base branch's merge-base and HEAD, using a decoration
  this extension fully owns (not VS Code's shared quick-diff gutter). Lines
  that are only different because of an uncommitted edit are left to Git's
  own gutter marker instead — our marker never doubles up on those.
- Defers to more important signals for the Explorer badge color: if a file
  has errors/warnings, or has its own uncommitted changes, this extension
  only adds the `B` badge — it won't override the color VS Code/Git already
  show for those.
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
  (e.g. `#e784bf`). Writes it into your user settings — no manual JSON
  editing needed. The line markers in the editor pick it up automatically
  since they reference the same theme color.
- **Branch Diff Colors: Refresh** — force a re-scan if it ever looks stale.

## Changing the color manually (optional)

The command above does this for you, but you can also edit it directly in
`settings.json`, exactly like the built-in git colors:

```json
"workbench.colorCustomizations": {
  "branchDiff.changedResourceForeground": "#e784bf"
}
```

The in-editor line markers reference this same color, so a single setting
controls both. The default is `#e784bf` in dark themes and `#590d44` in
light themes.

## Settings

| Setting                               | Default  | Description                                                                                  |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `branchDiffColors.baseBranch`         | `"main"` | Branch to diff against.                                                                      |
| `branchDiffColors.badge`              | `"B"`    | 1–2 character badge shown on decorated files.                                                |
| `branchDiffColors.includeUncommitted` | `false`  | Also highlight uncommitted/untracked changes, not just committed diffs from the base branch. |
| `branchDiffColors.showLineMarkers`    | `true`   | Show the colored line marker in the editor for lines that differ from the base branch.       |

## Why not VS Code's built-in quick-diff gutter?

VS Code's quick-diff gutter (the API Git's own extension uses for its
add/modify/delete bars) shares its coloring across every registered
quick-diff source — any third-party provider registered through the public
API is tagged the same "primary" kind as Git's, and the distinct "secondary"
color is reserved for VS Code's own multi-provider overlap case, not
something a third-party extension can claim for itself. Trying to recolor
those shared keys either does nothing for lines Git already owns, or ends up
recoloring Git's own uncommitted-change bars too. Owning our own
`TextEditorDecorationType` instead means the branch-diff markers never
collide with Git's gutter, at the cost of not sharing screen space with it —
you'll see both, side by side, rather than one merged indicator.

## Known limitations

- Assumes a single-root workspace and diffs against `workspaceFolders[0]`.
- The Explorer badge/color is based on `git diff --name-only <base>...HEAD`
  (merge-base diff), so it reflects files that differ due to your branch's
  own commits — not every file `main` has ever touched.
- The in-editor line markers are recomputed from `git diff` on save, so they
  reflect saved content, not unsaved edits, until you save.
- No icon-level or full row-background coloring, since that's the limit of
  VS Code's `FileDecorationProvider` API — there's no API for that.
