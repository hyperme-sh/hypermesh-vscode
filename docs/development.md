# Development

## Requirements

- Node.js 24. Continuous integration uses 24.15.0. `scripts/check-package.sh` refuses any other major version.
- Python 3, for `scripts/check_source.py` and `scripts/check-vsix.py`.
- npm, using the committed `package-lock.json`.

The only development dependency is `@vscode/vsce` 4.1.0. The extension runtime does not depend on npm packages. `npm ci --ignore-scripts` installs the packager and skips dependency lifecycle scripts.

## Layout

| Path | Role |
|---|---|
| `src/extension.js` | VS Code `activate`. Registers `hypermesh.smoke`, reads settings, prompts for the secret, and shows the result. |
| `src/smoke.js` | URL construction, SecretStorage lookup, and the completions POST. The command, `npm test`, and CI all call this module. |
| `src/smoke.test.js` | Seven headless tests. Left out of the VSIX. |
| `package.json` | Extension manifest: command, settings, engine `^1.85.0`, publisher `fyberlabs`, version `0.1.0`. |
| `.vscodeignore` | VSIX allowlist: `package.json`, `README.md`, `src/extension.js`, `src/smoke.js`, `LICENSE`. |
| `edge-routes.json` | Records that this client is served outside the control-plane reverse proxy. `edge_routes` is empty. |
| `scripts/check-package.sh` | Local qualification: hashes, tests, VSIX, unpacked retest. |
| `scripts/check_source.py` | Compares unchanged imported files with `SOURCE-MANIFEST.json`. |
| `scripts/check-vsix.py` | Checks the VSIX inventory and runtime bytes, then unpacks the archive. |
| `docs/source-README.md` | Historical package README, kept byte-for-byte. |
| `docs/source-AGENTS.md` | Historical package notes, kept byte-for-byte. |

## Tests

```sh
npm test
```

runs `node --test src/smoke.test.js`. Each case serves HTTP on `127.0.0.1` and uses fixture credentials. The seven cases cover:

1. The completions URL for `https://chat.test.hyperme.sh`, for an `apiBase` that already ends in `/v1`, and rejection of a URL that contains `/api/v1/hypermesh/renter/chat/completions`.
2. One `POST /v1/chat/completions` carrying `Authorization: Bearer <key>`, `X-Tenant-ID`, and the fixed message `Reply with the single word ready.` The request leaves `X-Api-Key` unset.
3. The smoke fails when the completions POST returns a non-200 status, including after a `GET` that already returned HTTP 200.
4. HTTP 200 with an empty or whitespace body fails.
5. The contributed command title is `Hypermesh: smoke`, the default `apiBase` is `https://chat.test.hyperme.sh`, `hypermesh.tenant` is declared, and `hypermesh.key` is absent from settings.
6. A secret already stored under `hypermesh.key` is reused, and the prompt function is not called.
7. An empty secret is prompted once and stored as `hypermesh.key`.

## Full check

```sh
npm run check
```

runs `scripts/check-package.sh`:

1. Require Node.js 24.
2. Run `scripts/check_source.py`.
3. Run `npm test`.
4. Run `npm run package`, which writes `dist/hypermesh-vscode.vsix`.
5. Run `scripts/check-vsix.py`. The archive must contain exactly these names:

   - `[Content_Types].xml`
   - `extension.vsixmanifest`
   - `extension/package.json`
   - `extension/readme.md`
   - `extension/LICENSE.txt`
   - `extension/src/extension.js`
   - `extension/src/smoke.js`

   `LICENSE.txt` must match `LICENSE`. `extension.js` and `smoke.js` must match the checkout. The packaged manifest must match `package.json` for `name`, `version`, `publisher`, `main`, `engines`, `contributes`, and `activationEvents`, and its `license` must be `Apache-2.0`. A `dependencies` object on the packaged manifest fails the check.
6. Copy `src/smoke.test.js` beside the unpacked extension and run `node --test src/smoke.test.js` there, so `require("./smoke")` loads the packaged copy.

This repository has no Visual Studio Code extension-host test. The headless suite does not launch the editor.

## Source hashes

`SOURCE-MANIFEST.json` lists each file moved into this repository, its sha256, and an `unchanged` flag. `scripts/check_source.py` re-hashes every entry marked `unchanged: true` and fails when the bytes differ. It also fails when `src/**/*.js` is anything other than the `src/` destinations in the manifest.

Unchanged files:

- `docs/source-AGENTS.md`
- `docs/source-README.md`
- `edge-routes.json`
- `src/extension.js`
- `src/smoke.js`
- `src/smoke.test.js`

`package.json` is recorded with `unchanged: false`. Editing an unchanged file, or adding a `src/*.js` file, makes `npm run check` fail until the manifest matches the tree again.

`docs/source-README.md` still describes the previous tree: `cd products/hypermesh-vscode` and a workflow named `.github/workflows/hypermesh-vscode-smoke.yml`. In this repository, tests run from the repository root, and the workflow is [`.github/workflows/package.yml`](../.github/workflows/package.yml). Follow this file and the [README](../README.md) for commands.

## Provenance

`EXTRACTION.json` is the import receipt. It records selected path `products/hypermesh-vscode`, filtered history head `126781472702b028f13c8084890ec89a863f3525`, and seven retained files. Its `repository` field still says `FyberLabs/hypermesh-vscode`. The GitHub repository is [hyperme-sh/hypermesh-vscode](https://github.com/hyperme-sh/hypermesh-vscode).

`SOURCE-MANIFEST.json` records the source repository and revision the bytes were taken from: `FyberLabs/panopticon` at `2d92d13f38d491c298631b9b9296979c1fbadd19`. Runtime files, the original tests, version 0.1.0, the command, the settings, and the completions endpoint match that import. `package.json` is the file the receipt marks as changed.

Those two JSON files are receipts. The chat caller in this repository posts to the Hypermesh chat host. Catalog, checkout, and lease calls stay on the control plane, which this command does not call.
