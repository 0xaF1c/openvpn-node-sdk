import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { describe, it } from 'node:test';
import {
  ADAPTER_TYPE_DCO,
  ADAPTER_TYPE_TAP,
  DEFAULT_SERVICE_PIPE,
  MSG_ACKNOWLEDGEMENT,
  MSG_CREATE_ADAPTER,
  OpenvpnServiceClient,
  OpenvpnServiceStartError,
  SERVICE_ERROR_STARTUP_DATA,
  ServiceOpenVpnProcess,
  ackSize,
  decodeAck,
  decodeHeader,
  describeServiceError,
  encodeCreateAdapterMessage,
  encodeHeader,
  encodeStartupData,
  headerSize,
  parseServiceErrorText,
  parseStartupResponse,
  readOpenvpnServiceSettings,
  type ServiceCommandExec,
  type ServiceSocket,
} from '../openvpnserv.ts';

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92);

/** Minimal duplex that records writes and lets the test play the service. */
class FakePipe extends Duplex {
  readonly written: Buffer[] = [];

  override _read(): void {
    // Data is pushed by respond().
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }

  respondText(text: string): void {
    this.push(Buffer.from(text, 'utf16le'));
  }

  respondBytes(bytes: Buffer): void {
    this.push(bytes);
  }

  endFromService(): void {
    this.push(null);
  }
}

