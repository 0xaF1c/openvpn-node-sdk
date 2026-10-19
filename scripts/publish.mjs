#!/usr/bin/env node
/**
 * Publish the single, self-contained `openvpn-node-sdk` package.
 *
 * Everything (@ovpn-sdk/* modules and the pinned OpenVPN binaries) is bundled
 * into dist/ + vendor/, so publishing needs no scoped packages, no organization
 * and no runtime dependencies.
 *
 *   node scripts/publish.mjs --dry-run
 *   node scripts/publish.mjs --yes [--tag latest] [--otp 123456] [--provenance]
 *
 * Preconditions: `npm run build:single && node scripts/prepare-release.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, ROOT } from './lib/openvpn-manifest.mjs';

const PACKAGE_NAME = 'openvpn-node-sdk';

const args = parseArgs();
const yes = args.has('yes');
const dryRun = !yes || args.has('dry-run');
const tag = args.get('tag', 'latest');
const otp = args.get('otp');
const provenance = args.has('provenance');

/** Quote an argv token only when it contains characters a shell could interpret. */
function shellQuote(value) {
  return /^[A-Za-z0-9@/._:=+-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

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

/** Turn npm's stderr into an actionable hint. */
function describeFailure(output) {
  if (/EOTP|one-time password/i.test(output)) {
    return 'npm requires a one-time password (2FA mode auth-and-writes): pass --otp <code>, or create a token that does not bypass 2FA';
  }
  if (/E404/.test(output) && /%2f/i.test(output)) {
    return 'the @scope is not owned by this npm account (404 on PUT): create an organization with that scope name on npmjs.com';
  }
  if (/E403|Forbidden/i.test(output)) {
    return 'the registry refused the publish (403): check that the package name is available and that you are logged in';
  }
  return 'resolve the error above';
}

function main() {
  let dir;
  try {
    dir = workspaceDir(PACKAGE_NAME);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const pkg = readJson(path.join(dir, 'package.json'));
  const entryJs = path.join(dir, 'dist', 'openvpn-sdk', 'src', 'index.js');
  const entryDts = path.join(dir, 'dist', 'openvpn-sdk', 'src', 'index.d.ts');

  const problems = [];
  if (pkg.main !== './dist/openvpn-sdk/src/index.js' || !existsSync(entryJs)) {
    problems.push('dist is missing or main does not point at it: run `npm run build:single`');
  }
  if (!existsSync(entryDts)) {
    problems.push('dist/openvpn-sdk/src/index.d.ts is missing: run `npm run build:single`');
  }
  if (!existsSync(path.join(dir, 'vendor', 'openvpn.json'))) {
    problems.push('vendor/ is missing: run `npm run build:single`');
  }
  if (Object.keys(pkg.dependencies ?? {}).length > 0 || pkg.optionalDependencies) {
    problems.push('the package still declares dependencies: run `node scripts/prepare-release.mjs` so it is published self-contained');
  }
  for (const doc of ['README.md', 'LICENSE']) {
    if (!existsSync(path.join(dir, doc))) {
      problems.push(`${doc} is missing from the package (npm shows an empty README): run \`node scripts/prepare-release.mjs\``);
    }
  }
  if (problems.length > 0) {
    console.error('cannot publish:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const command = ['publish', '--workspace', PACKAGE_NAME, '--access', 'public', '--tag', tag];
  if (otp) command.push('--otp', otp);
  if (provenance) command.push('--provenance');
  if (dryRun) command.push('--dry-run');

  console.log(`${dryRun ? 'dry-run' : 'publishing'}: ${pkg.name}@${pkg.version}, tag "${tag}"`);
  console.log(`  npm ${command.join(' ')}`);
  if (dryRun) {
    // Show what would be packed so a broken tarball is visible before publishing.
    const packed = spawnSync(`npm pack --workspace ${PACKAGE_NAME} --dry-run --json`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: process.env,
    });
    if (packed.status === 0) {
      try {
        const [info] = JSON.parse(packed.stdout);
        console.log(`\n  tarball: ${info.filename} (${info.files.length} files, ${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
        for (const file of info.files.filter((f) => f.path.startsWith('vendor/') || f.path === 'dist/openvpn-sdk/src/index.js').slice(0, 8)) {
          console.log(`    ${file.path}`);
        }
      } catch {
        // package manager output changed; the dry-run result is still valid
      }
    }
    console.log('\ndry-run complete; re-run with --yes to publish.');
    return 0;
  }

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
    console.error(`\ncannot publish: ${PACKAGE_NAME}: ${describeFailure(output)}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
