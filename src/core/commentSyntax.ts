/**
 * Comment syntax used when Twinlock *writes* directives into a file.
 * (Reading is language-agnostic; see parser.ts.)
 */

export interface CommentStyle {
  start: string;
  end?: string;
}

const HASH: CommentStyle = { start: '#' };
const SLASH: CommentStyle = { start: '//' };
const DASH: CommentStyle = { start: '--' };
const SEMI: CommentStyle = { start: ';' };
const PERCENT: CommentStyle = { start: '%' };
const HTML: CommentStyle = { start: '<!--', end: '-->' };
const BLOCK: CommentStyle = { start: '/*', end: '*/' };

const BY_LANGUAGE: Record<string, CommentStyle> = {
  // C family and friends
  c: SLASH, cpp: SLASH, 'cuda-cpp': SLASH, csharp: SLASH, java: SLASH, javascript: SLASH,
  javascriptreact: SLASH, typescript: SLASH, typescriptreact: SLASH, go: SLASH, rust: SLASH,
  swift: SLASH, kotlin: SLASH, scala: SLASH, dart: SLASH, groovy: SLASH, 'objective-c': SLASH,
  'objective-cpp': SLASH, php: SLASH, jsonc: SLASH, json5: SLASH, proto: SLASH, proto3: SLASH,
  zig: SLASH, v: SLASH, d: SLASH, hlsl: SLASH, glsl: SLASH, wgsl: SLASH, shaderlab: SLASH,
  solidity: SLASH, scss: SLASH, less: SLASH, stylus: SLASH, fsharp: SLASH, haxe: SLASH,
  apex: SLASH, verilog: SLASH, systemverilog: SLASH, typespec: SLASH, prisma: SLASH,
  graphql: HASH, thrift: SLASH, 'vue': HTML, svelte: HTML, astro: HTML, gleam: SLASH, odin: SLASH,
  // Hash comments
  python: HASH, ruby: HASH, shellscript: HASH, bash: HASH, sh: HASH, zsh: HASH, fish: HASH,
  perl: HASH, perl6: HASH, raku: HASH, r: HASH, julia: HASH, yaml: HASH, toml: HASH,
  dockerfile: HASH, makefile: HASH, cmake: HASH, powershell: HASH, coffeescript: HASH,
  elixir: HASH, nim: HASH, crystal: HASH, terraform: HASH, hcl: HASH, starlark: HASH,
  bazel: HASH, 'git-commit': HASH, gitignore: HASH, ignore: HASH, properties: HASH,
  dotenv: HASH, nix: HASH, tcl: HASH, awk: HASH, 'ssh_config': HASH, conf: HASH,
  // Dashes
  sql: DASH, lua: DASH, haskell: DASH, elm: DASH, ada: DASH, vhdl: DASH, plsql: DASH, purescript: DASH,
  // Others
  clojure: SEMI, lisp: SEMI, scheme: SEMI, racket: SEMI, 'emacs-lisp': SEMI, ini: SEMI, asm: SEMI,
  latex: PERCENT, tex: PERCENT, bibtex: PERCENT, erlang: PERCENT, matlab: PERCENT, prolog: PERCENT,
  html: HTML, xml: HTML, xsl: HTML, svg: HTML, markdown: HTML, mdx: { start: '{/*', end: '*/}' },
  razor: { start: '@*', end: '*@' }, handlebars: { start: '{{!--', end: '--}}' },
  jinja: { start: '{#', end: '#}' }, 'jinja-html': { start: '{#', end: '#}' }, twig: { start: '{#', end: '#}' },
  'django-html': { start: '{#', end: '#}' }, erb: { start: '<%#', end: '%>' },
  css: BLOCK, ocaml: { start: '(*', end: '*)' }, pascal: { start: '//' }, vb: { start: "'" },
  bat: { start: 'REM' }, vim: { start: '"' }, 'go-template': { start: '{{/*', end: '*/}}' },
  helm: { start: '{{/*', end: '*/}}' },
};

const BY_EXTENSION: Record<string, CommentStyle> = {
  py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, yml: HASH, yaml: HASH, toml: HASH,
  tf: HASH, bzl: HASH, bazel: HASH, r: HASH, pl: HASH, ps1: HASH, ex: HASH, exs: HASH, nix: HASH,
  sql: DASH, lua: DASH, hs: DASH, elm: DASH,
  html: HTML, htm: HTML, xml: HTML, svg: HTML, md: HTML, vue: HTML, svelte: HTML,
  css: BLOCK, tex: PERCENT, erl: PERCENT, clj: SEMI, el: SEMI, ini: SEMI, bat: { start: 'REM' }, cmd: { start: 'REM' },
};

/** Formats with no comment syntax: directives cannot be written into them. */
const NO_COMMENTS_LANGUAGES = new Set(['json', 'csv', 'tsv', 'binary', 'image']);
const NO_COMMENTS_EXTENSIONS = new Set(['json', 'csv', 'tsv', 'ipynb', 'lock']);

/** False when a file cannot hold comments (it can still be a whole-file target). */
export function supportsComments(languageId: string, fileName: string, overrides: Record<string, string> = {}): boolean {
  if (typeof overrides[languageId] === 'string' && overrides[languageId].trim().length > 0) {
    return true;
  }
  if (BY_LANGUAGE[languageId]) {
    return true;
  }
  const ext = /\.([^./\\]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return !NO_COMMENTS_LANGUAGES.has(languageId) && !(ext !== undefined && NO_COMMENTS_EXTENSIONS.has(ext));
}

/**
 * Pick the comment style for a document.
 * `overrides` maps languageId -> "start" or "start ... end" (e.g. "<!-- ... -->").
 */
export function commentStyleFor(languageId: string, fileName: string, overrides: Record<string, string> = {}): CommentStyle {
  const o = overrides[languageId];
  if (typeof o === 'string' && o.trim().length > 0) {
    const parts = o.split('...').map((x) => x.trim());
    return parts.length >= 2 && parts[1] ? { start: parts[0], end: parts[1] } : { start: parts[0] };
  }
  const byLang = BY_LANGUAGE[languageId];
  if (byLang) {
    return byLang;
  }
  const ext = /\.([^./\\]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (ext && BY_EXTENSION[ext]) {
    return BY_EXTENSION[ext];
  }
  return SLASH;
}

/** Every distinct style Twinlock may write (used by tests to prove round-trips). */
export function allCommentStyles(): Array<{ id: string; style: CommentStyle }> {
  return [
    ...Object.entries(BY_LANGUAGE).map(([id, style]) => ({ id, style })),
    ...Object.entries(BY_EXTENSION).map(([id, style]) => ({ id: `.${id}`, style })),
  ];
}

/** Render one directive as a full comment line. */
export function commentLine(style: CommentStyle, indent: string, body: string): string {
  return style.end ? `${indent}${style.start} ${body} ${style.end}` : `${indent}${style.start} ${body}`;
}
