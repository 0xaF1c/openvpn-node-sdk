import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BinarySource = 'env' | 'explicit' | 'bundled' | 'platform-package' | 'install-dir' | 'path';

export interface ResolvedBinary {
  path: string;
  source: BinarySource;
  version?: string;
}

export interface BinaryManagerOptions {
  openvpnBinary?: string;
  tapctlBinary?: string;
  /** Explicit platform package specifier; defaults to @ovpn-sdk/openvpn-<platform>-<arch>. */
  platformPackage?: string;
  /** Reject a detected version that differs from this value. */
  expectedVersion?: string;
  /** Directory with the bundled binaries (`vendor/` of the single-package build). */
  vendorDir?: string;
  /** Injectable resolver (tests); defaults to import.meta.resolve. */
  platformResolver?: (specifier: string) => string | null;
  /** Injectable platform/arch (tests). */
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Parse `OpenVPN X.Y.Z` from `openvpn --version` output. */
export function parseOpenVpnVersion(output: string): string | null {
  const match = output.match(/^OpenVPN (\d+\.\d+\.\d+)/m);
  return match ? (match[1] ?? null) : null;
}

/** Map process.platform/arch to the platform-package npm naming scheme. */
export function getPlatformPackageName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const osName =
    platform === 'win32' ? 'win32' :
    platform === 'darwin' ? 'darwin' :
    platform === 'linux' ? 'linux' :
    platform;
  const cpuName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'ia32' : arch;
  return `@ovpn-sdk/openvpn-${osName}-${cpuName}`;
}

