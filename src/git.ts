import { execFile } from 'child_process';
import * as fs from 'fs';
import { dirname, join, normalize } from './core/paths';

export interface GitLog {
  info(msg: string): void;
  warn(msg: string): void;
}

interface BaseInfo {
  sha?: string;
  at: number;
  pending?: Promise<string | undefined>;
}

/** Limits concurrent child processes so a big scan cannot fork-bomb the machine. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Minimal, read-only git access: repository roots, the baseline commit and
 * file contents at that commit. Everything is cached aggressively.
 */
export class GitService {
  private readonly dirRoots = new Map<string, Promise<string | undefined>>();
  private readonly verifiedRoots = new Map<string, Promise<string | undefined>>();
  private readonly bases = new Map<string, BaseInfo>();
  private readonly trees = new Map<string, Promise<Map<string, string> | undefined>>();
  private readonly blobs = new Map<string, Promise<string | undefined>>();
  private readonly ignored = new Map<string, Promise<boolean>>();
  private readonly changes = new Map<string, { at: number; value: Promise<Set<string> | undefined> }>();
  private readonly sem = new Semaphore(6);
  private warnedRefs = new Set<string>();
  private available: boolean | undefined;

  constructor(
    private readonly gitPath: string,
    private readonly caseInsensitive: boolean,
    private readonly log: GitLog,
  ) {}

  /** Forget cached commits (call after commits, checkouts, fetches...). */
  invalidate(): void {
    this.bases.clear();
    this.changes.clear();
  }

  /** Forget everything, including repository roots. */
  reset(): void {
    this.bases.clear();
    this.dirRoots.clear();
    this.verifiedRoots.clear();
    this.trees.clear();
    this.blobs.clear();
    this.ignored.clear();
    this.changes.clear();
  }

  /** Lookup key: NFC (see keyOf in model.ts) and lower-cased on case-insensitive systems. */
  private k(p: string): string {
    const n = p.normalize('NFC');
    return this.caseInsensitive ? n.toLowerCase() : n;
  }

  /** Repository root containing `dir`, found by walking up to a `.git` entry. */
  rootFor(dir: string): Promise<string | undefined> {
    dir = normalize(dir);
    const key = this.k(dir);
    let hit = this.dirRoots.get(key);
    if (!hit) {
      hit = (async () => {
        if (await exists(join(dir, '.git'))) {
          return this.verifyRoot(dir);
        }
        const parent = dirname(dir);
        if (parent === dir || parent === '.' || parent === '') {
          return undefined;
        }
        return this.rootFor(parent);
      })();
      this.dirRoots.set(key, hit);
    }
    return hit;
  }

  private verifyRoot(dir: string): Promise<string | undefined> {
    const key = this.k(dir);
    let hit = this.verifiedRoots.get(key);
    if (!hit) {
      hit = this.git(dir, ['rev-parse', '--show-toplevel'])
        .then((out) => {
          // Keep the path as we found it (not git's spelling): through symlinks,
          // 8.3 names or different drive-letter case, git may report the same
          // directory differently, and file paths must stay relative to it.
          return out.trim().length > 0 ? dir : undefined;
        })
        .catch((e: Error) => {
          this.log.info(`git rev-parse failed in ${dir}: ${e.message}`);
          return undefined;
        });
      this.verifiedRoots.set(key, hit);
    }
    return hit;
  }

  /** The commit to compare against, or `undefined` (e.g. a repo without commits). */
  async baseCommit(root: string, ref: string, useMergeBase: boolean): Promise<string | undefined> {
    const key = `${this.k(root)}\0${ref}\0${useMergeBase}`;
    const now = Date.now();
    const hit = this.bases.get(key);
    if (hit && (hit.pending || now - hit.at < 1500)) {
      return hit.pending ?? hit.sha;
    }
    const pending = this.resolveBase(root, ref, useMergeBase);
    this.bases.set(key, { at: now, pending, sha: hit?.sha });
    const sha = await pending;
    this.bases.set(key, { at: Date.now(), sha });
    return sha;
  }

