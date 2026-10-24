import { spawn } from 'node:child_process';
import {
  ADAPTER_TYPE_DCO,
  ADAPTER_TYPE_TAP,
  OpenvpnServiceClient,
  OpenvpnServiceError,
  describeServiceError,
  type AdapterTypeValue,
  type OpenvpnServiceClientLike,
} from './openvpnserv.ts';

export interface AdapterInfo {
  guid: string;
  name: string;
  hwid: string;
  /** True when created through the elevated interactive service (no GUID/name returned). */
  viaService?: boolean;
}

export interface TapctlExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export type TapctlExec = (binary: string, args: string[]) => Promise<TapctlExecResult>;

export type AdapterServiceMode = 'auto' | 'always' | 'never';

export interface TapctlOptions {
  binary?: string;
  /** Injectable runner for tests. Defaults to spawn + buffer collection. */
  exec?: TapctlExec;
  /** Client for the OpenVPN interactive service (elevated adapter creation). */
  serviceClient?: OpenvpnServiceClientLike;
  /**
   * When to create adapters through `openvpnserv` instead of `tapctl`:
   * - `auto` (default): when `tapctl` reports win32 740 (elevation required)
   *   or, for non-elevated processes, when the interactive service is available;
   * - `always`: skip `tapctl create` and use the service;
   * - `never`: only use `tapctl` (the old behavior).
   */
  serviceMode?: AdapterServiceMode;
}

export const ERROR_ELEVATION_REQUIRED = 740;

/**
 * Decode tapctl output. `tapctl` writes through fwprintf, so redirected stdout
 * is UTF-16LE without BOM; stderr mixes narrow/wide output. This heuristic
 * prefers UTF-8 for narrow output and UTF-16LE for wide output.
 */
export function decodeTapctl(buf: Buffer): string {
  if (buf.length === 0) return '';
  const asUtf8 = buf.toString('utf8');
  const hasNul = asUtf8.includes('\x00') || (buf.length > 1 && buf[1] === 0);
  if (!hasNul) return asUtf8;
  const wide = buf.toString('utf16le');
  const nonPrintable = wide.split('').filter((ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r';
  }).length;
  return nonPrintable > wide.length / 4 ? asUtf8.replaceAll('\x00', '') : wide;
}

/** Parse tapctl `create`/`list` stdout into adapter records. */
export function parseAdapterList(text: string): AdapterInfo[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [guid, name, hwid] = line.split('\t');
      return { guid: guid ?? '', name: name ?? '', hwid: hwid ?? '' };
    });
}

/** Extract a Win32 error code (`error 0x...`) from tapctl stderr. */
export function parseWin32ErrorCode(stderr: string): number | null {
  const match = stderr.match(/0x[0-9a-fA-F]+/);
  return match ? Number.parseInt(match[0], 16) : null;
}

export class TapctlError extends Error {
  readonly exitCode: number;
  readonly win32Code: number | null;
  readonly rebootRequired: boolean;

  constructor(message: string, exitCode: number, win32Code: number | null, rebootRequired: boolean) {
    super(message);
    this.name = 'TapctlError';
    this.exitCode = exitCode;
    this.win32Code = win32Code;
    this.rebootRequired = rebootRequired;
  }
}

function defaultTapctlExec(binary: string, args: string[]): Promise<TapctlExecResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('error', () => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: 1 });
    });
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 });
    });
  });
}

/**
 * Windows TAP adapter manager wrapping the official `tapctl.exe`.
 */
export class AdapterManager {
  private readonly options: TapctlOptions;
  private readonly exec: TapctlExec;
  private readonly serviceClient: OpenvpnServiceClientLike;
  private readonly refCounts = new Map<string, number>();
  /** Adapters created (or discovered) through the interactive service. */
  private readonly serviceAdapters = new Set<string>();

  constructor(options: TapctlOptions = {}) {
    this.options = options;
    this.exec = options.exec ?? defaultTapctlExec;
    this.serviceClient = options.serviceClient ?? new OpenvpnServiceClient();
  }

  get isWindows(): boolean {
    return process.platform === 'win32';
  }

  async list(hwid?: string): Promise<AdapterInfo[]> {
    if (!this.isWindows) return [];
    const args = ['list'];
    if (hwid) args.push('--hwid', hwid);
    const result = await this.exec(this.options.binary ?? 'tapctl.exe', args);
    if (result.exitCode !== 0) {
      throw this.toError('tapctl list failed', result);
    }
    return parseAdapterList(decodeTapctl(result.stdout));
  }

