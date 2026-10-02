import * as vscode from 'vscode';
import { BlockResult, TargetResult } from '../core/engine';
import { basename } from '../core/paths';
import { TwinlockModel, uriOf } from '../model';
import { blockName, STATE_ICON, targetLocation, targetName, targetStateText } from './util';

type GroupId = 'pending' | 'broken' | 'synced' | 'all';

type Node =
  | { kind: 'group'; id: GroupId; items: BlockResult[] }
  | { kind: 'file'; path: string; items: BlockResult[] }
  | { kind: 'block'; result: BlockResult; group: GroupId }
  | { kind: 'target'; result: BlockResult; target: TargetResult };

const GROUP_LABEL: Record<GroupId, string> = {
  pending: 'Needs update',
  broken: 'Broken links',
  synced: 'Changed together',
  all: 'All linked blocks',
};

const GROUP_ICON: Record<GroupId, vscode.ThemeIcon> = {
  pending: new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
  broken: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
  synced: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  all: new vscode.ThemeIcon('link'),
};

function isBroken(r: BlockResult): boolean {
  return r.targets.some((t) => t.state === 'missing-file' || t.state === 'missing-label');
}

export class LinksTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly model: TwinlockModel) {
    this.view = vscode.window.createTreeView('twinlock.links', { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(this.view, model.onDidChange(() => this.refresh()));
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.emitter.dispose();
  }

  refresh(): void {
    const results = this.model.analysis?.results ?? [];
    const pending = results.filter((r) => r.state === 'pending').length;
    this.view.badge = pending > 0 ? { value: pending, tooltip: `${pending} linked ${pending === 1 ? 'change needs' : 'changes need'} a matching update` } : undefined;
    this.view.message = this.model.isIndexing && results.length === 0 ? 'Indexing workspace…' : undefined;
    void vscode.commands.executeCommand('setContext', 'twinlock.hasLinks', results.length > 0);
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const results = this.model.analysis?.results ?? [];
    if (!node) {
      if (results.length === 0) {
        return [];
      }
      const groups: Node[] = [];
      const pending = results.filter((r) => r.state === 'pending');
      const broken = results.filter(isBroken);
      const synced = results.filter((r) => r.state === 'synced' || r.state === 'acknowledged');
      if (pending.length) groups.push({ kind: 'group', id: 'pending', items: pending });
      if (broken.length) groups.push({ kind: 'group', id: 'broken', items: broken });
      if (synced.length) groups.push({ kind: 'group', id: 'synced', items: synced });
      groups.push({ kind: 'group', id: 'all', items: results });
      return groups;
    }
    switch (node.kind) {
      case 'group': {
        if (node.id !== 'all') {
          return node.items.map((result) => ({ kind: 'block', result, group: node.id }));
        }
        const byFile = new Map<string, { path: string; items: BlockResult[] }>();
        for (const r of node.items) {
          const k = this.model.key(r.path);
          const e = byFile.get(k) ?? { path: r.path, items: [] };
          e.items.push(r);
          byFile.set(k, e);
        }
        return [...byFile.values()]
          .sort((a, b) => this.model.display(a.path).localeCompare(this.model.display(b.path)))
          .map((e) => ({ kind: 'file', path: e.path, items: e.items }));
      }
      case 'file':
        return node.items.map((result) => ({ kind: 'block', result, group: 'all' }));
      case 'block':
        return node.result.targets.map((target) => ({ kind: 'target', result: node.result, target }));
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          GROUP_LABEL[node.id],
          node.id === 'all' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `group:${node.id}`;
        item.description = String(node.items.length);
        item.iconPath = GROUP_ICON[node.id];
        item.contextValue = `group-${node.id}`;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(uriOf(node.path), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `file:${this.model.key(node.path)}`;
        item.description = this.model.display(node.path).replace(/\/[^/]*$/, '') || undefined;
        item.iconPath = vscode.ThemeIcon.File;
        return item;
      }
      case 'block': {
        const r = node.result;
        const label = r.block.label ?? `line ${r.block.ifLine + 1}`;
        const item = new vscode.TreeItem(
          node.group === 'all' ? label : blockName(this.model, r, true),
          r.targets.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : node.group === 'pending' || node.group === 'broken'
              ? vscode.TreeItemCollapsibleState.Expanded // what needs attention is shown right away
              : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `block:${node.group}:${this.model.key(r.path)}#${r.id}`;
        item.description = r.targets.map((t) => targetName(this.model, t, r.path, true)).join(', ');
        item.tooltip = this.blockTooltip(r);
        item.iconPath = new vscode.ThemeIcon(isBroken(r) && node.group === 'broken' ? 'error' : STATE_ICON[r.state], stateColor(r.state));
        item.contextValue = `block-${r.state}`;
        item.command = { command: 'twinlock.openLocation', title: 'Open', arguments: [uriOf(r.path), r.block.ifLine] };
        return item;
      }
      case 'target': {
        const t = node.target;
        const item = new vscode.TreeItem(targetName(this.model, t, node.result.path, true), vscode.TreeItemCollapsibleState.None);
        const pending = node.result.state === 'pending';
        const text = targetStateText(t, pending);
        item.description = text;
        item.tooltip = `${targetName(this.model, t, node.result.path)} — ${text}`;
        item.iconPath = t.state === 'stale' && !pending
          ? new vscode.ThemeIcon('link')
          : new vscode.ThemeIcon(STATE_ICON[t.state], targetColor(t.state));
        item.contextValue = `target-${t.state}`;
        if (t.state !== 'missing-file') {
          const loc = targetLocation(t);
          item.command = { command: 'twinlock.openLocation', title: 'Open', arguments: [loc.uri, loc.range.start.line] };
        }
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }

  private blockTooltip(r: BlockResult): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${blockName(this.model, r)}** — ${stateText(r.state)}\n\n`);
    for (const t of r.targets) {
      md.appendMarkdown(`- \`${targetName(this.model, t, r.path)}\` — ${targetStateText(t, r.state === 'pending')}\n`);
    }
    md.appendMarkdown(`\n_${basename(r.path)}, lines ${r.block.ifLine + 1}–${r.block.thenEndLine + 1}_`);
    return md;
  }
}

export function stateText(s: BlockResult['state']): string {
  switch (s) {
    case 'pending':
      return 'changed; linked code still needs updating';
    case 'synced':
      return 'changed together with all linked code';
    case 'acknowledged':
      return 'changed; acknowledged as needing no linked update';
    default:
      return 'unchanged';
  }
}

function stateColor(s: BlockResult['state']): vscode.ThemeColor | undefined {
  switch (s) {
    case 'pending':
      return new vscode.ThemeColor('list.warningForeground');
    case 'synced':
    case 'acknowledged':
      return new vscode.ThemeColor('testing.iconPassed');
    default:
      return undefined;
  }
}

function targetColor(s: TargetResult['state']): vscode.ThemeColor | undefined {
  switch (s) {
    case 'updated':
      return new vscode.ThemeColor('testing.iconPassed');
    case 'stale':
      return new vscode.ThemeColor('list.warningForeground');
    case 'missing-file':
    case 'missing-label':
      return new vscode.ThemeColor('list.errorForeground');
    default:
      return undefined;
  }
}
