import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { FrameParser, LineDecoder, classifyLine, parseByteCount, parseLog, parseState } from './codec.ts';
import { ClientEnvCollector } from './server.ts';
import { parseNeedCertificate, parsePkSignRequest } from './external-key.ts';
import type { MgmtCommandResult } from './types.ts';

export type CommandExpect = 'end' | 'single';

export interface ManagementCommandOptions {
  expect?: CommandExpect | 'auto';
  timeoutMs?: number;
}

export interface ManagementInitCommand {
  command: string;
  expect: CommandExpect;
}

export const DEFAULT_INIT_SEQUENCE: ManagementInitCommand[] = [
  { command: 'version 6', expect: 'single' },
  { command: 'state on all', expect: 'end' },
  { command: 'log on all', expect: 'end' },
  { command: 'bytecount 1', expect: 'single' },
];

export interface ManagementClientOptions {
  /** TCP host (default 127.0.0.1). Required unless `socketPath` is set. */
  host?: string;
  /** TCP port. Required unless `socketPath` is set. */
  port?: number;
  /** Unix domain socket path (POSIX only). Takes precedence over host/port. */
  socketPath?: string;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  welcomeTimeoutMs?: number;
  commandTimeoutMs?: number;
  initSequence?: ManagementInitCommand[];
  onCommandResult?: (result: MgmtCommandResult) => void;
  onNotify?: (kind: string, payload: string) => void;
}