  async create(opts: { name?: string; hwid?: string } = {}): Promise<AdapterInfo> {
    if (!this.isWindows) throw new Error('tapctl is only available on Windows');
    try {
      return await this.createWithTapctl(opts);
    } catch (err) {
      // Non-admin: tapctl create returns win32 740. Fall back to the service.
      if (!isElevationError(err) || (this.options.serviceMode ?? 'auto') === 'never') throw err;
      return this.ensureViaService(opts.hwid ?? 'ovpn-dco', opts.name);
    }
  }

  private async createWithTapctl(opts: { name?: string; hwid?: string } = {}): Promise<AdapterInfo> {
    const args = ['create'];
    if (opts.name) args.push('--name', opts.name);
    if (opts.hwid) args.push('--hwid', opts.hwid);
    const result = await this.exec(this.options.binary ?? 'tapctl.exe', args);
    if (result.exitCode !== 0) {
      throw this.toError('tapctl create failed', result);
    }
    const parsed = parseAdapterList(decodeTapctl(result.stdout));
    const adapter = parsed[0];
    if (!adapter) throw new Error('tapctl create returned no adapter');
    return adapter;
  }

  async delete(guidOrName: string): Promise<void> {
    if (!this.isWindows) return;
    const result = await this.exec(this.options.binary ?? 'tapctl.exe', ['delete', guidOrName]);
    if (result.exitCode !== 0) {
      throw this.toError('tapctl delete failed', result);
    }
  }

