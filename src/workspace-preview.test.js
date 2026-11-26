const assert = require('node:assert/strict');
const test = require('node:test');
const { showPreview } = require('./workspace-preview');

const id = 'a1234567-1234-1234-1234-123456789abc';
const scope = { boot: id, session: id, binding: '0'.repeat(64), workspace: '/repo', device_id: id };
const browser = 'workbench.action.browser.open';
const route = '/0123456789abcdef0123456789abcdef/';
const open = { ...scope, id, state: 'open', port: 4173, preview_id: id, url: 'http://127.0.0.1:50123' + route };

function setup({ remote, mapped = 'http://localhost:51000/', commands = [browser], choice = 'Open workspace preview',
  current = () => true, grant = open, localPortHost = 'localhost' } = {}) {
  const operations = [];
  const forwards = [];
  const launches = [];
  const vscode = {
    commands: { getCommands: async () => commands, executeCommand: async (...args) => launches.push(args) },
    env: { asExternalUri: async origin => { forwards.push(origin); return mapped; } },
    Uri: { parse: value => value },
    workspace: { getConfiguration: () => ({ get: () => localPortHost }) },
    window: { showWarningMessage: async () => 'Open Preview', showInformationMessage() {} },
  };
  const run = () => showPreview(vscode, {
    choice, workspace: '/repo', remote, scope, id, port: 4173, current,
    request: async operation => {
      operations.push(operation);
      return operation.type === 'preview_close' ? { ...open, state: 'eligible' } : grant;
    },
  });
  return { run, operations, forwards, launches };
}

test('local preview uses the integrated browser and keeps the grant on loopback', async () => {
  const view = setup();
  await view.run();
  assert.deepEqual(view.operations.map(op => op.type), ['preview_open', 'preview_context']);
  assert.deepEqual(view.forwards, []);
  assert.deepEqual(view.launches, [[browser, open.url]]);
});

test('Remote SSH forwards only the private proxy origin and preserves the grant path', async () => {
  const view = setup({ remote: 'ssh-remote' });
  await view.run();
  assert.deepEqual(view.forwards, ['http://127.0.0.1:50123']);
  assert.deepEqual(view.launches, [[browser, 'http://localhost:51000' + route]]);
});

test('missing browser support or an external forwarding result blocks the preview', async () => {
  const missing = setup({ commands: [] });
  await assert.rejects(missing.run, /integrated browser is unavailable/);
  assert.deepEqual(missing.operations, []);
  const shared = setup({ remote: 'ssh-remote', localPortHost: 'allInterfaces' });
  await assert.rejects(shared.run, /Private forwarding is unavailable/);
  assert.deepEqual(shared.operations, []);
  assert.deepEqual(shared.forwards, []);
  for (const mapped of ['https://remote.example/', 'http://localhost:4173/', 'http://localhost:51000/other']) {
    const view = setup({ remote: 'ssh-remote', mapped });
    await assert.rejects(view.run, /unavailable/);
    assert.deepEqual(view.launches, []);
  }
});

test('wrong scope and closed or changed grants do not open, and close uses the authorized ID', async () => {
  const wrong = setup({ grant: { ...open, workspace: '/other' } });
  await assert.rejects(wrong.run, /unavailable/);
  assert.deepEqual(wrong.launches, []);
  const closed = setup({ choice: 'Close workspace preview' });
  await closed.run();
  assert.equal(closed.operations[1].preview_id, open.preview_id);
  assert.deepEqual(closed.launches, []);
});
