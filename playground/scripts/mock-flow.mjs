#!/usr/bin/env node
/**
 * Scenario: full management-interface round trip with a scriptable mock server.
 *
 * No OpenVPN binary and no network access are required: a `MockManagementServer`
 * speaks the wire protocol and a `FakeProcessManager` stands in for the spawned
 * process. This exercises the same public surface the unit tests use, but from
 * outside the workspace (package-name import, like a real consumer).
 *
 *   npm run playground          # same as npm run playground:mock
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MockManagementServer,
  OpenVpnClient,
  OpenVpnServer,
  OvpnConfig,
  defaultMockResponse,
} from 'openvpn-node-sdk';
import {
  bold,
  createFakeAdapterManager,
  createFakeProcessManager,
  dim,
  EXIT_FAIL,
  onceEvent,
  Reporter,
  waitForCondition,
  yellow,
} from './lib.mjs';

const reporter = new Reporter('playground:mock-flow');
const mockLines = {
  auth: [],
  sig: [],
  sigCommand: null,
  inAuth: false,
  inSig: false,
};

/** Wire-protocol-shaped answers for the commands this scenario sends. */
function handleCommand(line) {
  if (mockLines.inSig) {
    if (line === 'END') {
      mockLines.inSig = false;
      return [];
    }
    mockLines.sig.push(line);
    return [];
  }
  if (mockLines.inAuth) {
    if (line === 'END') {
      mockLines.inAuth = false;
      return ['SUCCESS: client-auth command succeeded'];
    }
    mockLines.auth.push(line);
    return [];
  }
  if (line === 'pk-sig' || line === 'rsa-sig' || line === 'certificate') {
    mockLines.inSig = true;
    mockLines.sigCommand = line;
    mockLines.sig = [];
    return [];
  }
  if (line.startsWith('client-auth ')) {
    mockLines.inAuth = true;
    mockLines.auth = [];
    return [];
  }
  if (line.startsWith('client-auth-nt ')) return ['SUCCESS: client-auth command succeeded'];
  if (line.startsWith('client-deny ')) return ['SUCCESS: client-deny command succeeded'];
  if (line.startsWith('client-kill ')) return ['SUCCESS: client-kill command succeeded'];
  if (line.startsWith('username ') || line.startsWith('password ')) {
    return [`SUCCESS: ${line.split(/\s+/)[0]} entered`];
  }
  if (line === 'status' || line.startsWith('status ')) {
    return [
      'TITLE,OpenVPN 2.8 mock',
      'HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID,Data Channel Cipher',
      'CLIENT_LIST,alice,10.0.0.2,10.8.0.6,,1234,5678,2026-05-06 12:00:00,1715000000,,0,1,CHACHA20-POLY1305',
      'HEADER,ROUTING_TABLE,Virtual Address,Common Name,Real Address,Last Ref,Last Ref (time_t)',
      'ROUTING_TABLE,10.8.0.0/24,alice,10.0.0.2,2026-05-06 12:00:00,1715000000',
      'END',
    ];
  }
  return defaultMockResponse(line);
}

const received = () => server.received;

let server;

