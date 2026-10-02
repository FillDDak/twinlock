import * as vscode from 'vscode';
import { toDiagnosticSeverity } from '../config';
import { TwinlockModel, uriOf } from '../model';
import { blockLocation, blockName, targetLocation, targetName, toRange } from './util';

export const DIAG_SOURCE = 'Twinlock';

export const Codes = {
  pending: 'pending',
  incoming: 'needs-update',
  missingFile: 'missing-file',
  missingLabel: 'missing-label',
  self: 'self-reference',
} as const;

/** Publishes parse errors, broken links and pending updates to the Problems panel. */
export class DiagnosticsView implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('twinlock');
  private readonly sub: vscode.Disposable;

  constructor(private readonly model: TwinlockModel) {
    this.sub = model.onDidChange(() => this.update());
  }

  dispose(): void {
    this.sub.dispose();
    this.collection.dispose();
  }

  update(): void {
    const analysis = this.model.analysis;
    const byUri = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    const add = (path: string, d: vscode.Diagnostic) => {
      const k = this.model.key(path);
      let e = byUri.get(k);
      if (!e) {
        e = { uri: uriOf(path), list: [] };
        byUri.set(k, e);
      }
      d.source = DIAG_SOURCE;
      e.list.push(d);
    };
    if (!analysis) {
      this.collection.clear();
      return;
    }
    const severity = toDiagnosticSeverity(this.model.settings.pendingSeverity);
    const ns = this.model.settings.namespace;

    for (const r of analysis.results) {
      for (const t of r.targets) {
        const range = toRange(t.target.span);
        if (t.state === 'missing-file') {
          const d = new vscode.Diagnostic(range, `Linked file not found: "${t.target.path}" (looked for ${this.model.display(t.resolvedPath, r.path)}).`, vscode.DiagnosticSeverity.Error);
          d.code = Codes.missingFile;
          add(r.path, d);
        } else if (t.state === 'missing-label') {
          const d = new vscode.Diagnostic(range, `No ${ns}.IfChange(${t.target.label}) block found in ${this.model.display(t.resolvedPath, r.path)}.`, vscode.DiagnosticSeverity.Error);
          d.code = Codes.missingLabel;
          d.relatedInformation = [new vscode.DiagnosticRelatedInformation(targetLocation(t), 'Linked file')];
          add(r.path, d);
        } else if (t.state === 'self') {
          const d = new vscode.Diagnostic(range, 'This target refers to the block (or file) it is written in, so it can never be out of sync.', vscode.DiagnosticSeverity.Information);
          d.code = Codes.self;
          d.tags = [vscode.DiagnosticTag.Unnecessary];
          add(r.path, d);
        } else if (t.state === 'stale' && r.state === 'pending') {
          const name = targetName(this.model, t, r.path);
          const d = new vscode.Diagnostic(
            range,
            `The guarded code above changed, but ${name} was not updated. Update it too, or acknowledge that no change is needed.`,
            severity,
          );
          d.code = Codes.pending;
          d.relatedInformation = [
            new vscode.DiagnosticRelatedInformation(targetLocation(t), `${name} must change together with this block`),
            new vscode.DiagnosticRelatedInformation(blockLocation(r), 'Changed block'),
          ];
          add(r.path, d);

          // Mirror the obligation in the target file, where the work has to happen.
          const tb = t.targetBlock;
          const where = tb ? toRange(tb.labelSpan ?? tb.ifSpan) : new vscode.Range(0, 0, 0, 0);
          const src = blockName(this.model, r);
          const d2 = new vscode.Diagnostic(
            where,
            `${src} changed. This ${tb ? 'block' : 'file'} is linked to it and has not been updated yet.`,
            severity,
          );
          d2.code = Codes.incoming;
          d2.relatedInformation = [new vscode.DiagnosticRelatedInformation(blockLocation(r), `Changed: ${src}`)];
          add(t.resolvedPath, d2);
        }
      }
    }

    // Syntax errors in every indexed file.
    for (const { path, parsed } of this.model.allParsed()) {
      for (const e of parsed.errors) {
        const d = new vscode.Diagnostic(toRange(e.span), e.message, vscode.DiagnosticSeverity.Error);
        d.code = e.code;
        add(path, d);
      }
    }

    this.collection.clear();
    for (const { uri, list } of byUri.values()) {
      this.collection.set(uri, list);
    }
  }
}
