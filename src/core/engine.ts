/**
 * The analysis engine: given the current and baseline text of files, decide
 * for every IfChange block whether its linked targets were updated too.
 *
 * The engine is synchronous and pure; the host supplies file contents.
 */

import { anyChange, diffLines, LineChanges, rangeChanged, splitLines } from './lineDiff';
import { Block, ParsedFile, parse, Target } from './parser';
import { normalize, targetCandidates } from './paths';

export interface FileSnapshot {
  /** Absolute, normalised path (see `paths.normalize`). */
  path: string;
  text: string;
  /**
   * Text at the comparison baseline.
   * `null` means the file did not exist at the baseline (it is new),
   * so all of its content counts as changed.
   */
  baseline: string | null;
}

export interface EngineHost {
  /** Snapshot for a path, or `undefined` if no such file exists. */
  load(path: string): FileSnapshot | undefined;
  /** Project root used for `//` paths. */
  rootOf(path: string): string;
  /** Map key for a path (lower-cased on case-insensitive file systems). */
  key(path: string): string;
  /** Has the user acknowledged this exact block content as "no change needed"? */
  isAcknowledged?(path: string, blockId: string, contentHash: string): boolean;
  namespace?: string;
  /** Optional cache hook: parse + split a snapshot (must match `parse`/`splitLines`). */
  prepare?(snapshot: FileSnapshot): { parsed: ParsedFile; lines: string[] };
  rootFallback?: boolean;
}

export type TargetState =
  /** The target changed as well. */
  | 'updated'
  /** The target exists but did not change. */
  | 'stale'
  | 'missing-file'
  | 'missing-label'
  /** A block that names itself as its own target. */
  | 'self';

export interface TargetResult {
  target: Target;
  state: TargetState;
  /** Resolved absolute path when the file exists (or the best guess otherwise). */
  resolvedPath: string;
  /** The labeled block in the target file, when a label was given and found. */
  targetBlock?: Block;
}

export type BlockState =
  /** Guarded content did not change: nothing to do. */
  | 'clean'
  /** Guarded content changed and every target changed too. */
  | 'synced'
  /** Guarded content changed but at least one target did not. */
  | 'pending'
  /** Pending, but the user confirmed no change is needed. */
  | 'acknowledged';

export interface BlockResult {
  path: string;
  block: Block;
  /** Stable id within the file: the label, or `#n` for the n-th unlabeled block. */
  id: string;
  state: BlockState;
  contentHash: string;
  targets: TargetResult[];
}

export interface InboundRef {
  sourcePath: string;
  block: Block;
  target: Target;
}

export interface Analysis {
  results: BlockResult[];
  /** Results grouped by `host.key(path)`. */
  byFile: Map<string, BlockResult[]>;
  /** Inbound references keyed by `key(path)` (whole file) or `key(path)#label`. */
  inbound: Map<string, InboundRef[]>;
}

interface FileInfo {
  snapshot: FileSnapshot;
  parsed: ParsedFile;
  lines: string[];
  changes?: LineChanges;
}

export class Engine {
  private readonly cache = new Map<string, FileInfo | null>();

  constructor(private readonly host: EngineHost) {}

  /** Analyse every block of the given source files. */
  analyze(sourcePaths: Iterable<string>): Analysis {
    const results: BlockResult[] = [];
    const byFile = new Map<string, BlockResult[]>();
    const inbound = new Map<string, InboundRef[]>();
    const seen = new Set<string>();

    for (const raw of sourcePaths) {
      const path = normalize(raw);
      const key = this.host.key(path);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const info = this.info(path);
      if (!info || info.parsed.blocks.length === 0) {
        continue;
      }
      const fileResults = this.analyzeFile(info, inbound);
      results.push(...fileResults);
      byFile.set(key, fileResults);
    }
    return { results, byFile, inbound };
  }

