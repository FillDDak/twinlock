// Creates the demo repository used for README screenshots.
// Usage: node scripts/screenshots/make-demo.mjs <target-dir>
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: make-demo.mjs <target-dir>');
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const files = {
  'server/settings.py': `"""Server-side limits shared with the web client."""

# LINT.IfChange(upload_limit)
MAX_UPLOAD_MB = 25
ALLOWED_TYPES = ("image/png", "image/jpeg", "application/pdf")
# LINT.ThenChange(//web/src/config.ts:upload_limit, //docs/uploads.md)

REQUEST_TIMEOUT_S = 30
`,
  'server/models.py': `from enum import Enum


class OrderStatus(str, Enum):
    # LINT.IfChange(order_status)
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"
    # LINT.ThenChange(//web/src/types.ts:order_status)
`,
  'web/src/config.ts': `export const config = {
  apiBase: '/api/v2',

  // LINT.IfChange(upload_limit)
  maxUploadMb: 25,
  allowedTypes: ['image/png', 'image/jpeg', 'application/pdf'],
  // LINT.ThenChange(//server/settings.py:upload_limit, //docs/uploads.md)

  requestTimeoutS: 30,
};
`,
  'web/src/types.ts': `// LINT.IfChange(order_status)
export type OrderStatus = 'pending' | 'paid' | 'shipped';
// LINT.ThenChange(//server/models.py:order_status)

export interface Order {
  id: string;
  status: OrderStatus;
}
`,
  'web/src/codec.ts': `// LINT.IfChange(encode)
export function encode(order: { id: string; total: number }): string {
  return [order.id, order.total.toFixed(2)].join('|');
}
// LINT.ThenChange(:decode)

// LINT.IfChange(decode)
export function decode(line: string): { id: string; total: number } {
  const [id, total] = line.split('|');
  return { id, total: Number(total) };
}
// LINT.ThenChange(:encode)
`,
  'docs/uploads.md': `# Uploads

Files up to **25 MB** can be uploaded.
Supported types: PNG, JPEG and PDF.
`,
  'README.md': '# Shop\n\nDemo project for Twinlock screenshots.\n',
};

for (const [rel, content] of Object.entries(files)) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 'demo@example.com');
git('config', 'user.name', 'Demo');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'Initial commit');

// Uncommitted work: the client limit changed, the server did not (yet).
const edit = (rel, from, to) => {
  const p = join(dir, rel);
  writeFileSync(p, files[rel].replace(from, to));
};
edit('web/src/config.ts', "maxUploadMb: 25,\n  allowedTypes: ['image/png', 'image/jpeg', 'application/pdf'],", "maxUploadMb: 50,\n  allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],");
// ...while the enum was updated on both sides.
edit('web/src/types.ts', "'shipped';", "'shipped' | 'refunded';");
edit('server/models.py', 'SHIPPED = "shipped"\n', 'SHIPPED = "shipped"\n    REFUNDED = "refunded"\n');
console.log(`demo repository created in ${dir}`);
