import * as assert from 'assert';
import { GlobSet, globToRegExp } from '../../core/glob';

describe('glob', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/node_modules/**', 'node_modules/a/b.js', true],
    ['**/node_modules/**', 'x/node_modules/a.js', true],
    ['**/node_modules/**', 'x/node_modules', true],
    ['**/node_modules/**', 'x/node_modulesx/a.js', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'a/b/c.ts', true],
    ['**/*.ts', 'a/b/c.tsx', false],
    ['*.ts', 'a/b.ts', false],
    ['*.ts', 'b.ts', true],
    ['src/**', 'src/a/b', true],
    ['src/**', 'srcx/a', false],
    ['**/{dist,out}/**', 'pkg/dist/x.js', true],
    ['**/{dist,out}/**', 'pkg/out/x.js', true],
    ['**/{dist,out}/**', 'pkg/build/x.js', false],
    ['file?.txt', 'file1.txt', true],
    ['file?.txt', 'file12.txt', false],
    ['[ab].txt', 'a.txt', true],
    ['[!ab].txt', 'a.txt', false],
    ['[!ab].txt', 'c.txt', true],
    ['a.b', 'axb', false],
    ['**', 'anything/at/all', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x/y/c', false],
    ['**/.git/**', '.git/HEAD', true],
    ['foo**bar', 'fooXbar', true],
  ];
  for (const [g, p, expected] of cases) {
    it(`${g} ${expected ? 'matches' : 'does not match'} ${p}`, () => {
      assert.strictEqual(globToRegExp(g).test(p), expected);
    });
  }

  it('supports case-insensitive matching', () => {
    assert.strictEqual(new GlobSet(['**/Node_Modules/**'], true).matches('a/node_modules/b'), true);
    assert.strictEqual(new GlobSet(['**/Node_Modules/**'], false).matches('a/node_modules/b'), false);
  });

  it('normalises backslashes in patterns', () => {
    assert.strictEqual(globToRegExp('**\\dist\\**').test('a/dist/b'), true);
  });

  it('an empty GlobSet matches nothing', () => {
    assert.strictEqual(new GlobSet([]).matches('a'), false);
  });
});
