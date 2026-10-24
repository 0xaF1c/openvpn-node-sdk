# Windows elevation through the OpenVPN interactive service

On Windows, opening a TAP/DCO adapter, configuring routes/DNS and running
OpenVPN normally requires an elevated token. OpenVPN ships a service,
`OpenVPNServiceInteractive` (`openvpnserv.exe`), that performs those operations
on behalf of a standard user. This SDK uses that service in two places:

- [`AdapterManager`](../packages/tap/src/index.ts) creates adapters when
  `tapctl.exe` returns win32 740 (elevation required);
- [`OpenVpnClient`](../packages/openvpn-sdk/src/index.ts) can start
  `openvpn.exe` under the service's elevated token, which is the part that
  makes a real tunnel work for a non-admin process.

`OpenVpnClient` does this automatically by default (`elevation: 'auto'`).
No UAC prompt is shown; the service either accepts the request or rejects it.

## Requirements

- OpenVPN 2.4 or newer installed on Windows, with the interactive service
  registered and running. Installing OpenVPN normally does this.
  - Process brokering (starting OpenVPN through the service) is available in
    2.4+.
  - Creating adapters through the service requires the newer
    `msg_create_adapter` message, added in OpenVPN 2.6. On older services that
    path returns the service's "unknown message type" error; use `tapctl` from
    an elevated process instead.
- The process using the SDK does **not** need to be elevated for
  `elevation: 'auto'`; for an elevated process the SDK spawns OpenVPN directly.
- The user must be allowed to use the service. The service checks its option
  whitelist and the profile location, and also accepts users in the
  `ovpn_admin_group` group (`OpenVPN Administrators` by default). A standard
  user who is not in that group may only use profiles under the service
  `config_dir`. On some systems the service also accepts members of the local
  `Administrators` group (including UAC-filtered tokens); the authoritative
  answer is always the service's response.
- The service runs the binary configured in the registry
  (`HKLM\SOFTWARE\OpenVPN\exe_path`). The SDK's `binary` option is ignored in
  service mode, and `BinaryManager.resolveOpenVpn()` is not called for a
  service-mode launch. Keep the installed OpenVPN and the SDK's pinned binaries
  in mind when diagnosing version-specific options.

Check the installation:

```powershell
sc query OpenVPNServiceInteractive
reg query "HKLM\SOFTWARE\OpenVPN"
```

The interesting registry values are:

| Value | Meaning |
|---|---|
| `exe_path` | OpenVPN binary the service starts (service mode ignores `binary`). |
| `config_dir` | Only directory accepted for `--config` when the user is not authorized. |
| `ovpn_admin_group` | Group that may use arbitrary profiles/options. |
| `bin_dir` | Directory containing the `tapctl.exe` the service runs. |
| `log_dir` | Default log directory used by OpenVPN service profiles. |

## How `OpenVpnClient` decides

`elevation` controls the strategy:

| Value | Behavior |
|---|---|
| `'auto'` (default) | On Windows, if the process is not elevated and the service pipe is reachable, start OpenVPN through the service. If the process is elevated or the service is unavailable, spawn directly. |
| `'service'` | Always start through the service. Fails if the service is not installed/running. |
| `'never'` | Always spawn directly. The service is still used for adapter creation if needed. |

`auto` asks `AdapterManager.isElevated()` whether the current process is
already elevated. If you inject a custom `adapterManager`, either implement
`isElevated()` or pass `options.isElevated`.

The default is `'auto'`, so this is enough on Windows:

```ts
import { OpenVpnClient, OvpnConfig } from 'openvpn-node-sdk';

const vpn = new OpenVpnClient(
  new OvpnConfig()
    .client()
    .remote('vpn.example.com', 1194, 'udp')
    .caInline(CA_PEM)
    .certInline(CERT_PEM)
    .keyInline(KEY_PEM),
);

await vpn.connect(); // through openvpnserv when non-elevated
```

`OpenVpnServer` defaults to `elevation: 'never'`: server profiles commonly use
options (such as `--management-client-auth`) that are not on the interactive
service whitelist.

### Profile location for non-admin users

