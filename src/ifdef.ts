import * as vscode from "vscode";

const EXTENSION_ID = "emudome.hideifdef";
const CONFIG_SECTION = "ifdef";
const TOGGLE_COMMAND_ID = "ifdef.toggle";
const STATUS_BAR_PRIORITY = 100;
const WORKSPACE_MODE_KEY = `${EXTENSION_ID}.mode`;
const CLANGD_EXTENSION_ID = "llvm-vs-code-extensions.vscode-clangd";
const INACTIVE_NOTIFICATION = "textDocument/inactiveRegions";
const PREPROCESSOR_REGEX =
    /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/;

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type InactiveRegionsParams = {
    textDocument: { uri: string };
    regions: LspRange[];
    inactiveRegions: LspRange[];
    ranges: LspRange[];
};

// State
type HideIfdefMode = "visible" | "hidden" | "hiddenFolded";
const MODES: HideIfdefMode[] = ["visible", "hidden", "hiddenFolded"];
const $inactiveRegionsMap = new Map<string, vscode.Range[]>(); // Cache inactive regions to prevent flicker when reopening files
let $lastDecoration: vscode.TextEditorDecorationType | null = null; // Text decoration data (recreated when settings change)
let $lastOpacity = "";  // Used to suppress unnecessary updates
let $hideIfdefMode: HideIfdefMode = "hiddenFolded";
const $foldingChangeEmitter = new vscode.EventEmitter<void>(); // Fires when folding ranges need recalculation

async function initializeHideIfdefSetting(
    context: vscode.ExtensionContext
): Promise<void> {
    const storedMode = context.workspaceState.get<HideIfdefMode>(WORKSPACE_MODE_KEY);
    if (storedMode !== undefined && MODES.includes(storedMode)) {
        $hideIfdefMode = storedMode;
        return;
    }

    $hideIfdefMode = vscode.workspace.getConfiguration(CONFIG_SECTION).get<HideIfdefMode>("mode", "visible");
    await context.workspaceState.update(WORKSPACE_MODE_KEY, $hideIfdefMode);
}

function getHideIfdefOpacity(): number {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>("opacity", 0.0);
}

function getClangdOpacity(): number {
    return vscode.workspace.getConfiguration("clangd").get<number>("inactiveRegions.opacity", 0.55);
}

/**
 * Collect all lines hidden by decoration (inactive regions + preprocessor directives),
 * group consecutive hidden lines into blocks, and return a FoldingRange for each block of 2+ lines.
 *
 * Example: #endif (line 3) and #if 1 (line 4) are consecutive preprocessor lines → fold 3-4
 *          #else (line 7) through inactive code and #if 0 blocks to #endif (line 23) → fold 7-23
 */
function collectHiddenFoldingRanges(
    document: vscode.TextDocument,
    inactiveRanges: vscode.Range[]
): vscode.FoldingRange[] {
    // Gather every line number that the decoration hides
    const hiddenLines = new Set<number>();

    for (const range of inactiveRanges) {
        for (let i = range.start.line; i <= range.end.line; i++) {
            hiddenLines.add(i);
        }
    }
    for (let i = 0; i < document.lineCount; i++) {
        if (PREPROCESSOR_REGEX.test(document.lineAt(i).text)) {
            hiddenLines.add(i);
        }
    }

    if (hiddenLines.size === 0) { return []; }

    // Sort and group into consecutive blocks
    const sorted = [...hiddenLines].sort((a, b) => a - b);
    const foldingRanges: vscode.FoldingRange[] = [];
    let blockStart = sorted[0];
    let blockEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === blockEnd + 1) {
            blockEnd = sorted[i];
        } else {
            // Emit block only when it spans at least 2 lines (single-line fold is meaningless)
            if (blockEnd > blockStart) {
                foldingRanges.push(new vscode.FoldingRange(blockStart, blockEnd, vscode.FoldingRangeKind.Region));
            }
            blockStart = sorted[i];
            blockEnd = sorted[i];
        }
    }
    if (blockEnd > blockStart) {
        foldingRanges.push(new vscode.FoldingRange(blockStart, blockEnd, vscode.FoldingRangeKind.Region));
    }

    return foldingRanges;
}

/**
 * Subscribe to LSP notifications to receive inactive region information from clangd
 * Cache inactive regions to prevent flicker when re-displaying the editor
 */
