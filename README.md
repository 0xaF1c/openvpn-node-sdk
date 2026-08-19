# openvpn-node-sdk

Node.js SDK for OpenVPN: binary distribution, management-interface control and Windows tapctl adapter management.

## Status

Skeleton initialized. See `.reports/openvpn-nodejs-sdk-feasibility.md` for the full feasibility study and
`.reports/openvpn-nodejs-sdk-report.md` for the OpenVPN management-protocol deep dive.

The original OpenVPN 2.8-dev source tree is kept under `.reference/openvpn/` for reference.

## Workspaces

| Package | Description |
|---|---|
| `@ovpn-sdk/core` | Management-interface protocol codec and client, mock server for tests |
| `@ovpn-sdk/process` | Spawn and supervise the `openvpn` process |
| `@ovpn-sdk/config` | Object-model to `.ovpn` config generator |
| `@ovpn-sdk/tap` | Windows `tapctl.exe` adapter management |
| `@ovpn-sdk/binary` | Binary resolution / platform package lookup |
| `openvpn-node-sdk` | High-level facade (`OpenVpnClient`) |
| `@ovpn-sdk/openvpn-win32-x64` | Windows x64 binary platform package (placeholder) |

## Commands

```bash
npm install
npm test
npm run typecheck
npm run build          # compile packages/*/src -> packages/*/dist
```

Release preparation (points packages at `dist/` and adds `os`/`cpu` to
platform packages):

```bash
node scripts/prepare-release.mjs --dry-run
node scripts/prepare-release.mjs
```

Real-OpenVPN smoke test (spawns the actual binary with a throwaway
`dev null` config; needs an environment where process spawn is allowed —
on Windows run from an elevated PowerShell/cmd, or set `RUN_OPENVPN_SMOKE=1`
for the node:test version):

```bash
node scripts/smoke-test.mjs
# or
RUN_OPENVPN_SMOKE=1 npm test
```

## Binary extraction (Windows x64)

The platform package `@ovpn-sdk/openvpn-win32-x64` ships the OpenVPN binaries
required by the SDK. To rebuild it from a local OpenVPN installation:

```bash
node scripts/extract-openvpn-binaries.mjs
# or with explicit paths:
node scripts/extract-openvpn-binaries.mjs "C:\Program Files\OpenVPN\bin" platform-packages/openvpn-win32-x64/bin
```

The script copies every `.exe` and `.dll` from the source directory and
verifies `openvpn.exe` / `tapctl.exe` are present. See
`.reports/openvpn-nodejs-sdk-feasibility.md` §2.1 for the licensing notes
(OpenVPN is GPLv2; bundling its binaries carries source-offering obligations).

## Cross-platform notes

- `BinaryManager` selects a platform package named
  `@ovpn-sdk/openvpn-<platform>-<arch>` (win32/darwin/linux × x64/arm64/ia32),
  then falls back to platform-specific install dirs and `PATH`.
- On Linux/macOS the SDK can use a unix domain socket for the management
  interface: pass `managementSocketPath` to `OpenVpnClient`, or
  `socketPath` to `ManagementClient`. OpenVPN itself is launched with
  `--management <socket> unix`.
- `AdapterManager` is Windows-only; on Linux/macOS `ensure()` returns `null`
  and `OpenVpnClient` skips `dev-node` injection (the OS kernel provides
  `/dev/net/tun` or `utun` devices).
