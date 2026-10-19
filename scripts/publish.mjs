#!/usr/bin/env node
/**
 * Publish the SDK packages in dependency order.
 *
 * The monorepo root is `private` on purpose: it has no entry point and must not
 * be installed. Publish the workspace packages instead.
 *
 *   node scripts/publish.mjs --dry-run
 *   node scripts/publish.mjs --yes [--tag latest] [--otp 123456] [--provenance]
 *   node scripts/publish.mjs --yes --only openvpn-node-sdk
 *
 * Accounts with 2FA mode "auth-and-writes" (see `npm profile get`) must pass a
 * fresh --otp for every package, or configure an automation token so the batch
 * can run unattended.
 *
 * Preconditions per package: `main` must point at dist/ (run
 * `npm run build && node scripts/prepare-release.mjs` first) and dist/index.js
 * must exist. Packages publish only their `dist` directory (`files: ["dist"]`),
 * because dist/ is gitignored and npm would otherwise leave it out of the tarball.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isReady, loadManifest, parseArgs, platformPackageName, ROOT, validateManifest } from './lib/openvpn-manifest.mjs';

/** Quote an argv token only when it contains characters a shell could interpret. */
function shellQuote(value) {
  return /^[A-Za-z0-9@/._:=+-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

// Internal packages first, facade last, platform packages in between.
const CORE_PACKAGES = ['@ovpn-sdk/binary', '@ovpn-sdk/process', '@ovpn-sdk/core', '@ovpn-sdk/config', '@ovpn-sdk/tap'];
const FACADE_PACKAGE = 'openvpn-node-sdk';

const args = parseArgs();
const yes = args.has('yes');
const dryRun = !yes || args.has('dry-run');
const tag = args.get('tag', 'latest');
const otp = args.get('otp');
const provenance = args.has('provenance');
const only = args.get('only');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function workspaceDir(name) {
  for (const group of ['packages', 'platform-packages']) {
    const base = path.join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(base, entry.name, 'package.json');
      if (existsSync(file) && readJson(file).name === name) return path.join(base, entry.name);
    }
  }
  throw new Error(`cannot find workspace package ${name}`);
}

function publishOrder(openvpn) {
  const platformNames = Object.entries(openvpn.platforms)
    .filter(([, spec]) => isReady(spec))
    .map(([target]) => platformPackageName(target));
  return [...CORE_PACKAGES, ...platformNames, FACADE_PACKAGE];
}

function main() {
  const openvpn = validateManifest(loadManifest());
  const rootPackage = readJson(path.join(ROOT, 'package.json'));
  if (rootPackage.private !== true) {
    console.warn('warning: the monorepo root is not marked private; `npm publish` at the root would publish the whole repo tarball.');
  }

  const order = only ? [only] : publishOrder(openvpn);
  console.log(`${dryRun ? 'dry-run' : 'publishing'} ${order.length} package(s), tag "${tag}"\n`);

  const problems = [];
  for (const name of order) {
    let dir;
    try {
      dir = workspaceDir(name);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const pkg = readJson(path.join(dir, 'package.json'));
    const isPlatformPackage = pkg.name.startsWith('@ovpn-sdk/openvpn-');
    // Platform packages ship index.js + prebuilt binaries; workspace packages ship dist/.
    const ready = isPlatformPackage
      ? existsSync(path.join(dir, 'index.js'))
      : pkg.main === './dist/index.js' && existsSync(path.join(dir, 'dist', 'index.js'));
    const label = `${pkg.name}@${pkg.version}`;
    if (!ready) {
      problems.push(
        isPlatformPackage
          ? `${label}: index.js is missing from ${path.relative(ROOT, dir)}`
          : `${label}: dist is not ready (main=${pkg.main}). Run: npm run build && node scripts/prepare-release.mjs`,
      );
      continue;
    }
    const command = ['publish', '--workspace', name, '--access', 'public', '--tag', tag];
    if (otp) command.push('--otp', otp);
    if (provenance) command.push('--provenance');
    if (dryRun) command.push('--dry-run');

    console.log(`  ${label}  (${path.relative(ROOT, dir)})`);
    console.log(`    npm ${command.join(' ')}`);
    if (dryRun) continue;

    // Run through the shell with one command string: passing an args array with
    // shell:true triggers DEP0190 and is unsafe on Windows.
    const result = spawnSync(`npm ${command.map(shellQuote).join(' ')}`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const hint = /EOTP|one-time password/i.test(output)
        ? 'npm requires a one-time password (2FA mode auth-and-writes): pass --otp <code>, or configure an automation token so the batch can run unattended'
        : 'resolve the error above';
      problems.push(`${label}: publish failed (${hint}); retry with --only ${name}`);
      break;
    }
  }

  if (problems.length > 0) {
    console.error('\ncannot publish:');
    for (const problem of problems) console.error(`  - ${problem}`);
    if (dryRun) console.error('\nrun `npm run build && node scripts/prepare-release.mjs`, then retry.');
    return 1;
  }

  console.log(dryRun ? '\ndry-run complete; re-run with --yes to publish.' : '\nall packages published.');
  return 0;
}

process.exitCode = main();
