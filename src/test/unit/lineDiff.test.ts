import * as assert from 'assert';
import { anyChange, diffLines, rangeChanged, similarity, splitLines } from '../../core/lineDiff';

const L = (...xs: string[]) => xs.join('\n') + '\n';

function changedIdx(base: string, cur: string): number[] {
  const c = diffLines(base, cur);
  return c.changed.flatMap((v, i) => (v ? [i] : []));
}

describe('splitLines', () => {
  it('handles empty text', () => {
    assert.deepStrictEqual(splitLines(''), []);
  });
  it('ignores a single trailing newline', () => {
    assert.deepStrictEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepStrictEqual(splitLines('a\nb'), ['a', 'b']);
  });
  it('keeps blank lines in the middle and a blank last line before newline', () => {
    assert.deepStrictEqual(splitLines('a\n\nb\n\n'), ['a', '', 'b', '']);
  });
  it('normalises CRLF and CR', () => {
    assert.deepStrictEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  });
  it('strips a BOM', () => {
    assert.deepStrictEqual(splitLines('﻿a\nb'), ['a', 'b']);
  });
  it('treats a lone newline as one empty line', () => {
    assert.deepStrictEqual(splitLines('\n'), ['']);
  });
});

describe('diffLines', () => {
  it('reports identical texts', () => {
    const c = diffLines(L('a', 'b'), L('a', 'b'));
    assert.strictEqual(c.identical, true);
    assert.strictEqual(anyChange(c), false);
    assert.deepStrictEqual(c.deletedBefore, []);
  });

  it('treats CRLF vs LF as identical', () => {
    assert.strictEqual(diffLines('a\r\nb\r\n', 'a\nb\n').identical, true);
  });

  it('treats a missing final newline as identical', () => {
    assert.strictEqual(diffLines('a\nb', 'a\nb\n').identical, true);
  });

  it('detects a modified line', () => {
    assert.deepStrictEqual(changedIdx(L('a', 'b', 'c'), L('a', 'B', 'c')), [1]);
  });

  it('detects inserted lines', () => {
    assert.deepStrictEqual(changedIdx(L('a', 'c'), L('a', 'b1', 'b2', 'c')), [1, 2]);
  });

  it('detects a deletion position', () => {
    const c = diffLines(L('a', 'b', 'c'), L('a', 'c'));
    assert.deepStrictEqual(c.deletedBefore, [1]);
    assert.ok(c.changed.every((x) => !x));
    assert.strictEqual(c.identical, false);
  });

  it('detects deletion at end of file', () => {
    const c = diffLines(L('a', 'b'), L('a'));
    assert.deepStrictEqual(c.deletedBefore, [1]);
  });

  it('detects deletion at start of file', () => {
    const c = diffLines(L('a', 'b'), L('b'));
    assert.deepStrictEqual(c.deletedBefore, [0]);
  });

  it('handles new file (empty baseline)', () => {
    assert.deepStrictEqual(changedIdx('', L('x', 'y')), [0, 1]);
  });

  it('handles file emptied', () => {
    const c = diffLines(L('x', 'y'), '');
    assert.deepStrictEqual(c.deletedBefore, [0]);
    assert.strictEqual(c.lineCount, 0);
  });

  it('keeps edits local when repeated lines exist', () => {
    const base = L('}', '}', 'x', '}', '}');
    const cur = L('}', '}', 'x', 'y', '}', '}');
    assert.deepStrictEqual(changedIdx(base, cur), [3]);
  });

  it('handles multiple separated hunks', () => {
    const base = L('1', '2', '3', '4', '5', '6', '7', '8');
    const cur = L('1', 'X', '3', '4', '5', '6', 'Y', 'Z', '8');
    assert.deepStrictEqual(changedIdx(base, cur), [1, 6, 7]);
  });

  it('falls back to marking everything when edit distance is too large', () => {
    const base = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const cur = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const c = diffLines(base, cur, 10);
    assert.ok(c.changed.every((x) => x));
    assert.deepStrictEqual(c.deletedBefore, [0]);
  });

  it('is fast on large files with small edits', () => {
    const base = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
    const cur = base.slice();
    cur[100_000] = 'edited';
    cur.splice(150_000, 3);
    const t = Date.now();
    const c = diffLines(base, cur);
    assert.ok(Date.now() - t < 2000);
    assert.strictEqual(c.changed[100_000], true);
    assert.ok(c.deletedBefore.includes(150_000));
    assert.strictEqual(c.changed.filter((x) => x).length, 1);
  });

  describe('property: unchanged lines are an optimal common subsequence', () => {
    function lcs(a: string[], b: string[]): number {
      const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      return dp[a.length][b.length];
    }
    function isSubsequence(sub: string[], of: string[]): boolean {
      let i = 0;
      for (const x of of) {
        if (i < sub.length && sub[i] === x) i++;
      }
      return i === sub.length;
    }
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let iter = 0; iter < 400; iter++) {
      it(`random case ${iter}`, () => {
        const alphabet = ['a', 'b', 'c', '}', '', 'x'];
        const base = Array.from({ length: rnd(25) }, () => alphabet[rnd(alphabet.length)]);
        const cur = base.slice();
        const edits = rnd(6);
        for (let e = 0; e < edits; e++) {
          const op = rnd(3);
          const pos = rnd(cur.length + 1);
          if (op === 0) cur.splice(pos, 0, alphabet[rnd(alphabet.length)]);
          else if (op === 1 && cur.length > 0) cur.splice(Math.min(pos, cur.length - 1), 1);
          else if (cur.length > 0) cur[Math.min(pos, cur.length - 1)] = alphabet[rnd(alphabet.length)] + '!';
        }
        const c = diffLines(base, cur);
        const kept = cur.filter((_, i) => !c.changed[i]);
        assert.ok(isSubsequence(kept, base), 'kept lines must appear in baseline order');
        assert.strictEqual(kept.length, lcs(base, cur), 'diff must be minimal');
        const removed = base.length - kept.length;
        const inserted = cur.length - kept.length;
        if (removed === 0) {
          assert.deepStrictEqual(c.deletedBefore, [], 'no removals -> no deletion markers');
        }
        if (removed > inserted) {
          assert.ok(c.deletedBefore.length > 0, 'net removals must be reported');
        }
        assert.strictEqual(c.identical, base.length === cur.length && base.every((x, i) => x === cur[i]));
        for (const p of c.deletedBefore) {
          assert.ok(p >= 0 && p <= cur.length);
        }
      });
    }
  });
});

