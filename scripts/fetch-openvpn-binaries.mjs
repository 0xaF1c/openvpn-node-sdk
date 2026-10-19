#!/usr/bin/env node
/**
 * Populate a platform package with the OpenVPN release pinned in
 * `openvpn-binaries.json`. Maintainers only — consumers never run this.
 *
 *   node scripts/fetch-openvpn-binaries.mjs --platform win32-x64 [options]
 *
 * Options
 *   --platform <target>      win32-x64 | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
 *   --source <dir|file|url>  copy from a directory, extract a local archive, or download a URL
 *   --offline                never use the network
 *   --verify-only            only check the files already in bin/ (no download, no writes)
 *   --dry-run                print what would happen, touch nothing
 *   --no-exec                skip running the binary for the --version self check
 *   --version <X.Y.Z>        assert the manifest pins exactly this version
 *
 * Exit codes: 0 success, 1 failure, 2 usage error.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadManifest,
  openvpnBinaryName,
  parseArgs,
  platformDir,
  platformPackageVersion,
  validateManifest,
} from './lib/openvpn-manifest.mjs';

const args = parseArgs();
const target = args.get('platform');
const source = args.get('source');
const offline = args.has('offline');
const verifyOnly = args.has('verify-only');
const dryRun = args.has('dry-run');
const noExec = args.has('no-exec');
const pinnedVersion = args.get('version');

/** @type {{ version: string, packaging: number, platforms: Record<string, any> }} */
let openvpn;
/** @type {any} */
let spec;

function fail(message) {
  console.error(`fetch-openvpn-binaries: ${message}`);
  return 1;
}

function usage(message) {
  console.error(`fetch-openvpn-binaries: ${message}`);
  console.error('usage: node scripts/fetch-openvpn-binaries.mjs --platform <target> [--source <dir|file|url>] [--verify-only] [--dry-run]');
  return 2;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function detectVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) return { error: result.error };
  const stdout = result.stdout ?? '';
  const match = stdout.match(/^OpenVPN (\d+\.\d+\.\d+)/m);
  return { version: match ? match[1] : null };
}

function extractArchive(archivePath, destDir) {
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit', windowsHide: true });
  if (result.error?.code === 'ENOENT') {
    throw new Error('`tar` is not available on PATH; extract the archive manually and re-run with --source <dir>');
  }
  if (result.status !== 0) {
    throw new Error(`tar failed to extract ${archivePath} (exit ${result.status})`);
  }
}

async function download(url, destFile) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${response.statusText} (${url})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destFile, buffer);
  return buffer.length;
}

async function resolveSourceDir(tempDir) {
  if (source) {
    if (/^https?:\/\//.test(source)) {
      if (offline) throw new Error('--offline was set but --source is a URL');
      const archive = path.join(tempDir, 'download.tar.gz');
      const bytes = await download(source, archive);
      console.log(`  downloaded ${bytes} bytes from ${source}`);
      if (spec.sha256) verifySha(archive);
      extractArchive(archive, tempDir);
      return tempDir;
    }
    if (!existsSync(source)) throw new Error(`--source not found: ${source}`);
    if (statSync(source).isDirectory()) return source;
    if (spec.sha256) verifySha(source);
    extractArchive(source, tempDir);
    return tempDir;
  }

  if (spec.source === 'vendored') return null; // already in the repo
  if (spec.source === 'release') {
    if (offline) throw new Error('--offline was set and this platform is not vendored');
    if (!spec.url) throw new Error(`manifest is missing "url" for ${target}`);
    if (!spec.sha256) throw new Error(`manifest is missing "sha256" for ${target}; refusing to download an unverified archive`);
    const archive = path.join(tempDir, 'download.tar.gz');
    const bytes = await download(spec.url, archive);
    console.log(`  downloaded ${bytes} bytes from ${spec.url}`);
    verifySha(archive);
    extractArchive(archive, tempDir);
    return tempDir;
  }
  throw new Error(`platform ${target} has source "${spec.source}"; pass --source <dir|archive> to populate it`);
}

function verifySha(file) {
  if (!spec.sha256) return;
  const actual = sha256File(file);
  if (actual !== spec.sha256) {
    throw new Error(`sha256 mismatch for ${file}: expected ${spec.sha256}, got ${actual}`);
  }
  console.log(`  sha256 ok (${actual})`);
}

