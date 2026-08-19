import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OpenVpnProcessOptions {
  binary: string;
  configFile: string;
  managementHost?: string;
  managementPort?: number;
  /** POSIX: use a unix domain socket for the management interface. */
  managementSocket?: string;
  managementHold?: boolean;
  queryPasswords?: boolean;
  registerDns?: boolean;
  extraArgs?: string[];
  spawnOptions?: SpawnOptions;
}

/** Minimal process handle shape used by OpenVpnClient. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  removeListener(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessManagerLike {
  start(binary: string, args: string[]): SpawnedProcess;
  killTree(pid: number): Promise<void>;
  /** Optional diagnostics: collected stderr output from the spawned process. */
  getStderr?(): string;
  /** Optional diagnostics: collected stdout output from the spawned process. */
  getStdout?(): string;
}

/** Build the argv for launching an OpenVPN client with a management socket. */
export function buildOpenVpnArgs(options: OpenVpnProcessOptions): string[] {
  const managementArgs = options.managementSocket
    ? ['--management', options.managementSocket, 'unix']
    : ['--management', options.managementHost ?? '127.0.0.1', String(options.managementPort ?? 0)];
  const args = [
    '--config', options.configFile,
    ...managementArgs,
  ];
  if (options.managementHold !== false) args.push('--management-hold');
  if (options.queryPasswords !== false) args.push('--management-query-passwords');
  if (options.registerDns) args.push('--register-dns');
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}

/** Pick a currently-free TCP port on 127.0.0.1. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => reject(new Error('failed to allocate a port')));
      }
    });
  });
}

/** Wait until a TCP port accepts connections (or timeout). */
export async function waitForTcpPort(host: string, port: number, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(host, port, 250)) return;
    await sleep(intervalMs);
  }
  throw new Error(`TCP ${host}:${port} not reachable within ${timeoutMs}ms`);
}

/** Wait until a unix domain socket file exists (OpenVPN creates it on start). */
export async function waitForSocketPath(socketPath: string, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await sleep(intervalMs);
  }
  throw new Error(`socket ${socketPath} not created within ${timeoutMs}ms`);
}

async function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ProcessManager: spawn and supervise an OpenVPN process.
 */
export class ProcessManager implements ProcessManagerLike {
  private child: ChildProcess | null = null;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];

  get running(): boolean {
    return this.child?.exitCode === null && this.child?.signalCode === null;
  }

  start(binary: string, args: string[]): SpawnedProcess {
    this.stdoutChunks.length = 0;
    this.stderrChunks.length = 0;
    this.child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout?.on('data', (d: Buffer) => this.stdoutChunks.push(d));
    this.child.stderr?.on('data', (d: Buffer) => this.stderrChunks.push(d));
    return this.child;
  }

  getStderr(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  getStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf8');
  }

  async killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch (err) {
        // Fall back to direct kill if taskkill is unavailable.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already gone.
        }
        throw err;
      }
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone.
    }
  }

  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      sleep(opts.timeoutMs ?? 5000),
    ]);
    if (child.exitCode === null) {
      await this.killTree(child.pid ?? 0);
    }
  }
}