describe('modification pairing', () => {
  it('editing the line after a region is not a deletion inside it', () => {
    const c = diffLines(L('if', 'a', '// then(x)'), L('if', 'a', '// then(x, y)'));
    assert.deepStrictEqual(c.deletedBefore, []);
    assert.strictEqual(rangeChanged(c, 1, 1), false);
    assert.strictEqual(c.changed[2], true);
  });
  it('editing the line before a region is not a deletion inside it', () => {
    const c = diffLines(L('// if(a)', 'body', 'then'), L('// if(b)', 'body', 'then'));
    assert.strictEqual(rangeChanged(c, 1, 1), false);
  });
  it('removing content while editing the closer is still detected', () => {
    const c = diffLines(L('if', 'a', '// LINT.ThenChange(x)'), L('if', '// LINT.ThenChange(y)'));
    assert.strictEqual(rangeChanged(c, 1, 0), true);
  });
  it('removing content while editing the opener is still detected', () => {
    const c = diffLines(L('// LINT.IfChange(a)', 'zzz', 'b', 'then'), L('// LINT.IfChange(b)', 'b', 'then'));
    assert.strictEqual(rangeChanged(c, 1, 1), true);
  });
  it('a dissimilar replacement keeps its deletion marker', () => {
    const c = diffLines(L('x', 'alpha', 'y'), L('x', '12345', 'y'));
    assert.deepStrictEqual(c.deletedBefore, [1]);
    assert.strictEqual(c.changed[1], true);
  });
});

describe('similarity', () => {
  it('scores', () => {
    assert.strictEqual(similarity('abc', 'abc'), 1);
    assert.strictEqual(similarity('  abc', 'abc  '), 1);
    assert.strictEqual(similarity('', ''), 1);
    assert.strictEqual(similarity('abc', 'xyz'), 0);
    assert.ok(similarity('MAX = 10', 'MAX = 20') > 0.8);
    assert.ok(similarity('aaa', 'aaaa') <= 1);
  });
});

describe('rangeChanged', () => {
  const base = L('if', 'a', 'b', 'then', 'tail');
  it('is false when nothing inside changed', () => {
    const c = diffLines(base, L('if', 'a', 'b', 'then', 'TAIL'));
    assert.strictEqual(rangeChanged(c, 1, 2), false);
  });
  it('is true for a modification inside', () => {
    const c = diffLines(base, L('if', 'a', 'B', 'then', 'tail'));
    assert.strictEqual(rangeChanged(c, 1, 2), true);
  });
  it('is true for a deletion right after the opener', () => {
    const c = diffLines(base, L('if', 'b', 'then', 'tail'));
    assert.strictEqual(rangeChanged(c, 1, 1), true);
  });
  it('is true for a deletion right before the closer', () => {
    const c = diffLines(base, L('if', 'a', 'then', 'tail'));
    assert.strictEqual(rangeChanged(c, 1, 1), true);
  });
  it('is true when all content was deleted (empty range)', () => {
    const c = diffLines(base, L('if', 'then', 'tail'));
    assert.strictEqual(rangeChanged(c, 1, 0), true);
  });
  it('is false for a deletion just before the opener', () => {
    const c = diffLines(L('x', 'if', 'a', 'then'), L('if', 'a', 'then'));
    assert.strictEqual(rangeChanged(c, 1, 1), false);
  });
  it('is false for an insertion just after the closer', () => {
    const c = diffLines(base, L('if', 'a', 'b', 'then', 'new', 'tail'));
    assert.strictEqual(rangeChanged(c, 1, 2), false);
  });
});
