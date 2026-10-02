import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TwinlockApi } from '../../../extension';

const SUITE = process.env.TWINLOCK_SUITE as 'git' | 'nogit';
const WS = process.env.TWINLOCK_WORKSPACE!;
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8'));
const EXT_ID = `${pkg.publisher}.${pkg.name}`;

let api: TwinlockApi;

const file = (rel: string) => vscode.Uri.file(path.join(WS, rel));

async function idle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  await api.model.whenIdle();
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeout = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    await idle();
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

function twinlockDiags(rel: string): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(file(rel)).filter((d) => d.source === 'Twinlock');
}

function codes(rel: string): string[] {
  return twinlockDiags(rel).map((d) => String(d.code)).sort();
}

function state(rel: string, id: string): string | undefined {
  return api.model.resultsFor(file(rel)).find((r) => r.id === id)?.state;
}

async function open(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  return vscode.window.showTextDocument(doc);
}

async function replace(rel: string, search: string, replacement: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  const text = doc.getText();
  const idx = text.indexOf(search);
  assert.ok(idx >= 0, `"${search}" not found in ${rel}`);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + search.length)), replacement);
  assert.ok(await vscode.workspace.applyEdit(edit));
  return doc;
}

async function revert(rel: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  if (doc.isDirty) {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

async function revertAll(): Promise<void> {
  for (const rel of ['src/limits.ts', 'server/limits.py', 'docs/limits.md', 'src/plain.ts']) {
    await revert(rel);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await idle();
}

describe(`Twinlock integration (${SUITE})`, function () {
  this.timeout(60_000);

  before(async () => {
    const ext = vscode.extensions.getExtension<TwinlockApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    api = await ext.activate();
    await waitFor('initial analysis', () => api.model.analysis && api.model.analysis.results.length > 0);
  });

  afterEach(async () => {
    await revertAll();
  });

  it('indexes every file with directives but skips excluded folders', () => {
    const files = new Set(api.model.analysis!.results.map((r) => path.basename(r.path)));
    const expected = ['broken.ts', 'crlf.ts', 'limits.py', 'limits.ts', '설정 값.ts', '한글 문서.md'];
    if (SUITE === 'nogit') {
      expected.unshift('compiled.js'); // without git there is no .gitignore to honour
    } else {
      expected.unshift('sync.ts'); // found inside the nested repository
    }
    assert.deepStrictEqual([...files].sort(), expected.sort());
  });

  it('contributes a walkthrough whose media files exist', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    const walkthroughs = ext.packageJSON.contributes.walkthroughs as Array<{ id: string; steps: Array<{ media: { markdown?: string; image?: string } }> }>;
    assert.strictEqual(walkthroughs.length, 1);
    for (const step of walkthroughs[0].steps) {
      const media = step.media.markdown ?? step.media.image!;
      assert.ok(fs.existsSync(path.join(ext.extensionPath, media)), `${media} missing`);
    }
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${walkthroughs[0].id}`, false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('uses the expected baseline mode', () => {
    assert.strictEqual(api.model.modeOf(api.model.analysis!.results[0].path), SUITE === 'git' ? 'git' : 'session');
  });

  it('starts clean: no pending updates', () => {
    assert.strictEqual(state('src/limits.ts', 'upload_limit'), 'clean');
    assert.strictEqual(state('server/limits.py', 'upload_limit'), 'clean');
    assert.deepStrictEqual(codes('src/limits.ts'), []);
    assert.deepStrictEqual(codes('server/limits.py'), []);
  });

  it('a CRLF working copy is not reported as changed', () => {
    assert.strictEqual(state('src/crlf.ts', 'crlf'), 'clean');
  });

  it('handles non-ASCII paths with spaces (quoted targets)', async () => {
    const ts = 'src/설정 값.ts';
    const md = 'docs/한글 문서.md';
    assert.strictEqual(state(ts, 'kr'), 'clean');
    assert.strictEqual(state(md, 'kr'), 'clean');
    assert.deepStrictEqual(codes(ts), []);
    assert.deepStrictEqual(api.model.resultsFor(file(ts))[0].targets.map((t) => t.state), ['stale']);
    if (SUITE === 'git') {
      assert.strictEqual(api.model.modeOf(file(ts).fsPath), 'git');
    }
    await replace(ts, '제한 = 10', '제한 = 20');
    await waitFor('pending', () => state(ts, 'kr') === 'pending');
    assert.deepStrictEqual(codes(md), ['needs-update']);
    await replace(md, '10MB', '20MB');
    await waitFor('synced', () => state(ts, 'kr') === 'synced');
    await revert(ts);
    await revert(md);
  });

  it('reports broken links and syntax errors', () => {
    assert.deepStrictEqual(codes('src/broken.ts'), ['missing-file', 'missing-label']);
    assert.deepStrictEqual(codes('src/syntax.ts'), ['unclosed-if']);
    const missing = twinlockDiags('src/broken.ts').find((d) => d.code === 'missing-file')!;
    assert.strictEqual(missing.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(missing.range.start.line, 2);
  });

  it('flags unsaved edits immediately on both sides', async () => {
    await open('src/limits.ts');
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 20');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    assert.deepStrictEqual(codes('src/limits.ts'), ['pending', 'pending']);
    // The obligation is mirrored where the work has to happen.
    assert.deepStrictEqual(codes('server/limits.py'), ['needs-update']);
    assert.deepStrictEqual(codes('docs/limits.md'), ['needs-update']);
    const d = twinlockDiags('server/limits.py')[0];
    assert.strictEqual(d.range.start.line, 0);
    assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Warning);
  });

  it('becomes synced once every target changed too', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 20');
    await replace('server/limits.py', 'MAX_UPLOAD_MB = 10', 'MAX_UPLOAD_MB = 20');
    await waitFor('one target left', () => {
      const r = api.model.resultsFor(file('src/limits.ts'))[0];
      return r.targets.filter((t) => t.state === 'stale').length === 1 && r.state === 'pending';
    });
    await replace('docs/limits.md', '10 MB', '20 MB');
    await waitFor('synced', () => state('src/limits.ts', 'upload_limit') === 'synced');
    assert.strictEqual(state('server/limits.py', 'upload_limit'), 'synced');
    assert.deepStrictEqual(codes('src/limits.ts'), []);
    assert.deepStrictEqual(codes('server/limits.py'), []);
  });

  it('goes back to clean when the edit is undone', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 99');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    await replace('src/limits.ts', 'maxUploadMb: 99', 'maxUploadMb: 10');
    await waitFor('clean', () => state('src/limits.ts', 'upload_limit') === 'clean');
  });

  it('ignores edits outside the guarded block and to directive lines', async () => {
    await replace('src/limits.ts', 'export const LIMITS', 'export const LIMITS_RENAMED');
    await replace('src/limits.ts', '//docs/limits.md)', '//docs/limits.md, //src/plain.ts)');
    await idle();
    assert.strictEqual(state('src/limits.ts', 'upload_limit'), 'clean');
  });

  it('acknowledge silences a pending block until it changes again', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 11');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    const r = api.model.resultsFor(file('src/limits.ts'))[0];
    await vscode.commands.executeCommand('twinlock.acknowledge', r.path, r.id);
    await waitFor('acknowledged', () => state('src/limits.ts', 'upload_limit') === 'acknowledged');
    assert.deepStrictEqual(codes('src/limits.ts'), []);
    assert.deepStrictEqual(codes('server/limits.py'), []);
    await replace('src/limits.ts', 'maxUploadMb: 11', 'maxUploadMb: 12');
    await waitFor('pending again', () => state('src/limits.ts', 'upload_limit') === 'pending');
    await vscode.commands.executeCommand('twinlock.clearAcknowledgements');
  });

  it('acknowledge from the cursor position works without arguments', async () => {
    const editor = await open('src/limits.ts');
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 13');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    editor.selection = new vscode.Selection(2, 3, 2, 3);
    await vscode.commands.executeCommand('twinlock.acknowledge');
    await waitFor('acknowledged', () => state('src/limits.ts', 'upload_limit') === 'acknowledged');
    await vscode.commands.executeCommand('twinlock.unacknowledge');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
  });

  it('provides CodeLenses for state, acknowledge and diff', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 14');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', file('src/limits.ts'));
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.ok(titles.some((t) => t.includes('Update') && t.includes('limits.py:upload_limit')), titles.join(' | '));
    assert.ok(titles.includes('Acknowledge'), titles.join(' | '));
    assert.ok(titles.includes('Diff'), titles.join(' | '));
    assert.ok(titles.some((t) => t.includes('1 reference')), titles.join(' | '));
    const targetLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', file('server/limits.py'));
    assert.ok(targetLenses.some((l) => (l.command?.title ?? '').includes('Needs update')), targetLenses.map((l) => l.command?.title).join(' | '));
  });

  it('go to definition jumps from a target to the labeled block', async () => {
    const doc = await vscode.workspace.openTextDocument(file('src/limits.ts'));
    const line = doc.lineAt(3).text;
    const col = line.indexOf('//server') + 3;
    const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(3, col));
    assert.ok(defs.length >= 1);
    const d = defs[0] as vscode.LocationLink;
    assert.strictEqual(path.basename(d.targetUri.fsPath), 'limits.py');
    assert.strictEqual(d.targetSelectionRange!.start.line, 0);
    assert.strictEqual(d.originSelectionRange!.start.character, line.indexOf('//server'));
  });

  it('hover on a target shows its status and a code preview', async () => {
    const doc = await vscode.workspace.openTextDocument(file('src/limits.ts'));
    const col = doc.lineAt(3).text.indexOf('//server') + 3;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(3, col));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /Twinlock/);
    assert.match(text, /MAX_UPLOAD_MB = 10/);
  });

  it('find references lists who links to a block', async () => {
    const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', file('server/limits.py'), new vscode.Position(0, 5));
    const files = refs.map((r) => path.basename(r.uri.fsPath)).sort();
    assert.deepStrictEqual(files, ['limits.ts', 'limits.ts']);
  });

  it('offers quick fixes for pending diagnostics', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 15');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    const d = twinlockDiags('src/limits.ts')[0];
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file('src/limits.ts'), d.range);
    const titles = actions.map((a) => a.title);
    assert.ok(titles.some((t) => t.startsWith('Open ')), titles.join(' | '));
    assert.ok(titles.some((t) => t.startsWith('Acknowledge')), titles.join(' | '));
    const incoming = twinlockDiags('server/limits.py')[0];
    const actions2 = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file('server/limits.py'), incoming.range);
    assert.ok(actions2.some((a) => a.title.startsWith('Show what changed')), actions2.map((a) => a.title).join(' | '));
  });

  it('the tree view groups pending, broken and all blocks', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 16');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    api.tree.refresh();
    const roots = api.tree.getChildren();
    const labels = roots.map((n) => String(api.tree.getTreeItem(n).label));
    assert.deepStrictEqual(labels, ['Needs update', 'Broken links', 'All linked blocks']);
    const pending = api.tree.getChildren(roots[0]);
    assert.strictEqual(pending.length, 1);
    const targets = api.tree.getChildren(pending[0]);
    assert.strictEqual(targets.length, 2);
  });

  it('tree context actions act on the clicked block, not the active editor', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 21');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    const other = await open('src/crlf.ts');
    other.selection = new vscode.Selection(1, 0, 1, 0);
    api.tree.refresh();
    const pendingGroup = api.tree.getChildren()[0];
    const node = api.tree.getChildren(pendingGroup)[0];
    assert.strictEqual(api.tree.getTreeItem(node).contextValue, 'block-pending');
    await vscode.commands.executeCommand('twinlock.acknowledge', node);
    await waitFor('acknowledged via tree', () => state('src/limits.ts', 'upload_limit') === 'acknowledged');
    await vscode.commands.executeCommand('twinlock.showChanges', node);
    await waitFor('diff of the clicked block', () => vscode.window.activeTextEditor?.document.fileName.endsWith('limits.ts'));
    await vscode.commands.executeCommand('twinlock.clearAcknowledgements');
  });

  it('show changes explains when a file is not linked', async () => {
    const origInfo = vscode.window.showInformationMessage;
    const messages: string[] = [];
    try {
      (vscode.window as any).showInformationMessage = async (m: string) => { messages.push(m); return undefined; };
      await vscode.commands.executeCommand('twinlock.showChanges', path.join(WS, 'src/plain.ts'));
      assert.ok(messages.some((m) => m.includes('not linked')), messages.join(' | '));
    } finally {
      (vscode.window as any).showInformationMessage = origInfo;
    }
  });

  it('show changes opens a diff against the baseline', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 17');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    await vscode.commands.executeCommand('twinlock.showChanges', path.join(WS, 'src/limits.ts'), 2);
    await waitFor('baseline document', () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'twinlock-base'));
    const base = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'twinlock-base')!;
    assert.match(base.getText(), /maxUploadMb: 10/);
  });

  it('next pending navigates between both sides', async () => {
    await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 18');
    await waitFor('pending', () => state('src/limits.ts', 'upload_limit') === 'pending');
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand('twinlock.nextPending');
      seen.add(path.basename(vscode.window.activeTextEditor!.document.fileName));
    }
    assert.deepStrictEqual([...seen].sort(), ['limits.md', 'limits.py', 'limits.ts']);
  });

  it('a missing target disappears from problems once the file is created', async () => {
    const target = path.join(WS, 'missing', 'file.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export {};\n');
    try {
      await waitFor('missing-file resolved', () => !codes('src/broken.ts').includes('missing-file'), 15_000);
      assert.deepStrictEqual(codes('src/broken.ts'), ['missing-label']);
    } finally {
      fs.rmSync(path.join(WS, 'missing'), { recursive: true, force: true });
    }
    await waitFor('missing-file back', () => codes('src/broken.ts').includes('missing-file'), 15_000);
  });

  it('picks up directives typed into a new file and saved files on disk', async () => {
    const rel = 'src/new.ts';
    const p = path.join(WS, rel);
    fs.writeFileSync(p, 'export const n = 1;\n');
    try {
      const doc = await vscode.workspace.openTextDocument(file(rel));
      await vscode.window.showTextDocument(doc);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), '// LINT.IfChange(n)\n');
      edit.insert(doc.uri, new vscode.Position(1, 0), '// LINT.ThenChange(//src/plain.ts)\n');
      await vscode.workspace.applyEdit(edit);
      await waitFor('new block', () => api.model.resultsFor(doc.uri).length === 1);
      // Wrapping existing code is not a change of that code.
      assert.strictEqual(api.model.resultsFor(doc.uri)[0].state, SUITE === 'git' ? 'pending' : 'clean');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await waitFor('block gone after revert', () => api.model.resultsFor(doc.uri).length === 0);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(p, { force: true });
    }
  });

  it('link selection wraps both sides with matching directives', async () => {
    const a = 'src/link-a.ts';
    const b = 'server/link_b.py';
    fs.writeFileSync(path.join(WS, a), 'const before = 0;\nexport const RETRIES = 3;\nconst after = 0;\n');
    fs.writeFileSync(path.join(WS, b), 'x = 1\nRETRIES = 3\n');
    const origInput = vscode.window.showInputBox;
    const origInfo = vscode.window.showInformationMessage;
    try {
      (vscode.window as any).showInputBox = async (o: vscode.InputBoxOptions) => {
        assert.strictEqual(o.value, 'retries');
        assert.strictEqual(await o.validateInput!('1bad'), 'Start with a letter; use letters, digits, "_", "-" or "."');
        return 'retries';
      };
      (vscode.window as any).showInformationMessage = async () => undefined;
      const ea = await open(a);
      ea.selection = new vscode.Selection(1, 0, 2, 0);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      const eb = await open(b);
      eb.selection = new vscode.Selection(1, 0, 1, 11);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      const ta = (await vscode.workspace.openTextDocument(file(a))).getText();
      const tb = (await vscode.workspace.openTextDocument(file(b))).getText();
      assert.strictEqual(ta, 'const before = 0;\n// LINT.IfChange(retries)\nexport const RETRIES = 3;\n// LINT.ThenChange(//server/link_b.py:retries)\nconst after = 0;\n');
      assert.strictEqual(tb, 'x = 1\n# LINT.IfChange(retries)\nRETRIES = 3\n# LINT.ThenChange(//src/link-a.ts:retries)\n');
      await waitFor('linked', () => api.model.resultsFor(file(a)).length === 1 && api.model.resultsFor(file(b)).length === 1);
      const ra = api.model.resultsFor(file(a))[0];
      assert.strictEqual(ra.targets[0].state === 'missing-label' || ra.targets[0].state === 'missing-file', false);
    } finally {
      (vscode.window as any).showInputBox = origInput;
      (vscode.window as any).showInformationMessage = origInfo;
      for (const rel of [a, b]) {
        await revert(rel);
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(WS, a), { force: true });
      fs.rmSync(path.join(WS, b), { force: true });
    }
  });

  it('link selection within one file uses two labels', async () => {
    const a = 'src/same.ts';
    fs.writeFileSync(path.join(WS, a), 'function encode() {}\n\nfunction decode() {}\n');
    const origInput = vscode.window.showInputBox;
    const origInfo = vscode.window.showInformationMessage;
    try {
      (vscode.window as any).showInputBox = async () => 'codec';
      (vscode.window as any).showInformationMessage = async () => undefined;
      const ed = await open(a);
      ed.selection = new vscode.Selection(2, 0, 2, 20);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      ed.selection = new vscode.Selection(0, 0, 0, 20);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      assert.strictEqual(
        ed.document.getText(),
        '// LINT.IfChange(codec_2)\nfunction encode() {}\n// LINT.ThenChange(:codec)\n\n// LINT.IfChange(codec)\nfunction decode() {}\n// LINT.ThenChange(:codec_2)\n',
      );
      await waitFor('two blocks', () => api.model.resultsFor(file(a)).length === 2);
      // Untracked in git = entirely new (so both sides count as updated); otherwise unchanged.
      const expected = SUITE === 'git' ? 'updated' : 'stale';
      assert.deepStrictEqual(api.model.resultsFor(file(a)).flatMap((r) => r.targets.map((t) => t.state)), [expected, expected]);
    } finally {
      (vscode.window as any).showInputBox = origInput;
      (vscode.window as any).showInformationMessage = origInfo;
      await revert(a);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(WS, a), { force: true });
    }
  });

  it('linking to a JSON file (no comments) links the whole file instead', async () => {
    const a = 'src/version.ts';
    const j = 'package.json';
    fs.writeFileSync(path.join(WS, a), 'export const VERSION = "1.0.0";\n');
    fs.writeFileSync(path.join(WS, j), '{\n  "version": "1.0.0"\n}\n');
    const origInput = vscode.window.showInputBox;
    const origInfo = vscode.window.showInformationMessage;
    const origPick = vscode.window.showQuickPick;
    const origWarn = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    try {
      (vscode.window as any).showInputBox = async () => 'version';
      (vscode.window as any).showInformationMessage = async () => undefined;
      (vscode.window as any).showWarningMessage = async (m: string) => { warnings.push(m); return undefined; };
      (vscode.window as any).showQuickPick = async (items: any[]) => items[0];
      // Starting from JSON is refused...
      const ej = await open(j);
      ej.selection = new vscode.Selection(1, 0, 1, 10);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      assert.ok(warnings.some((w) => w.includes('cannot contain comments')), warnings.join(' | '));
      // ...but it can be the whole-file target.
      const ea = await open(a);
      ea.selection = new vscode.Selection(0, 0, 0, 10);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      const ej2 = await open(j);
      ej2.selection = new vscode.Selection(1, 0, 1, 10);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      assert.strictEqual((await vscode.workspace.openTextDocument(file(j))).getText(), '{\n  "version": "1.0.0"\n}\n');
      assert.strictEqual(
        (await vscode.workspace.openTextDocument(file(a))).getText(),
        '// LINT.IfChange(version)\nexport const VERSION = "1.0.0";\n// LINT.ThenChange(//package.json)\n',
      );
    } finally {
      (vscode.window as any).showInputBox = origInput;
      (vscode.window as any).showInformationMessage = origInfo;
      (vscode.window as any).showQuickPick = origPick;
      (vscode.window as any).showWarningMessage = origWarn;
      await revert(a);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(WS, a), { force: true });
      fs.rmSync(path.join(WS, j), { force: true });
    }
  });

  it('cancel link clears the pending anchor', async () => {
    const origInfo = vscode.window.showInformationMessage;
    try {
      (vscode.window as any).showInformationMessage = async () => undefined;
      const ed = await open('src/plain.ts');
      ed.selection = new vscode.Selection(0, 0, 0, 5);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      await vscode.commands.executeCommand('twinlock.cancelLink');
      // A new link now starts from scratch rather than completing the old one.
      ed.selection = new vscode.Selection(0, 0, 0, 5);
      await vscode.commands.executeCommand('twinlock.linkSelection');
      assert.strictEqual(ed.document.isDirty, false);
      await vscode.commands.executeCommand('twinlock.cancelLink');
    } finally {
      (vscode.window as any).showInformationMessage = origInfo;
    }
  });

  it('keeps showing results while a rescan is running', async () => {
    const before = api.model.analysis!.results.length;
    const scan = api.model.rescan();
    assert.strictEqual(api.model.isIndexing, true);
    await api.model.analyzeNow();
    assert.strictEqual(api.model.analysis!.results.length, before, 'results must not drop to zero mid-scan');
    await scan;
    await idle();
    assert.strictEqual(api.model.analysis!.results.length, before);
  });

  it('respects twinlock.pendingSeverity', async () => {
    const cfg = vscode.workspace.getConfiguration('twinlock');
    await cfg.update('pendingSeverity', 'error', vscode.ConfigurationTarget.Workspace);
    try {
      await replace('src/limits.ts', 'maxUploadMb: 10', 'maxUploadMb: 19');
      await waitFor('error severity', () => twinlockDiags('src/limits.ts').some((d) => d.severity === vscode.DiagnosticSeverity.Error && d.code === 'pending'));
    } finally {
      await cfg.update('pendingSeverity', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('a custom directive namespace triggers a rescan', async () => {
    const cfg = vscode.workspace.getConfiguration('twinlock');
    await cfg.update('directiveNamespace', 'SYNC', vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor('no LINT blocks', () => api.model.analysis && api.model.analysis.results.length === 0);
    } finally {
      await cfg.update('directiveNamespace', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await waitFor('LINT blocks back', () => api.model.analysis && api.model.analysis.results.length === 7);
  });

  it('disabling the extension clears everything', async () => {
    const cfg = vscode.workspace.getConfiguration('twinlock');
    await cfg.update('enable', false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor('cleared', () => !api.model.analysis && codes('src/broken.ts').length === 0);
    } finally {
      await cfg.update('enable', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await waitFor('back', () => api.model.analysis && codes('src/broken.ts').length === 2);
  });

  if (SUITE === 'git') {
    it('committing a change moves the baseline', async () => {
      const p = path.join(WS, 'docs/limits.md');
      const original = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, 'Uploads are limited to 25 MB.\n');
      try {
        await waitFor('doc changed', () => api.model.modeOf(p) === 'git' && api.model.baselineOf(p) === original);
        execFileSync('git', ['commit', '-qam', 'docs'], { cwd: WS });
        await vscode.commands.executeCommand('twinlock.refresh');
        await waitFor('baseline moved', () => api.model.baselineOf(p) === 'Uploads are limited to 25 MB.\n');
      } finally {
        fs.writeFileSync(p, original);
        execFileSync('git', ['commit', '-qam', 'restore'], { cwd: WS });
        await vscode.commands.executeCommand('twinlock.refresh');
      }
    });

    it('baseRef can point at an older commit (branch review mode)', async () => {
      // Make a commit that changes the source block only, then compare with HEAD~1.
      const p = path.join(WS, 'src/limits.ts');
      const original = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, original.replace('maxUploadMb: 10', 'maxUploadMb: 50'));
      execFileSync('git', ['commit', '-qam', 'bump'], { cwd: WS });
      const cfg = vscode.workspace.getConfiguration('twinlock');
      try {
        await vscode.commands.executeCommand('twinlock.refresh');
        await waitFor('clean against HEAD', () => state('src/limits.ts', 'upload_limit') === 'clean');
        await cfg.update('baseRef', 'HEAD~1', vscode.ConfigurationTarget.Workspace);
        await waitFor('pending against HEAD~1', () => state('src/limits.ts', 'upload_limit') === 'pending');
        await cfg.update('baseRef', 'does-not-exist', vscode.ConfigurationTarget.Workspace);
        await waitFor('falls back to HEAD', () => state('src/limits.ts', 'upload_limit') === 'clean');
      } finally {
        await cfg.update('baseRef', undefined, vscode.ConfigurationTarget.Workspace);
        fs.writeFileSync(p, original);
        execFileSync('git', ['commit', '-qam', 'restore'], { cwd: WS });
        await vscode.commands.executeCommand('twinlock.refresh');
        await waitFor('clean', () => state('src/limits.ts', 'upload_limit') === 'clean');
      }
    });

    it('git-ignored build output is never indexed, even when it changes', async () => {
      const p = path.join(WS, 'out', 'compiled.js');
      fs.writeFileSync(p, '// LINT.IfChange(compiled)\nexports.x = 2;\n// LINT.ThenChange(//nowhere.js)\n');
      await new Promise((r) => setTimeout(r, 1500));
      await idle();
      assert.strictEqual(api.model.resultsFor(vscode.Uri.file(p)).length, 0);
      assert.deepStrictEqual(codes('out/compiled.js'), []);
    });

    it('a nested repository is compared against its own history and root', async () => {
      const uri = file('vendor/lib/sync.ts');
      assert.strictEqual(api.model.modeOf(uri.fsPath), 'git');
      const r = api.model.resultsFor(uri)[0];
      assert.strictEqual(r.state, 'clean');
      // `//notes.md` resolves against the nested repository root.
      assert.strictEqual(r.targets[0].state, 'stale');
      assert.strictEqual(path.basename(r.targets[0].resolvedPath), 'notes.md');
      await replace('vendor/lib/sync.ts', 'n = 1', 'n = 2');
      await waitFor('nested pending', () => api.model.resultsFor(uri)[0]?.state === 'pending');
      await revert('vendor/lib/sync.ts');
      await waitFor('nested clean', () => api.model.resultsFor(uri)[0]?.state === 'clean');
    });

    it('a clean file in a legacy encoding is not reported as changed', async () => {
      const rel = 'src/latin1.ts';
      const p = path.join(WS, rel);
      // "café" in ISO-8859-1: the é byte (0xE9) is invalid UTF-8.
      fs.writeFileSync(p, Buffer.from('// LINT.IfChange(enc)\nconst s = "caf\xe9";\n// LINT.ThenChange(//docs/limits.md)\n', 'latin1'));
      execFileSync('git', ['add', rel], { cwd: WS });
      execFileSync('git', ['commit', '-qm', 'latin1'], { cwd: WS });
      const cfg = vscode.workspace.getConfiguration('files', file(rel));
      await cfg.update('encoding', 'iso88591', vscode.ConfigurationTarget.Workspace);
      try {
        await vscode.commands.executeCommand('twinlock.refresh');
        const doc = await vscode.workspace.openTextDocument(file(rel));
        await vscode.window.showTextDocument(doc);
        assert.ok(doc.getText().includes('café'), 'document decoded as ISO-8859-1');
        await waitFor('indexed', () => api.model.resultsFor(file(rel)).length === 1, 15_000);
        assert.strictEqual(api.model.resultsFor(file(rel))[0].state, 'clean');
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await cfg.update('encoding', undefined, vscode.ConfigurationTarget.Workspace);
        execFileSync('git', ['rm', '-q', rel], { cwd: WS });
        execFileSync('git', ['commit', '-qm', 'rm latin1'], { cwd: WS });
        await vscode.commands.executeCommand('twinlock.refresh');
      }
    });

    it('an untracked file counts as entirely new', async () => {
      const rel = 'src/untracked.ts';
      fs.writeFileSync(path.join(WS, rel), '// LINT.IfChange\nconst u = 1;\n// LINT.ThenChange(//docs/limits.md)\n');
      try {
        await waitFor('untracked indexed', () => api.model.resultsFor(file(rel)).length === 1, 15_000);
        assert.strictEqual(api.model.resultsFor(file(rel))[0].state, 'pending');
        assert.strictEqual(api.model.baselineOf(path.join(WS, rel)), null);
      } finally {
        fs.rmSync(path.join(WS, rel), { force: true });
      }
      await waitFor('untracked removed', () => api.model.resultsFor(file(rel)).length === 0, 15_000);
    });
  } else {
    it('reset session baseline accepts saved changes', async () => {
      const p = path.join(WS, 'docs/limits.md');
      const original = fs.readFileSync(p, 'utf8');
      const src = path.join(WS, 'src/limits.ts');
      const srcOriginal = fs.readFileSync(src, 'utf8');
      try {
        fs.writeFileSync(src, srcOriginal.replace('maxUploadMb: 10', 'maxUploadMb: 30'));
        await waitFor('pending from disk change', () => state('src/limits.ts', 'upload_limit') === 'pending', 15_000);
        await vscode.commands.executeCommand('twinlock.resetSessionBaseline');
        await waitFor('clean after reset', () => state('src/limits.ts', 'upload_limit') === 'clean');
      } finally {
        fs.writeFileSync(src, srcOriginal);
        fs.writeFileSync(p, original);
        await vscode.commands.executeCommand('twinlock.resetSessionBaseline');
        await waitFor('clean', () => state('src/limits.ts', 'upload_limit') === 'clean');
      }
    });
  }
});
