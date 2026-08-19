import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManagementClient, inferExpect } from '../client.ts';
import { MockManagementServer } from '../mock-server.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('inferExpect', () => {
  it('classifies single-line and END-terminated commands', () => {
    assert.equal(inferExpect('pid'), 'single');
    assert.equal(inferExpect('version 6'), 'single');
    assert.equal(inferExpect('version'), 'end');
    assert.equal(inferExpect('state on'), 'single');
    assert.equal(inferExpect('state all'), 'end');
    assert.equal(inferExpect('state on all'), 'end');
    assert.equal(inferExpect('log on all'), 'end');
    assert.equal(inferExpect('help'), 'end');
    assert.equal(inferExpect('bytecount 1'), 'single');
    assert.equal(inferExpect('signal SIGTERM'), 'single');
    assert.equal(inferExpect('status 2'), 'end');
  });
});

describe('ManagementClient', () => {
  it('connects, negotiates version and runs the init sequence', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false });

    const initialized = new Promise<void>((resolve) => client.on('initialized', resolve));
    await client.connect();
    await initialized;

    assert.equal(client.protocolVersion, 6);
    assert.ok(client.welcomeLine.includes('OpenVPN Management Interface Version 6'));
    assert.ok(server.received.includes('version 6'));
    assert.ok(server.received.includes('state on all'));
    assert.ok(server.received.includes('log on all'));
    assert.ok(server.received.includes('bytecount 1'));

    await client.disconnect();
    await server.stop();
  });

  it('resolves single-line and END-terminated command frames', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false });
    await client.connect();

    const pid = await client.send('pid');
    assert.equal(pid.success, 'pid=4242');
    assert.deepEqual(pid.lines, []);

    const help = await client.send('help');
    assert.ok(help.lines.includes('Commands:'));
    assert.equal(help.error, undefined);

    await client.disconnect();
    await server.stop();
  });

  it('collects >CLIENT:CONNECT ENV blocks into structured events', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false });
    await client.connect();

    const connectSeen = new Promise<{ cid: number; env: Record<string, string> }>((resolve) => {
      client.on('client', (e) => {
        if (e.type === 'connect-env') resolve({ cid: e.cid, env: e.env });
      });
    });
    server.broadcast('>CLIENT:CONNECT,0,1');
    server.broadcast('>CLIENT:ENV,common_name=alice');
    server.broadcast('>CLIENT:ENV,untrusted_ip=10.0.0.2');
    server.broadcast('>CLIENT:ENV,END');
    const seen = await connectSeen;
    assert.equal(seen.cid, 0);
    assert.deepEqual(seen.env, { common_name: 'alice', untrusted_ip: '10.0.0.2' });

    await client.disconnect();
    await server.stop();
  });

  it('routes >STATE notifications to typed events', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false });
    await client.connect();

    const stateSeen = new Promise<string>((resolve) => client.once('state', (s) => resolve(s.name)));
    server.broadcast('>STATE:1715000000,CONNECTED,init,10.8.0.6,1.2.3.4,1194,10.8.0.6,55555,fd00::1');
    assert.equal(await stateSeen, 'CONNECTED');

    const byteSeen = new Promise<number>((resolve) => client.once('bytecount', (b) => resolve(b.inBytes)));
    server.broadcast('>BYTECOUNT:12345,6789');
    assert.equal(await byteSeen, 12345);

    await client.disconnect();
    await server.stop();
  });

  it('serializes commands through the FIFO queue', async () => {
    const server = new MockManagementServer({
      async onCommand(line) {
        if (line === 'slow') {
          await sleep(80);
          return ['SUCCESS: slow done'];
        }
        if (line === 'fast') {
          return ['SUCCESS: fast done'];
        }
        return undefined;
      },
    });
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false, initSequence: [] });
    await client.connect();

    const order: string[] = [];
    const slow = client.send('slow', { expect: 'single' }).then((r) => order.push(r.success ?? 'slow'));
    const fast = client.send('fast', { expect: 'single' }).then((r) => order.push(r.success ?? 'fast'));
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['slow done', 'fast done']);

    await client.disconnect();
    await server.stop();
  });

  it('rejects commands that time out', async () => {
    const server = new MockManagementServer({
      onCommand(line) {
        if (line === 'hang') return undefined; // never answer
        return undefined;
      },
    });
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false, initSequence: [] });
    await client.connect();

    await assert.rejects(() => client.send('hang', { expect: 'single', timeoutMs: 120 }), /timed out/);

    await client.disconnect();
    await server.stop();
  });

  it('emits pk-sign and need-certificate events', async () => {
    const server = new MockManagementServer();
    const port = await server.start();
    const client = new ManagementClient({ host: '127.0.0.1', port, autoReconnect: false });
    await client.connect();

    const signSeen = new Promise<string>((resolve) => client.once('pk-sign', (req) => resolve(req.algorithm ?? '')));
    server.broadcast('>PK_SIGN:aGVsbG8=,RSA_PKCS1_PADDING');
    assert.equal(await signSeen, 'RSA_PKCS1_PADDING');

    const certSeen = new Promise<string>((resolve) => client.once('need-certificate', (hint) => resolve(hint)));
    server.broadcast('>NEED-CERTIFICATE:macosx-keychain:subject:o=OpenVPN-TEST');
    assert.equal(await certSeen, 'macosx-keychain:subject:o=OpenVPN-TEST');

    await client.disconnect();
    await server.stop();
  });

  it('connects over a unix domain socket (POSIX)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('unix domain sockets are not reliable on Windows CI');
      return;
    }
    const socketPath = `/tmp/ovpn-sdk-mock-${process.pid}-${Date.now()}.sock`;
    const bareServer = new MockManagementServer({ socketPath });
    await bareServer.start();
    const client = new ManagementClient({ socketPath, autoReconnect: false, initSequence: [] });
    await client.connect();
    assert.ok(client.welcomeLine.includes('OpenVPN Management Interface'));
    const pid = await client.send('pid');
    assert.equal(pid.success, 'pid=4242');
    await client.disconnect();
    await bareServer.stop();
  });
});
