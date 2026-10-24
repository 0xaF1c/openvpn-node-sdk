import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';

/**
 * Client for the OpenVPN interactive service (`openvpnserv.exe`).
 *
 * The service runs as LocalSystem and exposes a byte/message-mode named pipe
 * (`\\.\pipe\openvpn\service`). Two capabilities are used by this SDK:
 *
 * 1. creating DCO/TAP adapters (`msg_create_adapter`) so a standard user does
 *    not need an elevated `tapctl.exe`;
 * 2. starting `openvpn.exe` with the service's elevated token. The protocol is
 *    a UTF-16LE startup blob (`cwd\0options\0stdin\0`) followed by a UTF-16LE
 *    three-line reply (`0x<error>\n<function|pid>\n<message|Process ID>`).
 *
 * Protocol reference: OpenVPN `include/openvpn-msg.h` and
 * `src/openvpnserv/interactive.c`.
 */

const BS = String.fromCharCode(92);

/** `\\.\pipe\openvpn\service` */
export const DEFAULT_SERVICE_PIPE = `${BS}${BS}.${BS}pipe${BS}openvpn${BS}service`;

/** Windows service name of the interactive service. */
export const INTERACTIVE_SERVICE_NAME = 'OpenVPNServiceInteractive';

/** `message_type_t` values from `openvpn-msg.h`. */
export const MSG_ACKNOWLEDGEMENT = 0;
export const MSG_ADD_ADDRESS = 1;
export const MSG_DEL_ADDRESS = 2;
export const MSG_ADD_ROUTE = 3;
export const MSG_DEL_ROUTE = 4;
export const MSG_ADD_DNS_CFG = 5;
export const MSG_DEL_DNS_CFG = 6;
export const MSG_ADD_NRPT_CFG = 7;
export const MSG_DEL_NRPT_CFG = 8;
export const MSG_ADD_NBT_CFG = 9;
export const MSG_DEL_NBT_CFG = 10;
export const MSG_FLUSH_NEIGHBORS = 11;
export const MSG_ADD_WFP_BLOCK = 12;
export const MSG_DEL_WFP_BLOCK = 13;
export const MSG_REGISTER_DNS = 14;
export const MSG_ENABLE_DHCP = 15;
/** Retired message slot kept for numbering compatibility. */
export const MSG_DEPRECATED_REGISTER_RING_BUFFERS = 16;
export const MSG_SET_MTU = 17;
export const MSG_ADD_WINS_CFG = 18;
export const MSG_DEL_WINS_CFG = 19;
export const MSG_CREATE_ADAPTER = 20;

/** `adapter_type_t` values. */
export const ADAPTER_TYPE_DCO = 0;
export const ADAPTER_TYPE_TAP = 1;

/** Win32/HRESULT-ish codes returned by the service. */
export const ERROR_ELEVATION_REQUIRED = 740;
export const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
export const ERROR_SERVICE_NOT_ACTIVE = 1062;
export const SERVICE_ERROR_OPENVPN_STARTUP = 0x20000000;
export const SERVICE_ERROR_STARTUP_DATA = 0x20000001;
export const SERVICE_ERROR_MESSAGE_DATA = 0x20000002;
export const SERVICE_ERROR_MESSAGE_TYPE = 0x20000003;

/** Maximum startup blob accepted by OpenVPN 2.6+ (4096 wide characters). */
export const MAX_STARTUP_BYTES = 4096 * 2;

export type AdapterTypeValue = typeof ADAPTER_TYPE_DCO | typeof ADAPTER_TYPE_TAP;

export interface ServiceMessageHeader {
  type: number;
  size: number;
  messageId: number;
}

/**
 * Size of `message_header_t` (`{ message_type_t; size_t; int }`).
 * x64/arm64: 24 bytes, ia32: 12 bytes.
 */
export function headerSize(arch: string = process.arch): number {
  return arch === 'ia32' || arch === 'x86' || arch === 'i386' ? 12 : 24;
}

function pointerAlignment(arch: string): number {
  return headerSize(arch) === 12 ? 4 : 8;
}

/** Size of `ack_message_t`, including trailing struct padding. */
export function ackSize(arch: string = process.arch): number {
  const hs = headerSize(arch);
  return Math.ceil((hs + 4) / pointerAlignment(arch)) * pointerAlignment(arch);
}

