const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { userSetting } = require('./editor');

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const accessStates = ['ready', 'paused'];
const runStates = ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'paused', 'revoked'];
const unavailable = () => new Error('Visor terminal task unavailable or access changed.');

function exchange(program, workspace, operation, spawnProcess = spawn) {
  if (![program, workspace].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value))) {
    return Promise.reject(unavailable());
  }
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(program, ['--terminal-task', workspace, 'request'], {
      shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = Buffer.alloc(0);
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(unavailable());
      } else {
        resolve(result);
      }
    }
    const timer = setTimeout(() => finish(true), 7000);
    child.on('error', () => finish(true));
    child.stdin.on('error', () => finish(true));
    child.stdout.on('data', bytes => {
      if (settled) return;
      if (output.length + bytes.length > 65536) return finish(true);
      output = Buffer.concat([output, bytes]);
    });
    child.on('close', code => {
      if (code !== 0) return finish(true);
      try { finish(false, JSON.parse(output.toString('utf8'))); } catch { finish(true); }
    });
    child.stdin.end(JSON.stringify(operation));
  });
}

function contextFor(value) {
  if (!idPattern.test(value?.boot) || !idPattern.test(value?.session) ||
      !digestPattern.test(value?.binding) || !accessStates.includes(value.access)) throw unavailable();
  return value;
}

function scopeFor(scope, type, id) {
  return { type, id, boot: scope.boot, session: scope.session, binding: scope.binding };
}

function pageFor(result, scope, id, cursor) {
  if (result?.id !== id || result.session !== scope.session || !runStates.includes(result.status) ||
      !accessStates.includes(result.access) || typeof result.more !== 'boolean' ||
      typeof result.truncated !== 'boolean' || typeof result.output_base64 !== 'string' ||
      !(result.exit_code === null || Number.isSafeInteger(result.exit_code))) throw unavailable();
  const bytes = Buffer.from(result.output_base64, 'base64');
  if (result.cursor !== cursor + bytes.length || bytes.length > 16384 ||
      bytes.toString('base64') !== result.output_base64 || (result.more && bytes.length === 0)) throw unavailable();
  return { ...result, bytes };
}

function terminalText(value) {
  // Terminal output may contain shell integration or clipboard escape codes.
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\n/g, '\r\n');
}

function terminalFor(value) {
  if (value == null) return null;
  if (!idPattern.test(value.id) || typeof value.input_available !== 'boolean' ||
      (value.owner !== null && (!idPattern.test(value.owner?.id) ||
        !['cli', 'editor'].includes(value.owner.client) ||
        (value.owner.ack !== null && (!Number.isSafeInteger(value.owner.ack?.sequence) ||
          value.owner.ack.sequence < 1))))) throw unavailable();
  return value;
}

function control(scope, id, terminal, operation) {
  return { ...scopeFor(scope, 'control', id), terminal, request: operation };
}

function inputAttachment(grant, send, current, update, notice) {
  const queue = [];
  let lease = grant.lease;
  let sequence = 0;
  let draining = false;
  let dimensions;
  function drop(release) {
    const old = lease;
    lease = undefined;
    queue.length = 0;
    if (old && release && current()) {
      void Promise.resolve().then(() => send({ type: 'release', lease: old })).catch(() => {});
    }
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (lease && queue.length) {
        if (!current()) { drop(false); return; }
        const next = queue.shift();
        const before = lease;
        const wanted = sequence + 1;
        const result = await send({ ...next.action, sequence: wanted, lease: before });
        if (before !== lease) return;
        if (!current()) { drop(false); return; }
        const ack = result?.ack;
        if (ack?.sequence !== wanted || ack.resized !== (next.bytes === undefined)) throw unavailable();
        sequence = wanted;
        update(sequence);
        if (next.bytes !== undefined && ack.accepted_bytes !== next.bytes) {
          notice(`Terminal accepted ${Number.isInteger(ack.accepted_bytes) ? ack.accepted_bytes : '?'} of ${next.bytes} bytes. Attach again to send more input.`);
          drop(true);
        }
      }
    } catch {
      if (lease) {
        notice(`Input detached after acknowledgement ${sequence}. An operation was unconfirmed.`);
        drop(true);
      }
    } finally {
      draining = false;
    }
  }
  function enqueue(action, bytes) {
    if (!lease || !current()) return;
    if (queue.length >= 4) {
      notice('Terminal input queue is full.');
      return;
    }
    queue.push({ action, bytes });
    void drain();
  }
  return {
    input(data) {
      if (!lease || !current()) return;
      const bytes = Buffer.from(data, 'utf8');
      if (bytes.length > 1024) {
        notice('Send at most 1024 bytes of terminal input at a time.');
        return;
      }
      if (bytes.length) enqueue({ type: 'input', data_base64: bytes.toString('base64') }, bytes.length);
    },
    resize(size) {
      if (!lease || !current()) return;
      const rows = size?.rows;
      const cols = size?.columns;
      if (![rows, cols].every(value => Number.isInteger(value) && value >= 1 && value <= 1000) ||
          dimensions === `${rows}:${cols}`) return;
      if (queue.length < 4) dimensions = `${rows}:${cols}`;
      enqueue({ type: 'resize', rows, cols });
    },
    observe(terminal) {
      if (lease && (terminal?.id !== grant.terminal || !terminal.input_available || terminal.owner?.id !== grant.owner)) {
        notice(`Input detached after acknowledgement ${sequence}. Terminal ownership or access changed.`);
        drop(false);
      }
    },
    close() { drop(true); },
    stop() { drop(false); },
  };
}

