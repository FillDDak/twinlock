import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TwinlockApi } from '../../../extension';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8'));
export const EXT_ID = `${pkg.publisher}.${pkg.name}`;

export async function activate(): Promise<TwinlockApi> {
  const ext = vscode.extensions.getExtension<TwinlockApi>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found`);
  return ext.activate();
}

export async function waitFor<T>(api: TwinlockApi, what: string, fn: () => T | undefined | false, timeout = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    await api.model.whenIdle();
    const v = fn();
    if (v) {
      return v;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function replaceIn(uri: vscode.Uri, search: string, replacement: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const idx = doc.getText().indexOf(search);
  assert.ok(idx >= 0, `"${search}" not found in ${uri.fsPath}`);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + search.length)), replacement);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

export function twinlockCodes(uri: vscode.Uri): string[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Twinlock').map((d) => String(d.code)).sort();
}
