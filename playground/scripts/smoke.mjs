#!/usr/bin/env node
/**
 * Scenario: real-OpenVPN smoke test (no VPN server required).
 *
 * Spawns the resolved `openvpn` binary with a throwaway `dev null` config,
 * connects to its management socket, releases the management hold, confirms a
 * state notification and a `pid` round trip, then shuts down cleanly.
 *
 *   npm run playground:smoke -- --dry-run   # print binary/config/argv only
 *   npm run playground:smoke               # spawn the real binary
 *
 * Sandboxes that block piped child stdio (EPERM) exit with code 2.
 */
import { dim, EXIT_FAIL, EXIT_SKIP, isSpawnBlocked, onceEvent, parseArgs, probeSpawn, Reporter, resolveBinaries, spawnBlockedHint, yellow } from './lib.mjs';
import { BinaryManager, OpenVpnClient, OvpnConfig, buildOpenVpnArgs } from 'openvpn-node-sdk';

const args = parseArgs();
const dryRun = args.has('dry-run');
const timeoutMs = Number.parseInt(args.get('timeout', '20000'), 10);
const reporter = new Reporter('playground:smoke');

// A blocked spawn surfaces as an unhandled ChildProcess 'error' event, so map it
// to the documented "environment not capable" exit code instead of a stack trace.
process.on('uncaughtException', (err) => {
  if (isSpawnBlocked(err)) {
    console.log(yellow('\n SKIP spawn blocked by the environment'));
    console.log(dim(spawnBlockedHint()));
    process.exit(EXIT_SKIP);
  }
  console.error(yellow('playground:smoke crashed:'), err);
  process.exit(EXIT_FAIL);
});

// Throwaway config: never touches a TAP adapter and never needs a real server.
const PEER_FP = '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff';

function buildConfig() {
  return new OvpnConfig()
    .client()
    .dev('null')
    .remote('127.0.0.1', 9, 'udp')
    .raw('nobind')
    .raw('connect-retry-max', '1')
    .raw('peer-fingerprint', PEER_FP)
    .authUserPass()
    .toString();
}

async function main() {
  const report = await resolveBinaries(BinaryManager);
  for (const error of report.errors) {
    reporter.fail('binary resolution failed', error);
    return reporter.summary();
  }
  const binary = report.openvpn;

  reporter.section('resolved binary');
  reporter.ok(`openvpn found via ${binary.source}`);
  reporter.info(binary.path);
  if (report.version) reporter.info(`version ${report.version}`);
  else reporter.warn('version unknown (piped child stdout is blocked here, but the binary exists)');

  const config = buildConfig();
  const argv = buildOpenVpnArgs({ binary: binary.path, configFile: '<temp>/client.ovpn', managementPort: 0 });

  reporter.section('dry run');
  reporter.ok('config generated');
  for (const line of config.trimEnd().split('\n')) console.log(dim(`   ${line}`));
  reporter.ok('argv generated');
  reporter.info(argv.join(' '));
  reporter.expect(argv.includes('--management-hold'), 'argv holds the tunnel until the management client releases it');
  reporter.expect(argv.includes('--management-query-passwords'), 'argv asks the management client for credentials');

  if (dryRun) {
    reporter.info(dim('   --dry-run: not spawning. Remove the flag to exercise the real binary.'));
    return reporter.summary();
  }

  reporter.section('spawn capability');
  const capability = await probeSpawn(binary.path);
  if (capability === 'blocked') {
    console.log(yellow('\n SKIP spawn blocked by the environment'));
    console.log(dim(spawnBlockedHint()));
    return EXIT_SKIP;
  }
  if (capability === 'ok') reporter.ok('child processes with piped stdio can be spawned');
  else reporter.warn('spawn capability probe failed unexpectedly; continuing anyway');

  reporter.section('real process');
  const client = new OpenVpnClient(config, {
    binary: binary.path,
    manageAdapter: false,
    connectTimeoutMs: timeoutMs,
    disconnectTimeoutMs: 10_000,
    credentials: async () => ({ username: 'playground', password: 'playground' }),
  });

  const stateNames = [];
  client.on('state', (state) => {
    stateNames.push(state.name);
    console.log(`${dim('   state')} ${state.name} ${state.description}`);
  });
  client.on('log', (log) => console.log(`${dim('   log  ')} ${log.level} ${log.text}`));
  client.on('error', (err) => reporter.fail('client emitted error', err instanceof Error ? err.message : String(err)));

  try {
    const connected = onceEvent(client, 'management-connected', timeoutMs);
    // If connect() fails first (e.g. spawn EPERM) this promise would reject later
    // as an unhandled rejection, masking the real cause.
    connected.catch(() => {});
    await client.connect();
    await connected;
    reporter.ok('management socket connected and init sequence completed');
    reporter.expect(!client.currentState || client.currentState.name !== 'CONNECTED', 'process waits in --management-hold before release');

    const pid = await client.sendManagement('pid');
    reporter.expect(/pid=\d+/.test(pid.success ?? ''), 'pid command round-tripped', pid.success ?? '');

    const firstState = onceEvent(client, 'state', timeoutMs);
    await client.sendManagement('hold release');
    reporter.ok('hold release accepted (the SDK does not send this for you)');
    const [state] = await firstState;
    reporter.expect(typeof state.name === 'string' && state.name.length > 0, `state notification received: ${state.name}`);

    await client.disconnect();
    reporter.ok('disconnect completed');
    reporter.expect(client.states.length >= 1, 'state history was recorded');
    reporter.info(`states: ${stateNames.join(' -> ') || '(none)'}`);
    return reporter.summary();
  } catch (err) {
    if (isSpawnBlocked(err)) {
      console.log(yellow('\n SKIP spawn blocked by the environment'));
      console.log(dim(spawnBlockedHint()));
      return EXIT_SKIP;
    }
    reporter.fail('real smoke test failed', err instanceof Error ? err.stack ?? err.message : String(err));
    return reporter.summary();
  } finally {
    if (client.currentState !== null || stateNames.length > 0) {
      try {
        await client.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:smoke crashed:'), err);
    process.exitCode = EXIT_FAIL;
  });
