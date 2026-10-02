import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TwinlockApi } from '../../../extension';
import { activate, replaceIn, waitFor } from './helpers';

const WS = process.env.TWINLOCK_WORKSPACE!;
const PAIRS = Number(process.env.TWINLOCK_PERF_PAIRS || 1500);

/** Measures the worst event-loop stall while `fn` runs. */
async function maxLag<T>(fn: () => Promise<T>): Promise<{ result: T; lag: number }> {
  let lag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
  }, 10);
  try {
    const result = await fn();
    return { result, lag };
  } finally {
    clearInterval(timer);
  }
}

describe(`Twinlock performance (${PAIRS * 3} files, ${PAIRS * 2} blocks)`, function () {
  this.timeout(300_000);
  let api: TwinlockApi;

  it('indexes and analyses the repository', async () => {
    const start = Date.now();
    api = await activate();
    const { lag } = await maxLag(() => waitFor(api, 'all blocks', () => api.model.analysis && api.model.analysis.results.length === PAIRS * 2, 240_000));
    const ms = Date.now() - start;
    console.log(`      initial index + analysis: ${ms} ms, worst event-loop stall ${lag} ms`);
    assert.ok(api.model.analysis!.results.every((r) => r.state === 'clean'));
  });

  it('re-analyses quickly after an edit', async () => {
    const uri = vscode.Uri.file(path.join(WS, 'pkg7', 'a7.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const timings: number[] = [];
    let worstLag = 0;
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const { lag } = await maxLag(async () => {
        await replaceIn(uri, `V7 = ${7 + i}`, `V7 = ${8 + i}`);
        await waitFor(api, 'pending', () => api.model.resultsFor(uri)[0]?.state === 'pending', 30_000);
      });
      timings.push(Date.now() - start);
      worstLag = Math.max(worstLag, lag);
    }
    console.log(`      edit -> diagnostics: ${timings.join(', ')} ms (worst stall ${worstLag} ms)`);
    assert.ok(Math.min(...timings) < 5000, `analysis too slow: ${timings.join(', ')}`);
  });
});
