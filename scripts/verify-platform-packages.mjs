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
    skip(`${target}: os/cpu are added at publish time by prepare-release.mjs`);
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

function checkOptionalDependencies(openvpn) {
  console.log('\n== optionalDependencies');
  const pkgFile = path.join(SDK_PACKAGE_DIR, 'package.json');
  if (!existsSync(pkgFile)) {
    check('openvpn-node-sdk package.json exists', false, pkgFile);
    return;
  }
  const pkg = readJson(pkgFile);
  const deps = pkg.optionalDependencies ?? {};
  const expectedVersion = platformPackageVersion(openvpn);

  for (const [target, spec] of Object.entries(openvpn.platforms)) {
    const name = platformPackageName(target);
    if (isReady(spec)) {
      check(`${name} is pinned to ${expectedVersion}`, deps[name] === expectedVersion, String(deps[name]));
    } else {
      check(`${name} is not listed while "${spec.source}"`, deps[name] === undefined, String(deps[name]));
    }
  }

  for (const [name, version] of Object.entries(deps)) {
    if (!name.startsWith('@ovpn-sdk/openvpn-')) continue;
    const target = name.slice('@ovpn-sdk/openvpn-'.length);
    if (!openvpn.platforms[target]) {
      check(`optional dependency ${name} maps to a known platform`, false, `version ${version}`);
    }
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
  if (!targetFilter) checkOptionalDependencies(openvpn);

  console.log(
    `\n${checks - failures} passed, ${failures} failed, ${warnings} warnings, ${skips} skipped` +
      (existsSync(PLATFORM_PACKAGES_DIR) ? '' : ' (platform-packages directory missing)'),
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