async function runClientFlow() {
  const fake = createFakeProcessManager();
  const fakeAdapter = createFakeAdapterManager();
  const openVpnConfig = new OvpnConfig().client().remote('vpn.example.com', 1194, 'udp').authUserPass();

  reporter.section('client: spawn arguments');
  const client = new OpenVpnClient(openVpnConfig, {
    binary: process.execPath,
    processManager: fake.manager,
    adapterManager: fakeAdapter.manager,
    managementHost: '127.0.0.1',
    managementPort: server.port,
    manageAdapter: true,
    connectTimeoutMs: 5000,
    disconnectTimeoutMs: 250,
    extraArgs: ['--verb', '3'],
    credentials: async () => ({ username: 'alice', password: 'p@ss word"x' }),
    signer: async () => Buffer.from('sig-bytes'),
  });
  client.on('error', (err) => reporter.fail('client emitted error', err instanceof Error ? err.message : String(err)));
  const states = [];
  const logs = [];
  const bytes = [];
  client.on('state', (state) => states.push(state));
  client.on('log', (log) => logs.push(log));
  client.on('bytecount', (count) => bytes.push(count));

  const managementConnected = onceEvent(client, 'management-connected', 5000);
  managementConnected.catch(() => {});
  await client.connect();
  await managementConnected;

  reporter.expect(fake.started.length === 1, 'exactly one process start was requested');
  const started = fake.started[0] ?? { binary: '', args: [] };
  reporter.expect(started.binary === process.execPath, 'injected process manager received the resolved binary');
  reporter.expect(started.args.includes('--management-hold'), 'argv contains --management-hold');
  reporter.expect(started.args.includes('--management-query-passwords'), 'argv contains --management-query-passwords');
  reporter.expect(started.args.includes('--management') && started.args.includes(String(server.port)), 'argv wires the management port');
  reporter.expect(started.args.includes('--verb') && started.args.includes('3'), 'extraArgs are forwarded');

  const cfgIndex = started.args.indexOf('--config');
  const configPath = cfgIndex >= 0 ? started.args[cfgIndex + 1] : '';
  reporter.expect(configPath !== '' && existsSync(configPath), 'config file was written to a temp directory');
  const configText = configPath ? await readFile(configPath, 'utf8') : '';
  reporter.expect(configText.startsWith('client\n'), 'config text starts with `client`');
  reporter.expect(configText.includes('remote vpn.example.com 1194 udp'), 'config text keeps the remote directive');
  if (process.platform === 'win32') {
    reporter.expect(configText.includes('dev-node "Playground TAP Adapter"'), 'dev-node was injected from the adapter manager');
    reporter.expect(fakeAdapter.calls.ensure.length === 1, 'adapter manager ensure() was called once');
  } else {
    reporter.skip(`adapter injection is Windows-only (running on ${process.platform})`);
  }

  reporter.section('client: management handshake');
  await waitForCondition(
    () => ['version 6', 'state on all', 'log on all', 'bytecount 1'].every((cmd) => received().includes(cmd)),
    'init sequence',
  );
  reporter.ok('init sequence reached the server (version 6 / state on all / log on all / bytecount 1)');

  reporter.section('client: state / log / bytecount notifications');
  server.broadcast('>STATE:1715000000,CONNECTING,init,,,,,,,');
  server.broadcast('>STATE:1715000001,CONNECTED,init,10.8.0.6,,,,,');
  await client.waitFor('CONNECTED', 2000);
  reporter.expect(client.currentState?.name === 'CONNECTED', 'waitFor(CONNECTED) resolved and currentState is CONNECTED');
  reporter.expect(states.map((state) => state.name).join(',') === 'CONNECTING,CONNECTED', 'state events arrived in order', JSON.stringify(states.map((state) => state.name)));
  reporter.expect(client.states.length === 2, 'state history keeps every notification');

  server.broadcast('>LOG:1715000002,I,playground log line');
  await waitForCondition(() => logs.length > 0, 'log notification');
  reporter.expect(logs[0]?.text === 'playground log line' && logs[0]?.level === 'I', 'log notification is parsed');

  server.broadcast('>BYTECOUNT:1234,5678');
  await waitForCondition(() => bytes.length > 0, 'bytecount notification');
  reporter.expect(bytes[0]?.inBytes === 1234 && bytes[0]?.outBytes === 5678, 'bytecount notification is parsed');

  reporter.section('client: credential challenge');
  const authSubmitted = waitForCondition(
    () => received().some((line) => line === 'username "Auth" alice') && received().some((line) => line.startsWith('password "Auth" ')),
    'credential submission',
  );
  server.broadcast(">PASSWORD:Need 'Auth' username/password");
  await authSubmitted;
  reporter.ok('credentials provider answered the >PASSWORD challenge');
  const passwordLine = received().find((line) => line.startsWith('password "Auth" ')) ?? '';
  reporter.expect(passwordLine === 'password "Auth" "p@ss word\\"x"', 'password argument is escaped for the config lexer', passwordLine);

  reporter.section('client: external key signing');
  const signed = waitForCondition(() => mockLines.sig.length > 0 && !mockLines.inSig, 'pk-sig body');
  server.broadcast('>PK_SIGN:aGVsbG8=,RSA_PKCS1_PADDING');
  await signed;
  reporter.expect(mockLines.sigCommand === 'pk-sig', 'signer answered with the pk-sig command', String(mockLines.sigCommand));
  reporter.expect(mockLines.sig.join('') === Buffer.from('sig-bytes').toString('base64'), 'signature body is base64 encoded and END-terminated');

  reporter.section('client: missing certificate provider');
  const certRequired = onceEvent(client, 'certificate-required', 2000);
  server.broadcast('>NEED-CERTIFICATE:macosx-keychain:subject:o=OpenVPN-TEST');
  const [certHint] = await certRequired;
  reporter.expect(certHint === 'macosx-keychain:subject:o=OpenVPN-TEST', 'certificate-required carries the hint', String(certHint));

  reporter.section('client: disconnect');
  await client.disconnect();
  reporter.expect(received().includes('signal SIGTERM'), 'disconnect sent `signal SIGTERM` over management');
  reporter.expect(fake.killTreeCalls.length === 1, 'process tree was force-killed after the grace period', JSON.stringify(fake.killTreeCalls));
  reporter.expect(fakeAdapter.calls.released.includes('{fake-adapter-guid}'), 'adapter was released on disconnect', JSON.stringify(fakeAdapter.calls.released));
  reporter.expect(!existsSync(path.dirname(configPath)), 'temporary config directory was removed');
  reporter.expect(client.states.length === 2, 'state history survives until the next connect');
}

