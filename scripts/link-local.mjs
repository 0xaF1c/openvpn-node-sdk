#!/usr/bin/env node
/**
 * Link every workspace package into the global npm prefix so a local test
 * project can `npm link openvpn-node-sdk` and resolve the @ovpn-sdk/* deps.
 *
 * Usage (from the monorepo root):
 *   node scripts/link-local.mjs
 *
 * Then in your test project:
 *   npm link openvpn-node-sdk
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs = [
  ...readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(ROOT, 'packages', d.name)),
  ...readdirSync(path.join(ROOT, 'platform-packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(ROOT, 'platform-packages', d.name)),
];

let failed = false;
for (const dir of dirs) {
  const result = spawnSync('npm', ['link'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`npm link failed in ${dir}`);
    failed = true;
  } else {
    console.log(`linked ${path.basename(dir)}`);
  }
}
if (failed) process.exit(1);
console.log('\nDone. In your test project run: npm link openvpn-node-sdk');
