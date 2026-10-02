import * as vscode from 'vscode';
import { Analysis, BlockResult, Engine, FileSnapshot, TargetResult } from './core/engine';
import { GlobSet } from './core/glob';
import { splitLines } from './core/lineDiff';
import { mayContainDirectives, parse, ParsedFile } from './core/parser';
import { dirname, displayPath, normalize, relativeTo, targetCandidates } from './core/paths';
import { readConfig, TwinlockConfig } from './config';
import { GitService } from './git';

export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

const keyMemo = new Map<string, string>();

export function keyOf(path: string): string {
  let k = keyMemo.get(path);
  if (k === undefined) {
    // NFC: macOS file systems may report decomposed (NFD) names, git reports NFC.
    const n = normalize(path).normalize('NFC');
    k = CASE_INSENSITIVE ? n.toLowerCase() : n;
    if (keyMemo.size > 50_000) {
      keyMemo.clear();
    }
    keyMemo.set(path, k);
  }
  return k;
}

export function pathOf(uri: vscode.Uri): string {
  return normalize(uri.fsPath);
}

export function uriOf(path: string): vscode.Uri {
  return vscode.Uri.file(path);
}

/** A pending block whose stale target is the given file. */
export interface Incoming {
  source: BlockResult;
  target: TargetResult;
}

type BaselineMode = 'git' | 'session';

interface DiskEntry {
  exists: boolean;
  isFile: boolean;
  mtime: number;
  size: number;
  /** Decoded text; `undefined` for directories, binary or oversized files. */
  text: string | undefined;
  /** False once the entry may be outdated (window regained focus). */
  checked: boolean;
}

const MAX_CONCURRENT_READS = 24;
const MISSING_TTL_MS = 3000;

