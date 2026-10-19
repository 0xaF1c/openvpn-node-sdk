#!/usr/bin/env node
/**
 * Build the single, self-contained `openvpn-node-sdk` package.
 *
 * 1. `tsc -p tsconfig.bundle.json` compiles every workspace package into
 *    packages/openvpn-sdk/dist/<pkg>/src/ (plain JS + declarations, no bundler
 *    required, so this also works in sandboxes that block child-process pipes).
 * 2. The emitted `@ovpn-sdk/*` import specifiers are rewritten to relative
 *    paths, so the published package has no runtime dependencies.
 * 3. The pinned OpenVPN binaries of every "ready" platform are copied into
 *    vendor/openvpn-<target>/bin/ and recorded in vendor/openvpn.json, which
 *    BinaryManager reads to resolve the binary without spawning anything.
 *
 * Usage: node scripts/build-single.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isReady, loadManifest, platformDir, ROOT, validateManifest } from './lib/openvpn-manifest.mjs';

const SDK_DIR = path.join(ROOT, 'packages', 'openvpn-sdk');
const OUT_DIR = path.join(SDK_DIR, 'dist');
const VENDOR_DIR = path.join(SDK_DIR, 'vendor');
const ENTRY_DIR = path.join(OUT_DIR, 'openvpn-sdk', 'src');
const INTERNAL_PACKAGES = new Set(['binary', 'config', 'core', 'process', 'tap']);

function runTsc() {
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (!existsSync(bin)) throw new Error(`typescript is not installed (${bin})`);
  // Windows .cmd shims can only be launched through the shell; pass one command
  // string so Node does not warn about an args array with shell:true (DEP0190).
  const command = `"${bin}" -p tsconfig.bundle.json`;
  const result = spawnSync(command, { cwd: SDK_DIR, stdio: 'inherit', shell: true });
  if (result.error) throw new Error(`failed to run ${bin}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tsc failed with exit code ${result.status}`);
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

/** Rewrite `@ovpn-sdk/<pkg>` imports/exports to relative paths inside dist/. */
function rewriteInternalSpecifiers() {
  let rewritten = 0;
  walk(OUT_DIR, (file) => {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) return;
    const source = readFileSync(file, 'utf8');
    const next = source.replace(/(['"])@ovpn-sdk\/([a-z0-9-]+)\1/g, (match, quote, name) => {
      if (!INTERNAL_PACKAGES.has(name)) throw new Error(`unexpected internal package @ovpn-sdk/${name} in ${path.relative(ROOT, file)}`);
      const target = path.join(OUT_DIR, name, 'src', 'index.js');
      let relative = path.relative(path.dirname(file), target).split(path.sep).join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      return `${quote}${relative}${quote}`;
    });
    if (next !== source) {
      writeFileSync(file, next);
      rewritten += 1;
    }
  });
  console.log(`  rewrote internal specifiers in ${rewritten} file(s)`);

  // The only allowed remaining mention is the platform-package name template in
  // binary/src/index.ts (`@ovpn-sdk/openvpn-<os>-<arch>`), never an import.
  const importPattern = /(?:from|import)\s*\(?\s*['"]@ovpn-sdk\//;
  const leftovers = [];
  walk(OUT_DIR, (file) => {
    if (!file.endsWith('.js')) return;
    if (importPattern.test(readFileSync(file, 'utf8'))) leftovers.push(path.relative(ROOT, file));
  });
  if (leftovers.length > 0) {
    throw new Error(`unrewritten @ovpn-sdk imports remain in: ${leftovers.join(', ')}`);
  }
}

function vendorBinaries(openvpn) {
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });

  const platforms = {};
  for (const [target, spec] of Object.entries(openvpn.platforms)) {
    if (!isReady(spec)) continue;
    const sourceBin = path.join(platformDir(target), 'bin');
    const destBin = path.join(VENDOR_DIR, `openvpn-${target}`, 'bin');
    mkdirSync(destBin, { recursive: true });

    for (const file of spec.files) {
      const from = path.join(sourceBin, file);
      if (!existsSync(from)) {
        throw new Error(
          `missing ${path.relative(ROOT, from)}; run: node scripts/fetch-openvpn-binaries.mjs --platform ${target} --verify-only`,
        );
      }
      const to = path.join(destBin, file);
      cpSync(from, to);
      if (spec.os !== 'win32') chmodSync(to, 0o755);
    }
    platforms[target] = { version: openvpn.version, os: spec.os, cpu: spec.cpu, files: spec.files };
    console.log(`  vendored ${spec.files.length} file(s) for ${target} (${path.relative(ROOT, destBin)})`);
  }

  if (Object.keys(platforms).length === 0) {
    console.warn('  warning: no platform has binaries (all entries are "pending"); the package will fall back to system OpenVPN');
  }
  writeFileSync(
    path.join(VENDOR_DIR, 'openvpn.json'),
    `${JSON.stringify({ openvpnVersion: openvpn.version, packaging: openvpn.packaging, platforms }, null, 2)}\n`,
  );
  return platforms;
}

function reportSize() {
  let bytes = 0;
  walk(SDK_DIR, (file) => {
    bytes += statSync(file).size;
  });
  return bytes;
}

function main() {
  const openvpn = validateManifest(loadManifest());
  console.log(`single-package build: openvpn-node-sdk (OpenVPN ${openvpn.version}, packaging ${openvpn.packaging})`);

  rmSync(OUT_DIR, { recursive: true, force: true });
  console.log('compiling');
  runTsc();
  rewriteInternalSpecifiers();

  const entry = path.join(ENTRY_DIR, 'index.js');
  const declaration = path.join(ENTRY_DIR, 'index.d.ts');
  if (!existsSync(entry) || !existsSync(declaration)) {
    throw new Error(`expected ${path.relative(ROOT, entry)} and index.d.ts to exist`);
  }
  console.log(`  entry: ${path.relative(ROOT, entry)}`);

  console.log('vendoring binaries');
  vendorBinaries(openvpn);

  const size = reportSize();
  console.log(`done: ${(size / 1024 / 1024).toFixed(2)} MiB in ${path.relative(ROOT, SDK_DIR)}`);
  console.log('next: node scripts/prepare-release.mjs --dry-run');
}

try {
  main();
} catch (err) {
  console.error(`build-single: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
