import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { MockManagementServer } from '@ovpn-sdk/core';
import { type ProcessManagerLike, type SpawnedProcess } from '@ovpn-sdk/process';
import { readFile } from 'node:fs/promises';
import { OpenVpnClient, OpenVpnServer, OvpnConfig } from '../index.ts';

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid = 12345;
  exitCode: number | null = null;
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, signal ?? 'SIGTERM');
    return true;
  }
}

class FakeAdapterManager {
  readonly ensureCalls: Array<{ hwid?: string }> = [];
  readonly released: string[] = [];
  adapter = { guid: '{adapter-guid}', name: 'SDK TAP Adapter', hwid: 'ovpn-dco' };

  async ensure(opts: { hwid?: string } = {}): Promise<{ guid: string; name: string; hwid: string }> {
    this.ensureCalls.push(opts);
    return this.adapter;
  }

  async release(guidOrName: string): Promise<void> {
    this.released.push(guidOrName);
  }
}

class FakeProcessManager implements ProcessManagerLike {
  readonly started: Array<{ binary: string; args: string[] }> = [];
  readonly child = new FakeProcess();
  killTreeCalls: number[] = [];

  start(binary: string, args: string[]): SpawnedProcess {
    this.started.push({ binary, args });
    return this.child;
  }

  async killTree(pid: number): Promise<void> {
    this.killTreeCalls.push(pid);
    this.child.kill('SIGKILL');
  }
}

describe('OpenVpnClient orchestration', () => {
  it('spawns, connects to management, handles state and auth challenges', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fake = new FakeProcessManager();

    let resolveCredentials: (c: { username: string; password: string }) => void = () => {};
    const credentials = new Promise<{ username: string; password: string }>((resolve) => {
      resolveCredentials = resolve;
    });

    const fakeAdapters = new FakeAdapterManager();
    const client = new OpenVpnClient(
      new OvpnConfig().client().remote('vpn.example.com', 1194, 'udp').authUserPass(),
      {
        binary: process.execPath,
        processManager: fake,
        adapterManager: fakeAdapters,
        managementHost: '127.0.0.1',
        managementPort: port,
        disconnectTimeoutMs: 300,
        credentials: () => credentials,
      },
    );

    const stateEvents: string[] = [];
    client.on('state', (s) => stateEvents.push(s.name));

    await client.connect();
    assert.equal(fake.started.length, 1);
    assert.ok(fake.started[0]?.args.includes('--management'));
    assert.ok(fake.started[0]?.args.includes(String(port)));

    // Windows adapter ensure should have been called and dev-node written to config.
    assert.equal(fakeAdapters.ensureCalls.length, 1);
    const configArgIndex = fake.started[0]?.args.indexOf('--config') ?? -1;
    const configPath = configArgIndex >= 0 ? (fake.started[0]?.args[configArgIndex + 1] ?? '') : '';
    const configText = await readFile(configPath, 'utf8');
    assert.ok(configText.includes('dev-node "SDK TAP Adapter"'), configText);

    const connected = client.waitFor('CONNECTED', 2000);
    server.broadcast('>STATE:1715000000,CONNECTING,init,,,,,,,');
    server.broadcast('>STATE:1715000001,CONNECTED,init,10.8.0.6,,,,,');
    await connected;
    assert.equal(client.currentState?.name, 'CONNECTED');

    // Trigger a password challenge; the credentials provider should answer it.
    const authAnswered = new Promise<void>((resolve) => {
      const check = () => {
        if (server.received.some((line) => line.startsWith('username "Auth"')) && server.received.some((line) => line.startsWith('password "Auth"'))) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
    server.broadcast(">PASSWORD:Need 'Auth' username/password");
    resolveCredentials({ username: 'alice', password: 'secret' });
    await authAnswered;

    await client.disconnect();
    assert.ok(server.received.includes('signal SIGTERM'));
    assert.equal(fake.child.killed, true);
    assert.deepEqual(fakeAdapters.released, ['{adapter-guid}']);
    await server.stop();
  });

  it('waitFor resolves immediately when already in the target state', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fake = new FakeProcessManager();
    const client = new OpenVpnClient('client\ndev null\n', {
      binary: process.execPath,
      processManager: fake,
      managementPort: port,
      disconnectTimeoutMs: 300,
      manageAdapter: false,
    });
    await client.connect();
    server.broadcast('>STATE:1715000000,CONNECTED,init,,,,,,,');
    await client.waitFor('CONNECTED', 1000);
    await client.waitFor('CONNECTED', 1000); // should resolve immediately
    await client.disconnect();
    await server.stop();
  });
});


describe('OpenVpnServer orchestration', () => {
  it('approves/denies clients and parses status', async () => {
    const server = new MockManagementServer({
      onCommand(line) {
        if (line.startsWith('client-auth-nt 0 1')) return ['SUCCESS: client-auth command succeeded'];
        if (line.startsWith('client-deny 0 1')) return ['SUCCESS: client-deny command succeeded'];
        if (line === 'status') {
          return [
            'TITLE,OpenVPN 2.8 mock',
            'HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID,Data Channel Cipher',
            'CLIENT_LIST,alice,10.0.0.2,10.8.0.6,,1234,5678,2026-05-06 12:00:00,1715000000,,0,1,CHACHA20-POLY1305',
            'END',
          ];
        }
        if (line === 'version 6') return ['SUCCESS: Management client version set to 6'];
        if (line.startsWith('state ')) return ['SUCCESS: real-time state notification set to ON', '1715000000,CONNECTING,init,,,,,,,', 'END'];
        if (line.startsWith('log ')) return ['SUCCESS: real-time log notification set to ON', 'END'];
        if (line.startsWith('bytecount ')) return ['SUCCESS: bytecount interval changed'];
        if (line.startsWith('signal ')) return ['SUCCESS: signal SIGTERM executed'];
        return undefined;
      },
    });
    const port = await server.start();
    const fake = new FakeProcessManager();
    const srv = new OpenVpnServer(
      new OvpnConfig().raw('server').raw('dev', 'tun').raw('topology', 'subnet').raw('ifconfig', '10.8.0.1 10.8.0.2'),
      {
        binary: process.execPath,
        processManager: fake,
        managementPort: port,
        disconnectTimeoutMs: 300,
        manageAdapter: false,
      },
    );
    await srv.connect();

    await srv.approveClient(0, 1);
    assert.ok(server.received.some((line) => line.startsWith('client-auth-nt 0 1')));

    await srv.denyClient(0, 1, 'bad cert');
    assert.ok(server.received.some((line) => line.startsWith('client-deny 0 1')));

    const status = await srv.getStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0]?.commonName, 'alice');

    await srv.disconnect();
    await server.stop();
  });
});
