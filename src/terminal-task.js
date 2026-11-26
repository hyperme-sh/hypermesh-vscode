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

function exchange(program, workspace, operation, device, spawnProcess = spawn) {
  if (![program, workspace].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value))) {
    return Promise.reject(unavailable());
  }
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'HYPERMESH_RUNTIME_DIR', 'WSL_DISTRO_NAME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const args = ['--terminal-task', workspace];
    if (device) args.push('--host', device);
    args.push('request');
    const child = spawnProcess(program, args, {
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
  return {
    input(data) {
      if (!lease || !current()) return;
      const bytes = Buffer.from(data, 'utf8');
      if (bytes.length > 1024) {
        notice('Send at most 1024 bytes of terminal input at a time.');
        return;
      }
      if (!bytes.length) return;
      if (queue.length >= 4) {
        notice('Terminal input queue is full.');
        return;
      }
      queue.push({ action: { type: 'input', data_base64: bytes.toString('base64') }, bytes: bytes.length });
      void drain();
    },
    resize(size) {
      if (!lease || !current()) return;
      const rows = size?.rows;
      const cols = size?.columns;
      if (![rows, cols].every(value => Number.isInteger(value) && value >= 1 && value <= 1000) ||
          dimensions === `${rows}:${cols}`) return;
      dimensions = `${rows}:${cols}`;
      const next = { action: { type: 'resize', rows, cols } };
      // Keep one slot for the latest resize after any queued keystrokes.
      if (queue.at(-1)?.action.type === 'resize') {
        queue[queue.length - 1] = next;
      } else {
        queue.push(next);
      }
      void drain();
    },
    observe(terminal) {
      if (lease && (terminal?.id !== grant.terminal || !terminal.input_available || terminal.owner?.id !== grant.owner)) {
        notice(`Input detached after acknowledgement ${sequence}. Terminal ownership or access changed.`);
        drop(false);
      }
    },
    close() { drop(true); },
  };
}

function attach(vscode, scope, id, cursor, request, current, grant) {
  const writes = new vscode.EventEmitter();
  const names = new vscode.EventEmitter();
  const label = `Visor task ${id.slice(0, 8)}`;
  const notice = message => writes.fire(`\r\n[Visor] ${message}\r\n`);
  const input = grant && inputAttachment(grant,
    operation => request(control(scope, id, grant.terminal, operation)),
    current, ack => names.fire(`${label} · input here · ack ${ack}`), notice);
  const decoder = new StringDecoder('utf8');
  let closed = false;
  let timer;
  let lastStatus;
  async function poll() {
    try {
      if (!current()) throw unavailable();
      const result = pageFor(await request({ ...scopeFor(scope, 'read', id), cursor }), scope, id, cursor);
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
      input?.close();
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

function install(vscode, context, call = exchange, runtime = {
  platform: process.platform, distro: process.env.WSL_DISTRO_NAME,
}) {
  function activeDistro() {
    const name = runtime.distro;
    if (typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name) > 1024 ||
        name.trim() !== name || /[\/\\\p{Cc}]/u.test(name)) {
      throw new Error('The active WSL distribution could not be identified.');
    }
    return name;
  }
  function linuxPath(value) {
    return value.startsWith('/') && !value.startsWith('//') && !/^\/[a-z]:/i.test(value) &&
      !/[\\\p{Cc}]/u.test(value);
  }
  function project() {
    const remote = vscode.env.remoteName;
    if (!vscode.workspace.isTrusted || (remote && !['wsl', 'ssh-remote'].includes(remote))) return undefined;
    if (remote && (runtime.platform !== 'linux' || !vscode.ExtensionKind ||
        context.extension?.extensionKind !== vscode.ExtensionKind.Workspace)) {
      const location = remote === 'wsl' ? 'WSL' : 'Remote SSH';
      throw new Error(`Run the Hypermesh extension in the active ${location} workspace host.`);
    }
    const active = vscode.window.activeTextEditor?.document?.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ??
      (vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined);
    if (folder?.uri.scheme !== 'file') return undefined;
    const workspace = folder.uri.fsPath;
    if (remote && (folder.uri.authority || !linuxPath(workspace))) {
      throw new Error('Use the Linux workspace path inside the active remote workspace host.');
    }
    const distro = remote === 'wsl' ? activeDistro() : undefined;
    let device;
    if (remote === 'ssh-remote') {
      const configured = userSetting(vscode.workspace.getConfiguration('hypermesh'), 'terminalHostDeviceId');
      device = typeof configured === 'string' ? configured.toLowerCase() : '';
      if (!idPattern.test(device) || device === '00000000-0000-0000-0000-000000000000') {
        throw new Error('Set the enrolled Visor device ID in Hypermesh Remote Settings.');
      }
    }
    return { workspace, distro, device, remote };
  }
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.terminalTask', async () => {
    let starting;
    try {
      const target = project();
      if (!target) {
        const location = vscode.env.remoteName === 'wsl' ? 'WSL' :
          vscode.env.remoteName === 'ssh-remote' ? 'Remote SSH' : 'local';
        throw new Error(`Open a trusted ${location} workspace to use Visor terminal tasks.`);
      }
      const { workspace, distro, device, remote } = target;
      const current = () => {
        try {
          const active = project();
          return active?.workspace === workspace && active.distro === distro &&
            active.device === device && active.remote === remote;
        } catch {
          return false;
        }
      };
      const location = distro ? `WSL ${distro}` : device ? `SSH device ${device}` : undefined;
      const request = operation => {
        if (!current()) throw unavailable();
        const executable = userSetting(vscode.workspace.getConfiguration('hypermesh'), 'companionExecutable');
        const pending = call(executable, workspace, operation, device);
        return location ? pending.catch(() => {
          throw new Error(`Visor unavailable ${distro ? 'in' : 'on'} ${location} for ${workspace}. Check the companion and selected session on that host.`);
        }) : pending;
      };
      const scope = contextFor(await request({ type: 'context' }));
      if (distro && (scope.wsl_distro !== distro || scope.workspace !== workspace)) {
        throw new Error('Visor reported a different WSL distribution or workspace.');
      }
      if (device && (scope.device_id !== device || scope.workspace !== workspace)) {
        throw new Error('Visor reported a different enrolled device or workspace.');
      }
      if (!current()) throw unavailable();
      const choices = ['Attach to task', 'Attach with input', 'Cancel task', 'Workspace permissions'];
      if (scope.access === 'ready' && scope.task) choices.unshift('Run declared task');
      const choice = await vscode.window.showQuickPick(choices, {
        title: location ? `Visor terminal · ${location} · ${workspace} · access ${scope.access}` :
          `Visor terminal · connected · access ${scope.access}`,
        placeHolder: scope.task ? scope.task.command : 'No terminal task declared',
      });
      if (!choice) return;
      if (!current()) throw unavailable();
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
          detail: `${location ? `${location}\n` : ''}Workspace: ${workspace}\nDirectory: ${task.cwd}\nCommand: ${JSON.stringify([task.command, ...task.args])}\nEnvironment: clean\nMode: ${task.interactive ? 'interactive' : 'view only'}\nTimeout: ${task.timeout_seconds}s`,
        }, 'Run Task');
        if (answer !== 'Run Task') return;
        starting = randomUUID();
        const value = await request({
          ...scopeFor(scope, 'start', starting), revision: task.revision,
        });
        pageFor(value, scope, starting, 0);
        if (!current()) throw unavailable();
        attach(vscode, scope, starting, 0, request, current);
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
      if (!current()) throw unavailable();
      if (choice === 'Attach with input') {
        const read = { ...scopeFor(scope, 'read', id), cursor };
        const page = pageFor(await request(read), scope, id, cursor);
        const tty = terminalFor(page.terminal);
        if (!tty?.input_available || page.status !== 'running') throw new Error('Interactive input is unavailable for this task.');
        if (!current()) throw unavailable();
        const transfer = tty.owner ? `Transfer input from ${tty.owner.client} to this VS Code terminal?` :
          'Enable input for this Visor task?';
        const answer = await vscode.window.showWarningMessage(transfer, { modal: true, detail: `Task ${id}` }, 'Enable Input');
        if (answer !== 'Enable Input') return;
        const owner = randomUUID();
        const result = await request(control(scope, id, tty.id, {
          type: 'claim', owner, client: 'editor', expected_owner: tty.owner?.id ?? null,
        }));
        if (!current() || !idPattern.test(result?.lease) ||
            terminalFor(result.terminal)?.owner?.id !== owner) throw unavailable();
        attach(vscode, scope, id, cursor, request, current, {
          terminal: tty.id, owner, lease: result.lease,
        });
      } else if (choice === 'Attach to task') {
        attach(vscode, scope, id, cursor, request, current);
      } else {
        const result = pageFor(await request(scopeFor(scope, 'cancel', id)), scope, id, 0);
        if (!current()) throw unavailable();
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