async function runServerFlow() {
  const fake = createFakeProcessManager();
  const openVpnConfig = new OvpnConfig().raw('server').raw('dev', 'tun').raw('topology', 'subnet').raw('ifconfig', '10.8.0.1 10.8.0.2');
  const serverInstance = new OpenVpnServer(openVpnConfig, {
    binary: process.execPath,
    processManager: fake.manager,
    managementPort: server.port,
    manageAdapter: false,
    connectTimeoutMs: 5000,
    disconnectTimeoutMs: 250,
    extraArgs: ['--management-client-auth'],
  });
  serverInstance.on('error', (err) => reporter.fail('server emitted error', err instanceof Error ? err.message : String(err)));

  reporter.section('server: client-auth decisions');
  const clientConnect = onceEvent(serverInstance, 'client-connect', 3000);
  await serverInstance.connect();
  server.broadcast('>CLIENT:CONNECT,0,1');
  server.broadcast('>CLIENT:ENV,common_name=alice');
  server.broadcast('>CLIENT:ENV,untrusted_ip=10.0.0.2');
  server.broadcast('>CLIENT:ENV,END');
  const [connectEvent] = await clientConnect;
  reporter.expect(connectEvent.cid === 0 && connectEvent.kid === 1, 'client-connect carries cid/kid');
  reporter.expect(JSON.stringify(connectEvent.env) === JSON.stringify({ common_name: 'alice', untrusted_ip: '10.0.0.2' }), 'client-connect collects the ENV block', JSON.stringify(connectEvent.env));

  await serverInstance.approveClient(0, 1);
  reporter.expect(received().includes('client-auth-nt 0 1'), 'approveClient without config lines uses client-auth-nt');

  const multilineApproved = serverInstance.approveClient(0, 2, ['push "route 10.0.0.0 255.0.0.0"']);
  await multilineApproved;
  reporter.expect(received().includes('client-auth 0 2'), 'approveClient with config lines uses client-auth');
  reporter.expect(mockLines.auth.includes('push "route 10.0.0.0 255.0.0.0"'), 'config lines were sent before END', JSON.stringify(mockLines.auth));

  await serverInstance.denyClient(0, 1, 'bad cert');
  reporter.expect(received().includes('client-deny 0 1 "bad cert"'), 'denyClient quotes the reason');

  await serverInstance.killClient(3, 'restart');
  reporter.expect(received().includes('client-kill 3 restart'), 'killClient forwards the message');

  const status = await serverInstance.getStatus();
  reporter.expect(status.clients.length === 1, 'getStatus parsed one CLIENT_LIST row', JSON.stringify(status.clients));
  reporter.expect(status.clients[0]?.commonName === 'alice', 'getStatus parsed the common name');
  reporter.expect(status.routes.length === 1 && status.routes[0]?.virtualAddress === '10.8.0.0/24', 'getStatus parsed the ROUTING_TABLE row');

  await serverInstance.disconnect();
  reporter.expect(received().includes('signal SIGTERM'), 'server disconnect sent `signal SIGTERM`');
}

async function main() {
  console.log(bold('playground:mock-flow') + dim('  (MockManagementServer + fake process manager; no OpenVPN required)'));
  server = new MockManagementServer({ onCommand: handleCommand });
  server.port = await server.start();
  reporter.info(`mock management server listening on 127.0.0.1:${server.port}`);
  try {
    await runClientFlow();
    await runServerFlow();
  } finally {
    await server.stop();
  }
  return reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:mock-flow crashed:'), err);
    reporter.fail('scenario threw', err instanceof Error ? err.stack ?? err.message : String(err));
    reporter.summary();
    process.exitCode = EXIT_FAIL;
  });
