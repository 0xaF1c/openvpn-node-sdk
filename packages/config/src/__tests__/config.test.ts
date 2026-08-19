import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OvpnConfig } from '../index.ts';

describe('OvpnConfig', () => {
  it('builds a client config with remote, dev-node and auth-user-pass', () => {
    const cfg = new OvpnConfig()
      .client()
      .remote('vpn.example.com', 1194, 'udp')
      .devNode('My TAP Adapter')
      .authUserPass();

    assert.equal(
      cfg.toString(),
      'client\nremote vpn.example.com 1194 udp\ndev-node "My TAP Adapter"\nauth-user-pass\n',
    );
  });

  it('renders inline ca/cert/key blocks', () => {
    const cfg = new OvpnConfig().client().caInline('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----');
    assert.equal(
      cfg.toString(),
      'client\n<ca>\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n</ca>\n',
    );
  });

  it('writes the config to disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-config-test-'));
    const file = path.join(dir, 'client.ovpn');
    await new OvpnConfig().client().remote('10.0.0.1', 443, 'tcp').writeTo(file);
    const text = await readFile(file, 'utf8');
    assert.match(text, /remote 10\.0\.0\.1 443 tcp/);
    await rm(dir, { recursive: true, force: true });
  });
});
