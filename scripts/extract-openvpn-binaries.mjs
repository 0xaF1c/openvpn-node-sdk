#!/usr/bin/env node
/**
 * Extract OpenVPN binaries from a local OpenVPN installation into the
 * platform package. Defaults target the official Windows install layout:
 *
 *   C:\Program Files\OpenVPN\bin  ->  platform-packages/openvpn-win32-x64/bin
 *
 * Usage:
 *   node scripts/extract-openvpn-binaries.mjs [sourceDir] [targetDir]
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BS = String.fromCharCode(92);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_SOURCE = path.join('C:', BS, 'Program Files', 'OpenVPN', 'bin');
const DEFAULT_TARGET = path.join(ROOT, 'platform-packages', 'openvpn-win32-x64', 'bin');

const REQUIRED = ['openvpn.exe', 'tapctl.exe'];

async function main() {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const target = process.argv[3] ?? DEFAULT_TARGET;

  if (!existsSync(source)) {
    console.error(`Source directory not found: ${source}`);
    process.exit(1);
  }

  const entries = await readdir(source);
  const files = entries.filter((name) => name.toLowerCase().endsWith('.exe') || name.toLowerCase().endsWith('.dll'));

  await mkdir(target, { recursive: true });

  let copied = [];
  for (const file of files) {
    const from = path.join(source, file);
    const to = path.join(target, file);
    await copyFile(from, to);
    copied.push(file);
  }

  for (const required of REQUIRED) {
    if (!existsSync(path.join(target, required))) {
      console.error(`Required file missing after copy: ${required}`);
      process.exit(1);
    }
  }

  const totalBytes = await copied.reduce(async (acc, file) => (await acc) + (await stat(path.join(target, file))).size, Promise.resolve(0));
  console.log(`Copied ${copied.length} files (${(totalBytes / 1024 / 1024).toFixed(2)} MiB) from ${source}`);
  console.log(`Target: ${target}`);
  for (const file of copied.sort()) {
    const size = await stat(path.join(target, file));
    console.log(`  ${file}  ${(size.size / 1024).toFixed(1)} KiB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
