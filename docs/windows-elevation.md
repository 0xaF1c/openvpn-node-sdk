# Windows elevation (UAC)

On Windows, creating a TAP/DCO adapter and running a real tunnel require
administrator rights. `tapctl.exe` even has a `requireAdministrator` manifest,
so an unelevated process cannot start it at all. The SDK therefore uses an
**on-demand elevated helper process** instead of the OpenVPN interactive
service:

1. when a privileged operation is needed, `ElevatedBroker` starts
   `node elevate-helper.js` through
   `powershell Start-Process -Verb RunAs` — this is the UAC prompt;
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
  Windows version.
- The user must be able to approve the UAC prompt (a member of the local
  `Administrators` group, or able to supply administrator credentials).
- `process.execPath` must be a real Node.js executable. A single-file packaged
  binary cannot be reused to run the helper.
- Not usable from a Windows service or another session-0 process: there is no
  interactive desktop to show UAC. Run such a process elevated
  (`elevation: 'never'`) instead.

Check the environment:

```powershell
whoami /groups            # look for "Mandatory Label\High Mandatory Level"
where powershell.exe
```

## API

```ts
import { OpenVpnClient, OvpnConfig } from 'openvpn-node-sdk';

const vpn = new OpenVpnClient(config, {
  // 'auto' (default): elevate with UAC when the current process is not elevated
  // 'always': always use the elevated helper
  // 'never':  always spawn OpenVPN directly
  elevation: 'auto',
});

await vpn.connect(); // UAC prompt (once), then an elevated openvpn.exe
```

If the user declines the prompt, `connect()` rejects with
`ElevationCancelledError` (a subclass of `ElevationError`), and any adapter or
profiles created during the attempt are cleaned up.

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
`commandTimeoutMs` (default 30 s), `helperPath`, `nodePath`, and `launch`
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
| `ElevationCancelledError` / "UAC prompt was cancelled" | The prompt was declined or PowerShell could not show it | Approve the prompt, or run the Node.js process from an elevated shell. |
| `ElevationUnavailableError` "PowerShell ... not found" | `powershell.exe` is not available | Use a normal Windows installation, or run the process elevated with `elevation: 'never'`. |
| "the elevated helper did not connect back within 120000ms" | The UAC prompt stayed open too long, or the helper crashed | Approve the prompt promptly; check that `node` can start `elevate-helper.js`. |
| No prompt appears at all | The process is already elevated, or `elevation: 'never'` | Check `whoami /groups`; see the `elevation` modes above. |
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
