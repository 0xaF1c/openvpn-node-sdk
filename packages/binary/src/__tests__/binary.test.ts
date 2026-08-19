import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BinaryManager, getPlatformPackageName, parseOpenVpnVersion } from '../index.ts';

describe('getPlatformPackageName', () => {
  it('maps platform/arch to package names', () => {
    assert.equal(getPlatformPackageName('win32', 'x64'), '@ovpn-sdk/openvpn-win32-x64');
    assert.equal(getPlatformPackageName('linux', 'x64'), '@ovpn-sdk/openvpn-linux-x64');
    assert.equal(getPlatformPackageName('linux', 'arm64'), '@ovpn-sdk/openvpn-linux-arm64');
    assert.equal(getPlatformPackageName('darwin', 'x64'), '@ovpn-sdk/openvpn-darwin-x64');
    assert.equal(getPlatformPackageName('darwin', 'arm64'), '@ovpn-sdk/openvpn-darwin-arm64');
  });
});

describe('parseOpenVpnVersion', () => {
  it('parses the OpenVPN version line', () => {
    assert.equal(parseOpenVpnVersion('OpenVPN 2.7.5 [git:v2.7.5/b25bb2a8bda814ed] Windows [SSL (OpenSSL)]'), '2.7.5');
    assert.equal(parseOpenVpnVersion('not an openvpn banner'), null);
  });
});

describe('BinaryManager resolution order', () => {
  it('prefers explicit option, then env, then platform package, then install dir/path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-bin-test-'));
    const explicit = path.join(dir, 'explicit-openvpn.exe');
    const env = path.join(dir, 'env-openvpn.exe');
    const bundled = path.join(dir, 'bundled-openvpn.exe');
    await Promise.all([
      writeFile(explicit, ''),
      writeFile(env, ''),
      writeFile(bundled, ''),
    ]);

    const resolve = (specifier: string) => (specifier.endsWith('/bin/openvpn.exe') ? bundled : null);

    // 1. explicit wins
    const withExplicit = new BinaryManager({ openvpnBinary: explicit, platformResolver: resolve });
    assert.deepEqual(withExplicit.resolveOpenVpn(), { path: explicit, source: 'explicit' });

    // 2. env wins when no explicit
    const oldEnv = process.env.OPENVPN_BINARY;
    process.env.OPENVPN_BINARY = env;
    const withEnv = new BinaryManager({ platformResolver: resolve });
    assert.deepEqual(withEnv.resolveOpenVpn(), { path: env, source: 'env' });
    delete process.env.OPENVPN_BINARY;

    // 3. platform package when explicit/env absent
    const withBundle = new BinaryManager({ platformResolver: resolve });
    assert.deepEqual(withBundle.resolveOpenVpn(), { path: bundled, source: 'platform-package' });

    if (oldEnv !== undefined) process.env.OPENVPN_BINARY = oldEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves bundled platform package binaries when present', (t) => {
    if (process.platform !== 'win32') {
      t.skip('platform package binaries are populated on Windows only in this repo');
      return;
    }
    // Integration check: the extraction script has populated the platform package.
    const mgr = new BinaryManager();
    const openvpn = mgr.resolveOpenVpn();
    assert.ok(openvpn.path.length > 0);
    assert.ok(openvpn.source === 'platform-package' || openvpn.source === 'install-dir' || openvpn.source === 'path');
  });
});