  private async resolveBase(root: string, ref: string, useMergeBase: boolean): Promise<string | undefined> {
    const verify = (r: string) => this.git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`]).then((s) => s.trim());
    try {
      if (ref === 'HEAD' || !useMergeBase) {
        return await verify(ref);
      }
      return (await this.git(root, ['merge-base', 'HEAD', ref])).trim();
    } catch {
      if (ref !== 'HEAD') {
        if (!this.warnedRefs.has(ref)) {
          this.warnedRefs.add(ref);
          this.log.warn(`Cannot resolve base ref "${ref}" in ${root}; falling back to HEAD.`);
        }
        try {
          return await verify('HEAD');
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }

  /** Root-relative paths that exist at `sha`, keyed case-(in)sensitively. */
  private tree(root: string, sha: string): Promise<Map<string, string> | undefined> {
    const key = `${this.k(root)}\0${sha}`;
    let hit = this.trees.get(key);
    if (!hit) {
      hit = this.git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha])
        .then((out) => {
          const m = new Map<string, string>();
          for (const p of out.split('\0')) {
            if (p) {
              m.set(this.k(p), p);
            }
          }
          return m;
        })
        .catch((e: Error) => {
          this.log.warn(`git ls-tree failed: ${e.message}`);
          this.trees.delete(key);
          return undefined;
        });
      this.trees.set(key, hit);
      if (this.trees.size > 16) {
        this.trees.delete(this.trees.keys().next().value!);
      }
    }
    return hit;
  }

  /**
   * File content at `sha`.
   * - `string`: the content
   * - `null`: the file did not exist at that commit (it is new)
   * - `undefined`: git could not tell
   */
  async contentAt(root: string, sha: string, relPath: string): Promise<string | null | undefined> {
    const tree = await this.tree(root, sha);
    if (!tree) {
      return undefined;
    }
    const actual = tree.get(this.k(relPath));
    if (actual === undefined) {
      return null;
    }
    const key = `${sha}\0${actual}`;
    let hit = this.blobs.get(key);
    if (!hit) {
      hit = this.git(root, ['cat-file', 'blob', `${sha}:${actual}`])
        .catch((e: Error) => {
          this.log.warn(`git cat-file failed for ${actual}: ${e.message}`);
          this.blobs.delete(key);
          return undefined;
        });
      this.blobs.set(key, hit);
      if (this.blobs.size > 2000) {
        this.blobs.delete(this.blobs.keys().next().value!);
      }
    }
    return hit;
  }

  /**
   * Files in `dir` that git does not ignore (tracked + untracked), as paths
   * relative to `dir`. `undefined` when git cannot list them.
   */
  async listFiles(dir: string, max: number): Promise<string[] | undefined> {
    try {
      const out = await this.git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']);
      const files: string[] = [];
      for (const p of out.split('\0')) {
        if (p) {
          files.push(p);
          if (files.length >= max) {
            break;
          }
        }
      }
      return files;
    } catch (e) {
      this.log.info(`git ls-files failed in ${dir}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Files under `dir` (tracked or untracked, not ignored) whose working-tree
   * content contains any of `needles`, relative to `dir`. `undefined` on failure.
   */
  async grepFiles(dir: string, needles: string[]): Promise<string[] | undefined> {
    const args = ['grep', '-l', '-z', '-I', '-F', '--untracked', '--no-color'];
    for (const n of needles) {
      args.push('-e', n);
    }
    args.push('--', '.');
    try {
      const out = await this.git(dir, args, [0, 1]);
      return [...new Set(out.split('\0').filter(Boolean))];
    } catch (e) {
      this.log.info(`git grep failed in ${dir}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Nested repositories below `dir` (submodules and embedded clones), as
   * paths relative to `dir`. The outer `git grep` cannot see into them.
   */
  async nestedRepos(dir: string): Promise<string[]> {
    const out = new Set<string>();
    try {
      // Gitlinks (mode 160000) are submodules or committed embedded repositories.
      const staged = await this.git(dir, ['ls-files', '-s', '-z']);
      for (const entry of staged.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab > 0 && entry.startsWith('160000 ')) {
          out.add(entry.slice(tab + 1));
        }
      }
      // Untracked embedded repositories show up as untracked directories.
      const others = await this.git(dir, ['ls-files', '-z', '--others', '--directory', '--exclude-standard']);
      for (const p of others.split('\0')) {
        if (p.endsWith('/') && (await exists(join(join(dir, p), '.git')))) {
          out.add(p.slice(0, -1));
        }
      }
    } catch (e) {
      this.log.info(`git ls-files failed in ${dir}: ${(e as Error).message}`);
    }
    return [...out];
  }

  /**
   * Root-relative paths (keyed like `tree()`) whose working-tree content
   * differs from `sha`. Cached until `invalidateChanges()` or 10 seconds.
   */
  changedSince(root: string, sha: string): Promise<Set<string> | undefined> {
    const key = `${this.k(root)}\0${sha}`;
    const hit = this.changes.get(key);
    if (hit && Date.now() - hit.at < 10_000) {
      return hit.value;
    }
    const value = this.git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules', sha, '--'])
      .then((out) => new Set(out.split('\0').filter(Boolean).map((p) => this.k(p))))
      .catch((e: Error) => {
        this.log.warn(`git diff failed: ${e.message}`);
        this.changes.delete(key);
        return undefined;
      });
    this.changes.set(key, { at: Date.now(), value });
    return value;
  }

  /** True when git says the working-tree file equals its content at `sha`. */
  async isUnchanged(root: string, sha: string, relPath: string): Promise<boolean> {
    const changed = await this.changedSince(root, sha);
    return changed !== undefined && !changed.has(this.k(relPath));
  }

  /** Forget which files differ from the baseline (call on file changes). */
  invalidateChanges(): void {
    this.changes.clear();
  }

  /** Does `relPath` exist at `sha`? (`undefined` if git cannot tell.) */
  async existsAt(root: string, sha: string, relPath: string): Promise<boolean | undefined> {
    const tree = await this.tree(root, sha);
    return tree ? tree.has(this.k(relPath)) : undefined;
  }

  /** Is `relPath` (relative to `root`) ignored by .gitignore & co? */
  isIgnored(root: string, relPath: string): Promise<boolean> {
    const key = `${this.k(root)}\0${this.k(relPath)}`;
    let hit = this.ignored.get(key);
    if (!hit) {
      // Exit code 0 = ignored, 1 = not ignored.
      hit = this.git(root, ['check-ignore', '-q', '--', relPath]).then(() => true, () => false);
      this.ignored.set(key, hit);
      if (this.ignored.size > 5000) {
        this.ignored.delete(this.ignored.keys().next().value!);
      }
    }
    return hit;
  }

  isAvailable(): boolean | undefined {
    return this.available;
  }

  private git(cwd: string, args: string[], okExitCodes: number[] = [0]): Promise<string> {
    return this.sem.run(
      () =>
        new Promise<string>((resolve, reject) => {
          execFile(
            this.gitPath,
            ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args],
            {
              cwd,
              encoding: 'utf8',
              maxBuffer: 256 * 1024 * 1024,
              timeout: 30_000,
              windowsHide: true,
              env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
            },
            (err, stdout, stderr) => {
              const code = (err as { code?: unknown } | null)?.code;
              if (err && !(typeof code === 'number' && okExitCodes.includes(code))) {
                if (code === 'ENOENT') {
                  this.available = false;
                }
                reject(new Error((stderr || err.message).trim()));
              } else {
                this.available = true;
                resolve(stdout);
              }
            },
          );
        }),
    );
  }
}

function exists(p: string): Promise<boolean> {
  return new Promise((resolve) => fs.access(p, (err) => resolve(!err)));
}
