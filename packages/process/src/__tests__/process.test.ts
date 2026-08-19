import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { buildOpenVpnArgs, getFreePort, waitForTcpPort } from '../index.ts';

describe('buildOpenVpnArgs', () => {
  it('emits management args with hold and query-passwords by default', () => {
    const args = buildOpenVpnArgs({
      binary: 'openvpn.exe',
      configFile: 'C:\temp\client.ovpn',
      managementPort: 5555,
    });
    assert.deepEqual(args, [
      '--config', 'C:\temp\client.ovpn',
      '--management', '127.0.0.1', '5555',
      '--management-hold',
      '--management-query-passwords',
    ]);
  });

  it('can disable hold/query-passwords and add extras', () => {
    const args = buildOpenVpnArgs({
      binary: 'openvpn.exe',
      configFile: 'client.ovpn',
      managementHost: '127.0.0.1',
      managementPort: 0,
      managementHold: false,
      queryPasswords: false,
      registerDns: true,
      extraArgs: ['--verb', '3'],
    });
    assert.ok(!args.includes('--management-hold'));
    assert.ok(!args.includes('--management-query-passwords'));
    assert.ok(args.includes('--register-dns'));
    assert.deepEqual(args.slice(-2), ['--verb', '3']);
  });
});

describe('getFreePort / waitForTcpPort', () => {
  it('allocates a free port and waitForTcpPort sees a listening socket', async () => {
    const port = await getFreePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await waitForTcpPort('127.0.0.1', port, 2000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('waitForTcpPort times out for a closed port', async () => {
    const port = await getFreePort();
    await assert.rejects(() => waitForTcpPort('127.0.0.1', port, 300, 50), /not reachable/);
  });
});
