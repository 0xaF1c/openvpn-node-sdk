// Placeholder platform package. The real package will ship:
//   bin/openvpn.exe
//   bin/tapctl.exe
//   bin/*.dll (libcrypto/ssl, libpkcs11-helper, vcruntime140, ...)
// See .reports/openvpn-nodejs-sdk-feasibility.md section 2.1.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

function binaryPath(name) {
  const candidate = path.join(__dirname, 'bin', name);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `${candidate} is not present. This is a placeholder platform package; ` +
      `run the binary extraction script or install the real @ovpn-sdk/openvpn-win32-x64 package.`,
    );
  }
  return candidate;
}

module.exports = {
  openvpnPath: () => binaryPath('openvpn.exe'),
  tapctlPath: () => binaryPath('tapctl.exe'),
};
