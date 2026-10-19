import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
    // Integration check: scripts/fetch-openvpn-binaries.mjs has populated the platform package.
    const mgr = new BinaryManager();
    const openvpn = mgr.resolveOpenVpn();
    assert.ok(openvpn.path.length > 0);
    assert.ok(openvpn.source === 'platform-package' || openvpn.source === 'install-dir' || openvpn.source === 'path');
    if (openvpn.source === 'platform-package') {
      assert.match(openvpn.version ?? '', /^\d+\.\d+\.\d+$/, 'platform package metadata should carry the pinned OpenVPN version');
    }
  });
});

describe('platform package metadata', () => {
  async function makePlatformPackage(openvpnVersion: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-pkg-meta-'));
    const pkgDir = path.join(dir, 'node_modules', '@ovpn-sdk', 'openvpn-win32-x64');
    await mkdir(path.join(pkgDir, 'bin'), { recursive: true });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@ovpn-sdk/openvpn-win32-x64', version: '2.7.5-1', openvpnVersion }),
      'utf8',
    );
    const binary = path.join(pkgDir, 'bin', 'openvpn.exe');
    await writeFile(binary, '');
    const resolver = (specifier: string) =>
      specifier.endsWith('/package.json') ? path.join(pkgDir, 'package.json') : null;
    return { dir, binary, resolver };
  }

  it('reads openvpnVersion from the platform package without spawning it', async () => {
    const { dir, binary, resolver } = await makePlatformPackage('2.7.5');
    const mgr = new BinaryManager({ platformResolver: resolver });
    assert.deepEqual(mgr.resolveOpenVpn(), { path: binary, source: 'platform-package', version: '2.7.5' });
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a platform package that does not satisfy expectedVersion', async () => {
    const { dir, resolver } = await makePlatformPackage('2.6.12');
    const mismatch = new BinaryManager({ platformResolver: resolver, expectedVersion: '2.7.5' });
    assert.throws(
      () => mismatch.resolveOpenVpn(),
      /expected OpenVPN 2\.7\.5, but platform package @ovpn-sdk\/openvpn-win32-x64 provides 2\.6\.12/,
    );

    const match = new BinaryManager({ platformResolver: resolver, expectedVersion: '2.6.12' });
    assert.equal(match.resolveOpenVpn().version, '2.6.12');
    await rm(dir, { recursive: true, force: true });
  });

  it('falls through when the platform package has metadata but no binary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-pkg-empty-'));
    const pkgDir = path.join(dir, 'node_modules', '@ovpn-sdk', 'openvpn-win32-x64');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@ovpn-sdk/openvpn-win32-x64', openvpnVersion: '2.7.5' }),
      'utf8',
    );
    const resolver = (specifier: string) =>
      specifier.endsWith('/package.json') ? path.join(pkgDir, 'package.json') : null;
    const mgr = new BinaryManager({ platformResolver: resolver });

    let resolved: ReturnType<BinaryManager['resolveOpenVpn']> | null = null;
    try {
      resolved = mgr.resolveOpenVpn();
    } catch {
      resolved = null;
    }
    assert.ok(resolved === null || resolved.source !== 'platform-package');
    await rm(dir, { recursive: true, force: true });
  });

  it('verifyVersion rejects binaries whose OpenVPN version cannot be read', async () => {
    const mgr = new BinaryManager();
    await assert.rejects(
      () => mgr.verifyVersion(process.execPath, '2.7.5'),
      /unable to read the OpenVPN version|expected OpenVPN 2\.7\.5/,
    );
  });
});

describe('bundled vendor directory', () => {
  const target = () => `${process.platform}-${process.arch}`;
  const exeName = () => (process.platform === 'win32' ? 'openvpn.exe' : 'openvpn');

  async function makeVendor(version: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-vendor-'));
    const binDir = path.join(dir, `openvpn-${target()}`, 'bin');
    await mkdir(binDir, { recursive: true });
    const binary = path.join(binDir, exeName());
    await writeFile(binary, '');
    await writeFile(
      path.join(dir, 'openvpn.json'),
      JSON.stringify({ openvpnVersion: version, platforms: { [target()]: { version, files: [exeName()] } } }),
      'utf8',
    );
    return { dir, binary };
  }

  it('resolves the vendored binary together with its pinned version', async () => {
    const { dir, binary } = await makeVendor('2.7.5');
    const mgr = new BinaryManager({ vendorDir: dir, platformResolver: () => null });
    assert.deepEqual(mgr.resolveOpenVpn(), { path: binary, source: 'bundled', version: '2.7.5' });
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a bundled version that does not satisfy expectedVersion', async () => {
    const { dir } = await makeVendor('2.6.12');
    const mismatch = new BinaryManager({ vendorDir: dir, platformResolver: () => null, expectedVersion: '2.7.5' });
    assert.throws(() => mismatch.resolveOpenVpn(), /expected OpenVPN 2\.7\.5, but the bundled binaries provide 2\.6\.12/);

    const match = new BinaryManager({ vendorDir: dir, platformResolver: () => null, expectedVersion: '2.6.12' });
    assert.equal(match.resolveOpenVpn().version, '2.6.12');
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a vendor directory without a manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-vendor-empty-'));
    const mgr = new BinaryManager({ vendorDir: dir, platformResolver: () => null });
    let resolved: ReturnType<BinaryManager['resolveOpenVpn']> | null = null;
    try {
      resolved = mgr.resolveOpenVpn();
    } catch {
      resolved = null;
    }
    assert.ok(resolved === null || resolved.source !== 'bundled');
    await rm(dir, { recursive: true, force: true });
  });
});
