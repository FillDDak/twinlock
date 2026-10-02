/**
 * Parser for Google-style `LINT.IfChange` / `LINT.ThenChange` directives.
 *
 *   // LINT.IfChange(optional_label)
 *   ...guarded code...
 *   // LINT.ThenChange(//path/from/root.ts:label, ./relative.py, :same_file_label)
 *
 * The parser is language-agnostic: a directive is recognised when it starts a
 * line, optionally preceded by any common comment marker. ThenChange argument
 * lists may span several comment lines.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface Target {
  /** Text as written, e.g. `//src/a.ts:label`. */
  raw: string;
  /** Path part, or `undefined` for a same-file reference (`:label`). */
  path?: string;
  label?: string;
  span: Span;
}

export interface Block {
  label?: string;
  /** Span of the `LINT.IfChange(...)` token. */
  ifSpan: Span;
  labelSpan?: Span;
  ifLine: number;
  /** First line of the ThenChange directive. */
  thenLine: number;
  /** Last line of the ThenChange directive (differs when the list spans lines). */
  thenEndLine: number;
  thenSpan: Span;
  /** Guarded content lines (inclusive). `contentEnd < contentStart` when empty. */
  contentStart: number;
  contentEnd: number;
  targets: Target[];
  /** Nesting depth, 0 for top-level blocks. */
  depth: number;
}

export type ParseErrorCode =
  | 'unmatched-then'
  | 'unclosed-if'
  | 'invalid-label'
  | 'duplicate-label'
  | 'empty-targets'
  | 'unterminated-args'
  | 'invalid-target';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  span: Span;
}

export interface ParsedFile {
  blocks: Block[];
  errors: ParseError[];
  /** Labeled blocks by label (first occurrence wins). */
  labels: Map<string, Block>;
}

export const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_.\-]*$/;

/** Comment openers that may precede a directive on its line. */
const COMMENT_PREFIX = [
  '\\/\\/+[!/]?', //  //  ///  //!
  '\\/\\*+!?', //     /*  /**
  '\\*+', //          * (inside block comments)
  '#+!?', //          #  ##
  '--+', //           -- (SQL, Lua, Haskell)
  ';+', //            ;  (Lisp, INI, asm)
  '%+', //            %  (TeX, Erlang, MATLAB)
  "'+", //            '  (VB)
  '"', //             "  (Vim script)
  '<!--+', //         <!-- (HTML, XML, Markdown)
  '<%#', //           <%# (ERB)
  '@\\*', //          @* (Razor)
  '\\{\\{!-*', //     {{! (Handlebars)
  '\\{\\{-?\\s*\\/\\*', // {{/* (Go templates)
  '\\{#', //          {# (Jinja, Twig)
  '\\{\\/\\*', //       {/* (MDX, JSX)
  '\\{-+', //         {- (Haskell)
  '\\(\\*+', //       (* (OCaml, Pascal)
  '::', //            :: (Batch)
  'REM\\b', //        REM (Batch)
].join('|');

const directiveCache = new Map<string, RegExp>();

function directiveRegex(namespace: string): RegExp {
  let re = directiveCache.get(namespace);
  if (!re) {
    const ns = namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`^(\\s*(?:(?:${COMMENT_PREFIX})\\s*)?)(${ns}\\.(IfChange|ThenChange))(?![A-Za-z0-9_])`);
    directiveCache.set(namespace, re);
  }
  return re;
}

const CONTINUATION_PREFIX = new RegExp(`^\\s*(?:(?:${COMMENT_PREFIX})\\s*)?`);

/** Cheap pre-check used before running the full parser. */
export function mayContainDirectives(text: string, namespace = 'LINT'): boolean {
  return text.includes(`${namespace}.IfChange`) || text.includes(`${namespace}.ThenChange`);
}

/** Max number of lines a ThenChange argument list may span. */
const MAX_ARG_LINES = 64;

