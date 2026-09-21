import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

const COLOR_ID = "branchDiff.changedResourceForeground";
const LINE_BACKGROUND_COLOR_ID = "branchDiff.changedLineBackground";
const CONFIG_SECTION = "branchDiffColors";
// The line background is deliberately *not* the Explorer color: a whole-line tint needs a
// deeper pink on dark themes and a paler one on light themes to stay legible behind text.
// These mirror the `branchDiff.changedLineBackground` defaults in package.json.
const LINE_BACKGROUND_DARK_SHADE = -0.45; // mix the picked color toward black
const LINE_BACKGROUND_LIGHT_SHADE = 0.55; // mix the picked color toward white
const LINE_BACKGROUND_DARK_ALPHA = "66"; // ~40%
const LINE_BACKGROUND_LIGHT_ALPHA = "73"; // ~45%

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile (no shell) so branch names/paths never get shell-interpreted.
    cp.execFile(
      "git",
      args,
      { cwd, maxBuffer: 1024 * 1024 * 20 },
      (err: cp.ExecFileException | null, stdout: string, stderr: string) => {
        if (err) {
          // Non-zero exit is common for git diff on odd states; surface stderr for debugging.
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function toRelativePath(
  workspaceRoot: string,
  fsPath: string,
): string | undefined {
  const rel = path.relative(workspaceRoot, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

/** Normalizes `#abc` to `#aabbcc` so an alpha suffix can be appended safely. */
function expandHex(hex: string): string {
  const body = hex.slice(1);
  if (body.length !== 3) return hex;
  return "#" + [...body].map((c) => c + c).join("");
}

/**
 * Mixes a `#rrggbb` color toward white (`amount > 0`) or black (`amount < 0`), so the
 * in-editor line tint can be a darker or lighter pink than the Explorer foreground.
 */
function shadeHex(hex: string, amount: number): string {
  const body = expandHex(hex).slice(1);
  const target = amount > 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  const channels = [0, 2, 4].map((i) => {
    const value = parseInt(body.slice(i, i + 2), 16);
    const mixed = Math.round(value + (target - value) * ratio);
    return Math.max(0, Math.min(255, mixed)).toString(16).padStart(2, "0");
  });
  return "#" + channels.join("");
}

function escapeRef(ref: string): string {
  // Defensive guard against obviously-bogus ref names; execFile already avoids
  // shell interpretation, this just keeps ref lookups sane.
  return ref.replace(/[^\w\-./]/g, "");
}

class BranchDiffDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  // Files that differ from the base branch via committed history (merge-base...HEAD).
  private committedFiles = new Set<string>(); // absolute fs paths, normalized
  // Files with uncommitted working-tree/index/untracked changes. Git's own decoration
  // already colors these, so we defer to it and only add our badge on top.
  private uncommittedFiles = new Set<string>();
  private lastError: string | undefined;

  constructor(private readonly statusBar: vscode.StatusBarItem) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const normalized = this.normalize(uri.fsPath);
    const isCommitted = this.committedFiles.has(normalized);
    const isUncommitted = this.uncommittedFiles.has(normalized);
    if (!isCommitted && !isUncommitted) {
      return undefined;
    }

    const badge = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("badge", "B");
    const hasDiagnostics = vscode.languages
      .getDiagnostics(uri)
      .some(
        (d) =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning,
      );

    // Defer to more important signals: errors/warnings and uncommitted changes already
    // get their own Explorer color from VS Code/Git. We only add the "B" badge there,
    // and reserve our own highlight color for files that only differ from the base branch.
    const decoration: vscode.FileDecoration = {
      badge: badge.slice(0, 2),
      tooltip: "Differs from base branch",
      propagate: true,
    };
    if (isCommitted && !isUncommitted && !hasDiagnostics) {
      decoration.color = new vscode.ThemeColor(COLOR_ID);
    }
    return decoration;
  }

  private normalize(p: string): string {
    // Case-insensitive comparisons would be needed on Windows/macOS default FS,
    // but we keep it simple and case-sensitive here to match `git diff` output.
    return path.normalize(p);
  }

  async refresh(workspaceRoot: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const base = config.get<string>("baseBranch", "main");
    const includeUncommitted = config.get<boolean>("includeUncommitted", false);

    try {
      const previous = union(this.committedFiles, this.uncommittedFiles);
      const nextCommitted = new Set<string>();
      const nextUncommitted = new Set<string>();

      // Committed differences between base and HEAD.
      const committedOut = await execGit(
        ["diff", "--name-only", `${escapeRef(base)}...HEAD`],
        workspaceRoot,
      );
      addLines(nextCommitted, committedOut, workspaceRoot);

      // Optionally track uncommitted working-tree changes separately, so they can
      // still get the badge without our color fighting Git's own decoration for them.
      if (includeUncommitted) {
        const workingOut = await execGit(
          ["diff", "--name-only", "HEAD"],
          workspaceRoot,
        );
        addLines(nextUncommitted, workingOut, workspaceRoot);
        const untrackedOut = await execGit(
          ["ls-files", "--others", "--exclude-standard"],
          workspaceRoot,
        );
        addLines(nextUncommitted, untrackedOut, workspaceRoot);
      }

      this.committedFiles = nextCommitted;
      this.uncommittedFiles = nextUncommitted;
      const nextSet = union(nextCommitted, nextUncommitted);
      this.lastError = undefined;
      this.statusBar.text = `$(git-branch) diff:${base} (${nextSet.size})`;
      this.statusBar.tooltip = `Branch Diff Colors: comparing against "${base}". ${nextSet.size} file(s) highlighted.`;

      // Fire change events for anything that flipped state (added or removed).
      const changedUris: vscode.Uri[] = [];
      for (const p of union(previous, nextSet)) {
        if (previous.has(p) !== nextSet.has(p)) {
          changedUris.push(vscode.Uri.file(p));
        }
      }
      if (changedUris.length > 0) {
        this._onDidChange.fire(changedUris);
      } else {
        // First run: fire a broad refresh so the Explorer picks everything up.
        this._onDidChange.fire(undefined);
      }
    } catch (err: any) {
      this.lastError = err.message || String(err);
      this.statusBar.text = `$(warning) branch-diff error`;
      this.statusBar.tooltip = this.lastError;
    }
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  /** Re-evaluate decorations for specific files (e.g. their diagnostics changed) without a full git refresh. */
  notifyChanged(uris: readonly vscode.Uri[]): void {
    const relevant = uris.filter(
      (u) =>
        u.scheme === "file" &&
        (this.committedFiles.has(this.normalize(u.fsPath)) ||
          this.uncommittedFiles.has(this.normalize(u.fsPath))),
    );
    if (relevant.length > 0) {
      this._onDidChange.fire(relevant);
    }
  }
}

function addLines(set: Set<string>, output: string, workspaceRoot: string) {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    set.add(path.normalize(path.join(workspaceRoot, trimmed)));
  }
}

function union<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>(a);
  for (const item of b) out.add(item);
  return out;
}

/** One `@@ -oldStart,oldCount +newStart,newCount @@` hunk of a unified diff, body included. */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The `-` lines: how the hunk reads on the base side. */
  oldLines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  for (const raw of diffOutput.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = {
        oldStart: parseInt(header[1], 10),
        oldCount: header[2] !== undefined ? parseInt(header[2], 10) : 1,
        newStart: parseInt(header[3], 10),
        newCount: header[4] !== undefined ? parseInt(header[4], 10) : 1,
        oldLines: [],
      };
      hunks.push(current);
      continue;
    }
    // The `--- a/x` / `+++ b/x` preamble only ever precedes the first header, so there is no
    // hunk open yet when it goes by.
    if (!current) continue;
    if (raw.startsWith("-")) {
      current.oldLines.push(raw.slice(1));
    } else if (!raw.startsWith("+") && !raw.startsWith("\\")) {
      // Neither a `+` line nor a "\ No newline at end of file" marker: the hunk body is over.
      current = undefined;
    }
  }
  return hunks;
}

