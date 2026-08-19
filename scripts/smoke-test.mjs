#!/usr/bin/env node
/**
 * Real-OpenVPN smoke test (standalone runner).
 *
 * Spawns the actual OpenVPN binary with a throwaway `dev null` config,
 * connects to its management socket, queries `pid` and shuts down cleanly.
 * This verifies the full process -> management-interface path without a VPN
 * server and without touching TAP adapters.
 *
 * Usage:
 *   node scripts/smoke-test.mjs
 *
 * Windows note: run from an elevated PowerShell/cmd if spawn is blocked with
 * EPERM (msys token-guard / UAC limitations).
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BinaryManager } from '../packages/binary/src/index.ts';
import { OpenVpnClient } from '../packages/openvpn-sdk/src/index.ts';

const NL = String.fromCharCode(10);

async function main() {
  const binary = new BinaryManager().resolveOpenVpn();
  console.log('Using OpenVPN binary:', binary.path);

  const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-sdk-smoke-'));
  const configFile = path.join(dir, 'smoke.ovpn');
  const config = [
    'client',
    'dev null',
    'remote 127.0.0.1 9 udp',
    'nobind',
    'connect-retry-max 1',
    'peer-fingerprint 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
    'auth-user-pass',
  ].join(NL);
  await writeFile(configFile, config, 'utf8');

  const client = new OpenVpnClient(config, {
    binary: binary.path,
    manageAdapter: false,
    connectTimeoutMs: 20_000,
    disconnectTimeoutMs: 10_000,
  });

  client.on('state', (s) => console.log('state:', s.name, s.description));
  client.on('log', (l) => console.log('log:', l.level, l.text));
  client.on('error', (err) => console.error('client error:', err.message));

  try {
    await client.connect();
    console.log('management-connected, protocol OK');
    const pid = await client.sendManagement('pid');
    console.log('pid result:', pid.success);
    await client.disconnect();
    console.log('disconnected cleanly');
    console.log('SMOKE TEST PASSED');
  } catch (err) {
    if (err && err.code === 'EPERM') {
      console.error('spawn EPERM: re-run from an elevated PowerShell/cmd prompt.');
    }
    console.error('SMOKE TEST FAILED:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main();
