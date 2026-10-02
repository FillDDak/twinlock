import * as assert from 'assert';
import { Analysis, BlockResult, Engine, EngineHost, FileSnapshot, hashLines, summarize } from '../../core/engine';

type Files = Record<string, { base: string | null; cur?: string }>;

const L = (...xs: string[]) => xs.join('\n') + '\n';

function run(files: Files, opts: Partial<EngineHost> = {}, sources?: string[]): Analysis {
  const map = new Map<string, FileSnapshot>();
  for (const [p, f] of Object.entries(files)) {
    map.set(p, { path: p, baseline: f.base, text: f.cur ?? f.base ?? '' });
  }
  const host: EngineHost = {
    load: (p) => map.get(p),
    rootOf: () => '/r',
    key: (p) => p,
    ...opts,
  };
  return new Engine(host).analyze(sources ?? Object.keys(files));
}

function one(a: Analysis, path: string, id?: string): BlockResult {
  const r = a.results.find((x) => x.path === path && (id === undefined || x.id === id));
  assert.ok(r, `no result for ${path} ${id ?? ''}`);
  return r;
}

const A_BASE = L('top', '// LINT.IfChange(limit)', 'MAX = 10', '// LINT.ThenChange(//b.py:limit)', 'end');
const A_EDIT = L('top', '// LINT.IfChange(limit)', 'MAX = 20', '// LINT.ThenChange(//b.py:limit)', 'end');
const B_BASE = L('# LINT.IfChange(limit)', 'MAX = 10', '# LINT.ThenChange(//a.ts:limit)');
const B_EDIT = L('# LINT.IfChange(limit)', 'MAX = 20', '# LINT.ThenChange(//a.ts:limit)');

