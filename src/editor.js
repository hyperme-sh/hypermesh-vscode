const path = require('node:path');
const { spawn } = require('node:child_process');
const { chat } = require('./acp');

function userSetting(config, name) {
  const entry = config.inspect(name);
  // Repository/workspace settings never select an executable or credential peer.
  return entry?.globalValue ?? entry?.defaultValue ?? '';
}
function smokeSettings(config) {
  const apiBase = userSetting(config, 'apiBase');
  let url; try { url = new URL(apiBase); } catch { throw new Error('Set a trusted HTTPS chat host in user settings.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Stored keys require a trusted HTTPS chat host in user settings.');
  return { apiBase, tenant: userSetting(config, 'tenant') };
}
function install(vscode, context) {
  let active;
  const trusted = () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching Visor.'); };
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.chat', async () => {
    try {
      trusted(); if (active) throw new Error('A Visor turn is already active. Cancel it before starting another.');
      const folders = vscode.workspace.workspaceFolders || [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder || folder.uri.scheme !== 'file') throw new Error('Select a local project folder.');
      const prompt = await vscode.window.showInputBox({ prompt: 'Prompt for the assigned Visor session', ignoreFocusOut: true });
      if (!prompt) return;
      // A second command may have started while the input box was open.
      if (active) throw new Error('A Visor turn is already active.');
      const config = vscode.workspace.getConfiguration('hypermesh');
      const controller = new AbortController(); active = controller;
      try {
        const answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Visor through Conductor', cancellable: true }, async (_, cancellation) => {
          const listener = cancellation.onCancellationRequested(() => controller.abort());
          try {
            return await chat({ executable: userSetting(config, 'acpExecutable'), socket: userSetting(config, 'visorSocket'), cwd: folder.uri.fsPath, prompt, signal: controller.signal });
          } finally { listener.dispose(); }
        });
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: answer });
        await vscode.window.showTextDocument(document, { preview: true });
      } finally { if (active === controller) active = undefined; }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Visor request unavailable.');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.cancel', () => active?.abort()));
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.attachTools', async () => {
    try {
      trusted();
      const executable = userSetting(vscode.workspace.getConfiguration('hypermesh'), 'companionExecutable');
      if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) throw new Error('Set the installed companion path in user settings first.');
      const child = spawn(executable, ['--mcp-connections'], { shell: false, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => vscode.window.showErrorMessage('Visor tool manager unavailable.'));
      child.on('exit', code => { if (code !== 0) vscode.window.showErrorMessage('Visor tool manager did not complete.'); });
    } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Visor tool manager unavailable.'); }
  }));
  context.subscriptions.push({ dispose() { active?.abort(); } });
}
module.exports = { install, userSetting, smokeSettings };
