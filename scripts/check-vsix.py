"""Fail on unexpected VSIX payloads or runtime drift before external tests."""
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
expected = {
    '[Content_Types].xml', 'extension.vsixmanifest',
    'extension/package.json', 'extension/readme.md', 'extension/LICENSE.txt',
    'extension/src/extension.js', 'extension/src/smoke.js',
}
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)) or set(names) != expected:
        raise SystemExit(f'Unexpected VSIX inventory: {names}')
    assert archive.read('extension/LICENSE.txt') == (root / 'LICENSE').read_bytes()
    assert json.loads(archive.read('extension/package.json'))['license'] == 'Apache-2.0'
    for name in ('src/extension.js', 'src/smoke.js'):
        if archive.read('extension/' + name) != (root / name).read_bytes():
            raise SystemExit(f'Packaged runtime differs: {name}')
    package = json.loads(archive.read('extension/package.json'))
    source = json.loads((root / 'package.json').read_text())
    for key in ('name', 'version', 'publisher', 'main', 'engines', 'contributes', 'activationEvents'):
        if package[key] != source[key]:
            raise SystemExit(f'Packaged manifest differs: {key}')
    if package.get('dependencies'):
        raise SystemExit('Runtime dependencies require a reviewed VSIX inventory update')
    archive.extractall(sys.argv[2])  # Exact allowlist above excludes unsafe paths.
print('VSIX inventory, manifest and runtime bytes verified')