function defaultPlatformResolver(specifier: string): string | null {
  try {
    const url = import.meta.resolve(specifier);
    if (!url.startsWith('file:')) return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * `vendor/` of the single-package build. The compiled binary module lives at
 * `dist/<pkg>/src/index.js`, so walk up a few levels looking for
 * `vendor/openvpn.json` instead of assuming one fixed relative path.
 */
function defaultVendorDir(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = path.join(dir, 'vendor');
      if (existsSync(path.join(candidate, 'openvpn.json'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves OpenVPN / tapctl binaries in priority order:
 * explicit option -> environment variable -> bundled vendor directory ->
 * platform package -> platform-specific install directories -> PATH.
 */
export class BinaryManager {
  private readonly options: BinaryManagerOptions;
  private readonly platformResolver: (specifier: string) => string | null;
  private readonly vendorDir: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(options: BinaryManagerOptions = {}) {
    this.options = options;
    this.platformResolver = options.platformResolver ?? defaultPlatformResolver;
    this.vendorDir = options.vendorDir ?? defaultVendorDir();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  resolveOpenVpn(): ResolvedBinary {
    return this.resolve('openvpn.exe', 'openvpn', this.options.openvpnBinary, process.env.OPENVPN_BINARY);
  }

  resolveTapctl(): ResolvedBinary {
    if (this.platform !== 'win32') {
      throw new Error('tapctl is only available on Windows');
    }
    return this.resolve('tapctl.exe', 'tapctl.exe', this.options.tapctlBinary, process.env.TAPCTL_BINARY);
  }

  /** Run `<binary> --version` and return the parsed OpenVPN version (if any). */
  async detectVersion(binaryPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['--version'], { windowsHide: true, timeout: 10_000 });
      return parseOpenVpnVersion(stdout);
    } catch {
      return null;
    }
  }

  /** Verify that `<binaryPath> --version` reports exactly `expected`. */
  async verifyVersion(binaryPath: string, expected: string): Promise<string> {
    const actual = await this.detectVersion(binaryPath);
    if (actual === null) {
      throw new Error(`unable to read the OpenVPN version from ${binaryPath}`);
    }
    if (actual !== expected) {
      throw new Error(`expected OpenVPN ${expected} but ${binaryPath} reports ${actual}`);
    }
    return actual;
  }

  /**
   * Resolve a binary from a platform package, reading `openvpnVersion` from its
   * package.json so callers get the pinned version without spawning the binary.
   */
  private resolveFromPlatformPackage(platformPackage: string, exeName: string): ResolvedBinary | null {
    const manifestPath = this.platformResolver(`${platformPackage}/package.json`);
    if (!manifestPath) return null;

    let openvpnVersion: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(manifestPath, 'utf8')) as { openvpnVersion?: unknown };
      openvpnVersion = typeof meta.openvpnVersion === 'string' ? meta.openvpnVersion : undefined;
    } catch {
      return null;
    }

    if (openvpnVersion && this.options.expectedVersion && openvpnVersion !== this.options.expectedVersion) {
      throw new Error(
        `expected OpenVPN ${this.options.expectedVersion}, but platform package ${platformPackage} provides ${openvpnVersion}`,
      );
    }

    const bundled = path.join(path.dirname(manifestPath), 'bin', exeName);
    if (!existsSync(bundled)) return null;
    const resolved: ResolvedBinary = { path: bundled, source: 'platform-package' };
    if (openvpnVersion) resolved.version = openvpnVersion;
    return resolved;
  }

  /**
   * Resolve from the `vendor/` directory of the single-package build. The
   * bundled manifest records the pinned version, so nothing has to be spawned.
   */
  private resolveFromVendor(exeName: string): ResolvedBinary | null {
    if (!this.vendorDir) return null;
    const metaPath = path.join(this.vendorDir, 'openvpn.json');
    if (!existsSync(metaPath)) return null;

    let meta: { openvpnVersion?: string; platforms?: Record<string, { version?: string }> } = {};
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as typeof meta;
    } catch {
      return null;
    }

    const target = `${this.platform}-${this.arch}`;
    const info = meta.platforms?.[target];
    if (!info) return null;

    const version = info.version ?? meta.openvpnVersion;
    if (version && this.options.expectedVersion && version !== this.options.expectedVersion) {
      throw new Error(`expected OpenVPN ${this.options.expectedVersion}, but the bundled binaries provide ${version}`);
    }

    const bundled = path.join(this.vendorDir, `openvpn-${target}`, 'bin', exeName);
    if (!existsSync(bundled)) return null;
    const resolved: ResolvedBinary = { path: bundled, source: 'bundled' };
    if (version) resolved.version = version;
    return resolved;
  }

  private resolve(exeNameWin: string, exeNameOther: string, explicit?: string, envPath?: string): ResolvedBinary {
    const exeName = this.platform === 'win32' ? exeNameWin : exeNameOther;

    if (explicit && existsSync(explicit)) {
      return { path: explicit, source: 'explicit' };
    }
    if (envPath && existsSync(envPath)) {
      return { path: envPath, source: 'env' };
    }

    const fromVendor = this.resolveFromVendor(exeName);
    if (fromVendor) {
      return fromVendor;
    }

    const platformPackage = this.options.platformPackage ?? getPlatformPackageName(this.platform, this.arch);
    const fromPackage = this.resolveFromPlatformPackage(platformPackage, exeName);
    if (fromPackage) {
      return fromPackage;
    }

    // Legacy fallback: platform packages published before openvpnVersion metadata.
    const bundled = this.platformResolver(`${platformPackage}/bin/${exeName}`);
    if (bundled && existsSync(bundled)) {
      return { path: bundled, source: 'platform-package' };
    }

    for (const dir of this.installDirs()) {
      const candidate = path.join(dir, exeName);
      if (existsSync(candidate)) {
        return { path: candidate, source: 'install-dir' };
      }
    }

    const onPath = this.findOnPath(exeName);
    if (onPath) {
      return { path: onPath, source: 'path' };
    }

    throw new Error(
      `Unable to locate ${exeName}. Install OpenVPN (https://openvpn.net/community-downloads/) ` +
        `or set OPENVPN_BINARY/TAPCTL_BINARY.`,
    );
  }

  private installDirs(): string[] {
    if (this.platform === 'win32') {
      return [
        path.join(process.env.ProgramFiles ?? 'C:\Program Files', 'OpenVPN', 'bin'),
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\Program Files (x86)', 'OpenVPN', 'bin'),
      ];
    }
    if (this.platform === 'darwin') {
      return [
        '/opt/homebrew/sbin',
        '/opt/homebrew/bin',
        '/usr/local/sbin',
        '/usr/local/bin',
      ];
    }
    return [
      '/usr/local/sbin',
      '/usr/sbin',
      '/usr/bin',
      '/usr/local/bin',
      '/opt/openvpn/sbin',
    ];
  }

  private findOnPath(exeName: string): string | null {
    const PATH = process.env.PATH ?? '';
    for (const dir of PATH.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, exeName);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}
