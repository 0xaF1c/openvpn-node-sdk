#!/usr/bin/env node
/**
 * Scenario: bring up a real tunnel with your own `.ovpn` profile.
 *
 *   npm run playground:connect -- --config ./my-profile.ovpn --user alice --pass secret
 *
 * Environment fallbacks: PG_OVPN_CONFIG, PG_OVPN_USER, PG_OVPN_PASS.
 * Prints the state/log/bytecount stream, waits for CONNECTED, stays connected
 * for --hold ms, then disconnects. Ctrl-C disconnects cleanly.
 */
import { readFile } from 'node:fs/promises';
import { bold, dim, EXIT_FAIL, EXIT_SKIP, isSpawnBlocked, parseArgs, probeSpawn, Reporter, sleep, spawnBlockedHint, yellow } from './lib.mjs';
import { BinaryManager, OpenVpnClient } from 'openvpn-node-sdk';

const args = parseArgs();
const configPath = args.get('config', process.env.PG_OVPN_CONFIG);
const username = args.get('user', process.env.PG_OVPN_USER);
const password = args.get('pass', process.env.PG_OVPN_PASS);
const connectTimeoutMs = Number.parseInt(args.get('timeout', '60000'), 10);
const holdMs = Number.parseInt(args.get('hold', '5000'), 10);
const reporter = new Reporter('playground:connect');

let stopping = false;

process.on('uncaughtException', (err) => {
  if (isSpawnBlocked(err)) {
    console.log(yellow('\n SKIP spawn blocked by the environment'));
    console.log(dim(spawnBlockedHint()));
    process.exit(EXIT_SKIP);
  }
  console.error(yellow('playground:connect crashed:'), err);
  process.exit(EXIT_FAIL);
});

function usage() {
  console.log(`
${bold('playground:connect')} — connect to a real OpenVPN server

  npm run playground:connect -- --config <profile.ovpn> [--user <name>] [--pass <secret>]
                                 [--timeout <ms>] [--hold <ms>] [--no-adapter]

  --config   path to an .ovpn profile (or PG_OVPN_CONFIG)
  --user     username for auth-user-pass (or PG_OVPN_USER)
  --pass     password for auth-user-pass (or PG_OVPN_PASS)
  --timeout  how long to wait for CONNECTED (default 60000)
  --hold     how long to stay connected after CONNECTED (default 5000)
  --no-adapter  do not manage a TAP/DCO adapter (Windows only; also used for 'dev null' profiles)

${dim('On Windows, real tunnels need an elevated shell or the OpenVPN interactive service.')}`);
}

async function holdFor(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !stopping) {
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}

async function main() {
  if (!configPath) {
    usage();
    return EXIT_SKIP;
  }

  let configText;
  try {
    configText = await readFile(configPath, 'utf8');
  } catch (err) {
    reporter.fail(`cannot read profile: ${configPath}`, err instanceof Error ? err.message : String(err));
    return reporter.summary();
  }
  reporter.section('profile');
  reporter.ok(`loaded ${configPath} (${configText.length} bytes)`);
  if (username && password) {
    reporter.info(`credentials: ${username} / ${'*'.repeat(Math.max(1, password.length))}`);
  } else {
    reporter.info('no credentials supplied: an auth-user-pass profile will ask for them and time out');
  }
  if (process.platform === 'win32' && !args.has('no-adapter')) {
    reporter.info('adapter management: enabled (a TAP/DCO adapter will be created or reused)');
  } else {
    reporter.info('adapter management: disabled');
  }

  const options = {
    manageAdapter: process.platform === 'win32' && !args.has('no-adapter'),
    connectTimeoutMs,
    disconnectTimeoutMs: 10_000,
  };
  if (username && password) {
    options.credentials = async () => ({ username, password });
  }

  reporter.section('spawn capability');
  let binaryPath = null;
  try {
    binaryPath = new BinaryManager().resolveOpenVpn().path;
    reporter.ok(`openvpn resolved: ${binaryPath}`);
  } catch {
    reporter.warn('openvpn binary not resolved; the client will report it');
  }
  if (binaryPath) {
    const capability = await probeSpawn(binaryPath);
    if (capability === 'blocked') {
      console.log(yellow('\n SKIP spawn blocked by the environment'));
      console.log(dim(spawnBlockedHint()));
      return EXIT_SKIP;
    }
    if (capability === 'ok') reporter.ok('child processes with piped stdio can be spawned');
  }

  const client = new OpenVpnClient(configText, options);
  client.on('error', (err) => reporter.fail('client emitted error', err instanceof Error ? err.message : String(err)));
  client.on('state', (state) => console.log(`${dim('   state')} ${state.name} ${state.description}`));
  client.on('log', (log) => console.log(`${dim('   log  ')} ${log.level} ${log.text}`));
  client.on('bytecount', (count) => reporter.info(`bytecount in=${count.inBytes} out=${count.outBytes}`));
  client.on('auth-failed', (payload) => console.log(`${yellow('   auth ')} ${payload}`));
  client.on('credentials-required', () => console.log(`${yellow('   auth ')} credentials required (pass --user/--pass)`));

  const onSigint = () => {
    console.log(`\n${yellow('   ctrl-c')} disconnecting...`);
    stopping = true;
  };
  process.on('SIGINT', onSigint);

  let outcome = null;
  try {
    reporter.section('connect');
    const managementConnected = new Promise((resolve) => client.once('management-connected', resolve));
    await client.connect();
    await managementConnected;
    reporter.ok('management interface connected');

    try {
      await client.waitFor('CONNECTED', connectTimeoutMs);
    } catch (err) {
      reporter.fail(
        `tunnel did not reach CONNECTED within ${connectTimeoutMs}ms (last state: ${client.currentState?.name ?? 'none'})`,
        err instanceof Error ? err.message : String(err),
      );
      outcome = EXIT_FAIL;
    }

    if (outcome === null) {
      reporter.ok('tunnel is CONNECTED');
      const address = client.currentState;
      reporter.info(`local ${address?.localIpv4 || address?.localIp || '?'} remote ${address?.remoteHost}:${address?.remotePort}`);

      reporter.section('hold');
      reporter.info(`staying connected for ${holdMs}ms (ctrl-c to disconnect early)`);
      await holdFor(holdMs);
    }
  } catch (err) {
    if (isSpawnBlocked(err)) {
      console.log(yellow('\n SKIP spawn blocked by the environment'));
      console.log(dim(spawnBlockedHint()));
      outcome = EXIT_SKIP;
    } else {
      reporter.fail('connect scenario failed', err instanceof Error ? err.stack ?? err.message : String(err));
      outcome = EXIT_FAIL;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    try {
      await client.disconnect();
      console.log(dim('   disconnected'));
    } catch (err) {
      reporter.fail('disconnect failed', err instanceof Error ? err.message : String(err));
    }
  }

  return outcome === EXIT_SKIP ? EXIT_SKIP : reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:connect crashed:'), err);
    process.exitCode = EXIT_FAIL;
  });
