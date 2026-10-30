import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { describe, it } from 'node:test';
import {
  ElevatedBroker,
  ElevationCancelledError,
  ElevationError,
  ElevationUnavailableError,
  buildElevatedLaunchCommand,
  isElevated,
  type ElevatedLaunchOptions,
} from '../elevate.ts';

type Send = (message: Record<string, unknown>) => void;

interface FakeHelper {
  launch: (options: ElevatedLaunchOptions) => Promise<void>;
  sockets: Socket[];
}

interface FakeHelperOptions {
  /** Override the token sent in the hello message (to test rejection). */
  token?: string;
  /** Handle one command; return true when it was handled. */
  onCommand?: (command: Record<string, unknown>, send: Send) => boolean;
}

function defaultHandler(command: Record<string, unknown>, send: Send): void {
  const id = command.id;
  switch (command.op) {
    case 'run':
      send({
        id,
        ok: true,
        stdout: Buffer.from(`ran:${String(command.file)}`).toString('base64'),
        stderr: Buffer.from('').toString('base64'),
        exitCode: 0,
      });
      break;
    case 'spawn':
      send({ event: 'spawned', id, pid: 4242 });
      setTimeout(() => {
        send({ event: 'output', id, stream: 'stdout', data: Buffer.from('hello from openvpn').toString('base64') });
        send({ event: 'exit', id, code: 0, signal: null });
      }, 5);
      break;
    case 'kill':
      send({ id, ok: true });
      break;
    case 'shutdown':
      send({ id, ok: true });
      break;
    default:
      send({ id, ok: false, error: `unknown op ${String(command.op)}` });
      break;
  }
}

/** Simulate the elevated helper: connect back, handshake, answer commands. */
function startFakeHelper(options: FakeHelperOptions = {}): FakeHelper {
  const sockets: Socket[] = [];
  const launch = async ({ port, token }: ElevatedLaunchOptions): Promise<void> => {
    const socket = connect({ host: '127.0.0.1', port });
    sockets.push(socket);
    const send: Send = (message) => {
      if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
    };
    socket.on('connect', () => send({ event: 'hello', token: options.token ?? token }));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        const command = JSON.parse(line) as Record<string, unknown>;
        if (options.onCommand?.(command, send)) continue;
        defaultHandler(command, send);
      }
    });
  };
  return { launch, sockets };
}

function destroyAll(helper: FakeHelper): void {
  for (const socket of helper.sockets) socket.destroy();
}

