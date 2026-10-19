# bin/ placeholder

Populate this directory with an `openvpn` binary for darwin-x64:

```bash
node scripts/fetch-openvpn-binaries.mjs --platform darwin-x64 --source <dir|archive|url>
```

The pinned version and the expected files are declared in
[`openvpn-binaries.json`](../../../openvpn-binaries.json).
