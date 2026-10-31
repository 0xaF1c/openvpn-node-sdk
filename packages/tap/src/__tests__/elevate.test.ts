import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ElevatedBroker,
  ElevationCancelledError,
  ElevationError,
  ElevationUnavailableError,
  buildAppleScriptLaunchCommand,
  buildElectronElevatedLaunchCommand,
  buildElevatedLaunchCommand,
  buildPosixLaunchCommand,
  isElevated,
  resolveElevationHelperPath,
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

/** Create a scratch directory and run `body` with it, always cleaning up. */
async function withTempDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a dummy helper file and return its absolute path. */
async function writeHelper(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '// stand-in for elevate-helper.js\n', 'utf8');
  return file;
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

describe('buildElectronElevatedLaunchCommand', () => {
  it('runs the helper under Electron as Node with ELECTRON_RUN_AS_NODE', () => {
    const command = buildElectronElevatedLaunchCommand({
      nodePath: 'C:\\Program Files\\Acme\\Acme.exe',
      helperPath: 'C:\\Program Files\\Acme\\resources\\app.asar.unpacked\\out\\main\\elevate-helper.mjs',
      port: 4321,
      token: 'abc123',
    });
    assert.equal(command.targetFile, 'C:\\Program Files\\Acme\\Acme.exe');
    assert.match(command.powerShellScript, /-Verb RunAs/);
    assert.match(command.powerShellScript, /WindowsPowerShell/);

    const encoded = command.powerShellScript.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    assert.ok(encoded, 'outer script carries an encoded inner command');
    const inner = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(inner, /ELECTRON_RUN_AS_NODE = '1'/);
    assert.ok(inner.includes(String.raw`FilePath 'C:\Program Files\Acme\Acme.exe'`));
    assert.ok(inner.includes('elevate-helper.mjs'));
  });
});

describe('buildPosixLaunchCommand', () => {
  it('runs node with the helper arguments', () => {
    const command = buildPosixLaunchCommand({
      nodePath: '/usr/bin/node',
      helperPath: '/opt/OpenVPN/elevate-helper.js',
      port: 4321,
      token: 'abc123',
    });
    assert.equal(command, '/usr/bin/node /opt/OpenVPN/elevate-helper.js --port 4321 --token abc123');
  });

  it('quotes paths with spaces and single quotes', () => {
    const command = buildPosixLaunchCommand({
      nodePath: '/opt/My Node/node',
      helperPath: "/opt/it's/helper.js",
      port: 1,
      token: 't',
    });
    assert.equal(command, "'/opt/My Node/node' '/opt/it'\\''s/helper.js' --port 1 --token t");
  });
});

describe('buildAppleScriptLaunchCommand', () => {
  it('wraps the root command with administrator privileges', () => {
    const script = buildAppleScriptLaunchCommand({
      nodePath: '/usr/bin/node',
      helperPath: '/tmp/elevate-helper.js',
      port: 1,
      token: 't',
    });
    assert.equal(
      script,
      'do shell script "/usr/bin/node /tmp/elevate-helper.js --port 1 --token t" with administrator privileges',
    );
  });
});

