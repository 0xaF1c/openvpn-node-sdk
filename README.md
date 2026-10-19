# openvpn-node-sdk

Node.js SDK for OpenVPN: binary distribution, management-interface control,
Windows tapctl adapter management, and server-side client-auth decisions.

## Installation

```bash
npm install openvpn-node-sdk
```

The tarball is self-contained: the JavaScript is compiled into `dist/` (no runtime
dependencies) and the pinned OpenVPN binaries for Windows x64 are vendored into the
same package. On other platforms the resolver falls back to a system OpenVPN install
and `PATH`.

## Quick start — client

```ts
import { OpenVpnClient, OvpnConfig } from 'openvpn-node-sdk';

const cfg = new OvpnConfig()
  .client()
  .remote('vpn.example.com', 1194, 'udp')
  .caInline(CA_PEM)
  .certInline(CERT_PEM)
  .keyInline(KEY_PEM);

const vpn = new OpenVpnClient(cfg, {
  credentials: async () => ({ username: 'alice', password: 'secret' }),
});

vpn.on('state', (s) => console.log(s.name, s.description));
vpn.on('bytecount', (b) => console.log(b.inBytes, b.outBytes));

await vpn.connect();
await vpn.waitFor('CONNECTED', 30_000);
await vpn.disconnect();
```

## Quick start — server

```ts
import { OpenVpnServer, OvpnConfig } from 'openvpn-node-sdk';

const cfg = new OvpnConfig().raw('server').raw('dev', 'tun').raw('topology', 'subnet');

const vpn = new OpenVpnServer(cfg);

vpn.on('client-connect', async ({ cid, kid, env }) => {
  console.log('client', env.common_name);
  await vpn.approveClient(cid, kid);
});

await vpn.connect();
await vpn.disconnect();
```

---

# API Reference

## `OpenVpnClient`

High-level OpenVPN client. Extends `EventEmitter`.