  async ensure(opts: { name?: string; hwid?: 'auto' | 'ovpn-dco' | 'root\\tap0901' | 'tap0901' } = {}): Promise<AdapterInfo | null> {
    if (!this.isWindows) return null;

    let existing: AdapterInfo[] = [];
    let listNeedsElevation = false;
    try {
      existing = await this.list();
    } catch (err) {
      if (!isElevationError(err)) throw err;
      // Non-admin: tapctl itself needs elevation; fall through to service path.
      listNeedsElevation = true;
    }

    const preferred = opts.hwid === 'auto' || opts.hwid === undefined ? null : opts.hwid;
    const match = existing.find((a) => (preferred ? a.hwid === preferred : true));
    if (match) {
      this.refCounts.set(match.guid, (this.refCounts.get(match.guid) ?? 0) + 1);
      return match;
    }

    const candidates = opts.hwid === 'auto' || opts.hwid === undefined
      ? ['ovpn-dco', 'root\\tap0901', 'tap0901']
      : [opts.hwid];

    if (await this.shouldUseService(listNeedsElevation)) {
      let lastError: Error | null = null;
      for (const hwid of candidates) {
        try {
          return await this.ensureViaService(hwid, opts.name);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (!isAdapterCreateFailure(err)) throw err;
        }
      }
      throw new Error(`openvpnserv could not create an adapter (tried ${candidates.join(', ')}): ${lastError?.message ?? 'unknown error'}`);
    }

    let lastError: Error | null = null;
    for (const hwid of candidates) {
      try {
        const adapter = await this.createWithTapctl({ name: opts.name, hwid });
        this.refCounts.set(adapter.guid, 1);
        return adapter;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isElevationError(err) && (this.options.serviceMode ?? 'auto') !== 'never') {
          try {
            return await this.ensureViaService(hwid, opts.name);
          } catch (serviceErr) {
            lastError = serviceErr instanceof Error ? serviceErr : new Error(String(serviceErr));
            if (!isAdapterCreateFailure(serviceErr)) throw serviceErr;
          }
        }
      }
    }
    throw new Error(`unable to create a TAP adapter (tried ${candidates.join(', ')}): ${lastError?.message ?? 'unknown error'}`);
  }

  /**
   * Decide whether `ensure()` should go straight to the interactive service.
   *
   * - `always` → yes;
   * - `never` → no;
   * - `auto` → when listing already failed with 740, or when the process is
   *   not elevated and the service pipe is reachable.
   */
  private async shouldUseService(listNeedsElevation: boolean): Promise<boolean> {
    const mode = this.options.serviceMode ?? 'auto';
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    if (listNeedsElevation) return true;
    if (typeof this.serviceClient.isAvailable !== 'function') return false;

    try {
      if (await this.isElevated()) return false;
      return await this.serviceClient.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Create an adapter through `openvpnserv`.
   *
   * The service protocol has no adapter-name field, so `name` is ignored.
   * After creation we try to re-list adapters; `tapctl list` also requires
   * elevation on some systems, in which case a synthetic adapter record with
   * an empty GUID is returned (`viaService: true`).
   */
  private async ensureViaService(hwid: string, _name?: string): Promise<AdapterInfo> {
    const adapterType: AdapterTypeValue = adapterTypeForHwid(hwid);
    const errorNumber = await this.serviceClient.createAdapter(adapterType);
    if (errorNumber !== 0) {
      throw new OpenvpnServiceError(
        `openvpnserv failed to create an adapter with hwid "${hwid}": ` +
          `${describeServiceError(errorNumber)} (win32 0x${errorNumber.toString(16)})`,
        { stage: 'create-adapter', errorNumber },
      );
    }

    try {
      const listed = await this.list(hwid);
      const found = listed.find((a) => a.hwid === hwid);
      if (found) {
        this.serviceAdapters.add(found.guid);
        this.refCounts.set(found.guid, (this.refCounts.get(found.guid) ?? 0) + 1);
        return { ...found, viaService: true };
      }
    } catch {
      // `tapctl list` can require the same elevation as `create`; the service
      // does not return the adapter identity, so the caller gets no dev-node.
    }

    return { guid: '', name: '', hwid, viaService: true };
  }

  async release(guidOrName: string): Promise<void> {
    if (!this.isWindows || guidOrName === '') return;
    const count = this.refCounts.get(guidOrName) ?? 0;
    if (count > 1) {
      this.refCounts.set(guidOrName, count - 1);
      return;
    }
    this.refCounts.delete(guidOrName);

    if (this.serviceAdapters.delete(guidOrName)) {
      // Deleting a service-created adapter needs elevation as well; when the
      // caller is still non-elevated just leave it in place.
      try {
        await this.delete(guidOrName);
      } catch (err) {
        if (!isElevationError(err)) throw err;
      }
      return;
    }

    await this.delete(guidOrName);
  }

  async isElevated(): Promise<boolean> {
    if (process.platform !== 'win32') return true;
    const result = await this.exec('net', ['session']);
    return result.exitCode === 0;
  }

  private toError(prefix: string, result: TapctlExecResult): TapctlError {
    const stderrText = decodeTapctl(result.stderr);
    const win32Code = parseWin32ErrorCode(stderrText);
    const rebootRequired = stderrText.includes('A system reboot is required.');
    return new TapctlError(
      `${prefix} (exit ${result.exitCode}${win32Code !== null ? `, win32 0x${win32Code.toString(16)}` : ''}): ${stderrText.trim()}`,
      result.exitCode,
      win32Code,
      rebootRequired,
    );
  }
}

export type AdapterManagerLike = Pick<AdapterManager, 'ensure' | 'release'> & {
  /** Optional elevation probe used by `OpenVpnClient`'s `elevation: 'auto'`. */
  isElevated?(): Promise<boolean>;
};

function isElevationError(err: unknown): boolean {
  return err instanceof TapctlError && err.win32Code === ERROR_ELEVATION_REQUIRED;
}

/** True when the service replied to `msg_create_adapter` with a Win32 error. */
function isAdapterCreateFailure(err: unknown): boolean {
  return (
    err instanceof OpenvpnServiceError &&
    err.stage === 'create-adapter' &&
    err.errorNumber !== 0
  );
}

function adapterTypeForHwid(hwid: string): AdapterTypeValue {
  if (hwid === 'ovpn-dco') return ADAPTER_TYPE_DCO;
  if (hwid.includes('tap')) return ADAPTER_TYPE_TAP;
  throw new Error(`unsupported adapter hardware id for openvpnserv: ${hwid}`);
}

export {
  ADAPTER_TYPE_DCO,
  ADAPTER_TYPE_TAP,
  DEFAULT_SERVICE_PIPE,
  INTERACTIVE_SERVICE_NAME,
  MSG_ACKNOWLEDGEMENT,
  MSG_CREATE_ADAPTER,
  OpenvpnServiceClient,
  SERVICE_ERROR_OPENVPN_STARTUP,
  SERVICE_ERROR_STARTUP_DATA,
  OpenvpnServiceError,
  OpenvpnServiceProtocolError,
  OpenvpnServiceStartError,
  OpenvpnServiceUnavailableError,
  ServiceOpenVpnProcess,
  ackSize,
  createAdapterMessageSize,
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
  type AdapterTypeValue,
  type OpenvpnServiceClientLike,
  type OpenvpnServiceClientOptions,
  type OpenvpnServiceLauncherLike,
  type OpenvpnServiceErrorOptions,
  type OpenvpnServiceSettings,
  type OpenvpnServiceStage,
  type OpenvpnStartOptions,
  type OpenvpnStartupData,
  type ParsedServiceError,
  type ServiceCommandExec,
  type ServiceCommandResult,
  type ServiceConnector,
  type ServiceMessageHeader,
  type ServiceOpenVpnProcessLike,
  type ServiceSocket,
  type ServiceStartupResponse,
} from './openvpnserv.ts';
