# Branch Diff Colors

Colors files (and their parent folders) in the VS Code Explorer that **differ
from a chosen base branch** — committed or not — the same way Git's built-in
`gitDecoration.*` colors mark modified/untracked files. Uses VS Code's
`FileDecorationProvider` API, so it's a real Explorer badge + text color, not
a separate panel.

It also highlights the changed lines directly in the editor — a translucent
full-width line background, in the style of the Error Lens extension, rather
than a gutter bar. That leaves the gutter to Git's own uncommitted-change
indicator, so both can be on screen at once without competing. Next to each
changed line it prints, in the Explorer color, how that line reads on the
base branch.

## What it does

- Runs `git diff --name-only <base>...HEAD` to find every file that differs
  from your chosen base branch via committed history.
- Colors and badges (`B` by default) those files — and any parent folder that
  contains one — in the normal Explorer tree, just like Git badges folders
  containing uncommitted changes.
- Tints every editor line that differs from the base branch's merge-base with
  a translucent whole-line background, plus a mark in the overview ruler so
  changes are visible in the scrollbar. Like the Explorer decoration, this
  follows `includeUncommitted`: by default it compares committed history only,
  so merely saving a file never marks its lines.
- Prints the base-branch version of each changed line to the right of it, in
  the Explorer color — the same place Error Lens puts a diagnostic message.
  Hover it to see the full, untruncated line.
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
  editing needed. It also writes a matching line-background color shaded off
  that hue — darker on dark themes, lighter on light ones — so both stay in
  sync.
- **Branch Diff Colors: Refresh** — force a re-scan if it ever looks stale.

## Changing the color manually (optional)

The command above does this for you, but you can also edit it directly in
`settings.json`, exactly like the built-in git colors:

```json
"workbench.colorCustomizations": {
  "branchDiff.changedResourceForeground": "#e784bf",
  "branchDiff.changedLineBackground": "#7f486966"
}
```

Two separate keys, because a color that reads well as Explorer *text* is far
too strong as a *background*, and the two want to move in opposite directions
per theme:

| Key                                    | Dark theme        | Light theme       |
| -------------------------------------- | ----------------- | ----------------- |
| `branchDiff.changedResourceForeground` | `#e784bf`         | `#590d44`         |
| `branchDiff.changedLineBackground`     | `#7f486966` (deep pink) | `#f4c8e273` (pale pink) |

The line background is a **darker** pink on dark themes and a **lighter** pink
on light themes, so the tint sits behind the text instead of competing with
it. The trailing two hex digits are the alpha channel — raise them for a
stronger tint, lower them for a subtler one.

The base-branch text printed to the right of each line uses
`branchDiff.changedResourceForeground`, so it always matches the Explorer.

## Settings

| Setting                               | Default  | Description                                                                                  |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `branchDiffColors.baseBranch`         | `"main"` | Branch to diff against.                                                                      |
| `branchDiffColors.badge`              | `"B"`    | 1–2 character badge shown on decorated files.                                                |
| `branchDiffColors.includeUncommitted` | `false`  | Also count uncommitted/untracked changes, not just committed diffs from the base branch. Applies to both the Explorer decoration and the line highlight. |
| `branchDiffColors.highlightChangedLines` | `true` | Highlight editor lines that differ from the base branch with a full-width background tint.  |
| `branchDiffColors.showBaseBranchText` | `true`   | Print the base-branch version of each changed line to the right of it.                       |
| `branchDiffColors.baseBranchTextMaxLength` | `120` | Truncate that text after this many characters. The full line stays available on hover.     |

`branchDiffColors.showLineMarkers` was the old name for
`highlightChangedLines`. It's deprecated but still honoured, so an existing
`false` keeps the highlight off until you set the new key.

## Why a line background instead of a gutter bar?

The first version drew its own bar in the gutter, mimicking Git's
uncommitted-change indicator. Two bars in the same narrow strip read as
noise, and they can't be told apart at a glance.

Reusing VS Code's built-in quick-diff gutter isn't an option either: it
shares its coloring across every registered quick-diff source — any
third-party provider is tagged the same "primary" kind as Git's, and the
distinct "secondary" color is reserved for VS Code's own multi-provider
overlap case. Recoloring those shared keys either does nothing for lines Git
already owns, or recolors Git's own bars too.

A whole-line background sits in a different visual channel entirely, so the
branch diff and Git's gutter coexist cleanly — the same reason Error Lens
tints lines rather than adding another gutter icon.

## Known limitations

- Assumes a single-root workspace and diffs against `workspaceFolders[0]`.
- Remote branches (e.g. `origin/main`) work as the base branch without a
  local copy, but only reflect what you last fetched — run `git fetch` to
  update the comparison point if the remote has moved on.
- The Explorer badge/color is based on `git diff --name-only <base>...HEAD`
  (merge-base diff), so it reflects files that differ due to your branch's
  own commits — not every file `main` has ever touched.
- The in-editor line highlight is recomputed from `git diff` on save. With
  `includeUncommitted` off (the default) it reports only committed branch
  changes, remapping their line numbers through your local edits so the
  highlight follows the code as you insert and delete lines above it.
  Highlights also shift with unsaved edits, they just don't grow to cover new
  lines until the next save.
- A base line that your branch deleted outright has no line left to annotate,
  so it's folded into the annotation on the last surviving line of its hunk.
  A hunk that is *only* a deletion leaves nothing to highlight at all.
- Untracked files aren't line-highlighted — `git diff` doesn't see them.
  A file added in one of your branch's commits *is* highlighted, and since
  every line of it is new, the whole file gets tinted.
- No icon-level or full row-background coloring, since that's the limit of
  VS Code's `FileDecorationProvider` API — there's no API for that.