```ts
new OpenVpnClient(config: OvpnConfig | string, options?: OpenVpnClientOptions)
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `binary` | `string` | auto | Path to `openvpn.exe`/`openvpn`. |
| `tapctlBinary` | `string` | auto | Path to `tapctl.exe` (Windows). |
| `managementHost` | `string` | `'127.0.0.1'` | Management TCP host. |
| `managementPort` | `number` | `0` (auto) | Management TCP port. |
| `managementSocketPath` | `string` | — | POSIX: use a unix domain socket. |
| `credentials` | `() => Promise<OpenVpnCredentials>` | — | Auto-answer `>PASSWORD:Need 'Auth'`. |
| `signer` | `(req: PkSignRequest) => Promise<Buffer>` | — | External private-key signer. |
| `certificateProvider` | `(hint: string) => Promise<string>` | — | External cert provider, returns base64. |
| `manageAdapter` | `boolean` | `true` on win32 | Ensure a TAP adapter and inject `dev-node`. |
| `adapterHwid` | `'auto'` / `'ovpn-dco'` / `'root\\tap0901'` / `'tap0901'` | `'auto'` | Preferred adapter driver. |
| `connectTimeoutMs` | `number` | `15000` | Management socket wait timeout. |
| `disconnectTimeoutMs` | `number` | `5000` | Graceful shutdown timeout. |
| `registerDns` | `boolean` | `false` | Pass `--register-dns`. |
| `extraArgs` | `string[]` | — | Extra raw OpenVPN args. |
| `processManager` | `ProcessManagerLike` | `ProcessManager` | Injectable process manager. |
| `adapterManager` | `AdapterManagerLike` | `AdapterManager` | Injectable adapter manager. |

### Properties

| Member | Type | Description |
|---|---|---|
| `binaries` | `BinaryManager` | Binary resolver. |
| `adapters` | `AdapterManagerLike` | Adapter manager (Windows). |
| `currentState` | `OvpnState \| null` | Latest parsed `>STATE:` notification. |
| `states` | `OvpnState[]` | State history since connect. |

### Methods

| Method | Description |
|---|---|
| `connect(): Promise<void>` | Spawn OpenVPN, wait for the management socket, run the handshake. |
| `disconnect(): Promise<void>` | `signal SIGTERM` → wait for exit → force kill → cleanup. |
| `waitFor(state, timeoutMs?): Promise<void>` | Resolve when the tunnel reaches a state. |
| `sendManagement(cmd, opts?): Promise<MgmtCommandResult>` | Send a raw management command. |
| `submitCredentials(username, password): Promise<void>` | Answer a `>PASSWORD:Need 'Auth'` challenge. |
| `submitSignature(signature: Buffer, legacy?): void` | Answer `>PK_SIGN`/`>RSA_SIGN`. |
| `submitCertificate(certBase64: string): void` | Answer `>NEED-CERTIFICATE`. |

### Events

| Event | Payload | Description |
|---|---|---|
| `state` | `OvpnState` | Parsed `>STATE:` notification. |
| `log` | `OvpnLog` | Parsed `>LOG:` notification. |
| `bytecount` | `OvpnByteCount` | Parsed `>BYTECOUNT:` notification. |
| `notify` | `(kind, payload)` | Any management notification. |
| `password-request` | `string` | Raw `>PASSWORD:` payload. |
| `credentials-required` | `string` | Auth requested but no `credentials` provider set. |
| `auth-failed` | `string` | `Verification Failed` payload. |
| `signature-required` | `(PkSignRequest, legacy)` | Signature requested but no `signer` set. |
| `certificate-required` | `string` | Cert requested but no provider set. |
| `management-connected` | — | Management socket connected and initialized. |
| `process-exit` | `{ code, signal }` | OpenVPN process exited. |
| `disconnected` | — | Clean disconnect finished. |
| `error` | `Error` | Process/management errors. |

## `OpenVpnServer`

Server-side controller. Extends `OpenVpnClient`; add `--management-client-auth`
via `extraArgs` and listen for `client-connect`.

### Methods

| Method | Description |
|---|---|
| `approveClient(cid, kid, configLines?): Promise<MgmtCommandResult>` | Approve. With lines uses multi-line `client-auth`, otherwise `client-auth-nt`. |
| `denyClient(cid, kid, reason, clientReason?): Promise<MgmtCommandResult>` | Deny with log/client reason. |
| `pendingAuthClient(cid, kid, extra, timeout): Promise<MgmtCommandResult>` | Move to out-of-band pending auth. |
| `killClient(cid, message?): Promise<MgmtCommandResult>` | Kill a client by CID. |
| `killByCommonName(commonName): Promise<MgmtCommandResult>` | Kill all clients with a CN. |
| `getStatus(version?): Promise<ParsedStatus>` | Fetch and parse `status`. |

### Events

| Event | Payload |
|---|---|
| `client-connect` | `{ cid, kid, env }` after the `>CLIENT:ENV` block completes |
| `client-established` | `{ cid }` |
| `client-disconnect` | `{ cid }` |
| `client-address` | `{ cid, address, pri }` |
| `client-cr-response` | `{ cid, kid, response }` |

## `OvpnConfig`

Builder for `.ovpn` configuration text.

```ts
new OvpnConfig()
  .client()
  .remote(host, port, proto?)      // 'udp' | 'tcp'
  .proto('udp')
  .dev('tun')
  .devNode(name)
  .authUserPass()
  .caInline(pem)
  .certInline(pem)
  .keyInline(pem)
  .setenv(name, value)
  .raw(directive, value?)
  .toString(): string
  .writeTo(path): Promise<void>
