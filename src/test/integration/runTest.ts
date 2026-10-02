/**
 * Launches real VS Code instances against generated fixture workspaces:
 *  - "git":   a git repository with committed files (baseline = HEAD)
 *  - "nogit": a plain folder (baseline = content at session start)
 *  - "multiroot": a git folder + a plain folder in one window
 *  - "perf": a large generated repository (run explicitly: TWINLOCK_SUITE=perf)
 *
 * Set TWINLOCK_VSCODE_VERSION (e.g. "1.85.0" or "stable") to pick the build.
 */
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FILES: Record<string, string> = {
  'src/limits.ts': [
    'export const LIMITS = {',
    '  // LINT.IfChange(upload_limit)',
    '  maxUploadMb: 10,',
    '  // LINT.ThenChange(//server/limits.py:upload_limit, //docs/limits.md)',
    '};',
    '',
  ].join('\n'),
  'server/limits.py': [
    '# LINT.IfChange(upload_limit)',
    'MAX_UPLOAD_MB = 10',
    '# LINT.ThenChange(//src/limits.ts:upload_limit)',
    '',
  ].join('\n'),
  'docs/limits.md': 'Uploads are limited to 10 MB.\n',
  'src/broken.ts': [
    '// LINT.IfChange',
    'export const x = 1;',
    '// LINT.ThenChange(//missing/file.ts, //server/limits.py:nope)',
    '',
  ].join('\n'),
  'src/syntax.ts': ['// LINT.IfChange(open)', 'export const y = 2;', ''].join('\n'),
  'src/plain.ts': 'export const plain = true;\n',
  'out/compiled.js': '// LINT.IfChange(compiled)\nexports.x = 1;\n// LINT.ThenChange(//nowhere.js)\n',
  'node_modules/dep/index.js': '// LINT.IfChange\n// LINT.ThenChange(//nowhere.js)\n',
  'src/crlf.ts': '// LINT.IfChange(crlf)\r\nexport const c = 1;\r\n// LINT.ThenChange(//docs/limits.md)\r\n',
  // Non-ASCII and spaces in paths and content.
  'docs/한글 문서.md': '<!-- LINT.IfChange(kr) -->\n업로드 제한은 10MB입니다.\n<!-- LINT.ThenChange("//src/설정 값.ts:kr") -->\n',
  'src/설정 값.ts': '// LINT.IfChange(kr)\nexport const 제한 = 10;\n// LINT.ThenChange("//docs/한글 문서.md:kr")\n',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeWorkspace(kind: 'git' | 'nogit'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twinlock-${kind}-`));
  for (const [rel, content] of Object.entries(FILES)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), JSON.stringify({ 'git.autoRepositoryDetection': false, 'git.enabled': false }, null, 2));
  if (kind === 'git') {
    // A nested repository (like a vendored clone) with its own history.
    const nested = path.join(dir, 'vendor', 'lib');
    write(path.join(nested, 'sync.ts'), '// LINT.IfChange(nested)\nexport const n = 1;\n// LINT.ThenChange(//notes.md)\n');
    write(path.join(nested, 'notes.md'), 'n is 1\n');
    initRepo(nested);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Twinlock Test');
    git(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nout/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixtures');
  }
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Twinlock Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixtures');
}

/** Two workspace folders: a git repo ("app") and a plain folder ("docs-site"). */
function makeMultiRoot(): { dir: string; launch: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinlock-multi-'));
  const a = path.join(dir, 'app');
  const b = path.join(dir, 'docs-site');
  write(path.join(a, 'src', 'flags.ts'), [
    '// LINT.IfChange(flags)',
    "export const FLAGS = ['beta', 'dark-mode'];",
    '// LINT.ThenChange(../../docs-site/flags.md, //src/other.ts)',
    '',
  ].join('\n'));
  write(path.join(a, 'src', 'other.ts'), 'export const other = 1;\n');
  write(path.join(b, 'flags.md'), '- beta\n- dark-mode\n');
  write(path.join(b, 'guide', 'page.md'), '<!-- LINT.IfChange -->\nSee flags.\n<!-- LINT.ThenChange(//flags.md) -->\n');
  initRepo(a);
  const launch = path.join(dir, 'multi.code-workspace');
  fs.writeFileSync(launch, JSON.stringify({ folders: [{ path: 'app' }, { path: 'docs-site' }], settings: { 'git.enabled': false } }, null, 2));
  return { dir, launch };
}

/** A large repository: TWINLOCK_PERF_PAIRS linked pairs plus as many plain files. */
function makePerf(): string {
  const pairs = Number(process.env.TWINLOCK_PERF_PAIRS || 1500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinlock-perf-'));
  const body = Array.from({ length: 40 }, (_, j) => `export const filler${j} = ${j};`).join('\n');
  for (let i = 0; i < pairs; i++) {
    const d = path.join(dir, `pkg${i % 50}`);
    write(path.join(d, `a${i}.ts`), `${body}\n// LINT.IfChange(v${i})\nexport const V${i} = ${i};\n// LINT.ThenChange(//pkg${i % 50}/b${i}.py:v${i})\n${body}\n`);
    write(path.join(d, `b${i}.py`), `# LINT.IfChange(v${i})\nV${i} = ${i}\n# LINT.ThenChange(//pkg${i % 50}/a${i}.ts:v${i})\n`);
    write(path.join(d, `plain${i}.ts`), `${body}\n`);
  }
  initRepo(dir);
  return dir;
}

