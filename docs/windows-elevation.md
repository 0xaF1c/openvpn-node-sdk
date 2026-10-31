# Windows elevation (UAC)

On Windows, creating a TAP/DCO adapter and running a real tunnel require
administrator rights. `tapctl.exe` even has a `requireAdministrator` manifest,
so an unelevated process cannot start it at all. The SDK therefore uses an
**on-demand elevated helper process** instead of the OpenVPN interactive
service:

1. when a privileged operation is needed, `ElevatedBroker` starts
   `node elevate-helper.mjs` through the platform elevation API
   (`Start-Process -Verb RunAs` on Windows, `osascript` on macOS, `pkexec` on
   Linux) — this is the consent prompt;
2. the helper runs as administrator and connects back to the parent over a
   loopback TCP socket protected by a random token;
3. `tapctl.exe` (adapter management) and `openvpn.exe` (the tunnel) run in the
   helper's elevated context; their stdout/stderr and exit codes are streamed
   back to the parent;
4. the helper exits when the parent disconnects and terminates any OpenVPN
   child process, so no elevated process is left behind.

Unlike `openvpnserv`, this is real elevation: the OpenVPN process runs with an
administrator token (`TokenElevation = 1`, high integrity) and can create
adapters, set routes/DNS and run privileged scripts by itself.

**One UAC prompt is shown per `connect()`** (more precisely, per
`ElevatedBroker` instance). The prompt appears the first time a privileged
operation is needed: adapter creation, or starting OpenVPN when adapter
management is disabled.

## Requirements

- Windows with UAC available. If the process is already elevated, no prompt is
  shown and the SDK spawns OpenVPN directly.
- Windows PowerShell 5.1+ (`powershell.exe`). It is present on every supported
  Windows version and is used to trigger the UAC prompt.
- macOS: `osascript` (part of the OS).
- Linux: `pkexec` (PolicyKit) and a running polkit authentication agent; without
  an agent, elevation fails with `ElevationUnavailableError`. `elevation:
  'never'` skips the helper.
- The user must be able to approve the UAC prompt (a member of the local
  `Administrators` group, or able to supply administrator credentials).
- `process.execPath` must be Node.js or Electron. Electron is detected
  automatically and the helper is started with `ELECTRON_RUN_AS_NODE=1`; a
  single-file packaged binary cannot be reused to run the helper.