function syncPackageMetadata(dir) {
  const pkgFile = path.join(dir, 'package.json');
  if (!existsSync(pkgFile)) throw new Error(`missing ${pkgFile}`);
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const next = {
    ...pkg,
    version: platformPackageVersion(openvpn),
    os: [spec.os],
    cpu: [spec.cpu],
    openvpnVersion: openvpn.version,
  };
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    if (dryRun) console.log(`  [dry-run] update ${path.relative(process.cwd(), pkgFile)}`);
    else writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`);
  }

  const indexPath = path.join(dir, 'index.js');
  if (existsSync(indexPath)) {
    const sourceText = readFileSync(indexPath, 'utf8');
    const nextText = sourceText.replace(/(openvpnVersion\s*=\s*['"])[^'"]+(['"])/, `$1${openvpn.version}$2`);
    if (nextText !== sourceText) {
      if (dryRun) console.log(`  [dry-run] update ${path.relative(process.cwd(), indexPath)}`);
      else writeFileSync(indexPath, nextText);
    }
  }
}

async function main() {
  if (!target) return usage('--platform is required');

  const manifest = loadManifest();
  openvpn = validateManifest(manifest);
  spec = openvpn.platforms[target];
  if (!spec) return usage(`unknown platform "${target}" (known: ${Object.keys(openvpn.platforms).join(', ')})`);

  if (pinnedVersion && pinnedVersion !== openvpn.version) {
    return fail(`manifest pins OpenVPN ${openvpn.version}, but --version ${pinnedVersion} was requested`);
  }

  const dir = platformDir(target);
  const binDir = path.join(dir, 'bin');
  console.log(`${target}: OpenVPN ${openvpn.version} (package ${platformPackageVersion(openvpn)})`);

  if (!verifyOnly && !dryRun) mkdirSync(binDir, { recursive: true });

  if (verifyOnly) {
    const missing = spec.files.filter((file) => !existsSync(path.join(binDir, file)));
    if (missing.length > 0) return fail(`bin/ is missing: ${missing.join(', ')}`);
    console.log(`  all ${spec.files.length} expected files are present`);
  } else {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ovpn-fetch-'));
    try {
      const sourceDir = await resolveSourceDir(tempDir);
      if (sourceDir) {
        const missing = spec.files.filter((file) => !existsSync(path.join(sourceDir, file)));
        if (missing.length > 0) {
          return fail(`source is missing: ${missing.join(', ')} (looked in ${sourceDir})`);
        }
        for (const file of spec.files) {
          const from = path.join(sourceDir, file);
          const to = path.join(binDir, file);
          if (dryRun) console.log(`  [dry-run] copy ${file}`);
          else copyFileSync(from, to);
          if (!dryRun && spec.os !== 'win32') chmodSync(to, 0o755);
        }
        console.log(
          dryRun
            ? `  [dry-run] would install ${spec.files.length} files into ${path.relative(process.cwd(), binDir)}`
            : `  installed ${spec.files.length} files into ${path.relative(process.cwd(), binDir)}`,
        );
      } else {
        console.log('  platform is vendored; nothing to copy (use --verify-only to check)');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  if (dryRun) return 0;

  syncPackageMetadata(dir);

  if (noExec) {
    console.log('  skipping --version self check (--no-exec)');
    return 0;
  }
  const binary = path.join(binDir, openvpnBinaryName(spec));
  if (!existsSync(binary)) return fail(`missing ${binary}`);
  const detected = detectVersion(binary);
  if (detected.error) {
    if (detected.error.code === 'EPERM') {
      console.warn(`  WARN spawn blocked (EPERM); skipping --version self check for ${binary}`);
      return 0;
    }
    return fail(`failed to run ${binary}: ${detected.error.message}`);
  }
  if (detected.version !== openvpn.version) {
    return fail(`${binary} reports OpenVPN ${detected.version}, but the manifest pins ${openvpn.version}`);
  }
  console.log(`  self check ok: ${path.basename(binary)} reports OpenVPN ${detected.version}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`fetch-openvpn-binaries: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
