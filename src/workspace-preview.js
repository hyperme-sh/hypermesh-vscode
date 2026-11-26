const integratedBrowser = 'workbench.action.browser.open';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error('Visor workspace preview is unavailable or access changed.');

function loopback(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash) throw unavailable();
  return url;
}

async function showPreview(vscode, { choice, workspace, remote, scope, id, port, request, current }) {
  if (scope.workspace !== workspace || !uuid.test(scope.device_id)) throw unavailable();
  const send = (type, extra) => request({
    type, boot: scope.boot, session: scope.session, binding: scope.binding, id, port, ...extra,
  });
  const validate = (value, state) => {
    if (!current() || value?.boot !== scope.boot || value.session !== scope.session ||
        value.device_id !== scope.device_id || value.workspace !== workspace || value.id !== id ||
        value.port !== port || (state && value.state !== state) ||
        (value.state === 'open' && !uuid.test(value.preview_id))) throw unavailable();
    return value;
  };
  if (choice === 'Close workspace preview') {
    const preview = validate(await send('preview_context'));
    if (preview.state === 'open') {
      validate(await send('preview_close', { preview_id: preview.preview_id }), 'eligible');
    }
    vscode.window.showInformationMessage('Visor workspace preview closed.');
    return;
  }

  if (!(await vscode.commands.getCommands(true)).includes(integratedBrowser)) {
    throw new Error('The VS Code integrated browser is unavailable.');
  }
  if (remote && (remote !== 'ssh-remote' || typeof vscode.env.asExternalUri !== 'function')) {
    throw new Error('Private forwarding is unavailable for this workspace.');
  }
  const answer = await vscode.window.showWarningMessage('Open the authorized Visor workspace preview?', {
    modal: true, detail: `Device ${scope.device_id}\nWorkspace ${workspace}\nDevelopment port ${port}`,
  }, 'Open Preview');
  if (answer !== 'Open Preview') return;
  if (!current()) throw unavailable();

  const grant = validate(await send('preview_open'), 'open');
  const source = loopback(grant.url);
  if (source.hostname !== '127.0.0.1' || Number(source.port) === port ||
      !/^\/[a-f0-9]{32}\/$/.test(source.pathname)) throw unavailable();
  let origin = source.origin;
  if (remote) {
    const mapped = await vscode.env.asExternalUri(vscode.Uri.parse(origin));
    const forwarded = loopback(mapped.toString());
    if (forwarded.pathname !== '/' || Number(forwarded.port) === port) throw unavailable();
    origin = forwarded.origin;
  }
  const active = validate(await send('preview_context'), 'open');
  if (active.preview_id !== grant.preview_id) throw unavailable();
  await vscode.commands.executeCommand(integratedBrowser, origin + source.pathname);
  vscode.window.showInformationMessage(`Visor preview ${grant.preview_id} on device ${scope.device_id} · port ${port}`);
}

module.exports = { showPreview };
