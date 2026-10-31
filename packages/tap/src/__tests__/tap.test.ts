import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterManager,
  TapctlError,
  decodeTapctl,
  parseAdapterList,
  parseWin32ErrorCode,
  type TapctlExec,
  type TapctlExecResult,
} from '../index.ts';

const BS = String.fromCharCode(92);
const ROOT_TAP = 'root' + BS + 'tap0901';
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

function wide(s: string): Buffer {
  return Buffer.from(s, 'utf16le');
}

interface Step {
  args: string[];
  result: TapctlExecResult;
}

function fakeExec(script: Step[]): { exec: TapctlExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TapctlExec = async (_binary, args) => {
    calls.push(args);
    const hit = script.find((s) => JSON.stringify(s.args) === JSON.stringify(args));
    if (hit) return hit.result;
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  return { exec, calls };
}

const ELEVATION_ERROR: TapctlExecResult = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 1,
  spawnError: 'EACCES',
};

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

describe('AdapterManager with injected exec', { skip: process.platform !== 'win32' && 'tapctl is Windows-only' }, () => {
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

  it('treats a tapctl spawn EACCES as win32 740', async () => {
    const { exec } = fakeExec([{ args: ['list'], result: ELEVATION_ERROR }]);
    const mgr = new AdapterManager({ exec });
    await assert.rejects(
      () => mgr.list(),
      (err: unknown) => {
        assert.ok(err instanceof TapctlError);
        assert.equal(err.win32Code, 0x2e4);
        assert.match(err.message, /requires elevation/);
        return true;
      },
    );
  });

  it('ensure re-runs list/create through elevatedExec when tapctl needs elevation', async () => {
    const local = fakeExec([
      { args: ['list'], result: ELEVATION_ERROR },
    ]);
    const elevatedCalls: string[][] = [];
    const elevatedExec: TapctlExec = async (_binary, args) => {
      elevatedCalls.push(args);
      if (args[0] === 'list') {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (args[0] === 'create') {
        return { stdout: wide('{elevated}' + TAB + 'elevated tap' + TAB + 'ovpn-dco' + NL), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const mgr = new AdapterManager({ exec: local.exec, elevatedExec });
    const adapter = await mgr.ensure({ hwid: 'ovpn-dco' });
    assert.equal(adapter?.guid, '{elevated}');
    assert.equal(adapter?.name, 'elevated tap');
    assert.deepEqual(elevatedCalls, [
      ['list'],
      ['create', '--hwid', 'ovpn-dco'],
    ]);
  });

  it('list falls back to elevatedExec on an elevation error', async () => {
    const local = fakeExec([{ args: ['list'], result: ELEVATION_ERROR }]);
    const elevatedCalls: string[][] = [];
    const elevatedExec: TapctlExec = async (_binary, args) => {
      elevatedCalls.push(args);
      return {
        stdout: wide('{elevated}' + TAB + 'elevated tap' + TAB + 'ovpn-dco' + NL),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    };
    const mgr = new AdapterManager({ exec: local.exec, elevatedExec });
    const adapters = await mgr.list();
    assert.equal(adapters[0]?.name, 'elevated tap');
    assert.deepEqual(elevatedCalls, [['list']]);
  });

  it('create falls back to elevatedExec on an elevation error', async () => {
    const local = fakeExec([{ args: ['create', '--hwid', 'ovpn-dco'], result: ELEVATION_ERROR }]);
    const elevatedCalls: string[][] = [];
    const elevatedExec: TapctlExec = async (_binary, args) => {
      elevatedCalls.push(args);
      return { stdout: wide('{admin}' + TAB + 'admin tap' + TAB + 'ovpn-dco' + NL), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const mgr = new AdapterManager({ exec: local.exec, elevatedExec });
    const adapter = await mgr.create({ hwid: 'ovpn-dco' });
    assert.equal(adapter.guid, '{admin}');
    assert.deepEqual(elevatedCalls, [['create', '--hwid', 'ovpn-dco']]);
  });

  it('delete and release fall back to elevatedExec', async () => {
    const local = fakeExec([{ args: ['delete', '{a}'], result: ELEVATION_ERROR }]);
    const elevatedCalls: string[][] = [];
    const elevatedExec: TapctlExec = async (_binary, args) => {
      elevatedCalls.push(args);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const mgr = new AdapterManager({ exec: local.exec, elevatedExec });
    await mgr.release('{a}');
    assert.deepEqual(elevatedCalls, [['delete', '{a}']]);
  });

  it('does not elevate when no elevatedExec is configured', async () => {
    const local = fakeExec([{ args: ['list'], result: ELEVATION_ERROR }]);
    const mgr = new AdapterManager({ exec: local.exec });
    await assert.rejects(() => mgr.ensure({ hwid: 'ovpn-dco' }), (err: unknown) => {
      assert.ok(err instanceof TapctlError);
      assert.equal(err.win32Code, 0x2e4);
      return true;
    });
  });

  it('surfaces reboot-required and win32 codes via TapctlError', async () => {
    const { exec } = fakeExec([
      { args: ['create', '--hwid', 'tap0901'], result: { stdout: Buffer.alloc(0), stderr: Buffer.from('error 0x20' + NL + 'A system reboot is required.' + NL), exitCode: 1 } },
    ]);
    const mgr = new AdapterManager({ exec });
    await assert.rejects(
      () => mgr.create({ hwid: 'tap0901' }),
      (err: unknown) => {
        assert.ok(err instanceof TapctlError);
        assert.equal(err.win32Code, 0x20);
        assert.equal(err.rebootRequired, true);
        return true;
      },
    );
  });

  it('isElevated uses `net session` through the injected exec', async () => {
    const { exec } = fakeExec([{ args: ['session'], result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 } }]);
    const mgr = new AdapterManager({ exec });
    assert.equal(await mgr.isElevated(), true);
  });
});

describe('AdapterManager on POSIX', { skip: process.platform === 'win32' && 'Windows adapter management' }, () => {
  it('never runs tapctl and reports no adapters', async () => {
    let called = false;
    const exec: TapctlExec = async () => {
      called = true;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const mgr = new AdapterManager({ exec, elevatedExec: exec });
    assert.deepEqual(await mgr.list(), []);
    assert.equal(await mgr.ensure(), null);
    assert.equal(await mgr.isElevated(), true);
    assert.equal(called, false);
  });
});
