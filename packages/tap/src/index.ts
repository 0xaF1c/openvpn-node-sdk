import { spawn } from 'node:child_process';

export interface AdapterInfo {
  guid: string;
  name: string;
  hwid: string;
}

export interface TapctlExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  /**
   * Node `spawn` error code when the executable could not be started at all
   * (`EACCES`/`EPERM`).
   *
   * `tapctl.exe` ships with a `requireAdministrator` manifest, so a
   * non-elevated process cannot even start it: `CreateProcess` fails with
   * win32 740 and Node reports `EACCES` instead of an exit code and stderr.
   */
  spawnError?: string;
}

export type TapctlExec = (binary: string, args: string[]) => Promise<TapctlExecResult>;

export interface TapctlOptions {
  binary?: string;
  /** Injectable runner for tests. Defaults to spawn + buffer collection. */
  exec?: TapctlExec;
  /**
   * Runner used when `tapctl.exe` requires administrator rights (win32 740 /
   * spawn `EACCES`). Usually `(file, args) => broker.run(file, args)` with an
   * {@link ElevatedBroker}; the first such call triggers the UAC prompt.
   */
  elevatedExec?: TapctlExec;
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
    child.on('error', (err: NodeJS.ErrnoException) => {
      // A `requireAdministrator` binary cannot be spawned at all when the
      // process is not elevated; keep the spawn code so the caller can treat
      // this as win32 740 and fall back to the elevation broker.
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: 1,
        spawnError: err.code ?? 'UNKNOWN',
      });
    });
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 });
    });
  });
}

/**
 * Windows TAP adapter manager wrapping the official `tapctl.exe`.
 *
 * `tapctl.exe` requires administrator rights (its manifest says so), so an
 * unelevated process cannot start it at all. When `elevatedExec` is provided
 * the manager re-runs the failing command through an
 * {@link ElevatedBroker}, which triggers a single UAC prompt per broker.
 */
export class AdapterManager {
  private readonly options: TapctlOptions;
  private readonly exec: TapctlExec;
  private readonly elevatedExec: TapctlExec | null;
  private readonly refCounts = new Map<string, number>();

  constructor(options: TapctlOptions = {}) {
    this.options = options;
    this.exec = options.exec ?? defaultTapctlExec;
    this.elevatedExec = options.elevatedExec ?? null;
  }

  get isWindows(): boolean {
    return process.platform === 'win32';
  }

  async list(hwid?: string): Promise<AdapterInfo[]> {
    try {
      return await this.listWith(this.exec, hwid);
    } catch (err) {
      // `tapctl list` cannot even be spawned unelevated (win32 740/spawn
      // EACCES), so retry through the broker just like create/delete.
      if (!isElevationError(err) || this.elevatedExec === null) throw err;
      return this.listWith(this.elevatedExec, hwid);
    }
  }

  private async listWith(exec: TapctlExec, hwid?: string): Promise<AdapterInfo[]> {
    if (!this.isWindows) return [];
    const args = ['list'];
    if (hwid) args.push('--hwid', hwid);
    const result = await exec(this.options.binary ?? 'tapctl.exe', args);
    if (result.exitCode !== 0) {
      throw this.toError('tapctl list failed', result);
    }
    return parseAdapterList(decodeTapctl(result.stdout));
  }

  async create(opts: { name?: string; hwid?: string } = {}): Promise<AdapterInfo> {
    if (!this.isWindows) throw new Error('tapctl is only available on Windows');
    try {
      return await this.createWith(this.exec, opts);
    } catch (err) {
      // Non-admin: tapctl create fails with win32 740 (or a spawn EACCES).
      if (!isElevationError(err) || this.elevatedExec === null) throw err;
      return this.createWith(this.elevatedExec, opts);
    }
  }

  private async createWith(exec: TapctlExec, opts: { name?: string; hwid?: string } = {}): Promise<AdapterInfo> {
    const args = ['create'];
    if (opts.name) args.push('--name', opts.name);
    if (opts.hwid) args.push('--hwid', opts.hwid);
    const result = await exec(this.options.binary ?? 'tapctl.exe', args);
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
    try {
      await this.deleteWith(this.exec, guidOrName);
    } catch (err) {
      if (!isElevationError(err) || this.elevatedExec === null) throw err;
      await this.deleteWith(this.elevatedExec, guidOrName);
    }
  }

