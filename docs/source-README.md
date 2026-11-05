# Hypermesh VS Code smoke

Command **Hypermesh: smoke**. Workspace settings:

| Setting | Default | Use |
|---------|---------|-----|
| `hypermesh.apiBase` | `https://chat.test.hyperme.sh` | Chat host. The command posts `/v1/chat/completions`. |
| `hypermesh.tenant` | empty | `X-Tenant-ID` |

The renter key is stored with VS Code SecretStorage (`hypermesh.key`). The command asks for it once when the secret is empty. It is not a workspace setting.

The command sends one short completion. It fails when the status is not 200 or the body is empty. It does not call `GET /api/v1/health/` and it refuses `POST /api/v1/hypermesh/renter/chat/completions`.

The same function runs headless:

```bash
cd products/hypermesh-vscode
npm test
```

GitHub Action: `.github/workflows/hypermesh-vscode-smoke.yml`.
