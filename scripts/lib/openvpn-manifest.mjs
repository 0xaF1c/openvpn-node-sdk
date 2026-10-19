/**
 * Shared helpers for the OpenVPN platform-package tooling.
 *
 * `openvpn-binaries.json` is the single source of truth for the OpenVPN version
 * that the platform packages ship. Everything else (package versions, os/cpu
 * metadata, optionalDependencies) is derived from it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MANIFEST_FILE = path.join(ROOT, 'openvpn-binaries.json');
export const PLATFORM_PACKAGES_DIR = path.join(ROOT, 'platform-packages');
export const SDK_PACKAGE_DIR = path.join(ROOT, 'packages', 'openvpn-sdk');

/** @typedef {{ os: string, cpu: string, source: 'vendored'|'release'|'pending', libc?: string,
 *              archive?: string|null, url?: string|null, sha256?: string|null, files: string[] }} PlatformSpec */
/** @typedef {{ version: string, packaging: number, platforms: Record<string, PlatformSpec> }} OpenVpnManifest */

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
}

/** @param {OpenVpnManifest} openvpn */
export function platformPackageVersion(openvpn) {
  return `${openvpn.version}-${openvpn.packaging}`;
}

export function platformDirName(target) {
  return `openvpn-${target}`;
}

export function platformDir(target) {
  return path.join(PLATFORM_PACKAGES_DIR, platformDirName(target));
}

export function platformPackageName(target) {
  return `@ovpn-sdk/openvpn-${target}`;
}

/** A platform is "ready" once its binaries exist (vendored in git or fetched from a release). */
export function isReady(spec) {
  return spec.source === 'vendored' || spec.source === 'release';
}

export function openvpnBinaryName(spec) {
  return spec.os === 'win32' ? 'openvpn.exe' : 'openvpn';
}

export function tapctlBinaryName() {
  return 'tapctl.exe';
}

/** Targets that have a platform-package directory on disk. */
export function platformDirsOnDisk() {
  if (!existsSync(PLATFORM_PACKAGES_DIR)) return [];
  return readdirSync(PLATFORM_PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openvpn-'))
    .map((entry) => entry.name.slice('openvpn-'.length));
}

/** Validate the manifest shape; throws on structural problems. */
export function validateManifest(manifest) {
  if (manifest?.schema !== 1) throw new Error('openvpn-binaries.json: unsupported schema, expected 1');
  const openvpn = manifest.openvpn;
  if (!openvpn || typeof openvpn !== 'object') throw new Error('openvpn-binaries.json: missing "openvpn" object');
  if (!/^\d+\.\d+\.\d+$/.test(openvpn.version ?? '')) {
    throw new Error(`openvpn-binaries.json: openvpn.version must look like X.Y.Z, got ${JSON.stringify(openvpn.version)}`);
  }
  if (!Number.isInteger(openvpn.packaging) || openvpn.packaging < 1) {
    throw new Error('openvpn-binaries.json: openvpn.packaging must be a positive integer');
  }
  const platforms = openvpn.platforms;
  if (!platforms || typeof platforms !== 'object' || Object.keys(platforms).length === 0) {
    throw new Error('openvpn-binaries.json: openvpn.platforms must not be empty');
  }
  for (const [target, spec] of Object.entries(platforms)) {
    if (!/^(win32|linux|darwin)-(x64|arm64|ia32)$/.test(target)) {
      throw new Error(`openvpn-binaries.json: unsupported platform target ${target}`);
    }
    if (!spec.os || !spec.cpu) throw new Error(`openvpn-binaries.json: ${target} needs os and cpu`);
    if (!['vendored', 'release', 'pending'].includes(spec.source)) {
      throw new Error(`openvpn-binaries.json: ${target}.source must be vendored|release|pending`);
    }
    if (!Array.isArray(spec.files) || spec.files.length === 0) {
      throw new Error(`openvpn-binaries.json: ${target}.files must be a non-empty array`);
    }
    if (isReady(spec) && spec.source === 'release' && !spec.url) {
      throw new Error(`openvpn-binaries.json: ${target} has source "release" but no url`);
    }
  }
  return openvpn;
}

/** Minimal CLI arg helper shared by the scripts. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      values.set(arg.slice(2), argv[i + 1]);
      i += 1;
    } else {
      flags.add(arg.slice(2));
    }
  }
  return {
    flags,
    has: (name) => flags.has(name),
    get: (name, fallback) => values.get(name) ?? fallback,
  };
}
