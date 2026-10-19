#!/usr/bin/env node
/**
 * Verify that every platform package matches `openvpn-binaries.json`.
 *
 *   node scripts/verify-platform-packages.mjs [--platform <target>] [--no-exec] [--strict]
 *
 *   --platform <target>  only check one target (e.g. win32-x64)
 *   --no-exec            do not run the binaries (cross-platform CI / restricted sandboxes)
 *   --strict             fail on "pending" platforms and missing executables (release gate)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isReady,
  loadManifest,
  parseArgs,
  platformDir,
  platformDirsOnDisk,
  platformPackageName,
  platformPackageVersion,
  PLATFORM_PACKAGES_DIR,
  SDK_PACKAGE_DIR,
  validateManifest,
} from './lib/openvpn-manifest.mjs';

const args = parseArgs();
const targetFilter = args.get('platform');
const noExec = args.has('no-exec');
const strict = args.has('strict');

let checks = 0;
let failures = 0;
let warnings = 0;
let skips = 0;

const green = (text) => (process.stdout.isTTY ? `\x1b[32m${text}\x1b[0m` : text);
const red = (text) => (process.stdout.isTTY ? `\x1b[31m${text}\x1b[0m` : text);
const yellow = (text) => (process.stdout.isTTY ? `\x1b[33m${text}\x1b[0m` : text);

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`${green('  PASS')} ${label}`);
    return true;
  }
  failures += 1;
  console.log(`${red('  FAIL')} ${label}`);
  if (detail) console.log(`${red('       ')} ${detail}`);
  return false;
}

function warn(message) {
  warnings += 1;
  console.log(`${yellow('  WARN')} ${message}`);
}

function skip(message) {
  skips += 1;
  console.log(`${yellow('  SKIP')} ${message}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function detectVersion(binaryPath) {
  try {
    const stdout = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const match = stdout.match(/^OpenVPN (\d+\.\d+\.\d+)/m);
    return { version: match ? match[1] : null };
  } catch (err) {
    return { error: err };
  }
}

function checkTarget(openvpn, target) {
  const spec = openvpn.platforms[target];
  const dir = platformDir(target);
  const expectedVersion = platformPackageVersion(openvpn);

  console.log(`\n== ${target}`);

  if (!existsSync(dir)) {
    check(`${target}: platform package directory exists`, false, dir);
    return;
  }
  check(`${target}: platform package directory exists`, true);

  const pkgFile = path.join(dir, 'package.json');
  if (!existsSync(pkgFile)) {
    check(`${target}: package.json exists`, false, pkgFile);
    return;
  }
  const pkg = readJson(pkgFile);

  check(`${target}: package name is ${platformPackageName(target)}`, pkg.name === platformPackageName(target), String(pkg.name));
  check(`${target}: version is ${expectedVersion}`, pkg.version === expectedVersion, String(pkg.version));
  check(`${target}: openvpnVersion is ${openvpn.version}`, pkg.openvpnVersion === openvpn.version, String(pkg.openvpnVersion));

  // os/cpu are injected into the published tarball by prepare-release.mjs. Keeping
  // them in the repo package.json makes `npm install` fail with EBADPLATFORM for
  // the workspace links of every other platform.
  if (Array.isArray(pkg.os) || Array.isArray(pkg.cpu)) {
    check(`${target}: os is ${spec.os}`, pkg.os?.length === 1 && pkg.os[0] === spec.os, JSON.stringify(pkg.os));
    check(`${target}: cpu is ${spec.cpu}`, pkg.cpu?.length === 1 && pkg.cpu[0] === spec.cpu, JSON.stringify(pkg.cpu));
  } else {
    skip(`${target}: os/cpu are not used by the single-package build (binaries are vendored)`);
  }

  const indexPath = path.join(dir, 'index.js');
  if (!existsSync(indexPath)) {
    check(`${target}: index.js exists`, false, indexPath);
  } else {
    const indexSource = readFileSync(indexPath, 'utf8');
    const pinned = indexSource.match(/openvpnVersion\s*=\s*['"]([^'"]+)['"]/);
    check(`${target}: index.js exposes openvpnVersion ${openvpn.version}`, pinned?.[1] === openvpn.version, String(pinned?.[1]));
  }

  if (!isReady(spec)) {
    if (strict) check(`${target}: binaries are present (source is "${spec.source}")`, false);
    else skip(`${target}: pending platform (source "${spec.source}"), binaries not required`);
    return;
  }

  const binDir = path.join(dir, 'bin');
  for (const file of spec.files) {
    const filePath = path.join(binDir, file);
    check(`${target}: bin/${file} exists`, existsSync(filePath), filePath);
  }

  if (noExec) {
    skip(`${target}: skipping --version check (--no-exec)`);
    return;
  }
  if (spec.os !== process.platform) {
    skip(`${target}: skipping --version check (host is ${process.platform})`);
    return;
  }

  const openvpnExe = path.join(binDir, spec.os === 'win32' ? 'openvpn.exe' : 'openvpn');
  if (!existsSync(openvpnExe)) return;
  const detected = detectVersion(openvpnExe);
  if (detected.error) {
    if (detected.error.code === 'EPERM') {
      warn(`${target}: spawn blocked (EPERM), skipping --version check`);
    } else {
      check(`${target}: ${path.basename(openvpnExe)} --version runs`, false, detected.error.message);
    }
    return;
  }
  check(`${target}: binary reports OpenVPN ${openvpn.version}`, detected.version === openvpn.version, String(detected.version));
}

function checkSinglePackageMetadata(openvpn) {
  console.log('\n== single-package metadata');
  const pkgFile = path.join(SDK_PACKAGE_DIR, 'package.json');
  if (!existsSync(pkgFile)) {
    check('openvpn-node-sdk package.json exists', false, pkgFile);
    return;
  }
  const pkg = readJson(pkgFile);
  const platformDependencies = Object.entries(pkg.optionalDependencies ?? {}).filter(([name]) => name.startsWith('@ovpn-sdk/'));
  check(
    'openvpn-node-sdk does not declare scoped platform packages',
    platformDependencies.length === 0,
    JSON.stringify(platformDependencies),
  );

  const vendorMeta = path.join(SDK_PACKAGE_DIR, 'vendor', 'openvpn.json');
  if (!existsSync(vendorMeta)) {
    skip('vendor/ is not built (run `npm run build:single` to check the bundled binaries)');
    return;
  }
  const meta = readJson(vendorMeta);
  for (const [target, spec] of Object.entries(openvpn.platforms)) {
    if (!isReady(spec)) continue;
    check(`vendor contains ${target}`, meta.platforms?.[target] !== undefined);
    check(
      `vendor ${target} pins ${openvpn.version}`,
      meta.platforms?.[target]?.version === openvpn.version,
      String(meta.platforms?.[target]?.version),
    );
  }
}

function checkDiskOnlyTargets(openvpn) {
  for (const target of platformDirsOnDisk()) {
    if (!openvpn.platforms[target]) {
      check(`${platformDirName(target)} is declared in openvpn-binaries.json`, false);
    }
  }
}

function main() {
  const manifest = loadManifest();
  const openvpn = validateManifest(manifest);

  const targets = targetFilter ? [targetFilter] : Object.keys(openvpn.platforms);
  if (targetFilter && !openvpn.platforms[targetFilter]) {
    check(`platform ${targetFilter} is declared in openvpn-binaries.json`, false);
    return 1;
  }

  console.log(`verifying platform packages against openvpn-binaries.json (OpenVPN ${openvpn.version}-${openvpn.packaging})`);
  for (const target of targets) checkTarget(openvpn, target);
  checkDiskOnlyTargets(openvpn);
  if (!targetFilter) checkSinglePackageMetadata(openvpn);

  console.log(
    `\n${checks - failures} passed, ${failures} failed, ${warnings} warnings, ${skips} skipped` +
      (existsSync(PLATFORM_PACKAGES_DIR) ? '' : ' (platform-packages directory missing)'),
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
