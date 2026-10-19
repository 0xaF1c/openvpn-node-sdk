#!/usr/bin/env node
/**
 * Scenario: environment + packaging self-check (offline, no spawning).
 *
 * Verifies that the workspace resolves like a real consumer (`openvpn-node-sdk`
 * by package name), that the public surface is complete, where the binaries
 * come from, and what argv the SDK would build. Runs anywhere; never launches
 * OpenVPN, so it is safe under a confined sandbox/CI.
 *
 *   npm run playground:check
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPlatformPackageName } from '@ovpn-sdk/binary';
import {
  AdapterManager,
  BinaryManager,
  escapeArg,
  getFreePort,
  ManagementClient,
  ManagementServer,
  MockManagementServer,
  OpenVpnClient,
  OpenVpnServer,
  OvpnConfig,
  parseStatusText,
  buildOpenVpnArgs,
} from 'openvpn-node-sdk';
import { bold, dim, green, Reporter, resolveBinaries, yellow, EXIT_FAIL } from './lib.mjs';

const MIN_NODE = [22, 18, 0];

function parseNodeVersion(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function isAtLeast(actual, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = actual[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

const reporter = new Reporter('playground:check');
const platformPackage = getPlatformPackageName();
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const platformBinDir = fileURLToPath(new URL(`../../platform-packages/${platformPackage.replace('@ovpn-sdk/', '')}/bin/`, import.meta.url));

async function main() {
  console.log(bold(`playground self-check  ${dim(`(${repoRoot})`)}`));

  reporter.section('runtime');
  reporter.info(`node      : ${process.version}`);
  reporter.info(`platform  : ${process.platform}/${process.arch}`);
  reporter.info(`cwd       : ${process.cwd()}`);
  reporter.expect(
    isAtLeast(parseNodeVersion(process.versions.node), MIN_NODE),
    `node >= ${MIN_NODE.join('.')} (required by the SDK engines field)`,
    `running ${process.version}`,
  );

  reporter.section('package resolution');
  let resolvedEntry = '';
  try {
    resolvedEntry = fileURLToPath(import.meta.resolve('openvpn-node-sdk'));
  } catch (err) {
    reporter.info(dim(String(err)));
  }
  reporter.expect(
    resolvedEntry.endsWith('packages/openvpn-sdk/src/index.ts') || resolvedEntry.endsWith('packages\\openvpn-sdk\\src\\index.ts'),
    'openvpn-node-sdk resolves to the workspace source entry',
    resolvedEntry || 'unresolved',
  );
  reporter.info(`entry     : ${resolvedEntry || '(unresolved)'}`);

  reporter.section('public API surface');
  const surface = {
    OpenVpnClient,
    OpenVpnServer,
    OvpnConfig,
    BinaryManager,
    AdapterManager,
    ManagementClient,
    ManagementServer,
    MockManagementServer,
    parseStatusText,
    escapeArg,
    getFreePort,
    buildOpenVpnArgs,
  };
  for (const [name, value] of Object.entries(surface)) {
    reporter.expect(typeof value === 'function', `export ${name} is a function`, `got ${typeof value}`);
  }

  reporter.section('binary resolution');
  const report = await resolveBinaries(BinaryManager, { tapctl: true });
  for (const error of report.errors) {
    reporter.fail(`binary resolution failed: ${error}`, 'Install OpenVPN or set OPENVPN_BINARY/TAPCTL_BINARY.');
  }
  if (report.openvpn) {
    reporter.ok(`openvpn resolved via ${report.openvpn.source}`);
    reporter.info(`          ${report.openvpn.path}`);
    if (report.version) {
      reporter.ok(`openvpn version ${report.version} (from ${report.versionSource})`);
    } else {
      reporter.warn('openvpn version unknown (no platform package metadata and --version could not be read)');
    }
  }
  if (process.platform === 'win32') {
    if (report.tapctl) {
      reporter.ok(`tapctl resolved via ${report.tapctl.source}`);
      reporter.info(`          ${report.tapctl.path}`);
    } else {
      reporter.warn('tapctl not resolved (Windows adapter scenarios will be skipped)');
    }
  } else {
    reporter.skip(`tapctl is Windows-only (running on ${process.platform})`);
  }

  reporter.section('bundled platform package');
  reporter.info(`package   : ${platformPackage}`);
  if (existsSync(platformBinDir)) {
    const files = readdirSync(platformBinDir).sort();
    reporter.ok(`platform package bin/ exists (${files.length} entries)`);
    reporter.info(`          ${files.join(', ') || '(empty)'}`);
    if (process.platform === 'win32') {
      reporter.expect(files.includes('openvpn.exe'), 'bundled openvpn.exe present');
      reporter.expect(files.includes('tapctl.exe'), 'bundled tapctl.exe present');
    }
  } else {
    reporter.warn(`placeholder platform package (${platformBinDir} is missing)`);
  }

  reporter.section('argv the SDK would build (no spawn)');
  const args = buildOpenVpnArgs({
    binary: report.openvpn?.path ?? 'openvpn.exe',
    configFile: '<temp>/client.ovpn',
    managementPort: 5555,
  });
  console.log(`${dim('   ')}${args.join(' ')}`);
  reporter.expect(args.includes('--management-hold'), 'argv contains --management-hold');
  reporter.expect(args.includes('--management-query-passwords'), 'argv contains --management-query-passwords');
  reporter.expect(args.includes('--management') && args.includes('5555'), 'argv wires the management socket');

  reporter.section('config builder');
  const text = new OvpnConfig().client().remote('vpn.example.com', 1194, 'udp').devNode('Playground Adapter').authUserPass().toString();
  reporter.expect(text.startsWith('client\n'), 'OvpnConfig emits a client config');
  reporter.expect(text.includes('dev-node "Playground Adapter"'), 'dev-node arguments are quoted');
  console.log(`${dim('   ')}${text.trim().replaceAll('\n', ' | ')}`);

  if (reporter.failed === 0) {
    console.log(`\n${green('Environment looks good.')} Next: ${bold('npm run playground')}`);
  }
  return reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:check crashed:'), err);
    process.exitCode = EXIT_FAIL;
  });
