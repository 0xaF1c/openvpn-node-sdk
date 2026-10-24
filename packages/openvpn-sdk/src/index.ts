import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  buildWindowsCommandLine,
  getFreePort,
  waitForSocketPath,
  waitForTcpPort,
  type ProcessManagerLike,
  type SpawnedProcess,
} from '@ovpn-sdk/process';
import {
  AdapterManager,
  OpenvpnServiceClient,
  OpenvpnServiceError,
  readOpenvpnServiceSettings,
  SERVICE_ERROR_STARTUP_DATA,
  type AdapterManagerLike,
  type AdapterServiceMode,
  type OpenvpnServiceLauncherLike,
  type ServiceOpenVpnProcessLike,
} from '@ovpn-sdk/tap';

/** Windows privilege strategy for `OpenVpnClient`. */
export type ElevationMode = 'auto' | 'service' | 'never';

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
  /** Adapter creation strategy (default `'auto'`): `auto` / `always` / `never`. */
  adapterServiceMode?: AdapterServiceMode;
  /**
   * Windows privilege strategy (default `'auto'`):
   * - `auto`: run through `openvpnserv` when the process is not elevated and
   *   the interactive service is available; otherwise spawn OpenVPN directly;
   * - `service`: always run through the interactive service;
   * - `never`: always spawn directly (the service is only used for adapters).
   *
   * The service runs its configured `exe_path`, ignores the `binary` option,
   * and validates options/config locations; see the README.
   */
  elevation?: ElevationMode;
  /** Override the interactive-service pipe name. */
  servicePipe?: string;
  /** Injectable interactive-service client (tests). */
  serviceClient?: OpenvpnServiceLauncherLike;
  /**
   * Directory in which to create the temporary profile when launching through
   * `openvpnserv`. Non-admin users must use the service's `config_dir`
   * (`HKLM\SOFTWARE\OpenVPN\config_dir`) or be a member of
   * `ovpn_admin_group`; the SDK does not write to Program Files implicitly.
   */
  serviceConfigDir?: string;
  /** Capture OpenVPN's own log in the temp directory during service launches (default true). */
  serviceLog?: boolean;
  /** Timeout for the service to return the new OpenVPN pid (default 15000). */
  serviceStartTimeoutMs?: number;
  /** Override the elevation probe used by `elevation: 'auto'` (tests). */
  isElevated?: () => Promise<boolean>;
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
  private readonly serviceClient: OpenvpnServiceLauncherLike | null;

  private child: SpawnedProcess | null = null;
  protected management: ManagementClient | null = null;
  private tempDir: string | null = null;
  private configFile: string | null = null;
  private configOutsideTemp = false;
  private serviceProcess: ServiceOpenVpnProcessLike | null = null;
  private serviceLogFile: string | null = null;
  private launchedViaService = false;
  private connectInProgress = false;
  private current: OvpnState | null = null;
  private readonly stateHistory: OvpnState[] = [];
  private readonly waiters: StateWaiter[] = [];
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
    this.adapters =
      options.adapterManager ??
      new AdapterManager({
        binary: options.tapctlBinary,
        ...(options.adapterServiceMode === undefined ? {} : { serviceMode: options.adapterServiceMode }),
      });
    this.serviceClient =
      options.serviceClient ??
      (process.platform === 'win32'
        ? new OpenvpnServiceClient({
            ...(options.servicePipe === undefined ? {} : { pipePath: options.servicePipe }),
          })
        : null);
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

    const host = this.options.managementHost ?? '127.0.0.1';
    const socketPath = this.options.managementSocketPath;
    const port = socketPath
      ? 0
      : this.options.managementPort && this.options.managementPort > 0
        ? this.options.managementPort
        : await getFreePort();

    const plan = await this.resolveServicePlan();
    if (plan.useService && this.options.registerDns) {
      throw new Error(
        "`registerDns` cannot be used with openvpnserv elevation: --register-dns is not on the interactive service whitelist. " +
          "Add `register-dns` to the profile, or use elevation: 'never'.",
      );
    }

    // In service mode the service runs its configured exe_path; the SDK only
    // needs a local binary for a direct spawn.
    const binary = plan.useService ? 'openvpn' : this.binaries.resolveOpenVpn().path;

    this.connectInProgress = true;
    try {
      if (process.platform === 'win32' && (this.options.manageAdapter ?? true)) {
        const adapter = await this.adapters.ensure({ hwid: this.options.adapterHwid ?? 'auto' });
        if (adapter) {
          // The service cannot set an adapter name: when it creates the adapter
          // there is no name to inject, so OpenVPN picks the first matching one.
          if (adapter.name !== '' && !this.configText.includes('dev-node')) {
            this.configText += 'dev-node ' + escapeArg(adapter.name) + '\n';
          }
          if (adapter.guid !== '') this.createdAdapterGuid = adapter.guid;
        }
      }

      this.tempDir = await mkdtemp(path.join(tmpdir(), 'ovpn-sdk-'));
      await this.writeConfig(plan.useService);
      const configFile = this.configFile;
      if (configFile === null) throw new Error('the OpenVPN profile was not written');

      const args = buildOpenVpnArgs({
        binary,
        configFile,
        managementHost: host,
        managementPort: port,
        managementSocket: socketPath,
        registerDns: plan.useService ? false : this.options.registerDns,
        extraArgs: this.options.extraArgs,
      });

      if (plan.useService) {
        if (this.options.serviceLog !== false) {
          this.serviceLogFile = path.join(this.tempDir, 'openvpn-service.log');
          args.push('--log', this.serviceLogFile);
        }
        this.serviceProcess = await this.startViaService(args);
        this.child = this.serviceProcess;
        this.launchedViaService = true;
      } else {
        this.child = this.processManager.start(binary, args);
        this.launchedViaService = false;
      }

      this.child.on('exit', (code, signal) => {
        this.emit('process-exit', { code, signal });
        // Keep the temp directory (and the service log) until connect() has
        // had a chance to include the log tail in its error message.
        if (!this.connectInProgress) void this.cleanup();
      });

      if (this.child.exitCode !== null && this.child.exitCode !== undefined) {
        throw new Error(
          `openvpn exited before the management socket became ready (code=${this.child.exitCode})` +
            `${this.serviceErrorSuffix()}`,
        );
      }

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
      this.connectInProgress = false;
      this.emit('management-connected');
    } catch (err) {
      if (plan.useService) await this.attachServiceLog(err);
      this.connectInProgress = false;
      await this.abortConnect();
      throw err;
    }
  }

  /** Append the tail of `--log` to a failed service launch (best effort). */
  private async attachServiceLog(err: unknown): Promise<void> {
    if (!(err instanceof Error) || this.serviceLogFile === null) return;
    try {
      const log = await readFile(this.serviceLogFile, 'utf8');
      const tail = log.trim().split(/\r?\n/).slice(-8).join('\n');
      if (tail !== '' && !err.message.includes(tail)) {
        err.message += `\nOpenVPN log (tail):\n${tail}`;
      }
    } catch {
      // No log file (validation error before OpenVPN started).
    }
  }

  /**
   * Decide whether this connection should be brokered by `openvpnserv`.
   *
   * `auto` prefers the service only for non-elevated Windows processes. When
   * the service is unreachable it falls back to a direct spawn, which works
   * for elevated processes and for unprivileged tunnels (`dev null`).
   */
  private async resolveServicePlan(): Promise<{ useService: boolean }> {
    const mode = this.options.elevation ?? 'auto';
    if (process.platform !== 'win32') {
      if (mode === 'service') {
        throw new Error("elevation: 'service' requires Windows and the OpenVPN interactive service");
      }
      return { useService: false };
    }
    if (mode === 'never') return { useService: false };

    const client = this.serviceClient;
    if (!client?.startOpenVpn) {
      if (mode === 'service') {
        throw new Error('the configured service client does not implement startOpenVpn()');
      }
      return { useService: false };
    }

    if (mode === 'service') return { useService: true };
    if (await this.detectElevated()) return { useService: false };

    if (typeof client.isAvailable === 'function') {
      try {
        if (!(await client.isAvailable())) return { useService: false };
      } catch {
        return { useService: false };
      }
    }
    return { useService: true };
  }

  private async detectElevated(): Promise<boolean> {
    if (this.options.isElevated) {
      try {
        return await this.options.isElevated();
      } catch {
        return false;
      }
    }
    if (this.adapters.isElevated) {
      try {
        return await this.adapters.isElevated();
      } catch {
        return false;
      }
    }
    return false;
  }

  private async writeConfig(useService: boolean): Promise<void> {
    const tempDir = this.tempDir;
    if (!tempDir) throw new Error('temporary directory was not created');

    const directory =
      useService && this.options.serviceConfigDir !== undefined
        ? path.resolve(this.options.serviceConfigDir)
        : tempDir;
    if (directory !== tempDir) {
      try {
        await mkdir(directory, { recursive: true });
      } catch (err) {
        throw new Error(
          `cannot create serviceConfigDir "${directory}": ${err instanceof Error ? err.message : String(err)}. ` +
            'The interactive service only accepts profiles under its config_dir; choose a writable directory there or run elevated.',
          { cause: err },
        );
      }
    }

    const file = path.join(directory, `openvpn-sdk-${process.pid}-${randomBytes(6).toString('hex')}.ovpn`);
    await writeFile(file, this.configText, 'utf8');
    this.configFile = file;
    this.configOutsideTemp = directory !== tempDir;
  }

  private async startViaService(args: string[]): Promise<ServiceOpenVpnProcessLike> {
    const client = this.serviceClient;
    if (!client?.startOpenVpn) {
      throw new Error('the configured service client does not implement startOpenVpn()');
    }
    // Use the profile directory so relative file references inside the profile
    // (ca/cert/key/tls-auth) resolve next to the profile, like a normal OpenVPN
    // launch from that directory.
    const workingDirectory =
      this.configFile !== null ? path.dirname(this.configFile) : this.tempDir;
    if (!workingDirectory) throw new Error('temporary directory was not created');

    try {
      return await client.startOpenVpn({
        workingDirectory,
        options: buildWindowsCommandLine(args),
        stdin: '',
        timeoutMs: this.options.serviceStartTimeoutMs ?? 15_000,
      });
    } catch (err) {
      throw await this.decorateServiceError(err);
    }
  }

  /** Add actionable remediation to service startup failures. */
  private async decorateServiceError(err: unknown): Promise<Error> {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!(err instanceof OpenvpnServiceError)) return error;

    if (err.errorNumber === SERVICE_ERROR_STARTUP_DATA) {
      let hint =
        ' The interactive service rejected the startup data; non-admin users may only use profiles under the service config_dir.';
      const settings = await readOpenvpnServiceSettings().catch(() => null);
      if (settings?.configDir) {
        const group = settings.adminGroup ?? 'OpenVPN Administrators';
        hint = ` The interactive service accepts profiles only under "${settings.configDir}" unless the user is a member of "${group}". ` +
          'Pass `serviceConfigDir` (a writable directory inside config_dir) or run elevated.';
      }
      error.message = `${error.message}.${hint}`;
    }
    return error;
  }

  private serviceErrorSuffix(): string {
    const lastError = this.serviceProcess?.lastError;
    return lastError ? `: ${lastError}` : '';
  }

  private async abortConnect(): Promise<void> {
    const child = this.child;
    this.child = null;

    if (child && child.exitCode === null && child.pid !== undefined && child.pid > 0) {
      try {
        await this.processManager.killTree(child.pid);
      } catch {
        // Best effort: the process may already be gone.
      }
      if (this.launchedViaService && child.exitCode === null) {
        this.serviceProcess?.kill();
      }
    }
    this.serviceProcess?.close();
    this.serviceProcess = null;
    this.launchedViaService = false;

    if (this.management) {
      await this.management.disconnect();
      this.management = null;
    }

    if (this.createdAdapterGuid !== null) {
      try {
        await this.adapters.release(this.createdAdapterGuid);
      } catch {
        // Adapter cleanup is best effort.
      }
      this.createdAdapterGuid = null;
    }

    await this.cleanup();
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
    const child = this.child;
    if (!child) {
      // The process may have exited on its own (the exit handler cleared
      // `child`), but the management client and adapter may still be open.
      if (this.management === null && this.serviceProcess === null && this.createdAdapterGuid === null) {
        return;
      }
      this.serviceProcess?.close();
      this.serviceProcess = null;
      this.launchedViaService = false;
      if (this.management) {
        await this.management.disconnect();
        this.management = null;
      }
      if (this.createdAdapterGuid !== null) {
        try {
          await this.adapters.release(this.createdAdapterGuid);
        } catch (err) {
          this.emit('error', err);
        }
        this.createdAdapterGuid = null;
      }
      await this.cleanup();
      this.emit('disconnected');
      return;
    }

    try {
      if (this.management) {
        await this.management.send('signal SIGTERM', { expect: 'single', timeoutMs: 2000 });
      }
    } catch {
      // Fall through to process kill below.
    }

    const exitPromise = new Promise<void>((resolve) => {
      if (child.exitCode !== undefined && child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, this.options.disconnectTimeoutMs ?? 5000)),
    ]);

    const pid = child.pid;
    if (pid && this.isChildRunning()) {
      try {
        await this.processManager.killTree(pid);
      } catch {
        // The process may have exited between the check and taskkill.
      }
      if (this.launchedViaService && this.isChildRunning()) {
        this.serviceProcess?.kill();
      }
    }

    this.serviceProcess?.close();
    this.serviceProcess = null;
    this.launchedViaService = false;

    if (this.management) {
      await this.management.disconnect();
      this.management = null;
    }
    if (this.createdAdapterGuid !== null) {
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
        const serviceError = this.serviceProcess?.lastError ?? '';
        const stderr = this.processManager.getStderr?.() ?? '';
        const stdout = this.processManager.getStdout?.() ?? '';
        const details = [serviceError.trim(), stderr.trim(), stdout.trim()].filter(Boolean).join(' ');
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
    const configFile = this.configFile;
    const configOutsideTemp = this.configOutsideTemp;
    this.tempDir = null;
    this.configFile = null;
    this.configOutsideTemp = false;
    this.serviceLogFile = null;

    if (configOutsideTemp && configFile !== null) {
      try {
        await rm(configFile, { force: true });
      } catch {
        // Ignore: the profile may be held briefly by OpenVPN.
      }
    }
    if (!dir) return;
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
    // Server profiles use options such as --management-client-auth that are not
    // on the interactive-service whitelist, so default to a direct spawn.
    super(config, options.elevation === undefined ? { ...options, elevation: 'never' } : options);
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
export {
  ProcessManager,
  buildOpenVpnArgs,
  buildWindowsCommandLine,
  getFreePort,
  quoteWindowsCommandLineArg,
  waitForTcpPort,
  type ProcessManagerLike,
  type SpawnedProcess,
} from '@ovpn-sdk/process';
export {
  AdapterManager,
  DEFAULT_SERVICE_PIPE,
  INTERACTIVE_SERVICE_NAME,
  OpenvpnServiceClient,
  OpenvpnServiceError,
  OpenvpnServiceProtocolError,
  OpenvpnServiceStartError,
  OpenvpnServiceUnavailableError,
  SERVICE_ERROR_OPENVPN_STARTUP,
  SERVICE_ERROR_STARTUP_DATA,
  ServiceOpenVpnProcess,
  decodeTapctl,
  describeServiceError,
  encodeStartupData,
  parseStartupResponse,
  readOpenvpnServiceSettings,
  type AdapterInfo,
  type AdapterManagerLike,
  type AdapterServiceMode,
  type OpenvpnServiceClientLike,
  type OpenvpnServiceClientOptions,
  type OpenvpnServiceLauncherLike,
  type OpenvpnServiceSettings,
  type OpenvpnStartOptions,
  type ServiceOpenVpnProcessLike,
  type TapctlOptions,
} from '@ovpn-sdk/tap';
export { ManagementClient, type ManagementClientOptions } from '@ovpn-sdk/core';
