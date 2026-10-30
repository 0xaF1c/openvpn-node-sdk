import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Client for the elevated helper process.
 *
 * On Windows a non-elevated process cannot start `openvpn.exe` with the
 * privileges needed for a real tunnel, and `tapctl.exe` refuses to start at all
 * (its manifest requires administrator rights). The classic workaround was the
 * OpenVPN interactive service (`openvpnserv`); this module replaces it with an
 * on-demand UAC elevation: when elevation is needed, the SDK starts
 * {@link ./elevate-helper.ts} through `powershell Start-Process -Verb RunAs`.
 * The helper runs as an administrator, connects back to the parent over a
 * loopback TCP socket protected by a random token, and executes the privileged
 * commands (`tapctl.exe`, `openvpn.exe`) on request.
 *
 * One UAC prompt is shown per broker instance. The broker is started lazily on
 * the first privileged operation and should be {@link ElevatedBroker.dispose}
 * when the connection is torn down.
 */

/** Default time to wait for the user to approve UAC and the helper to connect. */
export const DEFAULT_ELEVATION_HANDSHAKE_TIMEOUT_MS = 120_000;
/** Default timeout for a single `tapctl`-style command. */
export const DEFAULT_ELEVATION_COMMAND_TIMEOUT_MS = 30_000;

/** Base class for elevation failures. */
export class ElevationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = 'ElevationError';
  }
}

/** The user declined the UAC prompt, or PowerShell could not show it. */
export class ElevationCancelledError extends ElevationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ElevationCancelledError';
  }
}

/** Elevation is not supported in this environment (non-Windows, no PowerShell). */
export class ElevationUnavailableError extends ElevationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ElevationUnavailableError';
  }
}

/**
 * True when the current process already has administrator/root privileges.
 *
 * Windows: `net session` succeeds only for an elevated token. POSIX: the
 * effective uid is 0. Other platforms: no elevation model, so `true`.
 */
export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('net', ['session'], { windowsHide: true, timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0;
  }
  return true;
}

export interface ElevatedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface ElevatedCommandOptions {
  /** Working directory for the child process. */
  cwd?: string;
  timeoutMs?: number;
}

