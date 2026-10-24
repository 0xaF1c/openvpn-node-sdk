#!/usr/bin/env node
/**
 * Scenario: report the Windows OpenVPN interactive-service capabilities.
 *
 *   npm run playground:service
 *
 * Read-only: checks the named pipe, reads HKLM\SOFTWARE\OpenVPN and explains
 * whether OpenVpnClient would use the service for the current shell.
 * Non-Windows hosts exit with code 2.
 */
import { OpenvpnServiceClient, readOpenvpnServiceSettings } from 'openvpn-node-sdk';
import { bold, dim, EXIT_SKIP, Reporter } from './lib.mjs';

const reporter = new Reporter('playground:service');

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`${bold('playground:service')} — OpenVPN interactive service`);
    reporter.skip(`Windows-only (running on ${process.platform})`);
    reporter.summary();
    return EXIT_SKIP;
  }

  const service = new OpenvpnServiceClient({ timeoutMs: 3000 });
  reporter.section('service pipe');
  reporter.info(`pipe: ${service.pipePath}`);
  const available = await service.isAvailable(3000);
  if (available) {
    reporter.ok('OpenVPNServiceInteractive pipe is reachable');
  } else {
    reporter.skip('pipe is not reachable (service not installed/running, or access denied)');
    reporter.info(dim('install/repair OpenVPN, then check: sc query OpenVPNServiceInteractive'));
  }

  reporter.section('registry settings (HKLM\\SOFTWARE\\OpenVPN)');
  let settings = null;
  try {
    settings = await readOpenvpnServiceSettings();
  } catch (err) {
    reporter.warn(`reg query failed: ${describeError(err)}`);
  }
  if (settings) {
    reporter.info(`exe_path: ${settings.exePath ?? '(not set)'}`);
    reporter.info(`config_dir: ${settings.configDir ?? '(not set)'}`);
    reporter.info(`bin_dir: ${settings.binDir ?? '(not set)'}`);
    reporter.info(`ovpn_admin_group: ${settings.adminGroup ?? '(not set)'}`);
    reporter.info(dim('service mode runs exe_path, not OpenVpnClientOptions.binary'));
  } else {
    reporter.warn('could not read the service settings; is OpenVPN installed?');
  }

  reporter.section('what OpenVpnClient will do');
  reporter.info(dim("elevation: 'auto' uses the service when the process is not elevated and the pipe is reachable"));
  reporter.info(dim("non-admin profiles must live under config_dir, or the user must be in ovpn_admin_group"));
  reporter.info(dim("see docs/windows-openvpnserv.md for details and troubleshooting"));

  return reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(describeError(err));
    process.exitCode = 1;
  });
