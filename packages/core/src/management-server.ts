import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { ManagementClient, type ManagementInitCommand } from './client.ts';

export interface ManagementServerOptions {
  host?: string;
  port?: number;
  /** POSIX unix domain socket path. */
  socketPath?: string;
  /** Init sequence run for every accepted OpenVPN client. */
  initSequence?: ManagementInitCommand[];
}

/**
 * TCP/unix-socket server for OpenVPN `--management-client` reverse mode.
 * OpenVPN connects as a client; this server accepts one or more connections
 * and exposes each as a ManagementClient.
 */
export class ManagementServer extends EventEmitter {
  readonly server: Server;
  readonly clients = new Set<ManagementClient>();

  private readonly options: ManagementServerOptions;

  constructor(options: ManagementServerOptions = {}) {
    super();
    this.options = options;
    this.server = createServer((socket) => void this.accept(socket));
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
    for (const client of this.clients) {
      await client.disconnect();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async accept(socket: Socket): Promise<void> {
    const client = new ManagementClient({
      host: this.options.host ?? '127.0.0.1',
      port: this.options.port ?? 0,
      autoReconnect: false,
      initSequence: this.options.initSequence,
    });
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
    client.on('close', () => this.clients.delete(client));
    this.emit('connection', client);

    try {
      await client.attachSocket(socket);
      await client.initialize();
      this.emit('client-ready', client);
    } catch (err) {
      this.emit('error', err);
    }
  }
}