async function subscribeClangdInactiveNotifications(): Promise<void> {
    const client = vscode.extensions.getExtension(CLANGD_EXTENSION_ID)?.exports?.client;
    if (!client || typeof client.onNotification !== "function") {
        return;
    }

    // Inject filter into clangd's middleware to suppress #if/#ifdef folding when hideIfdef is enabled
    // This prevents conflicting fold indicators between clangd's preprocessor folding and our inactive-region folding
    const middleware = client.middleware;
    if (middleware && typeof middleware === "object") {
        const originalProvideFoldingRanges = middleware.provideFoldingRanges;
        middleware.provideFoldingRanges = async (
            document: vscode.TextDocument,
            _context: vscode.FoldingContext,
            token: vscode.CancellationToken,
            next: (document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken) => Promise<vscode.FoldingRange[]>
        ): Promise<vscode.FoldingRange[]> => {
            const ranges: vscode.FoldingRange[] = originalProvideFoldingRanges
                ? await originalProvideFoldingRanges(document, _context, token, next)
                : await next(document, _context, token);
            if ($hideIfdefMode === "visible" || !ranges) { return ranges ?? []; }

            // Filter out folding ranges whose start line is a preprocessor directive
            return ranges.filter(range => {
                if (range.start >= document.lineCount) { return true; }
                return !PREPROCESSOR_REGEX.test(document.lineAt(range.start).text);
            });
        };
    }

    client.onNotification(INACTIVE_NOTIFICATION, async (params: InactiveRegionsParams) => {
        // When we receive inactive region information from clangd, update decorations based on it
        const uri = vscode.Uri.parse(params.textDocument.uri);
        const docKey = uri.fsPath.toLowerCase();
        const regions = params.regions.map(region =>
            new vscode.Range(
                new vscode.Position(region.start.line, region.start.character),
                new vscode.Position(region.end.line, region.end.character)
            )
        );

        // In hiddenFolded mode, unfold previous ranges before updating so stale folds are cleared
        const affectedEditors = vscode.window.visibleTextEditors
            .filter((e) => e.document.uri.fsPath.toLowerCase() === docKey);
        if ($hideIfdefMode === "hiddenFolded") {
            for (const editor of affectedEditors) {
                const oldRanges = $inactiveRegionsMap.get(docKey) ?? [];
                const oldFolding = collectHiddenFoldingRanges(editor.document, oldRanges);
                if (oldFolding.length > 0) {
                    await vscode.commands.executeCommand("editor.unfold", {
                        selectionLines: oldFolding.map(r => r.start),
                        levels: 1
                    });
                }
            }
        }

        // Cache the received inactive regions to prevent flicker when re-displaying the editor (it still flickers but displays faster)
        $inactiveRegionsMap.set(docKey, regions);

        // Notify folding provider that inactive regions have changed
        $foldingChangeEmitter.fire();

        // Decorate the editor screen for the file notified by clangd
        affectedEditors.forEach(editor => updateEditorDecoration(editor, getDecoration()));

        // Auto-fold hidden regions in affected editors
        for (const editor of affectedEditors) {
            await autoFoldHiddenRanges(editor);
        }
    });
}

/**
 * Sync status bar display with enabled/disabled state
 * Visualize the current state to users and make toggle behavior intuitive on click
 */
function updateStatusBar(
    statusBar: vscode.StatusBarItem
): void {
    const config: Record<HideIfdefMode, { text: string; tooltip: string }> = {
        visible: { text: "#ifdef: $(eye)", tooltip: vscode.l10n.t('statusBar.visible') },
        hidden: { text: "#ifdef: $(eye-closed)", tooltip: vscode.l10n.t('statusBar.hidden') },
        hiddenFolded: { text: "#ifdef: $(fold)", tooltip: vscode.l10n.t('statusBar.hiddenFolded') },
    };
    Object.assign(statusBar, config[$hideIfdefMode]);
}

/**
 * Initialize the status bar item
 * Create once during activation and register in subscriptions to automate resource management
 */
function createStatusBar(
    context: vscode.ExtensionContext
): vscode.StatusBarItem {
    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        STATUS_BAR_PRIORITY
    );
    statusBar.command = TOGGLE_COMMAND_ID;
    statusBar.show();
    context.subscriptions.push(statusBar);

    // Set initial value
    updateStatusBar(statusBar);

    return statusBar;
}

