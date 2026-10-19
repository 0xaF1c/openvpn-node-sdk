/**
 * Shared helpers for the playground scenarios.
 *
 * Everything here is intentionally dependency-free and only uses the SDK's
 * public API, so the playground doubles as a consumer-side compatibility check.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_SKIP = 2;

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const dim = paint(2);
export const bold = paint(1);

/** Tiny `--flag value` / `--flag=value` / `--flag` parser. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        values.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        values.set(arg.slice(2), argv[i + 1]);
        i += 1;
      } else {
        flags.add(arg.slice(2));
      }
    } else {
      positional.push(arg);
    }
  }
  return {
    flags,
    positional,
    has: (name) => flags.has(name),
    get: (name, fallback) => values.get(name) ?? fallback,
  };
}

/** Collects check results and renders a PASS/FAIL/SKIP summary. */
export class Reporter {
  constructor(title) {
    this.title = title;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.warnings = 0;
    this.failures = [];
  }

  section(name) {
    console.log(`\n${bold(`== ${name}`)}`);
  }

  info(message) {
    console.log(`${dim('   ')}${message}`);
  }

  ok(message) {
    this.passed += 1;
    console.log(`${green('  PASS')} ${message}`);
  }

  warn(message) {
    this.warnings += 1;
    console.log(`${yellow('  WARN')} ${message}`);
  }

  skip(message) {
    this.skipped += 1;
    console.log(`${yellow('  SKIP')} ${message}`);
  }

  fail(message, detail) {
    this.failed += 1;
    this.failures.push(message);
    console.log(`${red('  FAIL')} ${message}`);
    if (detail) {
      for (const line of String(detail).split('\n')) {
        console.log(`${red('       ')} ${line}`);
      }
    }
  }

  /** Record a boolean expectation. */
  expect(condition, message, detail) {
    if (condition) {
      this.ok(message);
    } else {
      this.fail(message, detail);
    }
    return Boolean(condition);
  }

  /** Assert a thrown error is the one we expect. */
  async expectRejects(fn, pattern, message) {
    try {
      await fn();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return this.expect(pattern.test(text), message, text);
    }
    return this.expect(false, message, 'call did not throw');
  }

  summary() {
    console.log(
      `\n${bold(this.title)}: ${green(`${this.passed} passed`)}` +
        (this.skipped ? `, ${yellow(`${this.skipped} skipped`)}` : '') +
        (this.warnings ? `, ${yellow(`${this.warnings} warnings`)}` : '') +
        (this.failed ? `, ${red(`${this.failed} failed`)}` : ''),
    );
    if (this.failed === 0) {
      console.log(green('RESULT: PASS'));
      return EXIT_OK;
    }
    console.log(red(`RESULT: FAIL (${this.failures.join(' | ')})`));
    return EXIT_FAIL;
  }
}

/** Create a temp dir, run `fn(dir)`, and always clean it up (with a retry on Windows). */
export async function withTempDir(fn, prefix = 'ovpn-pg-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await removeDir(dir);
  }
}

export async function removeDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold a handle on a just-spawned config file.
    await sleep(150);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // OS temp cleanup reclaims it eventually.
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject after `ms` so no scenario can hang forever. */
export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for the next event of `name` (optionally filtered), with a timeout. */
export function onceEvent(emitter, name, timeoutMs = 10_000, filter = () => true) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (...args) => {
        if (!filter(...args)) return;
        emitter.removeListener(name, handler);
        resolve(args);
      };
      emitter.on(name, handler);
    }),
    timeoutMs,
    `event ${name}`,
  );
}

/** Poll `predicate` until it is truthy or the timeout expires. */
export async function waitForCondition(predicate, label, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function isSpawnBlocked(err) {
  const code = err?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'EPERM' || /\bEPERM\b/.test(message);
}

/**
 * Check whether this environment can spawn a child with piped stdio (the mode
 * `ProcessManager` uses). Avoids creating an OpenVpnClient - and therefore a
 * temp config directory - just to discover that spawning is blocked.
 * Returns 'ok' | 'blocked' | 'error'.
 */
export async function probeSpawn(binaryPath, timeoutMs = 5000) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve(isSpawnBlocked(err) ? 'blocked' : 'error');
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve('ok');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(isSpawnBlocked(err) ? 'blocked' : 'error');
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve('ok');
    });
    return undefined;
  });
}

export function spawnBlockedHint() {
  return [
    'spawn was blocked with EPERM.',
    'This happens under a confined sandbox/token guard (the same reason `npm test` skips the real-OpenVPN smoke test).',
    'Re-run this scenario from a normal (or elevated) PowerShell/cmd window.',
  ].join('\n');
}

/** Standard `SpawnedProcess`-shaped fake used to drive OpenVpnClient without spawning. */
export function createFakeProcessManager() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal ?? 'SIGTERM';
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, child.killedWith);
    }
    return true;
  };

  const state = {
    child,
    started: [],
    killTreeCalls: [],
    stdout: '',
    stderr: '',
  };

  const manager = {
    start(binary, args) {
      state.started.push({ binary, args });
      return child;
    },
    async killTree(pid) {
      state.killTreeCalls.push(pid);
      child.kill('SIGKILL');
    },
    getStdout: () => state.stdout,
    getStderr: () => state.stderr,
  };

  return { manager, ...state, child };
}

export function createFakeAdapterManager(adapter = { guid: '{fake-adapter-guid}', name: 'Playground TAP Adapter', hwid: 'ovpn-dco' }) {
  const calls = { ensure: [], released: [] };
  const manager = {
    async ensure(opts = {}) {
      calls.ensure.push(opts);
      return adapter;
    },
    async release(guidOrName) {
      calls.released.push(guidOrName);
    },
  };
  return { manager, calls, adapter };
}

/**
 * Resolve the OpenVPN/tapctl binaries without throwing, and report the source
 * and version. The version comes from the platform package metadata when it is
 * available, so confined sandboxes that block spawning piped stdio still see it.
 */
export async function resolveBinaries(BinaryManager, { tapctl = false } = {}) {
  const report = { openvpn: null, tapctl: null, errors: [], version: null, versionSource: null };
  try {
    const mgr = new BinaryManager();
    report.openvpn = mgr.resolveOpenVpn();
    if (report.openvpn.version) {
      report.version = report.openvpn.version;
      report.versionSource = 'platform-package metadata';
    } else {
      report.version = await mgr.detectVersion(report.openvpn.path);
      report.versionSource = report.version ? 'openvpn --version' : null;
    }
    if (tapctl && process.platform === 'win32') {
      try {
        report.tapctl = mgr.resolveTapctl();
      } catch (err) {
        report.errors.push(`tapctl: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }
  return report;
}
