import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

const COLOR_ID = "branchDiff.changedResourceForeground";
const CONFIG_SECTION = "branchDiffColors";
const ORIGINAL_SCHEME = "branchDiffColorsOriginal";

// Built-in gutter colors used to render our quick-diff line bars. Git's own quick-diff
// provider owns the "primary" added/modified/deleted keys — those must stay untouched so
// uncommitted changes keep Git's own color. Ours renders as "secondary" bars instead
// (VS Code's convention for a second active quick-diff source), kept in sync with our
// Explorer highlight color so the two visuals match for base-branch-only differences.
const GUTTER_COLOR_IDS = [
  "editorGutter.addedSecondaryBackground",
  "editorGutter.modifiedSecondaryBackground",
  "editorGutter.deletedSecondaryBackground",
];

const DEFAULT_COLOR_DARK = "#e784bf";
const DEFAULT_COLOR_LIGHT = "#590d44";

/** The hex value used for our Explorer badge/text color, resolving the user override or the theme default. */
function resolveHighlightColor(): string {
  const workbenchConfig = vscode.workspace.getConfiguration("workbench");
  const customizations =
    workbenchConfig.get<Record<string, unknown>>("colorCustomizations") || {};
  const override = customizations[COLOR_ID];
  if (typeof override === "string") {
    return override;
  }
  const kind = vscode.window.activeColorTheme.kind;
  const isLight =
    kind === vscode.ColorThemeKind.Light ||
    kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight ? DEFAULT_COLOR_LIGHT : DEFAULT_COLOR_DARK;
}

/** Keeps the quick-diff gutter bar colors matched to the Explorer highlight color. */
async function syncGutterColors(): Promise<void> {
  const hex = resolveHighlightColor();
  const workbenchConfig = vscode.workspace.getConfiguration("workbench");
  const existing =
    workbenchConfig.get<Record<string, unknown>>("colorCustomizations") || {};

  let changed = false;
  const updated = { ...existing };
  for (const id of GUTTER_COLOR_IDS) {
    if (updated[id] !== hex) {
      updated[id] = hex;
      changed = true;
    }
  }
  if (changed) {
    await workbenchConfig.update(
      "colorCustomizations",
      updated,
      vscode.ConfigurationTarget.Global,
    );
  }
}

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

function escapeRef(ref: string): string {
  // Defensive guard against obviously-bogus ref names; execFile already avoids
  // shell interpretation, this just keeps ref lookups sane.
  return ref.replace(/[^\w\-./]/g, "");
}

/**
 * Serves the base-branch (merge-base) version of a file's content, so the editor's
 * built-in quick-diff gutter can render added/modified/deleted line bars against it —
 * the same bars Git renders against HEAD, just diffed against the configured branch instead.
 */
class BranchDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly workspaceRoot: string) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const relativePath = decodeURIComponent(uri.path.replace(/^\//, ""));
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const base = escapeRef(config.get<string>("baseBranch", "main"));

    try {
      const mergeBase = (
        await execGit(["merge-base", base, "HEAD"], this.workspaceRoot)
      ).trim();
      return await execGit(
        ["show", `${mergeBase}:${relativePath}`],
        this.workspaceRoot,
      );
    } catch {
      // No such ref, or the file didn't exist at the merge-base — treat as if it's all new.
      return "";
    }
  }

  /** Tell the editor to re-fetch original content (and thus re-render gutters) for open files. */
  invalidateOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      const relativePath = toRelativePath(this.workspaceRoot, doc.uri.fsPath);
      if (doc.uri.scheme !== "file" || !relativePath) continue;
      this._onDidChange.fire(
        vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: "/" + relativePath }),
      );
    }
  }
}

class BranchDiffQuickDiffProvider implements vscode.QuickDiffProvider {
  constructor(private readonly workspaceRoot: string) {}

  provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    if (uri.scheme !== "file") return undefined;
    const relativePath = toRelativePath(this.workspaceRoot, uri.fsPath);
    if (!relativePath) return undefined;
    return vscode.Uri.from({
      scheme: ORIGINAL_SCHEME,
      path: "/" + relativePath,
    });
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

  // Quick-diff gutter bars (added/modified/deleted line markers), diffed against
  // the merge-base with the configured branch instead of Git's own HEAD/index.
  const contentProvider = new BranchDiffContentProvider(workspaceRoot);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ORIGINAL_SCHEME,
      contentProvider,
    ),
  );
  const sourceControl = vscode.scm.createSourceControl(
    "branchDiffColors",
    "Branch Diff Colors",
    workspaceFolders[0].uri,
  );
  sourceControl.quickDiffProvider = new BranchDiffQuickDiffProvider(
    workspaceRoot,
  );
  context.subscriptions.push(sourceControl);

  const doRefresh = () => {
    provider.refresh(workspaceRoot);
    contentProvider.invalidateOpenDocuments();
  };

  // Refresh on startup, and keep the gutter bars matched to the Explorer highlight color.
  doRefresh();
  syncGutterColors();

  // The default highlight color differs between light/dark themes; re-sync when the
  // active theme changes so the gutter bars keep matching.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => syncGutterColors()),
  );

  // Errors/warnings take priority over our highlight color (see provideFileDecoration),
  // so once diagnostics for a file clear (or appear), its decoration needs to be re-evaluated.
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) =>
      provider.notifyChanged(e.uris),
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
          "Hex color for files that differ from the base branch (e.g. #e2c08d)",
        placeHolder: "#e2c08d",
        validateInput: (v) =>
          /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)
            ? undefined
            : "Enter a valid hex color, e.g. #e2c08d",
      });
      if (!hex) return;

      const workbenchConfig = vscode.workspace.getConfiguration("workbench");
      const existing =
        workbenchConfig.get<Record<string, unknown>>("colorCustomizations") ||
        {};
      const updated = { ...existing, [COLOR_ID]: hex };
      await workbenchConfig.update(
        "colorCustomizations",
        updated,
        vscode.ConfigurationTarget.Global,
      );
      // Keep the gutter line-change bars matched to the same color as the Explorer badge.
      await syncGutterColors();
      vscode.window.showInformationMessage(
        `Branch Diff Colors: highlight color set to ${hex}`,
      );
    }),
  );
}

export function deactivate() {}
