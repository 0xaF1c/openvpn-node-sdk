import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BinaryManager } from '@ovpn-sdk/binary';
import { OvpnConfig } from '@ovpn-sdk/config';
import {
  ManagementClient,
  buildClientDeny,
  buildClientKill,
  buildClientPendingAuth,
  buildKillByCommonName,
  buildPkSignResponse,
  escapeArg,
  parseStatusText,
  splitBase64,
  type MgmtCommandResult,
  type OvpnState,
  type OvpnStateName,
  type PkSignRequest,
} from '@ovpn-sdk/core';
import {
  ProcessManager,
  buildOpenVpnArgs,
  getFreePort,
  waitForSocketPath,
  waitForTcpPort,
  type ProcessManagerLike,
  type SpawnedProcess,
} from '@ovpn-sdk/process';
import { AdapterManager, type AdapterManagerLike } from '@ovpn-sdk/tap';

export interface OpenVpnCredentials {
  username: string;
  password: string;
}

export interface OpenVpnClientOptions {
  binary?: string;
  tapctlBinary?: string;
  managementHost?: string;
  managementPort?: number;
  /** POSIX: use a unix domain socket for the management interface. */
  managementSocketPath?: string;
  credentials?: () => Promise<OpenVpnCredentials>;
  /** External private-key signer (--management-external-key). */
  signer?: (request: PkSignRequest) => Promise<Buffer>;
  /** External certificate provider (--management-external-cert). Returns base64 DER/PEM. */
  certificateProvider?: (hint: string) => Promise<string>;
  processManager?: ProcessManagerLike;
  connectTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  registerDns?: boolean;
  extraArgs?: string[];
  /** Windows: ensure a TAP adapter exists before connect (default true on win32). */
  manageAdapter?: boolean;
  /** Preferred adapter driver; 'auto' tries ovpn-dco then tap0901. */
  adapterHwid?: 'auto' | 'ovpn-dco' | 'root\\tap0901' | 'tap0901';
  /** Injectable adapter manager (tests). */
  adapterManager?: AdapterManagerLike;
}

