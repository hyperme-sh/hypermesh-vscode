const assert = require('node:assert/strict');
const test = require('node:test');
const { install, pageFor, terminalText } = require('./terminal-task');

const boot = 'a1234567-1234-1234-1234-123456789abc';
const session = 'b1234567-1234-1234-1234-123456789abc';
const id = 'c1234567-1234-1234-1234-123456789abc';
const binding = 'a'.repeat(64);
const revision = 'b'.repeat(64);
const workspace = '/fixture/workspace';
const scope = { boot, session, binding, access: 'ready', task: {
  revision, cwd: workspace + '/src', command: '/bin/pwd', args: [], environment: 'clean', timeout_seconds: 5,
} };

function fixture({ trusted = true, remoteName, choice, input, onConfirm } = {}) {
  const entries = [];
  const output = [];
  const errors = [];
  let command;
  let pty;
  const vscode = {
    env: { remoteName },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: workspace } }],
      getConfiguration: () => ({ inspect: () => ({ globalValue: '/installed/companion' }) }),
    },
    commands: { registerCommand: (_, handler) => { command = handler; } },
    EventEmitter: class {
      fire(value) { output.push(value); }
      dispose() {}
    },
    window: {
      showQuickPick: async (options) => { assert.ok(options.includes(choice)); return choice; },
      showWarningMessage: async (_, options) => {
        assert.ok(options.detail.includes('/bin/pwd'));
        assert.ok(options.detail.includes(workspace + '/src'));
        onConfirm?.(vscode);
        return 'Run Task';
      },
      showInputBox: async () => input,
      showErrorMessage: (value) => errors.push(value),
      createTerminal: ({ pty: value }) => { pty = value; return { show: () => pty.open() }; },
    },
  };
  install(vscode, { subscriptions: [] }, async (exe, project, operation) => {
    assert.equal(exe, '/installed/companion');
    assert.equal(project, workspace);
    entries.push(operation);
    if (operation.type === 'context') return scope;
    const outputText = operation.type === 'read' ? 'done\n' : '';
    return { id: operation.id, session, status: 'completed', exit_code: 0,
      access: 'ready', cursor: (operation.cursor || 0) + Buffer.byteLength(outputText), more: false,
      truncated: false, output_base64: Buffer.from(outputText).toString('base64') };
  });
  return { entries, output, errors, open: () => command(), close: () => pty?.close() };
}

test('Restricted Mode and remote workspaces refuse before starting a helper', async () => {
  for (const options of [{ trusted: false }, { remoteName: 'ssh-remote' }]) {
    const client = fixture(options);
    await client.open();
    assert.deepEqual(client.entries, []);
    assert.match(client.errors[0], /trusted local workspace/);
  }
});

test('Workspace Trust is checked again after command review', async () => {
  const client = fixture({ choice: 'Run declared task', onConfirm: vscode => { vscode.workspace.isTrusted = false; } });
  await client.open();
  assert.deepEqual(client.entries.map(x => x.type), ['context']);
});

test('Run reviews a declaration then reads the same ID and exit status', async () => {
  const client = fixture({ choice: 'Run declared task' });
  await client.open();
  assert.deepEqual(client.entries.map(x => x.type), ['context', 'start', 'read']);
  assert.equal(client.entries[1].id, client.entries[2].id);
  assert.equal(client.entries[1].revision, revision);
  assert.equal(client.entries[2].binding, binding);
  assert.match(client.output.join(''), /done.*completed · access ready · exit 0/s);
  client.close();
});

test('Attach to a CLI run at its cursor never sends start', async () => {
  const client = fixture({ choice: 'Attach to task', input: id + ' 56' });
  await client.open();
  assert.deepEqual(client.entries, [{ type: 'context' }, { type: 'read', id, boot, session, binding, cursor: 56 }]);
  client.close();
});

test('Foreign task pages and terminal control sequences are rejected', () => {
  assert.throws(() => pageFor({ id: 'foreign' }, scope, id, 0), /unavailable/);
  assert.equal(terminalText('safe\x1b]52;clipboard\x07\n'), 'safe]52;clipboard\r\n');
});
