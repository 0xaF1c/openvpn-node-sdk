/**
 * Elevated helper process for the Windows UAC elevation path.
 *
 * This file is spawned as an administrator by {@link ElevatedBroker} (via
 * `powershell Start-Process -Verb RunAs`) and connects back to the parent over
 * a loopback TCP socket. It executes the privileged commands the parent asks
 * for: `tapctl.exe` (adapter management) and `openvpn.exe` (the tunnel).
 *
 * The helper is deliberately dependency-free: it must be able to run from the
 * compiled `dist/` directory as a plain Node.js script.
 *
 * Protocol (newline-delimited JSON, both directions):
 *
 *   helper -> parent  {"event":"hello","token":"..."}
 *   parent -> helper  {"id":1,"op":"run","file":"...","args":[...],"cwd":"...","timeoutMs":30000}
 *   helper -> parent  {"id":1,"ok":true,"stdout":"<base64>","stderr":"<base64>","exitCode":0}
 *   parent -> helper  {"id":2,"op":"spawn","file":"...","args":[...],"cwd":"..."}
 *   helper -> parent  {"event":"spawned","id":2,"pid":1234}
 *   helper -> parent  {"event":"output","id":2,"stream":"stdout","data":"<base64>"}
 *   helper -> parent  {"event":"exit","id":2,"code":0,"signal":null}
 *   parent -> helper  {"id":3,"op":"kill","pid":1234}
 *   parent -> helper  {"id":4,"op":"shutdown"}
 *
 * The helper exits when the parent socket closes and terminates any OpenVPN
 * child processes it started, so no orphaned elevated processes are left
 * behind.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

interface HelperMessage {
  id?: number;
  op?: string;
  event?: string;
  file?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  pid?: number;
  force?: boolean;
  token?: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  error?: string;
  code?: number | null;
  signal?: string | null;
}

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (name !== undefined && value !== undefined && name.startsWith('--')) {
    flags.set(name.slice(2), value);
  }
}

const port = Number.parseInt(flags.get('port') ?? '', 10);
const token = flags.get('token') ?? '';
if (!Number.isInteger(port) || port <= 0 || token === '') {
  process.stderr.write('elevate-helper: missing --port/--token\n');
  process.exit(2);
}

const children = new Map<number, ChildProcess>();
const socket = connect({ host: '127.0.0.1', port });

function send(message: Record<string, unknown>): void {
  try {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  } catch {
    // The parent is gone; the close handler terminates the process.
  }
}

/** Kill a process tree. The helper is elevated, so it can kill the tunnel. */
function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {});
    killer.unref();
  } catch {
    // Fall through to the direct kill below.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function runCommand(message: HelperMessage): void {
  const id = message.id;
  const child = spawn(message.file ?? '', message.args ?? [], {
    cwd: message.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let finished = false;
  const finish = (reply: Record<string, unknown>): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    send({ id, ...reply });
  };

  const timer = setTimeout(() => {
    if (child.pid !== undefined) killTree(child.pid);
  }, message.timeoutMs ?? 30_000);
  timer.unref?.();

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.once('error', (err: Error) => finish({ ok: false, error: err.message }));
  child.once('close', (code: number | null) =>
    finish({
      ok: true,
      stdout: Buffer.concat(stdout).toString('base64'),
      stderr: Buffer.concat(stderr).toString('base64'),
      exitCode: code ?? 1,
    }),
  );
}

function spawnCommand(message: HelperMessage): void {
  const id = message.id ?? 0;
  const child = spawn(message.file ?? '', message.args ?? [], {
    cwd: message.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(id, child);

  child.once('error', (err: Error) => {
    children.delete(id);
    send({ event: 'start-error', id, error: err.message });
  });
  child.once('spawn', () => {
    send({ event: 'spawned', id, pid: child.pid ?? 0 });
  });
  child.stdout?.on('data', (chunk: Buffer) =>
    send({ event: 'output', id, stream: 'stdout', data: chunk.toString('base64') }),
  );
  child.stderr?.on('data', (chunk: Buffer) =>
    send({ event: 'output', id, stream: 'stderr', data: chunk.toString('base64') }),
  );
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    children.delete(id);
    send({ event: 'exit', id, code: code ?? null, signal: signal ?? null });
  });
}

function dispatch(message: HelperMessage): void {
  switch (message.op) {
    case 'run':
      runCommand(message);
      break;
    case 'spawn':
      spawnCommand(message);
      break;
    case 'kill':
      killTree(Number(message.pid));
      send({ id: message.id, ok: true });
      break;
    case 'shutdown':
      for (const child of children.values()) {
        if (child.pid !== undefined) killTree(child.pid);
      }
      send({ id: message.id, ok: true });
      setTimeout(() => process.exit(0), 100);
      break;
    default:
      send({ id: message.id, ok: false, error: `unknown operation ${String(message.op)}` });
      break;
  }
}

let buffer = '';
socket.on('connect', () => send({ event: 'hello', token }));
socket.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    try {
      dispatch(JSON.parse(line) as HelperMessage);
    } catch {
      // Ignore malformed commands; the parent will time out.
    }
  }
});
socket.on('error', () => process.exit(1));
socket.on('close', () => {
  for (const child of children.values()) {
    if (child.pid !== undefined) killTree(child.pid);
  }
  // Give taskkill a moment to start before the helper exits.
  setTimeout(() => process.exit(0), 200);
});

process.on('uncaughtException', () => process.exit(1));
