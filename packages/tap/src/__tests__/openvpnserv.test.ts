import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SERVICE_PIPE,
  MSG_ACKNOWLEDGEMENT,
  MSG_CREATE_ADAPTER,
  decodeAck,
  decodeHeader,
  encodeCreateAdapterMessage,
  encodeHeader,
  headerSize,
} from '../openvpnserv.ts';

describe('openvpnserv pipe protocol', () => {
  it('computes x64/x86 header sizes', () => {
    assert.equal(headerSize('x64'), 24);
    assert.equal(headerSize('x86'), 12);
  });

  it('round-trips message headers', () => {
    for (const arch of ['x64', 'x86']) {
      const buf = encodeHeader({ type: MSG_CREATE_ADAPTER, size: arch === 'x64' ? 32 : 16, messageId: 42 }, arch);
      assert.equal(buf.length, headerSize(arch));
      const decoded = decodeHeader(buf, arch);
      assert.deepEqual(decoded, { type: MSG_CREATE_ADAPTER, size: arch === 'x64' ? 32 : 16, messageId: 42 });
    }
  });

  it('encodes create-adapter messages with the expected layout', () => {
    const msg = encodeCreateAdapterMessage(0, 7, 'x64');
    assert.equal(msg.length, 32);
    assert.equal(msg.readInt32LE(0), MSG_CREATE_ADAPTER);
    assert.equal(Number(msg.readBigInt64LE(8)), 32);
    assert.equal(msg.readInt32LE(16), 7);
    assert.equal(msg.readInt32LE(24), 0); // ADAPTER_TYPE_DCO

    const msg86 = encodeCreateAdapterMessage(1, 3, 'x86');
    assert.equal(msg86.length, 16);
    assert.equal(msg86.readInt32LE(0), MSG_CREATE_ADAPTER);
    assert.equal(msg86.readInt32LE(4), 16);
    assert.equal(msg86.readInt32LE(8), 3);
    assert.equal(msg86.readInt32LE(12), 1); // ADAPTER_TYPE_TAP
  });

  it('decodes ack messages', () => {
    const ack = Buffer.alloc(32);
    encodeHeader({ type: MSG_ACKNOWLEDGEMENT, size: 32, messageId: 9 }, 'x64').copy(ack, 0);
    ack.writeInt32LE(0x2e4, 24);
    const decoded = decodeAck(ack, 'x64');
    assert.equal(decoded.header.type, MSG_ACKNOWLEDGEMENT);
    assert.equal(decoded.errorNumber, 0x2e4);
  });

  it('defaults to the interactive-service pipe path', () => {
    assert.ok(DEFAULT_SERVICE_PIPE.endsWith('openvpn' + String.fromCharCode(92) + 'service'));
  });
});
