# Hypermesh for VS Code

The **Hypermesh: smoke** command sends one short completion to the configured chat
host. Configure `hypermesh.apiBase` (default `https://chat.test.hyperme.sh`) and
`hypermesh.tenant`. The renter key is prompted once and stored in VS Code
SecretStorage as `hypermesh.key`; it is not a workspace setting.

## Build and check

Requires Node.js 24 and Python 3 for archive/provenance verification:

```sh
npm ci --ignore-scripts
npm run check
```

The check verifies retained source hashes, runs the existing seven headless tests,
builds `dist/hypermesh-vscode.vsix`, verifies its file allowlist and runtime bytes,
and runs those same tests against the unpacked VSIX outside the repository.
Tests use a loopback HTTP server and fixture credentials. They never contact the
configured test plane. An interactive VS Code extension-host test remains separate.

The VSIX contains the extension manifest, README, Apache-2.0 license and two runtime JavaScript files.
It excludes tests, developer tooling, provenance records and dependencies. The
extension has no runtime npm dependencies. Packaging uses a locked local `vsce`;
no marketplace publication or publisher credential is involved. The extension is licensed under Apache-2.0.

## Phase C extraction

`EXTRACTION.json` is the original history-import receipt. `SOURCE-MANIFEST.json`
records relocation from Panopticon revision
`2d92d13f38d491c298631b9b9296979c1fbadd19`. Runtime and original test bytes
are unchanged, as are version 0.1.0, commands, settings and endpoint behavior.
Historical source guidance is retained in `docs/`.

CI uses debrunners while private and hosted Ubuntu when public, with read-only
contents, pinned actions and no private credentials. The qualified VSIX is retained
as an Actions artifact; no tag, release or Marketplace publication is performed.
