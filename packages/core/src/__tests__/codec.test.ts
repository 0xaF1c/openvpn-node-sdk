import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FrameParser, LineDecoder, classifyLine, parseByteCount, parseLog, parseState } from '../codec.ts';
import { escapeArg } from '../types.ts';

describe('LineDecoder', () => {
  it('splits LF and CRLF while preserving partial lines', () => {
    const dec = new LineDecoder();
    assert.deepEqual(dec.push('a\nb\r\nc'), ['a', 'b']);
    assert.equal(dec.drain(), 'c');
  });
});

describe('classifyLine', () => {
  it('classifies notify, success, error, end and data lines', () => {
    const notify = classifyLine('>STATE:1,CONNECTED,init,,,,,,');
    if (notify.type !== 'notify') throw new Error('expected notify line');
    assert.equal(notify.kind, 'STATE');
    assert.deepEqual(classifyLine('SUCCESS: ok'), { type: 'success', text: 'ok', raw: 'SUCCESS: ok' });
    assert.equal(classifyLine('ERROR: bad').type, 'error');
    assert.equal(classifyLine('END').type, 'end');
    assert.equal(classifyLine('OpenVPN CLIENT LIST').type, 'data');
  });
});

describe('FrameParser', () => {
  it('assembles a SUCCESS frame with a data body terminated by END', () => {
    const parser = new FrameParser();
    assert.equal(parser.push(classifyLine('SUCCESS: status')), null);
    assert.equal(parser.push(classifyLine('line1')), null);
    assert.deepEqual(parser.push(classifyLine('END')), {
      success: 'status',
      error: undefined,
      lines: ['line1'],
    });
    assert.equal(parser.pending, false);
  });

  it('routes notifications to the notify handler instead of the frame', () => {
    const seen: Array<[string, string]> = [];
    const parser = new FrameParser((n) => seen.push([n.kind, n.payload]));
    parser.push(classifyLine('>STATE:1,CONNECTED,init,,,,,,,'));
    parser.push(classifyLine('SUCCESS: pid'));
    assert.deepEqual(seen, [['STATE', '1,CONNECTED,init,,,,,,,']]);
  });
});

describe('payload parsers', () => {
  it('parses state/log/bytecount payloads', () => {
    assert.equal(parseState('1715000000,CONNECTED,init,10.8.0.6,1.2.3.4,1194,10.8.0.6,55555,fd00::1').name, 'CONNECTED');
    assert.equal(parseLog('1715000000,I,Initialization Sequence Completed').level, 'I');
    assert.deepEqual(parseByteCount('12345,6789'), { inBytes: 12345, outBytes: 6789 });
  });
});

describe('escapeArg', () => {
  it('quotes arguments containing spaces, quotes or backslashes', () => {
    const B = String.fromCharCode(92); // backslash
    assert.equal(escapeArg('plain'), 'plain');
    assert.equal(escapeArg('hello world'), '"hello world"');
    assert.equal(escapeArg('a"b'), '"a' + B + '"b"');
    assert.equal(escapeArg('a' + B + 'b'), '"a' + B + B + 'b"');
    assert.equal(escapeArg(''), '""');
  });
});