/** Like runTests(), but without forcing --disable-workspace-trust. */
function runWithWorkspaceTrust(exe: string, root: string, testsPath: string, workspace: string, env: Record<string, string>): Promise<void> {
  const cache = path.join(root, '.vscode-test');
  const args = [
    workspace,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-extensions',
    `--extensionTestsPath=${testsPath}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensions-dir=${path.join(cache, 'extensions')}`,
    `--user-data-dir=${path.join(cache, 'user-data')}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Test run failed with code ${code}`))));
  });
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const version = process.env.TWINLOCK_VSCODE_VERSION || 'stable';
  const only = process.env.TWINLOCK_SUITE;
  const suites = only ? only.split(',') : ['git', 'nogit', 'multiroot', 'restricted', 'gitmissing'];
  let failed = 0;
  for (const kind of suites) {
    let dir: string;
    let launch: string;
    let userSettings: Record<string, unknown> | undefined;
    let trust = false;
    if (kind === 'git' || kind === 'nogit') {
      dir = launch = makeWorkspace(kind);
    } else if (kind === 'restricted') {
      dir = launch = makeWorkspace('git');
      trust = true;
      userSettings = { 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' };
    } else if (kind === 'gitmissing') {
      dir = launch = makeWorkspace('git');
      userSettings = { 'git.path': path.join(dir, 'no-such-git', process.platform === 'win32' ? 'git.exe' : 'git') };
    } else if (kind === 'multiroot') {
      ({ dir, launch } = makeMultiRoot());
    } else if (kind === 'perf') {
      dir = launch = makePerf();
    } else {
      throw new Error(`Unknown suite "${kind}"`);
    }
    console.log(`\n=== Integration suite "${kind}" on VS Code ${version} (${dir}) ===`);
    // Machine/application-scoped settings must live in the user settings of the test profile.
    const userSettingsFile = path.join(root, '.vscode-test', 'user-data', 'User', 'settings.json');
    if (userSettings) {
      fs.mkdirSync(path.dirname(userSettingsFile), { recursive: true });
      fs.writeFileSync(userSettingsFile, JSON.stringify(userSettings, null, 2));
    }
    try {
      const extensionTestsPath = path.resolve(__dirname, './suite/index');
      const env = { TWINLOCK_SUITE: kind, TWINLOCK_WORKSPACE: dir };
      if (trust) {
        // runTests() always passes --disable-workspace-trust, so launch VS Code directly.
        await runWithWorkspaceTrust(await downloadAndUnzipVSCode(version), root, extensionTestsPath, launch, env);
      } else {
        await runTests({
          version,
          extensionDevelopmentPath: root,
          extensionTestsPath,
          launchArgs: [launch, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
          extensionTestsEnv: env,
        });
      }
    } catch (e) {
      console.error(`Suite "${kind}" failed: ${e}`);
      failed++;
    } finally {
      if (userSettings) {
        fs.rmSync(userSettingsFile, { force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
