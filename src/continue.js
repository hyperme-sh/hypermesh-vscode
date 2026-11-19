const path = require('node:path');
const {randomUUID} = require('node:crypto');
const { spawn } = require('node:child_process');
const { userSetting } = require('./editor');
const fail = () => new Error('Continue task unavailable. Refresh owner status before retrying.');
function args(executable, workspace, action) {
  if (![executable, workspace].every(v => typeof v === 'string' && path.isAbsolute(v) && !/[\r\n\0]/.test(v)) || !['status','control','open','advice'].includes(action)) throw fail();
  return [executable, [action === 'open' ? '--continue-workspace' : `--continue-${action}-workspace`, workspace]];
}
function exchange(executable, workspace, control, spawnProcess = spawn) {
  const [program, argv] = args(executable, workspace, control === 'advice' ? 'advice' : control ? 'control' : 'status');
  if (control && control !== 'advice' && (!['continue-on','continue-off','pause','stop','resume','restart','reassign','retire'].includes(control.action) || !Number.isSafeInteger(control.revision) || control.revision < 1 || typeof control.run_id !== 'string')) return Promise.reject(fail());
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
    const child = spawnProcess(program, argv, { shell: false, windowsHide: true, env, stdio: ['pipe','pipe','pipe'] });
    let raw = Buffer.alloc(0), done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); child.kill(); error ? reject(fail()) : resolve(result); };
    const timer = setTimeout(() => finish(true), 20000);
    child.on('error', () => finish(true)); child.stdin.on('error', () => finish(true));
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => { if (done) return; raw = Buffer.concat([raw, bytes]); if (raw.length > 131072) finish(true); });
    child.on('close', code => {
      if (code !== 0) return finish(true);
      try { const value = JSON.parse(raw.toString('utf8')); if (control === 'advice') { if (value.workspace !== workspace || !['continue','checkpoint-compact','restart','reassign','retire'].includes(value.action) || typeof value.handoff !== 'object') throw fail(); return finish(false,value); } if (!Object.hasOwn(value, 'run') || (value.run !== null && (typeof value.run.id !== 'string' || value.run.workspace !== workspace || !Number.isSafeInteger(value.run.revision)))) throw fail(); finish(false, value); } catch { finish(true); }
    });
    child.stdin.end(control && control !== 'advice' ? JSON.stringify(control) : '');
  });
}
function label(run) { return run ? `Continue ${run.continue_enabled ? 'on' : 'off'} · ${run.state} · ${run.used_chunks}/${(run.budgets?.chunks ?? 0) * (1 + (run.execution?.max_repairs ?? 0))} attempts` : 'Continue: no selected task'; }
function tracking(run) { return (Array.isArray(run?.tracking) ? run.tracking : []).filter(url => typeof url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull|actions\/runs)\/[0-9]+$/.test(url)).slice(0,12); }
function install(vscode, context, request = exchange) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  bar.command = 'hypermesh.continue';
  let current, pending, disposed = false, generation = 0, previous = '';
  const workspace = () => {
    if (!vscode.workspace.isTrusted) return undefined;
    const active = vscode.window.activeTextEditor?.document?.uri;
    const folder = (active ? vscode.workspace.getWorkspaceFolder(active) : undefined) ?? (vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined);
    return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
  };
  const executable = () => userSetting(vscode.workspace.getConfiguration('hypermesh'), 'companionExecutable');
  function refresh() {
    if (disposed) return Promise.resolve();
    const project = workspace();
    if (pending) return pending.project === project && pending.generation === generation ? pending.promise : pending.promise.then(() => refresh());
    const flight = { project, generation }; pending = flight;
    flight.promise = read(project, generation).finally(() => { if (pending === flight) pending = undefined; });
    return flight.promise;
  }
  async function read(project, captured) {
    if (!project || !executable()) {current = undefined; previous = ''; bar.hide(); return;}
    try {
      const value = await request(executable(), project);
      if (disposed || captured !== generation || workspace() !== project) return;
      current = { project, run: value.run }; const text = label(value.run);
      if (text !== previous) { previous = text; bar.text = `$(sync) ${text}`; }
      bar.tooltip = value.run ? `Task ${value.run.id}\nCurrent: ${value.run.current || 'none'}\n${value.run.reason}\nReserved tokens: ${value.run.used_tokens}/${value.run.budgets?.tokens}\nSpending: ${value.run.budgets?.money ? `${value.run.budgets.money.currency} ${((value.run.reserved_micros || 0) / 1e6).toFixed(6)} reserved maximum / ${(value.run.budgets.money.limit_micros / 1e6).toFixed(6)} limit` : 'no monetary cap (older task)'}\nProject style: ${value.run.project_settings?.style || 'manual'}\nContext: ${value.run.project?.budget?.source || 'unknown'}` : 'Start or attach to the owner-selected Visor task'; bar.show();
    } catch { if (captured === generation) { current = undefined; previous = ''; bar.text = '$(warning) Continue: reconnect'; bar.show(); } }

  }
  const reset = () => { generation++; current = undefined; previous = ''; bar.hide(); void refresh(); };
  context.subscriptions.push(vscode.commands.registerCommand('hypermesh.continue', async () => {
    try {
      const project = workspace(); if (!project) throw new Error('Select a trusted local workspace.');
      await refresh();
      const run = current?.project === project ? current.run : null;
      const options = ['Open task form and controls', 'Project styles and context plan', 'Agent recommendation and handoff', 'Refresh status'];
      if (run) options.push(run.continue_enabled ? 'Continue off' : 'Continue on', 'Pause', 'Resume', 'Stop', 'Restart worker', 'Reassign worker', 'Retire worker', ...tracking(run));
      const choice = await vscode.window.showQuickPick(options, { title: label(run), placeHolder: run ? `${run.reason}; current chunk ${run.current || 'none'}` : 'Start a scoped task in Visor' });
      if (!choice) return;
      if (workspace() !== project) throw fail();
      if ((choice === 'Open task form and controls' || choice === 'Project styles and context plan')) {
        const [program, argv] = args(executable(), project, 'open'); const child = spawn(program, argv, { shell:false, windowsHide:true, stdio:'ignore' });
        child.on('error', () => vscode.window.showErrorMessage('Visor task manager unavailable.'));
        child.on('exit', () => { void refresh(); });
      } else if (choice === 'Agent recommendation and handoff') {
        const advice = await request(executable(),project,'advice');
        if (workspace() !== project) throw fail();
        await vscode.window.showQuickPick([{label:advice.action,description:advice.confidence,detail:JSON.stringify({reasons:advice.reasons,observations:advice.contributing,unknown:advice.unknown,next:advice.next_action,handoff:advice.handoff})}],{title:'Agent advice · no worker change is applied'});
      } else if (choice === 'Refresh status') { await refresh(); }
      else if (tracking(run).includes(choice)) { await vscode.env.openExternal(vscode.Uri.parse(choice)); }
      else {
        if (!run || current?.project !== project || current.run?.id !== run.id) throw fail();
        const actions = { 'Continue off':'continue-off','Continue on':'continue-on',Pause:'pause',Resume:'resume',Stop:'stop','Restart worker':'restart','Reassign worker':'reassign','Retire worker':'retire' };
        const control={run_id:run.id,revision:run.revision,action:actions[choice]};
        if (['restart','reassign','retire'].includes(control.action)) {
          if (await vscode.window.showQuickPick(['Apply selected worker action','Cancel'],{title:'Checkpoint task and change worker within the same assigned machine. Pause and spent limits are preserved.'}) !== 'Apply selected worker action') return;
          if (workspace() !== project) throw fail();
          control.request_id=randomUUID();
        }
        const ack=await request(executable(), project,control);
        if (ack.handoff) await vscode.window.showInformationMessage(`Worker ${ack.handoff.old_worker || 'none'} → ${ack.handoff.new_worker || 'retired'}; generation ${ack.handoff.generation}; unfinished work retained: ${ack.handoff.unfinished}`);
        await refresh();
      }
    } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : fail().message); }
  }));
  context.subscriptions.push(bar, vscode.workspace.onDidChangeWorkspaceFolders(reset), vscode.window.onDidChangeActiveTextEditor(reset));
  const timer = setInterval(() => { void refresh(); }, 5000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); generation++; } });
  void refresh();
  return { refresh };
}
module.exports = { args, exchange, label, tracking, install };
