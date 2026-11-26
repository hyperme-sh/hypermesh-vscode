const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { userSetting } = require('./editor');

const digest = /^[0-9a-f]{64}$/;
const rules = new Set(['json-syntax', 'json-encoding', 'duplicate-key']);
const unavailable = () => new Error('Visor workspace linter unavailable. Check the installed companion and selected session.');

function exchange(program, workspace, file, signal, spawnProcess = spawn) {
  if (typeof program !== 'string' || !path.isAbsolute(program) || /[\p{Cc}]/u.test(program)) {
    return Promise.reject(new Error('Set the installed hypermesh-companion path in user settings.'));
  }
  if (signal.aborted) return Promise.reject(unavailable());
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'HYPERMESH_RUNTIME_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(program, ['--workspace-lint', workspace, file], {
      shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = Buffer.alloc(0);
    let settled = false;
    function finish(error, result, stop) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (stop) child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function abort() {
      finish(unavailable(), undefined, true);
    }
    const timer = setTimeout(abort, 20000);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', abort);
    child.stdout.on('data', bytes => {
      if (settled) return;
      if (output.length + bytes.length > 16384) return abort();
      output = Buffer.concat([output, bytes]);
    });
    child.on('close', code => {
      let response;
      try { response = JSON.parse(output.toString('utf8')); } catch { return finish(unavailable()); }
      const message = response?.error?.message;
      if (code === 2 && typeof message === 'string' && message.length <= 240 && !/[\p{Cc}]/u.test(message)) {
        return finish(new Error(message));
      }
      if (![0, 1].includes(code) || !Array.isArray(response?.result?.diagnostics) ||
          (code === 0) !== (response.result.diagnostics.length === 0)) return finish(unavailable());
      finish(undefined, response.result);
    });
  });
}

function diagnosticsFor(vscode, document, file, report) {
  if (report?.file !== file || report.runtime !== 'local-stdio' || report.config !== 'json-strict-v1' ||
      typeof report.linter_version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(report.linter_version) ||
      typeof report.display_sha256 !== 'string' || !digest.test(report.display_sha256) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length > 32 ||
      typeof report.truncated !== 'boolean' || (report.truncated && report.diagnostics.length !== 32)) throw unavailable();
  const text = document.getText().replace(/\r\n?/g, '\n');
  if (createHash('sha256').update(text).digest('hex') !== report.display_sha256) {
    throw new Error('The saved file changed. Reopen or save it before linting again.');
  }
  return report.diagnostics.map(item => {
    if (!rules.has(item?.rule) || !Number.isInteger(item.line) || item.line < 1 ||
        item.line > document.lineCount || !Number.isInteger(item.column) || item.column < 1 ||
        !['warning', 'error'].includes(item.severity) || typeof item.message !== 'string' ||
        item.message.length > 120 || /[\p{Cc}]/u.test(item.message)) throw unavailable();
    const line = item.line - 1;
    const column = item.column - 1;
    const lineText = document.lineAt(line).text;
    if (column > lineText.length) throw unavailable();
    const codePoint = lineText.codePointAt(column);
    const width = codePoint === undefined ? 0 : codePoint > 0xffff ? 2 : 1;
    const range = new vscode.Range(line, column, line, column + width);
    const severity = item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, item.message, severity);
    diagnostic.source = 'Visor JSON lint';
    diagnostic.code = item.rule;
    return diagnostic;
  });
}

function install(vscode, context, call = exchange) {
  const collection = vscode.languages.createDiagnosticCollection('visor-json-lint');
  let active;
  let displayed;
  let status;
  function clear() {
    active?.abort();
    active = undefined;
    displayed = undefined;
    status?.dispose();
    status = undefined;
    collection.clear();
  }
  context.subscriptions.push(
    { dispose: clear },
    collection,
    vscode.window.onDidChangeActiveTextEditor(clear),
    vscode.workspace.onDidChangeWorkspaceFolders(clear),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document === displayed) clear();
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document === displayed) clear();
    }),
    vscode.commands.registerCommand('hypermesh.lintFile', async () => {
      clear();
      const document = vscode.window.activeTextEditor?.document;
      const folder = document && vscode.workspace.getWorkspaceFolder(document.uri);
      if (process.platform !== 'linux' || !vscode.workspace.isTrusted || vscode.env.remoteName ||
          document?.uri.scheme !== 'file' || folder?.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('Open a trusted local Linux workspace and select a saved JSON file.');
        return;
      }
      const workspace = folder.uri.fsPath;
      const file = path.relative(workspace, document.uri.fsPath);
      if (!file.endsWith('.json') || file.split('/').some(part => ['', '.', '..'].includes(part)) ||
          path.isAbsolute(file) || /[\\*?\p{Cc}]/u.test(file) || document.isDirty) {
        vscode.window.showErrorMessage('Select a saved .json file inside the assigned workspace.');
        return;
      }
      const executable = userSetting(vscode.workspace.getConfiguration('hypermesh'), 'companionExecutable');
      const request = new AbortController();
      const version = document.version;
      active = request;
      displayed = document;
      const current = () => active === request && !request.signal.aborted &&
        vscode.workspace.isTrusted && !vscode.env.remoteName && !document.isDirty && document.version === version &&
        document === vscode.window.activeTextEditor?.document &&
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath === workspace;
      try {
        const report = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification, title: 'Visor JSON lint', cancellable: true,
        }, async (_progress, token) => {
          const cancellation = token.onCancellationRequested(() => {
            if (active === request) clear();
          });
          try {
            if (token.isCancellationRequested || !current()) return undefined;
            return await call(executable, workspace, file, request.signal);
          } finally {
            cancellation.dispose();
          }
        });
        if (!report || !current()) return;
        const diagnostics = diagnosticsFor(vscode, document, file, report);
        collection.set(document.uri, diagnostics);
        status = vscode.window.setStatusBarMessage(
          `Visor JSON lint ${report.linter_version} · ${report.runtime} · ${report.config} · ${diagnostics.length} ${diagnostics.length === 1 ? 'finding' : 'findings'}${report.truncated ? ' (limit reached)' : ''}`,
          10000,
        );
      } catch (error) {
        if (current()) vscode.window.showErrorMessage(error.message);
      } finally {
        if (active === request) active = undefined;
      }
    }),
  );
}

module.exports = { diagnosticsFor, exchange, install };