export class TwinlockModel implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly indexEmitter = new vscode.EventEmitter<boolean>();
  /** Fires `true` when indexing starts and `false` when it ends. */
  readonly onDidChangeIndexing = this.indexEmitter.event;

  private config: TwinlockConfig = readConfig();
  private git: GitService;
  private excludes = new GlobSet([]);
  private readonly disposables: vscode.Disposable[] = [];

  /** Files known to contain directives, by key. */
  private readonly sources = new Map<string, string>();
  /** Keys whose index entry changed while a rescan was running. */
  private touched: Set<string> | undefined;
  private readonly disk = new Map<string, DiskEntry>();
  private readonly sessionBaselines = new Map<string, string>();
  private readonly roots = new Map<string, string>();
  private readonly modes = new Map<string, BaselineMode>();
  private parsed = new Map<string, { path: string; parsed: ParsedFile }>();
  private snapshots = new Map<string, FileSnapshot | null>();
  private relevantKeys = new Set<string>();
  /** Parse results by file, reused while the text is unchanged. */
  private readonly parseCache = new Map<string, { text: string; namespace: string; parsed: ParsedFile; lines: string[] }>();

  private _analysis: Analysis | undefined;
  private incoming = new Map<string, Incoming[]>();
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private scanGeneration = 0;
  private running: Promise<void> | undefined;
  private rerun = false;
  private indexing = false;
  private disposed = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.git = this.createGit();
    this.applyConfig();
  }

  // ---------------------------------------------------------------- public API

  get analysis(): Analysis | undefined {
    return this._analysis;
  }

  get settings(): TwinlockConfig {
    return this.config;
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  key(path: string): string {
    return keyOf(path);
  }

  resultsFor(uri: vscode.Uri): BlockResult[] {
    return this._analysis?.byFile.get(keyOf(pathOf(uri))) ?? [];
  }

  parsedFor(uri: vscode.Uri): ParsedFile | undefined {
    return this.parsed.get(keyOf(pathOf(uri)))?.parsed;
  }

  allParsed(): Iterable<{ path: string; parsed: ParsedFile }> {
    return this.parsed.values();
  }

  /** Pending obligations that point *at* this file. */
  incomingFor(uri: vscode.Uri): Incoming[] {
    return this.incoming.get(keyOf(pathOf(uri))) ?? [];
  }

  /** Every block (anywhere) that references `path` / `path:label`. */
  inboundFor(path: string, label?: string) {
    const k = keyOf(path) + (label !== undefined ? `#${label}` : '');
    return this._analysis?.inbound.get(k) ?? [];
  }

  rootOf(path: string): string {
    const k = keyOf(path);
    const cached = this.roots.get(k);
    if (cached) {
      return cached;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uriOf(path));
    return folder ? normalize(folder.uri.fsPath) : dirname(path);
  }

  display(path: string, from?: string): string {
    return displayPath(path, this.rootOf(from ?? path), CASE_INSENSITIVE);
  }

  modeOf(path: string): BaselineMode | undefined {
    return this.modes.get(keyOf(path));
  }

  /** Baseline text used for comparison (`null` = new file). */
  baselineOf(path: string): string | null | undefined {
    const s = this.snapshots.get(keyOf(path));
    return s ? s.baseline : undefined;
  }

  isRelevant(uri: vscode.Uri): boolean {
    return this.relevantKeys.has(keyOf(pathOf(uri)));
  }

  ackKey(path: string, id: string): string {
    return `${keyOf(path)}#${id}`;
  }

  isAcknowledged(path: string, id: string, hash: string): boolean {
    const acks = this.state.get<Record<string, string>>('twinlock.acks', {});
    return acks[this.ackKey(path, id)] === hash;
  }

  async acknowledge(result: BlockResult): Promise<void> {
    const acks = { ...this.state.get<Record<string, string>>('twinlock.acks', {}) };
    acks[this.ackKey(result.path, result.id)] = result.contentHash;
    await this.state.update('twinlock.acks', acks);
    this.schedule(0);
  }

  async unacknowledge(result: BlockResult): Promise<void> {
    const acks = { ...this.state.get<Record<string, string>>('twinlock.acks', {}) };
    delete acks[this.ackKey(result.path, result.id)];
    await this.state.update('twinlock.acks', acks);
    this.schedule(0);
  }

  async clearAcknowledgements(): Promise<number> {
    const n = Object.keys(this.state.get<Record<string, string>>('twinlock.acks', {})).length;
    await this.state.update('twinlock.acks', {});
    this.schedule(0);
    return n;
  }

  /** Session baselines: treat the current disk content as "unchanged". */
  resetSessionBaselines(): void {
    this.sessionBaselines.clear();
    this.disk.clear();
    this.schedule(0);
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    const ws = vscode.workspace;
    this.disposables.push(
      ws.onDidChangeTextDocument((e) => this.onDocumentChanged(e.document)),
      ws.onDidOpenTextDocument((d) => this.onDocumentChanged(d)),
      ws.onDidCloseTextDocument((d) => {
        if (d.uri.scheme === 'file' && this.isRelevant(d.uri)) {
          this.schedule();
        }
      }),
      ws.onDidChangeWorkspaceFolders(() => this.rescan()),
      ws.onDidGrantWorkspaceTrust(() => {
        this.git.reset();
        this.schedule(0);
      }),
      ws.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('twinlock')) {
          const before = this.config;
          this.applyConfig();
          if (before.namespace !== this.config.namespace || before.exclude.join() !== this.config.exclude.join() || before.maxFiles !== this.config.maxFiles || before.maxFileSizeKB !== this.config.maxFileSizeKB || before.enable !== this.config.enable) {
            this.rescan();
          } else {
            this.git.reset();
            this.schedule(0);
          }
        }
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          // Commits, checkouts or edits made outside VS Code may have
          // happened without file events reaching us: re-validate.
          this.git.invalidate();
          for (const e of this.disk.values()) {
            e.checked = false;
          }
          this.schedule(200);
        }
      }),
    );

    const watcher = ws.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.onDiskChanged(u, false)),
      watcher.onDidChange((u) => this.onDiskChanged(u, false)),
      watcher.onDidDelete((u) => this.onDiskChanged(u, true)),
    );
    this.hookGitExtension();
    void this.rescan();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
    this.indexEmitter.dispose();
  }

  /** Full rescan of the workspace for files containing directives. */
  async rescan(): Promise<void> {
    const gen = ++this.scanGeneration;
    this.disk.clear();
    this.git.reset();
    if (!this.config.enable) {
      this.sources.clear();
      this._analysis = undefined;
      this.incoming.clear();
      this.emitter.fire();
      return;
    }
    this.setIndexing(true);
    const started = Date.now();
    // The previous index stays live while scanning so results don't flicker;
    // files that change meanwhile are tracked in `touched` and win over the scan.
    const found = new Map<string, string>();
    this.touched = new Set();
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const exclude = this.config.exclude.length > 0 ? `{${this.config.exclude.join(',')}}` : null;
      let budget = this.config.maxFiles;
      let scanned = 0;
      for (const folder of folders) {
        if (budget <= 0) {
          break;
        }
        const uris = await this.listWorkspaceFiles(folder, exclude, budget);
        budget -= uris.length;
        scanned += uris.length;
        await forEachLimit(uris, MAX_CONCURRENT_READS, async (uri) => {
          if (gen !== this.scanGeneration || this.disposed) {
            return;
          }
          const text = await this.readDisk(pathOf(uri));
          if (text !== undefined && mayContainDirectives(text, this.config.namespace)) {
            found.set(keyOf(pathOf(uri)), pathOf(uri));
          }
        });
      }
      if (gen === this.scanGeneration) {
        const touched = this.touched ?? new Set<string>();
        for (const k of [...this.sources.keys()]) {
          if (!found.has(k) && !touched.has(k)) {
            this.sources.delete(k);
          }
        }
        for (const [k, p] of found) {
          if (!touched.has(k)) {
            this.sources.set(k, p);
          }
        }
        this.touched = undefined;
        // Open documents may have unsaved directives.
        for (const doc of vscode.workspace.textDocuments) {
          this.trackDocument(doc);
        }
        if (budget <= 0) {
          this.log.warn(`Scanned the maximum of ${this.config.maxFiles} files (twinlock.maxFiles); some links may be missed.`);
        }
        this.log.info(`Indexed ${scanned} files in ${Date.now() - started} ms; ${this.sources.size} contain directives.`);
      }
    } catch (e) {
      this.log.error(`Indexing failed: ${(e as Error).message}`);
    } finally {
      if (gen === this.scanGeneration) {
        this.setIndexing(false);
        this.schedule(0);
      }
    }
  }

  /**
   * Candidate files in a workspace folder. Inside git repositories `git grep`
   * finds files mentioning the directives in one pass and skips .gitignore'd
   * build output (which often contains copies of the directives). Elsewhere
   * every file is listed and read.
   */
  private async listWorkspaceFiles(folder: vscode.WorkspaceFolder, exclude: string | null, budget: number): Promise<vscode.Uri[]> {
    const dir = normalize(folder.uri.fsPath);
    if (this.gitUsable() && (await this.git.rootFor(dir))) {
      const ns = this.config.namespace;
      const needles = [`${ns}.IfChange`, `${ns}.ThenChange`];
      const rels = await this.git.grepFiles(dir, needles);
      if (rels) {
        const out = new Map<string, vscode.Uri>();
        const add = (rel: string) => {
          if (!this.excludes.matches(rel) && out.size < budget) {
            const uri = vscode.Uri.joinPath(folder.uri, rel);
            out.set(keyOf(pathOf(uri)), uri);
          }
        };
        for (const rel of rels) {
          add(rel);
        }
        // Nested repositories (submodules, vendored clones) are opaque to the outer grep.
        const visit = async (repoDir: string, baseRel: string, depth: number): Promise<void> => {
          if (depth > 4) {
            return;
          }
          for (const nestedRel of await this.git.nestedRepos(repoDir)) {
            const full = baseRel ? `${baseRel}/${nestedRel}` : nestedRel;
            if (this.excludes.matches(full) || this.excludes.matches(`${full}/x`)) {
              continue;
            }
            const nd = normalize(`${repoDir}/${nestedRel}`);
            for (const rel of (await this.git.grepFiles(nd, needles)) ?? []) {
              add(`${full}/${rel}`);
            }
            await visit(nd, full, depth + 1);
          }
        };
        await visit(dir, '', 0);
        return [...out.values()];
      }
    }
    return vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, budget);
  }

  private gitUsable(): boolean {
    return this.config.useGit && vscode.workspace.isTrusted && this.git.isAvailable() !== false;
  }

  /** True when git ignores the file (such files are never indexed from disk events). */
  private async isGitIgnored(path: string): Promise<boolean> {
    if (!this.gitUsable()) {
      return false;
    }
    const root = await this.git.rootFor(dirname(path));
    const rel = root ? relativeTo(root, path, CASE_INSENSITIVE) : undefined;
    return root !== undefined && rel !== undefined && rel !== '' && (await this.git.isIgnored(root, rel));
  }

  /** Re-run the analysis after `delay` ms (debounced). */
  schedule(delay = 250): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.analyzeNow();
    }, delay);
  }

  /** Run an analysis now; resolves when results are published. */
  async analyzeNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        try {
          await this.analyzeOnce();
        } catch (e) {
          this.log.error(`Analysis failed: ${(e as Error).stack ?? e}`);
        }
      } while (this.rerun && !this.disposed);
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  /** Resolves once indexing and any pending analysis are done (for tests and commands). */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (!this.indexing && !this.timer && !this.running) {
        return;
      }
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.analyzeNow();
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
      if (this.running) {
        await this.running;
      }
    }
  }

  // ------------------------------------------------------------------ internals

  private createGit(): GitService {
    let gitPath = 'git';
    try {
      const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
      const first = Array.isArray(configured) ? configured[0] : configured;
      if (first) {
        gitPath = first;
      }
    } catch {
      // ignore
    }
    return new GitService(gitPath, CASE_INSENSITIVE, {
      info: (m) => this.log.info(m),
      warn: (m) => this.log.warn(m),
    });
  }

  private applyConfig(): void {
    this.config = readConfig();
    this.excludes = new GlobSet(this.config.exclude, CASE_INSENSITIVE);
  }

  private setIndexing(v: boolean): void {
    this.indexing = v;
    this.indexEmitter.fire(v);
  }

  private hookGitExtension(): void {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      if (!ext) {
        return;
      }
      const attach = (api: GitApi) => {
        const watch = (repo: GitRepository) => {
          let head = repo.state.HEAD?.commit;
          this.disposables.push(
            repo.state.onDidChange(() => {
              const next = repo.state.HEAD?.commit;
              if (next !== head) {
                head = next;
                this.git.invalidate();
                this.schedule(100);
              }
            }),
          );
        };
        api.repositories.forEach(watch);
        this.disposables.push(api.onDidOpenRepository(watch));
      };
      const activate = async () => {
        const exports = ext.isActive ? ext.exports : await ext.activate();
        const api = exports?.getAPI(1);
        if (api) {
          attach(api);
        }
      };
      activate().catch((e) => this.log.info(`Git extension API unavailable: ${(e as Error).message}`));
    } catch (e) {
      this.log.info(`Git extension API unavailable: ${(e as Error).message}`);
    }
  }

  private isExcluded(path: string): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uriOf(path));
    if (!folder) {
      return true; // outside the workspace: only indexed when opened
    }
    const rel = relativeTo(normalize(folder.uri.fsPath), path, CASE_INSENSITIVE);
    return rel === undefined || this.excludes.matches(rel);
  }

  private trackDocument(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') {
      return false;
    }
    const path = pathOf(doc.uri);
    const k = keyOf(path);
    const has = mayContainDirectives(doc.getText(), this.config.namespace);
    const had = this.sources.has(k);
    if (has && !had) {
      this.sources.set(k, path);
      this.touched?.add(k);
    } else if (!has && had && !doc.isDirty) {
      // Keep it while dirty: the saved file may still contain directives.
      this.sources.delete(k);
      this.touched?.add(k);
    }
    return has || had;
  }

  private onDocumentChanged(doc: vscode.TextDocument): void {
    if (!this.config.enable || doc.uri.scheme !== 'file') {
      return;
    }
    const isSource = this.trackDocument(doc);
    if (isSource || this.isRelevant(doc.uri)) {
      this.schedule();
    }
  }

  private onDiskChanged(uri: vscode.Uri, deleted: boolean): void {
    if (!this.config.enable || uri.scheme !== 'file') {
      return;
    }
    const path = pathOf(uri);
    const k = keyOf(path);
    this.disk.delete(k);
    // The path may be a folder: some file watchers (e.g. Linux inotify) report a
    // new folder but not the files written into it right away.
    for (const key of [...this.disk.keys()]) {
      if (key.startsWith(k + '/')) {
        this.disk.delete(key);
      }
    }
    this.git.invalidateChanges();
    if (/[\\/]\.git[\\/]/.test(uri.fsPath)) {
      this.git.invalidate();
      this.schedule(300);
      return;
    }
    if (deleted) {
      // Could be a folder: drop everything below it.
      for (const key of [...this.sources.keys()]) {
        if (key === k || key.startsWith(k + '/')) {
          this.sources.delete(key);
          this.touched?.add(key);
        }
      }
      for (const key of [...this.disk.keys()]) {
        if (key.startsWith(k + '/')) {
          this.disk.delete(key);
        }
      }
      this.schedule();
      return;
    }
    // A new folder may contain a (still missing) link target.
    const prefix = k + '/';
    if ([...this.relevantKeys].some((r) => r.startsWith(prefix))) {
      this.schedule();
    }
    if (this.isExcluded(path)) {
      if (this.relevantKeys.has(k)) {
        this.schedule();
      }
      return;
    }
    void this.readDisk(path).then(async (text) => {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && keyOf(pathOf(d.uri)) === k);
      const content = open ? open.getText() : text;
      const has = content !== undefined && mayContainDirectives(content, this.config.namespace) && (open !== undefined || !(await this.isGitIgnored(path)));
      const had = this.sources.has(k);
      if (has) {
        this.sources.set(k, path);
      } else {
        this.sources.delete(k);
      }
      this.touched?.add(k);
      if (has || had || this.relevantKeys.has(k)) {
        this.schedule();
      }
    });
  }

  /**
   * Cached view of a file on disk. Entries stay valid until a file-system
   * event (or regaining window focus) invalidates them, so steady-state
   * analyses do no I/O at all.
   */
  private async diskEntry(path: string): Promise<DiskEntry> {
    const k = keyOf(path);
    const hit = this.disk.get(k);
    // "Missing" is re-checked after a few seconds in case a creation event was lost.
    if (hit?.checked && (hit.exists || Date.now() - hit.mtime < MISSING_TTL_MS)) {
      return hit;
    }
    const uri = uriOf(path);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      // For missing entries, mtime records when we last looked.
      const missing: DiskEntry = { exists: false, isFile: false, mtime: Date.now(), size: 0, text: undefined, checked: true };
      this.disk.set(k, missing);
      return missing;
    }
    const isFile = (stat.type & vscode.FileType.File) !== 0;
    if (hit && hit.exists && hit.isFile === isFile && hit.mtime === stat.mtime && hit.size === stat.size) {
      hit.checked = true;
      return hit;
    }
    let text: string | undefined;
    if (isFile && stat.size <= this.config.maxFileSizeKB * 1024) {
      try {
        text = decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        text = undefined;
      }
    }
    const entry: DiskEntry = { exists: true, isFile, mtime: stat.mtime, size: stat.size, text, checked: true };
    this.disk.set(k, entry);
    if (text !== undefined && !this.sessionBaselines.has(k)) {
      this.sessionBaselines.set(k, text);
    }
    return entry;
  }

  /** File text from disk, or `undefined` if missing, a directory, binary or too large. */
  private async readDisk(path: string): Promise<string | undefined> {
    const e = await this.diskEntry(path);
    return e.isFile ? e.text : undefined;
  }

  private async fileExists(path: string): Promise<boolean> {
    const e = await this.diskEntry(path);
    return e.exists && e.isFile;
  }

  private async loadSnapshot(path: string, docs: Map<string, vscode.TextDocument>): Promise<FileSnapshot | null> {
    const k = keyOf(path);
    const doc = docs.get(k);
    const diskText = await this.readDisk(path);
    const onDisk = diskText !== undefined || (await this.fileExists(path));
    if (!doc && !onDisk) {
      return null;
    }
    if (diskText === undefined && onDisk) {
      // Binary, too large or not UTF-8 decodable: it exists, but never counts as changed.
      const t = doc?.getText() ?? '';
      return { path, text: t, baseline: t };
    }
    // Prefer the disk text for clean documents: it is decoded exactly like the
    // git baseline, so files in other encodings never look modified.
    const text = doc && (doc.isDirty || diskText === undefined) ? doc.getText() : diskText!;

    let baseline: string | null | undefined;
    let root: string | undefined;
    if (this.gitUsable()) {
      root = await this.git.rootFor(dirname(path));
      if (root) {
        const sha = await this.git.baseCommit(root, this.config.baseRef, this.config.useMergeBase);
        const rel = relativeTo(root, path, CASE_INSENSITIVE);
        if (sha && rel !== undefined && rel !== '') {
          const existed = await this.git.existsAt(root, sha, rel);
          if (existed === false) {
            // New since the baseline - unless git ignores it, then it has no history.
            baseline = (await this.git.isIgnored(root, rel)) ? undefined : null;
          } else if (existed === true) {
            if ((await this.git.isUnchanged(root, sha, rel)) && diskText !== undefined) {
              baseline = diskText; // unchanged on disk: no need to ask git for the old content
            } else {
              baseline = await this.git.contentAt(root, sha, rel);
            }
          }
        }
      }
    }
    if (root) {
      this.roots.set(k, root);
    } else {
      this.roots.delete(k);
    }
    if (baseline !== undefined) {
      this.modes.set(k, 'git');
    } else {
      // No git information: compare against the content first seen this session.
      this.modes.set(k, 'session');
      baseline = this.sessionBaselines.get(k) ?? diskText ?? text;
    }
    return { path, text, baseline };
  }

  private prepare(snap: FileSnapshot): { parsed: ParsedFile; lines: string[] } {
    const k = keyOf(snap.path);
    const hit = this.parseCache.get(k);
    if (hit && hit.text === snap.text && hit.namespace === this.config.namespace) {
      return hit;
    }
    const entry = { text: snap.text, namespace: this.config.namespace, parsed: parse(snap.text, this.config.namespace), lines: splitLines(snap.text) };
    this.parseCache.set(k, entry);
    return entry;
  }

  private async analyzeOnce(): Promise<void> {
    const gen = ++this.generation;
    const t0 = Date.now();
    if (!this.config.enable) {
      this._analysis = undefined;
      this.incoming.clear();
      this.emitter.fire();
      return;
    }

    const docs = new Map<string, vscode.TextDocument>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === 'file') {
        docs.set(keyOf(pathOf(d.uri)), d);
      }
    }

    const snapshots = new Map<string, FileSnapshot | null>();
    const parsed = new Map<string, { path: string; parsed: ParsedFile }>();
    const load = async (path: string) => {
      const k = keyOf(path);
      if (!snapshots.has(k)) {
        snapshots.set(k, null); // reserve to avoid duplicate loads
        snapshots.set(k, await this.loadSnapshot(path, docs));
      }
    };

    const sourcePaths = [...this.sources.values()];
    await forEachLimit(sourcePaths, MAX_CONCURRENT_READS, load);

    // Load every candidate target path of every block.
    const candidates = new Set<string>();
    for (const p of sourcePaths) {
      const snap = snapshots.get(keyOf(p));
      if (!snap) {
        continue;
      }
      const pf = this.prepare(snap).parsed;
      parsed.set(keyOf(p), { path: snap.path, parsed: pf });
      const root = this.rootOf(p);
      for (const b of pf.blocks) {
        for (const t of b.targets) {
          if (t.path !== undefined) {
            for (const c of targetCandidates(t.path, p, root, this.config.rootFallback)) {
              candidates.add(c);
            }
          }
        }
      }
    }
    await forEachLimit([...candidates], MAX_CONCURRENT_READS, load);
    if (gen !== this.generation || this.disposed) {
      return;
    }

    const tLoaded = Date.now();
    const engine = new Engine({
      load: (p) => snapshots.get(keyOf(p)) ?? undefined,
      rootOf: (p) => this.rootOf(p),
      key: keyOf,
      isAcknowledged: (p, id, h) => this.isAcknowledged(p, id, h),
      namespace: this.config.namespace,
      prepare: (snap) => this.prepare(snap),
      rootFallback: this.config.rootFallback,
    });
    const analysis = engine.analyze(sourcePaths.filter((p) => snapshots.get(keyOf(p))));

    const incoming = new Map<string, Incoming[]>();
    const relevant = new Set<string>();
    for (const r of analysis.results) {
      relevant.add(keyOf(r.path));
      for (const t of r.targets) {
        relevant.add(keyOf(t.resolvedPath));
        if (r.state === 'pending' && t.state === 'stale') {
          const k = keyOf(t.resolvedPath);
          let list = incoming.get(k);
          if (!list) {
            list = [];
            incoming.set(k, list);
          }
          list.push({ source: r, target: t });
        }
      }
    }
    // Candidate paths matter too: creating a missing target must re-trigger analysis.
    for (const c of candidates) {
      relevant.add(keyOf(c));
    }

    for (const k of this.parseCache.keys()) {
      if (!snapshots.get(k)) {
        this.parseCache.delete(k);
      }
    }
    this.snapshots = snapshots;
    this.parsed = parsed;
    this.relevantKeys = relevant;
    this.incoming = incoming;
    this._analysis = analysis;
    const tAnalyzed = Date.now();
    this.emitter.fire();
    this.log.debug(`Analysis: ${sourcePaths.length} files, ${analysis.results.length} blocks; load ${tLoaded - t0} ms, analyse ${tAnalyzed - tLoaded} ms, publish ${Date.now() - tAnalyzed} ms.`);
    if (process.env.TWINLOCK_PROFILE) {
      console.log(`[twinlock] load ${tLoaded - t0} ms, analyse ${tAnalyzed - tLoaded} ms, publish ${Date.now() - tAnalyzed} ms`);
    }
  }
}

function decode(bytes: Uint8Array): string | undefined {
  // Skip binary files: a NUL byte in the first 8 KB is a reliable signal.
  const probe = Math.min(bytes.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (bytes[i] === 0) {
      return undefined;
    }
  }
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let sinceYield = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
      // Cached work resolves as a long microtask chain; let the extension host breathe.
      if (++sinceYield >= 200) {
        sinceYield = 0;
        await new Promise((r) => setImmediate(r));
      }
    }
  });
  await Promise.all(workers);
}

// Minimal typing of the built-in Git extension API we use.
interface GitRepository {
  state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> };
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}
