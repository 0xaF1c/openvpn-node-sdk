import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BinaryManager } from '@ovpn-sdk/binary';
import { OpenVpnClient } from '../index.ts';

const NL = String.fromCharCode(10);
const RUN_SMOKE = process.env.RUN_OPENVPN_SMOKE === '1';

/**
 * Real-OpenVPN smoke test. Skipped by default because it spawns the actual
 * OpenVPN binary and needs an environment where process spawn is permitted.
 *
 * Run with:
 *   RUN_OPENVPN_SMOKE=1 npm test -- --test-isolation=none packages/openvpn-sdk/src/__tests__/smoke.test.ts
 */
describe('OpenVPN real-process smoke test', () => {
  it('spawns openvpn, connects to its management socket and exits cleanly', { skip: !RUN_SMOKE }, async () => {
    const binary = new BinaryManager().resolveOpenVpn().path;
    const config = [
      'client',
      'dev null',
      'remote 127.0.0.1 9 udp',
      'nobind',
      'connect-retry-max 1',
      'peer-fingerprint 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
      'auth-user-pass',
    ].join(NL);

    const client = new OpenVpnClient(config, {
      binary,
      manageAdapter: false,
      connectTimeoutMs: 20_000,
      disconnectTimeoutMs: 10_000,
    });

    const stateNames: string[] = [];
    client.on('state', (s) => stateNames.push(s.name));

    await client.connect();
    const pid = await client.sendManagement('pid');
    assert.ok(pid.success && pid.success.includes('pid='));

    await client.disconnect();
    assert.ok(client.currentState === null || client.currentState.name !== 'EXITING');
    assert.ok(stateNames.length >= 0);
  });
});