describe('resolveElevationHelperPath', () => {
  it('finds the helper shipped next to the module', () => {
    const resolved = resolveElevationHelperPath();
    assert.ok(existsSync(resolved), `expected an existing helper, got ${resolved}`);
    assert.match(path.basename(resolved), /^elevate-helper\.(mjs|js|ts)$/);
  });

  it('returns an explicit helper path unchanged', async () => {
    await withTempDir('ovpn-helper-', async (dir) => {
      const helper = await writeHelper(path.join(dir, 'nested', 'elevate-helper.mjs'));
      assert.equal(
        resolveElevationHelperPath({ helperPath: helper }),
        path.resolve(helper),
      );
    });
  });

  it('fails fast and lists the checked paths when the explicit helper is missing', async () => {
    await withTempDir('ovpn-helper-missing-', async (dir) => {
      const missing = path.join(dir, 'does-not-exist', 'elevate-helper.js');
      assert.throws(
        () => resolveElevationHelperPath({ helperPath: missing }),
        (err: unknown) => {
          assert.ok(err instanceof ElevationUnavailableError, String(err));
          assert.match(err.message, /elevationHelperPath/);
          assert.ok(err.message.includes(path.resolve(missing)), err.message);
          return true;
        },
      );
    });
  });

  it('resolves the installed package when a bundler inlined the SDK', async () => {
    // Simulates an electron-vite/rollup build: the host entry is out/main/index.js
    // and the SDK only exists as an installed package under node_modules/.
    await withTempDir('ovpn-helper-bundled-', async (dir) => {
      const packageRoot = path.join(dir, 'node_modules', 'openvpn-node-sdk');
      const helper = await writeHelper(
        path.join(packageRoot, 'dist', 'tap', 'src', 'elevate-helper.mjs'),
      );
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'openvpn-node-sdk',
          type: 'module',
          exports: {
            '.': './dist/openvpn-sdk/src/index.js',
            './elevate-helper': './dist/tap/src/elevate-helper.mjs',
          },
        }),
        'utf8',
      );
      const hostBundle = path.join(dir, 'out', 'main', 'index.js');
      await mkdir(path.dirname(hostBundle), { recursive: true });
      await writeFile(hostBundle, '// bundled host entry\n', 'utf8');

      assert.equal(
        resolveElevationHelperPath({ moduleUrl: pathToFileURL(hostBundle) }),
        realpathSync(helper),
      );
    });
  });

  it('prefers the asarUnpack copy of a helper inside app.asar', async () => {
    await withTempDir('ovpn-helper-asar-', async (dir) => {
      const resources = path.join(dir, 'resources');
      const archiveDir = path.join(resources, 'app.asar', 'out', 'main');
      await mkdir(archiveDir, { recursive: true });
      const unpacked = await writeHelper(
        path.join(resources, 'app.asar.unpacked', 'out', 'main', 'elevate-helper.mjs'),
      );

      assert.equal(
        resolveElevationHelperPath({ moduleUrl: pathToFileURL(path.join(archiveDir, 'index.js')) }),
        path.resolve(unpacked),
      );
    });
  });

  it('rejects a helper that only exists inside app.asar (Electron)', async () => {
    await withTempDir('ovpn-helper-asar-only-', async (dir) => {
      const archiveDir = path.join(dir, 'resources', 'app.asar', 'out', 'main');
      await writeHelper(path.join(archiveDir, 'elevate-helper.mjs'));

      const versions = process.versions as unknown as Record<string, string | undefined>;
      const previous = versions.electron;
      versions.electron = '42.0.0';
      try {
        assert.throws(
          () => resolveElevationHelperPath({ moduleUrl: pathToFileURL(path.join(archiveDir, 'index.js')) }),
          (err: unknown) => {
            assert.ok(err instanceof ElevationUnavailableError, String(err));
            assert.match(err.message, /app\.asar/);
            assert.match(err.message, /asarUnpack/);
            return true;
          },
        );
      } finally {
        if (previous === undefined) delete versions.electron;
        else versions.electron = previous;
      }
    });
  });
});

describe('ElevatedBroker helper resolution', () => {
  it('uses an explicit helper path', async () => {
    await withTempDir('ovpn-broker-', async (dir) => {
      const helper = await writeHelper(path.join(dir, 'elevate-helper.mjs'));
      const broker = new ElevatedBroker({ helperPath: helper });
      try {
        assert.equal(broker.helperPath, path.resolve(helper));
      } finally {
        await broker.dispose();
      }
    });
  });

  it('throws immediately for a helper path that does not exist', () => {
    assert.throws(
      () => new ElevatedBroker({ helperPath: path.join(tmpdir(), 'ovpn-missing-helper', 'elevate-helper.js') }),
      (err: unknown) => {
        assert.ok(err instanceof ElevationUnavailableError, String(err));
        assert.match(err.message, /was not found/);
        return true;
      },
    );
  });

  it('includes the helper path in the handshake timeout error', async () => {
    const broker = new ElevatedBroker({
      launch: async () => {},
      handshakeTimeoutMs: 50,
      helperPath: resolveElevationHelperPath(),
    });
    await assert.rejects(
      () => broker.run('tapctl.exe', ['list']),
      (err: unknown) => {
        assert.ok(err instanceof ElevationError, String(err));
        assert.match(err.message, /did not connect back/);
        assert.ok(err.message.includes(broker.helperPath), err.message);
        return true;
      },
    );
  });
});

describe('isElevated', { skip: process.platform === 'win32' && 'Windows uses the net session probe' }, () => {
  it('reflects the effective uid on POSIX', async () => {
    assert.equal(await isElevated(), process.getuid?.() === 0);
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
