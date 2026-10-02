import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TwinlockApi } from '../../../extension';
import { activate, replaceIn, twinlockCodes, waitFor } from './helpers';

const SUITE = process.env.TWINLOCK_SUITE!;
const WS = process.env.TWINLOCK_WORKSPACE!;
const file = (rel: string) => vscode.Uri.file(path.join(WS, rel));

/**
 * Environments where git must not (or cannot) be used. The workspace is a
 * real git repository, but Twinlock has to fall back to session baselines.
 */
describe(`Twinlock integration (${SUITE === 'restricted' ? 'Restricted Mode' : 'git executable missing'})`, function () {
  this.timeout(60_000);
  let api: TwinlockApi;

  before(async () => {
    api = await activate();
    await waitFor(api, 'indexed', () => api.model.analysis && api.model.analysis.results.length > 0, 20_000);
  });

  if (SUITE === 'restricted') {
    it('runs in an untrusted workspace', () => {
      assert.strictEqual(vscode.workspace.isTrusted, false);
    });
  }

  it('still finds every linked block (file search instead of git grep)', () => {
    const names = new Set(api.model.analysis!.results.map((r) => path.basename(r.path)));
    for (const n of ['limits.ts', 'limits.py', 'broken.ts']) {
      assert.ok(names.has(n), `${n} missing from ${[...names].join(', ')}`);
    }
  });

  it('falls back to the session baseline', () => {
    assert.strictEqual(api.model.modeOf(file('src/limits.ts').fsPath), 'session');
  });

  it('detects edits and reports both sides', async () => {
    assert.strictEqual(api.model.resultsFor(file('src/limits.ts'))[0].state, 'clean');
    await replaceIn(file('src/limits.ts'), 'maxUploadMb: 10', 'maxUploadMb: 20');
    await waitFor(api, 'pending', () => api.model.resultsFor(file('src/limits.ts'))[0]?.state === 'pending');
    assert.deepStrictEqual(twinlockCodes(file('server/limits.py')), ['needs-update']);
  });

  it('reports broken links', () => {
    assert.deepStrictEqual(twinlockCodes(file('src/broken.ts')), ['missing-file', 'missing-label']);
  });
});
