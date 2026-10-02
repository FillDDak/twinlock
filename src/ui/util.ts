import * as vscode from 'vscode';
import { BlockResult, TargetResult } from '../core/engine';
import { Block, Span } from '../core/parser';
import { basename } from '../core/paths';
import { TwinlockModel, uriOf } from '../model';

export function toRange(span: Span): vscode.Range {
  return new vscode.Range(span.start.line, span.start.character, span.end.line, span.end.character);
}

/** Range of the whole guarded block, directive lines included. */
export function blockRange(block: Block): vscode.Range {
  return new vscode.Range(block.ifLine, 0, block.thenEndLine, Number.MAX_SAFE_INTEGER);
}

/** Short human name for a block: `file.ts:label` or `file.ts (line 12)`. */
export function blockName(model: TwinlockModel, r: BlockResult, short = false): string {
  const file = short ? basename(r.path) : model.display(r.path);
  return r.block.label ? `${file}:${r.block.label}` : `${file} (line ${r.block.ifLine + 1})`;
}

export function targetName(model: TwinlockModel, t: TargetResult, from: string, short = false): string {
  const file = short ? basename(t.resolvedPath) : model.display(t.resolvedPath, from);
  return t.target.label !== undefined ? `${file}:${t.target.label}` : file;
}

/** Where to jump for a target: its labeled block, or the top of the file. */
export function targetLocation(t: TargetResult): vscode.Location {
  const line = t.targetBlock ? t.targetBlock.ifLine : 0;
  const ch = t.targetBlock ? t.targetBlock.ifSpan.start.character : 0;
  return new vscode.Location(uriOf(t.resolvedPath), new vscode.Position(line, ch));
}

export function blockLocation(r: BlockResult): vscode.Location {
  return new vscode.Location(uriOf(r.path), toRange(r.block.ifSpan));
}

export function isLinkable(t: TargetResult): boolean {
  return t.state !== 'missing-file';
}

export const STATE_ICON: Record<string, string> = {
  pending: 'warning',
  synced: 'pass',
  acknowledged: 'check-all',
  clean: 'link',
  updated: 'pass',
  stale: 'circle-large-outline',
  'missing-file': 'error',
  'missing-label': 'error',
  self: 'info',
};

export function targetStateText(t: TargetResult, sourceChanged = true): string {
  switch (t.state) {
    case 'updated':
      return 'updated';
    case 'stale':
      return sourceChanged ? 'not updated yet' : 'unchanged';
    case 'missing-file':
      return 'file not found';
    case 'missing-label':
      return 'label not found';
    case 'self':
      return 'refers to itself';
  }
}

/** Find the block result whose range contains `line` (innermost wins). */
export function resultAt(model: TwinlockModel, uri: vscode.Uri, line: number): BlockResult | undefined {
  let best: BlockResult | undefined;
  for (const r of model.resultsFor(uri)) {
    if (line >= r.block.ifLine && line <= r.block.thenEndLine) {
      if (!best || r.block.depth > best.block.depth) {
        best = r;
      }
    }
  }
  return best;
}
