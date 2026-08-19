import { createServer, type Server, type Socket } from 'node:net';
import { LineDecoder } from './codec.ts';

export interface MockManagementServerOptions {
  host?: string;
  port?: number;
  /** Unix domain socket path (POSIX only). Takes precedence over host/port. */
  socketPath?: string;
  welcome?: string;
  /** Custom command handler; return lines to write back (or void to stay silent). */
  onCommand?: (line: string, socket: Socket) => string[] | void | Promise<string[] | void>;
}

export const DEFAULT_MOCK_WELCOME =
  ">INFO:OpenVPN Management Interface Version 6 -- type 'help' for more info";

/**
 * Scriptable mock OpenVPN management server for protocol tests.
 */
export class MockManagementServer {
  readonly server: Server;
  readonly sockets = new Set<Socket>();
  readonly received: string[] = [];

  private readonly options: MockManagementServerOptions;
  private readonly decoder = new LineDecoder();

  constructor(options: MockManagementServerOptions = {}) {
    this.options = options;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
      socket.write(`${options.welcome ?? DEFAULT_MOCK_WELCOME}\r\n`);
      socket.on('data', (chunk: Buffer) => this.handleData(socket, chunk.toString('utf8')));
    });
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      if (this.options.socketPath) {
        this.server.listen(this.options.socketPath, () => resolve(0));
      } else {
        this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
          const address = this.server.address();
          if (address && typeof address === 'object') {
            resolve(address.port);
          } else {
            reject(new Error('server did not bind to a TCP port'));
          }
        });
      }
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Broadcast a raw management line to every connected client. */
  broadcast(line: string): void {
    for (const socket of this.sockets) {
      socket.write(`${line}\r\n`);
    }
  }

  private async handleData(socket: Socket, chunk: string): Promise<void> {
    for (const line of this.decoder.push(chunk)) {
      if (line.trim() === '') continue;
      this.received.push(line);
      const handler = this.options.onCommand;
      if (handler) {
        const response = await handler(line, socket);
        if (response) {
          for (const out of response) {
            socket.write(`${out}\r\n`);
          }
        }
        continue;
      }
      const response = defaultMockResponse(line);
      for (const out of response) {
        socket.write(`${out}\r\n`);
      }
    }
  }
}

/** Protocol-shaped default responses for the commands the SDK init flow uses. */
export function defaultMockResponse(line: string): string[] {
  const parts = line.trim().split(/\s+/);
  const verb = parts[0] ?? '';
  const arg = parts[1];
  switch (verb) {
    case 'version':
      if (arg) return [`SUCCESS: Management client version set to ${arg}`];
      return ['OpenVPN Version: OpenVPN 2.8-mock', 'Management Version: 6', 'END'];
    case 'state':
      if (parts.includes('all')) return ['SUCCESS: real-time state notification set to ON', '1715000000,CONNECTING,init,,,,,,,', 'END'];
      if (arg === 'on') return ['SUCCESS: real-time state notification set to ON'];
      if (arg === 'off') return ['SUCCESS: real-time state notification set to OFF'];
      if (arg && /^\d+$/.test(arg)) return ['1715000000,CONNECTING,init,,,,,,,', 'END'];
      return ['SUCCESS: real-time state notification set to ON'];
    case 'log':
      if (parts.includes('all')) return ['SUCCESS: real-time log notification set to ON', '1715000000,I,mock log line', 'END'];
      if (arg === 'on') return ['SUCCESS: real-time log notification set to ON'];
      if (arg === 'off') return ['SUCCESS: real-time log notification set to OFF'];
      if (arg && /^\d+$/.test(arg)) return ['1715000000,I,mock log line', 'END'];
      return ['SUCCESS: real-time log notification set to ON'];
    case 'echo':
      return ['SUCCESS: real-time echo notification set to ON'];
    case 'bytecount':
      return ['SUCCESS: bytecount interval changed'];
    case 'hold':
      return arg === 'release' ? ['SUCCESS: hold release succeeded'] : ['SUCCESS: hold flag set to ON'];
    case 'pid':
      return ['SUCCESS: pid=4242'];
    case 'signal':
      return ['SUCCESS: signal SIGTERM executed'];
    case 'help':
      return ['Management Interface for OpenVPN 2.8-mock', 'Commands:', 'END'];
    case 'exit':
    case 'quit':
      return [];
    default:
      return [`ERROR: unknown command [${verb}]`];
  }
}
