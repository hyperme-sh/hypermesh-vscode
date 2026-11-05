# Hypermesh for VS Code

**Hypermesh for VS Code** is the editor-side smoke check for [Hypermesh](https://hyperme.sh) renter chat. Package `hypermesh-vscode` version 0.1.0 contributes the command **Hypermesh: smoke** (`hypermesh.smoke`). The command sends one short chat completion to the Hypermesh chat host and reports whether that host returned HTTP 200 with a non-empty body.

The extension id is `fyberlabs.hypermesh-vscode`. It targets Visual Studio Code 1.85.0 and newer. The packaged runtime is `src/extension.js` and `src/smoke.js`. Install the VSIX built from this repository. Source and issues: [hyperme-sh/hypermesh-vscode](https://github.com/hyperme-sh/hypermesh-vscode).

## Why

A renter API key and a tenant id can call the control plane while the chat path is still down. Completions go to the chat host (`https://chat.test.hyperme.sh` on the test network). That host forwards an authorized request to the machine serving the lease. **Hypermesh: smoke** checks that hop from VS Code: one fixed user message, the renter key, and the tenant id. It passes when the chat host answers the completion.

## How it works

Visual Studio Code activates the extension when you run **Hypermesh: smoke**. The command reads two window settings and one secret:

| Name | Where it lives | Default | Sent as |
|---|---|---|---|
| `hypermesh.apiBase` | window setting | `https://chat.test.hyperme.sh` | chat host origin |
| `hypermesh.tenant` | window setting | empty | `X-Tenant-ID` |
| renter API key | SecretStorage key `hypermesh.key` | empty until prompted | `Authorization: Bearer <key>` |

The renter key lives in VS Code SecretStorage. The first run opens a masked input, **Renter API key**, and stores the value you enter. Later runs reuse `hypermesh.key` and skip the prompt. The command writes that secret only when it is empty.

The request URL is `{apiBase}/v1/chat/completions`. A trailing slash on `apiBase` is removed first. When `apiBase` already ends in `/v1`, the command appends `/chat/completions`. An empty `apiBase` fails with `API base is required`. An `apiBase` whose URL contains `/api/v1/hypermesh/renter/chat/completions` fails with `refusing the control-plane chat stub`. An empty tenant fails with `tenant is required`. An empty key fails with `API key is required`.

Headers are `Authorization: Bearer <key>`, `X-Tenant-ID`, and `Content-Type: application/json`. The body is fixed:

```json
{
  "messages": [{ "role": "user", "content": "Reply with the single word ready." }],
  "max_tokens": 8
}
```

Success is HTTP 200 and a body that contains something other than whitespace. VS Code then shows `Hypermesh smoke ok (200)`. Any other status, including HTTP 200 with an empty body, shows `Hypermesh smoke failed: smoke failed: status <code>`. A network error shows `Hypermesh smoke failed:` followed by the error message. The information message reports the status; the completion text stays in the response body.

`edge-routes.json` records this client as served outside the control-plane reverse proxy. The command calls the chat host directly.

## Practical use

You need Visual Studio Code 1.85 or newer, Node.js 24 to build the package, and a renter API key plus tenant id from your Hypermesh account.

```sh
git clone https://github.com/hyperme-sh/hypermesh-vscode.git
cd hypermesh-vscode
npm ci --ignore-scripts
npm run package
code --install-extension dist/hypermesh-vscode.vsix
```

`npm run package` writes `dist/hypermesh-vscode.vsix` using the locked `@vscode/vsce` 4.1.0 (`vsce package --no-dependencies`). Reload the window if **Hypermesh: smoke** is missing from the Command Palette.

Set the window settings (User or Workspace):

```json
{
  "hypermesh.apiBase": "https://chat.test.hyperme.sh",
  "hypermesh.tenant": "<tenant-id>"
}
```

On the test network, leave `apiBase` at the default. Point it at another origin when that origin is the chat host you want to probe, including a gateway on your own machine. Open the Command Palette, run **Hypermesh: smoke**, and paste the renter API key. The next run uses the stored secret.

The same request, without VS Code:

```sh
curl -sS -D - -o /tmp/hypermesh-smoke.json \
  -X POST "${HYPERMESH_CHAT_BASE:-https://chat.test.hyperme.sh}/v1/chat/completions" \
  -H "Authorization: Bearer ${HYPERMESH_API_KEY}" \
  -H "X-Tenant-ID: ${HYPERMESH_TENANT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with the single word ready."}],"max_tokens":8}'
```

A passing smoke is status `200` and a non-empty `/tmp/hypermesh-smoke.json`.

## How Hypermesh uses it

Hypermesh keeps renter setup on the control plane and renter chat on the chat host.

On the test network the control plane is `https://api.test.hyperme.sh`. A renter lists the catalog, lists hosts, and checks out a lease there. The [Hypermesh CLI](https://github.com/hyperme-sh/hypermesh-cli) is the command-line client for that API. It stores the same renter key and tenant id this extension uses.

Chat traffic goes to the chat host, `https://chat.test.hyperme.sh` by default. That host is the [Hypermesh gateway](https://github.com/hyperme-sh/hypermesh-gateway). The control plane assigns the gateway and host peers and issues the lease ticket. The gateway checks the renter credential and the ticket, then proxies `POST /v1/chat/completions` to the assigned host. The [host](https://github.com/hyperme-sh/hypermesh-host) serves inference on its WireGuard address. From VS Code, the renter calls the chat host.

**Hypermesh: smoke** is the VS Code caller on that chat path. Run it once the tenant id and renter key exist, to see that the chat host accepted them and returned a completion. Host enrollment, checkout, and lease lifetime stay on the control plane and the CLI.

The command scores only that completions POST. It never sends `GET /api/v1/health/`, so a healthy control plane is a separate fact from a passing smoke. `POST /api/v1/hypermesh/renter/chat/completions` on the control plane is a stub; an `apiBase` that contains that path is rejected before any request is sent.

## Develop and test

From a checkout, with Node.js 24 and Python 3:

```sh
npm ci --ignore-scripts
npm test
npm run check
```

`npm test` runs the seven headless tests in `src/smoke.test.js`. They bind a loopback HTTP server and use fixture credentials.

`npm run check` verifies imported source hashes, runs those tests, builds the VSIX, checks its file list and runtime bytes, and runs the same tests against the unpacked package outside the checkout. Hash coverage, the historical package notes, and the import receipt are in [docs/development.md](docs/development.md).

## Release and versioning

The package version is **0.1.0**, recorded in `package.json` and `.github/version-policy.json`. Continuous integration builds `dist/hypermesh-vscode.vsix` and keeps it as the Actions artifact `tested-vsix` for 30 days. Packaging, the version check, and publication are described in [docs/releasing.md](docs/releasing.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
