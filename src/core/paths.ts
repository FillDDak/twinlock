/**
 * Path helpers. Internally every path is absolute and uses forward slashes,
 * which keeps the core independent of the host OS and of VS Code.
 */

export function toSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/** Normalise `.`/`..` segments and duplicate slashes, keeping a drive prefix or UNC root. */
export function normalize(p: string): string {
  p = toSlash(p);
  let prefix = '';
  const drive = /^([A-Za-z]:)(\/|$)/.exec(p);
  if (drive) {
    prefix = drive[1].charAt(0).toLowerCase() + ':/';
    p = p.slice(drive[0].length);
  } else if (p.startsWith('//')) {
    // UNC path: //server/share/...
    prefix = '//';
    p = p.slice(2);
  } else if (p.startsWith('/')) {
    prefix = '/';
    p = p.slice(1);
  }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (prefix === '') {
        out.push('..');
      }
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
}

export function join(base: string, rel: string): string {
  return normalize(toSlash(base).replace(/\/+$/, '') + '/' + toSlash(rel));
}

export function dirname(p: string): string {
  const n = normalize(p);
  const idx = n.lastIndexOf('/');
  if (idx < 0) {
    return '.';
  }
  if (idx === 0) {
    return '/';
  }
  if (/^[a-z]:\/$/.test(n.slice(0, idx + 1)) && idx === 2) {
    return n.slice(0, 3);
  }
  return n.slice(0, idx);
}

export function basename(p: string): string {
  const n = normalize(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

/** `child` relative to `parent`, or `undefined` when it is not inside it. */
export function relativeTo(parent: string, child: string, caseInsensitive: boolean): string | undefined {
  const a = normalize(parent).replace(/\/$/, '');
  const b = normalize(child);
  const ca = caseInsensitive ? a.toLowerCase() : a;
  const cb = caseInsensitive ? b.toLowerCase() : b;
  if (cb === ca) {
    return '';
  }
  if (cb.startsWith(ca + '/')) {
    return b.slice(a.length + 1);
  }
  return undefined;
}

/**
 * Candidate absolute paths for a ThenChange target path, most specific first.
 *
 * - `//x/y`      project-root relative (Google / ifttt-lint style)
 * - `/x/y`       project-root relative, then filesystem absolute
 * - `C:\x`       filesystem absolute
 * - `x/y`, `./x`, `../x`  relative to the referencing file, then to the root
 */
export function targetCandidates(raw: string, sourceFile: string, root: string, rootFallback = true): string[] {
  const p = toSlash(raw);
  if (p.startsWith('//')) {
    return [join(root, p.slice(2))];
  }
  if (isWindowsAbsolute(raw)) {
    return [normalize(raw)];
  }
  if (p.startsWith('/')) {
    return unique([join(root, p.slice(1)), normalize(p)]);
  }
  const relative = join(dirname(sourceFile), p);
  if (!rootFallback || p.startsWith('./') || p.startsWith('../')) {
    return [relative];
  }
  return unique([relative, join(root, p)]);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Display form: root-relative with the `//` prefix when possible. */
export function displayPath(p: string, root: string, caseInsensitive: boolean): string {
  const rel = relativeTo(root, p, caseInsensitive);
  return rel !== undefined ? `//${rel}` : normalize(p);
}