/** Size of `create_adapter_message_t`, including trailing struct padding. */
export function createAdapterMessageSize(arch: string = process.arch): number {
  const hs = headerSize(arch);
  return Math.ceil((hs + 4) / pointerAlignment(arch)) * pointerAlignment(arch);
}

export function encodeHeader(header: ServiceMessageHeader, arch: string = process.arch): Buffer {
  const buf = Buffer.alloc(headerSize(arch));
  buf.writeInt32LE(header.type, 0);
  if (arch === 'ia32' || arch === 'x86' || arch === 'i386') {
    buf.writeInt32LE(header.size, 4);
    buf.writeInt32LE(header.messageId, 8);
  } else {
    buf.writeBigInt64LE(BigInt(header.size), 8);
    buf.writeInt32LE(header.messageId, 16);
  }
  return buf;
}

export function decodeHeader(buf: Buffer, arch: string = process.arch): ServiceMessageHeader {
  const hs = headerSize(arch);
  if (buf.length < hs) {
    throw new RangeError(`message header needs ${hs} bytes, received ${buf.length}`);
  }
  if (arch === 'ia32' || arch === 'x86' || arch === 'i386') {
    return {
      type: buf.readInt32LE(0),
      size: buf.readInt32LE(4),
      messageId: buf.readInt32LE(8),
    };
  }
  return {
    type: buf.readInt32LE(0),
    size: Number(buf.readBigInt64LE(8)),
    messageId: buf.readInt32LE(16),
  };
}

/** Encode a `msg_create_adapter` message. */
export function encodeCreateAdapterMessage(
  adapterType: AdapterTypeValue,
  messageId = 1,
  arch: string = process.arch,
): Buffer {
  if (adapterType !== ADAPTER_TYPE_DCO && adapterType !== ADAPTER_TYPE_TAP) {
    throw new RangeError(`invalid adapter type ${String(adapterType)}`);
  }
  const hs = headerSize(arch);
  const size = createAdapterMessageSize(arch);
  const buf = Buffer.alloc(size);
  encodeHeader({ type: MSG_CREATE_ADAPTER, size, messageId }, arch).copy(buf, 0);
  buf.writeInt32LE(adapterType, hs);
  return buf;
}

/** Decode an `msg_acknowledgement` message. */
export function decodeAck(
  buf: Buffer,
  arch: string = process.arch,
): { header: ServiceMessageHeader; errorNumber: number } {
  const hs = headerSize(arch);
  if (buf.length < hs + 4) {
    throw new RangeError(`ack message needs ${hs + 4} bytes, received ${buf.length}`);
  }
  return {
    header: decodeHeader(buf, arch),
    errorNumber: buf.readInt32LE(hs),
  };
}

export interface OpenvpnStartupData {
  /** Working directory passed to `CreateProcessAsUser`. */
  workingDirectory: string;
  /** Windows command-line options; the service prepends `openvpn` and appends `--msg-channel`. */
  options: string;
  /** Content written to OpenVPN's stdin (usually empty). */
  stdin?: string;
}

/**
 * Encode the `STARTUP_DATA` blob read by `GetStartupData()`:
 * three NUL-terminated UTF-16LE strings (directory, options, stdin).
 */
export function encodeStartupData(input: OpenvpnStartupData): Buffer {
  for (const [name, value] of [
    ['workingDirectory', input.workingDirectory],
    ['options', input.options],
    ['stdin', input.stdin ?? ''],
  ] as const) {
    if (value.includes('\0')) {
      throw new RangeError(`${name} must not contain NUL characters`);
    }
  }
  const blob = `${input.workingDirectory}\0${input.options}\0${input.stdin ?? ''}\0`;
  const buf = Buffer.from(blob, 'utf16le');
  if (buf.length > MAX_STARTUP_BYTES) {
    throw new RangeError(
      `startup data is ${buf.length} bytes; openvpnserv accepts at most ${MAX_STARTUP_BYTES} bytes`,
    );
  }
  return buf;
}

export interface ServiceStartupResponse {
  errorNumber: number;
  /** Function that reported the error (`ReturnError`) or empty for a PID reply. */
  functionName: string;
  /** Error message, or `Process ID` for a successful launch. */
  message: string;
  /** Parsed process id on success. */
  pid?: number;
  /** Data that followed the 3-line reply (usually an exit error). */
  remainder: string;
}

