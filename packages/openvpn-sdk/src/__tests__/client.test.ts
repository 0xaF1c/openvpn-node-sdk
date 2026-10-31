import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { MockManagementServer } from '@ovpn-sdk/core';
import { type ProcessManagerLike, type SpawnedProcess } from '@ovpn-sdk/process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ElevationCancelledError,
  ElevationUnavailableError,
  OpenVpnClient,
  OpenVpnServer,
  OvpnConfig,
  type ElevatedBrokerLike,
  type ElevatedCommandOptions,
  type ElevatedCommandResult,
  type ElevatedProcessLike,
} from '../index.ts';

const isWindows = process.platform === 'win32';

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
  elevated = false;

  async list(): Promise<Array<{ guid: string; name: string; hwid: string }>> {
    return [this.adapter];
  }

  async create(): Promise<{ guid: string; name: string; hwid: string }> {
    return this.adapter;
  }

  async ensure(opts: { hwid?: string } = {}): Promise<{ guid: string; name: string; hwid: string }> {
    this.ensureCalls.push(opts);
    return this.adapter;
  }

  async release(guidOrName: string): Promise<void> {
    this.released.push(guidOrName);
  }

  async isElevated(): Promise<boolean> {
    return this.elevated;
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

class FakeElevatedProcess extends EventEmitter implements ElevatedProcessLike {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  private stdout = '';
  private stderr = '';

  getStdout(): string {
    return this.stdout;
  }

  getStderr(): string {
    return this.stderr;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, signal ?? 'SIGTERM');
    return true;
  }

  finish(code: number | null = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

class FakeBroker implements ElevatedBrokerLike {
  readonly spawned: Array<{ file: string; args: string[]; options?: ElevatedCommandOptions }> = [];
  readonly runs: Array<{ file: string; args: string[] }> = [];
  readonly process = new FakeElevatedProcess();
  disposed = false;
  spawnError: Error | null = null;
  runResult: ElevatedCommandResult = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };

  async run(file: string, args: string[]): Promise<ElevatedCommandResult> {
    this.runs.push({ file, args });
    return this.runResult;
  }

  async spawn(file: string, args: string[], options?: ElevatedCommandOptions): Promise<ElevatedProcessLike> {
    if (this.spawnError) throw this.spawnError;
    this.spawned.push({ file, args, ...(options === undefined ? {} : { options }) });
    return this.process;
  }

  async kill(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe('OpenVpnClient orchestration', () => {
  it('spawns, connects to management, handles state and auth challenges', { skip: !isWindows && 'Windows adapter/dev-node flow' }, async () => {
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
        elevation: 'never',
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

  it('uses the elevated broker when the process is not elevated', { skip: !isWindows && 'UAC is Windows-only' }, async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    const broker = new FakeBroker();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      manageAdapter: false,
    });

    await client.connect();
    assert.equal(fakeManager.started.length, 0);
    assert.equal(broker.spawned.length, 1);
    assert.match(broker.spawned[0]?.args.join(' ') ?? '', /--management 127\.0\.0\.1 /);
    await client.disconnect();
    await server.stop();
  });

  it('spawns directly when the process is already elevated', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    fakeAdapters.elevated = true;
    const broker = new FakeBroker();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      manageAdapter: false,
    });

    await client.connect();
    assert.equal(fakeManager.started.length, 1);
    assert.equal(broker.spawned.length, 0);
    await client.disconnect();
    await server.stop();
  });

  it('always elevates when elevation is "always" even in an elevated process', { skip: !isWindows && 'UAC is Windows-only' }, async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    fakeAdapters.elevated = true;
    const broker = new FakeBroker();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      manageAdapter: false,
      elevation: 'always',
      registerDns: true,
    });

    await client.connect();
    assert.equal(fakeManager.started.length, 0);
    assert.equal(broker.spawned.length, 1);
    assert.ok(broker.spawned[0]?.args.includes('--register-dns'));
    await client.disconnect();
    await server.stop();
  });

  it('cleans up when the elevated process exits before disconnect', { skip: !isWindows && 'UAC is Windows-only' }, async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    const broker = new FakeBroker();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      elevation: 'always',
    });

    await client.connect();
    broker.process.finish(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.disconnect();

    assert.equal(client.currentState, null);
    assert.deepEqual(fakeAdapters.released, ['{adapter-guid}']);
    await server.stop();
  });

  it('writes the profile to a temp directory and removes it on disconnect', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      elevation: 'never',
      manageAdapter: false,
    });

    await client.connect();
    const start = fakeManager.started[0];
    assert.ok(start);
    const configIndex = start.args.indexOf('--config');
    const configPath = configIndex >= 0 ? (start.args[configIndex + 1] ?? '') : '';
    assert.ok(configPath.startsWith(tmpdir()), configPath);
    assert.ok((await readdir(path.dirname(configPath))).includes(path.basename(configPath)));

    await client.disconnect();
    await assert.rejects(() => readFile(configPath, 'utf8'), /ENOENT/);
    await server.stop();
  });

  it('propagates a cancelled UAC prompt and aborts the connection', { skip: !isWindows && 'UAC is Windows-only' }, async () => {
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    const broker = new FakeBroker();
    broker.spawnError = new ElevationCancelledError('the user cancelled the UAC prompt');

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementPort: 1,
      disconnectTimeoutMs: 20,
      elevation: 'always',
      manageAdapter: false,
    });

    await assert.rejects(() => client.connect(), ElevationCancelledError);
    assert.equal(fakeManager.started.length, 0);
    assert.equal(client.currentState, null);
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
      elevation: 'never',
    });
    await client.connect();
    server.broadcast('>STATE:1715000000,CONNECTED,init,,,,,,,');
    await client.waitFor('CONNECTED', 1000);
    await client.waitFor('CONNECTED', 1000); // should resolve immediately
    await client.disconnect();
    await server.stop();
  });

  it('uses the elevation broker on POSIX when not root', { skip: isWindows && 'Windows uses the UAC helper' }, async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const fakeAdapters = new FakeAdapterManager();
    const broker = new FakeBroker();

    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: fakeAdapters,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      manageAdapter: false,
      isElevated: async () => false,
    });

    await client.connect();
    assert.equal(broker.spawned.length, 1);
    assert.equal(fakeManager.started.length, 0);
    await client.disconnect();
    await server.stop();
  });

  it('uses the broker for elevation: "always" on POSIX', { skip: isWindows && 'Windows supports UAC' }, async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const fakeManager = new FakeProcessManager();
    const broker = new FakeBroker();
    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      broker,
      managementHost: '127.0.0.1',
      managementPort: port,
      disconnectTimeoutMs: 20,
      elevation: 'always',
      manageAdapter: false,
    });
    await client.connect();
    assert.equal(broker.spawned.length, 1);
    assert.equal(fakeManager.started.length, 0);
    await client.disconnect();
    await server.stop();
  });

  it('forwards elevationHelperPath to the broker it creates', async () => {
    // Bundled hosts (Electron + Vite/Rollup) must be able to point the SDK at
    // the helper themselves; the option has to reach ElevatedBroker.helperPath.
    const dir = await mkdtemp(path.join(tmpdir(), 'ovpn-sdk-helper-'));
    try {
      const helper = path.join(dir, 'elevate-helper.mjs');
      await writeFile(helper, '// stand-in for elevate-helper.js\n', 'utf8');
      const client = new OpenVpnClient('dev null\n', {
        binary: process.execPath,
        adapterManager: new FakeAdapterManager(),
        elevationHelperPath: helper,
        elevation: 'always',
      });

      const broker = (
        client as unknown as { getBroker(): ElevatedBrokerLike & { helperPath: string } }
      ).getBroker();
      try {
        assert.equal(broker.helperPath, path.resolve(helper));
      } finally {
        await broker.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when the elevation helper is missing', async () => {
    const fakeManager = new FakeProcessManager();
    const client = new OpenVpnClient('dev null\n', {
      binary: process.execPath,
      processManager: fakeManager,
      adapterManager: new FakeAdapterManager(),
      managementPort: 1,
      disconnectTimeoutMs: 20,
      manageAdapter: false,
      elevation: 'always',
      elevationHelperPath: path.join(tmpdir(), 'ovpn-sdk-missing', 'elevate-helper.js'),
    });

    await assert.rejects(
      () => client.connect(),
      (err: unknown) => {
        assert.ok(err instanceof ElevationUnavailableError, String(err));
        assert.match(err.message, /elevation helper/);
        return true;
      },
    );
    assert.equal(fakeManager.started.length, 0);
    assert.equal(client.currentState, null);
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