function attach(vscode, project, scope, id, cursor, request, current, grant) {
  const writes = new vscode.EventEmitter();
  const names = new vscode.EventEmitter();
  const label = `Visor task ${id.slice(0, 8)}`;
  const notice = message => writes.fire(`\r\n[Visor] ${message}\r\n`);
  const input = grant && inputAttachment(grant,
    operation => request(project, control(scope, id, grant.terminal, operation)),
    current, ack => names.fire(`${label} · input here · ack ${ack}`), notice);
  const decoder = new StringDecoder('utf8');
  let closed = false;
  let timer;
  let lastStatus;
  async function poll() {
    try {
      if (!current()) throw unavailable();
      const result = pageFor(await request(project, { ...scopeFor(scope, 'read', id), cursor }), scope, id, cursor);
      if (closed) return;
      if (!current()) throw unavailable();
      const tty = terminalFor(result.terminal);
      const owner = tty?.owner;
      if (tty) {
        const labelOwner = !tty.input_available ? 'input unavailable' :
          owner?.id === grant?.owner && owner ? 'input here' : owner ? `input: ${owner.client}` : 'input unclaimed';
        names.fire(`${label} · ${labelOwner} · ack ${owner?.ack?.sequence ?? 0}`);
      }
      input?.observe(tty);
      cursor = result.cursor;
      writes.fire(terminalText(decoder.write(result.bytes)));
      const status = `${result.status} · access ${result.access}`;
      if (status !== lastStatus) {
        lastStatus = status;
        writes.fire(`\r\n[Visor] ${status}${result.exit_code === null ? '' : ` · exit ${result.exit_code}`}\r\n`);
      }
      if (result.more || result.status === 'running') {
        timer = setTimeout(poll, result.more ? 0 : 250);
      } else {
        writes.fire(terminalText(decoder.end()));
        if (result.truncated) writes.fire('\r\n[Visor] Output reached its limit.\r\n');
      }
    } catch {
      input?.stop();
      if (!closed) writes.fire(`\r\n[Visor] Detached from task ${id} at cursor ${cursor}. Reattach to resume output.\r\n`);
    }
  }
  const pty = {
    onDidWrite: writes.event,
    onDidChangeName: names.event,
    open(dimensions) {
      writes.fire(`Visor task ${id}\r\n`);
      input?.resize(dimensions);
      void poll();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      input?.close();
      writes.dispose();
      names.dispose();
    },
  };
  if (input) {
    pty.handleInput = data => input.input(data);
    pty.setDimensions = size => input.resize(size);
  }
  const terminal = vscode.window.createTerminal({ name: label, pty, isTransient: true });
  terminal.show();
}

