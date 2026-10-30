#!/usr/bin/env node
/**
 * Scenario: Windows TAP / DCO adapter management through `tapctl.exe`.
 *
 *   npm run playground:adapters list
 *   npm run playground:adapters ensure [--hwid auto|ovpn-dco|tap0901] [--name <name>] [--release]
 *   npm run playground:adapters release <guid-or-name>
 *
 * Non-Windows hosts exit with code 2. `tapctl.exe` requires administrator
 * rights, so when the shell is not elevated the first command shows a UAC
 * prompt and the operation runs through the elevated helper.
 */
import { AdapterManager, BinaryManager, ElevatedBroker, ElevationError } from 'openvpn-node-sdk';
import { bold, dim, EXIT_FAIL, EXIT_SKIP, isSpawnBlocked, parseArgs, Reporter, spawnBlockedHint, yellow } from './lib.mjs';

const args = parseArgs();
const command = (args.positional[0] ?? 'list').toLowerCase();
const target = args.positional[1];
const reporter = new Reporter('playground:adapters');

function usage() {
  console.log(`
${bold('playground:adapters')} — Windows adapter management

  npm run playground:adapters list [--hwid <hwid>]
  npm run playground:adapters ensure [--hwid auto|ovpn-dco|tap0901] [--name <name>] [--release]
  npm run playground:adapters release <guid-or-name>

${dim('Needs Windows. tapctl.exe requires administrator rights, so an unelevated shell gets one UAC prompt.')}`);
}

function resolveTapctl() {
  try {
    return new BinaryManager().resolveTapctl().path;
  } catch {
    return undefined;
  }
}

function describeError(err) {
  if (err?.name === 'TapctlError') {
    const parts = [err.message];
    if (err.win32Code !== null && err.win32Code !== undefined) parts.push(`win32=${err.win32Code} (0x${Number(err.win32Code).toString(16)})`);
    if (err.rebootRequired) parts.push('a reboot is required before the adapter becomes usable');
    if (err.win32Code === 740) parts.push('elevation required: approve the UAC prompt or run from an elevated shell');
    return parts.join('\n');
  }
  if (err instanceof ElevationError) {
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`${yellow(' SKIP')} adapter management is Windows-only (running on ${process.platform})`);
    return EXIT_SKIP;
  }

  const binary = resolveTapctl();
  reporter.section('environment');
  if (binary) {
    reporter.ok('tapctl resolved from the SDK binary manager');
    reporter.info(binary);
  } else {
    reporter.warn('tapctl not resolved; falling back to `tapctl.exe` on PATH');
  }

  const broker = new ElevatedBroker();
  const adapters = new AdapterManager({
    ...(binary === undefined ? {} : { binary }),
    elevatedExec: (file, argv) => broker.run(file, argv),
  });

  let elevated = false;
  try {
    elevated = await adapters.isElevated();
  } catch (err) {
    reporter.warn(`elevation check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (elevated) reporter.ok('running elevated: tapctl runs directly');
  else reporter.warn('not elevated: tapctl runs through the elevated helper (UAC prompt on first use)');

  try {
    if (command === 'list') {
      reporter.section('list adapters');
      const items = await adapters.list(args.get('hwid'));
      reporter.ok(`tapctl list returned ${items.length} adapter(s)`);
      for (const item of items) {
        console.log(dim(`   ${item.guid}\t${item.name}\t${item.hwid}`));
      }
      return reporter.summary();
    }

    if (command === 'ensure') {
      reporter.section('ensure adapter');
      const hwid = args.get('hwid', 'auto');
      const adapter = await adapters.ensure({ hwid, name: args.get('name') });
      reporter.expect(adapter !== null, `adapter ready (hwid=${hwid})`);
      if (!adapter) return reporter.summary();
      reporter.info(`guid: ${adapter.guid || '(unknown)'}`);
      reporter.info(`name: ${adapter.name || '(unknown)'}`);
      reporter.info(`hwid: ${adapter.hwid}`);
      if (args.has('release')) {
        await adapters.release(adapter.guid || adapter.name);
        reporter.ok('adapter released (deleted when the last reference was dropped)');
      }
      return reporter.summary();
    }

    if (command === 'release') {
      reporter.section('release adapter');
      if (!target) {
        usage();
        return EXIT_SKIP;
      }
      await adapters.release(target);
      reporter.ok(`release(${target}) completed`);
      return reporter.summary();
    }

    reporter.fail(`unknown command: ${command}`);
    usage();
    return reporter.summary();
  } catch (err) {
    if (isSpawnBlocked(err)) {
      console.log(yellow('\n SKIP spawn blocked by the environment'));
      console.log(dim(spawnBlockedHint()));
      return EXIT_SKIP;
    }
    reporter.fail('adapter operation failed', describeError(err));
    return reporter.summary();
  } finally {
    await broker.dispose();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:adapters crashed:'), err);
    process.exitCode = EXIT_FAIL;
  });
