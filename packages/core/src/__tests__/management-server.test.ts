import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, it } from 'node:test';
import { ManagementServer } from '../management-server.ts';

describe('ManagementServer', () => {
  it('accepts an OpenVPN management client and runs the init sequence', async () => {
    const server = new ManagementServer();
    const port = await server.start();

    const ready = new Promise<void>((resolve) => server.once('client-ready', resolve));
    const socket = connect({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== '');
      for (const line of lines) {
        if (line.startsWith('version 6')) socket.write('SUCCESS: Management client version set to 6\r\n');
        else if (line.startsWith('state on all')) socket.write('SUCCESS: real-time state notification set to ON\r\n1715000000,CONNECTING,init,,,,,,,\r\nEND\r\n');
        else if (line.startsWith('log on all')) socket.write('SUCCESS: real-time log notification set to ON\r\nEND\r\n');
        else if (line.startsWith('bytecount 1')) socket.write('SUCCESS: bytecount interval changed\r\n');
      }
    });

    socket.write('>INFO:OpenVPN Management Interface Version 6 -- type \'help\' for more info\r\n');
    await ready;

    assert.equal(server.clients.size, 1);
    const client = [...server.clients][0];
    assert.equal(client?.protocolVersion, 6);

    socket.destroy();
    await server.stop();
  });
});