/**
 * Parse the first service reply. Returns `null` while the reply is incomplete
 * or if the text is not a service reply at all.
 */
export function parseStartupResponse(text: string): ServiceStartupResponse | null {
  const first = text.indexOf('\n');
  if (first < 0) return null;
  const second = text.indexOf('\n', first + 1);
  if (second < 0) return null;

  const errorLine = text.slice(0, first).trim();
  if (!/^0x[0-9a-f]{1,8}$/i.test(errorLine)) return null;
  const errorNumber = Number.parseInt(errorLine.slice(2), 16);

  const secondLine = text.slice(first + 1, second).replace(/\r$/, '');
  const rest = text.slice(second + 1);

  if (errorNumber === 0) {
    if (!/^0x[0-9a-f]+$/i.test(secondLine)) return null;
    if (!rest.startsWith('Process ID')) {
      // `Process ID` may be split across pipe reads.
      if ('Process ID'.startsWith(rest)) return null;
      return null;
    }
    return {
      errorNumber,
      functionName: '',
      message: 'Process ID',
      pid: Number.parseInt(secondLine.slice(2), 16),
      remainder: rest.slice('Process ID'.length),
    };
  }

  // `ReturnError` formats either
  //   0x<error>\n<function>\n<message>
  // or, when there is no extra message,
  //   0x<error>\n<message>\n
  // (this is what the service sends when OpenVPN exits with an error).
  if (rest.trim() === '') {
    return {
      errorNumber,
      functionName: '',
      message: secondLine,
      remainder: '',
    };
  }

  return {
    errorNumber,
    functionName: secondLine,
    message: rest,
    remainder: '',
  };
}

export interface ParsedServiceError {
  errorNumber: number;
  functionName: string;
  message: string;
}

/**
 * Parse an asynchronous service error frame
 * (`0x<error>\n<function>\n<message>`), as sent after OpenVPN exits.
 */
export function parseServiceErrorText(text: string): ParsedServiceError | null {
  const first = text.indexOf('\n');
  if (first < 0) return null;

  const errorLine = text.slice(0, first).trim();
  if (!/^0x[0-9a-f]{1,8}$/i.test(errorLine)) return null;
  const errorNumber = Number.parseInt(errorLine.slice(2), 16);
  if (errorNumber === 0) return null;

  const second = text.indexOf('\n', first + 1);
  if (second < 0) {
    // Final read without a trailing newline: the rest is the message.
    return { errorNumber, functionName: '', message: text.slice(first + 1).trim() };
  }

  const secondLine = text.slice(first + 1, second).replace(/\r$/, '');
  const rest = text.slice(second + 1).replace(/\r?\n$/, '').trimEnd();

  // The service writes the exit error as `0x<error>\n<message>\n` (there is no
  // function name line), while validation errors can carry a third line.
  if (rest === '') {
    return { errorNumber, functionName: '', message: secondLine };
  }
  return { errorNumber, functionName: secondLine, message: rest };
}

/** Human-readable description for the codes the service returns. */
export function describeServiceError(errorNumber: number): string {
  switch (errorNumber) {
    case 0:
      return 'success';
    case 5:
      return 'access denied';
    case ERROR_ELEVATION_REQUIRED:
      return 'elevation required';
    case ERROR_SERVICE_DOES_NOT_EXIST:
      return `service not installed (${INTERACTIVE_SERVICE_NAME})`;
    case ERROR_SERVICE_NOT_ACTIVE:
      return `service not running (${INTERACTIVE_SERVICE_NAME})`;
    case SERVICE_ERROR_OPENVPN_STARTUP:
      return 'OpenVPN failed to start';
    case SERVICE_ERROR_STARTUP_DATA:
      return 'startup data rejected by the interactive service';
    case SERVICE_ERROR_MESSAGE_DATA:
      return 'invalid service message data';
    case SERVICE_ERROR_MESSAGE_TYPE:
      return 'unknown service message type';
    default:
      return `Win32 error 0x${errorNumber.toString(16)}`;
  }
}

export type OpenvpnServiceStage = 'connect' | 'create-adapter' | 'start' | 'protocol';

