import { connect } from 'node:net';

/**
 * Minimal client for the OpenVPN interactive service
 * (`openvpnserv.exe`). The service runs elevated and exposes a named pipe
 * (`\.\pipe\openvpn\service`) with a binary message protocol defined in
 * `.reference/openvpn/include/openvpn-msg.h`.
 *
 * This gives non-admin processes a supported way to create TAP adapters:
 * send `msg_create_adapter`, read `msg_acknowledgement`.
 */

const BS = String.fromCharCode(92);
export const DEFAULT_SERVICE_PIPE = `${BS}${BS}.${BS}pipe${BS}openvpn${BS}service`;

export const MSG_ACKNOWLEDGEMENT = 0;
export const MSG_CREATE_ADAPTER = 20;

export type AdapterTypeValue = 0 | 1; // ADAPTER_TYPE_DCO / ADAPTER_TYPE_TAP

export interface ServiceMessageHeader {
  type: number;
  size: number;
  messageId: number;
}

/** Header size depends on sizeof(size_t): x64 24 bytes, x86 12 bytes. */
export function headerSize(arch: string = process.arch): number {
  return arch === 'x64' ? 24 : 12;
}

export function encodeHeader(header: ServiceMessageHeader, arch: string = process.arch): Buffer {
  const buf = Buffer.alloc(headerSize(arch));
  if (arch === 'x64') {
    buf.writeInt32LE(header.type, 0);
    buf.writeBigInt64LE(BigInt(header.size), 8);
    buf.writeInt32LE(header.messageId, 16);
  } else {
    buf.writeInt32LE(header.type, 0);
    buf.writeInt32LE(header.size, 4);
    buf.writeInt32LE(header.messageId, 8);
  }
  return buf;
}

export function decodeHeader(buf: Buffer, arch: string = process.arch): ServiceMessageHeader {
  if (arch === 'x64') {
    return {
      type: buf.readInt32LE(0),
      size: Number(buf.readBigInt64LE(8)),
      messageId: buf.readInt32LE(16),
    };
  }
  return {
    type: buf.readInt32LE(0),
    size: buf.readInt32LE(4),
    messageId: buf.readInt32LE(8),
  };
}

/** Encode a `msg_create_adapter` message. */
export function encodeCreateAdapterMessage(adapterType: AdapterTypeValue, messageId = 1, arch: string = process.arch): Buffer {
  const hs = headerSize(arch);
  const messageSize = arch === 'x64' ? hs + 8 : hs + 4;
  const buf = Buffer.alloc(messageSize);
  const header = encodeHeader({ type: MSG_CREATE_ADAPTER, size: messageSize, messageId }, arch);
  header.copy(buf, 0);
  if (arch === 'x64') {
    buf.writeInt32LE(adapterType, hs);
  } else {
    buf.writeInt32LE(adapterType, hs);
  }
  return buf;
}

/** Decode an `msg_acknowledgement` message. */
export function decodeAck(buf: Buffer, arch: string = process.arch): { header: ServiceMessageHeader; errorNumber: number } {
  const header = decodeHeader(buf, arch);
  const errorNumber = arch === 'x64' ? buf.readInt32LE(24) : buf.readInt32LE(12);
  return { header, errorNumber };
}

export interface OpenvpnServiceClientOptions {
  pipePath?: string;
  timeoutMs?: number;
}

/**
 * Synchronous request/response over the interactive-service named pipe.
 */
export class OpenvpnServiceClient {
  private readonly pipePath: string;
  private readonly timeoutMs: number;

  constructor(options: OpenvpnServiceClientOptions = {}) {
    this.pipePath = options.pipePath ?? DEFAULT_SERVICE_PIPE;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Ask the service to create a DCO (`0`) or TAP (`1`) adapter. Resolves to the Win32 error number. */
  createAdapter(adapterType: AdapterTypeValue, messageId = 1, arch: string = process.arch): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: this.pipePath });
      const request = encodeCreateAdapterMessage(adapterType, messageId, arch);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`openvpnserv did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      socket.once('connect', () => socket.write(request));
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      let received = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const hs = headerSize(arch);
        const ackSize = arch === 'x64' ? 32 : 16;
        if (received.length >= ackSize) {
          clearTimeout(timer);
          socket.destroy();
          const ack = decodeAck(received.subarray(0, ackSize), arch);
          resolve(ack.errorNumber);
        } else if (received.length >= hs) {
          // Wait for the rest of the fixed-size ack.
        }
      });
    });
  }
}

export type OpenvpnServiceClientLike = Pick<OpenvpnServiceClient, 'createAdapter'>;
