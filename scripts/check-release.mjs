// Pre-publish checks: catches the mistakes that break a Marketplace release.
//   node scripts/check-release.mjs [--allow-placeholders]
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowPlaceholders = process.argv.includes('--allow-placeholders');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const errors = [];
const warnings = [];
const placeholder = (msg) => (allowPlaceholders ? warnings : errors).push(msg);

// Identity
if (!pkg.publisher || pkg.publisher === 'your-publisher-id') {
  placeholder('package.json "publisher" is still the placeholder. Run: npm run configure -- --publisher <id> --repo <github url>');
} else if (!/^[a-z0-9][a-z0-9-]*$/i.test(pkg.publisher)) {
  errors.push(`publisher "${pkg.publisher}" may only contain letters, digits and dashes.`);
}
const repoUrl = pkg.repository?.url ?? '';
if (!repoUrl || repoUrl.includes('your-github-id')) {
  placeholder('package.json "repository.url" is still the placeholder (README images are resolved against it).');
}
for (const field of ['bugs', 'homepage']) {
  const v = typeof pkg[field] === 'string' ? pkg[field] : pkg[field]?.url;
  if (v && v.includes('your-github-id')) {
    placeholder(`package.json "${field}" is still the placeholder.`);
  }
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(pkg.name)) {
  errors.push(`name "${pkg.name}" must be lowercase letters, digits and dashes.`);
}

// Version and changelog
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  errors.push(`version "${pkg.version}" must be major.minor.patch (the Marketplace rejects pre-release suffixes).`);
}
const changelog = existsSync(join(root, 'CHANGELOG.md')) ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8') : '';
if (!changelog.includes(`## [${pkg.version}]`)) {
  errors.push(`CHANGELOG.md has no "## [${pkg.version}]" section.`);
}

// Engine vs. typings
const engine = pkg.engines?.vscode ?? '';
const types = pkg.devDependencies?.['@types/vscode'] ?? '';
const engineMin = engine.replace(/^[\^~>=]+/, '');
const typesMin = types.replace(/^[\^~>=]+/, '');
if (typesMin && engineMin && typesMin.localeCompare(engineMin, undefined, { numeric: true }) > 0) {
  errors.push(`@types/vscode (${types}) is newer than engines.vscode (${engine}); APIs may be used that older VS Code lacks.`);
}

// Icon
const iconPath = join(root, pkg.icon ?? '');
if (!pkg.icon || !existsSync(iconPath)) {
  errors.push(`icon "${pkg.icon}" does not exist.`);
} else {
  const png = readFileSync(iconPath);
  const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) {
    errors.push('icon must be a PNG (SVG icons are rejected by the Marketplace).');
  } else {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w < 128 || h < 128) {
      errors.push(`icon is ${w}x${h}; it must be at least 128x128.`);
    }
  }
}

// README images and links
for (const readme of ['README.md', 'README.ko.md']) {
  const p = join(root, readme);
  if (!existsSync(p)) {
    continue;
  }
  const text = readFileSync(p, 'utf8');
  const refs = [...text.matchAll(/(?:src|href)="([^"]+)"|\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? m[2]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|#)/.test(ref)) {
      if (ref.startsWith('http:')) {
        errors.push(`${readme}: "${ref}" must use https.`);
      }
      continue;
    }
    const file = ref.split('#')[0];
    if (file && !existsSync(join(root, file))) {
      errors.push(`${readme}: link target "${file}" does not exist.`);
    }
    if (/\.svg$/i.test(file)) {
      errors.push(`${readme}: SVG images ("${file}") are not allowed by the Marketplace.`);
    }
  }
}

// Contributions sanity
const commands = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
for (const kb of pkg.contributes?.keybindings ?? []) {
  if (!commands.has(kb.command)) {
    errors.push(`keybinding refers to unknown command ${kb.command}`);
  }
}
for (const [menu, items] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const item of items) {
    if (item.command && !commands.has(item.command)) {
      errors.push(`menu ${menu} refers to unknown command ${item.command}`);
    }
  }
}
const src = readFileSync(join(root, 'src', 'commands.ts'), 'utf8');
for (const c of commands) {
  if (!src.includes(`'${c}'`) && !['twinlock.focus'].includes(c)) {
    errors.push(`command ${c} is declared in package.json but not registered in src/commands.ts`);
  }
}

for (const w of warnings) {
  console.warn(`warning: ${w}`);
}
if (errors.length > 0) {
  for (const e of errors) {
    console.error(`error: ${e}`);
  }
  console.error(`\n${errors.length} problem(s) must be fixed before publishing.`);
  process.exit(1);
}
console.log(`Release checks passed for ${pkg.publisher}.${pkg.name}@${pkg.version}.`);
