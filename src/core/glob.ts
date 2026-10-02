/**
 * Small glob matcher compatible with the VS Code / minimatch subset used in
 * exclude settings: `**`, `*`, `?`, `{a,b}` and `[abc]`.
 */

export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let re = '';
  let i = 0;
  let braceDepth = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '/' && g.slice(i) === '/**') {
      re += '(?:/.*)?'; // "dir/**" also matches "dir" itself
      break;
    }
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const atEnd = i + 2 === g.length || g[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === g.length) {
            re += '.*'; // trailing "**": anything, including nothing
            i += 2;
          } else {
            re += '(?:[^/]*/)*'; // "**/": zero or more directories
            i += 3;
          }
          continue;
        }
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else if (c === '[') {
      const close = g.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        let cls = g.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) {
          cls = '^' + cls.slice(1);
        }
        re += `[${cls}]`;
        i = close;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

export class GlobSet {
  private readonly res: RegExp[];
  constructor(globs: readonly string[], caseInsensitive = false) {
    this.res = globs.map((g) => globToRegExp(g, caseInsensitive));
  }
  /** `relPath` uses forward slashes and is relative to the workspace folder. */
  matches(relPath: string): boolean {
    return this.res.some((r) => r.test(relPath));
  }
}
