import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Client for the elevated helper process.
 *
 * On Windows a non-elevated process cannot start `openvpn.exe` with the
 * privileges needed for a real tunnel, and `tapctl.exe` refuses to start at all
 * (its manifest requires administrator rights). The classic workaround was the
 * OpenVPN interactive service (`openvpnserv`); this module replaces it with an
 * on-demand elevation: when elevation is needed, the SDK starts
 * {@link ./elevate-helper.ts} through the platform's native consent UI
 * (`Start-Process -Verb RunAs` on Windows, `osascript` on macOS, `pkexec` on
 * Linux).
 * The helper runs as an administrator, connects back to the parent over a
 * loopback TCP socket protected by a random token, and executes the privileged
 * commands (`tapctl.exe`, `openvpn.exe`) on request.
 *
 * One elevation prompt is shown per broker instance. The broker is started
 * lazily on the first privileged operation and should be
 * {@link ElevatedBroker.dispose} when the connection is torn down.
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

/** The user declined the elevation prompt, or the prompt could not be shown. */
export class ElevationCancelledError extends ElevationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ElevationCancelledError';
  }
}

/** Elevation is not supported in this environment (no supported backend). */
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
  /**
   * Helper entry point. Defaults to {@link resolveElevationHelperPath}, which
   * finds the `elevate-helper` file shipped with the SDK (or installed inside
   * `openvpn-node-sdk`). Set it when a bundler inlined the SDK into a host
   * bundle and the helper lives somewhere else; a missing file throws
   * `ElevationUnavailableError` instead of timing out after the UAC prompt.
   */
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
   * `scripts/build-elevate-launcher.ps1`). Ignored on macOS/Linux.
   */
  launcherPath?: string;
  /** Injectable launcher (tests). Defaults to the platform elevation backend. */
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

/** Absolute Windows PowerShell path (PATH is not reliable after elevation). */
function powerShellPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function isElectronRuntime(): boolean {
  return typeof process.versions.electron === 'string' && process.versions.electron !== '';
}

function describeLaunchFailure(err: unknown): string {
  const error = err as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr !== '') return stderr;
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  if (stdout !== '') return stdout;
  return err instanceof Error ? err.message : String(err);
}

