# Releasing

## Version

`package.json` version is `0.1.0`. `.github/version-policy.json` records the same version under `versions["package.json"]`. [`.github/workflows/version-policy.yml`](../.github/workflows/version-policy.yml) runs `python3 scripts/check-version-policy.py` on pull requests, pushes to `main`, any tag, and `workflow_dispatch`. The script fails when the `version` field in `package.json` differs from that policy entry, and when the version is not a `0.MINOR.PATCH` value below `0.24.0`.

The policy file also lists versions of other Hypermesh packages under `owned_dependency_versions`. This repository has no `uv.lock`, so those entries are unused by the check here. They record the versions this package was imported alongside.

`package.json` sets `"private": true`, so `npm publish` refuses the tree. The installable artifact is the VSIX.

## Package contents

```sh
npm run package
```

runs `vsce package --no-dependencies --out dist/hypermesh-vscode.vsix` with `@vscode/vsce` 4.1.0. `.vscodeignore` keeps `package.json`, `README.md`, `src/extension.js`, `src/smoke.js`, and `LICENSE`. Inside the archive, vsce stores the license as `extension/LICENSE.txt` and the readme as `extension/readme.md`. Tests, `scripts/`, provenance JSON, `docs/`, and `node_modules` stay out.

Install that file into Visual Studio Code:

```sh
code --install-extension dist/hypermesh-vscode.vsix
```

The extension id is `fyberlabs.hypermesh-vscode`.

## Continuous integration

[`.github/workflows/package.yml`](../.github/workflows/package.yml) (workflow name **Standalone VSIX**) runs on pull requests, pushes to `main`, and `workflow_dispatch`.

- Permissions are `contents: read`.
- `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` are pinned by commit SHA.
- Checkout sets `persist-credentials: false`.
- Node.js is `24.15.0`, with the setup-node package-manager cache disabled.
- The job runs `npm ci --ignore-scripts`, then `npm run check`, then uploads `dist/hypermesh-vscode.vsix`.
- The artifact name is `tested-vsix`. A missing file fails the job. Retention is 30 days.

While the GitHub repository is private, the job selects a self-hosted Linux x64 runner. When the repository is public, it selects `ubuntu-24.04`. The workflow does not read a Marketplace token, a publisher secret, or any other credential.

[`.github/workflows/version-policy.yml`](../.github/workflows/version-policy.yml) uses the same runner selection and the same read-only `contents` permission. Its only step is the version check.

Both workflows upload their results (the VSIX, or the version-check log) and stop. A tag, a GitHub Release, and a Marketplace publication are separate from these workflows. The `tested-vsix` artifact on a successful run is the qualified build for that commit.