interface StateWaiter {
  state: OvpnStateName;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OpenVpnClient extends EventEmitter {
  private configText: string;
  readonly binaries: BinaryManager;
  readonly adapters: AdapterManagerLike;

  private readonly options: OpenVpnClientOptions;
  private readonly processManager: ProcessManagerLike;

  private child: SpawnedProcess | null = null;
  protected management: ManagementClient | null = null;
  private tempDir: string | null = null;
  private configFile: string | null = null;
  private current: OvpnState | null = null;
  private readonly stateHistory: OvpnState[] = [];
  private readonly waiters: StateWaiter[] = [];
  private manuallyDisconnecting = false;
  private createdAdapterGuid: string | null = null;
  private cleanupPromise: Promise<void> | null = null;

  constructor(config: OvpnConfig | string, options: OpenVpnClientOptions = {}) {
    super();
    this.configText = typeof config === 'string' ? config : config.toString();
    this.options = options;
    this.processManager = options.processManager ?? new ProcessManager();
    this.binaries = new BinaryManager({
      openvpnBinary: options.binary,
      tapctlBinary: options.tapctlBinary,
    });
    this.adapters = options.adapterManager ?? new AdapterManager({ binary: options.tapctlBinary });
  }

  get currentState(): OvpnState | null {
    return this.current;
  }

  get states(): OvpnState[] {
    return [...this.stateHistory];
  }

  async connect(): Promise<void> {
    if (this.child) {
      throw new Error('OpenVpnClient is already started');
    }
    this.manuallyDisconnecting = false;

    const { path: binary } = this.binaries.resolveOpenVpn();
    const host = this.options.managementHost ?? '127.0.0.1';
    const socketPath = this.options.managementSocketPath;
    const port = socketPath
      ? 0
      : this.options.managementPort && this.options.managementPort > 0
        ? this.options.managementPort
        : await getFreePort();

    if (process.platform === 'win32' && (this.options.manageAdapter ?? true)) {
      const adapter = await this.adapters.ensure({ hwid: this.options.adapterHwid ?? 'auto' });
      if (adapter && !this.configText.includes('dev-node')) {
        this.configText += 'dev-node ' + escapeArg(adapter.name) + '\n';
        this.createdAdapterGuid = adapter.guid;
      }
    }

    this.tempDir = await mkdtemp(path.join(tmpdir(), 'ovpn-sdk-'));
    this.configFile = path.join(this.tempDir, 'client.ovpn');
    await writeFile(this.configFile, this.configText, 'utf8');

    const args = buildOpenVpnArgs({
      binary,
      configFile: this.configFile,
      managementHost: host,
      managementPort: port,
      managementSocket: socketPath,
      registerDns: this.options.registerDns,
      extraArgs: this.options.extraArgs,
    });

    this.child = this.processManager.start(binary, args);
    this.child.on('exit', (code, signal) => {
      this.emit('process-exit', { code, signal });
      void this.cleanup();
    });

    if (socketPath) {
      // Unix domain socket: OpenVPN creates it at spawn; wait for it to appear.
      await this.waitForManagementReady(() => waitForSocketPath(socketPath, this.options.connectTimeoutMs ?? 15_000));
    } else {
      await this.waitForManagementReady(() => waitForTcpPort(host, port, this.options.connectTimeoutMs ?? 15_000));
    }

    const management = new ManagementClient({
      host,
      port,
      socketPath,
      autoReconnect: true,
      commandTimeoutMs: this.options.connectTimeoutMs ?? 5000,
    });
    this.management = management;
    this.bindManagementEvents(management);
    await management.connect();
    this.emit('management-connected');
  }

  waitFor(state: OvpnStateName, timeoutMs = 30_000): Promise<void> {
    if (this.current?.name === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: StateWaiter = {
        state,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new Error(`timed out waiting for state ${state} (current: ${this.current?.name ?? 'none'})`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async sendManagement(command: string, opts?: Parameters<ManagementClient['send']>[1]): Promise<MgmtCommandResult> {
    if (!this.management) throw new Error('management client is not connected');
    return this.management.send(command, opts);
  }

  async submitCredentials(username: string, password: string): Promise<void> {
    await this.sendManagement(`username "Auth" ${escapeArg(username)}`, { expect: 'single' });
    await this.sendManagement(`password "Auth" ${escapeArg(password)}`, { expect: 'single' });
  }

  /** Answer a `>PK_SIGN` / `>RSA_SIGN` challenge with a raw signature. */
  submitSignature(signature: Buffer, legacy = false): void {
    const response = buildPkSignResponse(signature, legacy);
    this.management?.writeMultiline(response.command, response.lines);
  }

  /** Answer a `>NEED-CERTIFICATE` challenge with a base64 certificate. */
  submitCertificate(certBase64: string): void {
    this.management?.writeMultiline('certificate', splitBase64(certBase64));
  }

  async disconnect(): Promise<void> {
    if (!this.child) return;
    this.manuallyDisconnecting = true;

    try {
      if (this.management) {
        await this.management.send('signal SIGTERM', { expect: 'single', timeoutMs: 2000 });
      }
    } catch {
      // Fall through to process kill below.
    }

    const exitPromise = new Promise<void>((resolve) => {
      if (!this.child || this.child.exitCode !== undefined && this.child.exitCode !== null) return resolve();
      this.child.once('exit', () => resolve());
    });
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, this.options.disconnectTimeoutMs ?? 5000)),
    ]);

    const pid = this.child?.pid;
    if (pid && this.isChildRunning()) {
      await this.processManager.killTree(pid);
    }

    if (this.management) {
      this.management.disconnect();
      this.management = null;
    }
    if (this.createdAdapterGuid) {
      try {
        await this.adapters.release(this.createdAdapterGuid);
      } catch (err) {
        this.emit('error', err);
      }
      this.createdAdapterGuid = null;
    }
    await this.cleanup();
    this.emit('disconnected');
  }

  protected bindManagementEvents(management: ManagementClient): void {
    management.on('state', (state: OvpnState) => this.onState(state));
    management.on('log', (log) => this.emit('log', log));
    management.on('bytecount', (bytes) => this.emit('bytecount', bytes));
    management.on('notify', (kind, payload) => this.emit('notify', kind, payload));
    management.on('password-request', (payload: string) => this.handlePasswordRequest(payload));
    management.on('pk-sign', (request: PkSignRequest, kind: string) => this.handlePkSign(request, kind === 'RSA_SIGN'));
    management.on('need-certificate', (hint: string) => this.handleNeedCertificate(hint));
    management.on('error', (err) => this.emit('error', err));
  }

  private onState(state: OvpnState): void {
    this.current = state;
    this.stateHistory.push(state);
    this.emit('state', state);
    for (const waiter of [...this.waiters]) {
      if (waiter.state === state.name) {
        clearTimeout(waiter.timer);
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        waiter.resolve();
      }
    }
  }

  private handlePasswordRequest(payload: string): void {
    this.emit('password-request', payload);
    if (payload.includes('Verification Failed')) {
      this.emit('auth-failed', payload);
      return;
    }
    if (payload.includes("Need 'Auth'")) {
      const provider = this.options.credentials;
      if (provider) {
        provider()
          .then((creds) => this.submitCredentials(creds.username, creds.password))
          .catch((err) => this.emit('error', err));
      } else {
        this.emit('credentials-required', payload);
      }
    }
  }

  private handlePkSign(request: PkSignRequest, legacy: boolean): void {
    const signer = this.options.signer;
    if (!signer) {
      this.emit('signature-required', request, legacy);
      return;
    }
    signer(request)
      .then((signature) => this.submitSignature(signature, legacy))
      .catch((err) => this.emit('error', err));
  }

  private handleNeedCertificate(hint: string): void {
    const provider = this.options.certificateProvider;
    if (!provider) {
      this.emit('certificate-required', hint);
      return;
    }
    provider(hint)
      .then((certBase64) => this.submitCertificate(certBase64))
      .catch((err) => this.emit('error', err));
  }

  private waitForManagementReady(wait: () => Promise<void>): Promise<void> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('openvpn process was not started'));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onExit = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        const stderr = this.processManager.getStderr?.() ?? '';
        const stdout = this.processManager.getStdout?.() ?? '';
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join(' ');
        reject(new Error(`openvpn exited before the management socket became ready (code=${code}, signal=${signal})${details ? `: ${details}` : ''}`));
      };
      child.once('exit', onExit);
      wait().then(
        () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      ).finally(() => {
        child.removeListener('exit', onExit);
      });
    });
  }

  private isChildRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= this.doCleanup().finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }

  private async doCleanup(): Promise<void> {
    this.child = null;
    const dir = this.tempDir;
    if (!dir) return;
    this.tempDir = null;
    this.configFile = null;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle on the config file; retry once.
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore: OS temp cleanup will eventually reclaim it.
      }
    }
  }
}


