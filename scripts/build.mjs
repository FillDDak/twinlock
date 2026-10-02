// Bundles the extension into a single file with esbuild.
import * as esbuild from 'esbuild';
import { rmSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Never ship a stale source map from a previous development build.
rmSync('dist', { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
  legalComments: 'none',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
