import * as vscode from 'vscode';
import { summarize } from '../core/engine';
import { TwinlockModel } from '../model';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('twinlock.status', vscode.StatusBarAlignment.Left, 50);
  private readonly subs: vscode.Disposable[] = [];
  private linking: string | undefined;

  constructor(private readonly model: TwinlockModel) {
    this.item.name = 'Twinlock';
    this.subs.push(
      this.item,
      model.onDidChange(() => this.update()),
      model.onDidChangeIndexing(() => this.update()),
    );
    this.update();
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
  }

  /** Show the "link in progress" state (or clear it with `undefined`). */
  setLinking(description: string | undefined): void {
    this.linking = description;
    this.update();
  }

  update(): void {
    const item = this.item;
    if (this.linking) {
      item.text = '$(link) Select the linked code, then run Link again';
      item.tooltip = `Twinlock: linking from ${this.linking}.\nSelect the counterpart code (in any file) and press the Link shortcut again.\nClick to cancel.`;
      item.command = 'twinlock.cancelLink';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
      return;
    }
    if (!this.model.settings.enable || !this.model.settings.statusBar) {
      item.hide();
      return;
    }
    const results = this.model.analysis?.results ?? [];
    if (this.model.isIndexing && results.length === 0) {
      item.text = '$(sync~spin) Twinlock';
      item.tooltip = 'Twinlock: indexing workspace…';
      item.command = undefined;
      item.backgroundColor = undefined;
      item.show();
      return;
    }
    if (results.length === 0) {
      item.hide();
      return;
    }
    const s = summarize(results);
    item.command = 'twinlock.focus';
    if (s.broken > 0) {
      item.text = `$(error) ${s.broken} broken ${s.broken === 1 ? 'link' : 'links'}` + (s.pending > 0 ? `  $(warning) ${s.pending}` : '');
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (s.pending > 0) {
      item.text = `$(warning) ${s.pending} to sync`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      item.text = `$(link) ${results.length}`;
      item.backgroundColor = undefined;
    }
    const lines = [
      `Twinlock — ${results.length} linked ${results.length === 1 ? 'block' : 'blocks'}`,
      `${s.pending} need${s.pending === 1 ? 's' : ''} a matching update`,
      `${s.synced} changed together`,
      `${s.acknowledged} acknowledged`,
      `${s.broken} with broken links`,
      '',
      'Click to open the Linked Changes view',
    ];
    item.tooltip = lines.join('\n');
    item.show();
  }
}
