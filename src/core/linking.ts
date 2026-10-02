/**
 * Pure helpers for the "Link Selection" workflow: picking labels, formatting
 * target references and computing the lines to insert.
 */

import { CommentStyle, commentLine } from './commentSyntax';
import { LABEL_PATTERN } from './parser';
import { dirname, normalize, relativeTo } from './paths';

const RESERVED = new Set([
  'const', 'let', 'var', 'function', 'def', 'class', 'return', 'export', 'import', 'public', 'private',
  'protected', 'static', 'final', 'async', 'await', 'if', 'else', 'for', 'while', 'type', 'interface',
  'enum', 'struct', 'fn', 'func', 'pub', 'val', 'new', 'from', 'package', 'readonly', 'abstract', 'override',
  'self', 'this', 'true', 'false', 'null', 'none', 'nil', 'void', 'int', 'string', 'bool', 'float', 'double',
]);

/** Turn arbitrary text into a valid label (or `undefined` if nothing usable). */
export function sanitizeLabel(raw: string): string | undefined {
  let s = raw.trim().replace(/[^A-Za-z0-9_.\-]+/g, '_').replace(/_+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/[_.\-]+$/, '');
  if (s.length > 48) {
    s = s.slice(0, 48).replace(/[_.\-]+$/, '');
  }
  return s.length > 0 && LABEL_PATTERN.test(s) ? s : undefined;
}

/** Suggest a label from the first meaningful identifier in the guarded code. */
export function suggestLabel(code: string, taken: ReadonlySet<string> = new Set()): string {
  let base: string | undefined;
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0];
    if (word.length >= 3 && !RESERVED.has(word.toLowerCase())) {
      base = sanitizeLabel(snake(word));
      if (base) {
        break;
      }
    }
  }
  return uniqueLabel(base ?? 'linked', taken);
}

export function uniqueLabel(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function snake(word: string): string {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * How `from` should refer to `to`: `//path` when both share the root,
 * otherwise a path relative to `from`'s directory.
 */
export function referencePath(from: string, to: string, root: string, caseInsensitive: boolean): string {
  const rel = relativeTo(root, to, caseInsensitive);
  if (rel !== undefined && relativeTo(root, from, caseInsensitive) !== undefined) {
    return `//${rel}`;
  }
  return relativePath(dirname(from), to, caseInsensitive);
}

function relativePath(fromDir: string, to: string, caseInsensitive: boolean): string {
  const a = normalize(fromDir).split('/').filter(Boolean);
  const b = normalize(to).split('/').filter(Boolean);
  let i = 0;
  const eq = (x: string, y: string) => (caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y);
  while (i < a.length && i < b.length && eq(a[i], b[i])) {
    i++;
  }
  const drive = (p: string) => /^[a-z]:\//i.exec(normalize(p))?.[0].toLowerCase() ?? (normalize(p).startsWith('//') ? 'unc' : '/');
  if (drive(fromDir) !== drive(to) || (i === 0 && drive(to) !== '/')) {
    return normalize(to); // different drives: only an absolute path works
  }
  const up = a.slice(i).map(() => '..');
  const rest = b.slice(i);
  const joined = [...up, ...rest].join('/');
  return up.length === 0 ? `./${joined}` : joined;
}

export function formatTarget(path: string | undefined, label: string | undefined): string {
  const t = `${path ?? ''}${label !== undefined ? `:${label}` : ''}`;
  // Spaces and commas would split the target list; quotes keep it intact.
  return /[\s,]/.test(t) ? `"${t}"` : t;
}

export interface LineInsertion {
  /** Insert *before* this zero-based line (may equal the line count to append). */
  line: number;
  text: string;
}

/**
 * Lines to insert so that lines `first..last` (inclusive) become a guarded block.
 */
export function wrapLines(
  lines: readonly string[],
  first: number,
  last: number,
  style: CommentStyle,
  namespace: string,
  label: string | undefined,
  targets: readonly string[],
): LineInsertion[] {
  const indent = indentOf(lines, first, last);
  const open = commentLine(style, indent, `${namespace}.IfChange${label ? `(${label})` : ''}`);
  const close = commentLine(style, indent, `${namespace}.ThenChange(${targets.join(', ')})`);
  return [
    { line: first, text: open },
    { line: last + 1, text: close },
  ];
}

function indentOf(lines: readonly string[], first: number, last: number): string {
  let best: string | undefined;
  for (let i = first; i <= last && i < lines.length; i++) {
    if (lines[i].trim().length === 0) {
      continue;
    }
    const ind = /^\s*/.exec(lines[i])![0];
    if (best === undefined || ind.length < best.length) {
      best = ind;
    }
  }
  return best ?? '';
}