/**
 * Create or retrieve text decoration type from cache based on current settings
 * Reuse the same decoration as long as the opacity value doesn't change to suppress flicker when settings change
 */
function getDecoration(): vscode.TextEditorDecorationType {
    const targetOpacity = ($hideIfdefMode !== "visible" ? getHideIfdefOpacity() : getClangdOpacity()).toString();

    if ($lastDecoration && $lastOpacity === targetOpacity) {
        return $lastDecoration;
    }

    $lastDecoration?.dispose();
    $lastDecoration = vscode.window.createTextEditorDecorationType({ opacity: targetOpacity });
    $lastOpacity = targetOpacity;

    return $lastDecoration;
}

/**
 * Update decorations for a single editor
 * Encapsulate safe decoration updates including file scheme validation and C/C++ detection
 */
async function updateEditorDecoration(
    editor: vscode.TextEditor,
    decorationType: vscode.TextEditorDecorationType
): Promise<void> {
    if (editor.document.uri.scheme !== "file" ||
        !(editor.document.languageId === "c" || editor.document.languageId === "cpp") // Don't decorate files other than C/C++
    ) {
        return;
    }

    // Inactive code regions received from clangd
    const inactiveRanges = $inactiveRegionsMap.get(editor.document.uri.fsPath.toLowerCase()) ?? [];
    // Regions containing preprocessor directives (#ifdef, etc.)
    const preprocessorRanges = Array.from(
        { length: editor.document.lineCount },
        (_, i) => editor.document.lineAt(i)
    ).filter(line => PREPROCESSOR_REGEX.test(line.text)).map(line => line.range);

    // Apply show/hide decorations
    editor.setDecorations(
        decorationType,
        $hideIfdefMode !== "visible"
            ? [...inactiveRanges, ...preprocessorRanges] // Hide both inactive regions and #ifdef
            : inactiveRanges // Display inactive regions according to clangd settings, display #ifdef as per editor settings
    );
}

/**
 * Automatically fold all hidden-region folding ranges in the given editor
 * Waits briefly for VS Code to process updated folding ranges from the provider before executing fold
 */
async function autoFoldHiddenRanges(
    editor: vscode.TextEditor
): Promise<void> {
    if ($hideIfdefMode !== "hiddenFolded") { return; }
    if (editor.document.uri.scheme !== "file" ||
        !(editor.document.languageId === "c" || editor.document.languageId === "cpp")
    ) {
        return;
    }

    const docKey = editor.document.uri.fsPath.toLowerCase();
    const inactiveRanges = $inactiveRegionsMap.get(docKey) ?? [];
    const foldingRanges = collectHiddenFoldingRanges(editor.document, inactiveRanges);
    if (foldingRanges.length === 0) { return; }

    // Brief delay to allow VS Code to register updated folding ranges from the provider
    await new Promise(resolve => setTimeout(resolve, 100));

    await vscode.commands.executeCommand("editor.fold", {
        selectionLines: foldingRanges.map(r => r.start),
        levels: 1
    });
}

/**
 * Batch update decorations for active editor and all visible editors
 * Functionalized to maintain sync at startup, settings change, and editor switch
 */
async function updateActiveEditor(
): Promise<void> {
    const decoration = getDecoration();
    const active = vscode.window.activeTextEditor;
    if (active) {
        await updateEditorDecoration(active, decoration);
    }

    for (const editor of vscode.window.visibleTextEditors.filter((e) => e !== active)) {
        await updateEditorDecoration(editor, decoration);
    }
}

/**
 * Register a custom FoldingRangeProvider for C/C++ that provides folding ranges
 * based on merged inactive regions from clangd, including surrounding preprocessor directives
 * Only active when $hideIfdefEnabled is true; otherwise returns empty to let clangd handle folding
 */
function registerFoldingProvider(
    context: vscode.ExtensionContext
): void {
    const provider: vscode.FoldingRangeProvider = {
        onDidChangeFoldingRanges: $foldingChangeEmitter.event,
        provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
            if ($hideIfdefMode === "visible") { return []; }

            const docKey = document.uri.fsPath.toLowerCase();
            const inactiveRanges = $inactiveRegionsMap.get(docKey) ?? [];
            return collectHiddenFoldingRanges(document, inactiveRanges);
        }
    };

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            [{ language: "c" }, { language: "cpp" }],
            provider
        )
    );
}

