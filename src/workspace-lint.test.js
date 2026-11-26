const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { diagnosticsFor, exchange, install } = require('./workspace-lint');

const workspace = '/assigned/project';
const file = 'sample.json';
const text = '{"x":1,\n "x":2}\n';
const report = {
  file,
  runtime: 'local-stdio',
  linter_version: '0.1.0',
  config: 'json-strict-v1',
  display_sha256: createHash('sha256').update(text).digest('hex'),
  diagnostics: [{ line: 2, column: 2, rule: 'duplicate-key', severity: 'warning', message: 'Duplicate JSON object key' }],
  truncated: false,
};

function fixture(call) {
  let run, activeChanged, foldersChanged, edited, closed, cancel;
  const shown = [];
  const errors = [];
  const statuses = [];
  const uri = { scheme: 'file', fsPath: workspace + '/' + file };
  const document = {
    uri, version: 1, isDirty: false, lineCount: 3,
    getText: () => text,
    lineAt: line => ({ text: text.split('\n')[line] }),
  };
  const options = { dispose() {} };
  const editor = {
    env: {},
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    Range: class { constructor(...range) { this.coordinates = range; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    ProgressLocation: { Notification: 1 },
    languages: { createDiagnosticCollection: () => ({
      clear: () => { shown.length = 0; },
      set: (uri, values) => shown.push({ uri, values }),
      dispose() {},
    }) },
    workspace: {
      isTrusted: true,
      getWorkspaceFolder: () => ({ uri: { scheme: 'file', fsPath: workspace } }),
      getConfiguration: () => ({ inspect: () => ({ globalValue: '/installed/companion', workspaceValue: '/project/ignored' }) }),
      onDidChangeWorkspaceFolders: callback => { foldersChanged = callback; return options; },
      onDidChangeTextDocument: callback => { edited = callback; return options; },
      onDidCloseTextDocument: callback => { closed = callback; return options; },
    },
    commands: { registerCommand: (id, callback) => { assert.equal(id, 'hypermesh.lintFile'); run = callback; return options; } },
    window: {
      activeTextEditor: { document },
      onDidChangeActiveTextEditor: callback => { activeChanged = callback; return options; },
      withProgress: (_options, task) => task({}, {
        isCancellationRequested: false,
        onCancellationRequested: callback => { cancel = callback; return options; },
      }),
      setStatusBarMessage: message => { statuses.push(message); return options; },
      showErrorMessage: message => errors.push(message),
    },
  };
  install(editor, { subscriptions: [] }, call);
  return {
    editor, document, run, shown, errors, statuses,
    cancel: () => cancel(),
    changeFolder: () => foldersChanged(),
    changeEditor: () => activeChanged(),
    edit: () => edited({ document }),
    close: () => closed(document),
  };
}

test('the CLI contract fixture renders the same file, position, rule, and severity in Problems', async () => {
  const view = fixture(async (exe, project, relative) => {
    assert.deepEqual([exe, project, relative], ['/installed/companion', workspace, file]);
    return report;
  });
  await view.run();
  assert.deepEqual(view.shown.map(({ uri, values }) => [uri, values.map(d => [d.range.coordinates, d.code, d.message, d.severity])]), [
    [view.document.uri, [[[1, 1, 1, 2], 'duplicate-key', 'Duplicate JSON object key', 1]]],
  ]);
  assert.match(view.statuses[0], /0\.1\.0 · local-stdio · json-strict-v1 · 1 finding/);
  view.edit();
  assert.deepEqual(view.shown, []);
  await view.run();
  assert.equal(view.shown.length, 1);
  view.close();
  assert.deepEqual(view.shown, []);
});

test('cancellation, a workspace switch, or an edit aborts the request and discards a late report', async () => {
  for (const event of ['cancel', 'changeFolder', 'changeEditor', 'edit']) {
    let complete, signal;
    const view = fixture((_exe, _project, _relative, abort) => {
      signal = abort;
      return new Promise(resolve => { complete = resolve; });
    });
    const pending = view.run();
    view[event]();
    assert.equal(signal.aborted, true, event);
    complete(report);
    await pending;
    assert.deepEqual(view.shown, [], event);
  }
});

test('a document mismatch cannot be published and a denial clears displayed findings', async () => {
  let allowed = true;
  const view = fixture(async () => {
    if (!allowed) throw new Error('Workspace read admission was unavailable or refused');
    return report;
  });
  const { editor, document } = view;
  assert.throws(() => diagnosticsFor(editor, document, file, { ...report, file: '../sample.json' }));
  assert.throws(() => diagnosticsFor(editor, { ...document, getText: () => 'changed' }, file, report), /saved file changed/);
  await view.run();
  assert.equal(view.shown.length, 1);
  allowed = false;
  await view.run();
  assert.deepEqual(view.shown, []);
  assert.match(view.errors[0], /refused/);
});

test('the companion uses fixed arguments and distinguishes findings from access errors', async () => {
  function spawnResponse(value, exit) {
    return (executable, args, options) => {
      assert.equal(executable, '/installed/companion');
      assert.deepEqual(args, ['--workspace-lint', workspace, file]);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(value)));
        child.emit('close', exit);
      });
      return child;
    };
  }
  const call = (value, code) => exchange('/installed/companion', workspace, file, new AbortController().signal, spawnResponse(value, code));
  assert.deepEqual(await call({ result: report }, 1), report);
  await assert.rejects(call({ error: { message: 'Enable the JSON lint plugin for the selected session and file' } }, 2), /Enable the JSON lint plugin/);
  await assert.rejects(call({ result: report }, 0), /linter unavailable/);

  const controller = new AbortController();
  let killed = false;
  const pending = exchange('/installed/companion', workspace, file, controller.signal, () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { killed = true; };
    return child;
  });
  controller.abort();
  await assert.rejects(pending, /linter unavailable/);
  assert.equal(killed, true);
});
