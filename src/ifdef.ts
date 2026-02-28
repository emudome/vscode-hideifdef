import * as vscode from "vscode";

const EXTENSION_ID = "emudome.hideifdef";
const CONFIG_SECTION = "ifdef";
const TOGGLE_COMMAND_ID = "ifdef.toggle";
const STATUS_BAR_PRIORITY = 100;
const WORKSPACE_ENABLED_KEY = `${EXTENSION_ID}.enabled`;
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
const $inactiveRegionsMap = new Map<string, vscode.Range[]>(); // Cache inactive regions to prevent flicker when reopening files
let $lastDecoration: vscode.TextEditorDecorationType | null = null; // Text decoration data (recreated when settings change)
let $lastOpacity = "";  // Used to suppress unnecessary updates
let $hideIfdefEnabled = true;

async function initializeHideIfdefSetting(
    context: vscode.ExtensionContext
): Promise<void> {
    const storedEnabled = context.workspaceState.get<boolean>(WORKSPACE_ENABLED_KEY);
    if (storedEnabled !== undefined) {
        $hideIfdefEnabled = storedEnabled;
        return;
    }

    $hideIfdefEnabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enabled", false);
    await context.workspaceState.update(WORKSPACE_ENABLED_KEY, $hideIfdefEnabled);
}

function getHideIfdefOpacity(): number {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>("opacity", 0.0);
}

function getClangdOpacity(): number {
    return vscode.workspace.getConfiguration("clangd").get<number>("inactiveRegions.opacity", 0.55);
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

    client.onNotification(INACTIVE_NOTIFICATION, (params: InactiveRegionsParams) => {
        // When we receive inactive region information from clangd, update decorations based on it
        const uri = vscode.Uri.parse(params.textDocument.uri);
        const docKey = uri.fsPath.toLowerCase();
        const regions = params.regions.map(region =>
            new vscode.Range(
                new vscode.Position(region.start.line, region.start.character),
                new vscode.Position(region.end.line, region.end.character)
            )
        );

        // Cache the received inactive regions to prevent flicker when re-displaying the editor (it still flickers but displays faster)
        $inactiveRegionsMap.set(docKey, regions);

        // Decorate the editor screen for the file notified by clangd
        vscode.window.visibleTextEditors
            .filter((e) => e.document.uri.fsPath.toLowerCase() === docKey)
            .forEach(editor => updateEditorDecoration(editor, getDecoration()));
    });
}

/**
 * Sync status bar display with enabled/disabled state
 * Visualize the current state to users and make toggle behavior intuitive on click
 */
function updateStatusBar(
    statusBar: vscode.StatusBarItem
): void {
    Object.assign(statusBar, $hideIfdefEnabled
        ? { text: "#ifdef: $(eye-closed)", tooltip: vscode.l10n.t('statusBar.hidden') }
        : { text: "#ifdef: $(eye)", tooltip: vscode.l10n.t('statusBar.visible') }
    );
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
    const targetOpacity = ($hideIfdefEnabled ? getHideIfdefOpacity() : getClangdOpacity()).toString();

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
        $hideIfdefEnabled
            ? [...inactiveRanges, ...preprocessorRanges] // Hide both inactive regions and #ifdef
            : inactiveRanges // Display inactive regions according to clangd settings, display #ifdef as per editor settings
    );
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
            // Toggle: save enabled to workspace state
            $hideIfdefEnabled = !$hideIfdefEnabled;
            await context.workspaceState.update(WORKSPACE_ENABLED_KEY, $hideIfdefEnabled);
            updateStatusBar(statusBar);
            await updateActiveEditor();
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
    // Register ON/OFF toggle command
    registerToggleCommand(context, statusBar);
    // Register various event handlers
    registerEventHandlers(context, statusBar);
    // Update editor display (initialization)
    await updateActiveEditor();
}

/**
 * Extension deactivation process
 * Clear cache and state map to dispose decorationType and prevent memory leaks
 */
export function deactivateIfDefHider(): void {
    if ($lastDecoration) {
        $lastDecoration.dispose();
        $lastDecoration = null;
    }
    $inactiveRegionsMap.clear();
}
