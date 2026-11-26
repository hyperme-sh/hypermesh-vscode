const assert = require('node:assert/strict');
const test = require('node:test');
const { install, inputAttachment, pageFor, terminalText } = require('./terminal-task');

const boot = 'a1234567-1234-1234-1234-123456789abc';
const session = 'b1234567-1234-1234-1234-123456789abc';
const id = 'c1234567-1234-1234-1234-123456789abc';
const binding = 'a'.repeat(64);
const revision = 'b'.repeat(64);
const workspace = '/fixture/workspace';
const scope = { boot, session, binding, access: 'ready', task: {
  revision, cwd: workspace + '/src', command: '/bin/pwd', args: [], environment: 'clean', timeout_seconds: 5,
} };

function fixture({ trusted = true, remoteName, choice, input, onConfirm, respond } = {}) {
  const entries = [];
  const output = [];
  const errors = [];
  const confirmations = [];
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
      showWarningMessage: async (title, options, action) => {
        confirmations.push(title);
        if (action === 'Run Task') {
          assert.ok(options.detail.includes('/bin/pwd'));
          assert.ok(options.detail.includes(workspace + '/src'));
        }
        onConfirm?.(vscode);
        return action;
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
    const override = respond?.(operation);
    if (override) return override;
    const outputText = operation.type === 'read' ? 'done\n' : '';
    return { id: operation.id, session, status: 'completed', exit_code: 0,
      access: 'ready', cursor: (operation.cursor || 0) + Buffer.byteLength(outputText), more: false,
      truncated: false, output_base64: Buffer.from(outputText).toString('base64') };
  });
  return { entries, output, errors, confirmations, pty: () => pty, open: () => command(), close: () => pty?.close() };
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

const terminal = 'd1234567-1234-1234-1234-123456789abc';
const owner = 'e1234567-1234-1234-1234-123456789abc';
const lease = 'f1234567-1234-1234-1234-123456789abc';
const grant = { terminal, owner, lease };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Interactive resize and keystrokes share an explicit ordered grant', async () => {
  const operations = [];
  const acknowledgements = [];
  const input = inputAttachment(grant, async operation => {
    operations.push(operation);
    return { ack: { sequence: operation.sequence, resized: operation.type === 'resize',
      accepted_bytes: operation.type === 'input' ? 1 : null } };
  }, () => true, ack => acknowledgements.push(ack), assert.fail);
  input.resize({ rows: 33, columns: 95 });
  input.input('x');
  await flush();
  assert.deepEqual(operations, [
    { type: 'resize', rows: 33, cols: 95, lease, sequence: 1 },
    { type: 'input', data_base64: 'eA==', lease, sequence: 2 },
  ]);
  assert.deepEqual(acknowledgements, [1, 2]);
  input.close();
  await flush();
  assert.deepEqual(operations[2], { type: 'release', lease });
});

test('The latest resize is delivered after a full queue of keystrokes', async () => {
  const operations = [];
  let finishFirst;
  const input = inputAttachment(grant, async operation => {
    operations.push(operation);
    if (operation.sequence === 1) await new Promise(resolve => { finishFirst = resolve; });
    const resized = operation.type === 'resize';
    return { ack: { sequence: operation.sequence, resized, accepted_bytes: resized ? null : 1 } };
  }, () => true, () => {}, assert.fail);
  input.resize({ rows: 24, columns: 80 });
  for (const key of 'abcd') input.input(key);
  for (let columns = 81; columns <= 85; columns++) input.resize({ rows: 25, columns });
  finishFirst();
  await flush();
  assert.deepEqual(operations.map(operation => operation.type), ['resize', 'input', 'input', 'input', 'input', 'resize']);
  assert.deepEqual(operations[5], { type: 'resize', rows: 25, cols: 85, sequence: 6, lease });
});

