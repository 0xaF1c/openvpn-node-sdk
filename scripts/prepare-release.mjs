#!/usr/bin/env node
/**
 * Prepare packages for npm publishing. Everything version/platform related is
 * derived from `openvpn-binaries.json`; this script is idempotent.
 *
 * 1. Platform packages: sync `version` (<openvpn>-<packaging>), `os`, `cpu`
 *    and `openvpnVersion` from the manifest.
 * 2. openvpn-node-sdk: pin `optionalDependencies` to the platforms that
 *    actually ship binaries (source "vendored" or "release").
 * 3. Every workspace package: point main/types/exports at dist/.
 *
 * Usage: node scripts/prepare-release.mjs [--dry-run]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isReady,
  loadManifest,
  platformDir,
  platformDirName,
  platformDirsOnDisk,
  platformPackageName,
  platformPackageVersion,
  ROOT,
  SDK_PACKAGE_DIR,
  validateManifest,
} from './lib/openvpn-manifest.mjs';

const dryRun = process.argv.includes('--dry-run');
const packagesDir = path.join(ROOT, 'packages');

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
  const expectedVersion = platformPackageVersion(openvpn);

  console.log(`OpenVPN ${openvpn.version} (platform packages ${expectedVersion})${dryRun ? ' [dry-run]' : ''}`);

  // Every directory on disk must be declared in the manifest, otherwise its
  // os/cpu metadata would drift away from the pinned version.
  const declared = new Set(Object.keys(openvpn.platforms));
  for (const target of platformDirsOnDisk()) {
    if (!declared.has(target)) {
      console.error(`  error: ${platformDirName(target)} exists on disk but is not declared in openvpn-binaries.json`);
      return 1;
    }
  }

  console.log('\nplatform packages');
  for (const [target, spec] of Object.entries(openvpn.platforms)) {
    const dir = platformDir(target);
    const pkgFile = path.join(dir, 'package.json');
    if (!existsSync(pkgFile)) {
      console.error(`  error: missing ${path.relative(ROOT, pkgFile)} (declared platform "${target}")`);
      return 1;
    }
    const pkg = readJson(pkgFile);
    writeJson(
      pkgFile,
      {
        ...pkg,
        version: expectedVersion,
        os: [spec.os],
        cpu: [spec.cpu],
        openvpnVersion: openvpn.version,
      },
      `${platformPackageName(target)} (source: ${spec.source})`,
    );
  }

  // Only platforms with real binaries become optional dependencies.
  console.log('\nopenvpn-node-sdk optionalDependencies');
  const sdkPackageFile = path.join(SDK_PACKAGE_DIR, 'package.json');
  const sdkPackage = readJson(sdkPackageFile);
  const otherOptionalDependencies = Object.fromEntries(
    Object.entries(sdkPackage.optionalDependencies ?? {}).filter(([name]) => !name.startsWith('@ovpn-sdk/openvpn-')),
  );
  const platformDependencies = {};
  for (const [target, spec] of Object.entries(openvpn.platforms)) {
    if (isReady(spec)) platformDependencies[platformPackageName(target)] = expectedVersion;
  }
  writeJson(
    sdkPackageFile,
    { ...sdkPackage, optionalDependencies: { ...otherOptionalDependencies, ...platformDependencies } },
    'openvpn-node-sdk',
  );

  // Point every workspace package at the compiled output.
  console.log('\npackage entry points');
  for (const name of readdirSync(packagesDir)) {
    const pkgFile = path.join(packagesDir, name, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = readJson(pkgFile);
    writeJson(
      pkgFile,
      {
        ...pkg,
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      },
      pkg.name,
    );
  }

  console.log('\nprepare-release done' + (dryRun ? ' (dry-run)' : ''));
  return 0;
}

process.exitCode = main();
