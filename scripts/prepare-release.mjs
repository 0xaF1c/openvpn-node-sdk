#!/usr/bin/env node
/**
 * Prepare the single, self-contained `openvpn-node-sdk` package for publishing.
 *
 * `npm run build:single` produces the bundled dist/ and the vendored binaries, so
 * this script only rewrites the package manifest and copies the docs:
 *   - main/types/exports -> dist/
 *   - files -> ["dist", "vendor"]
 *   - dependencies/optionalDependencies -> empty (everything is inlined/bundled)
 *   - README.md and LICENSE are copied from the repository root, because npm only
 *     picks up docs that live inside the package directory (they are gitignored)
 *
 * The script is idempotent. Revert the manifest afterwards with
 * `git checkout -- packages/openvpn-sdk/package.json`.
 *
 * Usage: node scripts/prepare-release.mjs [--dry-run]
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadManifest, ROOT, SDK_PACKAGE_DIR, validateManifest } from './lib/openvpn-manifest.mjs';

const dryRun = process.argv.includes('--dry-run');
const SDK_PACKAGE_FILE = path.join(SDK_PACKAGE_DIR, 'package.json');
const ENTRY_JS = 'dist/openvpn-sdk/src/index.js';
const ENTRY_DTS = 'dist/openvpn-sdk/src/index.d.ts';
/**
 * Elevation helper entry points. `elevate-helper.mjs` is the one hosts should
 * use (always parsed as an ES module, even when `asarUnpack`ed); the `.js` copy
 * is kept for build scripts that already reference it.
 */
const ELEVATION_HELPER_MJS = 'dist/tap/src/elevate-helper.mjs';
const ELEVATION_HELPER_JS = 'dist/tap/src/elevate-helper.js';
const REQUIRED_OUTPUTS = [
  ENTRY_JS,
  ENTRY_DTS,
  ELEVATION_HELPER_MJS,
  ELEVATION_HELPER_JS,
  'vendor/openvpn.json',
];
/** npm only includes README/LICENSE that sit inside the package directory. */
const DOC_FILES = ['README.md', 'LICENSE'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data, label) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current === next) {
    console.log(`  unchanged: ${label}`);
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] would update: ${label}`);
    return;
  }
  writeFileSync(file, next);
  console.log(`  updated: ${label}`);
}

function main() {
  const openvpn = validateManifest(loadManifest());
  console.log(`openvpn-node-sdk single package (OpenVPN ${openvpn.version})${dryRun ? ' [dry-run]' : ''}`);

  const missing = REQUIRED_OUTPUTS.filter((file) => !existsSync(path.join(SDK_PACKAGE_DIR, file)));
  if (missing.length > 0) {
    for (const file of missing) console.error(`  error: packages/openvpn-sdk/${file} is missing`);
    console.error('  run: npm run build:single');
    return 1;
  }

  const pkg = readJson(SDK_PACKAGE_FILE);

  const missingDocs = DOC_FILES.filter((name) => !existsSync(path.join(ROOT, name)));
  if (missingDocs.length > 0) {
    for (const name of missingDocs) console.error(`  error: ${name} is missing from the repository root`);
    return 1;
  }
  for (const name of DOC_FILES) {
    if (dryRun) {
      console.log(`  [dry-run] would copy: ${name}`);
      continue;
    }
    cpSync(path.join(ROOT, name), path.join(SDK_PACKAGE_DIR, name));
    console.log(`  copied: ${name}`);
  }

  const { optionalDependencies: _droppedOptional, ...rest } = pkg;
  const next = {
    ...rest,
    main: `./${ENTRY_JS}`,
    types: `./${ENTRY_DTS}`,
    exports: {
      '.': { types: `./${ENTRY_DTS}`, import: `./${ENTRY_JS}` },
      // Lets hosts (and the SDK's own resolver) locate the elevation helper with
      // `import.meta.resolve` / `require.resolve`, independent of the dist layout.
      './elevate-helper': `./${ELEVATION_HELPER_MJS}`,
      // Needed to resolve the package root (helper lookup fallback) and read
      // package metadata from host tooling.
      './package.json': './package.json',
    },
    files: ['dist', 'vendor'],
    dependencies: {},
    publishConfig: { ...(pkg.publishConfig ?? {}), access: 'public' },
  };

  writeJson(SDK_PACKAGE_FILE, next, 'openvpn-node-sdk');
  console.log('\nprepare-release done' + (dryRun ? ' (dry-run)' : ''));
  console.log('after publishing, restore the manifest: git checkout -- packages/openvpn-sdk/package.json');
  return 0;
}

process.exitCode = main();
