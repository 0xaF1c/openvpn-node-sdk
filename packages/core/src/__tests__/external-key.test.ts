import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPkSignResponse, parseNeedCertificate, parsePkSignRequest, splitBase64 } from '../external-key.ts';

describe('parsePkSignRequest', () => {
  it('parses payloads with and without algorithm', () => {
    const withAlg = parsePkSignRequest('aGVsbG8=,RSA_PKCS1_PADDING');
    assert.equal(withAlg.base64Data, 'aGVsbG8=');
    assert.equal(withAlg.data.toString(), 'hello');
    assert.equal(withAlg.algorithm, 'RSA_PKCS1_PADDING');

    const noAlg = parsePkSignRequest('aGVsbG8=');
    assert.equal(noAlg.algorithm, null);
    assert.equal(noAlg.data.toString(), 'hello');
  });

  it('keeps PSS algorithm params after the first comma', () => {
    const req = parsePkSignRequest('aGVsbG8=,RSA_PKCS1_PSS_PADDING,hashalg=SHA256,saltlen=digest');
    assert.equal(req.algorithm, 'RSA_PKCS1_PSS_PADDING,hashalg=SHA256,saltlen=digest');
  });
});

describe('parseNeedCertificate', () => {
  it('returns the hint', () => {
    assert.equal(parseNeedCertificate('macosx-keychain:subject:o=OpenVPN-TEST'), 'macosx-keychain:subject:o=OpenVPN-TEST');
  });
});

describe('buildPkSignResponse', () => {
  it('builds pk-sig response lines', () => {
    const sig = Buffer.from('hello world signature');
    const res = buildPkSignResponse(sig);
    assert.equal(res.command, 'pk-sig');
    assert.equal(res.lines.join(''), sig.toString('base64'));

    const legacy = buildPkSignResponse(sig, true);
    assert.equal(legacy.command, 'rsa-sig');
  });
});

describe('splitBase64', () => {
  it('splits base64 into fixed-width lines', () => {
    assert.deepEqual(splitBase64('abcdefgh', 3), ['abc', 'def', 'gh']);
    assert.deepEqual(splitBase64('', 76), ['']);
  });
});
