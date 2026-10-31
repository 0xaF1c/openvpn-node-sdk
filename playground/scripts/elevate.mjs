#!/usr/bin/env node
/**
 * Scenario: report the Windows UAC elevation setup used by the SDK.
 *
 *   npm run playground:elevate                        # report only (no UAC prompt)
 *   npm run playground:elevate -- --test              # prompt for UAC and run `whoami /groups`
 *   npm run playground:elevate -- --launcher <path>   # report/use a branded launcher
 *   npm run playground:elevate -- --helper <path>     # report/use an explicit helper file
 *
 * The helper is only started on demand, so the report itself never prompts.
 * Non-Windows hosts exit with code 2.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ElevatedBroker, ElevationError, isElevated } from 'openvpn-node-sdk';
import { bold, dim, EXIT_FAIL, EXIT_SKIP, parseArgs, Reporter } from './lib.mjs';

const cli = parseArgs();
const args = process.argv.slice(2);
const launcherPath = cli.get('launcher');
const explicitHelperPath = cli.get('helper');
const reporter = new Reporter('playground:elevate');

function describeError(err) {
  if (err instanceof ElevationError) return `${err.name}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`${bold('playground:elevate')} — Windows UAC elevation`);
    reporter.skip(`Windows-only (running on ${process.platform})`);
    reporter.summary();
    return EXIT_SKIP;
  }

  reporter.section('environment');
  reporter.info(`node: ${process.version}`);
  reporter.info(`execPath: ${process.execPath}`);
  const elevated = await isElevated();
  if (elevated) {
    reporter.ok('the current process is elevated: no UAC prompt, OpenVPN spawns directly');
  } else {
    reporter.warn('not elevated: connect() will request UAC (one prompt per connection)');
  }

  reporter.section('helper');
  let broker;
  try {
    broker = new ElevatedBroker({
      ...(explicitHelperPath === undefined ? {} : { helperPath: path.resolve(explicitHelperPath) }),
      ...(launcherPath === undefined ? {} : { launcherPath: path.resolve(launcherPath) }),
    });
  } catch (err) {
    // The SDK resolves the helper eagerly and throws when it cannot be found.
    reporter.fail('the elevation helper could not be resolved', describeError(err));
    reporter.info(dim('point the SDK at an existing file: npm run playground:elevate -- --helper <path>'));
    return reporter.summary();
  }
  reporter.info(`helper script: ${broker.helperPath}`);
  reporter.expect(existsSync(broker.helperPath), 'elevation helper is present');
  reporter.info(`node for the helper: ${broker.nodePath}`);
  if (broker.launcherPath === undefined) {
    reporter.info(dim('launcher: powershell Start-Process -Verb RunAs → node.exe (UAC shows "Node.js")'));
    reporter.info(dim('brand it with: npm run playground:elevate -- --launcher <your-launcher.exe>'));
  } else {
    reporter.info(`launcher: ${broker.launcherPath}`);
    reporter.expect(existsSync(broker.launcherPath), 'branded launcher is present');
    reporter.info(dim('the UAC prompt shows the launcher icon/name/publisher'));
  }

  if (!args.includes('--test')) {
    reporter.section('next');
    reporter.info('run `npm run playground:elevate -- --test` to approve a UAC prompt and run `whoami /groups`');
    await broker.dispose();
    return reporter.summary();
  }

  reporter.section('elevated command');
  try {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const result = await broker.run(whoami, ['/groups']);
    const output = result.stdout.toString('utf8');
    console.log(output.trim());
    reporter.expect(result.exitCode === 0, 'elevated whoami exited with 0', `exit ${result.exitCode}`);
    reporter.expect(
      /High Mandatory Level|S-1-16-12288/i.test(output),
      'elevated token has the High Mandatory Level',
      output,
    );
  } catch (err) {
    reporter.fail('elevated command failed', describeError(err));
  } finally {
    await broker.dispose();
  }
  return reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(describeError(err));
    process.exitCode = EXIT_FAIL;
  });