  private async deleteWith(exec: TapctlExec, guidOrName: string): Promise<void> {
    const result = await exec(this.options.binary ?? 'tapctl.exe', ['delete', guidOrName]);
    if (result.exitCode !== 0) {
      throw this.toError('tapctl delete failed', result);
    }
  }

  async ensure(opts: { name?: string; hwid?: 'auto' | 'ovpn-dco' | 'root\\tap0901' | 'tap0901' } = {}): Promise<AdapterInfo | null> {
    if (!this.isWindows) return null;

    let existing: AdapterInfo[];
    let exec = this.exec;
    try {
      existing = await this.listWith(exec);
    } catch (err) {
      if (!isElevationError(err) || this.elevatedExec === null) throw err;
      // `tapctl` cannot start unelevated; run it through the broker instead.
      exec = this.elevatedExec;
      existing = await this.listWith(exec);
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

    let lastError: Error | null = null;
    for (const hwid of candidates) {
      try {
        const adapter = await this.createWith(exec, { name: opts.name, hwid });
        this.refCounts.set(adapter.guid, 1);
        return adapter;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // A missing driver is worth trying the next candidate for; an
        // elevation/UAC failure is terminal.
        if (isElevationError(err)) throw err;
      }
    }
    throw new Error(
      `unable to create a TAP adapter (tried ${candidates.join(', ')}): ${lastError?.message ?? 'unknown error'}`,
    );
  }

  async release(guidOrName: string): Promise<void> {
    if (!this.isWindows || guidOrName === '') return;
    const count = this.refCounts.get(guidOrName) ?? 0;
    if (count > 1) {
      this.refCounts.set(guidOrName, count - 1);
      return;
    }
    this.refCounts.delete(guidOrName);

    try {
      await this.delete(guidOrName);
    } catch (err) {
      // Without elevation the adapter simply stays in place.
      if (!isElevationError(err)) throw err;
    }
  }

  async isElevated(): Promise<boolean> {
    if (process.platform !== 'win32') {
      return typeof process.getuid === 'function' ? process.getuid() === 0 : true;
    }
    const result = await this.exec('net', ['session']);
    return result.exitCode === 0;
  }

  private toError(prefix: string, result: TapctlExecResult): TapctlError {
    const stderrText = decodeTapctl(result.stderr);
    const elevationSpawn = result.spawnError === 'EACCES' || result.spawnError === 'EPERM';
    // `tapctl.exe` has a requireAdministrator manifest. A non-elevated process
    // gets ERROR_ELEVATION_REQUIRED from CreateProcess, which Node surfaces as
    // a spawn EACCES/EPERM with no stderr, so map it to win32 740 explicitly.
    const win32Code =
      parseWin32ErrorCode(stderrText) ?? (elevationSpawn ? ERROR_ELEVATION_REQUIRED : null);
    const rebootRequired = stderrText.includes('A system reboot is required.');
    const detail = stderrText.trim() !== ''
      ? stderrText.trim()
      : elevationSpawn
        ? `cannot start tapctl (${result.spawnError}); it requires elevation`
        : '';
    return new TapctlError(
      `${prefix} (exit ${result.exitCode}${win32Code !== null ? `, win32 0x${win32Code.toString(16)}` : ''})${detail === '' ? '' : `: ${detail}`}`,
      result.exitCode,
      win32Code,
      rebootRequired,
    );
  }
}

function isElevationError(err: unknown): boolean {
  return err instanceof TapctlError && err.win32Code === ERROR_ELEVATION_REQUIRED;
}

export type AdapterManagerLike = Pick<
  AdapterManager,
  'ensure' | 'release' | 'list' | 'create'
> & {
  /** Optional elevation probe used by `OpenVpnClient`'s `elevation: 'auto'`. */
  isElevated?(): Promise<boolean>;
};

/** Re-export the elevation API so `@ovpn-sdk/tap` is the single Windows import. */
export {
  ElevatedBroker,
  ElevatedProcess,
  ElevationCancelledError,
  ElevationError,
  ElevationUnavailableError,
  buildElevatedLaunchCommand,
  isElevated,
  quoteWindowsArgument,
  resolveElevationHelperPath,
  type ElevatedBrokerLike,
  type ElevatedBrokerOptions,
  type ElevatedCommandOptions,
  type ElevatedCommandResult,
  type ElevatedLaunchCommand,
  type ElevatedLaunchOptions,
  type ElevatedProcessLike,
  type ElevationHelperResolutionOptions,
} from './elevate.ts';