/** One editor line that differs from the base branch, with how that line reads on the base. */
interface ChangedLine {
  /** 0-based line in the document as it sits on disk. */
  line: number;
  /** The base-branch content this line replaced, absent for lines the branch purely added. */
  baseText?: string;
}

/**
 * The base-branch content behind the `i`-th new line of a hunk. A hunk can replace more base
 * lines than it produces, so the last new line also carries whatever the branch deleted
 * outright — otherwise those lines would silently vanish from the annotation.
 */
function baseTextForIndex(hunk: DiffHunk, i: number): string | undefined {
  if (i >= hunk.oldLines.length) return undefined;
  const upTo = i === hunk.newCount - 1 ? hunk.oldLines.length : i + 1;
  return hunk.oldLines.slice(i, upTo).join("\n");
}

/**
 * Turns a diff taken directly against the working tree into changed lines. `@@ -a,b +c,d @@`
 * gives `c` as the 1-based start line on the new side and `d` as how many lines the hunk
 * contributes there, so a pure deletion (`d == 0`) leaves no line to mark.
 */
function collectWorkingTreeLines(
  hunks: DiffHunk[],
  lineCount: number,
): ChangedLine[] {
  const changed: ChangedLine[] = [];
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.newCount; i++) {
      const line = hunk.newStart - 1 + i;
      if (line < 0 || line >= lineCount) continue;
      changed.push({ line, baseText: baseTextForIndex(hunk, i) });
    }
  }
  return changed;
}

