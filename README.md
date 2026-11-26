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

## Assigned Visor chat

Set `hypermesh.acpExecutable` and `hypermesh.visorSocket` in user settings to the
installed ACP adapter and private Visor socket. Run **Hypermesh: Chat with Visor**
in a trusted local workspace. Visor must already have a currently assigned
session and authorized host bridge. Turns use machine-authenticated Conductor
routing and AIuditor; the editor never receives host credentials. The existing
HTTPS chat-host smoke command still keeps its renter key in SecretStorage.

Cancel from the progress notification or **Hypermesh: Cancel Visor turn**. An
interrupted or unknown outcome is not retried. Responses open as plain text,
without writing project files. Prompt text is sent only over the adapter's stdin
and is not logged. Only one turn runs at a time.

Set `hypermesh.companionExecutable` to the installed companion and use
**Hypermesh: Manage Visor tool connections** to open its reviewed attachment UI.
The extension never imports project MCP files or accepts executable/socket
settings from a repository. Catalog, checkout and leases remain on Plane/CLI.
This feature requires Visor #219; it does not use the ACP fixture backend. No
Marketplace publication is included.

The stored-key smoke command also uses user settings only, requires HTTPS before
loading a key, and refuses redirects. Project settings cannot choose its credential
destination. The isolated smoke transport fixtures remain unchanged.

Use **Hypermesh: Inspect and manage workspace permissions** to open the installed
native permission manager for the selected local workspace. The manager shows
scoped templates, learned allows, current policy and dreaming changes, and offers
only owner-authorized edits. Configure the installed companion in user settings;
workspace settings cannot select it. Reopen after reconnecting or changing the
assigned organization. The editor keeps no permission database or credentials.
Failed coding actions offer the same command to inspect why access changed.

### Continue tasks

**Hypermesh: Continue task controls** shows the selected workspace's durable
Visor task. The status bar refreshes owner state, including Continue, chunk
progress, limits and completion/blocker reasons. Open the native task form to
start scoped work with Continue on by default; toggle Continue or pause/resume/
stop from either client. Controls use the observed task revision and show only
acknowledged state. Reconnect reads the existing task rather than starting one.

The installed companion handles private-socket identity and owner authorization.
The extension never reads credentials or opens an unauthenticated service port.
Workspace or active-editor changes clear stale status. Central GitHub issue, PR
and check links supplied with the task can be opened from the same menu. Changing
scope or limits requires stopping the selected task before replacement.

### Local Visor terminal task

In a trusted local workspace, set `hypermesh.companionExecutable` in User
Settings to the absolute path of the installed `hypermesh-companion`. Use
**Hypermesh: Visor terminal task** to check access, review and run the owner-declared
command, attach to an existing task ID and output cursor, or request cancellation.
The integrated terminal follows Visor's output and exit state. Closing the view
detaches from the task. The menu also opens the existing workspace permissions
view. Setup and CLI usage are in the [Visor terminal task guide](https://github.com/hyperme-sh/visor/blob/main/docs/terminal-tasks.md).

For a declaration with `"interactive": true`, choose **Attach with input**
to claim the exact task terminal. Confirm a transfer if another client owns
input. The terminal tab shows the current owner and last acknowledgement.
Keystrokes and resize events go to that task. **Attach to task** follows output
as a viewer, and closing either view detaches.

### Lint a workspace JSON file

On Linux, open a trusted local workspace with an approved Visor session.
Follow the [Visor JSON lint setup](https://github.com/hyperme-sh/visor/blob/main/plugins/json-lint/README.md)
to approve the exact file and enable the plugin. Set `hypermesh.companionExecutable`
in user settings, open the saved file, and run
**Hypermesh: Lint current JSON file with Visor**.

Open **Problems** to see findings and jump to their locations. The status bar
shows the plugin version, runtime, and configuration after the run. Rerun after
saving edits or changing the selected file.

### Visor terminal tasks in WSL

Open the project in a VS Code WSL window and install Hypermesh in its WSL
extension host. Set `hypermesh.companionExecutable` in **Remote Settings**
to the companion's absolute Linux executable path in that distribution. Open
**Hypermesh: Visor terminal task** in a trusted workspace to see the
distribution, workspace and access before running or attaching.

Setup, CLI commands, and the distribution binding are described in the
[Visor terminal task guide](https://github.com/hyperme-sh/visor/blob/main/docs/terminal-tasks.md#wsl).

### Visor terminal tasks over Remote SSH

Open the trusted Linux workspace through VS Code Remote–SSH. Install
Hypermesh in the remote extension host. In **Remote Settings**, set
`hypermesh.companionExecutable` to the companion on that host and
`hypermesh.terminalHostDeviceId` to the enrolled device UUID. The terminal
picker shows that device, the remote workspace and access state. If a
connection drops, reopen the command and attach using the displayed task ID
and output cursor.

The [Visor terminal task guide](https://github.com/hyperme-sh/visor/blob/main/docs/terminal-tasks.md#remote-ssh)
shows the matching CLI command and the host-side setup.
