import type { MgmtCommandResult, MgmtLine, OvpnState, OvpnLog, OvpnByteCount } from './types.ts';

const NOTIFY_RE = /^>([A-Z][A-Z0-9_-]*):(.*)$/;
const SUCCESS_RE = /^SUCCESS:\s?(.*)$/;
const ERROR_RE = /^ERROR:\s?(.*)$/;

/** Incremental line splitter handling CRLF and LF. */
export class LineDecoder {
  #buffer = '';

  /** Push a chunk of text; returns the complete lines contained in it. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.#buffer.search(/\r\n|\n/)) !== -1) {
      lines.push(this.#buffer.slice(0, idx));
      this.#buffer = this.#buffer.slice(idx + (this.#buffer[idx] === '\r' ? 2 : 1));
    }
    return lines;
  }

  /** Drain any trailing partial line (may be empty). */
  drain(): string {
    const tail = this.#buffer;
    this.#buffer = '';
    return tail;
  }
}

/** Classify a raw management-interface line. */
export function classifyLine(raw: string): MgmtLine {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const notify = NOTIFY_RE.exec(trimmed);
  if (notify) {
    return { type: 'notify', kind: notify[1]!, payload: notify[2]!, raw: trimmed };
  }
  const success = SUCCESS_RE.exec(trimmed);
  if (success) {
    return { type: 'success', text: success[1]!, raw: trimmed };
  }
  const error = ERROR_RE.exec(trimmed);
  if (error) {
    return { type: 'error', text: error[1]!, raw: trimmed };
  }
  if (trimmed === 'END') {
    return { type: 'end', raw: trimmed };
  }
  return { type: 'data', text: trimmed, raw: trimmed };
}

/**
 * Assembles command frames. Management-interface responses may interleave
 * `SUCCESS:`/`ERROR:` with multi-line bodies terminated by `END`; asynchronous
 * `>TYPE:` notifications are passed to `onNotify`.
 *
 * Two completion modes:
 * - `end`: the frame completes when `END` arrives (multi-line commands).
 * - `single`: the frame completes on the first `SUCCESS:`/`ERROR:` line
 *   (commands such as `version 6`, `pid`, `state on`, `bytecount 1` that
 *   never emit `END`).
 */
export class FrameParser {
  #pending: { success?: string; error?: string; lines: string[] } | null = null;

  readonly onNotify: (line: Extract<MgmtLine, { type: 'notify' }>) => void;

  constructor(onNotify: (line: Extract<MgmtLine, { type: 'notify' }>) => void = () => {}) {
    this.onNotify = onNotify;
  }

  /** Feed one classified line, returns a command result when its frame completes. */
  push(line: MgmtLine, mode: 'end' | 'single' = 'end'): MgmtCommandResult | null {
    switch (line.type) {
      case 'notify':
        this.onNotify(line);
        return null;
      case 'success':
        this.#ensurePending();
        this.#pending!.success = line.text;
        if (mode === 'single') {
          return this.#takePending();
        }
        return null;
      case 'error':
        this.#ensurePending();
        this.#pending!.error = line.text;
        if (mode === 'single') {
          return this.#takePending();
        }
        return null;
      case 'data':
        this.#ensurePending();
        this.#pending!.lines.push(line.text);
        return null;
      case 'end': {
        return this.#takePending();
      }
    }
  }

  #takePending(): MgmtCommandResult {
    if (!this.#pending) {
      return { lines: [] };
    }
    const frame = this.#pending;
    this.#pending = null;
    return { success: frame.success, error: frame.error, lines: frame.lines };
  }

  #ensurePending(): void {
    this.#pending ??= { lines: [] };
  }

  get pending(): boolean {
    return this.#pending !== null;
  }
}

/** Parse a `>STATE:` payload. */
export function parseState(payload: string): OvpnState {
  const p = payload.split(',');
  return {
    timestamp: Number(p[0] ?? 0),
    name: (p[1] ?? 'CONNECTING') as OvpnState['name'],
    description: p[2] ?? '',
    localIpv4: p[3] ?? '',
    remoteHost: p[4] ?? '',
    remotePort: p[5] ?? '',
    localIp: p[6] ?? '',
    localPort: p[7] ?? '',
    localIpv6: p[8] ?? '',
  };
}

/** Parse a `>LOG:` payload. */
export function parseLog(payload: string): OvpnLog {
  const p = payload.split(',');
  return {
    timestamp: Number(p[0] ?? 0),
    level: (p[1] ?? 'I') as OvpnLog['level'],
    text: p.slice(2).join(','),
  };
}

/** Parse a `>BYTECOUNT:` payload. */
export function parseByteCount(payload: string): OvpnByteCount {
  const p = payload.split(',');
  return {
    inBytes: Number(p[0] ?? 0),
    outBytes: Number(p[1] ?? 0),
  };
}