The interactively started process gets an elevated token but only for the
options the service accepts. The service validates `--config` and, unless the
user is in `ovpn_admin_group`, requires the canonical config path to be inside
`config_dir` (typically `C:\Program Files\OpenVPN\config\`).

`OpenVpnClient` writes its generated profile to `%TEMP%` by default. That works
for elevated processes and for authorized users, but a standard user will get
`0x20000001` from the service. In that case:

1. give the user a writable directory below the service `config_dir` (an
   administrator creates it once), and pass it as `serviceConfigDir`; or
2. add the user to `OpenVPN Administrators`; or
3. run the process elevated with `elevation: 'never'`.

```ts
const vpn = new OpenVpnClient(config, {
  elevation: 'service',
  // Must be inside HKLM\SOFTWARE\OpenVPN\config_dir and writable by the user.
  serviceConfigDir: 'C:\\Program Files\\OpenVPN\\config\\sdk',
});
```

The SDK never writes into Program Files implicitly. If `serviceConfigDir`
cannot be created, `connect()` fails with a message explaining the requirement.
The generated profile is deleted when the client disconnects.

### Options that are rejected

For a non-authorized user the service only allows a whitelist of option names:
`auth-retry`, `config`, `log`, `log-append`, `management`,
`management-forget-disconnect`, `management-hold`,
`management-query-passwords`, `management-query-proxy`, `management-signal`,
`management-up-down`, `mute`, `setenv`, `service`, `verb`, `pull-filter`,
`script-security`.

Consequences in service mode:

- `registerDns: true` throws early because `--register-dns` is not on the
  whitelist. Put `register-dns` in the profile instead.
- Extra options in `extraArgs` may be rejected by the service; the error
  includes the service's validation message.
- The SDK adds `--log <temp>\openvpn-service.log` by default
  (`serviceLog: false` disables it). On a failed launch the tail of that log is
  appended to the error.

### Adapter creation

`AdapterManager` (`@ovpn-sdk/tap`) uses `tapctl.exe` when it can and falls back
to the service on win32 740. For a non-elevated process it also probes the
service first, so the common path is:

1. `tapctl list` — may itself require elevation;
2. if the service is needed, send `msg_create_adapter` with
   `ADAPTER_TYPE_DCO` (`0`) or `ADAPTER_TYPE_TAP` (`1`);
3. the service runs its own `tapctl.exe` as LocalSystem.

`serviceMode` controls this: `'auto'` (default), `'always'`, `'never'`.

The `msg_create_adapter` protocol has no name field, so a service-created
adapter has no name for `dev-node`; OpenVPN selects the first matching adapter.
Such adapters are marked `viaService: true` and may have an empty GUID/name.
The SDK does not pass `dev-node` for them and cannot delete them without
elevation, so they persist. When adapter listing works after creation, the
manager fills in the GUID/name and treats it as a normal adapter.

```ts
const adapter = await adapters.ensure({ hwid: 'ovpn-dco' });
if (adapter?.viaService) {
  // No dev-node was injected; OpenVPN will pick the first matching adapter.
}
```

## Low-level service client

`OpenvpnServiceClient` implements the pipe protocol directly and is useful for
diagnostics or custom launch code.

```ts
import {
  OpenvpnServiceClient,
  buildWindowsCommandLine,
  readOpenvpnServiceSettings,
} from 'openvpn-node-sdk';

const service = new OpenvpnServiceClient({ timeoutMs: 5000 });

if (!(await service.isAvailable())) {
  throw new Error('OpenVPNServiceInteractive is not running');
}

const settings = await readOpenvpnServiceSettings();
console.log(settings?.exePath, settings?.configDir, settings?.adminGroup);

// 0 = DCO, 1 = TAP
const win32Error = await service.createAdapter(0);
if (win32Error !== 0) throw new Error(`adapter creation failed: ${win32Error}`);

const child = await service.startOpenVpn({
  workingDirectory: process.cwd(),
  options: buildWindowsCommandLine([
    '--config', 'C:\\Program Files\\OpenVPN\\config\\my-profile.ovpn',
    '--management', '127.0.0.1', '5555',
    '--management-hold',
  ]),
  stdin: '',
});

console.log('OpenVPN pid:', child.pid);
child.on('control', (text) => console.log('service control:', text));
child.on('exit', (code) => {
  console.log('exit:', code, child.lastError);
});

// Later:
child.kill(); // terminates the process; the service closes the pipe
```

`startOpenVpn()`:

- returns after the service reports the new process id;
- keeps the control pipe open and emits `exit` when the service closes it;
- sets `lastError` from the service's exit error frame, if any;
- does **not** add `--msg-channel`; the service does that itself.

The exit code is best effort: a clean pipe close (including `EPIPE` /
`ECONNRESET` on the read side) is reported as `0`; a non-zero service error
frame is reported as `1` with `lastError` set. The service does not send an
exit code on a clean exit.

The service does not start a caller-supplied binary. It uses `exe_path` from the
registry, and its working directory is the `workingDirectory` argument. This is
also why `serviceConfigDir` matters: a relative `--config` is resolved by the
service against that working directory, but the canonical path still has to be
inside `config_dir` unless the user is authorized.

## Protocol notes

The pipe name is `\\.\pipe\openvpn\service`. Interactive-service messages are
native-endian structs from `include/openvpn-msg.h`:

```c
typedef struct {
    message_type_t type; /* msg_create_adapter = 20, msg_acknowledgement = 0, ... */
    size_t size;         /* 24-byte header on x64/arm64, 12-byte header on ia32 */
    int message_id;
} message_header_t;
```

An adapter request adds a 4-byte `adapter_type` after the header (the struct is
padded to 32 bytes on x64). The response is an `ack_message_t`
(`header + int error_number`, also padded to 32/16 bytes).

Starting OpenVPN is a text protocol on the same pipe:

```text
client -> service: UTF-16LE  "<workingDirectory>\0<options>\0<stdin>\0"
service -> client: UTF-16LE  "0x00000000\n0x00002a3c\nProcess ID"
```

The `options` string is parsed with `CommandLineToArgvW`; use
`buildWindowsCommandLine()` (or quote each argument with
`quoteWindowsCommandLineArg()`) rather than joining arguments manually. Errors
are returned as either:

```text
0x20000001\n<message>\n          // startup/config validation
0x20000000\nOpenVPN exited with error: exit code = 1\n
```

The service also accepts `stdin` data, which it writes to OpenVPN's stdin. The
SDK passes an empty string; credentials are handled through the management
interface.

## Errors and troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| `OpenvpnServiceUnavailableError` connecting to the pipe | Service not installed, not running, or access denied | `sc query OpenVPNServiceInteractive`; start/repair the OpenVPN installation. |
| `0x2e4` (740) from `tapctl` | Elevation required | Let `AdapterManager` fall back to the service, or run elevated. |
| `0x424` (1060) | Service not installed | Install OpenVPN; verify the service name. |
| `0x426` (1062) | Service not running | Start the service (`sc start OpenVPNServiceInteractive`, from an elevated shell). |
| `0x20000001` from `startOpenVpn` | Startup/config rejected | Use a profile under `config_dir`, pass `serviceConfigDir`, add the user to `OpenVPN Administrators`, or remove non-whitelisted options. |
| `0x20000000` from `startOpenVpn` | OpenVPN started but exited with an error | Read `lastError` and the log tail; common causes are an invalid profile, missing certificate, or a version-specific option. |
| `read EPIPE` / `ECONNRESET` | The service closed the control pipe (normal after exit) | Not a failure by itself; the exit code comes from the service's error frame. |
| `OpenVPN log (tail): ...` in `connect()` error | The SDK read `<temp>\openvpn-service.log` for you | Fix the reported OpenVPN error; the log path is temporary. |
| `registerDns` throws immediately | `--register-dns` is not whitelisted | Put `register-dns` in the profile or use `elevation: 'never'`. |

## Security notes

- The service runs as LocalSystem and impersonates the caller for validation.
  Only pass profiles you trust: a profile started through the service runs with
  elevated privileges and can execute scripts (`script-security`).
- The service's whitelist/config-dir checks are a security boundary. This SDK
  does not try to bypass them; `serviceConfigDir` only helps when an
  administrator has intentionally made a directory usable.
- Service-created adapters persist. They are not deleted automatically on
  disconnect unless adapter listing works and deletion is permitted.
- The SDK does not install or reconfigure the service. It uses the existing
  `exe_path` and `config_dir` from the registry.

## Testing

Unit tests use an in-memory pipe (see
`packages/tap/src/__tests__/openvpnserv.test.ts`) and do not require Windows:

```bash
npm test
```

For a live check on a machine with OpenVPN installed:

```powershell
sc query OpenVPNServiceInteractive
reg query "HKLM\SOFTWARE\OpenVPN"
node playground/scripts/adapters.mjs list
```

`playground:connect` also goes through the same `OpenVpnClient` path, so it is a
good end-to-end check when the current user is allowed to use the service.
