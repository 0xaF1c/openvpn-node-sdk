import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BinarySource = 'env' | 'explicit' | 'platform-package' | 'install-dir' | 'path';

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
 * Resolves OpenVPN / tapctl binaries in priority order:
 * explicit option -> environment variable -> bundled platform package ->
 * platform-specific install directories -> PATH.
 */
export class BinaryManager {
  private readonly options: BinaryManagerOptions;
  private readonly platformResolver: (specifier: string) => string | null;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(options: BinaryManagerOptions = {}) {
    this.options = options;
    this.platformResolver = options.platformResolver ?? defaultPlatformResolver;
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

  private resolve(exeNameWin: string, exeNameOther: string, explicit?: string, envPath?: string): ResolvedBinary {
    const exeName = this.platform === 'win32' ? exeNameWin : exeNameOther;

    if (explicit && existsSync(explicit)) {
      return { path: explicit, source: 'explicit' };
    }
    if (envPath && existsSync(envPath)) {
      return { path: envPath, source: 'env' };
    }

    const platformPackage = this.options.platformPackage ?? getPlatformPackageName(this.platform, this.arch);
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
