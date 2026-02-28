import * as vscode from "vscode";
import { activateIfDefHider, deactivateIfDefHider } from "./ifdef";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateIfDefHider(context);
}

export function deactivate(): void {
  deactivateIfDefHider();
}