export interface OpenvpnServiceErrorOptions {
  stage?: OpenvpnServiceStage;
  errorNumber?: number;
  functionName?: string;
  detail?: string;
  cause?: unknown;
}

/** Base class for interactive-service failures. */
export class OpenvpnServiceError extends Error {
  readonly stage: OpenvpnServiceStage;
  readonly errorNumber: number;
  readonly functionName?: string;
  readonly detail?: string;

  constructor(message: string, options: OpenvpnServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenvpnServiceError';
    this.stage = options.stage ?? 'protocol';
    this.errorNumber = options.errorNumber ?? 0;
    this.functionName = options.functionName;
    this.detail = options.detail;
  }
}

/** The service is not installed/running or the pipe could not be opened. */
export class OpenvpnServiceUnavailableError extends OpenvpnServiceError {
  constructor(message: string, options: OpenvpnServiceErrorOptions = {}) {
    super(message, { ...options, stage: options.stage ?? 'connect' });
    this.name = 'OpenvpnServiceUnavailableError';
  }
}

/** The service replied with a non-zero error to a start request. */
export class OpenvpnServiceStartError extends OpenvpnServiceError {
  constructor(message: string, options: OpenvpnServiceErrorOptions = {}) {
    super(message, { ...options, stage: options.stage ?? 'start' });
    this.name = 'OpenvpnServiceStartError';
  }
}

/** The service replied with malformed/unexpected data. */
export class OpenvpnServiceProtocolError extends OpenvpnServiceError {
  constructor(message: string, options: OpenvpnServiceErrorOptions = {}) {
    super(message, { ...options, stage: options.stage ?? 'protocol' });
    this.name = 'OpenvpnServiceProtocolError';
  }
}

/**
 * Minimal socket surface used by the client. `net.Socket` satisfies it and
 * tests can supply a `Duplex`/`PassThrough`.
 */
export interface ServiceSocket {
  write(chunk: Buffer | string): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  readonly destroyed: boolean;
}

export type ServiceConnector = (pipePath: string, timeoutMs: number) => Promise<ServiceSocket>;

function defaultConnector(pipePath: string, timeoutMs: number): Promise<ServiceSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = netConnect({ path: pipePath });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new OpenvpnServiceUnavailableError(
          `openvpnserv pipe ${pipePath} did not accept a connection within ${timeoutMs}ms`,
          { stage: 'connect' },
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(
        new OpenvpnServiceUnavailableError(
          `unable to connect to the OpenVPN interactive service at ${pipePath}: ${err.message}`,
          { stage: 'connect', cause: err },
        ),
      );
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new OpenvpnServiceUnavailableError(
          `openvpnserv pipe ${pipePath} closed before the connection was established`,
          { stage: 'connect' },
        ),
      );
    });
  });
}

export interface OpenvpnServiceClientOptions {
  pipePath?: string;
  /** Timeout for pipe connects and startup replies (default 5000 ms). */
  timeoutMs?: number;
  /** Timeout for `msg_create_adapter` (default max(timeoutMs, 15000) ms). */
  adapterTimeoutMs?: number;
  /** Header architecture override (tests). Defaults to `process.arch`. */
  arch?: string;
  /** Injectable connector (tests). */
  connector?: ServiceConnector;
}

export interface OpenvpnStartOptions extends OpenvpnStartupData {
  timeoutMs?: number;
}

export interface ServiceOpenVpnProcessLike {
  readonly pid?: number;
  readonly exitCode?: number | null;
  /** Last error frame reported by the service (empty on a clean exit). */
  readonly lastError: string;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  removeListener(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  close(): void;
}

function decodeUtf16Chunk(chunk: Buffer, carry: Buffer): { text: string; carry: Buffer } {
  const combined = Buffer.concat([carry, chunk]);
  const even = combined.length - (combined.length % 2);
  return {
    text: combined.subarray(0, even).toString('utf16le'),
    carry: Buffer.from(combined.subarray(even)),
  };
}

/**
 * A running `openvpn.exe` started by the interactive service.
 *
 * The service keeps the client end of the control pipe open until the OpenVPN
 * process exits, then writes an error frame if the exit code was non-zero and
 * closes the pipe. That pipe close is therefore the exit signal.
 *
 * Events: `exit` (`code`, `signal`) and `control` (raw UTF-16 service text).
 */
export class ServiceOpenVpnProcess extends EventEmitter implements ServiceOpenVpnProcessLike {
  readonly pid: number;
  exitCode: number | null = null;
  /** Last error frame reported by the service (empty on a clean exit). */
  lastError = '';
  /** Error number of {@link lastError}. */
  lastErrorNumber: number | null = null;
  /** Function name reported with {@link lastError}. */
  lastErrorFunction = '';

