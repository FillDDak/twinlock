import * as vscode from 'vscode';
import { BlockResult, TargetResult } from '../core/engine';
import { splitLines } from '../core/lineDiff';
import { TwinlockModel, uriOf } from '../model';
import { Codes, DIAG_SOURCE } from './diagnostics';
import { stateText } from './tree';
import { blockName, isLinkable, targetLocation, targetName, targetStateText, toRange } from './util';

const SELECTOR: vscode.DocumentSelector = { scheme: 'file' };

function targetAt(model: TwinlockModel, doc: vscode.TextDocument, pos: vscode.Position): { result: BlockResult; target: TargetResult } | undefined {
  for (const result of model.resultsFor(doc.uri)) {
    if (pos.line < result.block.thenLine || pos.line > result.block.thenEndLine) {
      continue;
    }
    for (const target of result.targets) {
      if (toRange(target.target.span).contains(pos)) {
        return { result, target };
      }
    }
  }
  return undefined;
}

function blockOnLine(model: TwinlockModel, doc: vscode.TextDocument, line: number): BlockResult | undefined {
  return model.resultsFor(doc.uri).find((r) => r.block.ifLine === line);
}

function cmd(name: string, args: unknown[]): string {
  return `command:${name}?${encodeURIComponent(JSON.stringify(args))}`;
}

const TRUSTED_COMMANDS = ['twinlock.openLocation', 'twinlock.acknowledge', 'twinlock.showChanges'];

function fenceLang(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', cs: 'csharp', md: 'markdown', yml: 'yaml', sh: 'bash', h: 'c', hpp: 'cpp', cc: 'cpp' };
  return map[ext] ?? ext;
}

