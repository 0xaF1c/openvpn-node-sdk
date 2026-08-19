/**
 * Server-side management protocol helpers: `>CLIENT:` notifications,
 * `client-auth` / `client-deny` / `client-kill` command builders, and
 * `status` output parsing.
 */

export interface ClientEnvBlock {
  cid: number;
  kid: number;
  env: Record<string, string>;
  rawLines: string[];
}

export type ClientNotifyEvent =
  | { type: 'connect-env'; cid: number; kid: number; env: Record<string, string> }
  | { type: 'established'; cid: number }
  | { type: 'disconnect'; cid: number }
  | { type: 'address'; cid: number; address: string; pri: string }
  | { type: 'cr-response'; cid: number; kid: number; response: string };

/** Collect the multi-line `>CLIENT:ENV,...` block that follows `>CLIENT:CONNECT`. */
export class ClientEnvCollector {
  private pending: { cid: number; kid: number; env: Record<string, string>; raw: string[] } | null = null;

  push(kind: string, payload: string): ClientNotifyEvent | null {
    if (kind !== 'CLIENT') return null;
    if (payload.startsWith('CONNECT,')) {
      const parts = payload.split(',');
      const cid = Number(parts[1] ?? 0);
      const kid = Number(parts[2] ?? 0);
      this.pending = { cid, kid, env: {}, raw: [] };
      return null;
    }
    if (payload.startsWith('ENV,')) {
      const rest = payload.slice(4);
      if (rest === 'END') {
        const block = this.pending;
        this.pending = null;
        if (!block) return null;
        return { type: 'connect-env', cid: block.cid, kid: block.kid, env: block.env };
      }
      if (this.pending) {
        const idx = rest.indexOf('=');
        const key = idx >= 0 ? rest.slice(0, idx) : rest;
        const value = idx >= 0 ? rest.slice(idx + 1) : '';
        this.pending.env[key] = value;
        this.pending.raw.push(payload);
      }
      return null;
    }
    if (payload.startsWith('ESTABLISHED,')) {
      return { type: 'established', cid: Number(payload.split(',')[1] ?? 0) };
    }
    if (payload.startsWith('DISCONNECT,')) {
      return { type: 'disconnect', cid: Number(payload.split(',')[1] ?? 0) };
    }
    if (payload.startsWith('ADDRESS,')) {
      const parts = payload.split(',');
      return { type: 'address', cid: Number(parts[1] ?? 0), address: parts[2] ?? '', pri: parts[3] ?? '' };
    }
    if (payload.startsWith('CR_RESPONSE,')) {
      const parts = payload.split(',');
      return { type: 'cr-response', cid: Number(parts[1] ?? 0), kid: Number(parts[2] ?? 0), response: parts[3] ?? '' };
    }
    return null;
  }
}

export interface StatusClient {
  commonName: string;
  realAddress: string;
  virtualAddress: string;
  virtualIpv6Address: string;
  bytesReceived: string;
  bytesSent: string;
  connectedSince: string;
  connectedSinceTimeT: string;
  username: string;
  clientId: string;
  peerId: string;
  dataChannelCipher: string;
}

export interface StatusRoute {
  virtualAddress: string;
  commonName: string;
  realAddress: string;
  lastRef: string;
  lastRefTimeT: string;
}

export interface ParsedStatus {
  clients: StatusClient[];
  routes: StatusRoute[];
  raw: string;
}

/** Parse `status` / `status 3` command output (comma-separated tables). */
export function parseStatusText(text: string): ParsedStatus {
  const lines = text.split(/\r?\n/);
  const clients: StatusClient[] = [];
  const routes: StatusRoute[] = [];
  for (const line of lines) {
    if (line.startsWith('CLIENT_LIST,')) {
      const p = line.split(',');
      clients.push({
        commonName: p[1] ?? '',
        realAddress: p[2] ?? '',
        virtualAddress: p[3] ?? '',
        virtualIpv6Address: p[4] ?? '',
        bytesReceived: p[5] ?? '',
        bytesSent: p[6] ?? '',
        connectedSince: p[7] ?? '',
        connectedSinceTimeT: p[8] ?? '',
        username: p[9] ?? '',
        clientId: p[10] ?? '',
        peerId: p[11] ?? '',
        dataChannelCipher: p[12] ?? '',
      });
    } else if (line.startsWith('ROUTING_TABLE,')) {
      const p = line.split(',');
      routes.push({
        virtualAddress: p[1] ?? '',
        commonName: p[2] ?? '',
        realAddress: p[3] ?? '',
        lastRef: p[4] ?? '',
        lastRefTimeT: p[5] ?? '',
      });
    }
  }
  return { clients, routes, raw: text };
}

/** Build a `client-auth-nt CID KID` command (approve without config block). */
export function buildClientAuthNt(cid: number | string, kid: number | string): string {
  return `client-auth-nt ${cid} ${kid}`;
}

/** Build a `client-deny CID KID reason [client-reason]` command. */
export function buildClientDeny(
  cid: number | string,
  kid: number | string,
  reason: string,
  clientReason?: string,
): string {
  const escapedReason = escapeServerArg(reason);
  const base = `client-deny ${cid} ${kid} ${escapedReason}`;
  return clientReason !== undefined ? `${base} ${escapeServerArg(clientReason)}` : base;
}

/** Build a `client-pending-auth CID KID extra timeout` command. */
export function buildClientPendingAuth(
  cid: number | string,
  kid: number | string,
  extra: string,
  timeout: number | string,
): string {
  return `client-pending-auth ${cid} ${kid} ${escapeServerArg(extra)} ${timeout}`;
}

/** Build a `client-kill CID [message]` command. */
export function buildClientKill(cid: number | string, message?: string): string {
  return message !== undefined ? `client-kill ${cid} ${escapeServerArg(message)}` : `client-kill ${cid}`;
}

/** Build a `kill CN` command. */
export function buildKillByCommonName(commonName: string): string {
  return `kill ${escapeServerArg(commonName)}`;
}

function escapeServerArg(value: string): string {
  if (/[\s"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