describe('engine', () => {
  it('nothing changed -> clean', () => {
    const a = run({ '/r/a.ts': { base: A_BASE }, '/r/b.py': { base: B_BASE } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'clean');
    assert.strictEqual(one(a, '/r/b.py').state, 'clean');
    assert.deepStrictEqual(one(a, '/r/a.ts').targets.map((t) => t.state), ['stale']);
  });

  it('source changed, target not -> pending', () => {
    const a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE } });
    const r = one(a, '/r/a.ts');
    assert.strictEqual(r.state, 'pending');
    assert.strictEqual(r.targets[0].state, 'stale');
    assert.strictEqual(r.targets[0].targetBlock?.label, 'limit');
    // b.py did not change, so it has nothing to demand.
    assert.strictEqual(one(a, '/r/b.py').state, 'clean');
  });

  it('both changed -> synced on both sides', () => {
    const a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE, cur: B_EDIT } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'synced');
    assert.strictEqual(one(a, '/r/b.py').state, 'synced');
    assert.deepStrictEqual(one(a, '/r/a.ts').targets.map((t) => t.state), ['updated']);
  });

  it('change outside the guarded region does not trigger', () => {
    const cur = A_BASE.replace('top', 'TOP').replace('end', 'END');
    const a = run({ '/r/a.ts': { base: A_BASE, cur }, '/r/b.py': { base: B_BASE } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'clean');
  });

  it('editing only directive lines does not trigger', () => {
    const cur = A_BASE.replace('//b.py:limit)', '//b.py:limit, //c.ts)');
    const a = run({ '/r/a.ts': { base: A_BASE, cur }, '/r/b.py': { base: B_BASE }, '/r/c.ts': { base: '' } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'clean');
  });

  it('wrapping existing code in a new block does not trigger', () => {
    const base = L('x', 'MAX = 10', 'y');
    const cur = L('x', '// LINT.IfChange', 'MAX = 10', '// LINT.ThenChange(//b.py)', 'y');
    const a = run({ '/r/a.ts': { base, cur }, '/r/b.py': { base: 'b' } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'clean');
  });

  it('a change in the target outside its label does not count', () => {
    const bCur = B_BASE + 'OTHER = 1\n';
    const a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE, cur: bCur } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
  });

  it('whole-file targets accept any change in the file', () => {
    const src = L('// LINT.IfChange', 'v = 1', '// LINT.ThenChange(//docs/api.md)');
    const srcCur = src.replace('v = 1', 'v = 2');
    let a = run({ '/r/a.ts': { base: src, cur: srcCur }, '/r/docs/api.md': { base: '# API\n' } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
    a = run({ '/r/a.ts': { base: src, cur: srcCur }, '/r/docs/api.md': { base: '# API\n', cur: '# API\nv2\n' } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'synced');
  });

  it('whole-file target that only changed line endings is still stale', () => {
    const src = L('// LINT.IfChange', 'v = 1', '// LINT.ThenChange(//t.txt)');
    const a = run({ '/r/a.ts': { base: src, cur: src.replace('1', '2') }, '/r/t.txt': { base: 'x\ny\n', cur: 'x\r\ny\r\n' } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
  });

  it('missing target file is reported', () => {
    const a = run({ '/r/a.ts': { base: A_BASE } });
    const t = one(a, '/r/a.ts').targets[0];
    assert.strictEqual(t.state, 'missing-file');
    assert.strictEqual(t.resolvedPath, '/r/b.py');
    assert.strictEqual(summarize(a.results).broken, 1);
  });

  it('missing target label is reported', () => {
    const a = run({ '/r/a.ts': { base: A_BASE }, '/r/b.py': { base: 'nothing here\n' } });
    assert.strictEqual(one(a, '/r/a.ts').targets[0].state, 'missing-label');
  });

  it('broken targets do not count as stale (block can still be synced)', () => {
    const src = L('// LINT.IfChange', 'v', '// LINT.ThenChange(//gone.ts, //b.txt)');
    const a = run({ '/r/a.ts': { base: src, cur: src.replace('v', 'w') }, '/r/b.txt': { base: '1', cur: '2' } });
    const r = one(a, '/r/a.ts');
    assert.deepStrictEqual(r.targets.map((t) => t.state), ['missing-file', 'updated']);
    assert.strictEqual(r.state, 'synced');
  });

  it('a new file (no baseline) counts as fully changed', () => {
    const a = run({ '/r/a.ts': { base: null, cur: A_BASE }, '/r/b.py': { base: null, cur: B_BASE } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'synced');
  });

  it('new source file with old target is pending', () => {
    const a = run({ '/r/a.ts': { base: null, cur: A_BASE }, '/r/b.py': { base: B_BASE } });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
  });

  it('same-file label targets', () => {
    const base = L(
      '// LINT.IfChange(enc)', 'encode()', '// LINT.ThenChange(:dec)',
      '// LINT.IfChange(dec)', 'decode()', '// LINT.ThenChange(:enc)',
    );
    let a = run({ '/r/a.ts': { base, cur: base.replace('encode()', 'encode2()') } });
    assert.strictEqual(one(a, '/r/a.ts', 'enc').state, 'pending');
    assert.strictEqual(one(a, '/r/a.ts', 'dec').state, 'clean');
    a = run({ '/r/a.ts': { base, cur: base.replace('encode()', 'encode2()').replace('decode()', 'decode2()') } });
    assert.strictEqual(one(a, '/r/a.ts', 'enc').state, 'synced');
    assert.strictEqual(one(a, '/r/a.ts', 'dec').state, 'synced');
  });

  it('a block that targets itself is flagged as self', () => {
    const base = L('// LINT.IfChange(x)', 'v', '// LINT.ThenChange(:x)');
    const a = run({ '/r/a.ts': { base, cur: base.replace('v', 'w') } });
    const r = one(a, '/r/a.ts');
    assert.strictEqual(r.targets[0].state, 'self');
    assert.strictEqual(r.state, 'synced');
  });

  it('a whole-file reference to its own file is flagged as self', () => {
    const base = L('// LINT.IfChange', 'v', '// LINT.ThenChange(//a.ts)');
    const a = run({ '/r/a.ts': { base } });
    assert.strictEqual(one(a, '/r/a.ts').targets[0].state, 'self');
  });

  it('acknowledged blocks are not pending until their content changes again', () => {
    const acks = new Map<string, string>();
    const isAcknowledged = (p: string, id: string, h: string) => acks.get(`${p}#${id}`) === h;
    let a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE } }, { isAcknowledged });
    const r = one(a, '/r/a.ts');
    assert.strictEqual(r.state, 'pending');
    acks.set('/r/a.ts#limit', r.contentHash);
    a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE } }, { isAcknowledged });
    assert.strictEqual(one(a, '/r/a.ts').state, 'acknowledged');
    const again = A_EDIT.replace('20', '30');
    a = run({ '/r/a.ts': { base: A_BASE, cur: again }, '/r/b.py': { base: B_BASE } }, { isAcknowledged });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
  });

  it('assigns ids: labels or ordinal of unlabeled blocks', () => {
    const base = L(
      '// LINT.IfChange', '1', '// LINT.ThenChange(//t)',
      '// LINT.IfChange(named)', '2', '// LINT.ThenChange(//t)',
      '// LINT.IfChange', '3', '// LINT.ThenChange(//t)',
    );
    const a = run({ '/r/a.ts': { base }, '/r/t': { base: '' } });
    assert.deepStrictEqual(a.results.map((r) => r.id), ['#1', 'named', '#2']);
  });

  it('nested blocks are evaluated independently', () => {
    const base = L(
      '// LINT.IfChange(outer)', 'o1',
      '// LINT.IfChange(inner)', 'i1', '// LINT.ThenChange(//i.txt)',
      'o2', '// LINT.ThenChange(//o.txt)',
    );
    let a = run({ '/r/a.ts': { base, cur: base.replace('o2', 'O2') }, '/r/i.txt': { base: '' }, '/r/o.txt': { base: '' } });
    assert.strictEqual(one(a, '/r/a.ts', 'outer').state, 'pending');
    assert.strictEqual(one(a, '/r/a.ts', 'inner').state, 'clean');
    a = run({ '/r/a.ts': { base, cur: base.replace('i1', 'I1') }, '/r/i.txt': { base: '' }, '/r/o.txt': { base: '' } });
    assert.strictEqual(one(a, '/r/a.ts', 'outer').state, 'pending');
    assert.strictEqual(one(a, '/r/a.ts', 'inner').state, 'pending');
  });

  it('resolves file-relative paths before root fallback', () => {
    const src = L('// LINT.IfChange', 'v', '// LINT.ThenChange(b.ts)');
    const a = run({
      '/r/sub/a.ts': { base: src },
      '/r/sub/b.ts': { base: 'near' },
      '/r/b.ts': { base: 'root' },
    }, {}, ['/r/sub/a.ts']);
    assert.strictEqual(one(a, '/r/sub/a.ts').targets[0].resolvedPath, '/r/sub/b.ts');
  });

  it('falls back to root-relative for bare paths', () => {
    const src = L('// LINT.IfChange', 'v', '// LINT.ThenChange(lib/b.ts)');
    const a = run({ '/r/sub/a.ts': { base: src }, '/r/lib/b.ts': { base: 'x' } }, {}, ['/r/sub/a.ts']);
    assert.strictEqual(one(a, '/r/sub/a.ts').targets[0].state, 'stale');
    assert.strictEqual(one(a, '/r/sub/a.ts').targets[0].resolvedPath, '/r/lib/b.ts');
  });

  it('respects rootFallback=false', () => {
    const src = L('// LINT.IfChange', 'v', '// LINT.ThenChange(lib/b.ts)');
    const a = run({ '/r/sub/a.ts': { base: src }, '/r/lib/b.ts': { base: 'x' } }, { rootFallback: false }, ['/r/sub/a.ts']);
    assert.strictEqual(one(a, '/r/sub/a.ts').targets[0].state, 'missing-file');
  });

  it('builds the inbound index', () => {
    const a = run({ '/r/a.ts': { base: A_BASE }, '/r/b.py': { base: B_BASE } });
    assert.deepStrictEqual(a.inbound.get('/r/b.py#limit')?.map((x) => x.sourcePath), ['/r/a.ts']);
    assert.deepStrictEqual(a.inbound.get('/r/a.ts#limit')?.map((x) => x.sourcePath), ['/r/b.py']);
  });

  it('uses host.key for case-insensitive matching', () => {
    const files: Files = { '/r/A.ts': { base: A_BASE.replace('//b.py', '//B.PY') }, '/r/b.py': { base: B_BASE } };
    const lower = new Map(Object.entries(files).map(([p, f]) => [p.toLowerCase(), { path: p, baseline: f.base, text: f.base ?? '' }]));
    const engine = new Engine({ load: (p) => lower.get(p.toLowerCase()), rootOf: () => '/r', key: (p) => p.toLowerCase() });
    const a = engine.analyze(['/r/A.ts', '/r/a.ts']);
    assert.strictEqual(a.results.length, 1, 'same file listed twice is analysed once');
    assert.strictEqual(a.results[0].targets[0].state, 'stale');
  });

  it('supports a custom namespace', () => {
    const base = L('// SYNC.IfChange', 'v', '// SYNC.ThenChange(//t)');
    const a = run({ '/r/a.ts': { base, cur: base.replace('v', 'w') }, '/r/t': { base: '' } }, { namespace: 'SYNC' });
    assert.strictEqual(one(a, '/r/a.ts').state, 'pending');
  });

  it('summarize counts states', () => {
    const a = run({ '/r/a.ts': { base: A_BASE, cur: A_EDIT }, '/r/b.py': { base: B_BASE } });
    const s = summarize(a.results);
    assert.strictEqual(s.pending, 1);
    assert.strictEqual(s.clean, 1);
  });

  it('hashLines is stable and content-sensitive', () => {
    assert.strictEqual(hashLines(['a', 'b'], 0, 1), hashLines(['a', 'b'], 0, 1));
    assert.notStrictEqual(hashLines(['a', 'b'], 0, 1), hashLines(['a', 'c'], 0, 1));
    assert.notStrictEqual(hashLines(['ab'], 0, 0), hashLines(['a', 'b'], 0, 1));
    assert.strictEqual(hashLines([], 0, -1).length, 8);
  });

  it('loads each file only once per analysis', () => {
    let loads = 0;
    const files: Record<string, FileSnapshot> = {
      '/r/a.ts': { path: '/r/a.ts', text: A_BASE, baseline: A_BASE },
      '/r/b.py': { path: '/r/b.py', text: B_BASE, baseline: B_BASE },
    };
    const engine = new Engine({ load: (p) => { loads++; return files[p]; }, rootOf: () => '/r', key: (p) => p });
    engine.analyze(['/r/a.ts', '/r/b.py']);
    assert.strictEqual(loads, 2);
  });
});