export interface ClientConnectEvent {
  cid: number;
  kid: number;
  env: Record<string, string>;
}

/**
 * High-level OpenVPN server controller.
 *
 * Extends the process/management plumbing of OpenVpnClient with server-side
 * `--management-client-auth` decision APIs: approve/deny/pending-auth, kill,
 * and status parsing.
 */
export class OpenVpnServer extends OpenVpnClient {
  constructor(config: OvpnConfig | string, options: OpenVpnClientOptions = {}) {
    super(config, options);
  }

  protected override bindManagementEvents(management: ManagementClient): void {
    super.bindManagementEvents(management);
    management.on('client', (event) => {
      if (event.type === 'connect-env') {
        this.emit('client-connect', { cid: event.cid, kid: event.kid, env: event.env } satisfies ClientConnectEvent);
      } else {
        this.emit(`client-${event.type}`, event);
      }
    });
  }

  /** Approve a client. With config lines uses `client-auth` (multi-line), otherwise `client-auth-nt`. */
  async approveClient(cid: number | string, kid: number | string, configLines: string[] = []): Promise<MgmtCommandResult> {
    if (this.management === null) throw new Error('management client is not connected');
    if (configLines.length === 0) {
      return this.sendManagement(`client-auth-nt ${cid} ${kid}`, { expect: 'single' });
    }
    return this.management.sendMultiline(`client-auth ${cid} ${kid}`, configLines, { expect: 'single' });
  }

  /** Deny a client with a reason and optional client-facing reason. */
  async denyClient(cid: number | string, kid: number | string, reason: string, clientReason?: string): Promise<MgmtCommandResult> {
    return this.sendManagement(buildClientDeny(cid, kid, reason, clientReason), { expect: 'single' });
  }

  /** Move a client to pending (out-of-band) authentication. */
  async pendingAuthClient(cid: number | string, kid: number | string, extra: string, timeout: number | string): Promise<MgmtCommandResult> {
    return this.sendManagement(buildClientPendingAuth(cid, kid, extra, timeout), { expect: 'single' });
  }

  /** Kill a client by CID with an optional message. */
  async killClient(cid: number | string, message?: string): Promise<MgmtCommandResult> {
    return this.sendManagement(buildClientKill(cid, message), { expect: 'single' });
  }

  /** Kill all clients with the given common name. */
  async killByCommonName(commonName: string): Promise<MgmtCommandResult> {
    return this.sendManagement(buildKillByCommonName(commonName), { expect: 'single' });
  }

  /** Fetch and parse `status` (default or `status N`). */
  async getStatus(version?: number): Promise<ReturnType<typeof parseStatusText>> {
    const command = version !== undefined ? `status ${version}` : 'status';
    const result = await this.sendManagement(command, { expect: 'end' });
    return parseStatusText(result.lines.join('\n'));
  }
}

export { BinaryManager } from '@ovpn-sdk/binary';
export { OvpnConfig } from '@ovpn-sdk/config';
export * from '@ovpn-sdk/core';
export { ProcessManager, buildOpenVpnArgs, getFreePort, waitForTcpPort, type ProcessManagerLike, type SpawnedProcess } from '@ovpn-sdk/process';
export { AdapterManager, decodeTapctl, type AdapterInfo, type TapctlOptions } from '@ovpn-sdk/tap';
export { ManagementClient, type ManagementClientOptions } from '@ovpn-sdk/core';