async function preview(t: TargetResult, maxLines = 12): Promise<string | undefined> {
  try {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uriOf(t.resolvedPath).fsPath);
    const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uriOf(t.resolvedPath)));
    const lines = splitLines(text);
    const from = t.targetBlock ? t.targetBlock.contentStart : 0;
    const to = t.targetBlock ? t.targetBlock.contentEnd : Math.min(lines.length - 1, maxLines - 1);
    const slice = lines.slice(from, Math.min(to + 1, from + maxLines));
    if (slice.length === 0) {
      return undefined;
    }
    // Strip common indentation for a tidy preview.
    const indent = Math.min(...slice.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    const body = slice.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
    const more = to - from + 1 > maxLines ? '\n…' : '';
    return '```' + fenceLang(t.resolvedPath) + '\n' + body.replace(/```/g, '`​``') + more + '\n```';
  } catch {
    return undefined;
  }
}

export function registerLanguageFeatures(model: TwinlockModel): vscode.Disposable[] {
  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const hit = targetAt(model, doc, pos);
      if (hit) {
        const { result, target } = hit;
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
        md.supportThemeIcons = true;
        const name = targetName(model, target, result.path);
        md.appendMarkdown(`**Twinlock** · \`${name}\` — ${targetStateText(target, result.state === 'pending')}\n\n`);
        if (target.state === 'missing-file') {
          md.appendMarkdown(`Looked for \`${model.display(target.resolvedPath, result.path)}\`.`);
          return new vscode.Hover(md, toRange(target.target.span));
        }
        const code = await preview(target);
        if (code) {
          md.appendMarkdown(code + '\n\n');
        }
        const loc = targetLocation(target);
        md.appendMarkdown(`[$(go-to-file) Open](${cmd('twinlock.openLocation', [loc.uri.toString(), loc.range.start.line])})`);
        if (result.state === 'pending') {
          md.appendMarkdown(` · [$(check) Acknowledge](${cmd('twinlock.acknowledge', [result.path, result.id])})`);
        }
        return new vscode.Hover(md, toRange(target.target.span));
      }

      const r = blockOnLine(model, doc, pos.line);
      if (r && toRange(r.block.ifSpan).union(r.block.labelSpan ? toRange(r.block.labelSpan) : toRange(r.block.ifSpan)).contains(pos)) {
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
        md.appendMarkdown(`**Twinlock** · ${stateText(r.state)}\n\n`);
        for (const t of r.targets) {
          md.appendMarkdown(`- \`${targetName(model, t, r.path)}\` — ${targetStateText(t, r.state === 'pending')}\n`);
        }
        const inbound = r.block.label !== undefined ? model.inboundFor(r.path, r.block.label).filter((x) => x.block !== r.block) : [];
        if (inbound.length > 0) {
          md.appendMarkdown(`\nReferenced by ${inbound.map((x) => `\`${model.display(x.sourcePath)}${x.block.label ? ':' + x.block.label : ''}\``).join(', ')}\n`);
        }
        if (r.state !== 'clean') {
          md.appendMarkdown(`\n[$(diff) Show changes](${cmd('twinlock.showChanges', [r.path, r.block.ifLine])})`);
        }
        return new vscode.Hover(md);
      }
      return undefined;
    },
  };

  const definition: vscode.DefinitionProvider = {
    provideDefinition(doc, pos) {
      const hit = targetAt(model, doc, pos);
      if (!hit || !isLinkable(hit.target)) {
        return undefined;
      }
      const loc = targetLocation(hit.target);
      const tb = hit.target.targetBlock;
      const link: vscode.LocationLink = {
        originSelectionRange: toRange(hit.target.target.span),
        targetUri: loc.uri,
        targetRange: tb ? new vscode.Range(tb.ifLine, 0, tb.thenEndLine, Number.MAX_SAFE_INTEGER) : new vscode.Range(0, 0, 0, 0),
        targetSelectionRange: tb ? toRange(tb.labelSpan ?? tb.ifSpan) : new vscode.Range(0, 0, 0, 0),
      };
      return [link];
    },
  };

  const references: vscode.ReferenceProvider = {
    provideReferences(doc, pos) {
      const r = model.resultsFor(doc.uri).find((x) => pos.line >= x.block.ifLine && pos.line <= x.block.thenEndLine && (pos.line === x.block.ifLine || pos.line >= x.block.thenLine));
      if (!r) {
        return undefined;
      }
      const locs: vscode.Location[] = [];
      if (r.block.label !== undefined) {
        for (const ref of model.inboundFor(r.path, r.block.label)) {
          if (ref.block !== r.block) {
            locs.push(new vscode.Location(uriOf(ref.sourcePath), toRange(ref.target.span)));
          }
        }
      }
      for (const t of r.targets) {
        if (isLinkable(t)) {
          locs.push(targetLocation(t));
        }
      }
      return locs;
    },
  };

  const actions: vscode.CodeActionProvider = {
    provideCodeActions(doc, _range, ctx) {
      const out: vscode.CodeAction[] = [];
      const seen = new Set<string>();
      for (const d of ctx.diagnostics) {
        if (d.source !== DIAG_SOURCE) {
          continue;
        }
        const code = String(typeof d.code === 'object' ? d.code.value : d.code);
        if (code === Codes.pending) {
          const hit = targetAt(model, doc, d.range.start);
          if (!hit) continue;
          const name = targetName(model, hit.target, hit.result.path, true);
          const open = new vscode.CodeAction(`Open ${name}`, vscode.CodeActionKind.QuickFix);
          const loc = targetLocation(hit.target);
          open.command = { command: 'twinlock.openLocation', title: 'Open', arguments: [loc.uri, loc.range.start.line] };
          open.diagnostics = [d];
          open.isPreferred = true;
          out.push(open);
          const key = `${hit.result.path}#${hit.result.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            const ack = new vscode.CodeAction(`Acknowledge: no change needed in linked code (${blockName(model, hit.result, true)})`, vscode.CodeActionKind.QuickFix);
            ack.command = { command: 'twinlock.acknowledge', title: 'Acknowledge', arguments: [hit.result.path, hit.result.id] };
            ack.diagnostics = [d];
            out.push(ack);
          }
        } else if (code === Codes.incoming) {
          for (const inc of model.incomingFor(doc.uri)) {
            const tb = inc.target.targetBlock;
            const line = tb ? tb.ifLine : 0;
            if (line !== d.range.start.line) continue;
            const key = `${inc.source.path}#${inc.source.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const name = blockName(model, inc.source, true);
            const show = new vscode.CodeAction(`Show what changed in ${name}`, vscode.CodeActionKind.QuickFix);
            show.command = { command: 'twinlock.showChanges', title: 'Show changes', arguments: [inc.source.path, inc.source.block.ifLine] };
            show.diagnostics = [d];
            show.isPreferred = true;
            out.push(show);
            const ack = new vscode.CodeAction(`Acknowledge: this code does not need to change for ${name}`, vscode.CodeActionKind.QuickFix);
            ack.command = { command: 'twinlock.acknowledge', title: 'Acknowledge', arguments: [inc.source.path, inc.source.id] };
            ack.diagnostics = [d];
            out.push(ack);
          }
        }
      }
      return out;
    },
  };

  return [
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerReferenceProvider(SELECTOR, references),
    vscode.languages.registerCodeActionsProvider(SELECTOR, actions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  ];
}