function asSocket(pipe: FakePipe): ServiceSocket {
  return pipe as unknown as ServiceSocket;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('openvpnserv pipe protocol', () => {
  it('computes 32/64-bit header and struct sizes', () => {
    assert.equal(headerSize('x64'), 24);
    assert.equal(headerSize('arm64'), 24);
    assert.equal(headerSize('x86'), 12);
    assert.equal(headerSize('ia32'), 12);
    assert.equal(ackSize('x64'), 32);
    assert.equal(ackSize('x86'), 16);
  });

  it('round-trips message headers', () => {
    for (const arch of ['x64', 'x86']) {
      const buf = encodeHeader({ type: MSG_CREATE_ADAPTER, size: arch === 'x64' ? 32 : 16, messageId: 42 }, arch);
      assert.equal(buf.length, headerSize(arch));
      const decoded = decodeHeader(buf, arch);
      assert.deepEqual(decoded, { type: MSG_CREATE_ADAPTER, size: arch === 'x64' ? 32 : 16, messageId: 42 });
    }
  });

  it('encodes create-adapter messages with the expected layout', () => {
    const msg = encodeCreateAdapterMessage(ADAPTER_TYPE_DCO, 7, 'x64');
    assert.equal(msg.length, 32);
    assert.equal(msg.readInt32LE(0), MSG_CREATE_ADAPTER);
    assert.equal(Number(msg.readBigInt64LE(8)), 32);
    assert.equal(msg.readInt32LE(16), 7);
    assert.equal(msg.readInt32LE(24), ADAPTER_TYPE_DCO);

    const msg86 = encodeCreateAdapterMessage(ADAPTER_TYPE_TAP, 3, 'x86');
    assert.equal(msg86.length, 16);
    assert.equal(msg86.readInt32LE(0), MSG_CREATE_ADAPTER);
    assert.equal(msg86.readInt32LE(4), 16);
    assert.equal(msg86.readInt32LE(8), 3);
    assert.equal(msg86.readInt32LE(12), ADAPTER_TYPE_TAP);
  });

  it('decodes ack messages', () => {
    const ack = Buffer.alloc(32);
    encodeHeader({ type: MSG_ACKNOWLEDGEMENT, size: 32, messageId: 9 }, 'x64').copy(ack, 0);
    ack.writeInt32LE(0x2e4, 24);
    const decoded = decodeAck(ack, 'x64');
    assert.equal(decoded.header.type, MSG_ACKNOWLEDGEMENT);
    assert.equal(decoded.errorNumber, 0x2e4);
  });

  it('defaults to the interactive-service pipe path', () => {
    assert.equal(DEFAULT_SERVICE_PIPE, `${BS}${BS}.${BS}pipe${BS}openvpn${BS}service`);
  });

  it('encodes the UTF-16 startup blob (cwd, options, stdin)', () => {
    const buf = encodeStartupData({
      workingDirectory: 'C:' + BS + 'work',
      options: '--config "a b.ovpn"',
      stdin: '',
    });
    assert.equal(
      buf.toString('utf16le'),
      'C:' + BS + 'work' + NUL + '--config "a b.ovpn"' + NUL + NUL,
    );
    assert.throws(() => encodeStartupData({ workingDirectory: 'a' + NUL, options: '' }), /NUL/);
  });

  it('parses the process-id reply', () => {
    const parsed = parseStartupResponse(`0x00000000${NL}0x00003039${NL}Process ID`);
    assert.equal(parsed?.errorNumber, 0);
    assert.equal(parsed?.pid, 0x3039);
    assert.equal(parsed?.remainder, '');
  });

  it('waits for a complete reply', () => {
    assert.equal(parseStartupResponse('0x00000000'), null);
    assert.equal(parseStartupResponse(`0x00000000${NL}0x00003039${NL}Proc`), null);
  });

  it('parses a validation error reply', () => {
    const parsed = parseStartupResponse(
      `0x20000001${NL}ValidateOptions${NL}You have specified a config file location`,
    );
    assert.equal(parsed?.errorNumber, SERVICE_ERROR_STARTUP_DATA);
    assert.equal(parsed?.functionName, 'ValidateOptions');
    assert.equal(parsed?.pid, undefined);
    assert.match(parsed?.message ?? '', /config file location/);
  });

  it('parses asynchronous error frames', () => {
    const parsed = parseServiceErrorText(
      `0x20000000${NL}WaitForSingleObject${NL}OpenVPN exited with error: exit code = 5${NL}`,
    );
    assert.equal(parsed?.errorNumber, 0x20000000);
    assert.equal(parsed?.functionName, 'WaitForSingleObject');
    assert.match(parsed?.message ?? '', /exit code = 5/);
  });

  it('parses the two-line exit error frame emitted by openvpnserv', () => {
    const parsed = parseServiceErrorText(
      `0x20000000${NL}OpenVPN exited with error: exit code = 1${NL}`,
    );
    assert.equal(parsed?.errorNumber, 0x20000000);
    assert.equal(parsed?.message, 'OpenVPN exited with error: exit code = 1');

    const withoutTrailingNewline = parseServiceErrorText(
      `0x20000000${NL}OpenVPN exited with error: exit code = 1`,
    );
    assert.equal(withoutTrailingNewline?.message, 'OpenVPN exited with error: exit code = 1');
  });

  it('parses two-line startup validation errors', () => {
    const parsed = parseStartupResponse(
      `0x20000001${NL}You have specified a config file location that requires admin approval${NL}`,
    );
    assert.equal(parsed?.errorNumber, SERVICE_ERROR_STARTUP_DATA);
    assert.match(parsed?.message ?? '', /config file location/);
  });

  it('describes common service errors', () => {
    assert.match(describeServiceError(740), /elevation/);
    assert.match(describeServiceError(1062), /not running/);
    assert.match(describeServiceError(SERVICE_ERROR_STARTUP_DATA), /startup data/);
  });
});

describe('OpenvpnServiceClient', () => {
  it('creates an adapter through the pipe', async () => {
    const pipe = new FakePipe();
    const client = new OpenvpnServiceClient({ connector: async () => asSocket(pipe) });

    const result = client.createAdapter(ADAPTER_TYPE_DCO);
    await waitFor(() => pipe.written.length > 0);

    const request = pipe.written[0];
    assert.ok(request);
    assert.equal(request.readInt32LE(0), MSG_CREATE_ADAPTER);
    assert.equal(request.readInt32LE(24), ADAPTER_TYPE_DCO);

    const ack = Buffer.alloc(ackSize('x64'));
    encodeHeader({ type: MSG_ACKNOWLEDGEMENT, size: ack.length, messageId: 1 }, 'x64').copy(ack, 0);
    ack.writeInt32LE(0, 24);
    pipe.respondBytes(ack);

    assert.equal(await result, 0);
  });

  it('starts OpenVPN and reports the process id', async () => {
    const pipe = new FakePipe();
    const client = new OpenvpnServiceClient({ connector: async () => asSocket(pipe) });

    const starting = client.startOpenVpn({
      workingDirectory: 'C:' + BS + 'work',
      options: '--config "a b.ovpn"',
      stdin: '',
    });
    await waitFor(() => pipe.written.length > 0);

    const startup = pipe.written[0];
    assert.ok(startup);
    assert.equal(
      startup.toString('utf16le'),
      'C:' + BS + 'work' + NUL + '--config "a b.ovpn"' + NUL + NUL,
    );

    pipe.respondText(`0x00000000${NL}0x00003039${NL}Process ID`);
    const process = await starting;
    assert.equal(process.pid, 0x3039);

    const exit = new Promise<number | null>((resolve) => process.once('exit', (code) => resolve(code)));
    pipe.respondText(
      `0x20000000${NL}WaitForSingleObject${NL}OpenVPN exited with error: exit code = 5${NL}`,
    );
    pipe.endFromService();

    assert.equal(await exit, 1);
    assert.match(process.lastError, /exit code = 5/);
  });

  it('turns a validation error into OpenvpnServiceStartError', async () => {
    const pipe = new FakePipe();
    const client = new OpenvpnServiceClient({ connector: async () => asSocket(pipe) });

    const starting = client.startOpenVpn({ workingDirectory: 'C:' + BS + 'temp', options: '--config x.ovpn' });
    await waitFor(() => pipe.written.length > 0);
    pipe.respondText(
      `0x20000001${NL}You have specified a config file location that requires admin approval${NL}`,
    );
    pipe.endFromService();

    await assert.rejects(
      starting,
      (err: unknown) => {
        assert.ok(err instanceof OpenvpnServiceStartError);
        assert.equal(err.errorNumber, SERVICE_ERROR_STARTUP_DATA);
        assert.match(err.message, /admin approval/);
        return true;
      },
    );
  });

  it('reports availability from the connector', async () => {
    const available = new OpenvpnServiceClient({
      connector: async () => asSocket(new FakePipe()),
    });
    assert.equal(await available.isAvailable(100), true);

    const unavailable = new OpenvpnServiceClient({
      connector: async () => {
        throw new Error('EPERM');
      },
    });
    assert.equal(await unavailable.isAvailable(100), false);
  });
});

describe('ServiceOpenVpnProcess', () => {
  it('marks a clean pipe close as exit code 0', async () => {
    const pipe = new FakePipe();
    const process = new ServiceOpenVpnProcess(asSocket(pipe), 1234);
    const exit = new Promise<number | null>((resolve) => process.once('exit', (code) => resolve(code)));
    pipe.endFromService();
    assert.equal(await exit, 0);
    assert.equal(process.lastError, '');
  });

  it('ignores EPIPE when the service closes the pipe after a clean exit', async () => {
    const pipe = new FakePipe();
    const process = new ServiceOpenVpnProcess(asSocket(pipe), 1234);
    const exit = new Promise<number | null>((resolve) => process.once('exit', (code) => resolve(code)));
    const error = Object.assign(new Error('read EPIPE'), { code: 'EPIPE' });
    pipe.destroy(error);
    assert.equal(await exit, 0);
    assert.equal(process.lastError, '');
  });
});

describe('readOpenvpnServiceSettings', () => {
  it('parses HKLM\\SOFTWARE\\OpenVPN values', async () => {
    const output = [
      'HKEY_LOCAL_MACHINE' + BS + 'SOFTWARE' + BS + 'OpenVPN',
      '    (Default)    REG_SZ    C:' + BS + 'Program Files' + BS + 'OpenVPN' + BS,
      '    exe_path     REG_SZ    C:' + BS + 'Program Files' + BS + 'OpenVPN' + BS + 'bin' + BS + 'openvpn.exe',
      '    config_dir   REG_SZ    C:' + BS + 'Program Files' + BS + 'OpenVPN' + BS + 'config' + BS,
      '    ovpn_admin_group    REG_SZ    OpenVPN Administrators',
      '',
    ].join('\r\n');
    const exec: ServiceCommandExec = async () => ({ stdout: output, stderr: '', exitCode: 0 });

    const settings = await readOpenvpnServiceSettings(exec);
    assert.equal(settings?.exePath, 'C:' + BS + 'Program Files' + BS + 'OpenVPN' + BS + 'bin' + BS + 'openvpn.exe');
    assert.equal(settings?.configDir, 'C:' + BS + 'Program Files' + BS + 'OpenVPN' + BS + 'config' + BS);
    assert.equal(settings?.adminGroup, 'OpenVPN Administrators');
  });
});
