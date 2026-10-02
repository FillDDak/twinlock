import * as assert from 'assert';
import { mayContainDirectives, parse, splitTarget } from '../../core/parser';

const src = (...xs: string[]) => xs.join('\n');

describe('parser', () => {
  describe('basic blocks', () => {
    it('returns nothing for plain text', () => {
      const p = parse('const x = 1;\n');
      assert.deepStrictEqual(p.blocks, []);
      assert.deepStrictEqual(p.errors, []);
    });

    it('parses an unlabeled block with one target', () => {
      const p = parse(src('// LINT.IfChange', 'a', 'b', '// LINT.ThenChange(//x/y.ts)'));
      assert.strictEqual(p.errors.length, 0);
      assert.strictEqual(p.blocks.length, 1);
      const b = p.blocks[0];
      assert.strictEqual(b.label, undefined);
      assert.strictEqual(b.ifLine, 0);
      assert.strictEqual(b.thenLine, 3);
      assert.strictEqual(b.contentStart, 1);
      assert.strictEqual(b.contentEnd, 2);
      assert.deepStrictEqual(b.targets.map((t) => [t.raw, t.path, t.label]), [['//x/y.ts', '//x/y.ts', undefined]]);
    });

    it('parses labels and label targets', () => {
      const p = parse(src('# LINT.IfChange(limits)', 'X = 1', '# LINT.ThenChange(//a.ts:limits, b.py, :other)'));
      assert.strictEqual(p.errors.length, 0);
      const b = p.blocks[0];
      assert.strictEqual(b.label, 'limits');
      assert.deepStrictEqual(
        b.targets.map((t) => [t.path, t.label]),
        [['//a.ts', 'limits'], ['b.py', undefined], [undefined, 'other']],
      );
      assert.strictEqual(p.labels.get('limits'), b);
    });

    it('records exact spans for label and targets', () => {
      const line2 = '  // LINT.ThenChange(//a.ts:lim,  b.ts)';
      const p = parse(src('  // LINT.IfChange(lim)', 'x', line2));
      const b = p.blocks[0];
      assert.deepStrictEqual(b.labelSpan, { start: { line: 0, character: 19 }, end: { line: 0, character: 22 } });
      assert.deepStrictEqual(b.ifSpan.start, { line: 0, character: 5 });
      const [t1, t2] = b.targets;
      assert.strictEqual(line2.slice(t1.span.start.character, t1.span.end.character), '//a.ts:lim');
      assert.strictEqual(line2.slice(t2.span.start.character, t2.span.end.character), 'b.ts');
    });

    it('allows an empty block', () => {
      const p = parse(src('// LINT.IfChange', '// LINT.ThenChange(a.ts)'));
      assert.strictEqual(p.blocks[0].contentStart, 1);
      assert.strictEqual(p.blocks[0].contentEnd, 0);
    });

    it('treats LINT.IfChange() as unlabeled', () => {
      const p = parse(src('// LINT.IfChange()', 'x', '// LINT.ThenChange(a.ts)'));
      assert.strictEqual(p.errors.length, 0);
      assert.strictEqual(p.blocks[0].label, undefined);
    });

    it('accepts quoted labels and targets', () => {
      const p = parse(src('// LINT.IfChange("lbl")', 'x', '// LINT.ThenChange("//a.ts:lbl", \'b.ts\')'));
      assert.strictEqual(p.errors.length, 0);
      assert.strictEqual(p.blocks[0].label, 'lbl');
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//a.ts:lbl', 'b.ts']);
    });

    it('accepts quoted targets containing spaces, commas and non-ASCII characters', () => {
      const line = '// LINT.ThenChange("//docs/한글 문서.md:kr", \'//a, b.ts\', //plain.ts)';
      const p = parse(src('// LINT.IfChange', 'x', line));
      assert.deepStrictEqual(p.errors, []);
      const t = p.blocks[0].targets;
      assert.deepStrictEqual(t.map((x) => [x.path, x.label]), [['//docs/한글 문서.md', 'kr'], ['//a, b.ts', undefined], ['//plain.ts', undefined]]);
      // Spans cover the text inside the quotes.
      assert.strictEqual(line.slice(t[0].span.start.character, t[0].span.end.character), '//docs/한글 문서.md:kr');
    });

    it('rejects an unbalanced quote', () => {
      const p = parse(src('// LINT.IfChange', 'x', '// LINT.ThenChange("//a.ts, //b.ts)'));
      assert.deepStrictEqual(p.errors.map((e) => e.code), ['invalid-target']);
    });

    it('rejects unquoted spaces with a helpful message', () => {
      const p = parse(src('// LINT.IfChange', 'x', '// LINT.ThenChange(//my file.ts)'));
      assert.match(p.errors[0].message, /quote paths that contain spaces/);
    });

    it('accepts bracketed target lists', () => {
      const p = parse(src('// LINT.IfChange', 'x', '// LINT.ThenChange(["//a.ts", "//b.ts"])'));
      assert.strictEqual(p.errors.length, 0);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//a.ts', '//b.ts']);
    });

    it('ignores trailing prose after the directive', () => {
      const p = parse(src('// LINT.IfChange(a) keep in sync with the server', 'x', '// LINT.ThenChange(b.ts) see docs'));
      assert.strictEqual(p.errors.length, 0);
      assert.strictEqual(p.blocks[0].label, 'a');
    });

    it('does not match identifiers that merely start with the directive', () => {
      const p = parse(src('// LINT.IfChangeX', '// LINT.ThenChanges(a)'));
      assert.strictEqual(p.blocks.length, 0);
      assert.strictEqual(p.errors.length, 0);
    });

    it('does not match directives in the middle of code', () => {
      const p = parse(src('const s = "LINT.IfChange";', 'call(); // not LINT.ThenChange(a)'));
      assert.strictEqual(p.blocks.length, 0);
      assert.strictEqual(p.errors.length, 0);
    });

    it('handles CRLF input', () => {
      const p = parse('// LINT.IfChange(a)\r\nx\r\n// LINT.ThenChange(b.ts)\r\n');
      assert.strictEqual(p.errors.length, 0);
      assert.strictEqual(p.blocks[0].thenLine, 2);
    });

    it('handles a BOM without shifting columns', () => {
      const p = parse('\ufeff// LINT.IfChange(a)\nx\n// LINT.ThenChange(b.ts)');
      assert.strictEqual(p.blocks.length, 1);
      assert.strictEqual(p.blocks[0].ifSpan.start.character, 3);
    });

    it('parses several sequential blocks', () => {
      const p = parse(src(
        '// LINT.IfChange(a)', '1', '// LINT.ThenChange(x.ts)',
        'mid',
        '// LINT.IfChange(b)', '2', '// LINT.ThenChange(y.ts)',
      ));
      assert.deepStrictEqual(p.blocks.map((b) => b.label), ['a', 'b']);
      assert.strictEqual(p.errors.length, 0);
    });

    it('supports nesting, closing the innermost block first', () => {
      const p = parse(src(
        '// LINT.IfChange(outer)',
        'a',
        '// LINT.IfChange(inner)',
        'b',
        '// LINT.ThenChange(i.ts)',
        'c',
        '// LINT.ThenChange(o.ts)',
      ));
      assert.strictEqual(p.errors.length, 0);
      const outer = p.labels.get('outer')!;
      const inner = p.labels.get('inner')!;
      assert.strictEqual(outer.contentStart, 1);
      assert.strictEqual(outer.contentEnd, 5);
      assert.strictEqual(outer.depth, 0);
      assert.strictEqual(inner.contentStart, 3);
      assert.strictEqual(inner.contentEnd, 3);
      assert.strictEqual(inner.depth, 1);
      assert.deepStrictEqual(p.blocks.map((b) => b.label), ['outer', 'inner']);
    });
  });

  describe('comment styles', () => {
    const styles: Array<[string, string, string]> = [
      ['//', '// LINT.IfChange(a)', '// LINT.ThenChange(t.ts)'],
      ['///', '/// LINT.IfChange(a)', '/// LINT.ThenChange(t.ts)'],
      ['//!', '//! LINT.IfChange(a)', '//! LINT.ThenChange(t.ts)'],
      ['#', '# LINT.IfChange(a)', '# LINT.ThenChange(t.ts)'],
      ['##', '## LINT.IfChange(a)', '## LINT.ThenChange(t.ts)'],
      ['--', '-- LINT.IfChange(a)', '-- LINT.ThenChange(t.ts)'],
      [';', '; LINT.IfChange(a)', '; LINT.ThenChange(t.ts)'],
      [';;', ';; LINT.IfChange(a)', ';; LINT.ThenChange(t.ts)'],
      ['%', '% LINT.IfChange(a)', '% LINT.ThenChange(t.ts)'],
      ["'", "' LINT.IfChange(a)", "' LINT.ThenChange(t.ts)"],
      ['"', '" LINT.IfChange(a)', '" LINT.ThenChange(t.ts)'],
      ['/* */', '/* LINT.IfChange(a) */', '/* LINT.ThenChange(t.ts) */'],
      ['/** */', '/** LINT.IfChange(a) */', '/** LINT.ThenChange(t.ts) */'],
      [' * ', ' * LINT.IfChange(a)', ' * LINT.ThenChange(t.ts)'],
      ['<!-- -->', '<!-- LINT.IfChange(a) -->', '<!-- LINT.ThenChange(t.ts) -->'],
      ['{{/* */}}', '{{/* LINT.IfChange(a) */}}', '{{/* LINT.ThenChange(t.ts) */}}'],
      ['{{- /* */}}', '{{- /* LINT.IfChange(a) */ -}}', '{{- /* LINT.ThenChange(t.ts) */ -}}'],
      ['{# #}', '{# LINT.IfChange(a) #}', '{# LINT.ThenChange(t.ts) #}'],
      ['{{! }}', '{{! LINT.IfChange(a) }}', '{{! LINT.ThenChange(t.ts) }}'],
      ['<%# %>', '<%# LINT.IfChange(a) %>', '<%# LINT.ThenChange(t.ts) %>'],
      ['@* *@', '@* LINT.IfChange(a) *@', '@* LINT.ThenChange(t.ts) *@'],
      ['{- -}', '{- LINT.IfChange(a) -}', '{- LINT.ThenChange(t.ts) -}'],
      ['(* *)', '(* LINT.IfChange(a) *)', '(* LINT.ThenChange(t.ts) *)'],
      ['::', ':: LINT.IfChange(a)', ':: LINT.ThenChange(t.ts)'],
      ['REM', 'REM LINT.IfChange(a)', 'REM LINT.ThenChange(t.ts)'],
      ['no space', '//LINT.IfChange(a)', '#LINT.ThenChange(t.ts)'],
      ['bare (inside block comment)', 'LINT.IfChange(a)', 'LINT.ThenChange(t.ts)'],
      ['tabs', '\t\t// LINT.IfChange(a)', '\t\t// LINT.ThenChange(t.ts)'],
    ];
    for (const [name, open, close] of styles) {
      it(`recognises ${name}`, () => {
        const p = parse(src(open, 'body', close));
        assert.deepStrictEqual(p.errors, []);
        assert.strictEqual(p.blocks.length, 1);
        assert.strictEqual(p.blocks[0].label, 'a');
        assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['t.ts']);
      });
    }
  });

  describe('multi-line target lists', () => {
    it('parses targets across comment lines', () => {
      const p = parse(src(
        '// LINT.IfChange',
        'x',
        '// LINT.ThenChange(',
        '//     //a.ts:one,',
        '//     //b/c.py,',
        '// )',
        'after',
      ));
      assert.deepStrictEqual(p.errors, []);
      const b = p.blocks[0];
      assert.deepStrictEqual(b.targets.map((t) => t.raw), ['//a.ts:one', '//b/c.py']);
      assert.strictEqual(b.thenLine, 2);
      assert.strictEqual(b.thenEndLine, 5);
      assert.deepStrictEqual(b.targets[0].span, { start: { line: 3, character: 7 }, end: { line: 3, character: 17 } });
      assert.deepStrictEqual(b.targets[1].span, { start: { line: 4, character: 7 }, end: { line: 4, character: 15 } });
    });

    it('parses Python-style continuation', () => {
      const p = parse(src('# LINT.IfChange', 'x', '# LINT.ThenChange(//a.py,', '#   //b.py)'));
      assert.deepStrictEqual(p.errors, []);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//a.py', '//b.py']);
    });

    it('parses lists inside a block comment', () => {
      const p = parse(src('/* LINT.IfChange */', 'x', '/* LINT.ThenChange(', ' *   //a.c,', ' *   //b.c', ' * ) */'));
      assert.deepStrictEqual(p.errors, []);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//a.c', '//b.c']);
    });

    it('does not treat a closing comment marker as part of the target', () => {
      const p = parse(src('<!-- LINT.IfChange -->', 'x', '<!-- LINT.ThenChange(//a.md, -->', '<!-- //b.md) -->'));
      assert.deepStrictEqual(p.errors, []);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['//a.md', '//b.md']);
    });

    it('accepts a trailing comma', () => {
      const p = parse(src('// LINT.IfChange', 'x', '// LINT.ThenChange(', '//   a.ts,', '// )'));
      assert.deepStrictEqual(p.errors, []);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['a.ts']);
    });

    it('continues scanning after a multi-line directive', () => {
      const p = parse(src(
        '// LINT.IfChange(a)', 'x', '// LINT.ThenChange(', '//   b.ts', '// )',
        '// LINT.IfChange(c)', 'y', '// LINT.ThenChange(d.ts)',
      ));
      assert.deepStrictEqual(p.errors, []);
      assert.strictEqual(p.blocks.length, 2);
    });
  });

  describe('errors', () => {
    const codes = (text: string) => parse(text).errors.map((e) => e.code);

    it('reports ThenChange without IfChange', () => {
      assert.deepStrictEqual(codes('// LINT.ThenChange(a.ts)'), ['unmatched-then']);
    });

    it('reports an unclosed IfChange', () => {
      const p = parse(src('x', '// LINT.IfChange(foo)', 'y'));
      assert.deepStrictEqual(p.errors.map((e) => e.code), ['unclosed-if']);
      assert.strictEqual(p.errors[0].span.start.line, 1);
      assert.match(p.errors[0].message, /foo/);
    });

    it('reports invalid labels', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange(1abc)', 'x', '// LINT.ThenChange(a.ts)')), ['invalid-label']);
      assert.deepStrictEqual(codes(src('// LINT.IfChange(a b)', 'x', '// LINT.ThenChange(a.ts)')), ['invalid-label']);
    });

    it('reports invalid labels in targets', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange(a.ts:9x)')), ['invalid-label']);
    });

    it('reports duplicate labels', () => {
      const p = parse(src(
        '// LINT.IfChange(a)', '1', '// LINT.ThenChange(x.ts)',
        '// LINT.IfChange(a)', '2', '// LINT.ThenChange(y.ts)',
      ));
      assert.deepStrictEqual(p.errors.map((e) => e.code), ['duplicate-label']);
      assert.strictEqual(p.errors[0].span.start.line, 3);
      assert.strictEqual(p.labels.get('a')!.ifLine, 0);
    });

    it('reports an empty target list', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange()')), ['empty-targets']);
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange( , )')), ['empty-targets']);
    });

    it('reports a ThenChange without parentheses', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange')), ['empty-targets']);
    });

    it('reports an unterminated list', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange(a.ts,', '// b.ts')), ['unterminated-args']);
    });

    it('reports an unterminated label', () => {
      const c = codes(src('// LINT.IfChange(abc', 'x', '// LINT.ThenChange(a.ts)'));
      assert.deepStrictEqual(c, ['unterminated-args']);
    });

    it('reports targets separated by spaces instead of commas', () => {
      assert.deepStrictEqual(codes(src('// LINT.IfChange', 'x', '// LINT.ThenChange(a.ts b.ts)')), ['invalid-target']);
    });

    it('still builds the block when targets have errors', () => {
      const p = parse(src('// LINT.IfChange', 'x', '// LINT.ThenChange(a.ts:9x, b.ts)'));
      assert.strictEqual(p.blocks.length, 1);
      assert.deepStrictEqual(p.blocks[0].targets.map((t) => t.raw), ['b.ts']);
    });

    it('recovers after an unmatched ThenChange', () => {
      const p = parse(src('// LINT.ThenChange(x.ts)', '// LINT.IfChange(a)', 'y', '// LINT.ThenChange(z.ts)'));
      assert.deepStrictEqual(p.errors.map((e) => e.code), ['unmatched-then']);
      assert.strictEqual(p.blocks.length, 1);
    });
  });

  describe('custom namespace', () => {
    it('uses the configured namespace', () => {
      const p = parse(src('// SYNC.IfChange(a)', 'x', '// SYNC.ThenChange(b.ts)'), 'SYNC');
      assert.strictEqual(p.blocks.length, 1);
      assert.strictEqual(parse(src('// LINT.IfChange(a)', 'x', '// LINT.ThenChange(b.ts)'), 'SYNC').blocks.length, 0);
    });

    it('escapes regex characters in the namespace', () => {
      const p = parse(src('// A+B.IfChange', 'x', '// A+B.ThenChange(b.ts)'), 'A+B');
      assert.strictEqual(p.blocks.length, 1);
    });
  });

  describe('mayContainDirectives', () => {
    it('detects either directive', () => {
      assert.strictEqual(mayContainDirectives('x LINT.IfChange'), true);
      assert.strictEqual(mayContainDirectives('x LINT.ThenChange'), true);
      assert.strictEqual(mayContainDirectives('nothing'), false);
    });
  });

  describe('splitTarget', () => {
    const cases: Array<[string, string | undefined, string | undefined]> = [
      ['//a/b.ts', '//a/b.ts', undefined],
      ['//a/b.ts:lbl', '//a/b.ts', 'lbl'],
      [':lbl', undefined, 'lbl'],
      ['a.ts', 'a.ts', undefined],
      ['C:\\x\\y.ts', 'C:\\x\\y.ts', undefined],
      ['C:/x/y.ts', 'C:/x/y.ts', undefined],
      ['C:/x/y.ts:lbl', 'C:/x/y.ts', 'lbl'],
      ['a.ts:', 'a.ts', undefined],
      ['dir:weird/file.ts', 'dir:weird/file.ts', undefined],
      ['a.b.c:x.y-z', 'a.b.c', 'x.y-z'],
    ];
    for (const [raw, path, label] of cases) {
      it(raw, () => {
        const r = splitTarget(raw);
        assert.deepStrictEqual({ path: r.path, label: r.label }, { path, label });
      });
    }
  });

  describe('robustness', () => {
    it('never throws on random input', () => {
      const pieces = ['// LINT.IfChange', '// LINT.IfChange(a)', '// LINT.ThenChange(', '// LINT.ThenChange(x)', ')', ',', ':', 'code', '', '#', '"', '(', 'LINT.', '\r'];
      let seed = 7;
      const rnd = (n: number) => {
        seed = (seed * 48271) % 2147483647;
        return seed % n;
      };
      for (let i = 0; i < 3000; i++) {
        const lines = Array.from({ length: rnd(12) }, () => pieces[rnd(pieces.length)] + (rnd(3) === 0 ? pieces[rnd(pieces.length)] : ''));
        const text = lines.join('\n');
        const lineCount = text.split(/\r\n|\r|\n/).length;
        const p = parse(text);
        for (const b of p.blocks) {
          assert.ok(b.ifLine < b.thenLine);
          assert.ok(b.thenLine <= b.thenEndLine);
          assert.strictEqual(b.contentStart, b.ifLine + 1);
          assert.strictEqual(b.contentEnd, b.thenLine - 1);
        }
        for (const e of p.errors) {
          assert.ok(e.span.start.line >= 0 && e.span.start.line < lineCount);
        }
      }
    });

    it('parses a large file quickly', () => {
      const parts: string[] = [];
      for (let i = 0; i < 5000; i++) {
        parts.push(`// LINT.IfChange(l${i})`, `const v${i} = ${i};`, `// LINT.ThenChange(//other.ts:l${i})`, 'filler();');
      }
      const t = Date.now();
      const p = parse(parts.join('\n'));
      assert.ok(Date.now() - t < 1500);
      assert.strictEqual(p.blocks.length, 5000);
      assert.strictEqual(p.errors.length, 0);
    });
  });
});
