import * as vscode from 'vscode';
import { BlockResult } from './core/engine';
import { commentStyleFor, supportsComments } from './core/commentSyntax';
import { splitLines } from './core/lineDiff';
import { formatTarget, LineInsertion, referencePath, suggestLabel, uniqueLabel, wrapLines } from './core/linking';
import { LABEL_PATTERN, parse } from './core/parser';
import { basename } from './core/paths';
import { CASE_INSENSITIVE, keyOf, pathOf, TwinlockModel, uriOf } from './model';
import { StatusBar } from './ui/statusBar';
import { blockName, isLinkable, resultAt, targetLocation, targetName, targetStateText, toRange } from './ui/util';

export const BASELINE_SCHEME = 'twinlock-base';

interface Anchor {
  uri: vscode.Uri;
  first: number;
  last: number;
  version: number;
}

function asUri(x: unknown): vscode.Uri | undefined {
  if (x instanceof vscode.Uri) {
    return x;
  }
  if (typeof x === 'string') {
    return /^[a-z][a-z0-9+.-]+:/i.test(x) && !/^[a-z]:[\\/]/i.test(x) ? vscode.Uri.parse(x) : vscode.Uri.file(x);
  }
  return undefined;
}

/** Tree view items pass their node to context-menu commands. */
function treeResult(x: unknown): BlockResult | undefined {
  const node = x as { kind?: string; result?: BlockResult } | undefined;
  return node && typeof node === 'object' && (node.kind === 'block' || node.kind === 'target') && node.result ? node.result : undefined;
}

/** Whole-line range of a selection; a selection ending at column 0 excludes that line. */
function selectedLines(sel: vscode.Selection): { first: number; last: number } {
  let last = sel.end.line;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    last--;
  }
  return { first: sel.start.line, last };
}

export class Commands implements vscode.Disposable {
  private anchor: Anchor | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly baselineEmitter = new vscode.EventEmitter<vscode.Uri>();

  constructor(
    private readonly model: TwinlockModel,
    private readonly status: StatusBar,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const reg = (id: string, fn: (...args: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    reg('twinlock.openLocation', (u: unknown, line?: number) => this.openLocation(u, line));
    reg('twinlock.pickTarget', (p: string, line: number) => this.pickTarget(p, line));
    reg('twinlock.acknowledge', (p?: unknown, id?: string) => this.acknowledge(p, id));
    reg('twinlock.unacknowledge', (p?: unknown, id?: string) => this.unacknowledge(p, id));
    reg('twinlock.clearAcknowledgements', () => this.clearAcks());
    reg('twinlock.showChanges', (p?: unknown, line?: number) => this.showChanges(p, line));
    reg('twinlock.showReferences', (p: string, line: number) => this.showReferences(p, line));
    reg('twinlock.refresh', () => this.model.rescan());
    reg('twinlock.resetSessionBaseline', () => {
      this.model.resetSessionBaselines();
      void vscode.window.showInformationMessage('Twinlock: files without git history are now compared against their current saved content.');
    });
    reg('twinlock.showLog', () => this.log.show());
    reg('twinlock.focus', () => vscode.commands.executeCommand('twinlock.links.focus'));
    reg('twinlock.nextPending', () => this.nextPending(1));
    reg('twinlock.previousPending', () => this.nextPending(-1));
    reg('twinlock.linkSelection', () => this.linkSelection());
    reg('twinlock.linkSelectionToFile', () => this.linkToFile());
    reg('twinlock.cancelLink', () => this.cancelLink(true));

    this.subs.push(
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
        onDidChange: this.baselineEmitter.event,
        provideTextDocumentContent: (uri) => {
          const path = new URLSearchParams(uri.query).get('path') ?? '';
          return this.model.baselineOf(path) ?? '';
        },
      }),
      model.onDidChange(() => {
        for (const d of vscode.workspace.textDocuments) {
          if (d.uri.scheme === BASELINE_SCHEME) {
            this.baselineEmitter.fire(d.uri);
          }
        }
      }),
    );
    void vscode.commands.executeCommand('setContext', 'twinlock.linking', false);
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.baselineEmitter.dispose();
  }

