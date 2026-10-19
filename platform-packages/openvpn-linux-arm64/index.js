'use strict';

// OpenVPN 2.7.5 binaries for linux-arm64 (placeholder; run
// scripts/fetch-openvpn-binaries.mjs --platform linux-arm64 to populate bin/).

const path = require('node:path');
const fs = require('node:fs');

const openvpnVersion = '2.7.5';

function binaryPath(name) {
  const candidate = path.join(__dirname, 'bin', name);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      candidate + ' is not present. This is a placeholder platform package; ' +
      'run scripts/fetch-openvpn-binaries.mjs --platform linux-arm64 or install OpenVPN via the system package manager.',
    );
  }
  return candidate;
}

module.exports = {
  openvpnVersion,
  openvpnPath: () => binaryPath('openvpn'),
  tapctlPath: () => binaryPath('tapctl.exe'),
};