  private readonly socket: ServiceSocket;
  private raw = '';
  private carry: Buffer = Buffer.alloc(0);
  private finished = false;
  private transportError = '';

  constructor(socket: ServiceSocket, pid: number, remainder = '') {
    super();
    this.socket = socket;
    this.pid = pid;
    this.raw = remainder;
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      this.transportError = err.message;
      // Windows can report a broken read pipe (EPIPE/ECONNRESET) when the
      // service closes the control pipe after OpenVPN exited cleanly. The
      // exit status must come from the service error frame, not from this.
      const cleanClose =
        err.code === 'EPIPE' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ERR_STREAM_DESTROYED' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE';
      this.finish(cleanClose ? 0 : 1);
    });
    socket.once('end', () => this.finish());
    socket.once('close', () => this.finish());
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return false;
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop the control pipe. Does not terminate OpenVPN unless it already exited. */
  close(): void {
    try {
      this.socket.end();
    } catch {
      // Already closed.
    }
    try {
      this.socket.destroy();
    } catch {
      // Already closed.
    }
    this.finish();
  }

  private handleData(chunk: Buffer): void {
    const decoded = decodeUtf16Chunk(chunk, this.carry);
    this.carry = decoded.carry;
    this.raw += decoded.text;
    if (decoded.text !== '') this.emit('control', decoded.text);
  }

  private finish(forcedCode?: number): void {
    if (this.finished) return;
    this.finished = true;

    const parsed = parseServiceErrorText(this.raw);
    if (parsed) {
      this.lastError = parsed.message;
      this.lastErrorNumber = parsed.errorNumber;
      this.lastErrorFunction = parsed.functionName;
      this.exitCode = 1;
    } else if (this.raw.trim() !== '') {
      this.lastError = this.raw.trim();
      this.exitCode = 1;
    } else {
      this.exitCode = forcedCode ?? 0;
      if (this.exitCode !== 0 && this.transportError !== '') {
        this.lastError = this.transportError;
      }
    }

    this.emit('exit', this.exitCode, null);
  }
}

/**
 * Client for the OpenVPN interactive service.
 *
 * All methods fail with {@link OpenvpnServiceUnavailableError} when the
 * service is not installed/running, and with {@link OpenvpnServiceStartError}
 * when the service rejects the request (for example because the config file is
 * outside the service's `config_dir` and the user is not in the OpenVPN
 * Administrators group).
 */
export class OpenvpnServiceClient {
  readonly pipePath: string;
  readonly timeoutMs: number;
  readonly adapterTimeoutMs: number;

  private readonly arch: string;
  private readonly connector: ServiceConnector;

  constructor(options: OpenvpnServiceClientOptions = {}) {
    this.pipePath = options.pipePath ?? DEFAULT_SERVICE_PIPE;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.adapterTimeoutMs = options.adapterTimeoutMs ?? Math.max(this.timeoutMs, 15_000);
    this.arch = options.arch ?? process.arch;
    this.connector = options.connector ?? defaultConnector;
  }

