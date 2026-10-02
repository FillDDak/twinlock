// Development-only helper that stages VS Code for each README screenshot.
// It talks to capture.ps1 through marker files in TWINLOCK_SHOTS_DIR:
//   <name>.ready  -> written here when the scene is on screen
//   <name>.done   -> written by capture.ps1 after the screenshot was taken
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const DIR = process.env.TWINLOCK_SHOTS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (id, ...args) => vscode.commands.executeCommand(id, ...args);

async function waitDone(name) {
  fs.writeFileSync(path.join(DIR, `${name}.ready`), name);
  const done = path.join(DIR, `${name}.done`);
  for (let i = 0; i < 600 && !fs.existsSync(done); i++) {
    await sleep(200);
  }
}

function ws(rel) {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, rel);
}

async function show(rel, column, line, preserveFocus = false) {
  const doc = await vscode.workspace.openTextDocument(ws(rel));
  const ed = await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, preserveFocus });
  const pos = new vscode.Position(line, 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  return ed;
}

function find(ed, needle) {
  const text = ed.document.getText();
  const idx = text.indexOf(needle);
  return ed.document.positionAt(idx);
}

async function reset() {
  await cmd('workbench.action.closeAllEditors');
  await cmd('workbench.action.closePanel');
  await cmd('notifications.clearAll');
  await sleep(300);
}

async function run() {
  if (!DIR) {
    return;
  }
  const twinlock = vscode.extensions.all.find((e) => e.packageJSON.name === 'twinlock');
  const api = await twinlock.activate();
  await sleep(2500);
  await api.model.whenIdle();

  // 1. Hero: both sides of a drifting link, the tree, problems and status bar.
  await reset();
  await cmd('workbench.view.scm');
  // Give the Linked Changes view the whole sidebar.
  await cmd('workbench.scm.history.removeView').then(undefined, () => undefined);
  await cmd('workbench.scm.removeView').then(undefined, () => undefined);
  await cmd('twinlock.links.focus');
  await show('server/settings.py', vscode.ViewColumn.Two, 8, true);
  const cfg = await show('web/src/config.ts', vscode.ViewColumn.One, 10);
  cfg.selection = new vscode.Selection(10, 0, 10, 0);
  await cmd('workbench.actions.view.problems');
  await cmd('workbench.action.focusActiveEditorGroup');
  await sleep(2500);
  await waitDone('hero');

  // 2. Hover preview on a ThenChange target.
  await reset();
  await cmd('workbench.action.closeSidebar');
  const ed2 = await show('web/src/config.ts', vscode.ViewColumn.One, 0);
  const p2 = find(ed2, '//server/settings.py');
  ed2.selection = new vscode.Selection(p2.translate(0, 6), p2.translate(0, 6));
  await sleep(800);
  await cmd('editor.action.showHover');
  await sleep(2000);
  await waitDone('hover');

  // 3. Quick fixes on a pending target.
  await reset();
  const ed3 = await show('web/src/config.ts', vscode.ViewColumn.One, 0);
  const p3 = find(ed3, '//docs/uploads.md');
  ed3.selection = new vscode.Selection(p3.translate(0, 4), p3.translate(0, 4));
  await sleep(800);
  await cmd('editor.action.quickFix');
  await sleep(2000);
  await waitDone('quickfix');
  await cmd('hideCodeActionWidget');
  await cmd('workbench.action.closeQuickOpen');

  // 4. The target side: what you see when you open the file that must follow.
  await reset();
  const ed4 = await show('server/settings.py', vscode.ViewColumn.One, 0);
  const p4 = find(ed4, 'upload_limit');
  ed4.selection = new vscode.Selection(p4, p4);
  await sleep(1500);
  await waitDone('target');

  // 5. Link Selection: pick a label for two selections in different languages.
  await reset();
  const a = await show('web/src/config.ts', vscode.ViewColumn.One, 0);
  a.selection = new vscode.Selection(8, 0, 9, 0);
  // The first step waits on its notification; don't block on it.
  void cmd('twinlock.linkSelection');
  await sleep(800);
  await cmd('notifications.clearAll');
  const b = await show('server/settings.py', vscode.ViewColumn.Two, 0);
  b.selection = new vscode.Selection(7, 0, 8, 0);
  void cmd('twinlock.linkSelection');
  await sleep(1500);
  await waitDone('link');
  await cmd('workbench.action.closeQuickOpen');
  await sleep(500);

  // 6. Diff against the baseline.
  await reset();
  await cmd('twinlock.showChanges', ws('web/src/config.ts').fsPath, 4);
  await sleep(2000);
  await waitDone('diff');

  // 7. The Get Started walkthrough.
  await reset();
  await cmd('workbench.action.openWalkthrough', `${twinlock.id}#twinlock.start`, false);
  await sleep(2500);
  await waitDone('walkthrough');

  fs.writeFileSync(path.join(DIR, 'all.done'), 'ok');
}

exports.activate = () => {
  run().catch((e) => {
    if (DIR) {
      fs.writeFileSync(path.join(DIR, 'error.txt'), String(e && e.stack ? e.stack : e));
    }
  });
};
exports.deactivate = () => {};