test('Takeover discards queued input and the old reply cannot re-enable it', async () => {
  const operations = [];
  const messages = [];
  let resolve;
  const input = inputAttachment(grant, operation => {
    operations.push(operation);
    return new Promise(done => { resolve = done; });
  }, () => true, assert.fail, message => messages.push(message));
  input.input('a');
  input.input('b');
  input.observe({ id: terminal, input_available: true, owner: { id } });
  resolve({ ack: { sequence: 1, resized: false, accepted_bytes: 1 } });
  await flush();
  input.input('c');
  assert.equal(operations.length, 1);
  assert.match(messages[0], /ownership or access changed/);
});

test('An unconfirmed write stops the queue without retrying the input', async () => {
  const operations = [];
  const messages = [];
  const input = inputAttachment(grant, async operation => {
    operations.push(operation);
    if (operation.type === 'input') throw new Error('disconnected');
  }, () => true, assert.fail, message => messages.push(message));
  input.input('a');
  input.input('b');
  await flush();
  assert.deepEqual(operations.map(operation => operation.type), ['input', 'release']);
  assert.match(messages[0], /unconfirmed/);
});

function interactivePage(operation, activeOwner) {
  return { id, session, status: 'running', exit_code: null, access: 'ready',
    cursor: operation.cursor ?? 0, more: false, truncated: false, output_base64: '',
    terminal: { id: terminal, input_available: true, owner: activeOwner } };
}

test('Viewing an interactive task leaves its typing and size controls unregistered', async () => {
  const client = fixture({ choice: 'Attach to task', input: id,
    respond: operation => interactivePage(operation, { id: owner, client: 'cli', ack: null }) });
  await client.open();
  assert.equal(client.pty().handleInput, undefined);
  assert.equal(client.pty().setDimensions, undefined);
  client.close();
  assert.deepEqual(client.entries.map(operation => operation.type), ['context', 'read']);
});

test('Explicit confirmation transfers input for the exact attached terminal', async () => {
  let activeOwner = { id: owner, client: 'cli', ack: null };
  const respond = operation => {
    if (operation.type === 'read') return interactivePage(operation, activeOwner);
    const request = operation.request;
    assert.equal(operation.id, id);
    assert.equal(operation.terminal, terminal);
    if (request.type === 'claim') {
      assert.equal(request.expected_owner, owner);
      activeOwner = { id: request.owner, client: 'editor', ack: null };
      return { lease, terminal: { id: terminal, input_available: true, owner: activeOwner } };
    }
    if (request.type === 'input') {
      assert.equal(request.lease, lease);
      activeOwner.ack = { sequence: request.sequence };
      return { ack: { sequence: request.sequence, accepted_bytes: 1, resized: false } };
    }
    assert.equal(request.type, 'release');
    assert.equal(request.lease, lease);
    return { terminal: { id: terminal, input_available: true, owner: null } };
  };
  const client = fixture({ choice: 'Attach with input', input: id + ' 12', respond });
  await client.open();
  assert.match(client.confirmations[0], /Transfer input from cli/);
  client.pty().handleInput('y');
  await flush();
  client.close();
  await flush();
  assert.deepEqual(client.entries.filter(operation => operation.type === 'control').map(operation => operation.request.type),
    ['claim', 'input', 'release']);
  assert.equal(client.entries.filter(operation => operation.type === 'read')[1].cursor, 12);
});

test('A failed output poll releases input ownership before the terminal closes', async () => {
  let reads = 0;
  const respond = operation => {
    if (operation.type === 'read') {
      if (++reads > 1) throw new Error('disconnected');
      return interactivePage(operation, null);
    }
    const request = operation.request;
    if (request.type === 'claim') {
      return { lease, terminal: { id: terminal, input_available: true,
        owner: { id: request.owner, client: 'editor', ack: null } } };
    }
    assert.deepEqual(request, { type: 'release', lease });
    return {};
  };
  const client = fixture({ choice: 'Attach with input', input: id, respond });
  await client.open();
  await flush();
  client.close();
  await flush();
  assert.deepEqual(client.entries.filter(operation => operation.type === 'control').map(operation => operation.request.type),
    ['claim', 'release']);
  assert.match(client.output.join(''), /Detached from task/);
});
