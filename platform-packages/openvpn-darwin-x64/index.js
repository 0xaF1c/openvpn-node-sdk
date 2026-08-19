'use strict';

const path = require('node:path');
const fs = require('node:fs');

function binaryPath(name) {
  const candidate = path.join(__dirname, 'bin', name);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      candidate + ' is not present. This is a placeholder platform package; ' +
      'populate bin/ from your package manager or OpenVPN build.',
    );
  }
  return candidate;
}

module.exports = {
  openvpnPath: () => binaryPath('openvpn'),
  tapctlPath: () => binaryPath('tapctl.exe'),
};
