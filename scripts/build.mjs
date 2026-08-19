#!/usr/bin/env node
/**
 * Build every workspace package: src/*.ts -> dist/*.js + dist/*.d.ts.
 * TS 5.7+ rewrites relative `.ts` import specifiers to `.js` on emit.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.join(ROOT, 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let failed = false;
for (const name of packages) {
  const cwd = path.join(packagesDir, name);
  const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`Build failed: ${name}`);
    failed = true;
  } else {
    console.log(`Built: ${name}`);
  }
}
if (failed) process.exit(1);
