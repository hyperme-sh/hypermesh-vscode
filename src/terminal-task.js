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

function attach(vscode, project, scope, id, cursor, request, current) {
  const writes = new vscode.EventEmitter();
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
      if (!closed) writes.fire(`\r\n[Visor] Detached from task ${id} at cursor ${cursor}. Reattach to resume output.\r\n`);
    }
  }
  const pty = {
    onDidWrite: writes.event,
    open() {
      writes.fire(`Visor task ${id}\r\n`);
      void poll();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      writes.dispose();
    },
  };
  const terminal = vscode.window.createTerminal({ name: `Visor task ${id.slice(0, 8)}`, pty, isTransient: true });
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
      const choices = ['Attach to task', 'Cancel task', 'Workspace permissions'];
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
          detail: `Workspace: ${workspace}\nDirectory: ${task.cwd}\nCommand: ${JSON.stringify([task.command, ...task.args])}\nEnvironment: clean\nTimeout: ${task.timeout_seconds}s`,
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
        prompt: choice === 'Attach to task' ? 'Task ID and optional output cursor' : 'Task ID to cancel',
      });
      if (!input) return;
      const [id, offset, ...extra] = input.trim().split(/\s+/);
      const cursor = offset === undefined ? 0 : Number(offset);
      if (!idPattern.test(id) || extra.length || !Number.isSafeInteger(cursor) || cursor < 0 ||
          (offset !== undefined && (choice === 'Cancel task' || !/^\d+$/.test(offset)))) {
        throw new Error('Enter a valid task ID and output cursor.');
      }
      if (project() !== workspace) throw unavailable();
      if (choice === 'Attach to task') {
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

module.exports = { exchange, install, pageFor, terminalText };
