import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterManager,
  TapctlError,
  decodeTapctl,
  parseAdapterList,
  parseWin32ErrorCode,
  type TapctlExecResult,
} from '../index.ts';

const BS = String.fromCharCode(92);
const ROOT_TAP = 'root' + BS + 'tap0901';
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

function wide(s: string): Buffer {
  return Buffer.from(s, 'utf16le');
}

function fakeExec(script: Array<{ args: string[]; result: TapctlExecResult }>): { exec: (binary: string, args: string[]) => Promise<TapctlExecResult>; calls: string[][] } {
  const calls: string[][] = [];
  const exec = async (binary: string, args: string[]): Promise<TapctlExecResult> => {
    calls.push(args);
    const hit = script.find((s) => JSON.stringify(s.args) === JSON.stringify(args));
    if (hit) return hit.result;
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  return { exec, calls };
}

describe('decodeTapctl', () => {
  it('decodes UTF-16LE wide output', () => {
    const decoded = decodeTapctl(wide('{GUID}' + TAB + 'My TAP' + TAB + 'ovpn-dco' + NL));
    assert.equal(decoded, '{GUID}' + TAB + 'My TAP' + TAB + 'ovpn-dco' + NL);
  });

  it('keeps narrow UTF-8 output', () => {
    const utf8 = Buffer.from('error 0x2e4' + NL, 'utf8');
    assert.equal(decodeTapctl(utf8), 'error 0x2e4' + NL);
  });
});

describe('parse helpers', () => {
  it('parses adapter list output', () => {
    const parsed = parseAdapterList('{a}' + TAB + 'name-one' + TAB + 'ovpn-dco' + NL + '{b}' + TAB + 'name two' + TAB + ROOT_TAP);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], { guid: '{a}', name: 'name-one', hwid: 'ovpn-dco' });
    assert.equal(parsed[1]?.name, 'name two');
  });

  it('extracts win32 error codes', () => {
    assert.equal(parseWin32ErrorCode('error 0x2e4' + NL), 0x2e4);
    assert.equal(parseWin32ErrorCode('no code'), null);
  });
});

describe('AdapterManager with injected exec', () => {
  it('list parses tapctl output', async () => {
    const { exec, calls } = fakeExec([
      { args: ['list'], result: { stdout: wide('{a}' + TAB + 'adapter' + TAB + 'tap0901' + NL), stderr: Buffer.alloc(0), exitCode: 0 } },
    ]);
    const mgr = new AdapterManager({ exec });
    const list = await mgr.list();
    assert.deepEqual(list, [{ guid: '{a}', name: 'adapter', hwid: 'tap0901' }]);
    assert.deepEqual(calls[0], ['list']);
  });

  it('ensure reuses an existing adapter', async () => {
    const { exec, calls } = fakeExec([
      { args: ['list'], result: { stdout: wide('{a}' + TAB + 'existing' + TAB + 'ovpn-dco' + NL), stderr: Buffer.alloc(0), exitCode: 0 } },
    ]);
    const mgr = new AdapterManager({ exec });
    const adapter = await mgr.ensure({ hwid: 'ovpn-dco' });
    assert.equal(adapter?.guid, '{a}');
    assert.equal(calls.filter((c) => c[0] === 'create').length, 0);
  });

  it('ensure creates an adapter and release deletes it', async () => {
    const { exec, calls } = fakeExec([
      { args: ['list'], result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 } },
      { args: ['create', '--hwid', 'ovpn-dco'], result: { stdout: wide('{new}' + TAB + 'created' + TAB + 'ovpn-dco' + NL), stderr: Buffer.alloc(0), exitCode: 0 } },
      { args: ['delete', '{new}'], result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 } },
    ]);
    const mgr = new AdapterManager({ exec });
    const adapter = await mgr.ensure({ hwid: 'ovpn-dco' });
    assert.equal(adapter?.guid, '{new}');
    await mgr.release('{new}');
    assert.deepEqual(calls[2], ['delete', '{new}']);
  });

  it('ensure falls back to tap0901 when ovpn-dco create fails', async () => {
    const { exec } = fakeExec([
      { args: ['list'], result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 } },
      { args: ['create', '--hwid', 'ovpn-dco'], result: { stdout: Buffer.alloc(0), stderr: Buffer.from('error 0xe000020b' + NL), exitCode: 1 } },
      { args: ['create', '--hwid', ROOT_TAP], result: { stdout: wide('{b}' + TAB + 'fallback' + TAB + ROOT_TAP + NL), stderr: Buffer.alloc(0), exitCode: 0 } },
    ]);
    const mgr = new AdapterManager({ exec });
    const adapter = await mgr.ensure();
    assert.equal(adapter?.hwid, ROOT_TAP);
  });

  it('ensure falls back to openvpnserv when tapctl needs elevation (740)', async () => {
    const { exec } = fakeExec([
      { args: ['list'], result: { stdout: Buffer.alloc(0), stderr: Buffer.from('error 0x2e4' + NL), exitCode: 1 } },
      { args: ['create', '--hwid', 'ovpn-dco'], result: { stdout: Buffer.alloc(0), stderr: Buffer.from('error 0x2e4' + NL), exitCode: 1 } },
    ]);
    const serviceClient = {
      calls: [] as number[],
      async createAdapter(adapterType: number): Promise<number> {
        this.calls.push(adapterType);
        return 0;
      },
    };
    const mgr = new AdapterManager({ exec, serviceClient });
    const adapter = await mgr.ensure({ hwid: 'ovpn-dco' });
    assert.equal(adapter?.viaService, true);
    assert.equal(adapter?.hwid, 'ovpn-dco');
    assert.deepEqual(serviceClient.calls, [0]);
  });

  it('surfaces reboot-required and win32 codes via TapctlError', async () => {
    const { exec } = fakeExec([
      { args: ['create', '--hwid', 'tap0901'], result: { stdout: Buffer.alloc(0), stderr: Buffer.from('error 0x2e4' + NL + 'A system reboot is required.' + NL), exitCode: 1 } },
    ]);
    const mgr = new AdapterManager({ exec });
    await assert.rejects(
      () => mgr.create({ hwid: 'tap0901' }),
      (err: unknown) => {
        assert.ok(err instanceof TapctlError);
        assert.equal(err.win32Code, 0x2e4);
        assert.equal(err.rebootRequired, true);
        return true;
      },
    );
  });
});