  /** True when the interactive-service pipe accepts a connection. */
  async isAvailable(timeoutMs = Math.min(this.timeoutMs, 2000)): Promise<boolean> {
    try {
      const socket = await this.connector(this.pipePath, timeoutMs);
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask the service to create a DCO (`0`) or TAP (`1`) adapter.
   * Resolves to the Win32 error number (0 = success).
   */
  createAdapter(adapterType: AdapterTypeValue, messageId = 1, arch: string = this.arch): Promise<number> {
    return this.requestAck(
      encodeCreateAdapterMessage(adapterType, messageId, arch),
      messageId,
      arch,
      this.adapterTimeoutMs,
    );
  }

  /**
   * Start `openvpn.exe` through the service.
   *
   * The service uses its configured `exe_path` (registry
   * `HKLM\SOFTWARE\OpenVPN\exe_path`), not a caller-supplied binary, and adds
   * `--msg-channel` itself. Options are validated against the service
   * whitelist; for non-admin users `--config` must point inside the service's
   * `config_dir`.
   */
  async startOpenVpn(options: OpenvpnStartOptions): Promise<ServiceOpenVpnProcess> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const socket = await this.connector(this.pipePath, timeoutMs);
    const request = encodeStartupData(options);

    return new Promise<ServiceOpenVpnProcess>((resolve, reject) => {
      let text = '';
      let carry: Buffer = Buffer.alloc(0);
      let pendingError: ServiceStartupResponse | null = null;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('end', onEnd);
        socket.removeListener('close', onClose);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(err);
      };

      const succeed = (child: ServiceOpenVpnProcess): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.pause();
        resolve(child);
      };

      const onData = (chunk: Buffer): void => {
        const decoded = decodeUtf16Chunk(chunk, carry);
        carry = decoded.carry;
        text += decoded.text;

        const parsed = parseStartupResponse(text);
        if (!parsed) return;

        if (parsed.pid !== undefined) {
          const child = new ServiceOpenVpnProcess(socket, parsed.pid, parsed.remainder);
          succeed(child);
          socket.resume();
          return;
        }

        // Wait for the pipe to close so the (possibly multi-line) error text
        // is complete before surfacing it.
        pendingError = parsed;
      };

      const onEnd = (): void => {
        if (settled) return;

        // A two-line error frame may arrive without a trailing newline; the
        // pipe close marks it as complete.
        if (!pendingError) {
          const parsed = parseServiceErrorText(text);
          if (parsed) {
            pendingError = {
              errorNumber: parsed.errorNumber,
              functionName: parsed.functionName,
              message: parsed.message,
              remainder: '',
            };
          }
        }

        if (pendingError) {
          fail(
            new OpenvpnServiceStartError(
              `openvpnserv rejected the startup request (${formatServiceReply(pendingError)}): ${pendingError.message}`,
              {
                stage: 'start',
                errorNumber: pendingError.errorNumber,
                functionName: pendingError.functionName,
                detail: pendingError.message,
              },
            ),
          );
          return;
        }
        fail(
          new OpenvpnServiceProtocolError(
            `openvpnserv closed the control pipe before returning a process id` +
              `${text.trim() === '' ? '' : `: ${text.trim()}`}`,
          ),
        );
      };

      const onClose = onEnd;

      const onError = (err: Error): void => {
        fail(
          new OpenvpnServiceUnavailableError(
            `openvpnserv control pipe failed while starting OpenVPN: ${err.message}`,
            { stage: 'start', cause: err },
          ),
        );
      };

      const timer = setTimeout(() => {
        fail(
          new OpenvpnServiceUnavailableError(
            `openvpnserv did not return a process id within ${timeoutMs}ms`,
            { stage: 'start' },
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('end', onEnd);
      socket.once('close', onClose);

      try {
        socket.write(request);
      } catch (err) {
        fail(
          new OpenvpnServiceUnavailableError(
            `failed to write startup data to openvpnserv: ${err instanceof Error ? err.message : String(err)}`,
            { stage: 'start', cause: err },
          ),
        );
      }
    });
  }

  private async requestAck(request: Buffer, messageId: number, arch: string, timeoutMs: number): Promise<number> {
    const socket = await this.connector(this.pipePath, timeoutMs);
    const hs = headerSize(arch);

    return new Promise<number>((resolve, reject) => {
      let received = Buffer.alloc(0);
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('end', onEnd);
        socket.removeListener('close', onClose);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(err);
      };

      const succeed = (value: number): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        resolve(value);
      };

      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        if (received.length < hs) return;

        const header = decodeHeader(received, arch);
        if (header.type !== MSG_ACKNOWLEDGEMENT) {
          fail(
            new OpenvpnServiceProtocolError(
              `expected msg_acknowledgement (0), received message type ${header.type}`,
              { stage: 'create-adapter' },
            ),
          );
          return;
        }
        if (header.messageId !== messageId) {
          fail(
            new OpenvpnServiceProtocolError(
              `acknowledgement message id ${header.messageId} does not match request id ${messageId}`,
              { stage: 'create-adapter' },
            ),
          );
          return;
        }

        const expected = header.size >= hs + 4 && header.size <= 4096 ? header.size : ackSize(arch);
        if (received.length < expected) return;

        const ack = decodeAck(received, arch);
        succeed(ack.errorNumber);
      };

      const onEnd = (): void => {
        fail(
          new OpenvpnServiceProtocolError(
            `openvpnserv closed the pipe before acknowledging the adapter request` +
              `${received.length === 0 ? '' : ` (${received.length} bytes received)`}`,
            { stage: 'create-adapter' },
          ),
        );
      };
      const onClose = onEnd;
      const onError = (err: Error): void => {
        fail(
          new OpenvpnServiceUnavailableError(
            `openvpnserv pipe failed during the adapter request: ${err.message}`,
            { stage: 'create-adapter', cause: err },
          ),
        );
      };

      const timer = setTimeout(() => {
        fail(
          new OpenvpnServiceUnavailableError(
            `openvpnserv did not acknowledge the adapter request within ${timeoutMs}ms`,
            { stage: 'create-adapter' },
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('end', onEnd);
      socket.once('close', onClose);

      try {
        socket.write(request);
      } catch (err) {
        fail(
          new OpenvpnServiceUnavailableError(
            `failed to write the adapter request to openvpnserv: ${err instanceof Error ? err.message : String(err)}`,
            { stage: 'create-adapter', cause: err },
          ),
        );
      }
    });
  }
}

function formatServiceReply(reply: ServiceStartupResponse): string {
  const code = `0x${reply.errorNumber.toString(16).padStart(8, '0')}`;
  const description = describeServiceError(reply.errorNumber);
  const functionName = reply.functionName === '' ? '' : ` from ${reply.functionName}`;
  return `${code} (${description})${functionName}`;
}

export interface OpenvpnServiceSettings {
  exePath?: string;
  configDir?: string;
  binDir?: string;
  logDir?: string;
  adminGroup?: string;
}

export interface ServiceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ServiceCommandExec = (file: string, args: string[]) => Promise<ServiceCommandResult>;

function defaultServiceCommandExec(file: string, args: string[]): Promise<ServiceCommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
      const rawCode = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
      resolve({
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        exitCode: typeof rawCode === 'number' ? rawCode : error ? 1 : 0,
      });
    });
  });
}

