// Captures the README screenshots from a real VS Code window through the
// Chrome DevTools Protocol, so it works even while the screen is locked and
// produces identical, high-DPI images on every machine.
//
//   npm run build
//   node scripts/screenshots/capture.mjs [path/to/Code.exe]
//
// A throw-away profile is used; your own VS Code settings and extensions are untouched.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repo, 'media', 'screenshots');
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 4 / 3 };
// Height (CSS px) to keep for each scene; the rest of the window is empty.
const SCENES = { hero: 900, hover: 520, quickfix: 500, target: 330, link: 380, diff: 400, walkthrough: 900 };
const PORT = 9300 + Math.floor(Math.random() * 500);

function findCode() {
  if (process.argv[2]) {
    return process.argv[2];
  }
  const base = join(repo, '.vscode-test');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith('vscode-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const exe of ['Code.exe', 'code', 'Visual Studio Code.app/Contents/MacOS/Electron']) {
      const p = join(base, d, exe);
      if (existsSync(p)) {
        return p;
      }
    }
  }
  throw new Error('VS Code not found: run the integration tests once, or pass the executable path.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage() {
  for (let i = 0; i < 300; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /workbench/.test(t.url));
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error('VS Code workbench did not expose a DevTools target');
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : ok(msg.result);
    }
  };
  const opened = new Promise((ok, reject) => {
    ws.onopen = ok;
    ws.onerror = reject;
  });
  return {
    opened,
    send: (method, params = {}) =>
      new Promise((ok, reject) => {
        const n = ++id;
        pending.set(n, { resolve: ok, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main() {
  const code = findCode();
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'twinlock-shots-'));
  const demo = join(tmp, 'shop');
  const userData = join(tmp, 'user-data');
  const signals = join(tmp, 'signals');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(signals, { recursive: true });
  execFileSync(process.execPath, [join(repo, 'scripts', 'screenshots', 'make-demo.mjs'), demo], { stdio: 'inherit' });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'window.restoreWindows': 'none',
    'window.zoomLevel': 0,
    'editor.fontSize': 14,
    'editor.minimap.enabled': false,
    'editor.hover.delay': 100,
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.editor.empty.hint': 'hidden',
    'workbench.layoutControl.enabled': false,
    'chat.disableAIFeatures': true,
    'chat.commandCenter.enabled': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'extensions.ignoreRecommendations': true,
    'security.workspace.trust.enabled': false,
    'git.openRepositoryInParentFolders': 'never',
    'git.autofetch': false,
    'scm.showHistoryGraph': false,
  }, null, 2));

  const child = spawn(code, [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${join(tmp, 'extensions')}`,
    `--extensionDevelopmentPath=${repo}`,
    `--extensionDevelopmentPath=${join(repo, 'scripts', 'screenshots', 'helper')}`,
    `--remote-debugging-port=${PORT}`,
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--new-window',
    demo,
  ], { env: { ...process.env, TWINLOCK_SHOTS_DIR: signals }, stdio: 'ignore', detached: false });

  try {
    const client = cdp(await waitForPage());
    await client.opened;
    await client.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });
    for (const [scene, height] of Object.entries(SCENES)) {
      const deadline = Date.now() + 180_000;
      while (!existsSync(join(signals, `${scene}.ready`))) {
        if (existsSync(join(signals, 'error.txt'))) {
          throw new Error(readFileSync(join(signals, 'error.txt'), 'utf8'));
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for scene "${scene}"`);
        }
        await sleep(200);
      }
      await sleep(300);
      // Show the window title a user would see, not the development-host marker.
      await client.send('Runtime.evaluate', {
        expression: `for (const el of document.querySelectorAll('.window-title, .search-label, .window-title-text')) {
          for (const n of el.childNodes) if (n.nodeType === 3) n.textContent = n.textContent.replace('[Extension Development Host] ', '');
        }`,
      });
      const { data } = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height, scale: 1 },
      });
      const file = join(outDir, `${scene}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`saved ${file}`);
      writeFileSync(join(signals, `${scene}.done`), 'ok');
    }
    client.close();
  } finally {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    } else {
      child.kill('SIGTERM');
    }
    await sleep(1500);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