/**
 * Translates a 1-based line number in the committed (HEAD) file into the corresponding line
 * in the file as it currently sits on disk, given the HEAD→working-tree hunks. Returns
 * `undefined` when the line no longer exists because a local edit deleted it.
 */
function mapHeadLineToWorkingTree(
  line: number,
  localHunks: DiffHunk[],
): number | undefined {
  let offset = 0;
  for (const hunk of localHunks) {
    if (hunk.oldCount === 0) {
      // Pure insertion recorded as `-a,0`: `a` is the HEAD line it was inserted *after*.
      if (line > hunk.oldStart) offset += hunk.newCount;
      continue;
    }
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    if (oldEnd < line) {
      offset += hunk.newCount - hunk.oldCount;
      continue;
    }
    if (hunk.oldStart > line) break; // hunks are ordered; the rest are past this line
    // The line itself was edited locally. If it survived, anchor it inside the hunk's
    // replacement so a branch-changed line stays marked even after being touched.
    if (hunk.newCount === 0) return undefined;
    return hunk.newStart + Math.min(line - hunk.oldStart, hunk.newCount - 1);
  }
  return line + offset;
}

/**
 * Maps the committed base→HEAD hunks onto the on-disk file, so uncommitted edits shift the
 * highlight along instead of being reported as branch changes themselves.
 */