interface PendingCommand {
  command: string;
  expect: CommandExpect;
  extraLines?: string[];
  multiline?: boolean;
  resolve: (result: MgmtCommandResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ManagementClient extends EventEmitter {
  private readonly options: ManagementClientOptions;
  private readonly decoder = new LineDecoder();
  private readonly parser = new FrameParser((line) => this.handleNotify(line.kind, line.payload));
  private readonly clientEnv = new ClientEnvCollector();

  private socket: Socket | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;

  private queue: PendingCommand[] = [];
  private busy = false;
  private manuallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  protocolVersion = 1;
  welcomeLine = '';

  constructor(options: ManagementClientOptions) {
    super();
    this.options = options;
  }

  async connect(): Promise<void> {
    this.manuallyClosed = false;
    await this.openSocket();
    await this.waitForWelcome();
    this.reconnectAttempt = 0;
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.rejectAllPending(new Error('management client disconnected'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.end();
      socket.destroy();
    }
  }

  send(command: string, opts: ManagementCommandOptions = {}): Promise<MgmtCommandResult> {
    return this.enqueue(command, [], opts);
  }

  /** Queue a multi-line command (body lines are sent verbatim, then `END`). */
  sendMultiline(command: string, lines: string[] = [], opts: ManagementCommandOptions = {}): Promise<MgmtCommandResult> {
    return this.enqueue(command, lines, opts, true);
  }

  /**
   * Write a multi-line command without waiting for a response. Used for
   * `pk-sig` / `rsa-sig` / `certificate` replies: OpenVPN consumes the body
   * synchronously and does not emit a SUCCESS/ERROR line.
   */
  writeMultiline(command: string, lines: string[] = []): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(`${command}\n`);
    for (const line of lines) {
      this.socket.write(`${line}\n`);
    }
    this.socket.write(`END\n`);
  }

  private enqueue(command: string, extraLines: string[], opts: ManagementCommandOptions, multiline = false): Promise<MgmtCommandResult> {
    const expect = opts.expect === 'auto' || opts.expect === undefined ? inferExpect(command) : opts.expect;
    const timeoutMs = opts.timeoutMs ?? this.options.commandTimeoutMs ?? 5000;
    return new Promise<MgmtCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        command,
        expect,
        extraLines,
        multiline,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(pending);
          if (idx !== -1) this.queue.splice(idx, 1);
          if (this.busy) this.busy = false;
          this.socket?.destroy();
          reject(new Error(`management command timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs),
      };
      this.queue.push(pending);
      this.pumpQueue();
    });
  }

  async initialize(sequence: ManagementInitCommand[] = this.options.initSequence ?? DEFAULT_INIT_SEQUENCE): Promise<void> {
    for (const item of sequence) {
      const result = await this.send(item.command, { expect: item.expect });
      if (item.command.startsWith('version ') && result.success) {
        const match = result.success.match(/(\d+)/);
        if (match) this.protocolVersion = Number(match[1]);
      }
    }
    this.emit('initialized');
  }

  private async openSocket(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const socket = this.options.socketPath
      ? connect({ path: this.options.socketPath })
      : connect({ host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 0 });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => this.emit('socket-connect'));
    socket.on('error', (err) => {
      this.readyReject?.(err);
      this.emit('error', err);
    });
    socket.on('data', (chunk: string) => this.handleData(chunk));
    socket.on('close', () => {
      this.readyReject?.(new Error('management socket closed before welcome'));
      this.rejectAllPending(new Error('management socket closed'));
      this.emit('close');
      this.scheduleReconnectIfNeeded();
    });
    socket.on('end', () => this.emit('end'));
  }

  private waitForWelcome(): Promise<void> {
    if (!this.readyPromise) {
      return Promise.reject(new Error('client is not connecting'));
    }
    this.welcomeTimer = setTimeout(() => {
      this.readyReject?.(new Error(`welcome banner not received within ${this.options.welcomeTimeoutMs ?? 5000}ms`));
    }, this.options.welcomeTimeoutMs ?? 5000);
    this.welcomeTimer.unref?.();
    return this.readyPromise;
  }

  /**
   * Attach an already-connected socket (used by ManagementServer in
   * `--management-client` reverse mode). Returns once the welcome banner
   * has been received.
   */
  attachSocket(socket: Socket): Promise<void> {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => this.emit('socket-connect'));
    socket.on('error', (err) => {
      this.readyReject?.(err);
      this.emit('error', err);
    });
    socket.on('data', (chunk: string) => this.handleData(chunk));
    socket.on('close', () => {
      this.readyReject?.(new Error('management socket closed before welcome'));
      this.rejectAllPending(new Error('management socket closed'));
      this.emit('close');
      this.scheduleReconnectIfNeeded();
    });
    socket.on('end', () => this.emit('end'));
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    return this.waitForWelcome();
  }

  private handleData(chunk: string): void {
    for (const line of this.decoder.push(chunk)) {
      const classified = classifyLine(line);
      if (classified.type === 'notify' && classified.kind === 'INFO' && classified.payload.includes('OpenVPN Management Interface')) {
        this.welcomeLine = classified.raw;
        if (this.welcomeTimer) {
          clearTimeout(this.welcomeTimer);
          this.welcomeTimer = null;
        }
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        this.emit('welcome', classified.payload);
        this.handleNotify(classified.kind, classified.payload);
        continue;
      }

      const mode = this.busy ? (this.queue[0]?.expect ?? 'end') : 'end';
      const result = this.parser.push(classified, mode);
      if (result) {
        this.completeCurrent(result);
      }
    }
  }

  private handleNotify(kind: string, payload: string): void {
    this.options.onNotify?.(kind, payload);
    this.emit('notify', kind, payload);
    switch (kind) {
      case 'STATE': {
        const state = parseState(payload);
        this.emit('state', state);
        break;
      }
      case 'LOG': {
        const log = parseLog(payload);
        this.emit('log', log);
        break;
      }
      case 'BYTECOUNT':
      case 'BYTECOUNT_CLI': {
        const bytes = parseByteCount(payload);
        this.emit('bytecount', bytes);
        break;
      }
      case 'PASSWORD':
        this.emit('password-request', payload);
        break;
      case 'CLIENT': {
        const event = this.clientEnv.push(kind, payload);
        if (event) {
          this.emit('client', event);
          this.emit(`client-${event.type}`, event);
        }
        break;
      }
      case 'PK_SIGN':
      case 'RSA_SIGN':
        this.emit('pk-sign', parsePkSignRequest(payload), kind);
        break;
      case 'NEED-CERTIFICATE':
        this.emit('need-certificate', parseNeedCertificate(payload));
        break;
      default:
        break;
    }
  }

  private pumpQueue(): void {
    if (this.busy || this.queue.length === 0 || !this.socket || this.socket.destroyed) {
      return;
    }
    const pending = this.queue[0];
    if (!pending) return;
    this.busy = true;
    this.socket.write(`${pending.command}\n`);
    for (const line of pending.extraLines ?? []) {
      this.socket.write(`${line}\n`);
    }
    if (pending.multiline) {
      this.socket.write(`END\n`);
    }
  }

  private completeCurrent(result: MgmtCommandResult): void {
    const pending = this.queue.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    this.busy = false;
    this.options.onCommandResult?.(result);
    this.emit('command-result', result, pending.command);
    pending.resolve(result);
    this.pumpQueue();
  }

  private rejectAllPending(err: Error): void {
    const pending = this.queue.splice(0);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    this.busy = false;
  }

  private scheduleReconnectIfNeeded(): void {
    if (this.manuallyClosed || !this.socket) return;
    if (!(this.options.autoReconnect ?? true)) return;
    if (this.reconnectTimer) return;

    const base = this.options.reconnectBaseDelayMs ?? 1000;
    const max = this.options.reconnectMaxDelayMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.emit('reconnecting', delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket()
        .then(() => this.waitForWelcome())
        .then(() => {
          this.reconnectAttempt = 0;
          this.emit('reconnected');
          return this.initialize();
        })
        .catch((err) => {
          this.emit('error', err);
        });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export function inferExpect(command: string): CommandExpect {
  const parts = command.trim().split(/\s+/);
  const verb = parts[0] ?? '';
  const rest = parts.slice(1);
  switch (verb) {
    case 'help':
    case 'status':
    case 'net':
    case 'test':
    case 'load-stats':
    case 'remote-entry-count':
    case 'remote-entry-get':
      return 'end';
    case 'version':
      return rest.length === 0 ? 'end' : 'single';
    case 'state':
    case 'log':
    case 'echo':
      return rest.includes('all') || (rest.length > 0 && /^\d+$/.test(rest[rest.length - 1] ?? '')) ? 'end' : 'single';
    case 'pid':
    case 'signal':
    case 'bytecount':
    case 'hold':
    case 'auth-retry':
    case 'verb':
    case 'mute':
    case 'username':
    case 'password':
    case 'needok':
    case 'needstr':
    case 'cr-response':
    case 'forget-passwords':
    case 'client-auth':
    case 'client-auth-nt':
    case 'client-deny':
    case 'client-pending-auth':
    case 'client-kill':
    case 'pk-sig':
    case 'rsa-sig':
    case 'certificate':
    case 'pkcs11-id-count':
    case 'pkcs11-id-get':
    case 'remote':
    case 'proxy':
    case 'push-update-broad':
    case 'push-update-cid':
      return 'single';
    default:
      return 'end';
  }
}