  // ------------------------------------------------------------------ navigation

  async openLocation(u: unknown, line = 0): Promise<void> {
    const uri = asUri(u);
    if (!uri) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = doc.validatePosition(new vscode.Position(Number(line) || 0, 0));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  }

  private findResult(p: unknown, idOrLine?: string | number): BlockResult | undefined {
    const fromTree = treeResult(p);
    if (fromTree) {
      // Re-resolve: the tree node may be older than the latest analysis.
      return this.model.resultsFor(uriOf(fromTree.path)).find((r) => r.id === fromTree.id) ?? fromTree;
    }
    const uri = asUri(p) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return undefined;
    }
    if (typeof idOrLine === 'string') {
      return this.model.resultsFor(uri).find((r) => r.id === idOrLine);
    }
    const line = typeof idOrLine === 'number' ? idOrLine : vscode.window.activeTextEditor?.selection.active.line ?? 0;
    return resultAt(this.model, uri, line);
  }

  private async pickTarget(p: string, line: number): Promise<void> {
    const r = this.findResult(p, line);
    if (!r) {
      return;
    }
    const items = r.targets.filter(isLinkable).map((t) => ({
      label: targetName(this.model, t, r.path),
      description: targetStateText(t, r.state === 'pending'),
      t,
    }));
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: `Linked targets of ${blockName(this.model, r)}` });
    if (pick) {
      const loc = targetLocation(pick.t);
      await this.openLocation(loc.uri, loc.range.start.line);
    }
  }

  private async showReferences(p: string, line: number): Promise<void> {
    const r = this.findResult(p, line);
    if (!r || r.block.label === undefined) {
      return;
    }
    const locs = this.model
      .inboundFor(r.path, r.block.label)
      .filter((x) => x.block !== r.block)
      .map((x) => new vscode.Location(uriOf(x.sourcePath), toRange(x.target.span)));
    await vscode.commands.executeCommand('editor.action.showReferences', uriOf(r.path), new vscode.Position(r.block.ifLine, r.block.ifSpan.start.character), locs);
  }

  private async nextPending(dir: 1 | -1): Promise<void> {
    await this.model.whenIdle();
    const items: Array<{ path: string; line: number }> = [];
    for (const r of this.model.analysis?.results ?? []) {
      if (r.state === 'pending') {
        items.push({ path: r.path, line: r.block.ifLine });
        for (const t of r.targets) {
          if (t.state === 'stale') {
            items.push({ path: t.resolvedPath, line: t.targetBlock?.ifLine ?? 0 });
          }
        }
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Twinlock: nothing to sync. 🎉');
      return;
    }
    const unique = [...new Map(items.map((i) => [`${keyOf(i.path)}:${i.line}`, i])).values()];
    unique.sort((a, b) => keyOf(a.path).localeCompare(keyOf(b.path)) || a.line - b.line);
    const ed = vscode.window.activeTextEditor;
    const curKey = ed ? keyOf(pathOf(ed.document.uri)) : '';
    const curLine = ed?.selection.active.line ?? -1;
    const cmp = (i: { path: string; line: number }) => keyOf(i.path).localeCompare(curKey) || i.line - curLine;
    const next = dir === 1
      ? unique.find((i) => cmp(i) > 0) ?? unique[0]
      : [...unique].reverse().find((i) => cmp(i) < 0) ?? unique[unique.length - 1];
    await this.openLocation(uriOf(next.path), next.line);
  }

  // ------------------------------------------------------------- acknowledgements

  private async acknowledge(p?: unknown, id?: string): Promise<void> {
    await this.model.whenIdle();
    const r = this.findResult(p, id);
    if (!r) {
      void vscode.window.showWarningMessage('Twinlock: place the cursor inside a linked block to acknowledge it.');
      return;
    }
    if (r.state !== 'pending') {
      void vscode.window.showInformationMessage(`Twinlock: ${blockName(this.model, r)} has nothing to acknowledge.`);
      return;
    }
    await this.model.acknowledge(r);
    await this.model.whenIdle();
  }

  private async unacknowledge(p?: unknown, id?: string): Promise<void> {
    await this.model.whenIdle();
    const r = this.findResult(p, id);
    if (r) {
      await this.model.unacknowledge(r);
      await this.model.whenIdle();
    }
  }

  private async clearAcks(): Promise<void> {
    const n = await this.model.clearAcknowledgements();
    void vscode.window.showInformationMessage(`Twinlock: cleared ${n} acknowledgement${n === 1 ? '' : 's'}.`);
  }

  // ----------------------------------------------------------------------- diffs

  async showChanges(p?: unknown, line?: number): Promise<void> {
    const fromTree = treeResult(p);
    if (fromTree) {
      p = fromTree.path;
      line = fromTree.block.ifLine;
    }
    const uri = asUri(p) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return;
    }
    await this.model.whenIdle();
    const path = pathOf(uri);
    if (this.model.baselineOf(path) === undefined) {
      void vscode.window.showInformationMessage(`Twinlock: ${basename(path)} is not linked to anything, so it has no baseline to compare with.`);
      return;
    }
    const mode = this.model.modeOf(path);
    const left = vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      path: '/' + basename(path),
      query: new URLSearchParams({ path, t: String(Date.now()) }).toString(),
    });
    const label = mode === 'session' ? 'since session start' : this.model.settings.baseRef;
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (typeof line === 'number') {
      options.selection = new vscode.Range(line, 0, line, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, uri, `${basename(path)} (${label} ↔ working tree)`, options);
  }

  // --------------------------------------------------------------------- linking

  private async linkSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Twinlock: open a file and select the code to link.');
      return;
    }
    if (!this.anchor) {
      if (editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('Twinlock: select the lines that must stay in sync, then run "Link Selection" again.');
        return;
      }
      if (editor.document.isUntitled) {
        void vscode.window.showWarningMessage('Twinlock: save the file before linking it.');
        return;
      }
      if (!this.canHoldDirectives(editor.document)) {
        void vscode.window.showWarningMessage(`Twinlock: ${basename(editor.document.fileName)} cannot contain comments. Start from the other code and link to this file as a whole.`);
        return;
      }
      const { first, last } = selectedLines(editor.selection);
      this.anchor = { uri: editor.document.uri, first, last, version: editor.document.version };
      const where = `${basename(editor.document.fileName)}:${first + 1}–${last + 1}`;
      this.status.setLinking(where);
      void vscode.commands.executeCommand('setContext', 'twinlock.linking', true);
      const choice = await vscode.window.showInformationMessage(
        `Twinlock: linking ${where}. Now select the matching code (in any file) and run "Link Selection" again.`,
        'Pick a File Instead…',
        'Cancel',
      );
      if (choice === 'Cancel') {
        this.cancelLink(false);
      } else if (choice === 'Pick a File Instead…') {
        await this.linkToFile(true);
      }
      return;
    }

    const anchor = this.anchor;
    const docA = await vscode.workspace.openTextDocument(anchor.uri);
    if (docA.version !== anchor.version) {
      this.cancelLink(false);
      void vscode.window.showWarningMessage('Twinlock: the first selection was edited in the meantime. Please start the link again.');
      return;
    }
    const docB = editor.document;
    const noComments = !this.canHoldDirectives(docB);
    if (editor.selection.isEmpty || noComments) {
      if (keyOf(pathOf(docB.uri)) === keyOf(pathOf(docA.uri))) {
        void vscode.window.showWarningMessage('Twinlock: select the counterpart code, or switch to another file to link to it as a whole.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [{ label: `$(file) Link to the whole file ${basename(docB.fileName)}`, id: 'file' }, { label: '$(close) Cancel', id: 'cancel' }],
        { placeHolder: noComments ? `${basename(docB.fileName)} cannot contain comments, so only the whole file can be linked` : 'No code is selected here' },
      );
      if (pick?.id !== 'file') {
        return;
      }
      await this.insertOneSided(docA, anchor.first, anchor.last, docB.uri, undefined);
      this.cancelLink(false);
      return;
    }

    const { first, last } = selectedLines(editor.selection);
    const same = keyOf(pathOf(docA.uri)) === keyOf(pathOf(docB.uri));
    if (same && !(last < anchor.first || first > anchor.last)) {
      void vscode.window.showWarningMessage('Twinlock: the two selections overlap. Select a different part of the file.');
      return;
    }
    await this.insertPair(docA, anchor.first, anchor.last, docB, first, last);
    this.cancelLink(false);
  }

  private canHoldDirectives(doc: vscode.TextDocument): boolean {
    return supportsComments(doc.languageId, doc.fileName, this.model.settings.commentSyntax);
  }

  private cancelLink(announce: boolean): void {
    const had = this.anchor !== undefined;
    this.anchor = undefined;
    this.status.setLinking(undefined);
    void vscode.commands.executeCommand('setContext', 'twinlock.linking', false);
    if (announce && had) {
      void vscode.window.setStatusBarMessage('Twinlock: link cancelled', 2500);
    }
  }

  private labelsIn(doc: vscode.TextDocument): Set<string> {
    return new Set(parse(doc.getText(), this.model.settings.namespace).labels.keys());
  }

  private async askLabel(suggestion: string, taken: Set<string>, prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: 'Twinlock: Link Code',
      prompt,
      value: suggestion,
      valueSelection: [0, suggestion.length],
      validateInput: (v) => {
        const s = v.trim();
        if (!LABEL_PATTERN.test(s)) {
          return 'Start with a letter; use letters, digits, "_", "-" or "."';
        }
        if (taken.has(s)) {
          return `"${s}" is already used in this file`;
        }
        return undefined;
      },
    }).then((v) => v?.trim());
  }

  private refPath(from: vscode.Uri, to: vscode.Uri): string {
    const a = pathOf(from);
    const b = pathOf(to);
    if (keyOf(a) === keyOf(b)) {
      return '';
    }
    return referencePath(a, b, this.model.rootOf(a), CASE_INSENSITIVE);
  }

  private insertionsFor(doc: vscode.TextDocument, first: number, last: number, label: string | undefined, targets: string[]): LineInsertion[] {
    const style = commentStyleFor(doc.languageId, doc.fileName, this.model.settings.commentSyntax);
    return wrapLines(splitLines(doc.getText()), first, last, style, this.model.settings.namespace, label, targets);
  }

  private addInsertions(edit: vscode.WorkspaceEdit, doc: vscode.TextDocument, ins: LineInsertion[]): void {
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    for (const i of ins) {
      if (i.line >= doc.lineCount) {
        // Append after the last line.
        const end = doc.lineAt(doc.lineCount - 1).range.end;
        edit.insert(doc.uri, end, eol + i.text);
      } else {
        edit.insert(doc.uri, new vscode.Position(i.line, 0), i.text + eol);
      }
    }
  }

  private async insertPair(docA: vscode.TextDocument, a1: number, a2: number, docB: vscode.TextDocument, b1: number, b2: number): Promise<void> {
    const same = keyOf(pathOf(docA.uri)) === keyOf(pathOf(docB.uri));
    const takenA = this.labelsIn(docA);
    const takenB = same ? takenA : this.labelsIn(docB);
    const textA = docA.getText(new vscode.Range(a1, 0, a2 + 1, 0));
    const both = new Set([...takenA, ...takenB]);
    const suggested = suggestLabel(textA, both);
    const label = await this.askLabel(suggested, both, same ? 'Label for the first block (the second gets a numbered variant)' : 'Label for the linked blocks (used in both files)');
    if (!label) {
      return;
    }
    const labelA = label;
    const labelB = same ? uniqueLabel(label, new Set([...both, label])) : label;
    const pathAtoB = this.refPath(docA.uri, docB.uri);
    const pathBtoA = this.refPath(docB.uri, docA.uri);
    const edit = new vscode.WorkspaceEdit();
    // Links are always two-way: a label can only exist on a block, and every
    // block names what must change with it.
    const insA = this.insertionsFor(docA, a1, a2, labelA, [formatTarget(pathAtoB || undefined, labelB)]);
    const insB = this.insertionsFor(docB, b1, b2, labelB, [formatTarget(pathBtoA || undefined, labelA)]);
    if (same) {
      // Apply bottom-up in one document so positions stay valid.
      // At the same line, close the earlier block before opening the next one.
      const isClose = (i: LineInsertion) => i === insA[1] || i === insB[1];
      const all = [...insA, ...insB].sort((x, y) => x.line - y.line || Number(isClose(y)) - Number(isClose(x)));
      this.addInsertions(edit, docA, all);
    } else {
      this.addInsertions(edit, docA, insA);
      this.addInsertions(edit, docB, insB);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage('Twinlock: could not insert the link directives.');
      return;
    }
    this.log.info(`Linked ${pathOf(docA.uri)}:${labelA} <-> ${pathOf(docB.uri)}:${labelB}`);
    void vscode.window.setStatusBarMessage(`$(link) Twinlock: linked ${labelA} ⇄ ${labelB}`, 4000);
    this.model.schedule(0);
  }

  private async insertOneSided(doc: vscode.TextDocument, first: number, last: number, target: vscode.Uri, targetLabel: string | undefined): Promise<void> {
    const taken = this.labelsIn(doc);
    const suggested = suggestLabel(doc.getText(new vscode.Range(first, 0, last + 1, 0)), taken);
    const label = await this.askLabel(suggested, taken, `Label for this block (it will require ${basename(target.fsPath)}${targetLabel ? ':' + targetLabel : ''} to change with it)`);
    if (!label) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const ref = formatTarget(this.refPath(doc.uri, target) || undefined, targetLabel);
    this.addInsertions(edit, doc, this.insertionsFor(doc, first, last, label, [ref || `:${targetLabel}`]));
    if (await vscode.workspace.applyEdit(edit)) {
      void vscode.window.setStatusBarMessage(`$(link) Twinlock: linked ${label} → ${ref}`, 4000);
      this.model.schedule(0);
    }
  }

  private async linkToFile(fromAnchor = false): Promise<void> {
    let doc: vscode.TextDocument;
    let first: number;
    let last: number;
    if (fromAnchor && this.anchor) {
      doc = await vscode.workspace.openTextDocument(this.anchor.uri);
      first = this.anchor.first;
      last = this.anchor.last;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file' || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('Twinlock: select the lines that must stay in sync first.');
        return;
      }
      doc = editor.document;
      ({ first, last } = selectedLines(editor.selection));
      if (!this.canHoldDirectives(doc)) {
        void vscode.window.showWarningMessage(`Twinlock: ${basename(doc.fileName)} cannot contain comments. Start from the other code and link to this file as a whole.`);
        return;
      }
    }
    this.cancelLink(false);

    const exclude = this.model.settings.exclude.length ? `{${this.model.settings.exclude.join(',')}}` : null;
    const files = await vscode.workspace.findFiles('**/*', exclude, 20000);
    const self = keyOf(pathOf(doc.uri));
    const items = files
      .filter((u) => keyOf(pathOf(u)) !== self)
      .map((u) => ({ label: basename(u.fsPath), description: vscode.workspace.asRelativePath(u, true), uri: u }))
      .sort((a, b) => a.description.localeCompare(b.description));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'File that must change together with the selected code', matchOnDescription: true });
    if (!picked) {
      return;
    }
    const targetDoc = await vscode.workspace.openTextDocument(picked.uri);
    const labels = [...parse(targetDoc.getText(), this.model.settings.namespace).labels.values()];
    let label: string | undefined;
    if (labels.length > 0) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(file) Whole file', description: 'Any change in the file counts', value: undefined as string | undefined },
          ...labels.map((b) => ({ label: `$(symbol-key) ${b.label}`, description: `line ${b.ifLine + 1}`, value: b.label })),
        ],
        { placeHolder: `Link to the whole file or to a labeled block in ${picked.label}` },
      );
      if (!choice) {
        return;
      }
      label = choice.value;
    }
    await this.insertOneSided(doc, first, last, picked.uri, label);
  }
}
