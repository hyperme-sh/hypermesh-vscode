const path = require('node:path');
const { spawn } = require('node:child_process');
const { userSetting } = require('./editor');

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const zero = '00000000-0000-0000-0000-000000000000';
const identifiers = ['device_id', 'task_id', 'lease_id'];
const keys = [...identifiers, 'worker_generation', 'workspace'];
const fail = () => new Error('Cloud workspace lease is unavailable or changed.');

function selection(vscode, context) {
  const remote = vscode.env.remoteName;
  if (!vscode.workspace.isTrusted || (remote && remote !== 'ssh-remote') ||
      context.extension?.extensionKind !== vscode.ExtensionKind.Workspace) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor?.document?.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ??
    (folders.length === 1 ? folders[0] : undefined);
  const uri = folder?.uri;
  if (!uri || uri.scheme !== 'file' || uri.authority || !uri.fsPath.startsWith('/') ||
      uri.fsPath.startsWith('//') || /[\\\p{Cc}]/u.test(uri.fsPath)) return undefined;
  const config = vscode.workspace.getConfiguration('hypermesh');
  const selected = userSetting(config, 'cloudWorkspaceTask');
  if (!selected || !identifiers.every(key => uuid.test(selected[key]) && selected[key] !== zero) ||
      !Number.isSafeInteger(selected.worker_generation) || selected.worker_generation < 1 ||
      typeof selected.executable !== 'string' || !path.isAbsolute(selected.executable) ||
      /[\r\n\0]/.test(selected.executable)) return undefined;
  const scope = Object.fromEntries(identifiers.map(key => [key, selected[key]]));
  return { executable: selected.executable, scope: {
    ...scope, worker_generation: selected.worker_generation, workspace: uri.fsPath,
  } };
}

function exchange(executable, scope, request, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'HYPERMESH_RUNTIME_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawnProcess(executable, ['workspace-task', 'request', scope.workspace], {
      shell: false, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let data = Buffer.alloc(0), settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (result) resolve(result);
      else { child.kill(); reject(fail()); }
    };
    const timeout = setTimeout(() => finish(), 5000);
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', bytes => {
      if (settled) return;
      if (data.length + bytes.length > 16384) finish();
      else data = Buffer.concat([data, bytes]);
    });
    child.on('close', code => {
      if (code !== 0) return finish();
      try { finish(JSON.parse(data.toString('utf8'))); } catch { finish(); }
    });
    child.stdin.end(JSON.stringify({ ...scope, ...request }));
  });
}

function validate(value, scope, cursor) {
  if (value?.version !== 1 || !keys.every(key => scope[key] === value[key]) ||
      !Number.isSafeInteger(value.expires_at_ms) || value.expires_at_ms <= Date.now() ||
      value.tool !== 'check-json' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.target) ||
      !['ready', 'running', 'completed', 'failed'].includes(value.state) ||
      typeof value.output !== 'string' || /\p{Cc}/u.test(value.output.replaceAll('\n', '')) ||
      value.cursor !== cursor + Buffer.byteLength(value.output, 'utf8')) throw fail();
  return value;
}

function install(vscode, context, call = exchange, platform = process.platform) {
  let disposed = false, attached = false, channel;
  context.subscriptions.push({ dispose() { disposed = true; channel?.dispose(); } });
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.cloudWorkspace', async () => {
    if (attached || disposed) return;
    attached = true;
    try {
      const selected = platform === 'linux' ? selection(vscode, context) : undefined;
      if (!selected) throw new Error('Open the trusted Linux worker workspace and select a cloud task in User or Remote Settings.');
      const { executable, scope } = selected;
      const request = async (operation, cursor = 0) => {
        const matches = () => {
          const current = selection(vscode, context);
          return !disposed && current?.executable === executable &&
            keys.every(key => current.scope[key] === scope[key]);
        };
        if (!matches()) throw fail();
        const result = validate(await call(executable, scope, { operation, cursor }), scope, cursor);
        if (!matches()) throw fail();
        return result;
      };
      const task = await request('inspect');
      const title = `Cloud worker ${task.device_id} · generation ${task.worker_generation} · task ${task.task_id}`;
      const detail = `${task.workspace} · lease ${task.lease_id} · expires ${new Date(task.expires_at_ms).toISOString()}`;
      const options = [{ label: 'Inspect task', detail }, { label: 'Attach to output', detail }];
      if (task.state === 'ready') options.push({ label: 'Run declared workspace tool', detail: `${task.tool} ${task.target}` });
      const choice = await vscode.window.showQuickPick(options, { title });
      if (!choice || choice.label === 'Inspect task') return;
      if (choice.label === 'Run declared workspace tool') {
        const approved = await vscode.window.showWarningMessage('Run the admitted workspace tool?', {
          modal: true, detail: `${title}\n${detail}\n${task.tool} ${task.target}`,
        }, 'Run Tool');
        if (approved !== 'Run Tool') return;
        await request('invoke');
      }
      let cursor = 0;
      channel ??= vscode.window.createOutputChannel('Visor Cloud Workspace');
      channel.clear();
      channel.appendLine(title);
      channel.appendLine(detail);
      channel.show(true);
      for (;;) {
        const page = await request('read', cursor);
        channel.append(page.output);
        cursor = page.cursor;
        if (page.state !== 'running') {
          channel.appendLine(`Task ${scope.task_id} · ${page.state}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } catch (error) {
      if (!disposed) vscode.window.showErrorMessage(error.message);
    } finally {
      attached = false;
    }
  }));
}

module.exports = { install, validate };
