# Playground

Manual, consumer-style scenarios for `openvpn-node-sdk`. Unlike `npm test`
(unit tests that run inside the workspace), these scripts import the SDK by
package name — `import { OpenVpnClient } from 'openvpn-node-sdk'` — so they also
prove that package resolution and the public surface work from a normal project.

No install step is needed: `node_modules/openvpn-node-sdk` is already linked to
`packages/openvpn-sdk` by the monorepo workspaces. (Running `npm install` inside
this folder is pointless — the scripts resolve packages from the repo root.)

## Scenarios

| Command | Real OpenVPN | Admin | What it does |
|---|---|---|---|
| `npm run playground` | no | no | Mock management server + fake process: spawn args, init sequence, state/log/bytecount, credential challenge, pk-sig, adapter injection, clean disconnect, plus server-side approve/deny/kill/status. |
| `npm run playground:check` | no | no | Environment self-check: node/platform, package resolution, public API surface, binary sources, bundled platform package, argv preview, config builder. |
| `npm run playground:config` | no | no | Build a client `.ovpn` (inline CA/cert/key) and write it to disk (`--out <path>` keeps it). |
| `npm run playground:smoke` | yes | no | Spawn the real binary with a throwaway `dev null` config, release `--management-hold`, confirm a state notification and a `pid` round trip, then disconnect. `--dry-run` prints the config/argv without spawning. |
| `npm run playground:connect` | yes | Windows: usually | Bring up a real tunnel from your own profile: `-- --config <profile.ovpn> [--user u] [--pass p]`. |
| `npm run playground:adapters` | yes (`tapctl`) | Windows: yes for create/delete | `list` / `ensure [--hwid auto|ovpn-dco|tap0901]` / `release <guid-or-name>`. |

`npm run playground:offline` chains the three offline scenarios (`check`,
`config`, `mock`).

## Requirements

- Node.js >= 22.18 (the SDK loads TypeScript sources via type stripping).
- `playground:smoke` / `playground:connect` need an OpenVPN binary; the Windows
  x64 platform package in this repo already bundles one (2.7.5). Otherwise set
  `OPENVPN_BINARY` (and `TAPCTL_BINARY` for adapters).
- `playground:connect` on Windows needs an elevated shell or the OpenVPN
  interactive service, unless the profile uses `dev null`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every assertion passed |
| 1 | an assertion failed (details are printed above the summary) |
| 2 | the environment cannot run the scenario (not Windows, no binary, spawn blocked, missing `--config`, missing adapter target) |

## Known behaviors worth knowing

- The client passes `--management-hold` but never releases it. `playground:smoke`
  sends `hold release` explicitly; a real `connect()` flow must do the same (see
  `client.sendManagement('hold release')`).
- `AdapterManager` spawns `tapctl.exe` from `PATH` unless you pass a binary. The
  adapters scenario resolves it through `BinaryManager.resolveTapctl()` first.
- In confined sandboxes (and some CI runners) spawning a child with piped stdio
  fails with `EPERM`. The scenarios detect this and exit with code 2 instead of
  reporting a failure.

## Adding a scenario

Drop a `.mjs` file in `scripts/`, import from `openvpn-node-sdk` plus the helpers
in `scripts/lib.mjs` (`Reporter`, `parseArgs`, `onceEvent`, `withTempDir`,
`createFakeProcessManager`, `createFakeAdapterManager`), return
`reporter.summary()` as the exit code, and register the command in both
`playground/package.json` and the root `package.json`.
