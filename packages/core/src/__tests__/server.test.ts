import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClientEnvCollector,
  buildClientAuthNt,
  buildClientDeny,
  buildClientKill,
  buildClientPendingAuth,
  buildKillByCommonName,
  parseStatusText,
} from '../server.ts';

describe('ClientEnvCollector', () => {
  it('collects the ENV block that follows >CLIENT:CONNECT', () => {
    const c = new ClientEnvCollector();
    assert.equal(c.push('CLIENT', 'CONNECT,0,1'), null);
    assert.equal(c.push('CLIENT', 'ENV,common_name=alice'), null);
    assert.equal(c.push('CLIENT', 'ENV,untrusted_ip=10.0.0.2'), null);
    const event = c.push('CLIENT', 'ENV,END');
    assert.deepEqual(event, { type: 'connect-env', cid: 0, kid: 1, env: { common_name: 'alice', untrusted_ip: '10.0.0.2' } });
  });

  it('emits established/disconnect events', () => {
    const c = new ClientEnvCollector();
    assert.deepEqual(c.push('CLIENT', 'ESTABLISHED,0'), { type: 'established', cid: 0 });
    assert.deepEqual(c.push('CLIENT', 'DISCONNECT,0'), { type: 'disconnect', cid: 0 });
  });
});

describe('parseStatusText', () => {
  it('parses CLIENT_LIST and ROUTING_TABLE rows', () => {
    const text = [
      'TITLE,OpenVPN 2.8 x86_64-w64-mingw32 [SSL (OpenSSL)] [LZO] [LZ4] [PKCS11] [AEAD] [DCO]',
      'TIME,1715000000,2026-05-06 12:00:00',
      'HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID,Data Channel Cipher',
      'CLIENT_LIST,alice,10.0.0.2,10.8.0.6,,1234,5678,2026-05-06 12:00:00,1715000000,,0,1,CHACHA20-POLY1305',
      'HEADER,ROUTING_TABLE,Virtual Address,Common Name,Real Address,Last Ref,Last Ref (time_t)',
      'ROUTING_TABLE,10.8.0.0/24,alice,10.0.0.2,2026-05-06 12:00:00,1715000000',
      'GLOBAL_STATS,Max bcast/mcast queue length,0',
      'END',
    ].join('\n');
    const parsed = parseStatusText(text);
    assert.equal(parsed.clients.length, 1);
    assert.equal(parsed.clients[0]?.commonName, 'alice');
    assert.equal(parsed.clients[0]?.clientId, '0');
    assert.equal(parsed.routes.length, 1);
    assert.equal(parsed.routes[0]?.virtualAddress, '10.8.0.0/24');
  });
});

describe('server command builders', () => {
  it('builds auth/deny/pending/kill commands with escaping', () => {
    assert.equal(buildClientAuthNt(0, 1), 'client-auth-nt 0 1');
    assert.equal(buildClientDeny(0, 1, 'bad cert'), 'client-deny 0 1 "bad cert"');
    assert.equal(buildClientDeny(0, 1, 'bad cert', 'please retry'), 'client-deny 0 1 "bad cert" "please retry"');
    assert.equal(buildClientPendingAuth(0, 1, 'OPEN_URL:https://example.com', 60), 'client-pending-auth 0 1 OPEN_URL:https://example.com 60');
    assert.equal(buildClientKill(3), 'client-kill 3');
    assert.equal(buildClientKill(3, 'restart'), 'client-kill 3 restart');
    assert.equal(buildKillByCommonName('John Doe'), 'kill "John Doe"');
  });
});