describe('buildElevatedLaunchCommand', () => {
  it('elevates node with the helper arguments by default', () => {
    const command = buildElevatedLaunchCommand({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      helperPath: 'C:\\sdk\\elevate-helper.js',
      port: 4321,
      token: 'abc123',
    });
    assert.equal(command.targetFile, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(command.targetArguments, String.raw`C:\sdk\elevate-helper.js --port 4321 --token abc123`);
    assert.ok(command.powerShellScript.includes(String.raw`Start-Process -FilePath 'C:\Program Files\nodejs\node.exe'`));
    assert.match(command.powerShellScript, /-Verb RunAs/);
  });

  it('elevates a branded launcher and forwards node + helper paths', () => {
    const command = buildElevatedLaunchCommand({
      nodePath: 'C:\\node\\node.exe',
      helperPath: 'C:\\sdk\\elevate-helper.js',
      port: 1,
      token: 't',
      launcherPath: 'C:\\Brand\\AcmeElevate.exe',
    });
    assert.equal(command.targetFile, 'C:\\Brand\\AcmeElevate.exe');
    assert.equal(
      command.targetArguments,
      String.raw`C:\node\node.exe C:\sdk\elevate-helper.js --port 1 --token t`,
    );
    assert.ok(command.powerShellScript.includes(String.raw`FilePath 'C:\Brand\AcmeElevate.exe'`));
  });

  it('quotes paths with spaces', () => {
    const command = buildElevatedLaunchCommand({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      helperPath: 'C:\\Program Files\\SDK\\elevate-helper.js',
      port: 2,
      token: 'x',
    });
    assert.equal(
      command.targetArguments,
      String.raw`"C:\Program Files\SDK\elevate-helper.js" --port 2 --token x`,
    );
  });
});

describe('isElevated', { skip: process.platform === 'win32' && 'Windows uses the net session probe' }, () => {
  it('reflects the effective uid on POSIX', async () => {
    assert.equal(await isElevated(), process.getuid?.() === 0);
  });
});

describe('Default launcher', { skip: process.platform === 'win32' && 'Windows uses PowerShell/UAC' }, () => {
  it('reports UAC as unavailable off Windows', async () => {
    const broker = new ElevatedBroker({ handshakeTimeoutMs: 200 });
    await assert.rejects(() => broker.run('tapctl.exe', ['list']), ElevationUnavailableError);
  });
});

describe('ElevatedBroker', () => {
  it('runs a command through the fake elevated helper', async () => {
    const helper = startFakeHelper();
    const broker = new ElevatedBroker({ launch: helper.launch, handshakeTimeoutMs: 2000, commandTimeoutMs: 2000 });
    try {
      const result = await broker.run('tapctl.exe', ['list']);
      assert.equal(broker.connected, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.toString(), 'ran:tapctl.exe');
      assert.equal(result.stderr.toString(), '');
    } finally {
      await broker.dispose();
      destroyAll(helper);
    }
  });

  it('passes a branded launcher path to the launcher', async () => {
    const helper = startFakeHelper();
    const seen: ElevatedLaunchOptions[] = [];
    const broker = new ElevatedBroker({
      launcherPath: 'C:\\Brand\\AcmeElevate.exe',
      launch: async (options) => {
        seen.push(options);
        await helper.launch(options);
      },
      handshakeTimeoutMs: 2000,
      commandTimeoutMs: 2000,
    });
    try {
      await broker.run('tapctl.exe', ['list']);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.launcherPath, 'C:\\Brand\\AcmeElevate.exe');
    } finally {
      await broker.dispose();
      destroyAll(helper);
    }
  });

  it('spawns a process and streams output and the exit code', async () => {
    const helper = startFakeHelper();
    const broker = new ElevatedBroker({ launch: helper.launch, handshakeTimeoutMs: 2000, commandTimeoutMs: 2000 });
    try {
      const child = await broker.spawn('openvpn.exe', ['--config', 'profile.ovpn'], { cwd: 'C:\\tmp' });
      assert.equal(child.pid, 4242);
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      assert.equal(code, 0);
      assert.equal(child.getStdout(), 'hello from openvpn');
      assert.equal(child.exitCode, 0);
    } finally {
      await broker.dispose();
      destroyAll(helper);
    }
  });

  it('rejects a helper that sends the wrong token', async () => {
    const helper = startFakeHelper({ token: 'not-the-token' });
    const broker = new ElevatedBroker({ launch: helper.launch, handshakeTimeoutMs: 1000, commandTimeoutMs: 1000 });
    try {
      await assert.rejects(() => broker.run('tapctl.exe', ['list']), ElevationError);
    } finally {
      await broker.dispose();
      destroyAll(helper);
    }
  });

  it('surfaces a cancelled UAC prompt', async () => {
    const broker = new ElevatedBroker({
      launch: async () => {
        throw new ElevationCancelledError('the user cancelled');
      },
      handshakeTimeoutMs: 1000,
    });
    await assert.rejects(() => broker.run('tapctl.exe', ['list']), ElevationCancelledError);
  });

  it('times out when the helper never connects', async () => {
    const broker = new ElevatedBroker({
      launch: async () => {},
      handshakeTimeoutMs: 100,
    });
    await assert.rejects(() => broker.run('tapctl.exe', ['list']), /did not connect back/);
  });

  it('rejects commands after dispose', async () => {
    const helper = startFakeHelper();
    const broker = new ElevatedBroker({ launch: helper.launch, handshakeTimeoutMs: 2000, commandTimeoutMs: 2000 });
    await broker.run('tapctl.exe', ['list']);
    await broker.dispose();
    assert.equal(broker.connected, false);
    await assert.rejects(() => broker.run('tapctl.exe', ['list']), /disposed/);
    destroyAll(helper);
  });

  it('marks a running process as exited when the helper disconnects', async () => {
    const helper = startFakeHelper({ onCommand: () => false });
    const broker = new ElevatedBroker({ launch: helper.launch, handshakeTimeoutMs: 2000, commandTimeoutMs: 2000 });
    try {
      const child = await broker.spawn('openvpn.exe', []);
      const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
      destroyAll(helper);
      assert.equal(await exit, 1);
    } finally {
      await broker.dispose();
    }
  });
});
