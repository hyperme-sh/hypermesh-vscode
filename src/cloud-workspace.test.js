const assert = require('node:assert/strict');
const test = require('node:test');
const { install, validate } = require('./cloud-workspace');

const one = '11111111-1111-4111-8111-111111111111';
const two = '22222222-2222-4222-8222-222222222222';
const three = '33333333-3333-4333-8333-333333333333';
const scope = { device_id: one, worker_generation: 1, task_id: two, lease_id: three, workspace: '/workspace' };
const view = { ...scope, version: 1, expires_at_ms: Date.now() + 60000, tool: 'check-json',
  target: 'check.json', state: 'ready', output: '', cursor: 0 };

test('the editor rejects an expired lease, a foreign agent, or a regressed output cursor', () => {
  assert.equal(validate(view, scope, 0), view);
  for (const invalid of [{ lease_id: two }, { worker_generation: 2 }, { device_id: three },
    { expires_at_ms: 0 }, { cursor: 5 }, { workspace: '/foreign' }]) {
    assert.throws(() => validate({ ...view, ...invalid }, scope, 0), /lease/);
  }
});

const extensionKinds = { UI: 1, Workspace: 2 };

async function runCloudCommand(remoteName, extensionKind) {
  const ops = [], lines = [], errors = [];
  let command;
  const settings = { executable: '/usr/bin/hypermesh-visor-headless', ...scope };
  const vscode = {
    env: { remoteName }, ExtensionKind: extensionKinds,
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: scope.workspace } }],
      getConfiguration: () => ({ inspect: () => ({ globalValue: settings, workspaceValue: { device_id: three } }) }),
    },
    commands: { registerCommand: (_, handler) => { command = handler; } },
    window: {
      showQuickPick: async (choices, options) => {
        assert.match(options.title, new RegExp(one));
        assert.match(choices[0].detail, new RegExp(three));
        return choices[2];
      },
      showWarningMessage: async () => 'Run Tool',
      createOutputChannel: () => ({ clear() {}, show() {}, append: text => lines.push(text),
        appendLine: text => lines.push(text) }),
      showErrorMessage: text => errors.push(text),
    },
  };
  install(vscode, { extension: { extensionKind }, subscriptions: [] }, async (exe, supplied, request) => {
    assert.equal(exe, settings.executable);
    assert.deepEqual(supplied, scope);
    ops.push(request.operation);
    return request.operation === 'read' ? { ...view, state: 'completed', output: 'valid\n', cursor: 6 } : view;
  }, 'linux');
  await command();
  return { ops, lines, errors };
}

for (const [host, remoteName, extensionKind] of [
  ['local Linux', undefined, extensionKinds.UI],
  ['Remote SSH', 'ssh-remote', extensionKinds.Workspace],
]) {
  test(`the enrolled worker stays scoped across inspect and invoke on ${host}`, async () => {
    const { ops, lines, errors } = await runCloudCommand(remoteName, extensionKind);
    assert.deepEqual(ops, ['inspect', 'invoke', 'read']);
    assert.deepEqual(errors, []);
    assert.ok(lines.includes('valid\n'));
  });
}

test('the local UI host cannot run the enrolled worker command in a Remote SSH window', async () => {
  const { ops, errors } = await runCloudCommand('ssh-remote', extensionKinds.UI);
  assert.deepEqual(ops, []);
  assert.match(errors[0], /trusted Linux worker workspace/);
});