/**
 * Read the service settings from `HKLM\SOFTWARE\OpenVPN` (`reg query`).
 *
 * These are the values `openvpnserv` uses when it validates and starts
 * OpenVPN: `exe_path` is the binary that will actually run (the SDK's
 * `binary` option is ignored in service mode), `config_dir` is the only
 * config directory accepted for non-admin users, and `ovpn_admin_group` is
 * the group that may run arbitrary configs.
 */
export async function readOpenvpnServiceSettings(
  exec: ServiceCommandExec = defaultServiceCommandExec,
): Promise<OpenvpnServiceSettings | null> {
  const result = await exec('reg.exe', ['query', 'HKLM\\SOFTWARE\\OpenVPN']);
  if (result.exitCode !== 0) return null;

  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1].toLowerCase(), match[2].trim());
    }
  }

  const settings: OpenvpnServiceSettings = {};
  const exePath = values.get('exe_path');
  const configDir = values.get('config_dir');
  const binDir = values.get('bin_dir');
  const logDir = values.get('log_dir');
  const adminGroup = values.get('ovpn_admin_group');
  if (exePath !== undefined) settings.exePath = exePath;
  if (configDir !== undefined) settings.configDir = configDir;
  if (binDir !== undefined) settings.binDir = binDir;
  if (logDir !== undefined) settings.logDir = logDir;
  if (adminGroup !== undefined) settings.adminGroup = adminGroup;
  return settings;
}

/** The subset used by `OpenVpnClient` when it decides to broker a launch. */
export type OpenvpnServiceLauncherLike = {
  isAvailable?(timeoutMs?: number): Promise<boolean>;
  startOpenVpn?(options: OpenvpnStartOptions): Promise<ServiceOpenVpnProcessLike>;
};

export type OpenvpnServiceClientLike = Pick<OpenvpnServiceClient, 'createAdapter'> &
  OpenvpnServiceLauncherLike;
