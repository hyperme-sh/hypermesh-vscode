#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24")'
python3 scripts/check_source.py
npm test
mkdir -p dist
npm run package
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
python3 scripts/check-vsix.py dist/hypermesh-vscode.vsix "$scratch"
# The suite is deliberately excluded from the VSIX. Run the unchanged tests
# beside the unpacked runtime, so require('./smoke') cannot use the checkout.
cp src/smoke.test.js "$scratch/extension/src/"
(cd "$scratch/extension" && node --test src/smoke.test.js)