/**
 * Register ON/OFF toggle command
 * Define explicit behavior when user clicks the status bar
 * By saving to global settings, it's reflected in all editors through settings change events
 */
function registerToggleCommand(
    context: vscode.ExtensionContext,
    statusBar: vscode.StatusBarItem
): void {
    const toggleCommand = vscode.commands.registerCommand(
        TOGGLE_COMMAND_ID,
        async () => {
            // Cycle mode: visible → hidden → hiddenFolded → visible
            const previousMode = $hideIfdefMode;
            const currentIndex = MODES.indexOf($hideIfdefMode);
            $hideIfdefMode = MODES[(currentIndex + 1) % MODES.length];
            await context.workspaceState.update(WORKSPACE_MODE_KEY, $hideIfdefMode);
            $foldingChangeEmitter.fire();
            updateStatusBar(statusBar);
            await updateActiveEditor();

            // Unfold regions that were folded in hiddenFolded mode when returning to visible
            if ($hideIfdefMode === "visible" && previousMode === "hiddenFolded") {
                for (const editor of vscode.window.visibleTextEditors) {
                    const docKey = editor.document.uri.fsPath.toLowerCase();
                    const inactiveRanges = $inactiveRegionsMap.get(docKey) ?? [];
                    const foldingRanges = collectHiddenFoldingRanges(editor.document, inactiveRanges);
                    if (foldingRanges.length > 0) {
                        await vscode.commands.executeCommand("editor.unfold", {
                            selectionLines: foldingRanges.map(r => r.start),
                            levels: 1
                        });
                    }
                }
            }

            // Auto-fold hidden regions in all visible editors when entering hiddenFolded mode
            if ($hideIfdefMode === "hiddenFolded") {
                for (const editor of vscode.window.visibleTextEditors) {
                    await autoFoldHiddenRanges(editor);
                }
            }
        }
    );
    context.subscriptions.push(toggleCommand);
}

/**
 * Listen to various editor events (text changes, file switches, settings changes) and sync decorations
 * Functionalized to register multiple event handlers at once to achieve unified control flow
 */
function registerEventHandlers(
    context: vscode.ExtensionContext,
    statusBar: vscode.StatusBarItem
): void {
    // Update decorations for that file when user edits text
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            const active = vscode.window.activeTextEditor;
            if (active && event.document === active.document) {
                await updateEditorDecoration(active, getDecoration());
            }
        })
    );

    // Update decorations for new active editor when user switches files
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                await updateEditorDecoration(editor, getDecoration());
                await autoFoldHiddenRanges(editor);
            }
        })
    );

    // When settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            // Update decorations for all editors if any settings change
            if (event.affectsConfiguration(CONFIG_SECTION)) {
                await updateActiveEditor();
            }
            updateStatusBar(statusBar);
        })
    );
}

/**
 * Initialize and activate the extension
 * Execute clangd connection, UI element creation, and event listener registration in order
 */
export async function activateIfDefHider(
    context: vscode.ExtensionContext
): Promise<void> {
    // Initial value of enabled is from settings, thereafter use workspaceState
    await initializeHideIfdefSetting(context);
    // Create status bar item
    const statusBar = createStatusBar(context);
    // Initialize to receive inactive regions from clangd and update decorations
    await subscribeClangdInactiveNotifications();
    // Register custom folding provider for inactive regions
    registerFoldingProvider(context);
    // Register ON/OFF toggle command
    registerToggleCommand(context, statusBar);
    // Register various event handlers
    registerEventHandlers(context, statusBar);
    // Update editor display (initialization)
    await updateActiveEditor();

    // Auto-fold hidden regions at startup
    for (const editor of vscode.window.visibleTextEditors) {
        await autoFoldHiddenRanges(editor);
    }
}

/**
 * Extension deactivation process
 * Clear cache and state map to dispose decorationType and prevent memory leaks
 */
export function deactivateIfDefHider(): void {
    $lastDecoration?.dispose();
    $lastDecoration = null;
    $inactiveRegionsMap.clear();
    $foldingChangeEmitter.dispose();
}