/** Quote one argument for /bin/sh (used by macOS `do shell script`). */
function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * File names the helper is shipped under, most portable first.
 *
 * - `.mjs`: the build copies the compiled helper to this name, because `.mjs`
 *   is always parsed as an ES module. A `.js` copy (for example an
 *   `asarUnpack`ed file without the package's `package.json` above it) would be
 *   loaded as CommonJS and the helper would die with a syntax error.
 * - `.js`: the `tsc` output shipped inside `dist/` since 0.1.0, kept so host
 *   build scripts that copy `dist/tap/src/elevate-helper.js` keep working.
 * - `.ts`: the TypeScript source, used when the SDK runs from sources
 *   (tests/playground) and the compiled file does not exist yet. Node >= 22.18
 *   runs it directly via type stripping.
 */
const HELPER_FILE_NAMES = ['elevate-helper.mjs', 'elevate-helper.js', 'elevate-helper.ts'] as const;

/**
 * Packages that ship the helper as an `exports` subpath. `openvpn-node-sdk` is
 * the published bundle, `@ovpn-sdk/tap` the workspace package it is built from.
 */
const HELPER_PACKAGE_NAMES = ['openvpn-node-sdk', '@ovpn-sdk/tap'] as const;

/** `exports` subpath both packages use for the helper entry point. */
const HELPER_EXPORT_SUBPATH = 'elevate-helper';

/** An `app.asar` path segment, as produced by an Electron packager. */
const ASAR_SEGMENT = /([\\/])app\.asar([\\/])/;

/** Options for {@link resolveElevationHelperPath}. */
export interface ElevationHelperResolutionOptions {
  /**
   * Explicit helper entry point (`elevationHelperPath` on `OpenVpnClient`,
   * `helperPath` on `ElevatedBroker`).
   *
   * Relative paths are resolved against the current working directory. When set,
   * discovery is skipped and a missing file is an error instead of a silent
   * fallback.
   */
  helperPath?: string;
  /**
   * URL (or path) of the module executing this code; defaults to
   * `import.meta.url`.
   *
   * Bundlers replace `import.meta.url` with the host bundle's URL, which is
   * exactly what the package-based lookup needs. Tests and hosts with a custom
   * module loader can override the starting point.
   */
  moduleUrl?: string | URL;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toModuleUrl(value: string | URL): URL {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return pathToFileURL(resolve(value));
  }
}

/**
 * An Electron `app.asar` archive cannot be read by an elevated child process,
 * so a candidate inside the archive is only usable through its `asarUnpack`ed
 * sibling. Prefer that copy and fall back to the archive path, which
 * {@link pickExistingHelper} rejects when it is the only one that exists.
 */
function unpackedVariants(candidate: string): string[] {
  const match = ASAR_SEGMENT.exec(candidate);
  if (match === null) return [candidate];
  const unpacked = candidate.replace(ASAR_SEGMENT, `${match[1]}app.asar.unpacked${match[2]}`);
  return [unpacked, candidate];
}

/** True for a path inside an Electron `app.asar` archive (not `app.asar.unpacked`). */
function isArchivedPath(path: string): boolean {
  if (typeof process.versions.electron !== 'string' || process.versions.electron === '') return false;
  return ASAR_SEGMENT.test(path);
}

/**
 * Layouts the helper can have inside an installed package: the published
 * bundle nests the workspace packages under `dist/`, while the tap package
 * emits next to its own `dist/` root, and a source checkout has `src/`.
 */
function installedHelperLayouts(packageRoot: string): string[] {
  return [
    join(packageRoot, 'dist', 'tap', 'src', 'elevate-helper.mjs'),
    join(packageRoot, 'dist', 'tap', 'src', 'elevate-helper.js'),
    join(packageRoot, 'dist', 'elevate-helper.mjs'),
    join(packageRoot, 'dist', 'elevate-helper.js'),
    join(packageRoot, 'src', 'elevate-helper.ts'),
  ];
}

function formatCheckedLocations(checked: readonly string[]): string {
  return checked.map((entry) => `  - ${entry}`).join('\n');
}

/** Return the first candidate that exists, recording every path that was tried. */
function pickExistingHelper(candidates: readonly string[], checked: string[]): string | null {
  for (const candidate of candidates) {
    checked.push(candidate);
    if (!isFile(candidate)) continue;
    if (isArchivedPath(candidate)) {
      throw new ElevationUnavailableError(
        `the elevation helper ${candidate} is inside an app.asar archive, which an elevated child process cannot execute. ` +
          'Unpack it (electron-builder: asarUnpack: ["node_modules/openvpn-node-sdk/dist/tap/src/elevate-helper.mjs"]), ' +
          'or copy it outside the archive and pass its path as elevationHelperPath/helperPath',
      );
    }
    return candidate;
  }
  return null;
}

/**
 * Locate the elevated helper entry point (`elevate-helper.mjs`, `.js` or `.ts`).
 *
 * Resolution order:
 * 1. an explicit `helperPath` — a missing file is an error, never a silent
 *    fallback to a path that does not exist;
 * 2. files next to the running module (`import.meta.url`), which covers the
 *    published `dist/tap/src/` layout and the TypeScript sources;
 * 3. the installed package root, found with `createRequire` from the running
 *    module (`openvpn-node-sdk/elevate-helper`). This is what keeps working when
 *    a bundler inlined the SDK into the host bundle: `import.meta.url` then
 *    points at the *host* entry file, but Node's resolver still walks up to
 *    `node_modules` and finds the installed package.
 *
 * Paths inside an Electron `app.asar` are mapped to `app.asar.unpacked` before
 * use, and rejected when only the archive copy exists.
 *
 * @throws {ElevationUnavailableError} when no candidate exists. The message
 * lists every path that was checked, so the caller can point the SDK at the
 * right file with `elevationHelperPath`/`helperPath` instead of waiting for the
 * 120 s handshake timeout after the UAC prompt.
 */
export function resolveElevationHelperPath(
  options: ElevationHelperResolutionOptions = {},
): string {
  const checked: string[] = [];

  const explicit = options.helperPath;
  if (explicit !== undefined && explicit.trim() !== '') {
    const absolute = resolve(explicit);
    const found = pickExistingHelper(unpackedVariants(absolute), checked);
    if (found !== null) return found;
    throw new ElevationUnavailableError(
      [
        `the elevation helper was not found at ${absolute} (elevationHelperPath/helperPath). Checked:`,
        formatCheckedLocations(checked),
        'Pass the existing elevate-helper.js/.mjs file, or remove the option to let the SDK resolve it.',
      ].join('\n'),
    );
  }

  const moduleUrl = toModuleUrl(options.moduleUrl ?? import.meta.url);
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  for (const name of HELPER_FILE_NAMES) {
    const found = pickExistingHelper(unpackedVariants(join(moduleDirectory, name)), checked);
    if (found !== null) return found;
  }

  const requireFromModule = createRequire(moduleUrl);
  for (const packageName of HELPER_PACKAGE_NAMES) {
    // Preferred: the documented subpath export (`openvpn-node-sdk/elevate-helper`).
    const subpath = `${packageName}/${HELPER_EXPORT_SUBPATH}`;
    try {
      const resolved = requireFromModule.resolve(subpath);
      const found = pickExistingHelper(unpackedVariants(resolved), checked);
      if (found !== null) return found;
    } catch (err) {
      if (err instanceof ElevationUnavailableError) throw err;
      checked.push(`${subpath} (not resolvable from ${moduleDirectory})`);
    }

    // Fallback: resolve the package root and derive the known dist layouts. This
    // also works for manifests that do not export the subpath.
    const manifestSpecifier = `${packageName}/package.json`;
    try {
      const manifest = requireFromModule.resolve(manifestSpecifier);
      const found = pickExistingHelper(installedHelperLayouts(dirname(manifest)), checked);
      if (found !== null) return found;
    } catch (err) {
      if (err instanceof ElevationUnavailableError) throw err;
      checked.push(`${manifestSpecifier} (not resolvable from ${moduleDirectory})`);
    }
  }

  throw new ElevationUnavailableError(
    [
      `cannot find the elevation helper (${HELPER_FILE_NAMES.join(', ')}). Checked:`,
      formatCheckedLocations(checked),
      'If a bundler inlined the SDK into your own build, pass the helper path explicitly:',
      "  new OpenVpnClient(config, { elevationHelperPath: '<absolute path to elevate-helper.js>' })",
      "  new ElevatedBroker({ helperPath: '<absolute path to elevate-helper.js>' })",
      'Electron: the helper must live outside app.asar (asarUnpack); see docs/windows-elevation.md.',
    ].join('\n'),
  );
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
 * Build the PowerShell `Start-Process -Verb RunAs` command used on Windows.
 *
 * The elevated executable is `nodePath` (or `launcherPath`), never `cmd.exe`;
 * `-ArgumentList` is pre-quoted because Start-Process joins its array elements
 * with spaces without quoting.
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

/**
 * Electron variant of {@link buildElevatedLaunchCommand}.
 *
 * In an Electron host `process.execPath` is `electron.exe` (or the packaged
 * app), not a standalone Node.js. UAC launches it without the caller's
 * environment, so it would start a second GUI instance instead of the helper.
 * Elevate a nested PowerShell that sets `ELECTRON_RUN_AS_NODE=1` before
 * starting the target, which makes Electron behave like Node for the helper.
 *
 * The branded `launcherPath` is intentionally not used here: a custom launcher
 * runs the target itself and is responsible for the Electron environment.
 */
export function buildElectronElevatedLaunchCommand(options: {
  nodePath: string;
  helperPath: string;
  port: number;
  token: string;
}): ElevatedLaunchCommand {
  const { targetFile, targetArguments } = buildElevatedLaunchCommand(options);
  const innerScript = [
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    `Start-Process -FilePath ${powerShellQuote(targetFile)}` +
      ` -ArgumentList ${powerShellQuote(targetArguments)} -WindowStyle Hidden`,
  ].join('\n');
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64');
  const innerArguments =
    `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const powerShellScript = [
    `Start-Process -FilePath ${powerShellQuote(powerShellPath())}`,
    `-ArgumentList ${powerShellQuote(innerArguments)}`,
    '-Verb RunAs -WindowStyle Hidden',
  ].join(' ');
  return { targetFile, targetArguments, powerShellScript };
}

/**
 * Build the /bin/sh command that runs the helper as root on macOS/Linux.
 *
 * `launcherPath` is a Windows-only branding feature and is ignored here.
 */
export function buildPosixLaunchCommand(options: ElevatedLaunchOptions): string {
  return [
    options.nodePath,
    options.helperPath,
    '--port',
    String(options.port),
    '--token',
    options.token,
  ].map(shellQuote).join(' ');
}

/** AppleScript string literal (backslashes and quotes escaped). */
function appleScriptQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * AppleScript that asks for administrator rights via `osascript` and runs the
 * helper as root. `do shell script` waits for the helper to exit, so the
 * broker's handshake (not this promise) decides when it is ready.
 */
export function buildAppleScriptLaunchCommand(options: ElevatedLaunchOptions): string {
  return `do shell script ${appleScriptQuote(buildPosixLaunchCommand(options))} with administrator privileges`;
}

async function defaultLaunch(options: ElevatedLaunchOptions): Promise<void> {
  if (process.platform === 'win32') return launchWindows(options);
  if (process.platform === 'darwin') return launchMac(options);
  if (process.platform === 'linux') return launchLinux(options);
  throw new ElevationUnavailableError(`elevation is not supported on ${process.platform}`);
}

async function launchWindows(options: ElevatedLaunchOptions): Promise<void> {
  // Elevate node.exe (or the branded launcher) directly; cmd.exe is never the
  // elevated target. Electron hosts need the nested PowerShell wrapper so the
  // helper runs with `ELECTRON_RUN_AS_NODE=1`.
  const { powerShellScript } =
    isElectronRuntime() && options.launcherPath === undefined
      ? buildElectronElevatedLaunchCommand(options)
      : buildElevatedLaunchCommand(options);
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powerShellScript],
      { windowsHide: true, timeout: 120_000 },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ElevationUnavailableError(
        'Windows PowerShell (powershell.exe) is required to request administrator rights but was not found',
        { cause: err },
      );
    }
    throw new ElevationCancelledError(
      `failed to start the elevated OpenVPN helper (the UAC prompt was cancelled or could not be shown): ${describeLaunchFailure(err)}`,
      { cause: err },
    );
  }
}

async function launchMac(options: ElevatedLaunchOptions): Promise<void> {
  try {
    await execFileAsync('osascript', ['-e', buildAppleScriptLaunchCommand(options)], { windowsHide: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ElevationUnavailableError(
        'osascript is required to request administrator rights but was not found',
        { cause: err },
      );
    }
    throw new ElevationCancelledError(
      `macOS administrator authorization failed (cancelled?): ${describeLaunchFailure(err)}`,
      { cause: err },
    );
  }
}

async function launchLinux(options: ElevatedLaunchOptions): Promise<void> {
  const args = [options.helperPath, '--port', String(options.port), '--token', options.token];
  try {
    await execFileAsync('pkexec', [options.nodePath, ...args], { windowsHide: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ElevationUnavailableError(
        'pkexec (PolicyKit) is required to request administrator rights but was not found',
        { cause: err },
      );
    }
    const detail = describeLaunchFailure(err);
    const numeric = typeof code === 'number' ? code : Number(code);
    if (/no authentication agent/i.test(detail)) {
      throw new ElevationUnavailableError(
        `no PolicyKit authentication agent is available: ${detail}`,
        { cause: err },
      );
    }
    if (numeric === 126 || numeric === 127 || /not authorized|dismissed|cancel/i.test(detail)) {
      throw new ElevationCancelledError(
        `PolicyKit authorization was cancelled or denied: ${detail}`,
        { cause: err },
      );
    }
    throw new ElevationError(
      `failed to start the elevated OpenVPN helper: ${detail}`,
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
    this.helperPath = resolveElevationHelperPath(
      options.helperPath === undefined ? {} : { helperPath: options.helperPath },
    );
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
            `the elevated helper did not connect back within ${this.handshakeTimeoutMs}ms ` +
              `(was the UAC prompt approved? helper: ${this.helperPath})`,
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
      const launch = this.launch({
        port: address.port,
        token: this.token,
        helperPath: this.helperPath,
        nodePath: this.nodePath,
        ...(this.launcherPath === undefined ? {} : { launcherPath: this.launcherPath }),
      });
      // A successful launch may resolve immediately (Windows) or only when the
      // helper exits (pkexec/osascript). Neither proves the helper is ready:
      // the handshake does. Map success to a promise that never settles so the
      // race below can only be won by the handshake, while an early launch
      // failure (e.g. the UAC prompt was cancelled) still rejects promptly.
      const launchFailure = launch.then(
        () => new Promise<void>(() => {}),
        (err) => Promise.reject(err),
      );
      void launchFailure.catch(() => {});
      await Promise.race([handshake, launchFailure]);
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