  /** Parsed file (cached for the lifetime of this engine). */
  info(path: string): FileInfo | undefined {
    const key = this.host.key(path);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return hit ?? undefined;
    }
    const snapshot = this.host.load(path);
    if (!snapshot) {
      this.cache.set(key, null);
      return undefined;
    }
    const info: FileInfo = {
      snapshot,
      ...(this.host.prepare?.(snapshot) ?? {
        parsed: parse(snapshot.text, this.host.namespace),
        lines: splitLines(snapshot.text),
      }),
    };
    this.cache.set(key, info);
    return info;
  }

  private changesOf(info: FileInfo): LineChanges {
    if (!info.changes && info.snapshot.baseline === info.snapshot.text) {
      // The common case: nothing changed. Skip the diff entirely.
      info.changes = { lineCount: info.lines.length, changed: [], deletedBefore: [], identical: true };
    }
    if (!info.changes) {
      info.changes = info.snapshot.baseline === null
        ? diffLines([], info.lines)
        : diffLines(info.snapshot.baseline, info.lines);
    }
    return info.changes;
  }

  private blockChanged(info: FileInfo, block: Block): boolean {
    return rangeChanged(this.changesOf(info), block.contentStart, block.contentEnd);
  }

  private analyzeFile(info: FileInfo, inbound: Map<string, InboundRef[]>): BlockResult[] {
    const path = info.snapshot.path;
    const root = this.host.rootOf(path);
    const out: BlockResult[] = [];
    let unlabeled = 0;

    for (const block of info.parsed.blocks) {
      const id = block.label ?? `#${++unlabeled}`;
      const contentHash = hashLines(info.lines, block.contentStart, block.contentEnd);
      const changed = this.blockChanged(info, block);
      const targets: TargetResult[] = [];

      for (const target of block.targets) {
        const result = this.resolveTarget(info, block, target, root);
        targets.push(result);
        if (result.state !== 'missing-file') {
          const k = this.host.key(result.resolvedPath) + (target.label !== undefined ? `#${target.label}` : '');
          let list = inbound.get(k);
          if (!list) {
            list = [];
            inbound.set(k, list);
          }
          list.push({ sourcePath: path, block, target });
        }
      }

      let state: BlockState = 'clean';
      if (changed) {
        const stale = targets.some((t) => t.state === 'stale');
        if (!stale) {
          state = 'synced';
        } else if (this.host.isAcknowledged?.(path, id, contentHash)) {
          state = 'acknowledged';
        } else {
          state = 'pending';
        }
      }
      out.push({ path, block, id, state, contentHash, targets });
    }
    return out;
  }

  private resolveTarget(info: FileInfo, block: Block, target: Target, root: string): TargetResult {
    const sourcePath = info.snapshot.path;
    let targetInfo: FileInfo | undefined;
    let resolvedPath: string;

    if (target.path === undefined) {
      targetInfo = info;
      resolvedPath = sourcePath;
    } else {
      const candidates = targetCandidates(target.path, sourcePath, root, this.host.rootFallback ?? true);
      resolvedPath = candidates[0];
      for (const c of candidates) {
        const found = this.info(c);
        if (found) {
          targetInfo = found;
          resolvedPath = found.snapshot.path;
          break;
        }
      }
    }

    if (!targetInfo) {
      return { target, state: 'missing-file', resolvedPath };
    }

    if (target.label === undefined) {
      if (targetInfo === info) {
        // A whole-file reference to the file itself is always satisfied by
        // the edit that triggered it; harmless but pointless.
        return { target, state: 'self', resolvedPath };
      }
      return { target, state: anyChange(this.changesOf(targetInfo)) ? 'updated' : 'stale', resolvedPath };
    }

    const targetBlock = targetInfo.parsed.labels.get(target.label);
    if (!targetBlock) {
      return { target, state: 'missing-label', resolvedPath };
    }
    if (targetBlock === block) {
      return { target, state: 'self', resolvedPath, targetBlock };
    }
    const changed = this.blockChanged(targetInfo, targetBlock);
    return { target, state: changed ? 'updated' : 'stale', resolvedPath, targetBlock };
  }
}

/** FNV-1a over the guarded lines; stable across line-ending styles. */
export function hashLines(lines: readonly string[], first: number, last: number): string {
  let h = 0x811c9dc5;
  for (let i = first; i <= last && i < lines.length; i++) {
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 10;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Convenience: block counts by state. */
export function summarize(results: readonly BlockResult[]): Record<BlockState, number> & { broken: number } {
  const counts = { clean: 0, synced: 0, pending: 0, acknowledged: 0, broken: 0 };
  for (const r of results) {
    counts[r.state]++;
    if (r.targets.some((t) => t.state === 'missing-file' || t.state === 'missing-label')) {
      counts.broken++;
    }
  }
  return counts;
}
