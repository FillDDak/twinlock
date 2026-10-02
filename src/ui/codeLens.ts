import * as vscode from 'vscode';
import { BlockResult } from '../core/engine';
import { TwinlockModel } from '../model';
import { blockName, isLinkable, targetLocation, targetName } from './util';

export class TwinlockCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly model: TwinlockModel) {
    this.sub = model.onDidChange(() => this.emitter.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.model.settings.codeLens || !this.model.settings.enable) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const maxLine = document.lineCount - 1;
    const at = (line: number) => new vscode.Range(Math.min(line, maxLine), 0, Math.min(line, maxLine), 0);

    for (const r of this.model.resultsFor(document.uri)) {
      if (r.block.ifLine > maxLine) {
        continue; // stale results while the document is being edited
      }
      const range = at(r.block.ifLine);
      lenses.push(new vscode.CodeLens(range, this.stateCommand(r)));
      if (r.state === 'pending') {
        lenses.push(new vscode.CodeLens(range, {
          title: 'Acknowledge',
          tooltip: 'Mark this change as not requiring updates in the linked code (until the block changes again)',
          command: 'twinlock.acknowledge',
          arguments: [r.path, r.id],
        }));
      }
      if (r.state !== 'clean') {
        lenses.push(new vscode.CodeLens(range, {
          title: 'Diff',
          tooltip: 'Compare this file with its baseline',
          command: 'twinlock.showChanges',
          arguments: [r.path, r.block.ifLine],
        }));
      }
      if (r.block.label !== undefined) {
        const inbound = this.model.inboundFor(r.path, r.block.label).filter((x) => x.block !== r.block);
        if (inbound.length > 0) {
          lenses.push(new vscode.CodeLens(range, {
            title: `$(references) ${inbound.length} ${inbound.length === 1 ? 'reference' : 'references'}`,
            tooltip: 'Blocks that list this block in their ThenChange',
            command: 'twinlock.showReferences',
            arguments: [r.path, r.block.ifLine],
          }));
        }
      }
    }

    // Obligations pointing at this file from elsewhere.
    const incoming = this.model.incomingFor(document.uri);
    const grouped = new Map<number, BlockResult[]>();
    for (const inc of incoming) {
      const line = inc.target.targetBlock ? inc.target.targetBlock.ifLine : 0;
      const list = grouped.get(line) ?? [];
      if (!list.includes(inc.source)) {
        list.push(inc.source);
      }
      grouped.set(line, list);
    }
    for (const [line, sources] of grouped) {
      if (line > maxLine) {
        continue;
      }
      const names = sources.map((s) => blockName(this.model, s, true));
      const title = sources.length === 1
        ? `$(arrow-swap) Needs update: ${names[0]} changed`
        : `$(arrow-swap) Needs update: ${sources.length} linked blocks changed`;
      lenses.push(new vscode.CodeLens(at(line), {
        title,
        tooltip: `Linked code changed in ${names.join(', ')}. Click to see what changed.`,
        command: 'twinlock.showChanges',
        arguments: [sources[0].path, sources[0].block.ifLine],
      }));
    }
    return lenses;
  }

  private stateCommand(r: BlockResult): vscode.Command {
    const linkable = r.targets.filter(isLinkable);
    const names = r.targets.map((t) => targetName(this.model, t, r.path, true));
    const open = (): Pick<vscode.Command, 'command' | 'arguments'> => {
      if (linkable.length === 1) {
        const loc = targetLocation(linkable[0]);
        return { command: 'twinlock.openLocation', arguments: [loc.uri, loc.range.start.line] };
      }
      return { command: 'twinlock.pickTarget', arguments: [r.path, r.block.ifLine] };
    };
    const list = names.length <= 2 ? names.join(', ') : `${names.length} targets`;
    switch (r.state) {
      case 'pending': {
        const stale = r.targets.filter((t) => t.state === 'stale');
        const staleNames = stale.map((t) => targetName(this.model, t, r.path, true));
        const loc = targetLocation(stale[0]);
        return {
          title: `$(warning) Update ${staleNames.length <= 2 ? staleNames.join(', ') : `${staleNames.length} linked targets`} too`,
          tooltip: 'This block changed, but linked code has not. Click to open it.',
          command: stale.length === 1 ? 'twinlock.openLocation' : 'twinlock.pickTarget',
          arguments: stale.length === 1 ? [loc.uri, loc.range.start.line] : [r.path, r.block.ifLine],
        };
      }
      case 'synced':
        return { title: `$(pass) In sync with ${list}`, tooltip: 'This block and all linked targets changed together', ...open() };
      case 'acknowledged':
        return { title: '$(check-all) Acknowledged: no linked change needed', tooltip: 'Click to undo the acknowledgement', command: 'twinlock.unacknowledge', arguments: [r.path, r.id] };
      default:
        return { title: `$(link) Linked to ${list}`, tooltip: 'Changes here must be mirrored in the linked code', ...open() };
    }
  }
}
