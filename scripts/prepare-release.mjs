#!/usr/bin/env node
/**
 * Prepare packages for npm publishing:
 * 1. Point package main/types/exports at dist/ (built JavaScript + d.ts).
 * 2. Add os/cpu fields to platform packages so npm installs only the
 *    matching platform (esbuild-style optionalDependencies).
 *
 * Usage: node scripts/prepare-release.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const packagesDir = path.join(ROOT, 'packages');
const platformDir = path.join(ROOT, 'platform-packages');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  if (dryRun) {
    console.log(`[dry-run] ${path.relative(ROOT, file)} ->`, JSON.stringify(data, null, 2));
  } else {
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
}

for (const name of readdirSync(packagesDir)) {
  const pkgFile = path.join(packagesDir, name, 'package.json');
  const pkg = readJson(pkgFile);
  pkg.main = './dist/index.js';
  pkg.types = './dist/index.d.ts';
  pkg.exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  writeJson(pkgFile, pkg);
}

for (const name of readdirSync(platformDir)) {
  const pkgFile = path.join(platformDir, name, 'package.json');
  const pkg = readJson(pkgFile);
  const match = name.match(/^openvpn-(win32|darwin|linux)-(x64|arm64|ia32)$/);
  if (!match) continue;
  pkg.os = [match[1]];
  pkg.cpu = [match[2]];
  writeJson(pkgFile, pkg);
}
console.log('prepare-release done' + (dryRun ? ' (dry-run)' : ''));