export function parse(text: string, namespace = 'LINT'): ParsedFile {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0].slice(1); // editors do not count the BOM as a column
  }
  const blocks: Block[] = [];
  const errors: ParseError[] = [];
  const labels = new Map<string, Block>();
  const open: Array<{ line: number; span: Span; label?: string; labelSpan?: Span }> = [];
  const re = directiveRegex(namespace);

  if (!mayContainDirectives(text, namespace)) {
    return { blocks, errors, labels };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(namespace)) {
      continue;
    }
    const m = re.exec(line);
    if (!m) {
      continue;
    }
    const kind = m[3] as 'IfChange' | 'ThenChange';
    const tokenStart = m[1].length;
    const afterToken = tokenStart + m[2].length;
    const rest = line.slice(afterToken);
    const hasParen = /^\s*\(/.test(rest);

    if (kind === 'IfChange') {
      let label: string | undefined;
      let labelSpan: Span | undefined;
      let tokenEnd = afterToken;
      if (hasParen) {
        const openParen = line.indexOf('(', afterToken);
        const close = line.indexOf(')', openParen + 1);
        if (close === -1) {
          errors.push({
            code: 'unterminated-args',
            message: `Missing ")" after ${namespace}.IfChange(.`,
            span: lineSpan(i, tokenStart, line.length),
          });
        } else {
          tokenEnd = close + 1;
          const inner = line.slice(openParen + 1, close);
          const lead = inner.length - inner.trimStart().length;
          const unquoted = stripQuotes(inner.trim());
          const quoteOffset = unquoted.length < inner.trim().length ? 1 : 0;
          const trimmed = unquoted;
          if (trimmed.length > 0) {
            const innerStart = openParen + 1 + lead + quoteOffset;
            const span = lineSpan(i, innerStart, innerStart + trimmed.length);
            if (LABEL_PATTERN.test(trimmed)) {
              label = trimmed;
              labelSpan = span;
            } else {
              errors.push({
                code: 'invalid-label',
                message: `Invalid label "${trimmed}". Labels start with a letter and may contain letters, digits, "_", "-" and ".".`,
                span,
              });
            }
          }
        }
      }
      open.push({ line: i, span: lineSpan(i, tokenStart, tokenEnd), label, labelSpan });
      continue;
    }

    // ThenChange
    let args = '';
    const positions: Position[] = [];
    let endLine = i;
    let tokenEnd = afterToken;
    let terminated = false;
    if (hasParen) {
      let col = line.indexOf('(', afterToken) + 1;
      let ln = i;
      let text = line;
      for (;;) {
        const close = text.indexOf(')', col);
        const stop = close === -1 ? stripTrailingCommentCloser(text, col) : close;
        for (let c = col; c < stop; c++) {
          args += text[c];
          positions.push({ line: ln, character: c });
        }
        if (close !== -1) {
          terminated = true;
          endLine = ln;
          tokenEnd = close + 1;
          break;
        }
        if (ln + 1 >= lines.length || ln - i >= MAX_ARG_LINES) {
          break;
        }
        // Continue onto the next comment line.
        ln++;
        text = lines[ln];
        col = (CONTINUATION_PREFIX.exec(text) ?? [''])[0].length;
        args += '\n';
        positions.push({ line: ln, character: col });
      }
      if (!terminated) {
        errors.push({
          code: 'unterminated-args',
          message: `Missing ")" to close ${namespace}.ThenChange(.`,
          span: lineSpan(i, tokenStart, line.length),
        });
      }
    }

    const thenSpan: Span = {
      start: { line: i, character: tokenStart },
      end: { line: endLine, character: terminated ? tokenEnd : lines[i].length },
    };
    const errorsBefore = errors.length;
    const targets = terminated ? parseTargets(args, positions, errors) : [];
    if (!hasParen) {
      errors.push({
        code: 'empty-targets',
        message: `${namespace}.ThenChange needs a target list, e.g. ${namespace}.ThenChange(//path/to/file.ts).`,
        span: thenSpan,
      });
    } else if (terminated && targets.length === 0 && errors.length === errorsBefore) {
      errors.push({
        code: 'empty-targets',
        message: `${namespace}.ThenChange needs at least one target, e.g. ${namespace}.ThenChange(//path/to/file.ts:label).`,
        span: thenSpan,
      });
    }

    const opener = open.pop();
    if (!opener) {
      errors.push({
        code: 'unmatched-then',
        message: `${namespace}.ThenChange without a preceding ${namespace}.IfChange.`,
        span: thenSpan,
      });
    } else {
      const block: Block = {
        label: opener.label,
        labelSpan: opener.labelSpan,
        ifSpan: opener.span,
        ifLine: opener.line,
        thenLine: i,
        thenEndLine: endLine,
        thenSpan,
        contentStart: opener.line + 1,
        contentEnd: i - 1,
        targets,
        depth: open.length,
      };
      blocks.push(block);
      if (block.label !== undefined) {
        if (labels.has(block.label)) {
          errors.push({
            code: 'duplicate-label',
            message: `Duplicate label "${block.label}" in this file; references to it would be ambiguous.`,
            span: block.labelSpan ?? block.ifSpan,
          });
        } else {
          labels.set(block.label, block);
        }
      }
    }
    i = endLine;
  }

  for (const o of open) {
    errors.push({
      code: 'unclosed-if',
      message: `${namespace}.IfChange${o.label ? `(${o.label})` : ''} is never closed by a ${namespace}.ThenChange.`,
      span: o.span,
    });
  }

  blocks.sort((x, y) => x.ifLine - y.ifLine);
  return { blocks, errors, labels };
}