export interface ElevatedProcessLike {
  readonly pid: number;
  readonly exitCode: number | null;
  getStdout(): string;
  getStderr(): string;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  removeListener(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

/** The surface `OpenVpnClient` (and `AdapterManager`) use for elevation. */
export interface ElevatedBrokerLike {
  run(file: string, args: string[], options?: ElevatedCommandOptions): Promise<ElevatedCommandResult>;
  spawn(file: string, args: string[], options?: ElevatedCommandOptions): Promise<ElevatedProcessLike>;
  kill(pid: number, force?: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export interface ElevatedLaunchOptions {
  port: number;
  token: string;
  helperPath: string;
  nodePath: string;
  /** Branded launcher executable to elevate instead of `nodePath`. */
  launcherPath?: string;
}

export interface ElevatedBrokerOptions {
  /** How long to wait for the UAC prompt and the helper handshake (default 120 s). */
  handshakeTimeoutMs?: number;
  /** Timeout for a single command (default 30 s). */
  commandTimeoutMs?: number;
  /** Helper entry point; defaults to `elevate-helper.js` next to this module. */
  helperPath?: string;
  /** Node.js executable used for the helper (default `process.execPath`). */
  nodePath?: string;
  /**
   * Windows: a branded launcher executable to elevate instead of `nodePath`.
   *
   * The UAC consent dialog shows the **elevated executable's** icon, program
   * name (`FileDescription`) and Authenticode publisher, so a custom launcher
   * is the only way to brand it. The launcher is started as
   * `launcher <nodePath> <helperPath> --port <p> --token <t>` and must run
   * `nodePath` with the remaining arguments (see
   * `scripts/build-elevate-launcher.ps1`).
   */
  launcherPath?: string;
  /** Injectable launcher (tests). Defaults to PowerShell `Start-Process -Verb RunAs`. */
  launch?: (options: ElevatedLaunchOptions) => Promise<void>;
}

interface HelperReply {
  id?: number;
  ok?: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  event?: string;
  token?: string;
  pid?: number;
  stream?: 'stdout' | 'stderr';
  data?: string;
  code?: number | null;
  signal?: string | null;
}

interface PendingRequest {
  resolve: (reply: HelperReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const BACKSLASH = String.fromCharCode(92);

/**
 * Quote one argument for a Windows command line as parsed by
 * `CommandLineToArgvW`. Matches `quoteWindowsCommandLineArg` from
 * `@ovpn-sdk/process` (kept local so the tap package stays standalone).
 */
export function quoteWindowsArgument(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t\n\v\r"]/.test(arg)) return arg;

  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === BACKSLASH) {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += BACKSLASH.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += BACKSLASH.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += BACKSLASH.repeat(backslashes * 2) + '"';
  return out;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function describeLaunchFailure(err: unknown): string {
  const error = err as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr !== '') return stderr;
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  if (stdout !== '') return stdout;
  return err instanceof Error ? err.message : String(err);
}

function defaultHelperPath(): string {
  // Built packages ship `elevate-helper.js`; when the SDK is loaded from its
  // TypeScript sources (tests/playground) the compiled file may not exist yet
  // and Node can run the `.ts` entry directly (type stripping).
  const compiled = fileURLToPath(new URL('./elevate-helper.js', import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL('./elevate-helper.ts', import.meta.url));
  return existsSync(source) ? source : compiled;
}

export interface ElevatedLaunchCommand {
  /** Executable that is elevated (the branded launcher or `nodePath`). */
  targetFile: string;
  /** Pre-quoted command line passed to the target. */
  targetArguments: string;
  /** PowerShell one-liner that triggers the UAC prompt. */
  powerShellScript: string;
}

/**
 * Build the command used to start the elevated helper.
 *
 * Without a launcher the target is `node <helper> --port … --token …`.
 * With a launcher the target is `launcher <node> <helper> --port … --token …`;
 * the launcher just forwards the remaining arguments to `node`, which makes the
 * UAC consent dialog show the launcher's icon/name/publisher instead of
 * Node.js.
 */
export function buildElevatedLaunchCommand(options: {
  nodePath: string;
  helperPath: string;
  port: number;
  token: string;
  launcherPath?: string;
}): ElevatedLaunchCommand {
  const helperArguments = ['--port', String(options.port), '--token', options.token];
  const targetFile = options.launcherPath ?? options.nodePath;
  const argv = options.launcherPath === undefined
    ? [options.helperPath, ...helperArguments]
    : [options.nodePath, options.helperPath, ...helperArguments];
  const targetArguments = argv.map(quoteWindowsArgument).join(' ');
  const powerShellScript = [
    `Start-Process -FilePath ${powerShellQuote(targetFile)}`,
    `-ArgumentList ${powerShellQuote(targetArguments)}`,
    '-Verb RunAs -WindowStyle Hidden',
  ].join(' ');
  return { targetFile, targetArguments, powerShellScript };
}

async function defaultLaunch(options: ElevatedLaunchOptions): Promise<void> {
  if (process.platform !== 'win32') {
    throw new ElevationUnavailableError('UAC elevation is only available on Windows');
  }
  // `Start-Process -Verb RunAs` is the only UAC entry point available from
  // pure Node.js. The arguments are pre-quoted because Start-Process joins
  // `-ArgumentList` with spaces without quoting.
  const { powerShellScript } = buildElevatedLaunchCommand(options);

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powerShellScript],
      { windowsHide: true, timeout: 120_000 },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = describeLaunchFailure(err);
    if (code === 'ENOENT') {
      throw new ElevationUnavailableError(
        'Windows PowerShell (powershell.exe) is required to request administrator rights but was not found',
        { cause: err },
      );
    }
    throw new ElevationCancelledError(
      `failed to start the elevated OpenVPN helper (the UAC prompt was cancelled or could not be shown): ${detail}`,
      { cause: err },
    );
  }
}

/** The `openvpn.exe` process started by the elevated helper. */
export class ElevatedProcess extends EventEmitter implements ElevatedProcessLike {
  readonly id: number;
  pid = 0;
  exitCode: number | null = null;

  private readonly startPromise: Promise<number>;
  private startSettled = false;
  private startResolve: ((pid: number) => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly broker: ElevatedBroker;

  constructor(broker: ElevatedBroker, id: number, startTimeoutMs: number) {
    super();
    this.broker = broker;
    this.id = id;
    this.startPromise = new Promise<number>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.startTimer = setTimeout(() => {
      this.failStart(new ElevationError(`the elevated helper did not start OpenVPN within ${startTimeoutMs}ms`));
    }, startTimeoutMs);
    this.startTimer.unref?.();
  }

  waitForStart(): Promise<number> {
    return this.startPromise;
  }

  markStarted(pid: number): void {
    if (this.startSettled) return;
    this.startSettled = true;
    this.pid = pid;
    this.clearStartTimer();
    this.startResolve?.(pid);
  }

  failStart(err: Error): void {
    if (this.startSettled) return;
    this.startSettled = true;
    this.exitCode = 1;
    this.clearStartTimer();
    this.startReject?.(err);
  }

  push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    (stream === 'stdout' ? this.stdoutChunks : this.stderrChunks).push(chunk);
  }

  getStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf8');
  }

  getStderr(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  finish(code: number | null, signal: string | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? (signal === null ? 0 : 1);
    this.clearStartTimer();
    if (!this.startSettled) {
      this.startSettled = true;
      this.startReject?.(new ElevationError(`OpenVPN exited before it was reported as started (code=${this.exitCode})`));
    }
    this.emit('exit', this.exitCode, signal);
  }

  kill(_signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return false;
    if (this.pid <= 0) return false;
    void this.broker.kill(this.pid, true).catch(() => {});
    return true;
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }
}

/**
 * Starts, supervises and tears down the elevated helper.
 *
 * Create one instance per elevation session (for example per `connect()`),
 * call `run()` for `tapctl` and `spawn()` for OpenVPN, and `dispose()` when the
 * session ends. All calls share the same UAC prompt.
 */
export class ElevatedBroker implements ElevatedBrokerLike {
  readonly handshakeTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly helperPath: string;
  readonly nodePath: string;
  readonly launcherPath: string | undefined;

  private readonly launch: (options: ElevatedLaunchOptions) => Promise<void>;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private token = '';
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private handshake: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly processes = new Map<number, ElevatedProcess>();
  private disposed = false;

  constructor(options: ElevatedBrokerOptions = {}) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_ELEVATION_HANDSHAKE_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_ELEVATION_COMMAND_TIMEOUT_MS;
    this.helperPath = options.helperPath ?? defaultHelperPath();
    this.nodePath = options.nodePath ?? process.execPath;
    this.launcherPath = options.launcherPath;
    this.launch = options.launch ?? defaultLaunch;
  }

  /** True once the helper is connected and ready to accept commands. */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Run a command as administrator and buffer its output. */
  async run(file: string, args: string[], options: ElevatedCommandOptions = {}): Promise<ElevatedCommandResult> {
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    await this.ensureReady();
    const reply = await this.request(
      {
        op: 'run',
        file,
        args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeoutMs,
      },
      timeoutMs + 5000,
    );
    if (reply.ok !== true) {
      throw new ElevationError(
        `the elevated helper could not run ${file}: ${reply.error ?? 'unknown error'}`,
      );
    }
    return {
      stdout: Buffer.from(typeof reply.stdout === 'string' ? reply.stdout : '', 'base64'),
      stderr: Buffer.from(typeof reply.stderr === 'string' ? reply.stderr : '', 'base64'),
      exitCode: typeof reply.exitCode === 'number' ? reply.exitCode : 1,
    };
  }

  /** Start a long-running process as administrator and stream its output. */
  async spawn(file: string, args: string[], options: ElevatedCommandOptions = {}): Promise<ElevatedProcess> {
    await this.ensureReady();
    const id = this.nextId++;
    const child = new ElevatedProcess(this, id, options.timeoutMs ?? this.commandTimeoutMs);
    this.processes.set(id, child);
    try {
      this.send({
        id,
        op: 'spawn',
        file,
        args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (err) {
      this.processes.delete(id);
      throw err;
    }
    try {
      await child.waitForStart();
    } catch (err) {
      this.processes.delete(id);
      throw err;
    }
    return child;
  }

  /** Terminate a process started by {@link spawn}. */
  async kill(pid: number, force = true): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request({ op: 'kill', pid, force }, 10_000);
    } catch {
      // The helper may already be gone; the exit event is authoritative.
    }
  }

  /** Ask the helper to exit and close the connection. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.connected) {
      try {
        this.send({ op: 'shutdown' });
      } catch {
        // Ignore: the socket may already be gone.
      }
      try {
        this.socket?.destroy();
      } catch {
        // Ignore.
      }
    }
    this.handleDisconnect();
  }

  private async ensureReady(): Promise<void> {
    if (this.connected) return;
    if (this.disposed) throw new ElevationError('the elevated broker has been disposed');
    if (this.readyPromise !== null) return this.readyPromise;
    this.readyPromise = this.start().catch((err: unknown) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(new ElevationUnavailableError(`cannot listen on loopback for the elevation helper: ${err.message}`, { cause: err }));
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address() as AddressInfo | string | null;
    if (address === null || typeof address === 'string') {
      this.closeServer();
      throw new ElevationUnavailableError('could not allocate a loopback port for the elevation helper');
    }

    this.token = randomBytes(16).toString('hex');
    const handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(
          new ElevationError(
            `the elevated helper did not connect back within ${this.handshakeTimeoutMs}ms (was the UAC prompt approved?)`,
          ),
        );
      }, this.handshakeTimeoutMs);
      timer.unref?.();
      this.handshake = {
        resolve: () => {
          clearTimeout(timer);
          this.handshake = null;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.handshake = null;
          reject(err);
        },
      };
    });
    // Keep the handshake rejection handled when `launch` fails before we await
    // it; `await handshake` below still observes the rejection.
    void handshake.catch(() => {});

    try {
      await this.launch({
        port: address.port,
        token: this.token,
        helperPath: this.helperPath,
        nodePath: this.nodePath,
        ...(this.launcherPath === undefined ? {} : { launcherPath: this.launcherPath }),
      });
      await handshake;
    } catch (err) {
      this.handshake?.reject(err instanceof Error ? err : new Error(String(err)));
      this.handshake = null;
      this.closeServer();
      throw err;
    }
  }

  private accept(socket: Socket): void {
    if (this.socket !== null) {
      socket.destroy();
      return;
    }

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        let message: HelperReply;
        try {
          message = JSON.parse(line) as HelperReply;
        } catch {
          continue;
        }
        this.handleMessage(socket, message);
      }
    });
    socket.once('close', () => {
      if (this.socket === socket) {
        this.handleDisconnect();
      } else {
        this.handshake?.reject(new ElevationError('the elevated helper disconnected during the handshake'));
        this.handshake = null;
      }
    });
    socket.once('error', () => {
      // 'close' runs afterwards and performs the cleanup.
    });
  }

  private handleMessage(socket: Socket, message: HelperReply): void {
    if (message.event === 'hello') {
      if (this.socket !== null) {
        socket.destroy();
        return;
      }
      if (typeof message.token !== 'string' || message.token !== this.token) {
        this.handshake?.reject(new ElevationError('the elevated helper failed the token handshake'));
        this.handshake = null;
        socket.destroy();
        return;
      }
      this.socket = socket;
      this.closeServer();
      this.handshake?.resolve();
      return;
    }

    if (socket !== this.socket) return;

    switch (message.event) {
      case 'spawned': {
        const child = typeof message.id === 'number' ? this.processes.get(message.id) : undefined;
        if (child && typeof message.pid === 'number') child.markStarted(message.pid);
        return;
      }
      case 'start-error': {
        const child = typeof message.id === 'number' ? this.processes.get(message.id) : undefined;
        if (child) {
          child.failStart(new ElevationError(`the elevated helper could not start OpenVPN: ${message.error ?? 'unknown error'}`));
          this.processes.delete(child.id);
        }
        return;
      }
      case 'output': {
        const child = typeof message.id === 'number' ? this.processes.get(message.id) : undefined;
        if (child && (message.stream === 'stdout' || message.stream === 'stderr')) {
          child.push(message.stream, Buffer.from(message.data ?? '', 'base64'));
        }
        return;
      }
      case 'exit': {
        const child = typeof message.id === 'number' ? this.processes.get(message.id) : undefined;
        if (child) {
          child.finish(
            typeof message.code === 'number' ? message.code : null,
            typeof message.signal === 'string' ? message.signal : null,
          );
          this.processes.delete(child.id);
        }
        return;
      }
      default:
        break;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<HelperReply> {
    const id = this.nextId++;
    return new Promise<HelperReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ElevationError(`the elevated helper did not reply within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...payload, id });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new ElevationError('the elevated helper is not connected');
    }
    socket.write(JSON.stringify(message) + '\n');
  }

  private handleDisconnect(): void {
    this.socket = null;
    const error = new ElevationError('the elevated helper disconnected');
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const child of [...this.processes.values()]) {
      child.finish(null, 'SIGKILL');
    }
    this.processes.clear();
    this.closeServer();
    this.readyPromise = null;
    this.handshake?.reject(error);
    this.handshake = null;
  }

  private closeServer(): void {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    }
  }
}