- The helper entry file must be readable **as a real file** by the elevated
  process, so it cannot live inside `app.asar`; see
  [Where the helper lives](#where-the-helper-lives-bundlers-and-packaged-apps).
- A custom `elevateLauncher` runs the target itself and must set
  `ELECTRON_RUN_AS_NODE=1` when the target is Electron.
- Not usable from a Windows service or another session-0 process: there is no
  interactive desktop to show UAC. Run such a process elevated
  (`elevation: 'never'`) instead.

Check the environment:

```powershell
whoami /groups            # look for "Mandatory Label\High Mandatory Level"
where powershell.exe
```

## Where the helper lives (bundlers and packaged apps)

The helper is **a separate Node.js process**, so it must be a real file on disk
that the elevated process can read. The SDK looks for it in this order:

1. an explicit path (`elevationHelperPath` on `OpenVpnClient`, `helperPath` on
   `ElevatedBroker`) — no fallback, a missing file is an error;
2. `elevate-helper.mjs` / `.js` / `.ts` next to the running SDK module
   (`import.meta.url`);
3. `openvpn-node-sdk/elevate-helper` (or the package root) resolved with Node's
   resolver from the same module, which finds the installed package in
   `node_modules`.

Step 3 is what makes an installed SDK keep working when a bundler inlined it
into the host entry file: `import.meta.url` then points at the *host* bundle,
but Node's resolver still walks up to `node_modules` and finds
`openvpn-node-sdk/dist/tap/src/elevate-helper.mjs`.

`resolveElevationHelperPath()` exposes the same lookup so hosts can inspect the
result, log it, or pass it on:

```ts
import { resolveElevationHelperPath } from 'openvpn-node-sdk';

const helperPath = resolveElevationHelperPath(); // absolute path, throws when missing

const vpn = new OpenVpnClient(config, { elevationHelperPath: helperPath });
```

The package also publishes the helper as a subpath export, so any resolvable
context can find it without knowing the `dist/` layout:

```ts
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
const helperPath = requireFromHere.resolve('openvpn-node-sdk/elevate-helper');
// Node >= 20.6 also supports: import.meta.resolve('openvpn-node-sdk/elevate-helper')
```

### Vite / Rollup / esbuild (Electron main process)

A bundler that inlines the SDK (`externalizeDepsPlugin({ exclude: [...] })`,
`noExternal: [...]`, single-file builds) leaves no `elevate-helper.*` next to the
generated bundle, so the sibling lookup in step 2 cannot match. Two supported
options:

1. **Keep the SDK external.** With `externalizeDepsPlugin()` and its default
   excludes, the SDK is loaded from `node_modules` at runtime and step 3 finds
   the helper. This is the recommended setup because upgrades keep working.
2. **Pass the path explicitly.** Point at the installed helper (this works even
   when the SDK code itself is inlined):

   ```ts
   // electron main
   import { app } from 'electron';
   import { join } from 'node:path';

   const client = new OpenVpnClient(config, {
     elevation: 'auto',
     elevationHelperPath: join(
       app.getAppPath(),
       'node_modules/openvpn-node-sdk/dist/tap/src/elevate-helper.mjs',
     ),
   });
   ```

   If the packager prunes `node_modules`, ship the helper as an extra resource
   instead — it lands next to `app.asar`, so the elevated process can run it:

   ```yaml
   # electron-builder.yml
   extraResources:
     - from: node_modules/openvpn-node-sdk/dist/tap/src/elevate-helper.mjs
       to: elevate-helper.mjs
   ```

   ```ts
   import { join } from 'node:path';

   const client = new OpenVpnClient(config, {
     elevation: 'auto',
     elevationHelperPath: join(process.resourcesPath, 'elevate-helper.mjs'),
   });
   ```

   When the package is resolvable at runtime, `resolveElevationHelperPath()` is
   shorter and layout-independent:

   ```ts
   const client = new OpenVpnClient(config, { elevationHelperPath: resolveElevationHelperPath() });
   ```

### Electron packaging (`app.asar`)

An elevated child process cannot execute a file inside `app.asar`; it must be
`asarUnpack`ed:

```yaml
# electron-builder.yml
asarUnpack:
  - node_modules/openvpn-node-sdk/dist/tap/src/elevate-helper.mjs
```

The resolver maps `app.asar` → `app.asar.unpacked` automatically and throws
`ElevationUnavailableError` when only the archived copy exists. Prefer the
`.mjs` name: it is always parsed as an ES module, while an unpacked `.js` copy
without the package's `package.json` above it would be loaded as CommonJS and
crash inside the elevated process.

### A missing helper is a hard error

If none of the candidates exists, the broker fails immediately with
`ElevationUnavailableError` and lists every path it checked — instead of showing
a UAC prompt for a file that cannot start and then waiting the 120 s handshake
timeout with a message that never mentions the missing file.

## Branding the UAC prompt

Windows owns the consent dialog: its title ("User Account Control") and body
text cannot be changed. What you *can* control is the program identity —
**icon**, **program name** (`FileDescription`), **product name** and
**publisher** (Authenticode signer) — all taken from the executable that is
elevated. The default launcher elevates `node.exe`, so the prompt says
"Node.js" with the Node.js icon.

Build a small branded launcher and point the SDK at it:

```powershell
# Requires .NET Framework 4.x (csc.exe). Icon and signing are optional.
.\scripts\build-elevate-launcher.ps1 `
  -Title 'Acme VPN' -Product 'Acme VPN' -Company 'Acme Inc.' `
  -Icon .\assets\acme.ico -OutFile .\build\AcmeElevate.exe

# Recommended: sign it so UAC shows "Verified publisher: Acme Inc."
signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 .\build\AcmeElevate.exe
```

```ts
const vpn = new OpenVpnClient(config, {
  elevation: 'auto',
  elevateLauncher: 'C:\\build\\AcmeElevate.exe',
});
```

The launcher receives `<nodePath> <helperPath> --port … --token …` and runs
Node.js with the remaining arguments. Unsigned launchers show **Unknown
publisher** with a yellow UAC shield; sign them in CI with your code-signing
certificate. `elevateLauncher` is Windows-only and ignored on macOS/Linux, where
`osascript`/`pkexec` show their own prompt.

What cannot be customised: the dialog title, the "Do you want to allow this app
to make changes to your device?" text and the shield icon are rendered by
Windows. A pre-UAC splash/confirmation is an application concern; this SDK does
not add one.

## Other platforms

UAC is Windows-only. macOS uses `osascript ... with administrator privileges`;
Linux uses `pkexec`. Both run the same helper as root, so the rest of the
protocol (loopback token, streaming, cleanup) is identical.

| Platform | `isElevated()` | `elevation: 'auto'` | `elevation: 'always'` |
|---|---|---|---|
| Windows | `net session` succeeds | starts the UAC helper when not elevated | always uses the helper |
| Linux/macOS | uid 0 | starts the `pkexec`/`osascript` helper when not root | always uses the helper |
| other | `true` | `ElevationUnavailableError` | `ElevationUnavailableError` |

- Linux needs `pkexec` and a polkit authentication agent. macOS uses the
  built-in `osascript`. Run the process as root to skip the prompt entirely.
- Adapter management is Windows-only (`tapctl.exe`); on POSIX OpenVPN creates
  the tun/tap device itself.
- `elevateLauncher` is Windows-only. `ElevatedBroker` and `elevation` work on
  all three platforms; pass a custom `broker` (`ElevatedBrokerLike`) if you need
  a different privilege mechanism.
- The management interface is platform-neutral: TCP, or a unix socket via
  `managementSocketPath`.

## API

```ts
import { OpenVpnClient, OvpnConfig } from 'openvpn-node-sdk';

const vpn = new OpenVpnClient(config, {
  // 'auto' (default): elevate with UAC when the current process is not elevated
  // 'always': always use the elevated helper
  // 'never':  always spawn OpenVPN directly
  elevation: 'auto',
  // Only for bundled hosts / custom packaging; defaults to the SDK's own lookup:
  // elevationHelperPath: 'C:\\app\\resources\\app.asar.unpacked\\node_modules\\openvpn-node-sdk\\dist\\tap\\src\\elevate-helper.mjs',
});

await vpn.connect(); // UAC prompt (once), then an elevated openvpn.exe
```

If the user declines the prompt, `connect()` rejects with
`ElevationCancelledError` (a subclass of `ElevationError`), and any adapter or
profiles created during the attempt are cleaned up. If the helper file cannot be
found, `connect()` rejects with `ElevationUnavailableError` *before* the prompt.

`OpenVpnServer` defaults to `elevation: 'never'`: a server is normally started
by an elevated service or from an elevated shell, and it should not pop a UAC
prompt. Pass `elevation: 'auto'` to opt in.

### Manual broker use

`ElevatedBroker` is exported for custom launch code and for `AdapterManager`:

```ts
import { AdapterManager, ElevatedBroker } from 'openvpn-node-sdk';

const broker = new ElevatedBroker();
try {
  const adapters = new AdapterManager({
    // Runs tapctl as administrator; triggers the UAC prompt on first use.
    elevatedExec: (file, args) => broker.run(file, args),
  });
  const adapter = await adapters.ensure({ hwid: 'ovpn-dco' });

  // Start a privileged process and stream its output:
  const child = await broker.spawn('C:\\Program Files\\OpenVPN\\bin\\openvpn.exe', [
    '--config', 'C:\\tmp\\profile.ovpn',
  ]);
  child.on('exit', (code) => console.log('exit', code, child.getStderr()));
} finally {
  await broker.dispose();
}
```

`ElevatedBroker` options: `handshakeTimeoutMs` (default 120 s),
`commandTimeoutMs` (default 30 s), `helperPath` (defaults to
`resolveElevationHelperPath()`), `nodePath`, `launcherPath`, and `launch`
(injectable launcher, used by tests).

## Adapter creation

`tapctl.exe` has a `requireAdministrator` manifest, so an unelevated process
gets `CreateProcess` error 740 (Node reports a spawn `EACCES`). `AdapterManager`
maps that to win32 740 and re-runs `list`/`create`/`delete` through the
elevated runner. Because the helper is already elevated, the whole
`connect()` flow needs only the single prompt.

Service-created adapters are gone: the broker returns the real `tapctl` output,
so adapters have a GUID and a name, and `OpenVpnClient` can inject `dev-node`
when needed.

## Security notes

- The helper executes the SDK's own JavaScript with administrator rights. Like
  every Node.js package, install it in a directory only trusted users can
  modify (`node_modules` inside Program Files, or a protected prefix).
- The parent listens on `127.0.0.1` only, requires a random 128-bit token in
  the first message, and closes the listening socket after the helper
  handshakes. The token is also passed on the helper command line, which is
  readable by the same user's processes.
- The helper terminates its child processes when the parent disconnects, so a
  crashed SDK process does not leave an elevated OpenVPN behind.
- UAC is a security boundary: a user who can approve the prompt can already
  run anything as administrator. The broker does not bypass that.

## Troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| `ElevationCancelledError` / "prompt was cancelled" | The prompt was declined or could not be shown | Approve the prompt, or run the Node.js process from an elevated shell. |
| `ElevationUnavailableError` "cannot find the elevation helper" | The helper file is not next to the SDK module and the installed package is not resolvable (bundled build, pruned `node_modules`) | Pass `elevationHelperPath` (`helperPath` on a standalone broker), or call `resolveElevationHelperPath()` from an unbundled context. See [Where the helper lives](#where-the-helper-lives-bundlers-and-packaged-apps). |
| `ElevationUnavailableError` "is inside an app.asar archive" | The packager left the helper in `app.asar` | Add it to `asarUnpack` (prefer `.../dist/tap/src/elevate-helper.mjs`), or copy it outside the archive and pass its path. |
| `ElevationUnavailableError` "PowerShell ... not found" | `powershell.exe` is not available (Windows) | Use a normal Windows installation, or run the process elevated with `elevation: 'never'`. |
| `ElevationUnavailableError` "pkexec ... not found" / "no authentication agent" | PolicyKit is missing (Linux) | Install `pkexec` and a polkit agent, or run as root with `elevation: 'never'`. |
| "the elevated helper did not connect back within 120000ms (helper: …)" | The prompt stayed open too long, or the helper crashed after it started | Approve the prompt promptly; the message names the helper path — check that `node` can start it (a copy inside `app.asar` or a `.js` copy loaded as CommonJS would crash). |
| No prompt appears at all | The process is already elevated, `elevation: 'never'`, or the process runs at low integrity | Check `whoami /groups`; run the process from a normal (medium-integrity) shell. |
| UAC shows "Node.js" and the Node icon | The elevated executable is `node.exe` | Build a branded launcher and set `elevateLauncher` (see "Branding the UAC prompt"). |
| UAC shows "Unknown publisher" | The launcher is not Authenticode-signed | Sign the launcher with `signtool` in CI. |
| `connect()` from a service fails | Session 0 has no interactive desktop | Run the service as LocalSystem and use `elevation: 'never'`. |
| Adapter creation still fails with 740 | The elevated runner was not wired (standalone `AdapterManager`) | Pass `elevatedExec: (file, args) => broker.run(file, args)`. |

## Testing

Unit tests use a fake helper over a real loopback socket, so they need neither
UAC nor Windows:

```bash
npm test
```

For a live check with a real prompt:

```powershell
npm run playground:elevate              # report only, no prompt
npm run playground:elevate -- --test    # prompts for UAC and runs whoami /groups
```