function parseTargets(args: string, positions: Position[], errors: ParseError[]): Target[] {
  const targets: Target[] = [];
  let segStart = 0;
  let quote: string | undefined;
  for (let idx = 0; idx <= args.length; idx++) {
    if (idx < args.length) {
      const c = args[idx];
      // Commas inside quotes belong to the path ("//docs/a, b.md").
      if (quote) {
        if (c === quote) {
          quote = undefined;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c !== ',') {
        continue;
      }
    }
    // Segment [segStart, idx)
    let s = segStart;
    let e = idx;
    segStart = idx + 1;
    while (s < e && /\s/.test(args[s])) s++;
    while (e > s && /\s/.test(args[e - 1])) e--;
    // Strip wrapping brackets, e.g. ["//a.ts", "//b.ts"].
    while (s < e && args[s] === '[') s++;
    while (e > s && args[e - 1] === ']') e--;
    while (s < e && /\s/.test(args[s])) s++;
    while (e > s && /\s/.test(args[e - 1])) e--;
    // Quoted targets may contain spaces.
    let quoted = false;
    if (e - s >= 2 && /["'`]/.test(args[s]) && args[e - 1] === args[s]) {
      s++;
      e--;
      quoted = true;
    }
    if (s >= e) {
      continue;
    }
    const raw = args.slice(s, e);
    const span: Span = {
      start: positions[s],
      end: { line: positions[e - 1].line, character: positions[e - 1].character + 1 },
    };
    if (/["'`]/.test(raw) || (!quoted && /\s/.test(raw)) || raw.includes('\n')) {
      errors.push({
        code: 'invalid-target',
        message: `Invalid target "${raw.replace(/\s+/g, ' ')}". Separate targets with commas, and quote paths that contain spaces.`,
        span,
      });
      continue;
    }
    const t = splitTarget(raw);
    if (t.label !== undefined && !LABEL_PATTERN.test(t.label)) {
      errors.push({ code: 'invalid-label', message: `Invalid label "${t.label}" in target "${raw}".`, span });
      continue;
    }
    if (t.path === undefined && t.label === undefined) {
      errors.push({ code: 'invalid-target', message: `Invalid target "${raw}".`, span });
      continue;
    }
    targets.push({ raw, path: t.path, label: t.label, span });
  }
  return targets;
}

/** Split `path:label`, `:label` or `path` (Windows drive letters are not labels). */
export function splitTarget(raw: string): { path?: string; label?: string } {
  const colon = raw.lastIndexOf(':');
  if (colon === -1 || (colon === 1 && /^[A-Za-z]:[\\/]/.test(raw))) {
    return { path: raw };
  }
  const path = raw.slice(0, colon);
  const label = raw.slice(colon + 1);
  if (label.length === 0) {
    return { path: path.length > 0 ? path : undefined };
  }
  if (/[\\/]/.test(label)) {
    // A colon inside a path, not a label separator.
    return { path: raw };
  }
  return { path: path.length > 0 ? path : undefined, label };
}

function stripQuotes(s: string): string {
  const m = /^(["'`])(.*)\1$/.exec(s);
  return m ? m[2] : s;
}

/** Stop before a trailing block-comment closer like `*\/`, `-->`, `*)`, `-}`. */
function stripTrailingCommentCloser(text: string, from: number): number {
  const m = /\s*(?:\*\/\}?|-->|\*\)|-\}|#\}|--\}\}|\}\}|%>|\*@)\s*$/.exec(text.slice(from));
  return m ? from + m.index : text.length;
}

function lineSpan(line: number, start: number, end: number): Span {
  return { start: { line, character: start }, end: { line, character: end } };
}
