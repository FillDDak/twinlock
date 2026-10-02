/**
 * Line-based diff that answers one question: which parts of the *current*
 * text differ from a baseline?
 *
 * The result is expressed purely in current-text coordinates so callers can
 * ask "did anything change inside lines [a, b]?" without caring about how
 * the baseline looked.
 */

export interface LineChanges {
  /** Number of lines in the current text. */
  readonly lineCount: number;
  /** `changed[i]` is true when current line `i` was added or modified. */
  readonly changed: readonly boolean[];
  /**
   * Current-line indices *before which* one or more baseline lines were
   * removed. An index equal to `lineCount` means lines were removed at EOF.
   */
  readonly deletedBefore: readonly number[];
  /** True when the texts are identical (after line-ending normalisation). */
  readonly identical: boolean;
}

/** Split text into lines, tolerating CRLF/CR, a BOM and a trailing newline. */
export function splitLines(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  // "a\nb\n" is two lines, not three.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** When the edit script grows beyond this, the middle is treated as rewritten. */
const DEFAULT_MAX_EDIT_DISTANCE = 4000;

export function diffLines(
  baseline: string | readonly string[],
  current: string | readonly string[],
  maxEditDistance = DEFAULT_MAX_EDIT_DISTANCE,
): LineChanges {
  const a = typeof baseline === 'string' ? splitLines(baseline) : baseline;
  const b = typeof current === 'string' ? splitLines(current) : current;
  const changed: boolean[] = new Array<boolean>(b.length).fill(false);
  const deleted = new Set<number>();

  // Trim the common prefix and suffix: most real edits are local, and this
  // keeps the expensive part tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start === endA && start === endB) {
    return { lineCount: b.length, changed, deletedBefore: [], identical: a.length === b.length };
  }

  if (start === endA) {
    for (let i = start; i < endB; i++) {
      changed[i] = true;
    }
  } else if (start === endB) {
    deleted.add(start);
  } else {
    const ops = myers(a, start, endA, b, start, endB, maxEditDistance);
    if (ops === undefined) {
      // Too different to diff cheaply: the whole middle counts as rewritten.
      for (let i = start; i < endB; i++) {
        changed[i] = true;
      }
      deleted.add(start);
    } else {
      for (const op of ops) {
        if (op.kind === 'insert') {
          changed[op.b] = true;
        }
      }
      for (const p of pureDeletions(ops, a, b)) {
        deleted.add(p);
      }
    }
  }

  return {
    lineCount: b.length,
    changed,
    deletedBefore: [...deleted].sort((x, y) => x - y),
    identical: false,
  };
}

/** True when anything changed within content lines `first..last` (inclusive). */
export function rangeChanged(changes: LineChanges, first: number, last: number): boolean {
  for (let i = Math.max(0, first); i <= last && i < changes.lineCount; i++) {
    if (changes.changed[i]) {
      return true;
    }
  }
  // A removal "before line last+1" still happened inside the range.
  for (const p of changes.deletedBefore) {
    if (p >= first && p <= last + 1) {
      return true;
    }
  }
  return false;
}

export function anyChange(changes: LineChanges): boolean {
  return !changes.identical;
}

interface EditOp {
  kind: 'insert' | 'delete';
  /** For inserts: the inserted current line. For deletes: the current line it sits before. */
  b: number;
  /** For deletes: the removed baseline line. */
  a: number;
}

/** Minimum similarity for a removed line to count as "modified into" an inserted one. */
const PAIR_THRESHOLD = 0.5;

/**
 * Deletion positions that are not simply the "old version" of a modified line.
 *
 * Myers reports a modified line as delete + insert. If we kept every deletion,
 * editing the line right *after* a region (e.g. the ThenChange directive)
 * would look like a removal at the region's end. So within each hunk, removed
 * lines are paired in order with similar inserted lines and only the
 * unpaired ones are reported, positioned where they sat between the inserts.
 */
function pureDeletions(ops: readonly EditOp[], a: readonly string[], b: readonly string[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < ops.length) {
    // Collect one hunk: ops touching a contiguous stretch of current lines.
    const start = ops[i].b;
    let end = start; // one past the last inserted line seen
    const dels: EditOp[] = [];
    const ins: number[] = [];
    while (i < ops.length && ops[i].b >= start && ops[i].b <= end) {
      const op = ops[i];
      if (op.kind === 'insert') {
        ins.push(op.b);
        end = op.b + 1;
      } else {
        dels.push(op);
      }
      i++;
    }
    let next = 0; // index into ins of the first insert not yet consumed
    for (const d of dels) {
      // Never pair across an insert that precedes the deletion's position.
      while (next < ins.length && ins[next] < d.b) {
        next++;
      }
      let paired = -1;
      for (let j = next; j < ins.length; j++) {
        if (similarity(a[d.a], b[ins[j]]) >= PAIR_THRESHOLD) {
          paired = j;
          break;
        }
      }
      if (paired === -1) {
        out.push(next < ins.length ? ins[next] : Math.max(d.b, end));
      } else {
        next = paired + 1;
      }
    }
  }
  return out;
}

/** Cheap 0..1 similarity: shared prefix + suffix over the longer length. */
export function similarity(x: string, y: string): number {
  x = x.trim();
  y = y.trim();
  if (x === y) {
    return 1;
  }
  const max = Math.max(x.length, y.length);
  if (max === 0) {
    return 1;
  }
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) {
    p++;
  }
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) {
    s++;
  }
  return (p + s) / max;
}

/**
 * Classic Myers O(ND) diff over the slices a[aStart, aEnd) / b[bStart, bEnd).
 * Returns `undefined` when the edit distance exceeds `maxD`.
 */
function myers(
  a: readonly string[],
  aStart: number,
  aEnd: number,
  b: readonly string[],
  bStart: number,
  bEnd: number,
  maxD: number,
): EditOp[] | undefined {
  // Intern lines so the hot loop compares integers.
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    return id;
  };
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const A = new Int32Array(n);
  const B = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    A[i] = intern(a[aStart + i]);
  }
  for (let j = 0; j < m; j++) {
    B[j] = intern(b[bStart + j]);
  }

  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) {
    return undefined;
  }

  // Backtrack. trace[d] holds V *before* step d, covering k in [-d-1, d+1].
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const get = (k: number): number => vd[k + d + 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ kind: 'insert', b: bStart + prevY, a: aStart + prevX });
    } else {
      ops.push({ kind: 'delete', b: bStart + prevY, a: aStart + prevX });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
