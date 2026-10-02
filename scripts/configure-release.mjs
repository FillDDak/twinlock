// Sets the Marketplace publisher and GitHub repository in package.json.
//   npm run configure -- --publisher <publisher-id> --repo https://github.com/<user>/<repo>
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const publisher = arg('publisher');
let repo = arg('repo');
if (!publisher && !repo) {
  console.error('usage: npm run configure -- --publisher <publisher-id> --repo https://github.com/<user>/<repo>');
  process.exit(1);
}
const file = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(file, 'utf8'));
if (publisher) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(publisher)) {
    console.error(`Invalid publisher id "${publisher}" (letters, digits and dashes only).`);
    process.exit(1);
  }
  pkg.publisher = publisher;
}
if (repo) {
  repo = repo.replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(repo)) {
    console.error(`Invalid repository URL "${repo}". Expected https://github.com/<user>/<repo>.`);
    process.exit(1);
  }
  pkg.repository = { type: 'git', url: `${repo}.git` };
  pkg.bugs = { url: `${repo}/issues` };
  pkg.homepage = `${repo}#readme`;
}
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json updated: publisher=${pkg.publisher}, repository=${pkg.repository.url}`);