function collectCommittedLines(
  committedHunks: DiffHunk[],
  localHunks: DiffHunk[],
  lineCount: number,
): ChangedLine[] {
  // A local edit can collapse several committed lines onto one line on disk; the first
  // base-branch counterpart wins so the annotation stays stable.
  const byLine = new Map<number, ChangedLine>();
  for (const hunk of committedHunks) {
    for (let i = 0; i < hunk.newCount; i++) {
      const mapped = mapHeadLineToWorkingTree(hunk.newStart + i, localHunks);
      if (mapped === undefined) continue;
      const line = mapped - 1;
      if (line < 0 || line >= lineCount || byLine.has(line)) continue;
      byLine.set(line, { line, baseText: baseTextForIndex(hunk, i) });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Collapses the changed lines into as few whole-line ranges as possible. */
function toRanges(changed: ChangedLine[]): vscode.Range[] {
  const lines = [...new Set(changed.map((c) => c.line))].sort((a, b) => a - b);
  const ranges: vscode.Range[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const line of lines) {
    if (start === undefined || previous === undefined) {
      start = previous = line;
      continue;
    }
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    ranges.push(new vscode.Range(start, 0, previous, 0));
    start = previous = line;
  }
  if (start !== undefined && previous !== undefined) {
    ranges.push(new vscode.Range(start, 0, previous, 0));
  }
  return ranges;
}

/**
 * Builds the end-of-line annotations that show how each changed line reads on the base
 * branch, the way Error Lens parks a diagnostic message to the right of the code.
 */
function toBaseTextAnnotations(
  changed: ChangedLine[],
  document: vscode.TextDocument,
  base: string,
  maxLength: number,
): vscode.DecorationOptions[] {
  const annotations: vscode.DecorationOptions[] = [];
  for (const { line, baseText } of changed) {
    if (baseText === undefined) continue; // the branch added this line; nothing to quote
    const collapsed = baseText.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    const truncated =
      collapsed.length > maxLength
        ? collapsed.slice(0, Math.max(1, maxLength - 1)) + "…"
        : collapsed;
    const end = document.lineAt(line).range.end;
    annotations.push({
      range: new vscode.Range(end, end),
      // The full, untruncated line stays reachable on hover.
      hoverMessage: new vscode.MarkdownString(
        `On \`${base}\`:\n\n\`\`\`\n${baseText}\n\`\`\``,
      ),
      renderOptions: { after: { contentText: `  ← ${truncated}` } },
    });
  }
  return annotations;
}

/** Reads the on/off toggle, honouring the pre-0.4 `showLineMarkers` name. */
function isLineHighlightEnabled(config: vscode.WorkspaceConfiguration): boolean {
  const current = config.inspect<boolean>("highlightChangedLines");
  const currentValue =
    current?.workspaceFolderValue ??
    current?.workspaceValue ??
    current?.globalValue;
  if (currentValue !== undefined) return currentValue;

  const legacy = config.inspect<boolean>("showLineMarkers");
  const legacyValue =
    legacy?.workspaceFolderValue ??
    legacy?.workspaceValue ??
    legacy?.globalValue;
  if (legacyValue !== undefined) return legacyValue;

  return true;
}

/**
 * Tints the full width of every line that differs from the base branch, the way Error Lens
 * highlights a line carrying a diagnostic: a translucent whole-line background in the
 * extension's own color, plus a mark in the overview ruler. Deliberately not a gutter bar —
 * that channel belongs to Git's quick-diff indicator for uncommitted edits, and two stacked
 * bars read as noise. A background tint sits in a different visual channel entirely, so both
 * can be on screen at once without competing.
 *
 * By default only committed differences count, matching `includeUncommitted`: an unsaved or
 * merely-saved local edit is Git's quick-diff story, not a branch difference.
 */
class BranchDiffLineHighlighter {
  private readonly decorationType = vscode.window.createTextEditorDecorationType(
    {
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(LINE_BACKGROUND_COLOR_ID),
      overviewRulerColor: new vscode.ThemeColor(COLOR_ID),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      // Keep the highlight pinned to the lines it was computed for instead of swallowing
      // text typed at either edge; a re-run of the diff on save re-establishes the truth.
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    },
  );

  // The end-of-line quote of the base-branch version. Separate from the background tint so it
  // can carry per-line text, and so it uses the main (Explorer) color the user picked.
  private readonly annotationType = vscode.window.createTextEditorDecorationType(
    {
      after: {
        color: new vscode.ThemeColor(COLOR_ID),
        fontStyle: "italic",
        margin: "0 0 0 2em",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    },
  );

  constructor(private readonly workspaceRoot: string) {}

  dispose(): void {
    this.decorationType.dispose();
    this.annotationType.dispose();
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
    editor.setDecorations(this.annotationType, []);
  }

  async updateEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!isLineHighlightEnabled(config)) {
      this.clear(editor);
      return;
    }
    const relativePath = toRelativePath(
      this.workspaceRoot,
      editor.document.uri.fsPath,
    );
    if (!relativePath) {
      this.clear(editor);
      return;
    }

    const base = escapeRef(config.get<string>("baseBranch", "main"));
    const includeUncommitted = config.get<boolean>("includeUncommitted", false);
    const lineCount = editor.document.lineCount;

    try {
      const mergeBase = (
        await execGit(["merge-base", base, "HEAD"], this.workspaceRoot)
      ).trim();

      let changed: ChangedLine[];
      if (includeUncommitted) {
        // merge-base against the working tree (no second ref), so the diff covers everything
        // this branch changed — committed or not — and its line numbers already refer to the
        // file as it sits on disk. No remapping needed.
        const diff = await execGit(
          ["diff", "--unified=0", mergeBase, "--", relativePath],
          this.workspaceRoot,
        );
        changed = collectWorkingTreeLines(parseHunks(diff), lineCount);
      } else {
        // Committed-only: diff merge-base against HEAD, never the working tree, so merely
        // saving a file can't make its lines look like branch changes. Those line numbers
        // refer to the committed file, so they're then shifted by the local HEAD→disk edits.
        const [committedDiff, localDiff] = await Promise.all([
          execGit(
            ["diff", "--unified=0", mergeBase, "HEAD", "--", relativePath],
            this.workspaceRoot,
          ),
          execGit(
            ["diff", "--unified=0", "HEAD", "--", relativePath],
            this.workspaceRoot,
          ),
        ]);
        changed = collectCommittedLines(
          parseHunks(committedDiff),
          parseHunks(localDiff),
          lineCount,
        );
      }

      editor.setDecorations(this.decorationType, toRanges(changed));
      editor.setDecorations(
        this.annotationType,
        config.get<boolean>("showBaseBranchText", true)
          ? toBaseTextAnnotations(
              changed,
              editor.document,
              config.get<string>("baseBranch", "main"),
              Math.max(8, config.get<number>("baseBranchTextMaxLength", 120)),
            )
          : [],
      );
    } catch {
      this.clear(editor);
    }
  }

  updateAllVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const statusBarItem = vscode.window.createStatusBarItem(
    "branchDiffColors",
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "branchDiffColors.setBaseBranch";
  statusBarItem.show();

  const provider = new BranchDiffDecorationProvider(statusBarItem);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
  );
  context.subscriptions.push(statusBarItem);

  const lineHighlighter = new BranchDiffLineHighlighter(workspaceRoot);
  context.subscriptions.push({ dispose: () => lineHighlighter.dispose() });

  const doRefresh = () => {
    provider.refresh(workspaceRoot);
    lineHighlighter.updateAllVisibleEditors();
  };

  // Refresh on startup.
  doRefresh();

  // Errors/warnings take priority over our highlight color (see provideFileDecoration),
  // so once diagnostics for a file clear (or appear), its decoration needs to be re-evaluated.
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) =>
      provider.notifyChanged(e.uris),
    ),
  );

  // Keep line markers current as editors are opened, switched to, or split.
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() =>
      lineHighlighter.updateAllVisibleEditors(),
    ),
  );

  // Refresh whenever the checked-out branch changes (HEAD updates on checkout/commit).
  const gitHeadWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], ".git/HEAD"),
  );
  gitHeadWatcher.onDidChange(doRefresh);
  gitHeadWatcher.onDidCreate(doRefresh);
  context.subscriptions.push(gitHeadWatcher);

  // Refresh on save, since uncommitted edits should update the decoration too.
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doRefresh));

  // React to configuration changes (base branch, badge, include-uncommitted toggle).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        doRefresh();
      }
    }),
  );

  // Command: change the base branch to compare against.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "branchDiffColors.setBaseBranch",
      async () => {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const current = config.get<string>("baseBranch", "main");
        const input = await vscode.window.showInputBox({
          prompt: "Branch to compare against (e.g. main, develop, origin/main)",
          value: current,
        });
        if (input && input.trim()) {
          await config.update(
            "baseBranch",
            input.trim(),
            vscode.ConfigurationTarget.Workspace,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("branchDiffColors.refresh", doRefresh),
  );

  // Command: change the highlight color without hand-editing settings.json.
  context.subscriptions.push(
    vscode.commands.registerCommand("branchDiffColors.pickColor", async () => {
      const hex = await vscode.window.showInputBox({
        prompt:
          "Hex color for files that differ from the base branch (e.g. #e784bf)",
        placeHolder: "#e784bf",
        validateInput: (v) =>
          /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)
            ? undefined
            : "Enter a valid hex color, e.g. #e784bf",
      });
      if (!hex) return;

      const workbenchConfig = vscode.workspace.getConfiguration("workbench");
      const existing =
        workbenchConfig.get<Record<string, unknown>>("colorCustomizations") ||
        {};
      // Theme colors can't be derived from one another at runtime, so the line background is
      // written alongside — otherwise picking a new color would leave the in-editor highlight
      // on the old one. It's shaded off the picked hue rather than reusing it: darker for dark
      // themes, lighter for light ones, which is what a whole-line tint needs to stay readable.
      const kind = vscode.window.activeColorTheme.kind;
      const isLight =
        kind === vscode.ColorThemeKind.Light ||
        kind === vscode.ColorThemeKind.HighContrastLight;
      const lineBackground =
        shadeHex(
          hex,
          isLight ? LINE_BACKGROUND_LIGHT_SHADE : LINE_BACKGROUND_DARK_SHADE,
        ) + (isLight ? LINE_BACKGROUND_LIGHT_ALPHA : LINE_BACKGROUND_DARK_ALPHA);
      const updated = {
        ...existing,
        [COLOR_ID]: hex,
        [LINE_BACKGROUND_COLOR_ID]: lineBackground,
      };
      await workbenchConfig.update(
        "colorCustomizations",
        updated,
        vscode.ConfigurationTarget.Global,
      );
      vscode.window.showInformationMessage(
        `Branch Diff Colors: highlight color set to ${hex}`,
      );
    }),
  );
}

export function deactivate() {}
