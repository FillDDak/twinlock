import * as assert from 'assert';
import { allCommentStyles, commentLine, commentStyleFor, supportsComments } from '../../core/commentSyntax';
import { formatTarget, referencePath, sanitizeLabel, suggestLabel, uniqueLabel, wrapLines } from '../../core/linking';
import { parse } from '../../core/parser';

function apply(lines: string[], ins: { line: number; text: string }[]): string[] {
  const out = lines.slice();
  for (const i of [...ins].sort((a, b) => b.line - a.line)) {
    out.splice(i.line, 0, i.text);
  }
  return out;
}

describe('linking', () => {
  describe('sanitizeLabel', () => {
    const cases: Array<[string, string | undefined]> = [
      ['maxRetries', 'maxRetries'],
      ['max retries', 'max_retries'],
      ['123abc', 'abc'],
      ['__init__', 'init'],
      ['a.b-c', 'a.b-c'],
      ['---', undefined],
      ['', undefined],
      ['한글', undefined],
      ['x'.repeat(100), 'x'.repeat(48)],
      ['trailing-', 'trailing'],
    ];
    for (const [input, out] of cases) {
      it(JSON.stringify(input), () => assert.strictEqual(sanitizeLabel(input), out));
    }
  });

  describe('suggestLabel', () => {
    it('uses the first meaningful identifier in snake_case', () => {
      assert.strictEqual(suggestLabel('export const MaxUploadSize = 10;'), 'max_upload_size');
      assert.strictEqual(suggestLabel('def parse_user(x):'), 'parse_user');
      assert.strictEqual(suggestLabel('HTTPServerConfig'), 'http_server_config');
    });
    it('falls back to "linked"', () => {
      assert.strictEqual(suggestLabel('{ } 1 2'), 'linked');
      assert.strictEqual(suggestLabel(''), 'linked');
    });
    it('avoids taken labels', () => {
      assert.strictEqual(suggestLabel('const fooBar = 1', new Set(['foo_bar'])), 'foo_bar_2');
      assert.strictEqual(uniqueLabel('a', new Set(['a', 'a_2'])), 'a_3');
    });
  });

  describe('referencePath', () => {
    it('uses // for files under the same root', () => {
      assert.strictEqual(referencePath('/r/a/x.ts', '/r/b/y.py', '/r', false), '//b/y.py');
    });
    it('uses relative paths when the target is outside the root', () => {
      assert.strictEqual(referencePath('/r/a/x.ts', '/other/y.py', '/r', false), '../../other/y.py');
    });
    it('handles case-insensitive roots', () => {
      assert.strictEqual(referencePath('c:/R/a.ts', 'c:/r/B.ts', 'c:/r', true), '//B.ts');
    });
    it('falls back to absolute across drives', () => {
      assert.strictEqual(referencePath('c:/r/a.ts', 'd:/x/b.ts', 'c:/r', true), 'd:/x/b.ts');
    });
    it('uses ./ for siblings outside the root', () => {
      assert.strictEqual(referencePath('/x/a.ts', '/x/b.ts', '/r', false), './b.ts');
    });
  });

  it('formatTarget', () => {
    assert.strictEqual(formatTarget('//a.ts', 'l'), '//a.ts:l');
    assert.strictEqual(formatTarget('//a.ts', undefined), '//a.ts');
    assert.strictEqual(formatTarget(undefined, 'l'), ':l');
    assert.strictEqual(formatTarget('//docs/my file.md', 'l'), '"//docs/my file.md:l"');
    assert.strictEqual(formatTarget('//a,b.md', undefined), '"//a,b.md"');
  });

  it('quoted targets with spaces round-trip through the parser', () => {
    const lines = ['x'];
    const ins = wrapLines(lines, 0, 0, { start: '//' }, 'LINT', 'l', [formatTarget('//docs/한글 문서.md', 'kr'), formatTarget('//a,b.md', undefined), '//c.md']);
    const p = parse(apply(lines, ins).join('\n'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.blocks[0].targets.map((t) => [t.path, t.label]), [['//docs/한글 문서.md', 'kr'], ['//a,b.md', undefined], ['//c.md', undefined]]);
  });

  describe('wrapLines', () => {
    it('wraps with the smallest indentation of the range', () => {
      const lines = ['class A {', '    x = 1', '      y = 2', '', '}'];
      const out = apply(lines, wrapLines(lines, 1, 3, { start: '//' }, 'LINT', 'xy', ['//b.ts:xy']));
      assert.deepStrictEqual(out, ['class A {', '    // LINT.IfChange(xy)', '    x = 1', '      y = 2', '', '    // LINT.ThenChange(//b.ts:xy)', '}']);
    });
    it('appends at end of file', () => {
      const lines = ['a'];
      const out = apply(lines, wrapLines(lines, 0, 0, { start: '#' }, 'LINT', undefined, ['x', 'y']));
      assert.deepStrictEqual(out, ['# LINT.IfChange', 'a', '# LINT.ThenChange(x, y)']);
    });
    it('uses block comment closers', () => {
      const lines = ['<p>hi</p>'];
      const out = apply(lines, wrapLines(lines, 0, 0, { start: '<!--', end: '-->' }, 'LINT', 'p', ['//a.ts']));
      assert.deepStrictEqual(out, ['<!-- LINT.IfChange(p) -->', '<p>hi</p>', '<!-- LINT.ThenChange(//a.ts) -->']);
    });
  });

  describe('every written comment style round-trips through the parser', () => {
    for (const { id, style } of allCommentStyles()) {
      it(id, () => {
        const lines = ['  value = 1', '  other = 2'];
        const out = apply(lines, wrapLines(lines, 0, 1, style, 'LINT', 'my.label-1', ['//dir/file.ext:other', ':same']));
        const p = parse(out.join('\n'));
        assert.deepStrictEqual(p.errors, [], out.join('\n'));
        assert.strictEqual(p.blocks.length, 1);
        assert.strictEqual(p.blocks[0].label, 'my.label-1');
        assert.strictEqual(p.blocks[0].contentStart, 1);
        assert.strictEqual(p.blocks[0].contentEnd, 2);
        assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//dir/file.ext:other', ':same']);
      });
    }
  });

  describe('commentStyleFor', () => {
    it('by language', () => {
      assert.deepStrictEqual(commentStyleFor('python', 'x.py'), { start: '#' });
      assert.deepStrictEqual(commentStyleFor('html', 'x.html'), { start: '<!--', end: '-->' });
    });
    it('by extension when the language is unknown', () => {
      assert.deepStrictEqual(commentStyleFor('plaintext', '/a/b.yaml'), { start: '#' });
      assert.deepStrictEqual(commentStyleFor('unknown', 'C:\\a\\b.SQL'), { start: '--' });
    });
    it('defaults to //', () => {
      assert.deepStrictEqual(commentStyleFor('unknown', 'file'), { start: '//' });
    });
    it('honours overrides', () => {
      assert.deepStrictEqual(commentStyleFor('python', 'x.py', { python: '##' }), { start: '##' });
      assert.deepStrictEqual(commentStyleFor('foo', 'x', { foo: '<# ... #>' }), { start: '<#', end: '#>' });
      assert.deepStrictEqual(commentStyleFor('python', 'x.py', { python: '  ' }), { start: '#' });
    });
    it('supportsComments', () => {
      assert.strictEqual(supportsComments('json', 'package.json'), false);
      assert.strictEqual(supportsComments('jsonc', 'tsconfig.json'), true);
      assert.strictEqual(supportsComments('plaintext', 'data.csv'), false);
      assert.strictEqual(supportsComments('plaintext', 'notes.txt'), true);
      assert.strictEqual(supportsComments('json', 'x.json', { json: '//' }), true);
      assert.strictEqual(supportsComments('typescript', 'a.ts'), true);
    });
    it('commentLine', () => {
      assert.strictEqual(commentLine({ start: '//' }, '\t', 'X'), '\t// X');
      assert.strictEqual(commentLine({ start: '/*', end: '*/' }, '', 'X'), '/* X */');
    });
  });
});
