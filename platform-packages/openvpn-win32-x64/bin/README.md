# OpenVPN 2.7.5 binaries (win32-x64)

Vendored release binaries. The pinned version and the authoritative file list live in
[`openvpn-binaries.json`](../../../openvpn-binaries.json).

Verify the contents against the manifest:

```bash
node scripts/fetch-openvpn-binaries.mjs --platform win32-x64 --verify-only
node scripts/verify-platform-packages.mjs --platform win32-x64
```

Files installed by the tooling:

- openvpn.exe
- tapctl.exe
- libcrypto-3-x64.dll
- libssl-3-x64.dll
- libpkcs11-helper-1.dll
- libopenvpn_plap.dll
- vcruntime140.dll
