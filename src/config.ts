import * as vscode from 'vscode';

export type Severity = 'error' | 'warning' | 'information' | 'hint';

export interface TwinlockConfig {
  enable: boolean;
  namespace: string;
  baseRef: string;
  useMergeBase: boolean;
  pendingSeverity: Severity;
  codeLens: boolean;
  decorations: boolean;
  exclude: string[];
  maxFileSizeKB: number;
  maxFiles: number;
  rootFallback: boolean;
  commentSyntax: Record<string, string>;
  useGit: boolean;
  statusBar: boolean;
}

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/bower_components/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.vscode-test/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/coverage/**',
];

export function readConfig(scope?: vscode.ConfigurationScope): TwinlockConfig {
  const c = vscode.workspace.getConfiguration('twinlock', scope);
  const namespace = String(c.get('directiveNamespace', 'LINT')).trim();
  return {
    enable: c.get('enable', true),
    namespace: /^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace) ? namespace : 'LINT',
    baseRef: String(c.get('baseRef', 'HEAD')).trim() || 'HEAD',
    useMergeBase: c.get('useMergeBase', true),
    pendingSeverity: c.get<Severity>('pendingSeverity', 'warning'),
    codeLens: c.get('codeLens.enabled', true),
    decorations: c.get('decorations.enabled', true),
    exclude: c.get<string[]>('exclude', DEFAULT_EXCLUDE).filter((x) => typeof x === 'string' && x.length > 0),
    maxFileSizeKB: Math.max(1, c.get('maxFileSizeKB', 1024)),
    maxFiles: Math.max(1, c.get('maxFiles', 50000)),
    rootFallback: c.get('resolveBarePathsFromRoot', true),
    commentSyntax: c.get<Record<string, string>>('commentSyntax', {}) ?? {},
    useGit: c.get('git.enabled', true),
    statusBar: c.get('statusBar.enabled', true),
  };
}

export function toDiagnosticSeverity(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

export { DEFAULT_EXCLUDE };
