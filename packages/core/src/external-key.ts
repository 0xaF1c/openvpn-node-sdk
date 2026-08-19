/**
 * External private-key / certificate support (management-external-key and
 * management-external-cert).
 *
 * Spec: .reference/openvpn/doc/management-notes.txt (COMMAND -- pk-sig /
 * rsa-sig / certificate).
 */

export interface PkSignRequest {
  /** Base64-encoded data to sign (as sent by OpenVPN). */
  base64Data: string;
  /** Raw decoded data to sign. */
  data: Buffer;
  /** Algorithm string, e.g. `RSA_PKCS1_PADDING`, `ECDSA`, `RSA_PKCS1_PSS_PADDING,...`. */
  algorithm: string | null;
}

export interface PkSignResponse {
  /** Command to send (`pk-sig` for version > 1, `rsa-sig` for legacy). */
  command: 'pk-sig' | 'rsa-sig';
  /** Base64 signature lines to send before `END`. */
  lines: string[];
}

/** Parse a `>PK_SIGN:...` / `>RSA_SIGN:...` notification payload. */
export function parsePkSignRequest(payload: string): PkSignRequest {
  const comma = payload.indexOf(',');
  const base64Data = comma === -1 ? payload : payload.slice(0, comma);
  const algorithm = comma === -1 ? null : payload.slice(comma + 1);
  return {
    base64Data,
    data: Buffer.from(base64Data, 'base64'),
    algorithm,
  };
}

/** Parse a `>NEED-CERTIFICATE:<hint>` notification payload. */
export function parseNeedCertificate(payload: string): string {
  return payload;
}

/** Build the `pk-sig` / `rsa-sig` multi-line response. */
export function buildPkSignResponse(signature: Buffer, legacy = false): PkSignResponse {
  return {
    command: legacy ? 'rsa-sig' : 'pk-sig',
    lines: splitBase64(signature.toString('base64'), 76),
  };
}

/** Split a base64 string into lines of `width` characters. */
export function splitBase64(value: string, width = 76): string[] {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) {
    lines.push(value.slice(i, i + width));
  }
  return lines.length > 0 ? lines : [''];
}
