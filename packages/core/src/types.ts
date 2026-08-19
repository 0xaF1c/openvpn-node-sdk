/**
 * OpenVPN management-interface protocol types.
 *
 * Spec: .reference/openvpn/doc/management-notes.txt
 * Implementation: .reference/openvpn/src/openvpn/manage.c / manage.h
 */

/** Client-side tunnel states, as reported by `>STATE:` notifications. */
export const OVPN_STATES = [
  'CONNECTING',
  'WAIT',
  'AUTH',
  'GET_CONFIG',
  'ASSIGN_IP',
  'ADD_ROUTES',
  'CONNECTED',
  'RECONNECTING',
  'EXITING',
  'RESOLVE',
  'TCP_CONNECT',
  'AUTH_PENDING',
] as const;

export type OvpnStateName = (typeof OVPN_STATES)[number];

/** Parsed `>STATE:` notification payload (9 comma-separated fields). */
export interface OvpnState {
  timestamp: number;
  name: OvpnStateName;
  description: string;
  localIpv4: string;
  remoteHost: string;
  remotePort: string;
  localIp: string;
  localPort: string;
  localIpv6: string;
}

/** Log levels used by `>LOG:` notifications. */
export type OvpnLogLevel = 'I' | 'F' | 'N' | 'W' | 'D';

/** Parsed `>LOG:` notification payload. */
export interface OvpnLog {
  timestamp: number;
  level: OvpnLogLevel;
  text: string;
}

/** Parsed `>BYTECOUNT:` / `>BYTECOUNT_CLI:` notification payload. */
export interface OvpnByteCount {
  inBytes: number;
  outBytes: number;
}

/** A `>PASSWORD:` credential request (simplified initial version). */
export interface PasswordRequest {
  type: 'Auth' | 'Private Key' | 'Auth-Token' | string;
  message: string;
}

/** A classified management-interface output line. */
export type MgmtLine =
  | { type: 'notify'; kind: string; payload: string; raw: string }
  | { type: 'success'; text: string; raw: string }
  | { type: 'error'; text: string; raw: string }
  | { type: 'end'; raw: string }
  | { type: 'data'; text: string; raw: string };

/** Result of a command frame: optional success/error plus multi-line data body. */
export interface MgmtCommandResult {
  success?: string;
  error?: string;
  lines: string[];
}

/** Escape a single management-interface argument (OpenVPN config lexer rules). */
export function escapeArg(value: string): string {
  if (value === '') {
    return '""';
  }
  const BACKSLASH = String.fromCharCode(92);
  const needsQuotes = value.split('').some((ch) => ch === ' ' || ch === '	' || ch === '"' || ch === "'" || ch === BACKSLASH);
  if (!needsQuotes) {
    return value;
  }
  let out = '"';
  for (const ch of value) {
    if (ch === BACKSLASH || ch === '"') {
      out += BACKSLASH;
    }
    out += ch;
  }
  out += '"';
  return out;
}
