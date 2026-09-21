import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

const COLOR_ID = "branchDiff.changedResourceForeground";
const LINE_BACKGROUND_COLOR_ID = "branchDiff.changedLineBackground";
const CONFIG_SECTION = "branchDiffColors";
// Alpha appended to a picked hex color to derive the translucent line background.
const LINE_BACKGROUND_ALPHA = "26"; // ~15%

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

/**
 * Turns a unified diff into the editor ranges to highlight. `@@ -a,b +c,d @@` headers give
 * `c` as the 1-based start line on the working-tree side and `d` as how many lines the hunk
 * contributes there, so a pure deletion (`d == 0`) leaves no line to highlight.
 */
function parseChangedLineRanges(
  diffOutput: string,
  lineCount: number,
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diffOutput))) {
    const newStart = parseInt(m[1], 10);
    const newLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    if (newLines === 0) continue;
    const startLine = Math.max(0, newStart - 1);
    const endLine = Math.min(lineCount - 1, newStart + newLines - 2);
    if (endLine < startLine) continue;
    ranges.push(new vscode.Range(startLine, 0, endLine, 0));
  }
  return ranges;
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

  constructor(private readonly workspaceRoot: string) {}

  dispose(): void {
    this.decorationType.dispose();
  }

  async updateEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!isLineHighlightEnabled(config)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    const relativePath = toRelativePath(
      this.workspaceRoot,
      editor.document.uri.fsPath,
    );
    if (!relativePath) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const base = escapeRef(config.get<string>("baseBranch", "main"));

    try {
      const mergeBase = (
        await execGit(["merge-base", base, "HEAD"], this.workspaceRoot)
      ).trim();
      // merge-base against the working tree (no second ref), so the diff covers everything
      // this branch changed — committed or not — and its line numbers already refer to the
      // file as it sits on disk. No remapping needed.
      const diff = await execGit(
        ["diff", "--unified=0", mergeBase, "--", relativePath],
        this.workspaceRoot,
      );
      editor.setDecorations(
        this.decorationType,
        parseChangedLineRanges(diff, editor.document.lineCount),
      );
    } catch {
      editor.setDecorations(this.decorationType, []);
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
      // Theme colors can't be derived from one another at runtime, so the line background
      // is written alongside as the same hue at low alpha — otherwise picking a new color
      // would leave the in-editor highlight on the old one.
      const updated = {
        ...existing,
        [COLOR_ID]: hex,
        [LINE_BACKGROUND_COLOR_ID]: expandHex(hex) + LINE_BACKGROUND_ALPHA,
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
