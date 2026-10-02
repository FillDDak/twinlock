import * as vscode from 'vscode';
import { Commands } from './commands';
import { TwinlockModel } from './model';
import { TwinlockCodeLens } from './ui/codeLens';
import { Decorations } from './ui/decorations';
import { DiagnosticsView } from './ui/diagnostics';
import { registerLanguageFeatures } from './ui/language';
import { StatusBar } from './ui/statusBar';
import { LinksTree } from './ui/tree';

/** Exposed for integration tests. */
export interface TwinlockApi {
  model: TwinlockModel;
  tree: LinksTree;
}

export function activate(context: vscode.ExtensionContext): TwinlockApi {
  const log = vscode.window.createOutputChannel('Twinlock', { log: true });
  const model = new TwinlockModel(context.workspaceState, log);
  const status = new StatusBar(model);
  const codeLens = new TwinlockCodeLens(model);
  const tree = new LinksTree(model);

  context.subscriptions.push(
    log,
    model,
    status,
    codeLens,
    new DiagnosticsView(model),
    new Decorations(model, context.extensionUri),
    tree,
    new Commands(model, status, log),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    ...registerLanguageFeatures(model),
  );

  log.info(`Twinlock ${context.extension.packageJSON.version} activated.`);
  model.start();
  return { model, tree };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
