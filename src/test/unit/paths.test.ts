import * as assert from 'assert';
import { basename, dirname, displayPath, join, normalize, relativeTo, targetCandidates } from '../../core/paths';

describe('paths', () => {
  describe('normalize', () => {
    const cases: Array<[string, string]> = [
      ['/a/b/../c', '/a/c'],
      ['/a//b/./c/', '/a/b/c'],
      ['C:\\Users\\x\\..\\y', 'c:/Users/y'],
      ['c:/a/b', 'c:/a/b'],
      ['D:', 'd:/'],
      ['/..', '/'],
      ['a/../../b', '../b'],
      ['\\\\server\\share\\x', '//server/share/x'],
      ['/', '/'],
    ];
    for (const [input, out] of cases) {
      it(`${input} -> ${out}`, () => assert.strictEqual(normalize(input), out));
    }
  });

  it('join', () => {
    assert.strictEqual(join('/r', 'a/b'), '/r/a/b');
    assert.strictEqual(join('/r/', '../x'), '/x');
    assert.strictEqual(join('c:\\r', 'a\\b'), 'c:/r/a/b');
  });

  it('dirname / basename', () => {
    assert.strictEqual(dirname('/a/b/c.ts'), '/a/b');
    assert.strictEqual(dirname('/c.ts'), '/');
    assert.strictEqual(dirname('c:/c.ts'), 'c:/');
    assert.strictEqual(dirname('c:/x/c.ts'), 'c:/x');
    assert.strictEqual(basename('/a/b/c.ts'), 'c.ts');
  });

  it('relativeTo', () => {
    assert.strictEqual(relativeTo('/r', '/r/a/b', false), 'a/b');
    assert.strictEqual(relativeTo('/r/', '/r/a', false), 'a');
    assert.strictEqual(relativeTo('/r', '/r', false), '');
    assert.strictEqual(relativeTo('/r', '/rx/a', false), undefined);
    assert.strictEqual(relativeTo('c:/R', 'C:/r/A', true), 'A');
    assert.strictEqual(relativeTo('/R', '/r/a', false), undefined);
  });

  describe('targetCandidates', () => {
    const src = '/repo/src/app/a.ts';
    it('root-relative //', () => {
      assert.deepStrictEqual(targetCandidates('//lib/b.ts', src, '/repo'), ['/repo/lib/b.ts']);
    });
    it('single slash: root first, then absolute', () => {
      assert.deepStrictEqual(targetCandidates('/lib/b.ts', src, '/repo'), ['/repo/lib/b.ts', '/lib/b.ts']);
    });
    it('bare: file-relative, then root-relative', () => {
      assert.deepStrictEqual(targetCandidates('b.ts', src, '/repo'), ['/repo/src/app/b.ts', '/repo/b.ts']);
      assert.deepStrictEqual(targetCandidates('lib/b.ts', src, '/repo'), ['/repo/src/app/lib/b.ts', '/repo/lib/b.ts']);
    });
    it('bare without root fallback', () => {
      assert.deepStrictEqual(targetCandidates('b.ts', src, '/repo', false), ['/repo/src/app/b.ts']);
    });
    it('explicit ./ and ../ are file-relative only', () => {
      assert.deepStrictEqual(targetCandidates('./b.ts', src, '/repo'), ['/repo/src/app/b.ts']);
      assert.deepStrictEqual(targetCandidates('../b.ts', src, '/repo'), ['/repo/src/b.ts']);
    });
    it('windows absolute', () => {
      assert.deepStrictEqual(targetCandidates('D:\\x\\y.ts', 'c:/repo/a.ts', 'c:/repo'), ['d:/x/y.ts']);
    });
    it('windows backslash relative', () => {
      assert.deepStrictEqual(targetCandidates('lib\\b.ts', 'c:/repo/a.ts', 'c:/repo'), ['c:/repo/lib/b.ts']);
    });
    it('deduplicates when file is at root', () => {
      assert.deepStrictEqual(targetCandidates('b.ts', '/repo/a.ts', '/repo'), ['/repo/b.ts']);
    });
  });

  it('displayPath', () => {
    assert.strictEqual(displayPath('/repo/a/b.ts', '/repo', false), '//a/b.ts');
    assert.strictEqual(displayPath('/other/b.ts', '/repo', false), '/other/b.ts');
  });
});
