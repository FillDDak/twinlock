import Mocha from 'mocha';
import * as path from 'path';

const FILES: Record<string, string> = {
  git: 'twinlock.test.js',
  nogit: 'twinlock.test.js',
  multiroot: 'multiroot.test.js',
  perf: 'perf.test.js',
  restricted: 'environments.test.js',
  gitmissing: 'environments.test.js',
};

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30_000, reporter: 'spec' });
  const suite = process.env.TWINLOCK_SUITE ?? 'git';
  mocha.addFile(path.join(__dirname, FILES[suite] ?? FILES.git));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