```

Inline blocks use OpenVPN's `<ca>/<cert>/<key>` syntax.

## `BinaryManager`

Resolves `openvpn`/`tapctl` in priority order:

1. explicit option (`openvpnBinary`/`tapctlBinary`)
2. `OPENVPN_BINARY` / `TAPCTL_BINARY` environment variable
3. bundled `vendor/` directory of the single package (`vendor/openvpn-<platform>-<arch>/bin/...`)
4. platform package (`@ovpn-sdk/openvpn-<platform>-<arch>`, workspace development only)
5. platform install dirs (`Program Files\\OpenVPN\\bin`, Homebrew, `/usr/sbin`, etc.)
6. `PATH`

```ts
const mgr = new BinaryManager();
const openvpn = mgr.resolveOpenVpn();   // { path, source, version? } — source is 'bundled' when the packaged binaries are used
const tapctl = mgr.resolveTapctl();     // Windows only
const version = await mgr.detectVersion(openvpn.path); // spawns --version; '2.7.5' | null
await mgr.verifyVersion(openvpn.path, '2.7.5');        // throws unless the binary reports 2.7.5
```

`new BinaryManager({ expectedVersion: '2.7.5' })` makes `resolveOpenVpn()` throw when the
bundled binaries (or the platform package) pin a different OpenVPN version; explicit
paths and `OPENVPN_BINARY` bypass that check.

Exports: `getPlatformPackageName(platform?, arch?)`, `parseOpenVpnVersion(output)`.

## `AdapterManager` (Windows)

Wraps `tapctl.exe`.

| Method | Description |
|---|---|
| `list(hwid?): Promise<AdapterInfo[]>` | Enumerate adapters (`GUID/name/hwid`). |
| `create({ name?, hwid? }): Promise<AdapterInfo>` | Create an adapter. |
| `delete(guidOrName): Promise<void>` | Delete an adapter. |
| `ensure({ hwid? }): Promise<AdapterInfo | null>` | Reuse or create; falls back to `openvpnserv` on elevation error 740. |
| `release(guidOrName): Promise<void>` | Ref-counted release/delete. |
| `isElevated(): Promise<boolean>` | `net session` check. |

Exports: `decodeTapctl(buf)`, `parseAdapterList(text)`,
`parseWin32ErrorCode(stderr)`, `TapctlError`, `ERROR_ELEVATION_REQUIRED`.

## `OpenvpnServiceClient` (Windows)

Minimal client for the OpenVPN interactive service named pipe.
Used automatically by `AdapterManager.ensure()` when `tapctl` fails with
elevation error 740.

```ts
const svc = new OpenvpnServiceClient();
await svc.createAdapter(0); // 0 = DCO, 1 = TAP; resolves to Win32 error number
```

Exports protocol helpers: `encodeHeader`, `decodeHeader`,
`encodeCreateAdapterMessage`, `decodeAck`, `headerSize`.

## `ManagementClient` / `ManagementServer` (core)

Low-level management-interface transport.

```ts
const mgmt = new ManagementClient({ host: '127.0.0.1', port: 5555 });
await mgmt.connect();                    // waits for welcome, runs init sequence
const pid = await mgmt.send('pid');      // Promise<MgmtCommandResult>
await mgmt.sendMultiline('client-auth 0 1', ['push "route 10.0.0.0 255.0.0.0"']);
mgmt.writeMultiline('pk-sig', ['base64...']); // fire-and-forget (no response)
await mgmt.disconnect();
```

`ManagementServer` implements the `--management-client` reverse mode:

```ts
const server = new ManagementServer({ port: 5555 });
await server.start();
server.on('client-ready', (client) => console.log('OpenVPN connected'));
```

Events on `ManagementClient`: `notify`, `state`, `log`, `bytecount`,
`password-request`, `pk-sign`, `need-certificate`, `client`,
`command-result`, `initialized`, `welcome`, `close`, `error`.

## Protocol helpers (core)

| Export | Description |
|---|---|
| `LineDecoder` | Incremental CRLF/LF line splitter. |
| `classifyLine(raw)` | Classify a line as `notify`/`success`/`error`/`end`/`data`. |
| `FrameParser` | Assemble `SUCCESS`/`ERROR`/multi-line/`END` command frames. |
| `parseState`, `parseLog`, `parseByteCount` | Parse `>STATE:`, `>LOG:`, `>BYTECOUNT:` payloads. |
| `escapeArg(value)` | OpenVPN config-lexer quoting. |
| `inferExpect(command)` | Infer `single` vs `end` command response mode. |
| `ClientEnvCollector` | Collect `>CLIENT:ENV` blocks. |
| `parseStatusText(text)` | Parse `status` output into `{ clients, routes, raw }`. |
| `parsePkSignRequest(payload)` | Parse `>PK_SIGN`/`>RSA_SIGN` payload. |
| `buildPkSignResponse(sig, legacy?)` | Build `pk-sig`/`rsa-sig` multi-line response. |
| `splitBase64(value, width?)` | Split base64 into lines. |
| `parseNeedCertificate(hint)` | Parse `>NEED-CERTIFICATE` hint. |
| `buildClientDeny`, `buildClientPendingAuth`, `buildClientKill`, `buildKillByCommonName` | Server command builders. |

## Key types

| Type | Shape |
|---|---|
| `OvpnState` | `{ timestamp, name, description, localIpv4, remoteHost, remotePort, localIp, localPort, localIpv6 }` |
| `OvpnLog` | `{ timestamp, level: 'I'/'F'/'N'/'W'/'D', text }` |
| `OvpnByteCount` | `{ inBytes, outBytes }` |
| `MgmtCommandResult` | `{ success?, error?, lines: string[] }` |
| `PkSignRequest` | `{ base64Data, data: Buffer, algorithm: string | null }` |
| `AdapterInfo` | `{ guid, name, hwid, viaService? }` |
| `ResolvedBinary` | `{ path, source, version? }` |
| `ParsedStatus` | `{ clients: StatusClient[], routes: StatusRoute[], raw }` |
| `OpenVpnCredentials` | `{ username, password }` |

## Bundled OpenVPN binaries

[`openvpn-binaries.json`](openvpn-binaries.json) is the only place that pins the OpenVPN
release (`openvpn.version` + `openvpn.packaging`). `scripts/build-single.mjs` copies the
binaries of every platform whose manifest entry is `vendored` or `release` into
`vendor/openvpn-<target>/bin/` and records the version in `vendor/openvpn.json`;
`BinaryManager` reads that file, so the pinned version is known without spawning the
binary.

| Target | Contents | Status |
|---|---|---|
| `win32-x64` | `openvpn.exe`, `tapctl.exe`, runtime DLLs | vendored in `platform-packages/openvpn-win32-x64/bin` |
| `linux-x64` / `linux-arm64` | `openvpn` | pending — populate with `scripts/fetch-openvpn-binaries.mjs` |
| `darwin-x64` / `darwin-arm64` | `openvpn` | pending — populate with the fetch script or use Homebrew |

`platform-packages/*` stays in the repository as the staging area for the binaries and
their metadata, but it is no longer published as separate npm packages: they are baked
into the single `openvpn-node-sdk` tarball.

## Development

```bash
npm install              # install workspaces
npm run verify:packages  # check platform packages against openvpn-binaries.json
npm test                 # node --test (62 tests; real-binary smoke test skipped by default)
npm run typecheck        # tsc --noEmit
npm run build            # per-package tsc build (packages/*/dist)
npm run build:single     # bundled single package (dist + vendor) used for publishing
```

`npm` is the primary package manager (CI and `package-lock.json`). `pnpm install`
also works: [`pnpm-workspace.yaml`](pnpm-workspace.yaml) declares the workspaces and
enables `linkWorkspacePackages`, which pnpm 10+ needs in order to resolve the
`@ovpn-sdk/*` dependencies locally instead of looking them up in the registry.

### Publishing

`openvpn-node-sdk` is published as **one self-contained, unscoped package**: the
JavaScript of every workspace package is compiled into `dist/` and the pinned binaries
are vendored, so there are no runtime dependencies and no `@ovpn-sdk/*` packages to
publish.

```bash
npm run build:single                    # dist/ (JS + d.ts) and vendor/ binaries
node scripts/prepare-release.mjs        # main/types -> dist, files: ["dist","vendor"], deps: {}
npm run publish:packages -- --dry-run   # prints the npm command and the packed file list
npm run publish:packages -- --yes       # publish (requires `npm login`)
```

Accounts with 2FA mode `auth-and-writes` (`npm profile get`) must pass a one-time
password for the publish:

```bash
npm run publish:packages -- --yes --otp 123456
```

- The monorepo root is `private` and must not be published: its tarball is the whole
  repository and has no entry point.
- `prepare-release.mjs` rewrites `packages/openvpn-sdk/package.json` into the published
  shape; restore it afterwards with
  `git checkout -- packages/openvpn-sdk/package.json`.
- If the monorepo root was published by mistake, remove it within 72 hours:
  `npm unpublish openvpn-node-sdk-monorepo@<version>`.

### Pinned OpenVPN version

[`openvpn-binaries.json`](openvpn-binaries.json) is the only place that decides which
OpenVPN release ships. Changing it and re-running the tooling is the whole procedure:

```bash
# 1. bump openvpn.version / openvpn.packaging in openvpn-binaries.json
# 2. populate a platform package from a release archive, URL or local unpacked build
node scripts/fetch-openvpn-binaries.mjs --platform win32-x64 --source ./openvpn-2.7.6-win32-x64.tar.gz
# 3. verify the binaries and metadata
node scripts/verify-platform-packages.mjs             # --no-exec on cross-platform CI
# 4. rebuild the single package; vendor/openvpn.json picks up the new version
npm run build:single
```

`fetch-openvpn-binaries.mjs` verifies `sha256` for downloads, runs `<openvpn> --version`
and refuses to continue unless it matches the manifest. `build-single.mjs` then copies
the pinned binaries into `vendor/` and records the version there, so `BinaryManager`
reports `source: "bundled"` with the exact version. The runtime override is still
`OPENVPN_BINARY`.

### Running the quick start locally (before npm publish)

The package is not published yet; link it from this repo:

```bash
# 1. In this repository:
node scripts/link-local.mjs

# 2. In your test project:
npm link openvpn-node-sdk
```

Make sure your test project package.json has `"type": "module"` (the SDK is
ESM-only). Then `node index.js` from the quick-start examples works.

The published tarball is self-contained, so this local-link workflow is only needed to
develop against unreleased sources.

With pnpm, do not use a `file:` dependency: pnpm installs the dependencies of
`file:` links and will fail on the unpublished `@ovpn-sdk/*` packages. Use the
`link:` protocol instead, which symlinks the package and resolves its dependencies
from this repository:

```json
{ "dependencies": { "openvpn-node-sdk": "link:../openvpn/packages/openvpn-sdk" } }
```

Real-OpenVPN smoke test:

```bash
node scripts/smoke-test.mjs
# or enable the node:test version:
RUN_OPENVPN_SMOKE=1 npm test
```

Release preparation (see "Publishing" above for the full sequence):

```bash
npm run build:single
node scripts/prepare-release.mjs --dry-run
```

### Playground (manual end-to-end scenarios)

`playground/` contains consumer-style scripts that import the SDK by package
name and exercise it end to end, separately from the unit tests. Nothing needs
to be installed: resolution goes through the workspace `node_modules`.

```bash
npm run playground          # mock management server + fake process (offline)
npm run playground:offline  # check + config + mock, chained
npm run playground:check    # environment / resolution / API surface report
npm run playground:smoke    # real binary, dev-null config (--dry-run to preview)
npm run playground:connect -- --config <profile.ovpn>
npm run playground:adapters list        # Windows; needs an elevated shell
```

Offline scenarios run anywhere; the real-binary ones need an OpenVPN
installation (bundled on Windows x64) and an environment where spawning child
processes is allowed. See [`playground/README.md`](playground/README.md) for the
full matrix, exit codes and known behaviors.

## License

SDK package: MIT. Bundled OpenVPN binaries: GPL-2.0-only.
See `LICENSE` and the platform package READMEs.
