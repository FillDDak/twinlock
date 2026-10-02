import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TwinlockApi } from '../../../extension';
import { activate, replaceIn, twinlockCodes, waitFor } from './helpers';

const WS = process.env.TWINLOCK_WORKSPACE!;
const app = (rel: string) => vscode.Uri.file(path.join(WS, 'app', rel));
const docs = (rel: string) => vscode.Uri.file(path.join(WS, 'docs-site', rel));

describe('Twinlock integration (multi-root workspace)', function () {
  this.timeout(60_000);
  let api: TwinlockApi;

  before(async () => {
    api = await activate();
    await waitFor(api, 'both folders indexed', () => api.model.analysis && api.model.analysis.results.length === 2);
  });

  it('indexes both workspace folders', () => {
    assert.strictEqual(vscode.workspace.workspaceFolders?.length, 2);
    assert.strictEqual(api.model.resultsFor(app('src/flags.ts')).length, 1);
    assert.strictEqual(api.model.resultsFor(docs('guide/page.md')).length, 1);
  });

  it('uses git in the repository folder and the session baseline in the plain folder', () => {
    assert.strictEqual(api.model.modeOf(app('src/flags.ts').fsPath), 'git');
    assert.strictEqual(api.model.modeOf(docs('guide/page.md').fsPath), 'session');
  });

  it('resolves // against each file\'s own root and relative paths across roots', () => {
    const flags = api.model.resultsFor(app('src/flags.ts'))[0];
    assert.deepStrictEqual(flags.targets.map((t) => t.state), ['stale', 'stale']);
    assert.strictEqual(path.basename(flags.targets[0].resolvedPath), 'flags.md');
    const page = api.model.resultsFor(docs('guide/page.md'))[0];
    assert.strictEqual(page.targets[0].state, 'stale');
    assert.strictEqual(vscode.Uri.file(page.targets[0].resolvedPath).fsPath.toLowerCase(), docs('flags.md').fsPath.toLowerCase());
  });

  it('reports a cross-root obligation in the other folder', async () => {
    await replaceIn(app('src/flags.ts'), "'beta', ", '');
    await waitFor(api, 'pending', () => api.model.resultsFor(app('src/flags.ts'))[0]?.state === 'pending');
    assert.deepStrictEqual(twinlockCodes(docs('flags.md')), ['needs-update']);
    await replaceIn(docs('flags.md'), '- beta\n', '');
    await replaceIn(app('src/other.ts'), '1', '2');
    await waitFor(api, 'synced', () => api.model.resultsFor(app('src/flags.ts'))[0]?.state === 'synced');
    assert.deepStrictEqual(twinlockCodes(docs('flags.md')), []);
  });

  it('a markdown block in the plain folder detects unsaved edits', async () => {
    await replaceIn(docs('guide/page.md'), 'See flags.', 'See the flags.');
    await waitFor(api, 'pending', () => api.model.resultsFor(docs('guide/page.md'))[0]?.state !== 'clean');
  });
});
