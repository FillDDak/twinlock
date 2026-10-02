import * as vscode from 'vscode';
import { TwinlockModel } from '../model';
import { blockName, blockRange } from './util';

/** Colours guarded blocks that need attention, with gutter and overview-ruler marks. */
export class Decorations implements vscode.Disposable {
  private readonly pending: vscode.TextEditorDecorationType;
  private readonly incoming: vscode.TextEditorDecorationType;
  private readonly synced: vscode.TextEditorDecorationType;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly model: TwinlockModel, extensionUri: vscode.Uri) {
    const icon = (name: string) => vscode.Uri.joinPath(extensionUri, 'media', name);
    this.pending = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('twinlock.pendingBackground'),
      overviewRulerColor: new vscode.ThemeColor('twinlock.pendingRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: icon('gutter-pending.svg'),
      gutterIconSize: '80%',
    });
    this.incoming = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('twinlock.incomingBackground'),
      overviewRulerColor: new vscode.ThemeColor('twinlock.pendingRuler'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: icon('gutter-incoming.svg'),
      gutterIconSize: '80%',
    });
    this.synced = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('gutter-synced.svg'),
      gutterIconSize: '80%',
    });
    this.subs.push(
      model.onDidChange(() => this.refreshAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
    );
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.pending.dispose();
    this.incoming.dispose();
    this.synced.dispose();
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor);
    }
  }

  private refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (!this.model.settings.decorations || !this.model.settings.enable || doc.uri.scheme !== 'file') {
      editor.setDecorations(this.pending, []);
      editor.setDecorations(this.incoming, []);
      editor.setDecorations(this.synced, []);
      return;
    }
    const max = doc.lineCount - 1;
    const clamp = (r: vscode.Range) => doc.validateRange(r);
    const pending: vscode.DecorationOptions[] = [];
    const synced: vscode.DecorationOptions[] = [];
    for (const r of this.model.resultsFor(doc.uri)) {
      if (r.block.ifLine > max) {
        continue;
      }
      if (r.state === 'pending') {
        pending.push({ range: clamp(blockRange(r.block)) });
      } else if (r.state === 'synced' || r.state === 'acknowledged') {
        synced.push({ range: clamp(new vscode.Range(r.block.ifLine, 0, r.block.ifLine, 0)) });
      }
    }
    const incoming: vscode.DecorationOptions[] = [];
    for (const inc of this.model.incomingFor(doc.uri)) {
      const tb = inc.target.targetBlock;
      const range = tb ? blockRange(tb) : new vscode.Range(0, 0, 0, 0);
      if (range.start.line > max) {
        continue;
      }
      incoming.push({
        range: clamp(range),
        hoverMessage: new vscode.MarkdownString(`**Twinlock:** \`${blockName(this.model, inc.source)}\` changed; update this ${tb ? 'block' : 'file'} to match.`),
      });
    }
    editor.setDecorations(this.pending, pending);
    editor.setDecorations(this.incoming, incoming);
    editor.setDecorations(this.synced, synced);
  }
}