function install(vscode, context, call = exchange) {
  function project() {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) return undefined;
    const active = vscode.window.activeTextEditor?.document?.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ??
      (vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined);
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
  }
  function request(workspace, operation) {
    if (project() !== workspace) throw unavailable();
    const executable = userSetting(vscode.workspace.getConfiguration('hypermesh'), 'companionExecutable');
    return call(executable, workspace, operation);
  }
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.terminalTask', async () => {
    let starting;
    try {
      const workspace = project();
      if (!workspace) throw new Error('Open a trusted local workspace to use Visor terminal tasks.');
      const scope = contextFor(await request(workspace, { type: 'context' }));
      if (project() !== workspace) throw unavailable();
      const choices = ['Attach to task', 'Attach with input', 'Cancel task', 'Workspace permissions'];
      if (scope.access === 'ready' && scope.task) choices.unshift('Run declared task');
      const choice = await vscode.window.showQuickPick(choices, {
        title: `Visor terminal · connected · access ${scope.access}`,
        placeHolder: scope.task ? scope.task.command : 'No terminal task declared',
      });
      if (!choice) return;
      if (project() !== workspace) throw unavailable();
      if (choice === 'Workspace permissions') {
        await vscode.commands.executeCommand('hypermesh.permissions');
        return;
      }
      if (choice === 'Run declared task') {
        const task = scope.task;
        if (!digestPattern.test(task.revision) || typeof task.command !== 'string' ||
            typeof task.cwd !== 'string' || !Array.isArray(task.args) || task.environment !== 'clean') throw unavailable();
        const answer = await vscode.window.showWarningMessage('Run the declared Visor terminal task?', {
          modal: true,
          detail: `Workspace: ${workspace}\nDirectory: ${task.cwd}\nCommand: ${JSON.stringify([task.command, ...task.args])}\nEnvironment: clean\nMode: ${task.interactive ? 'interactive' : 'view only'}\nTimeout: ${task.timeout_seconds}s`,
        }, 'Run Task');
        if (answer !== 'Run Task') return;
        starting = randomUUID();
        const value = await request(workspace, {
          ...scopeFor(scope, 'start', starting), revision: task.revision,
        });
        pageFor(value, scope, starting, 0);
        if (project() !== workspace) throw unavailable();
        attach(vscode, workspace, scope, starting, 0, request, () => project() === workspace);
        return;
      }
      const input = await vscode.window.showInputBox({
        prompt: choice === 'Cancel task' ? 'Task ID to cancel' : 'Task ID and optional output cursor',
      });
      if (!input) return;
      const [id, offset, ...extra] = input.trim().split(/\s+/);
      const cursor = offset === undefined ? 0 : Number(offset);
      if (!idPattern.test(id) || extra.length || !Number.isSafeInteger(cursor) || cursor < 0 ||
          (offset !== undefined && (choice === 'Cancel task' || !/^\d+$/.test(offset)))) {
        throw new Error('Enter a valid task ID and output cursor.');
      }
      if (project() !== workspace) throw unavailable();
      if (choice === 'Attach with input') {
        const read = { ...scopeFor(scope, 'read', id), cursor };
        const page = pageFor(await request(workspace, read), scope, id, cursor);
        const tty = terminalFor(page.terminal);
        if (!tty?.input_available || page.status !== 'running') throw new Error('Interactive input is unavailable for this task.');
        if (project() !== workspace) throw unavailable();
        const transfer = tty.owner ? `Transfer input from ${tty.owner.client} to this VS Code terminal?` :
          'Enable input for this Visor task?';
        const answer = await vscode.window.showWarningMessage(transfer, { modal: true, detail: `Task ${id}` }, 'Enable Input');
        if (answer !== 'Enable Input') return;
        const owner = randomUUID();
        const result = await request(workspace, control(scope, id, tty.id, {
          type: 'claim', owner, client: 'editor', expected_owner: tty.owner?.id ?? null,
        }));
        if (project() !== workspace || !idPattern.test(result?.lease) ||
            terminalFor(result.terminal)?.owner?.id !== owner) throw unavailable();
        attach(vscode, workspace, scope, id, cursor, request, () => project() === workspace, {
          terminal: tty.id, owner, lease: result.lease,
        });
      } else if (choice === 'Attach to task') {
        attach(vscode, workspace, scope, id, cursor, request, () => project() === workspace);
      } else {
        const result = pageFor(await request(workspace, scopeFor(scope, 'cancel', id)), scope, id, 0);
        if (project() !== workspace) throw unavailable();
        vscode.window.showInformationMessage(result.status === 'running' ?
          `Cancellation requested for task ${id}.` : `Task ${id} is ${result.status}.`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(starting ?
        `Visor could not confirm task ${starting}. Attach by ID before trying again.` : error.message);
    }
  }));
}

module.exports = { exchange, install, inputAttachment, pageFor, terminalText };
